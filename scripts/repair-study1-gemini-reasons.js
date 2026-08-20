require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { sendPrompt } = require('../lib/llm-clients');
const {
  REASON_FIELD_NAMES,
  BRAND_REASON_LONG_HEADERS,
  buildReasonPrompt,
  buildBrandReasonRows,
  reasonFieldsFromResponse,
} = require('../lib/followup-reasons');
const { exportSimplifiedResults } = require('../lib/simplified-export');

const ROOT = path.join(__dirname, '..');
const RUN_DIR = process.env.RUN_DIR || path.join(
  ROOT,
  'data',
  'exports',
  'study1',
  '2026-08-11_context_free_5cat_6model_40rep_repaired_with_reasons'
);
const MODEL_ID = process.env.MODEL_ID || 'gemini-3.1-pro-preview';
const REASON_MAX_OUTPUT_TOKENS = Number(process.env.REASON_MAX_OUTPUT_TOKENS || 4000);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 350);

const stateFile = path.join(RUN_DIR, 'state.json');
const rawCsvFile = path.join(RUN_DIR, 'raw_results.csv');
const reasonsCsvFile = path.join(RUN_DIR, 'brand_reasons_long.csv');
const qualityFile = path.join(RUN_DIR, 'quality_report.md');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCSV(filepath, rows, headers) {
  const content = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n');
  fs.writeFileSync(filepath, `${content}\n`);
}

function saveState(state) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

function backupFiles() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const filepath of [stateFile, rawCsvFile, reasonsCsvFile, qualityFile]) {
    if (!fs.existsSync(filepath)) continue;
    const backup = `${filepath}.pre_reason_retry_${stamp}`;
    fs.copyFileSync(filepath, backup);
  }
  return stamp;
}

function rowBrands(row) {
  return [1, 2, 3, 4, 5].map(rank => row[`brand_${rank}`]).filter(Boolean);
}

function retryTargets(state) {
  return state.rawResults.filter(row => (
    row.model_id === MODEL_ID &&
    row.reason_status !== 'completed' &&
    !String(row.response_text || '').startsWith('[ERROR]') &&
    rowBrands(row).length > 0
  ));
}

async function repairRow(row) {
  const brands = rowBrands(row);
  const reasonPrompt = buildReasonPrompt(row.prompt, brands);
  let lastFields = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const responseText = await sendPrompt(
        'google',
        MODEL_ID,
        reasonPrompt,
        TEMPERATURE,
        REASON_MAX_OUTPUT_TOKENS,
        false
      );
      lastFields = reasonFieldsFromResponse(row.prompt, brands, responseText);
      if (lastFields.reason_status === 'completed') return lastFields;
    } catch (error) {
      lastFields = {
        reason_prompt: reasonPrompt,
        reason_response_text: '',
        reason_1: '', reason_2: '', reason_3: '', reason_4: '', reason_5: '',
        reason_status: /429|quota|rate limit|resource_exhausted/i.test(error.message)
          ? 'quota_or_rate_limit'
          : 'error',
        reason_error: error.message,
      };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(700 * attempt);
  }
  return lastFields;
}

function updateCellLedgers(state) {
  const categories = [...new Set(state.rawResults
    .filter(row => row.model_id === MODEL_ID)
    .map(row => row.sub_category))];

  for (const category of categories) {
    const key = `context-free|${MODEL_ID}|${category}`;
    const rows = state.rawResults.filter(row => (
      row.model_id === MODEL_ID &&
      row.sub_category === category &&
      row.prompt_condition === 'context-free'
    ));
    const reasonIssues = rows.filter(row => row.reason_status !== 'completed').length;
    const report = state.qualityReports.find(item => (
      item.model_id === MODEL_ID &&
      item.sub_category === category &&
      item.prompt_condition === 'context-free'
    ));
    if (report) {
      report.reasonIssueRows = reasonIssues;
      report.quotaLimited = rows.some(row => row.reason_status === 'quota_or_rate_limit');
      report.issues = (report.issues || []).filter(issue => !/missing completed follow-up reasons/.test(issue));
      if (reasonIssues) report.issues.push(`${reasonIssues} rows are missing completed follow-up reasons`);
    }
    if (rows.length === 40 && reasonIssues === 0) {
      state.completed[key] = {
        ...(state.failed[key] || state.completed[key] || {}),
        status: 'completed',
        completed: 40,
        errors: 0,
        followupReasons: true,
        finishedAt: new Date().toISOString(),
      };
      delete state.failed[key];
      delete state.skipped[key];
    }
  }
}

function exportArtifacts(state) {
  writeCSV(rawCsvFile, state.rawResults, [
    'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
    'prompt_condition', 'prompt', 'response_text', 'brand_1', 'brand_2',
    'brand_3', 'brand_4', 'brand_5', ...REASON_FIELD_NAMES, 'timestamp', 'temperature',
    'max_output_tokens', 'notes',
  ]);
  writeCSV(reasonsCsvFile, buildBrandReasonRows(state.rawResults), BRAND_REASON_LONG_HEADERS);

  const lines = [
    '# LLM Brand Experiment Quality Report', '',
    `Generated: ${new Date().toISOString()}`,
    `Output directory: ${RUN_DIR}`, '',
  ];
  for (const report of state.qualityReports || []) {
    lines.push(`## ${report.prompt_condition} / ${report.model_id} / ${report.sub_category}`, '');
    lines.push(`Status: ${report.status}; completed ${report.completed}/${report.total}; errors ${report.errors}`);
    lines.push(`Follow-up reason issues: ${report.reasonIssueRows || 0}`, '');
    if (!(report.issues || []).length) lines.push('No obvious spelling/parsing issues detected.');
    else for (const issue of report.issues) lines.push(`- ${issue}`);
    lines.push('');
  }
  fs.writeFileSync(qualityFile, `${lines.join('\n')}\n`);
  exportSimplifiedResults({ runDir: RUN_DIR, study: 'study1' });
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not configured.');
  if (!fs.existsSync(stateFile)) throw new Error(`State file not found: ${stateFile}`);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const initialTargets = retryTargets(state);
  if (!initialTargets.length) {
    console.log('No incomplete Gemini reason rows remain.');
    return;
  }

  const backupStamp = backupFiles();
  console.log(`Backup stamp: ${backupStamp}`);
  console.log(`Reason-only targets: ${initialTargets.length}`);
  console.log(`Model: ${MODEL_ID}; max output tokens: ${REASON_MAX_OUTPUT_TOKENS}`);

  let repaired = 0;
  for (let index = 0; index < initialTargets.length; index += 1) {
    const row = initialTargets[index];
    const fields = await repairRow(row);
    Object.assign(row, fields, {
      timestamp: new Date().toISOString(),
      notes: [row.notes, `reason_only_retry_${REASON_MAX_OUTPUT_TOKENS}_tokens`].filter(Boolean).join('; '),
    });
    if (row.reason_status === 'completed') repaired += 1;
    saveState(state);
    console.log(`[${index + 1}/${initialTargets.length}] ${row.sub_category} replicate ${row.replicate}: ${row.reason_status}`);
    await sleep(REQUEST_DELAY_MS);
  }

  updateCellLedgers(state);
  saveState(state);
  exportArtifacts(state);

  const remaining = retryTargets(state);
  console.log(`Repaired this run: ${repaired}`);
  console.log(`Remaining incomplete Gemini reasons: ${remaining.length}`);
  if (remaining.length) process.exitCode = 2;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
