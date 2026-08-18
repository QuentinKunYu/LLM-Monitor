const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { calculateMetrics } = require('../lib/metrics');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const API = process.env.EXPERIMENT_API || 'http://localhost:3000';
const REPLICATES = Number(process.env.REPLICATES || 20);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 800);
const WEB_SEARCH = process.env.WEB_SEARCH === 'true';
const MODEL_FILTER = (process.env.MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const CATEGORY_FILTER = (process.env.CATEGORIES || '').split(',').map(s => s.trim()).filter(Boolean);
const PERSONA_FILTER = (process.env.PERSONAS || '').split(',').map(s => s.trim()).filter(Boolean);
const CONDITION_ID = process.env.CONDITION || 'synthetic-profile';

const runStamp = process.env.RUN_STAMP || new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(DATA_DIR, 'exports', 'study2', runStamp);
const stateFile = path.join(outputDir, 'state.json');
const rawCsvFile = path.join(outputDir, 'raw_results.csv');
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

function loadCSV(filename) {
  return parse(fs.readFileSync(path.join(ROOT, 'config', filename), 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadState() {
  if (!fs.existsSync(stateFile)) {
    return { completed: {}, rawResults: [], qualityReports: [] };
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function profileText(persona) {
  return [
    `Persona ID: ${persona.persona_id}`,
    `Age range: ${persona.age_range}`,
    `Gender: ${persona.gender}`,
    `Income range: ${persona.income_range}`,
    `Life stage: ${persona.life_stage}`,
    `Shopping orientation: ${persona.shopping_orientation}`,
    `Category experience: ${persona.category_experience}`,
    `Budget orientation: ${persona.budget_orientation}`,
    `Style identity: ${persona.style_identity}`,
    `Practical needs: ${persona.practical_needs}`,
    `Aspirational goals: ${persona.aspirational_goals}`,
  ].join('\n');
}

function loadPromptCondition(config) {
  const condition = (config.promptConditions || []).find(item => item.id === CONDITION_ID);
  if (!condition) {
    throw new Error(`Prompt condition "${CONDITION_ID}" not found. Restart the server if config/prompt_conditions.json was just changed.`);
  }
  if (!condition.prompt_template.includes('[profile]')) {
    throw new Error(`Prompt condition "${CONDITION_ID}" must include [profile].`);
  }
  return condition;
}

function finalPrompt(template, subCategory, persona) {
  return template
    .replace(/\[profile\]/gi, profileText(persona))
    .replace(/\[category\]/gi, subCategory);
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

function removeExistingRows(state, modelId, subCategory, personaId) {
  state.rawResults = state.rawResults.filter(row => !(
    row.model_id === modelId &&
    row.sub_category === subCategory &&
    row.persona_id === personaId &&
    row.prompt_condition === CONDITION_ID
  ));
  state.qualityReports = state.qualityReports.filter(row => !(
    row.model_id === modelId &&
    row.sub_category === subCategory &&
    row.persona_id === personaId &&
    row.prompt_condition === CONDITION_ID
  ));
}

function analyseRun(data, persona) {
  const results = data.results || [];
  const errorRows = results.filter(row => String(row.response_text || '').startsWith('[ERROR]'));
  const blankRows = results.filter(row => [1, 2, 3, 4, 5].every(k => !row[`brand_${k}`]));
  const issues = [];
  if (errorRows.length) issues.push(`${errorRows.length} API/parser error rows`);
  if (blankRows.length) issues.push(`${blankRows.length} rows have no extracted brands`);

  return {
    model_id: data.config?.modelId,
    sub_category: data.config?.subCategory,
    prompt_condition: data.config?.promptCondition,
    persona_id: persona.persona_id,
    status: data.status,
    completed: data.progress?.completed || 0,
    total: data.progress?.total || 0,
    errors: data.progress?.errors || 0,
    issues,
    errorSamples: errorRows.slice(0, 3).map(row => ({
      replicate: row.replicate,
      error: String(row.response_text || '').slice(0, 300),
    })),
  };
}

function buildFocalIndex(categories) {
  const index = {};
  for (const category of categories) {
    for (const sub of category.sub_categories) {
      index[sub.sub_category] = sub.brands;
    }
  }
  return index;
}

function buildMetrics(rawRows, focalIndex) {
  const grouped = {};
  for (const row of rawRows) {
    if (String(row.response_text || '').startsWith('[ERROR]')) continue;
    const key = `${row.prompt_condition}|${row.model_id}|${row.sub_category}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  const metrics = [];
  for (const [key, rows] of Object.entries(grouped)) {
    const [promptCondition, modelId, subCategory] = key.split('|');
    const personaCount = new Set(rows.map(row => row.persona_id)).size;
    const metricRows = calculateMetrics(rows, focalIndex[subCategory] || [], subCategory, modelId, promptCondition);
    for (const row of metricRows) {
      row.persona_type = 'synthetic';
      row.n_personas = personaCount;
      metrics.push(row);
    }
  }
  return metrics;
}

function exportArtifacts(state, focalIndex) {
  const rawHeaders = [
    'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
    'prompt_condition', 'persona_id', 'persona_type', 'profile_text', 'prompt',
    'response_text', 'brand_1', 'brand_2', 'brand_3', 'brand_4', 'brand_5',
    'timestamp', 'temperature', 'max_output_tokens', 'notes',
  ];
  const metricHeaders = [
    'sub_category', 'model_id', 'prompt_condition', 'persona_type', 'n_personas',
    'brand', 'visibility_group', 'total_mentions', 'n_replicates',
    'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
  ];

  writeCSV(rawCsvFile, state.rawResults, rawHeaders);
  writeCSV(metricsCsvFile, buildMetrics(state.rawResults, focalIndex), metricHeaders);
  writeQualityReport(state.qualityReports);
}

function writeQualityReport(reports) {
  const lines = [
    '# Study 2b Synthetic Persona Quality Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Output directory: ${outputDir}`,
    '',
  ];

  for (const report of reports) {
    lines.push(`## ${report.prompt_condition} / ${report.model_id} / ${report.sub_category} / ${report.persona_id}`);
    lines.push('');
    lines.push(`Status: ${report.status}; completed ${report.completed}/${report.total}; errors ${report.errors}`);
    lines.push('');
    if (!report.issues.length) {
      lines.push('No obvious spelling/parsing issues detected.');
    } else {
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

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const state = loadState();
  const config = await getJSON(`${API}/api/config`);
  const condition = loadPromptCondition(config);
  const focalIndex = buildFocalIndex(config.categories);

  const allSubcategories = [];
  for (const category of config.categories) {
    for (const sub of category.sub_categories) {
      allSubcategories.push({ category: category.category, subCategory: sub.sub_category });
    }
  }

  const personas = loadCSV('synthetic_personas.csv')
    .filter(persona => PERSONA_FILTER.length === 0 || PERSONA_FILTER.includes(persona.persona_id));
  const models = config.models
    .filter(model => MODEL_FILTER.length === 0 || MODEL_FILTER.includes(model.model_id));
  const subcategories = allSubcategories
    .filter(item => CATEGORY_FILTER.length === 0 || CATEGORY_FILTER.includes(item.subCategory));

  console.log(`Output: ${outputDir}`);
  console.log(`Condition: ${CONDITION_ID}`);
  console.log(`Models: ${models.map(m => m.model_id).join(', ')}`);
  console.log(`Categories: ${subcategories.map(c => c.subCategory).join(', ')}`);
  console.log(`Personas: ${personas.map(p => p.persona_id).join(', ')}`);
  console.log(`Replicates per persona/category/model: ${REPLICATES}`);

  for (const model of models) {
    for (const item of subcategories) {
      for (const persona of personas) {
        const key = `${CONDITION_ID}|${model.model_id}|${item.subCategory}|${persona.persona_id}`;
        if (
          state.completed[key] &&
          state.completed[key].status === 'completed' &&
          state.completed[key].errors === 0 &&
          state.completed[key].completed === REPLICATES
        ) {
          console.log(`[skip] ${key}`);
          continue;
        }

        const prompt = finalPrompt(condition.prompt_template, item.subCategory, persona);
        console.log(`[start] ${key}`);
        removeExistingRows(state, model.model_id, item.subCategory, persona.persona_id);

        const start = await getJSON(`${API}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId: model.model_id,
            category: item.category,
            subCategory: item.subCategory,
            promptTemplate: prompt,
            promptCondition: CONDITION_ID,
            replicates: REPLICATES,
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            webSearch: WEB_SEARCH,
            notes: `persona_id=${persona.persona_id}; persona_type=synthetic`,
          }),
        });

        const data = await waitForRun(start.runId);
        const profile = profileText(persona);
        const augmentedRows = (data.results || []).map(row => ({
          ...row,
          persona_id: persona.persona_id,
          persona_type: 'synthetic',
          profile_text: profile,
          prompt_condition: CONDITION_ID,
        }));
        const quality = analyseRun({ ...data, results: augmentedRows }, persona);

        state.rawResults.push(...augmentedRows);
        state.qualityReports.push(quality);

        const completion = {
          runId: start.runId,
          status: data.status,
          completed: data.progress?.completed || 0,
          errors: data.progress?.errors || 0,
          finishedAt: new Date().toISOString(),
        };
        if (completion.status === 'completed' && completion.errors === 0 && completion.completed === REPLICATES) {
          state.completed[key] = completion;
        } else {
          delete state.completed[key];
          if (!state.failed) state.failed = {};
          state.failed[key] = completion;
        }

        saveState(state);
        exportArtifacts(state, focalIndex);

        const issueSummary = quality.issues.length ? quality.issues.join(' | ') : 'no obvious issues';
        console.log(`[done] ${key}: ${quality.completed}/${quality.total}, errors=${quality.errors}, ${issueSummary}`);
      }
    }
  }

  exportArtifacts(state, focalIndex);
  console.log(`Raw CSV: ${rawCsvFile}`);
  console.log(`Metrics CSV: ${metricsCsvFile}`);
  console.log(`Quality report: ${reportFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
