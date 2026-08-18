const fs = require('fs');
const path = require('path');
const {
  REASON_FIELD_NAMES,
  BRAND_REASON_LONG_HEADERS,
  buildBrandReasonRows,
} = require('../lib/followup-reasons');
const { exportSimplifiedResults } = require('../lib/simplified-export');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const API = process.env.EXPERIMENT_API || 'http://localhost:3000';
const REPLICATES = Number(process.env.REPLICATES || 40);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 800);
const FOLLOWUP_REASONS = process.env.FOLLOWUP_REASONS === 'true';
const REASON_MAX_OUTPUT_TOKENS = Number(process.env.REASON_MAX_OUTPUT_TOKENS || 800);
const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_QUOTA = process.env.SKIP_QUOTA === 'true';
const RETRY_SKIPPED = process.env.RETRY_SKIPPED === 'true';
const WEB_SEARCH = process.env.WEB_SEARCH === 'true';
const MODEL_FILTER = (process.env.MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const CATEGORY_FILTER = (process.env.CATEGORIES || '').split(',').map(s => s.trim()).filter(Boolean);
const CONDITION_FILTER = (process.env.CONDITIONS || 'context-free').split(',').map(s => s.trim()).filter(Boolean);

const runStamp = process.env.RUN_STAMP || new Date().toISOString().replace(/[:.]/g, '-');

function inferStudyFolder(conditions) {
  if (process.env.STUDY) return process.env.STUDY;
  if (conditions.every(condition => condition === 'context-free')) return 'study1';
  if (conditions.some(condition => condition.includes('profile') || condition.includes('persona'))) return 'study2';
  if (conditions.some(condition => condition.includes('need'))) return 'study3';
  return 'misc';
}

const studyFolder = inferStudyFolder(CONDITION_FILTER);
const outputDir = path.join(DATA_DIR, 'exports', studyFolder, runStamp);
const stateFile = path.join(outputDir, 'state.json');
const rawCsvFile = path.join(outputDir, 'raw_results.csv');
const brandReasonsLongCsvFile = path.join(outputDir, 'brand_reasons_long.csv');
const metricsCsvFile = path.join(outputDir, 'metrics.csv');
const reportFile = path.join(outputDir, 'quality_report.md');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function loadState() {
  if (!fs.existsSync(stateFile)) {
    return { completed: {}, failed: {}, skipped: {}, rawResults: [], metrics: [], qualityReports: [] };
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.completed ||= {};
  state.failed ||= {};
  state.skipped ||= {};
  state.rawResults ||= [];
  state.metrics ||= [];
  state.qualityReports ||= [];
  return state;
}

function saveState(state) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function exportArtifacts(state) {
  const rawHeaders = [
    'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
    'prompt_condition', 'prompt', 'response_text', 'brand_1', 'brand_2',
    'brand_3', 'brand_4', 'brand_5', ...REASON_FIELD_NAMES, 'timestamp', 'temperature',
    'max_output_tokens', 'notes',
  ];
  const metricHeaders = [
    'sub_category', 'model_id', 'prompt_condition', 'brand', 'visibility_group', 'total_mentions',
    'n_replicates', 'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
  ];

  writeCSV(rawCsvFile, state.rawResults, rawHeaders);
  writeCSV(brandReasonsLongCsvFile, buildBrandReasonRows(state.rawResults), BRAND_REASON_LONG_HEADERS);
  writeCSV(metricsCsvFile, state.metrics, metricHeaders);
  writeQualityReport(state.qualityReports);
  exportSimplifiedResults({ runDir: outputDir, study: studyFolder });
}

function removeExistingRunRows(state, modelId, subCategory, promptCondition) {
  state.rawResults = state.rawResults.filter(row => !(
    row.model_id === modelId &&
    row.sub_category === subCategory &&
    row.prompt_condition === promptCondition
  ));
  state.metrics = state.metrics.filter(row => !(
    row.model_id === modelId &&
    row.sub_category === subCategory &&
    row.prompt_condition === promptCondition
  ));
  state.qualityReports = state.qualityReports.filter(row => !(
    row.model_id === modelId &&
    row.sub_category === subCategory &&
    row.prompt_condition === promptCondition
  ));
}

function normaliseForIssue(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function analyseRun(data) {
  const issues = [];
  const results = data.results || [];
  const errorRows = results.filter(row => String(row.response_text || '').startsWith('[ERROR]'));
  if (errorRows.length > 0) {
    issues.push(`${errorRows.length} API/parser error rows`);
  }

  const blankRows = results.filter(row => [1, 2, 3, 4, 5].every(k => !row[`brand_${k}`]));
  if (blankRows.length > 0) {
    issues.push(`${blankRows.length} rows have no extracted brands`);
  }

  const reasonIssueRows = results.filter(row => (
    FOLLOWUP_REASONS &&
    !String(row.response_text || '').startsWith('[ERROR]') &&
    row.reason_status !== 'completed'
  ));
  if (reasonIssueRows.length > 0) {
    issues.push(`${reasonIssueRows.length} rows are missing completed follow-up reasons`);
  }

  const brandValues = [];
  for (const row of results) {
    for (let k = 1; k <= 5; k++) {
      const brand = row[`brand_${k}`];
      if (brand) brandValues.push(brand);
    }
  }

  const suspicious = [...new Set(brandValues.filter(brand => {
    const lower = brand.toLowerCase();
    return (
      brand.length > 48 ||
      /[{}[\]"“”]/.test(brand) ||
      lower.includes('brand') ||
      lower.includes('json') ||
      lower.includes('undefined') ||
      lower.includes('null') ||
      lower.includes(' and ') ||
      lower.includes(' or ')
    );
  }))];
  if (suspicious.length > 0) {
    issues.push(`Suspicious brand strings: ${suspicious.join('; ')}`);
  }

  const variantsByNorm = {};
  for (const brand of brandValues) {
    const key = normaliseForIssue(brand);
    if (!key) continue;
    if (!variantsByNorm[key]) variantsByNorm[key] = new Set();
    variantsByNorm[key].add(brand);
  }
  const spellingVariants = Object.values(variantsByNorm)
    .map(set => [...set])
    .filter(values => values.length > 1);
  if (spellingVariants.length > 0) {
    issues.push(`Case/accent variants: ${spellingVariants.map(values => values.join(' / ')).join('; ')}`);
  }

  const errorSamples = errorRows.slice(0, 3).map(row => ({
    replicate: row.replicate,
    error: String(row.response_text || '').slice(0, 300),
  }));

  return {
    model_id: data.config?.modelId,
    sub_category: data.config?.subCategory,
    prompt_condition: data.config?.promptCondition,
    run_id: data.config?.runId,
    status: data.status,
    completed: data.progress?.completed || 0,
    total: data.progress?.total || 0,
    errors: data.progress?.errors || 0,
    reasonIssueRows: reasonIssueRows.length,
    quotaLimited: Boolean(data.quotaLimited || reasonIssueRows.some(row => /quota|rate limit|429/i.test(row.reason_error || row.reason_status || ''))),
    issues,
    errorSamples,
  };
}

function writeQualityReport(reports) {
  const lines = [
    '# LLM Brand Experiment Quality Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Output directory: ${outputDir}`,
    '',
  ];

  for (const report of reports) {
    const heading = `${report.prompt_condition} / ${report.model_id} / ${report.sub_category}`;
    lines.push(`## ${heading}`);
    lines.push('');
    lines.push(`Status: ${report.status}; completed ${report.completed}/${report.total}; errors ${report.errors}`);
    if (FOLLOWUP_REASONS) {
      lines.push(`Follow-up reason issues: ${report.reasonIssueRows || 0}`);
    }
    if (!report.issues.length) {
      lines.push('');
      lines.push('No obvious spelling/parsing issues detected.');
    } else {
      lines.push('');
      for (const issue of report.issues) lines.push(`- ${issue}`);
    }
    if (report.errorSamples.length) {
      lines.push('');
      lines.push('Error samples:');
      for (const sample of report.errorSamples) {
        lines.push(`- replicate ${sample.replicate}: ${sample.error}`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`);
}

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function waitForRun(runId) {
  while (true) {
    const data = await getJSON(`${API}/api/run/${runId}/results`);
    if (data.status === 'completed' || data.status === 'cancelled') return data;
    await sleep(1500);
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const state = loadState();
  const config = await getJSON(`${API}/api/config`);

  const allSubcategories = [];
  for (const category of config.categories) {
    for (const sub of category.sub_categories) {
      allSubcategories.push({
        category: category.category,
        subCategory: sub.sub_category,
      });
    }
  }

  const models = config.models
    .filter(model => MODEL_FILTER.length === 0 || MODEL_FILTER.includes(model.model_id));
  const subcategories = allSubcategories
    .filter(item => CATEGORY_FILTER.length === 0 || CATEGORY_FILTER.includes(item.subCategory));
  const availableConditions = config.promptConditions || [{
    id: 'context-free',
    display_name: 'Context-Free',
    experiment: 'study1',
    prompt_template: config.defaultPrompt,
  }];
  const promptConditions = availableConditions
    .filter(condition => CONDITION_FILTER.includes(condition.id));

  console.log(`Output: ${outputDir}`);
  console.log(`Models: ${models.map(m => m.model_id).join(', ')}`);
  console.log(`Categories: ${subcategories.map(c => c.subCategory).join(', ')}`);
  console.log(`Prompt conditions: ${promptConditions.map(c => c.id).join(', ')}`);
  console.log(`Replicates: ${REPLICATES}`);
  console.log(`Follow-up reasons: ${FOLLOWUP_REASONS ? 'on' : 'off'}`);

  for (const condition of promptConditions) {
    for (const model of models) {
      for (const item of subcategories) {
        const key = `${condition.id}|${model.model_id}|${item.subCategory}`;
        if (
          state.completed[key] &&
          state.completed[key].status === 'completed' &&
          Boolean(state.completed[key].followupReasons) === FOLLOWUP_REASONS &&
          state.completed[key].errors === 0 &&
          state.completed[key].completed === REPLICATES
        ) {
          console.log(`[skip] ${key}`);
          continue;
        }
        if (state.skipped?.[key] && !RETRY_SKIPPED) {
          console.log(`[skip-quota] ${key}`);
          continue;
        }

        console.log(`[start] ${key}`);
        removeExistingRunRows(state, model.model_id, item.subCategory, condition.id);
        const start = await getJSON(`${API}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId: model.model_id,
            category: item.category,
            subCategory: item.subCategory,
            promptTemplate: condition.prompt_template,
            promptCondition: condition.id,
            replicates: REPLICATES,
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            webSearch: WEB_SEARCH,
            followupReasons: FOLLOWUP_REASONS,
            reasonMaxOutputTokens: REASON_MAX_OUTPUT_TOKENS,
            bypassCache: FOLLOWUP_REASONS || process.env.BYPASS_CACHE === 'true',
            dryRun: DRY_RUN,
          }),
        });

        const data = await waitForRun(start.runId);
        const quality = analyseRun(data);
        state.rawResults.push(...(data.results || []));
        state.metrics.push(...(data.metrics || []));
        state.qualityReports.push(quality);
        const completion = {
          runId: start.runId,
          status: data.status,
          completed: data.progress?.completed || 0,
          errors: data.progress?.errors || 0,
          followupReasons: FOLLOWUP_REASONS,
          finishedAt: new Date().toISOString(),
        };
      if (quality.quotaLimited && SKIP_QUOTA) {
        delete state.completed[key];
        if (state.failed) delete state.failed[key];
        state.skipped[key] = {
          ...completion,
          reason: 'quota_or_rate_limit',
        };
      } else if (completion.status === 'completed' &&
          completion.errors === 0 &&
          completion.completed === REPLICATES &&
          quality.reasonIssueRows === 0) {
        state.completed[key] = completion;
        if (state.failed) delete state.failed[key];
        if (state.skipped) delete state.skipped[key];
      } else {
          delete state.completed[key];
          if (state.skipped) delete state.skipped[key];
          if (!state.failed) state.failed = {};
          state.failed[key] = completion;
        }

        saveState(state);
        exportArtifacts(state);

        const issueSummary = quality.issues.length ? quality.issues.join(' | ') : 'no obvious issues';
        console.log(`[done] ${key}: ${quality.completed}/${quality.total}, errors=${quality.errors}, ${issueSummary}`);
      }
    }
  }

  exportArtifacts(state);
  console.log(`Raw CSV: ${rawCsvFile}`);
  console.log(`Brand reasons long CSV: ${brandReasonsLongCsvFile}`);
  console.log(`Metrics CSV: ${metricsCsvFile}`);
  console.log(`Quality report: ${reportFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
