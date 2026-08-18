require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { sendPrompt } = require('../lib/llm-clients');
const { extractBrands, standardiseBrands, norm } = require('../lib/brand-extractor');
const { exportSimplifiedResults } = require('../lib/simplified-export');
const {
  buildRepeatedPromptTasks,
  calculateNeedsMetrics,
  loadNeedsPrompts,
  summariseNeedsPrompts,
} = require('../lib/study3-needs');
const {
  REASON_FIELD_NAMES,
  BRAND_REASON_LONG_HEADERS,
  buildReasonPrompt,
  buildBrandReasonRows,
  dryRunReasonResponse,
  reasonFieldsFromResponse,
  blankReasonFields,
} = require('../lib/followup-reasons');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG_PROMPTS = path.join(ROOT, 'config', 'needs_based_prompts.csv');
const DOWNLOADS_PROMPTS = '/Users/quentin/Downloads/needs_based_prompts.csv';
const PROMPTS_FILE = process.env.NEEDS_PROMPTS_FILE ||
  (fs.existsSync(DEFAULT_CONFIG_PROMPTS) ? DEFAULT_CONFIG_PROMPTS : DOWNLOADS_PROMPTS);
const REPEATS = Number.parseInt(process.env.REPEATS || process.env.REPEAT_COUNT || '2', 10);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 800);
const FOLLOWUP_REASONS = process.env.FOLLOWUP_REASONS === 'true';
const REASON_MAX_OUTPUT_TOKENS = Number(process.env.REASON_MAX_OUTPUT_TOKENS || 4000);
const WEB_SEARCH = process.env.WEB_SEARCH === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_QUOTA = process.env.SKIP_QUOTA === 'true';
const RECLEAN_ONLY = process.env.RECLEAN_ONLY === 'true';
const RETRY_SKIPPED = process.env.RETRY_SKIPPED === 'true';
const MODEL_FILTER = splitFilter(process.env.MODELS);
const CATEGORY_FILTER = splitFilter(process.env.CATEGORIES);
const CONDITION_FILTER = splitFilter(process.env.CONDITIONS);
const THEME_FILTER = splitFilter(process.env.THEMES);
const PROMPT_ID_FILTER = splitFilter(process.env.PROMPT_IDS);
const RUN_STAMP = process.env.RUN_STAMP || new Date().toISOString().replace(/[:.]/g, '-');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

const outputDir = path.join(DATA_DIR, 'exports', 'study3', RUN_STAMP);
const stateFile = path.join(outputDir, 'state.json');
const progressFile = path.join(outputDir, 'progress.json');
const rawCsvFile = path.join(outputDir, 'raw_results.csv');
const cleanCsvFile = path.join(outputDir, 'raw_results_cleaned.csv');
const brandReasonsLongCsvFile = path.join(outputDir, 'brand_reasons_long.csv');
const metricsCsvFile = path.join(outputDir, 'metrics.csv');
const metricsByThemeCsvFile = path.join(outputDir, 'metrics_by_theme.csv');
const conditionSummaryCsvFile = path.join(outputDir, 'condition_summary.csv');
const themeSummaryCsvFile = path.join(outputDir, 'theme_summary.csv');
const promptSummaryCsvFile = path.join(outputDir, 'prompt_summary.csv');
const reportFile = path.join(outputDir, 'quality_report.md');

function splitFilter(value = '') {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function loadCSV(filename) {
  const filepath = path.join(ROOT, 'config', filename);
  return parse(fs.readFileSync(filepath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadJSON(filename) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', filename), 'utf8'));
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCSV(file, rows, headers) {
  const body = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n');
  fs.writeFileSync(file, `${body}\n`);
}

function buildAliasMap(aliasRows) {
  const aliasMap = {};
  for (const row of aliasRows) {
    aliasMap[`${row.category}|${norm(row.alias)}`] = row.standard_brand;
  }
  return aliasMap;
}

function buildCategoryIndex(categoriesBrands) {
  const categoryIndex = {};
  const focalBrands = [];
  for (const row of categoriesBrands) {
    if (!categoryIndex[row.sub_category]) {
      categoryIndex[row.sub_category] = {
        category: row.category,
        sub_category: row.sub_category,
        brands: [],
      };
    }
    const brandRow = {
      brand: row.brand,
      visibility_group: row.visibility_group,
      sub_category: row.sub_category,
    };
    categoryIndex[row.sub_category].brands.push(brandRow);
    focalBrands.push(brandRow);
  }
  return { categoryIndex, focalBrands };
}

function loadState() {
  if (!fs.existsSync(stateFile)) {
    return { completed: {}, failed: {}, skipped: {}, rawResults: [] };
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.completed ||= {};
  state.failed ||= {};
  state.skipped ||= {};
  state.rawResults ||= [];
  return state;
}

function reconcileReasonState(state) {
  let reconciled = 0;
  for (const row of state.rawResults) {
    if (
      String(row.response_text || '').startsWith('[ERROR]') ||
      row.reason_status === 'completed'
    ) {
      continue;
    }

    const taskKey = `${row.prompt_id}|${row.model_id}|${row.repeat_index}`;
    delete state.completed[taskKey];
    if (row.reason_status === 'quota_or_rate_limit' || isQuotaError(row.reason_error)) {
      state.skipped[taskKey] = {
        finishedAt: row.timestamp || new Date().toISOString(),
        reason: 'quota_or_rate_limit',
        error: row.reason_error || 'Reason follow-up quota or rate limit',
      };
      delete state.failed[taskKey];
    } else {
      state.failed[taskKey] = {
        finishedAt: row.timestamp || new Date().toISOString(),
        reason: 'reason_incomplete',
        error: row.reason_error || `Reason status: ${row.reason_status || 'blank'}`,
      };
      delete state.skipped[taskKey];
    }
    reconciled++;
  }
  return reconciled;
}

function saveState(state) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function writeProgress(progress) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

function exportArtifacts(state, focalBrands, prompts) {
  const analysis = calculateNeedsMetrics(state.rawResults, focalBrands);
  const rawRows = addCleanedBrandFields(state.rawResults);
  const rawHeaders = [
    'run_id', 'study', 'category', 'sub_category', 'model_id', 'model_name',
    'prompt_condition', 'theme', 'prompt_id', 'repeat_index', 'replicate',
    'prompt', 'response_text', 'brand_1', 'brand_2', 'brand_3', 'brand_4',
    'brand_5', 'cleaned_brand_1', 'cleaned_brand_2', 'cleaned_brand_3',
    'cleaned_brand_4', 'cleaned_brand_5', ...REASON_FIELD_NAMES, 'timestamp', 'temperature',
    'max_output_tokens', 'notes',
  ];
  const metricHeaders = [
    'sub_category', 'model_id', 'prompt_condition', 'brand', 'visibility_group',
    'total_mentions', 'n_replicates', 'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
  ];
  const metricByThemeHeaders = [
    ...metricHeaders.slice(0, 3),
    'theme', 'prompt_id_count',
    ...metricHeaders.slice(3),
  ];
  const summaryHeaders = ['prompt_condition', 'sub_category', 'theme', 'model_id', 'total_rows', 'unique_prompts', 'total_mentions', 'error_rows'];
  const promptSummaryHeaders = ['sub_category', 'prompt_condition', 'theme', 'prompt_count'];

  writeCSV(rawCsvFile, rawRows, rawHeaders);
  writeCSV(cleanCsvFile, rawRows, rawHeaders);
  writeCSV(brandReasonsLongCsvFile, buildBrandReasonRows(rawRows), BRAND_REASON_LONG_HEADERS);
  writeCSV(metricsCsvFile, analysis.metrics, metricHeaders);
  writeCSV(metricsByThemeCsvFile, analysis.metricsByTheme, metricByThemeHeaders);
  writeCSV(conditionSummaryCsvFile, analysis.conditionSummary, summaryHeaders);
  writeCSV(themeSummaryCsvFile, analysis.themeSummary, summaryHeaders);
  writeCSV(promptSummaryCsvFile, buildPromptSummaryRows(prompts), promptSummaryHeaders);
  writeQualityReport(state, analysis);
}

function exportSimplifiedArtifacts() {
  return exportSimplifiedResults({ runDir: outputDir, study: 'study3' });
}

function addCleanedBrandFields(rows) {
  return rows.map(row => {
    const next = { ...row };
    for (let i = 1; i <= 5; i++) {
      next[`cleaned_brand_${i}`] = row[`brand_${i}`] || '';
    }
    return next;
  });
}

function writeQualityReport(state, analysis) {
  const rows = state.rawResults;
  const errors = rows.filter(row => String(row.response_text || '').startsWith('[ERROR]'));
  const blank = rows.filter(row => [1, 2, 3, 4, 5].every(k => !row[`brand_${k}`]));
  const lines = [
    '# Study 3 Needs-Based Prompt Quality Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Prompt CSV: ${PROMPTS_FILE}`,
    `Output directory: ${outputDir}`,
    `Rows: ${rows.length}`,
    `Errors: ${errors.length}`,
    `Blank brand rows: ${blank.length}`,
    `Reason follow-up enabled: ${FOLLOWUP_REASONS ? 'yes' : 'no'}`,
    `Condition summaries: ${analysis.conditionSummary.length}`,
    `Theme summaries: ${analysis.themeSummary.length}`,
    '',
  ];

  if (errors.length) {
    lines.push('## Error Samples', '');
    for (const row of errors.slice(0, 10)) {
      lines.push(`- ${row.model_id} / ${row.prompt_id} / repeat ${row.repeat_index}: ${String(row.response_text).slice(0, 240)}`);
    }
    lines.push('');
  }

  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`);
}

function filterPrompts(prompts) {
  return prompts.filter(row => (
    (CATEGORY_FILTER.length === 0 || CATEGORY_FILTER.includes(row.sub_category)) &&
    (CONDITION_FILTER.length === 0 || CONDITION_FILTER.includes(row.prompt_condition)) &&
    (THEME_FILTER.length === 0 || THEME_FILTER.includes(row.theme)) &&
    (PROMPT_ID_FILTER.length === 0 || PROMPT_ID_FILTER.includes(row.prompt_id))
  ));
}

function dryRunResponse(task) {
  const fixtures = {
    'cordless drills': ['DeWalt', 'Milwaukee', 'Ryobi', 'Makita', 'Bosch'],
    'coffee maker': ['Breville', 'Cuisinart', 'DeLonghi', 'Ninja', 'Keurig'],
    'cat food': ['Purina Pro Plan', "Hill's Science Diet", 'Royal Canin', 'Blue Buffalo', 'Iams'],
    'boat cruises': ['Royal Caribbean', 'Carnival Cruise Line', 'Norwegian Cruise Line', 'Viking', 'Celebrity Cruises'],
    'hiking jacket': ['Patagonia', 'The North Face', "Arc'teryx", 'Columbia', 'REI'],
  };
  const brands = fixtures[task.sub_category] || ['Brand A', 'Brand B', 'Brand C', 'Brand D', 'Brand E'];
  return JSON.stringify({ brands });
}

function buildPromptSummaryRows(prompts) {
  const counts = {};
  for (const row of prompts) {
    const key = `${row.sub_category}|${row.prompt_condition}|${row.theme}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).map(([key, prompt_count]) => {
    const [sub_category, prompt_condition, theme] = key.split('|');
    return { sub_category, prompt_condition, theme, prompt_count };
  });
}

function validatePromptCategories(prompts, categoryIndex) {
  const unknown = [...new Set(prompts.map(row => row.sub_category).filter(sub => !categoryIndex[sub]))];
  if (unknown.length) {
    throw new Error(`Needs prompt CSV has sub_category values not in config/categories_brands.csv: ${unknown.join(', ')}`);
  }
}

function recleanExistingRows(state, aliasMap) {
  let updated = 0;
  let unchanged = 0;

  state.rawResults = (state.rawResults || []).map(row => {
    if (String(row.response_text || '').startsWith('[ERROR]')) return row;

    const rawBrands = extractBrands(row.response_text);
    const stdBrands = standardiseBrands(rawBrands, aliasMap, row.sub_category);
    if (stdBrands.length === 0) {
      unchanged++;
      return row;
    }

    const next = { ...row };
    for (let i = 1; i <= 5; i++) {
      next[`brand_${i}`] = stdBrands[i - 1] || '';
    }
    updated++;
    return next;
  });

  return { updated, unchanged };
}

function isQuotaError(message) {
  return /429|too many requests|resource_exhausted|quota|rate limit|rate_limit|insufficient_quota/i.test(String(message || ''));
}

async function runTask(task, aliasMap, state) {
  const runId = `study3-${task.prompt_id}-${task.model_id}-${task.repeat_index}`;
  let responseText = '';
  try {
    responseText = DRY_RUN
      ? dryRunResponse(task)
      : await sendPrompt(task.provider, task.model_name, task.prompt, TEMPERATURE, MAX_OUTPUT_TOKENS, WEB_SEARCH);
    if (!responseText || !responseText.trim()) {
      throw new Error('Model returned an empty response');
    }
    const rawBrands = extractBrands(responseText);
    const stdBrands = standardiseBrands(rawBrands, aliasMap, task.sub_category);
    if (stdBrands.length === 0) {
      throw new Error('No brands could be extracted from the model response');
    }
    let reasonFields = blankReasonFields();
    if (FOLLOWUP_REASONS) {
      const reasonPrompt = buildReasonPrompt(task.prompt, stdBrands);
      try {
        const reasonResponseText = DRY_RUN
          ? dryRunReasonResponse(stdBrands)
          : await sendPrompt(task.provider, task.model_name, reasonPrompt, TEMPERATURE, REASON_MAX_OUTPUT_TOKENS, WEB_SEARCH);
        if (!reasonResponseText || !reasonResponseText.trim()) {
          throw new Error('Model returned an empty reason response');
        }
        reasonFields = reasonFieldsFromResponse(task.prompt, stdBrands, reasonResponseText);
      } catch (reasonErr) {
        reasonFields = {
          ...blankReasonFields('error', reasonErr.message),
          reason_prompt: reasonPrompt,
        };
        if (isQuotaError(reasonErr.message)) {
          reasonFields.reason_status = 'quota_or_rate_limit';
        }
      }
    }
    return {
      run_id: runId,
      study: 'study3',
      category: task.category,
      sub_category: task.sub_category,
      model_id: task.model_id,
      model_name: task.model_name,
      prompt_condition: task.prompt_condition,
      theme: task.theme,
      prompt_id: task.prompt_id,
      repeat_index: task.repeat_index,
      replicate: task.repeat_index,
      prompt: task.prompt,
      response_text: responseText,
      brand_1: stdBrands[0] || '',
      brand_2: stdBrands[1] || '',
      brand_3: stdBrands[2] || '',
      brand_4: stdBrands[3] || '',
      brand_5: stdBrands[4] || '',
      ...reasonFields,
      timestamp: new Date().toISOString(),
      temperature: TEMPERATURE,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      notes: DRY_RUN ? 'dry_run_no_api_call' : '',
    };
  } catch (err) {
    return {
      run_id: runId,
      study: 'study3',
      category: task.category,
      sub_category: task.sub_category,
      model_id: task.model_id,
      model_name: task.model_name,
      prompt_condition: task.prompt_condition,
      theme: task.theme,
      prompt_id: task.prompt_id,
      repeat_index: task.repeat_index,
      replicate: task.repeat_index,
      prompt: task.prompt,
      response_text: responseText
        ? `[ERROR] ${err.message}\n\n[RAW RESPONSE]\n${responseText}`
        : `[ERROR] ${err.message}`,
      brand_1: '',
      brand_2: '',
      brand_3: '',
      brand_4: '',
      brand_5: '',
      ...blankReasonFields('', ''),
      timestamp: new Date().toISOString(),
      temperature: TEMPERATURE,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      notes: `Error: ${err.message}`,
      quota_limited: isQuotaError(err.message),
    };
  }
}

function hasSuccessfulRecommendation(row) {
  return row &&
    !String(row.response_text || '').startsWith('[ERROR]') &&
    [1, 2, 3, 4, 5].some(rank => row[`brand_${rank}`]);
}

async function retryReasonForRow(task, existingRow) {
  const brands = [1, 2, 3, 4, 5]
    .map(rank => existingRow[`brand_${rank}`])
    .filter(Boolean);
  const reasonPrompt = buildReasonPrompt(task.prompt, brands);

  try {
    const reasonResponseText = DRY_RUN
      ? dryRunReasonResponse(brands)
      : await sendPrompt(
        task.provider,
        task.model_name,
        reasonPrompt,
        TEMPERATURE,
        REASON_MAX_OUTPUT_TOKENS,
        WEB_SEARCH,
      );
    if (!reasonResponseText || !reasonResponseText.trim()) {
      throw new Error('Model returned an empty reason response');
    }
    return {
      ...existingRow,
      ...reasonFieldsFromResponse(task.prompt, brands, reasonResponseText),
      timestamp: new Date().toISOString(),
      notes: DRY_RUN ? 'dry_run_reason_resume_no_api_call' : existingRow.notes,
    };
  } catch (reasonErr) {
    const reasonFields = {
      ...blankReasonFields('error', reasonErr.message),
      reason_prompt: reasonPrompt,
    };
    if (isQuotaError(reasonErr.message)) {
      reasonFields.reason_status = 'quota_or_rate_limit';
    }
    return {
      ...existingRow,
      ...reasonFields,
      timestamp: new Date().toISOString(),
    };
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const prompts = filterPrompts(loadNeedsPrompts(PROMPTS_FILE));
  const { categoryIndex, focalBrands } = buildCategoryIndex(loadCSV('categories_brands.csv'));
  validatePromptCategories(prompts, categoryIndex);

  const aliasMap = buildAliasMap(loadCSV('brand_alias_dictionary.csv'));
  const models = loadJSON('models.json').models
    .filter(model => MODEL_FILTER.length === 0 || MODEL_FILTER.includes(model.model_id));
  const tasks = buildRepeatedPromptTasks({ prompts, models, repeatCount: REPEATS });
  const state = loadState();
  const reconciledReasons = FOLLOWUP_REASONS ? reconcileReasonState(state) : 0;
  delete state.paused;
  saveState(state);
  if (reconciledReasons > 0) {
    console.log(`Reconciled ${reconciledReasons} incomplete reason rows for retry.`);
  }

  if (RECLEAN_ONLY) {
    const result = recleanExistingRows(state, aliasMap);
    saveState(state);
    exportArtifacts(state, focalBrands, prompts);
    exportSimplifiedArtifacts();
    writeProgress({
      status: Object.keys(state.skipped || {}).length ? 'completed_with_skips' : 'completed',
      outputDir,
      promptFile: PROMPTS_FILE,
      finishedAt: new Date().toISOString(),
      completed: Object.keys(state.completed || {}).length,
      total: tasks.length,
      errors: Object.keys(state.failed || {}).length,
      skipped: Object.keys(state.skipped || {}).length,
      dryRun: DRY_RUN,
      recleanOnly: true,
      recleanedRows: result.updated,
      unchangedRows: result.unchanged,
      files: {
        rawResults: rawCsvFile,
        rawResultsCleaned: cleanCsvFile,
        metrics: metricsCsvFile,
        metricsByTheme: metricsByThemeCsvFile,
        brandReasonsLong: brandReasonsLongCsvFile,
        conditionSummary: conditionSummaryCsvFile,
        themeSummary: themeSummaryCsvFile,
        qualityReport: reportFile,
      },
    });
    console.log(`Recleaned rows: ${result.updated}; unchanged successful rows: ${result.unchanged}`);
    console.log(`Clean CSV: ${cleanCsvFile}`);
    return;
  }

  writeProgress({
    status: 'running',
    outputDir,
    promptFile: PROMPTS_FILE,
    startedAt: new Date().toISOString(),
    completed: Object.keys(state.completed || {}).length,
    total: tasks.length,
    errors: Object.keys(state.failed || {}).length,
    skipped: Object.keys(state.skipped || {}).length,
      dryRun: DRY_RUN,
      followupReasons: FOLLOWUP_REASONS,
  });

  console.log(`Study 3 needs-based run`);
  console.log(`Prompt CSV: ${PROMPTS_FILE}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Prompts: ${prompts.length}; models: ${models.length}; repeats: ${REPEATS}; tasks: ${tasks.length}`);

  for (const task of tasks) {
    if (state.completed[task.task_key] && Boolean(state.completed[task.task_key].followupReasons) === FOLLOWUP_REASONS) {
      console.log(`[skip] ${task.task_key}`);
      continue;
    }
    if (state.skipped[task.task_key] && !RETRY_SKIPPED) {
      console.log(`[skip-quota] ${task.task_key}`);
      continue;
    }

    console.log(`[start] ${task.task_key}`);
    const existingRow = state.rawResults.find(row => (
      row.prompt_id === task.prompt_id &&
      row.model_id === task.model_id &&
      String(row.repeat_index) === String(task.repeat_index)
    ));
    state.rawResults = state.rawResults.filter(row => !(
      row.prompt_id === task.prompt_id &&
      row.model_id === task.model_id &&
      String(row.repeat_index) === String(task.repeat_index)
    ));

    const shouldRetryReasonOnly = FOLLOWUP_REASONS &&
      RETRY_SKIPPED &&
      hasSuccessfulRecommendation(existingRow) &&
      existingRow.reason_status !== 'completed';
    if (shouldRetryReasonOnly) {
      console.log(`[resume-reason] ${task.task_key}`);
    }
    const row = shouldRetryReasonOnly
      ? await retryReasonForRow(task, existingRow)
      : await runTask(task, aliasMap, state);
    state.rawResults.push(row);

    const rowIsError = String(row.response_text || '').startsWith('[ERROR]');
    const reasonIsIncomplete = FOLLOWUP_REASONS && row.reason_status !== 'completed';
    const rowIsQuotaLimited = row.quota_limited ||
      row.reason_status === 'quota_or_rate_limit' ||
      isQuotaError(row.response_text) ||
      isQuotaError(row.reason_error) ||
      isQuotaError(row.notes);

    if (rowIsQuotaLimited && SKIP_QUOTA) {
      state.skipped[task.task_key] = {
        finishedAt: new Date().toISOString(),
        reason: 'quota_or_rate_limit',
        error: row.response_text,
      };
      delete state.completed[task.task_key];
      delete state.failed[task.task_key];
    } else if (rowIsError || reasonIsIncomplete) {
      state.failed[task.task_key] = {
        finishedAt: new Date().toISOString(),
        reason: rowIsError ? 'recommendation_error' : 'reason_incomplete',
        error: rowIsError ? row.response_text : row.reason_error,
      };
      delete state.completed[task.task_key];
      delete state.skipped[task.task_key];
    } else {
      state.completed[task.task_key] = {
        finishedAt: new Date().toISOString(),
        followupReasons: FOLLOWUP_REASONS,
      };
      delete state.failed[task.task_key];
      delete state.skipped[task.task_key];
    }

    saveState(state);
    exportArtifacts(state, focalBrands, prompts);
    writeProgress({
      status: 'running',
      outputDir,
      promptFile: PROMPTS_FILE,
      startedAt: fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')).startedAt : new Date().toISOString(),
      completed: Object.keys(state.completed || {}).length,
      total: tasks.length,
      errors: Object.keys(state.failed || {}).length,
      skipped: Object.keys(state.skipped || {}).length,
      current: task.task_key,
      dryRun: DRY_RUN,
      followupReasons: FOLLOWUP_REASONS,
    });

    if (rowIsQuotaLimited && SKIP_QUOTA) {
      console.log(`[skipped_quota] ${task.task_key}`);
      continue;
    }

    if (rowIsQuotaLimited) {
      state.paused = {
        reason: 'quota_or_rate_limit',
        current: task.task_key,
        pausedAt: new Date().toISOString(),
        message: row.response_text,
      };
      saveState(state);
      exportArtifacts(state, focalBrands, prompts);
      exportSimplifiedArtifacts();
      writeProgress({
        status: 'paused_quota',
        outputDir,
        promptFile: PROMPTS_FILE,
        pausedAt: state.paused.pausedAt,
        completed: Object.keys(state.completed || {}).length,
        total: tasks.length,
        errors: Object.keys(state.failed || {}).length,
        skipped: Object.keys(state.skipped || {}).length,
        current: task.task_key,
        dryRun: DRY_RUN,
        message: 'Paused because an API quota or rate limit error was detected. Re-run with the same RUN_STAMP to continue.',
      });
      console.log(`[paused_quota] ${task.task_key}`);
      return;
    }
  }

  exportArtifacts(state, focalBrands, prompts);
  const simplifiedFiles = exportSimplifiedArtifacts();
  writeProgress({
    status: Object.keys(state.skipped || {}).length ? 'completed_with_skips' : 'completed',
    outputDir,
    promptFile: PROMPTS_FILE,
    finishedAt: new Date().toISOString(),
    completed: Object.keys(state.completed || {}).length,
    total: tasks.length,
    errors: Object.keys(state.failed || {}).length,
    skipped: Object.keys(state.skipped || {}).length,
    dryRun: DRY_RUN,
    files: {
        rawResults: rawCsvFile,
        rawResultsCleaned: cleanCsvFile,
        brandReasonsLong: brandReasonsLongCsvFile,
        metrics: metricsCsvFile,
      metricsByTheme: metricsByThemeCsvFile,
      conditionSummary: conditionSummaryCsvFile,
      themeSummary: themeSummaryCsvFile,
      qualityReport: reportFile,
      simplifiedMain: simplifiedFiles.mainFile,
      simplifiedReasons: simplifiedFiles.reasonsFile,
      simplifiedSummary: simplifiedFiles.summaryFile,
    },
  });

  console.log(`Raw CSV: ${rawCsvFile}`);
  console.log(`Clean CSV: ${cleanCsvFile}`);
  console.log(`Brand reasons long CSV: ${brandReasonsLongCsvFile}`);
  console.log(`Metrics CSV: ${metricsCsvFile}`);
  console.log(`Theme metrics CSV: ${metricsByThemeCsvFile}`);
  console.log(`Quality report: ${reportFile}`);
  console.log(`Simplified CSVs: ${simplifiedFiles.outputDir}`);
}

main().catch(err => {
  writeProgress({
    status: 'failed',
    outputDir,
    promptFile: PROMPTS_FILE,
    finishedAt: new Date().toISOString(),
    error: err.message,
    dryRun: DRY_RUN,
  });
  console.error(err);
  process.exit(1);
});
