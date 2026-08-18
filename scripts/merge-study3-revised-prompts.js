const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { loadNeedsPrompts } = require('../lib/study3-needs');

const ROOT = path.join(__dirname, '..');
const [oldRunArg, partialRunArg, outputRunArg, revisedPromptsArg] = process.argv.slice(2);

if (!oldRunArg || !partialRunArg || !outputRunArg || !revisedPromptsArg) {
  throw new Error(
    'Usage: node scripts/merge-study3-revised-prompts.js <old-run-dir> <partial-run-dir> <output-run-dir> <revised-prompts.csv>'
  );
}

const oldRunDir = path.resolve(oldRunArg);
const partialRunDir = path.resolve(partialRunArg);
const outputRunDir = path.resolve(outputRunArg);
const revisedPromptsFile = path.resolve(revisedPromptsArg);
const originalPromptsFile = path.join(ROOT, 'config', 'needs_based_prompts.csv');
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8')).models;

function loadState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

function taskKey(row) {
  return `${row.prompt_id}|${row.model_id}|${Number(row.repeat_index || row.replicate)}`;
}

function uniqueRowMap(rows, label) {
  const map = new Map();
  for (const row of rows) {
    const key = taskKey(row);
    assert(!map.has(key), `${label} has duplicate task key: ${key}`);
    map.set(key, row);
  }
  return map;
}

const oldState = loadState(oldRunDir);
const partialState = loadState(partialRunDir);
const oldRows = uniqueRowMap(oldState.rawResults || [], 'Old run');
const partialRows = uniqueRowMap(partialState.rawResults || [], 'Partial run');
const originalPrompts = loadNeedsPrompts(originalPromptsFile);
const revisedPrompts = loadNeedsPrompts(revisedPromptsFile);
const originalById = new Map(originalPrompts.map(row => [row.prompt_id, row]));

assert.strictEqual(revisedPrompts.length, 200, 'Revised prompt file must contain 200 prompts');
assert.strictEqual(originalById.size, 200, 'Original prompt file must contain 200 unique prompts');

const changedPromptIds = new Set(
  revisedPrompts
    .filter(row => originalById.get(row.prompt_id)?.prompt !== row.prompt)
    .map(row => row.prompt_id)
);
assert.strictEqual(changedPromptIds.size, 88, 'Expected exactly 88 changed prompt texts');

const mergedRows = [];
const completed = {};
const provenanceRows = [];
const mergedRunStamp = path.basename(outputRunDir);
const oldRunStamp = path.basename(oldRunDir);
const partialRunStamp = path.basename(partialRunDir);

for (const promptRow of revisedPrompts) {
  const promptChanged = changedPromptIds.has(promptRow.prompt_id);
  const sourceMap = promptChanged ? partialRows : oldRows;
  const sourceRunStamp = promptChanged ? partialRunStamp : oldRunStamp;

  for (const model of models) {
    for (const repeatIndex of [1, 2]) {
      const key = `${promptRow.prompt_id}|${model.model_id}|${repeatIndex}`;
      const sourceRow = sourceMap.get(key);
      assert(sourceRow, `Missing source row: ${key}`);
      assert.strictEqual(sourceRow.prompt, promptRow.prompt, `Prompt text mismatch: ${key}`);
      assert.strictEqual(sourceRow.reason_status, 'completed', `Reason incomplete: ${key}`);
      assert(
        [1, 2, 3, 4, 5].some(rank => String(sourceRow[`brand_${rank}`] || '').trim()),
        `No successful recommendation: ${key}`
      );

      const provenanceNote = `source_run=${sourceRunStamp}; prompt_revision=${promptChanged ? 'category_explicit_v2' : 'unchanged'}`;
      const mergedRow = {
        ...sourceRow,
        run_id: `study3-merged-${promptRow.prompt_id}-${model.model_id}-${repeatIndex}`,
        prompt: promptRow.prompt,
        source_run_stamp: sourceRunStamp,
        prompt_revision: promptChanged ? 'category_explicit_v2' : 'unchanged',
        notes: [sourceRow.notes, provenanceNote].filter(Boolean).join(' | '),
      };
      mergedRows.push(mergedRow);
      completed[key] = {
        finishedAt: sourceRow.timestamp || new Date().toISOString(),
        sourceRunStamp,
      };
      provenanceRows.push({
        prompt_id: promptRow.prompt_id,
        model_id: model.model_id,
        repeat_index: repeatIndex,
        task_key: key,
        prompt_changed: promptChanged ? 'true' : 'false',
        prompt_revision: promptChanged ? 'category_explicit_v2' : 'unchanged',
        source_run_stamp: sourceRunStamp,
      });
    }
  }
}

assert.strictEqual(mergedRows.length, 2400, 'Merged run must contain 2,400 rows');
assert.strictEqual(new Set(mergedRows.map(taskKey)).size, 2400, 'Merged task keys must be unique');
assert.strictEqual(
  mergedRows.filter(row => row.prompt_revision === 'category_explicit_v2').length,
  1056,
  'Changed prompts must contribute 1,056 rows'
);
assert.strictEqual(
  mergedRows.filter(row => row.prompt_revision === 'unchanged').length,
  1344,
  'Unchanged prompts must contribute 1,344 rows'
);

fs.mkdirSync(outputRunDir, { recursive: true });
fs.writeFileSync(
  path.join(outputRunDir, 'state.json'),
  `${JSON.stringify({ completed, failed: {}, skipped: {}, rawResults: mergedRows }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(outputRunDir, 'merge_manifest.json'),
  `${JSON.stringify({
    generated_at: new Date().toISOString(),
    merged_run_stamp: mergedRunStamp,
    original_run_stamp: oldRunStamp,
    partial_run_stamp: partialRunStamp,
    original_prompts_file: originalPromptsFile,
    revised_prompts_file: revisedPromptsFile,
    changed_prompt_count: changedPromptIds.size,
    unchanged_prompt_count: revisedPrompts.length - changedPromptIds.size,
    revised_rows: 1056,
    reused_rows: 1344,
    total_rows: mergedRows.length,
    changed_prompt_ids: [...changedPromptIds],
  }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(outputRunDir, 'task_provenance.csv'),
  stringify(provenanceRows, {
    header: true,
    columns: [
      'prompt_id', 'model_id', 'repeat_index', 'task_key', 'prompt_changed',
      'prompt_revision', 'source_run_stamp',
    ],
  })
);

console.log(JSON.stringify({
  outputRunDir,
  changedPrompts: changedPromptIds.size,
  revisedRows: 1056,
  reusedRows: 1344,
  totalRows: mergedRows.length,
  uniqueTaskKeys: new Set(mergedRows.map(taskKey)).size,
}, null, 2));
