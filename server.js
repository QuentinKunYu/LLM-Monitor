/**
 * ═══════════════════════════════════════════════════════════════════
 * LLM Brand Recommendation Experiment — Server
 * ═══════════════════════════════════════════════════════════════════
 *
 * This Express server powers the context-free brand recommendation
 * experiment.  It exposes REST endpoints for:
 *
 *   GET  /api/config          → categories, focal brands, aliases, models
 *   POST /api/run             → kick off an experiment (streams progress via SSE)
 *   GET  /api/run/:id/status  → poll run progress
 *   GET  /api/run/:id/results → fetch raw + metric results
 *
 * Methodological invariants enforced here:
 *   • Every replicate is an independent, single-turn API call.
 *   • No conversation history is carried between replicates.
 *   • Web search / tool use is never enabled.
 *   • Temperature and max_output_tokens are held constant within a run.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const { sendPrompt } = require('./lib/llm-clients');
const { extractBrands, standardiseBrands, norm } = require('./lib/brand-extractor');
const { calculateMetrics } = require('./lib/metrics');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════

function loadCSV(filename) {
  const filepath = path.join(__dirname, 'config', filename);
  const content = fs.readFileSync(filepath, 'utf-8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

function loadJSON(filename) {
  const filepath = path.join(__dirname, 'config', filename);
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function readCSVIfExists(filepath) {
  if (!fs.existsSync(filepath)) return [];
  return parse(fs.readFileSync(filepath, 'utf-8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function safeFilename(filename) {
  return String(filename || 'rq1-input.csv')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'rq1-input.csv';
}

function validateRq1CSV(csvText) {
  const requiredColumns = [
    'run_id',
    'category',
    'sub_category',
    'model_id',
    'model_name',
    'replicate',
    'prompt_condition',
    'response_text',
    'brand_1',
    'brand_2',
    'brand_3',
    'brand_4',
    'brand_5',
  ];
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    to_line: 2,
  });
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const missing = requiredColumns.filter(col => !columns.includes(col));
  if (missing.length) {
    throw new Error(`RQ1 CSV is missing required columns: ${missing.join(', ')}`);
  }
}

function validateRq1BaselineCSV(csvText) {
  const requiredColumns = [
    'sub_category',
    'brand',
    'baseline_share',
    'aspiration_score',
  ];
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    to_line: 2,
  });
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const missing = requiredColumns.filter(col => !columns.includes(col));
  if (missing.length) {
    throw new Error(`Baseline CSV is missing required columns: ${missing.join(', ')}`);
  }
}

// Load configuration data at startup
const categoriesBrands = loadCSV('categories_brands.csv');
const aliasRows = loadCSV('brand_alias_dictionary.csv');
const modelsConfig = loadJSON('models.json');
const promptConditionsConfig = loadJSON('prompt_conditions.json');
const syntheticPersonas = [
  ...loadCSV('synthetic_personas_test.csv').map(row => ({ ...row, persona_type: 'synthetic_test' })),
  ...loadCSV('synthetic_personas.csv').map(row => ({ ...row, persona_type: 'synthetic' })),
];

// Build alias lookup:  "sub_category|normalised_alias" → standard_brand
const aliasMap = {};
for (const row of aliasRows) {
  const key = `${row.category}|${norm(row.alias)}`;
  aliasMap[key] = row.standard_brand;
}

// Build category → sub_category → focal brands index
const categoryIndex = {};
for (const row of categoriesBrands) {
  if (!categoryIndex[row.category]) categoryIndex[row.category] = {};
  if (!categoryIndex[row.category][row.sub_category]) {
    categoryIndex[row.category][row.sub_category] = [];
  }
  categoryIndex[row.category][row.sub_category].push({
    brand: row.brand,
    visibility_group: row.visibility_group,
    sub_category: row.sub_category,
  });
}

// ═══════════════════════════════════════════════════════════════════
// IN-MEMORY RUN STORE
// ═══════════════════════════════════════════════════════════════════

const runs = {};   // run_id → { status, config, results[], metrics[], progress }
let rq1AnalysisRun = null;

// ═══════════════════════════════════════════════════════════════════
// PERSISTENT RESULT CACHE
// ═══════════════════════════════════════════════════════════════════

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'result-cache.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadResultCache() {
  ensureDataDir();
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch (err) {
    console.warn(`Could not read result cache: ${err.message}`);
    return {};
  }
}

function saveResultCache() {
  ensureDataDir();
  const tmpFile = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(resultCache, null, 2));
  fs.renameSync(tmpFile, CACHE_FILE);
}

const resultCache = loadResultCache(); // cache_key → successful result rows

function cacheKeyForConfig(config) {
  return JSON.stringify({
    modelId: config.modelId,
    modelName: config.modelName,
    provider: config.provider,
    subCategory: config.subCategory,
    finalPrompt: config.finalPrompt,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    promptCondition: config.promptCondition,
    sessionRule: config.sessionRule,
    webSearch: config.webSearch,
    tools: config.tools,
  });
}

function legacyCacheKeyForConfig(config) {
  return JSON.stringify({
    modelId: config.modelId,
    modelName: config.modelName,
    provider: config.provider,
    category: config.category,
    subCategory: config.subCategory,
    finalPrompt: config.finalPrompt,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    promptCondition: config.promptCondition,
    sessionRule: config.sessionRule,
    webSearch: config.webSearch,
    tools: config.tools,
  });
}

function parsedCacheKeyMatchesConfig(parsedKey, config) {
  return Boolean(
    parsedKey &&
    parsedKey.modelId === config.modelId &&
    parsedKey.modelName === config.modelName &&
    parsedKey.provider === config.provider &&
    parsedKey.subCategory === config.subCategory &&
    parsedKey.finalPrompt === config.finalPrompt &&
    parsedKey.temperature === config.temperature &&
    parsedKey.maxOutputTokens === config.maxOutputTokens &&
    parsedKey.promptCondition === config.promptCondition &&
    parsedKey.sessionRule === config.sessionRule &&
    parsedKey.webSearch === config.webSearch &&
    parsedKey.tools === config.tools
  );
}

function hasExtractedBrand(row) {
  return [1, 2, 3, 4, 5].some(k => row[`brand_${k}`] && row[`brand_${k}`].trim() !== '');
}

function isReusableResult(row) {
  return Boolean(
    row &&
    row.response_text &&
    row.response_text.trim() !== '' &&
    !row.response_text.startsWith('[ERROR]')
  );
}

function materializeCachedRow(cachedRow, runConfig, replicate) {
  const rawBrands = extractBrands(cachedRow.response_text);
  const stdBrands = standardiseBrands(rawBrands, aliasMap, runConfig.subCategory);
  return {
    run_id: runConfig.runId,
    category: runConfig.category,
    sub_category: runConfig.subCategory,
    model_id: runConfig.modelId,
    model_name: runConfig.modelName,
    replicate,
    prompt_condition: runConfig.promptCondition,
    persona_id: runConfig.personaId || '',
    persona_type: runConfig.personaType || '',
    profile_text: runConfig.profileText || '',
    prompt: runConfig.finalPrompt,
    response_text: cachedRow.response_text,
    brand_1: stdBrands[0] || '',
    brand_2: stdBrands[1] || '',
    brand_3: stdBrands[2] || '',
    brand_4: stdBrands[3] || '',
    brand_5: stdBrands[4] || '',
    timestamp: cachedRow.timestamp || new Date().toISOString(),
    temperature: runConfig.temperature,
    max_output_tokens: runConfig.maxOutputTokens,
    notes: cachedRow.notes ? `${cachedRow.notes}; cache_hit` : 'cache_hit',
  };
}

function getCachedRows(config) {
  const keys = new Set([cacheKeyForConfig(config), legacyCacheKeyForConfig(config)]);
  const cachedRows = [];

  for (const [key, rows] of Object.entries(resultCache)) {
    try {
      if (!parsedCacheKeyMatchesConfig(JSON.parse(key), config)) continue;
    } catch (_) {
      continue;
    }
    keys.add(key);
  }

  for (const key of keys) {
    for (const row of (resultCache[key] || [])) {
      if (!isReusableResult(row)) continue;
      cachedRows.push(row);
    }
  }

  return cachedRows
    .filter(isReusableResult)
    .map((row, idx) => materializeCachedRow(row, config, idx + 1))
    .filter(hasExtractedBrand);
}

function addCachedRow(config, row) {
  if (!isReusableResult(row) || !hasExtractedBrand(row)) return;
  const key = cacheKeyForConfig(config);
  if (!resultCache[key]) resultCache[key] = [];

  resultCache[key].push({
    response_text: row.response_text,
    timestamp: row.timestamp,
    notes: row.notes || '',
  });
  saveResultCache();
}

function isQuotaError(message) {
  return /429|too many requests|resource_exhausted|quota|rate limit/i.test(String(message || ''));
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/config
 * Returns categories, focal brands, models, and the default prompt template.
 */
app.get('/api/config', (req, res) => {
  // Build a structured category list for the frontend
  const categories = Object.entries(categoryIndex).map(([cat, subs]) => ({
    category: cat,
    sub_categories: Object.entries(subs).map(([sub, brands]) => ({
      sub_category: sub,
      brands,
    })),
  }));

  res.json({
    categories,
    models: modelsConfig.models,
    defaultPrompt: 'I am looking for a [category]. Return valid JSON only, with exactly this schema: {"brands":["Brand 1","Brand 2","Brand 3","Brand 4","Brand 5"]}. Include exactly five brand names. Do not include explanations, markdown, numbering, or any text outside the JSON object.',
    promptConditions: promptConditionsConfig.conditions,
    syntheticPersonas,
    defaults: {
      replicates: 40,
      temperature: 0.7,
      maxOutputTokens: 800,
      promptCondition: 'context-free',
    },
  });
});

/**
 * POST /api/run
 * Starts an experiment run.  The run executes asynchronously;
 * poll /api/run/:id/status for progress.
 *
 * Body: { modelId, category, subCategory, promptTemplate, replicates, temperature, maxOutputTokens }
 */
app.post('/api/run', (req, res) => {
  const {
    modelId,
    category,
    subCategory,
    promptTemplate,
    replicates,
    temperature,
    maxOutputTokens,
    webSearch,
    promptCondition,
    personaId,
    personaType,
    profileText,
    notes,
  } = req.body;

  // Validate
  const model = modelsConfig.models.find(m => m.model_id === modelId);
  if (!model) return res.status(400).json({ error: `Unknown model: ${modelId}` });

  const focalBrands = categoryIndex[category]?.[subCategory];
  if (!focalBrands) return res.status(400).json({ error: `Unknown category/sub: ${category}/${subCategory}` });

  const conditionId = promptCondition || 'context-free';

  // Build the final prompt by replacing [category] with the sub_category
  const finalPrompt = promptTemplate.replace(/\[category\]/gi, subCategory);

  const runId = uuidv4();
  const run = {
    status: 'running',
    config: {
      runId,
      modelId: model.model_id,
      modelName: model.model_name,
      provider: model.provider,
      displayName: model.display_name,
      category,
      subCategory,
      promptTemplate,
      finalPrompt,
      replicates: parseInt(replicates, 10),
      temperature: parseFloat(temperature),
      maxOutputTokens: parseInt(maxOutputTokens, 10),
      promptCondition: conditionId,
      personaId: personaId || '',
      personaType: personaType || '',
      profileText: profileText || '',
      sessionRule: 'fresh_session_no_history',
      webSearch: webSearch ? 'on' : 'off',
      tools: webSearch ? 'web_search' : 'off',
      notes: notes || '',
    },
    results: [],
    metrics: [],
    progress: { completed: 0, total: parseInt(replicates, 10), errors: 0 },
    startTime: new Date().toISOString(),
    cancelRequested: false,
  };

  runs[runId] = run;
  res.json({ runId, status: 'running' });

  // Fire and forget — run replicates asynchronously
  executeRun(run);
});

/**
 * POST /api/run-all
 * Starts an experiment run for ALL product categories with the same
 * model and settings.  Each category runs sequentially to avoid
 * overwhelming API rate limits.
 *
 * Body: { modelId, promptTemplate, replicates, temperature, maxOutputTokens }
 */
app.post('/api/run-all', (req, res) => {
  const {
    modelId,
    promptTemplate,
    replicates,
    temperature,
    maxOutputTokens,
    webSearch,
    promptCondition,
    personaId,
    personaType,
    profileText,
    notes,
  } = req.body;

  const model = modelsConfig.models.find(m => m.model_id === modelId);
  if (!model) return res.status(400).json({ error: `Unknown model: ${modelId}` });

  const batchId = uuidv4();
  const runIds = [];
  const conditionId = promptCondition || 'context-free';

  // Create a run for each category/sub-category pair
  for (const [category, subs] of Object.entries(categoryIndex)) {
    for (const [subCategory, focalBrands] of Object.entries(subs)) {
      const finalPrompt = promptTemplate.replace(/\[category\]/gi, subCategory);
      const runId = uuidv4();

      const run = {
        status: 'queued',
        batchId,
        config: {
          runId,
          modelId: model.model_id,
          modelName: model.model_name,
          provider: model.provider,
          displayName: model.display_name,
          category,
          subCategory,
          promptTemplate,
          finalPrompt,
          replicates: parseInt(replicates, 10),
          temperature: parseFloat(temperature),
          maxOutputTokens: parseInt(maxOutputTokens, 10),
          promptCondition: conditionId,
          personaId: personaId || '',
          personaType: personaType || '',
          profileText: profileText || '',
          sessionRule: 'fresh_session_no_history',
          webSearch: webSearch ? 'on' : 'off',
          tools: webSearch ? 'web_search' : 'off',
          notes: notes || '',
        },
        results: [],
        metrics: [],
        progress: { completed: 0, total: parseInt(replicates, 10), errors: 0 },
        startTime: null,
        cancelRequested: false,
      };

      runs[runId] = run;
      runIds.push({ runId, category, subCategory });
    }
  }

  // Store the batch info
  runs[`batch_${batchId}`] = {
    batchId,
    status: 'running',
    runIds: runIds.map(r => r.runId),
    totalCategories: runIds.length,
    completedCategories: 0,
    cancelRequested: false,
  };

  res.json({ batchId, runIds, totalCategories: runIds.length });

  // Execute all runs sequentially in the background
  executeAllRuns(batchId, runIds.map(r => r.runId));
});

/**
 * GET /api/batch/:id/status
 * Returns progress of a batch (run-all) execution.
 */
app.get('/api/batch/:id/status', (req, res) => {
  const batch = runs[`batch_${req.params.id}`];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const runDetails = batch.runIds.map(rid => {
    const r = runs[rid];
    return {
      runId: rid,
      subCategory: r?.config?.subCategory,
      category: r?.config?.category,
      status: r?.status,
      progress: r?.progress,
    };
  });

  res.json({
    batchId: batch.batchId,
    status: batch.status,
    totalCategories: batch.totalCategories,
    completedCategories: batch.completedCategories,
    runs: runDetails,
  });
});

/**
 * POST /api/run/:id/cancel
 * Requests cancellation for a single run. In-flight API calls cannot be
 * interrupted, but the run stops before starting the next replicate.
 */
app.post('/api/run/:id/cancel', (req, res) => {
  const run = runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'Run not found' });

  run.cancelRequested = true;
  if (run.status === 'queued') run.status = 'cancelled';
  if (run.status === 'completed' || run.status === 'cancelled') {
    return res.json({ status: run.status });
  }
  res.json({ status: 'cancelling' });
});

/**
 * POST /api/batch/:id/cancel
 * Requests cancellation for an all-categories batch.
 */
app.post('/api/batch/:id/cancel', (req, res) => {
  const batch = runs[`batch_${req.params.id}`];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  batch.cancelRequested = true;
  batch.status = batch.status === 'completed' ? 'completed' : 'cancelling';

  for (const runId of batch.runIds) {
    const run = runs[runId];
    if (!run) continue;
    run.cancelRequested = true;
    if (run.status === 'queued') run.status = 'cancelled';
  }

  res.json({ status: batch.status });
});

/**
 * GET /api/run/:id/status
 * Returns current progress of a run.
 */
app.get('/api/run/:id/status', (req, res) => {
  const run = runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    status: run.status,
    progress: run.progress,
    startTime: run.startTime,
  });
});

/**
 * GET /api/run/:id/results
 * Returns full raw results and calculated metrics.
 */
app.get('/api/run/:id/results', (req, res) => {
  const run = runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    status: run.status,
    config: run.config,
    results: run.results,
    metrics: run.metrics,
    progress: run.progress,
  });
});

/**
 * GET /api/runs
 * Returns list of all runs (summary only).
 */
app.get('/api/runs', (req, res) => {
  const summaries = Object.values(runs).filter(r => r.config).map(r => ({
    runId: r.config.runId,
    status: r.status,
    model: r.config.displayName,
    category: r.config.subCategory,
    replicates: r.config.replicates,
    progress: r.progress,
    startTime: r.startTime,
  }));
  res.json(summaries);
});

app.post('/api/analysis/rq1', (req, res) => {
  if (rq1AnalysisRun?.status === 'running') {
    return res.status(409).json({ error: 'RQ1 analysis is already running.' });
  }

  let sourceRawFile = '';
  let sourceBaselineFile = '';
  let sourceFilename = '';
  let sourceBaselineFilename = '';
  try {
    const csvText = req.body?.csvText;
    const baselineCsvText = req.body?.baselineCsvText;
    sourceFilename = req.body?.filename || '';
    sourceBaselineFilename = req.body?.baselineFilename || '';
    if (csvText) {
      validateRq1CSV(csvText);
      const uploadDir = path.join(__dirname, 'data', 'uploads', 'rq1');
      fs.mkdirSync(uploadDir, { recursive: true });
      sourceRawFile = path.join(uploadDir, `${Date.now()}-${safeFilename(sourceFilename)}`);
      fs.writeFileSync(sourceRawFile, csvText, 'utf8');
    }
    if (baselineCsvText) {
      validateRq1BaselineCSV(baselineCsvText);
      const uploadDir = path.join(__dirname, 'data', 'uploads', 'rq1');
      fs.mkdirSync(uploadDir, { recursive: true });
      sourceBaselineFile = path.join(uploadDir, `${Date.now()}-${safeFilename(sourceBaselineFilename)}`);
      fs.writeFileSync(sourceBaselineFile, baselineCsvText, 'utf8');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  rq1AnalysisRun = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stdout: '',
    stderr: '',
    files: {},
    sourceFilename: sourceFilename || 'default local Study 1 CSV',
    baselineFilename: sourceBaselineFilename || 'test baseline data',
    sourceMode: sourceRawFile ? 'uploaded_csv' : 'default_path',
    baselineMode: sourceBaselineFile ? 'uploaded_baseline_csv' : 'test_data',
  };

  execFile('Rscript', ['scripts/run-rq1-logit.R'], {
    cwd: __dirname,
    env: {
      ...process.env,
      ...(sourceRawFile ? { RQ1_RAW_FILE: sourceRawFile } : {}),
      ...(sourceBaselineFile ? { RQ1_BASELINE_FILE: sourceBaselineFile } : {}),
    },
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 5,
  }, (err, stdout, stderr) => {
    const outDir = path.join(__dirname, 'data', 'analysis', 'rq1');
    const summaryFile = path.join(outDir, 'rq1_summary.md');

    rq1AnalysisRun.status = err ? 'failed' : 'completed';
    rq1AnalysisRun.finishedAt = new Date().toISOString();
    rq1AnalysisRun.stdout = stdout || '';
    rq1AnalysisRun.stderr = stderr || '';
    rq1AnalysisRun.error = err ? err.message : '';
    rq1AnalysisRun.files = {
      summary: summaryFile,
      rawInput: sourceRawFile || path.join(__dirname, 'data', 'exports', 'study1', 'full_2026-05-05_all_models', 'raw_results_cleaned.csv'),
      baselineInput: sourceBaselineFile || path.join(__dirname, 'config', 'brand_baseline_test.csv'),
      binaryDataset: path.join(outDir, 'study1_brand_binary_dataset_focal.csv'),
      predictorTemplate: path.join(outDir, 'brand_predictors_template.csv'),
      visibilityModel: path.join(outDir, 'logit_model1_visibility.csv'),
      visibilityModelInteraction: path.join(outDir, 'logit_model3_visibility_model_interaction.csv'),
      visibilityModelInteractionAllRefs: path.join(outDir, 'logit_model3_visibility_model_interaction_all_refs.csv'),
      fitStats: path.join(outDir, 'logit_fit_stats.csv'),
      recommendationRates: path.join(outDir, 'brand_recommendation_rates.csv'),
      visibilityRates: path.join(outDir, 'visibility_recommendation_rates.csv'),
      categoryVisibilityRates: path.join(outDir, 'category_visibility_recommendation_rates.csv'),
      categoryPopularityBias: path.join(outDir, 'category_popularity_bias.csv'),
      nicheBrandOpportunities: path.join(outDir, 'niche_brand_opportunities.csv'),
      modelVisibilityRates: path.join(outDir, 'model_visibility_recommendation_rates.csv'),
      modelPopularityBias: path.join(outDir, 'model_popularity_bias.csv'),
      baselineDistributionBias: path.join(outDir, 'baseline_distribution_bias_testdata.csv'),
      baselineModelBias: path.join(outDir, 'baseline_model_bias_testdata.csv'),
      brandBaselineOverrecommendation: path.join(outDir, 'brand_baseline_overrecommendation_testdata.csv'),
      brandLevelOrrModel: path.join(outDir, 'brand_level_orr_model_testdata.csv'),
      segmentShareBias: path.join(outDir, 'segment_share_bias_testdata.csv'),
      categoryModelBiasModels: path.join(outDir, 'category_model_bias_models_testdata.csv'),
    };
    rq1AnalysisRun.summary = fs.existsSync(summaryFile)
      ? fs.readFileSync(summaryFile, 'utf8')
      : '';
    rq1AnalysisRun.tables = {
      visibilityModel: readCSVIfExists(rq1AnalysisRun.files.visibilityModel),
      visibilityModelInteraction: readCSVIfExists(rq1AnalysisRun.files.visibilityModelInteraction),
      visibilityModelInteractionAllRefs: readCSVIfExists(rq1AnalysisRun.files.visibilityModelInteractionAllRefs),
      fitStats: readCSVIfExists(rq1AnalysisRun.files.fitStats),
      visibilityRates: readCSVIfExists(rq1AnalysisRun.files.visibilityRates),
      categoryVisibilityRates: readCSVIfExists(rq1AnalysisRun.files.categoryVisibilityRates),
      categoryPopularityBias: readCSVIfExists(rq1AnalysisRun.files.categoryPopularityBias),
      nicheBrandOpportunities: readCSVIfExists(rq1AnalysisRun.files.nicheBrandOpportunities),
      modelVisibilityRates: readCSVIfExists(rq1AnalysisRun.files.modelVisibilityRates),
      modelPopularityBias: readCSVIfExists(rq1AnalysisRun.files.modelPopularityBias),
      baselineDistributionBias: readCSVIfExists(rq1AnalysisRun.files.baselineDistributionBias),
      baselineModelBias: readCSVIfExists(rq1AnalysisRun.files.baselineModelBias),
      brandBaselineOverrecommendation: readCSVIfExists(rq1AnalysisRun.files.brandBaselineOverrecommendation),
      brandLevelOrrModel: readCSVIfExists(rq1AnalysisRun.files.brandLevelOrrModel),
      segmentShareBias: readCSVIfExists(rq1AnalysisRun.files.segmentShareBias),
      categoryModelBiasModels: readCSVIfExists(rq1AnalysisRun.files.categoryModelBiasModels),
    };
  });

  res.json({ status: 'running', startedAt: rq1AnalysisRun.startedAt });
});

app.get('/api/analysis/rq1/status', (req, res) => {
  if (!rq1AnalysisRun) {
    return res.json({ status: 'idle' });
  }
  res.json(rq1AnalysisRun);
});

// ═══════════════════════════════════════════════════════════════════
// EXPERIMENT EXECUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Runs all replicates sequentially.  Each replicate is an independent
 * API call with no shared conversation history.
 */
async function executeRun(run) {
  const { provider, modelName, finalPrompt, replicates, temperature, maxOutputTokens, webSearch } = run.config;
  const focalBrands = categoryIndex[run.config.category][run.config.subCategory];
  const cachedRows = getCachedRows(run.config).slice(0, replicates);

  for (let i = 1; i <= replicates; i++) {
    if (run.cancelRequested) break;
    let responseText = '';
    try {
      if (cachedRows[i - 1]) {
        const cachedRow = { ...cachedRows[i - 1], replicate: i };
        run.results.push(cachedRow);
        run.progress.completed = i;
        continue;
      }

      // ── Independent API call (fresh session, no history) ─────────
      responseText = await sendPrompt(provider, modelName, finalPrompt, temperature, maxOutputTokens, webSearch === 'on');
      if (!responseText || responseText.trim() === '') {
        throw new Error('Model returned an empty response');
      }

      // ── Extract and standardise brands ───────────────────────────
      const rawBrands = extractBrands(responseText);
      const stdBrands = standardiseBrands(rawBrands, aliasMap, run.config.subCategory);
      if (stdBrands.length === 0) {
        throw new Error('No brands could be extracted from the model response');
      }

      // ── Build result row ─────────────────────────────────────────
      const row = {
        run_id: run.config.runId,
        category: run.config.category,
        sub_category: run.config.subCategory,
        model_id: run.config.modelId,
        model_name: run.config.modelName,
        replicate: i,
        prompt_condition: run.config.promptCondition,
        persona_id: run.config.personaId || '',
        persona_type: run.config.personaType || '',
        profile_text: run.config.profileText || '',
        prompt: finalPrompt,
        response_text: responseText,
        brand_1: stdBrands[0] || '',
        brand_2: stdBrands[1] || '',
        brand_3: stdBrands[2] || '',
        brand_4: stdBrands[3] || '',
        brand_5: stdBrands[4] || '',
        timestamp: new Date().toISOString(),
        temperature,
        max_output_tokens: maxOutputTokens,
        notes: run.config.notes,
      };

      run.results.push(row);
      addCachedRow(run.config, row);
      run.progress.completed = i;
    } catch (err) {
      console.error(`Replicate ${i} failed:`, err.message);
      run.progress.errors++;
      run.progress.completed = i;

      // Store an error row so we can audit failures
      run.results.push({
        run_id: run.config.runId,
        category: run.config.category,
        sub_category: run.config.subCategory,
        model_id: run.config.modelId,
        model_name: run.config.modelName,
        replicate: i,
        prompt_condition: run.config.promptCondition,
        persona_id: run.config.personaId || '',
        persona_type: run.config.personaType || '',
        profile_text: run.config.profileText || '',
        prompt: finalPrompt,
        response_text: responseText
          ? `[ERROR] ${err.message}\n\n[RAW RESPONSE]\n${responseText}`
          : `[ERROR] ${err.message}`,
        brand_1: '', brand_2: '', brand_3: '', brand_4: '', brand_5: '',
        timestamp: new Date().toISOString(),
        temperature,
        max_output_tokens: maxOutputTokens,
        notes: `Error: ${err.message}`,
      });

      if (isQuotaError(err.message)) {
        run.quotaLimited = true;
        break;
      }
    }
  }

  // ── Calculate metrics ──────────────────────────────────────────
  const successfulResults = run.results.filter(r => !r.response_text.startsWith('[ERROR]'));
  run.metrics = calculateMetrics(
    successfulResults,
    focalBrands,
    run.config.subCategory,
    run.config.modelId,
    run.config.promptCondition
  );
  run.status = run.cancelRequested ? 'cancelled' : 'completed';
  console.log(`Run ${run.config.runId} ${run.status}: ${run.progress.completed}/${replicates} replicates, ${run.progress.errors} errors`);
}

/**
 * Runs all categories in a batch sequentially.
 * Each category's replicates complete before moving to the next.
 */
async function executeAllRuns(batchId, runIds) {
  const batch = runs[`batch_${batchId}`];

  for (const runId of runIds) {
    if (batch.cancelRequested) break;

    const run = runs[runId];
    if (!run) continue;
    if (run.status === 'cancelled') continue;

    run.status = 'running';
    run.startTime = new Date().toISOString();
    console.log(`[Batch ${batchId}] Starting category: ${run.config.subCategory}`);

    await executeRun(run);

    if (run.status === 'completed') {
      batch.completedCategories++;
      console.log(`[Batch ${batchId}] Completed ${batch.completedCategories}/${batch.totalCategories}`);
    }
  }

  if (batch.cancelRequested) {
    for (const runId of runIds) {
      const run = runs[runId];
      if (run && run.status === 'queued') run.status = 'cancelled';
    }
    batch.status = 'cancelled';
    console.log(`[Batch ${batchId}] Cancelled after ${batch.completedCategories}/${batch.totalCategories} categories.`);
  } else {
    batch.status = 'completed';
    console.log(`[Batch ${batchId}] All ${batch.totalCategories} categories completed.`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  LLM Brand Recommendation Experiment Server     ║`);
  console.log(`  ║  http://localhost:${PORT}                          ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});
