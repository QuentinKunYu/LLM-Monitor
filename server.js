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
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { parse } = require('csv-parse/sync');
const { sendPrompt } = require('./lib/llm-clients');
const { extractBrands, standardiseBrands, norm } = require('./lib/brand-extractor');
const { calculateMetrics } = require('./lib/metrics');
const {
  buildReasonPrompt,
  dryRunReasonResponse,
  reasonFieldsFromResponse,
  blankReasonFields,
} = require('./lib/followup-reasons');
const {
  loadNeedsPrompts,
  summariseNeedsPrompts,
  validateNeedsPrompts,
} = require('./lib/study3-needs');
const {
  PAPER_DEFAULTS,
  buildProtocol,
  calculateExperimentMetrics,
} = require('./lib/experiment-orchestrator');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requirePassword(req, res, next) {
  if (!APP_PASSWORD) return next();

  const authHeader = req.get('authorization') || '';
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const password = separator >= 0 ? decoded.slice(separator + 1) : decoded;
    if (safeCompare(password, APP_PASSWORD)) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="LLM Brand Experiment"');
  return res.status(401).send('Authentication required');
}

app.use(requirePassword);
app.use(express.static(path.join(__dirname, 'public')));

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

function validateNeedsPromptCSV(csvText) {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  validateNeedsPrompts(rows);
}

function readJSONIfExists(filepath) {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function defaultNeedsPromptFile() {
  return path.join(__dirname, 'config', 'needs_based_prompts.csv');
}

function latestStudy3OutputDir() {
  const study3Dir = dataPath('exports', 'study3');
  if (!fs.existsSync(study3Dir)) return '';
  const dirs = fs.readdirSync(study3Dir)
    .map(name => path.join(study3Dir, name))
    .filter(filepath => fs.existsSync(path.join(filepath, 'progress.json')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] || '';
}

function readStudy3Tables(outputDir) {
  if (!outputDir) return {};
  return {
    rawResults: readCSVIfExists(path.join(outputDir, 'raw_results_cleaned.csv')),
    metrics: readCSVIfExists(path.join(outputDir, 'metrics.csv')),
    metricsByTheme: readCSVIfExists(path.join(outputDir, 'metrics_by_theme.csv')),
    conditionSummary: readCSVIfExists(path.join(outputDir, 'condition_summary.csv')),
    themeSummary: readCSVIfExists(path.join(outputDir, 'theme_summary.csv')),
    promptSummary: readCSVIfExists(path.join(outputDir, 'prompt_summary.csv')),
  };
}

// Load configuration data at startup
const categoriesBrands = loadCSV('categories_brands.csv');
const aliasRows = loadCSV('brand_alias_dictionary.csv');
const modelsConfig = loadJSON('models.json');
const promptConditionsConfig = loadJSON('prompt_conditions.json');
const DEFAULT_CONTEXT_FREE_PROMPT = 'I am looking for a [category]. Return valid JSON only, with this schema: {"brands":["Brand name"]}. Include up to five brand names. Do not include explanations, markdown, numbering, or any text outside the JSON object.';
const defaultNeedsPrompts = loadNeedsPrompts(defaultNeedsPromptFile());
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
const experiments = {}; // secure, token-scoped public experiment jobs
const experimentCredentials = new Map(); // never serialized
let rq1AnalysisRun = null;
let study3NeedsRun = null;

// ═══════════════════════════════════════════════════════════════════
// PERSISTENT RESULT CACHE
// ═══════════════════════════════════════════════════════════════════

const CACHE_FILE = path.join(DATA_DIR, 'result-cache.json');
const EXPERIMENT_DIR = path.join(DATA_DIR, 'experiments');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function experimentFile(runId) {
  return path.join(EXPERIMENT_DIR, `${runId}.json`);
}

function persistExperiment(experiment) {
  ensureDataDir();
  fs.mkdirSync(EXPERIMENT_DIR, { recursive: true });
  const filepath = experimentFile(experiment.runId);
  const tmpFile = `${filepath}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(experiment));
  fs.renameSync(tmpFile, filepath);
}

function loadExperiments() {
  ensureDataDir();
  if (!fs.existsSync(EXPERIMENT_DIR)) return;
  for (const filename of fs.readdirSync(EXPERIMENT_DIR).filter(name => name.endsWith('.json'))) {
    try {
      const experiment = JSON.parse(fs.readFileSync(path.join(EXPERIMENT_DIR, filename), 'utf8'));
      if (!experiment?.runId || !experiment?.tokenDigest) continue;
      if (experiment.status === 'running' || experiment.status === 'cancelling') {
        experiment.status = 'interrupted';
        experiment.stage = 'interrupted';
        experiment.message = 'The server restarted. Re-enter provider keys to retry unfinished observations.';
      }
      experiments[experiment.runId] = experiment;
      persistExperiment(experiment);
    } catch (err) {
      console.warn(`Could not restore experiment ${filename}: ${err.message}`);
    }
  }
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function authorizeExperiment(req, res) {
  const experiment = experiments[req.params.id];
  if (!experiment) {
    res.status(404).json({ error: 'Experiment not found.' });
    return null;
  }
  const providedDigest = tokenDigest(req.get('x-run-token') || '');
  if (!safeCompare(providedDigest, experiment.tokenDigest)) {
    res.status(403).json({ error: 'A valid run token is required.' });
    return null;
  }
  return experiment;
}

function publicExperimentStatus(experiment) {
  const { needsPrompts, ...safeConfig } = experiment.config;
  return {
    runId: experiment.runId,
    status: experiment.status,
    stage: experiment.stage,
    message: experiment.message || '',
    createdAt: experiment.createdAt,
    startedAt: experiment.startedAt,
    finishedAt: experiment.finishedAt,
    counts: experiment.counts,
    progress: experiment.progress,
    completeness: experiment.completeness,
    errors: experiment.errors.slice(-50),
    config: {
      ...safeConfig,
      needsPromptCount: needsPrompts?.length || 0,
    },
  };
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
loadExperiments();

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
    ...blankReasonFields(),
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

function dryRunBrandResponse(subCategory) {
  const fixtures = {
    'cordless drills': ['DeWalt', 'Milwaukee', 'Ryobi', 'Makita', 'Bosch'],
    'coffee maker': ['Breville', 'Cuisinart', 'DeLonghi', 'Ninja', 'Keurig'],
    'cat food': ['Purina Pro Plan', "Hill's Science Diet", 'Royal Canin', 'Blue Buffalo', 'Iams'],
    'boat cruises': ['Royal Caribbean', 'Carnival Cruise Line', 'Norwegian Cruise Line', 'Viking', 'Celebrity Cruises'],
    'hiking jacket': ['Patagonia', 'The North Face', "Arc'teryx", 'Columbia', 'REI'],
  };
  return JSON.stringify({ brands: fixtures[subCategory] || ['Brand A', 'Brand B', 'Brand C', 'Brand D', 'Brand E'] });
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
    defaultPrompt: DEFAULT_CONTEXT_FREE_PROMPT,
    promptConditions: promptConditionsConfig.conditions,
    syntheticPersonas,
    needsPromptSummary: summariseNeedsPrompts(defaultNeedsPrompts, 'config/needs_based_prompts.csv'),
    paperDefaults: {
      ...PAPER_DEFAULTS,
      models: modelsConfig.models.map(model => model.model_id),
      categories: [...new Set(categoriesBrands.map(row => row.sub_category))],
      promptTemplate: DEFAULT_CONTEXT_FREE_PROMPT,
      needsPromptCount: defaultNeedsPrompts.length,
      primaryRecommendationCalls: 3600,
      reasonCalls: 3600,
      totalCalls: 7200,
    },
    defaults: {
      replicates: 40,
      temperature: null,
      maxOutputTokens: 800,
      promptCondition: 'context-free',
    },
  });
});

app.get('/api/prompts', (req, res) => {
  res.json({
    prompts: defaultNeedsPrompts,
    summary: summariseNeedsPrompts(defaultNeedsPrompts, 'config/needs_based_prompts.csv'),
  });
});

app.post('/api/experiments', (req, res) => {
  try {
    const requestedPrompts = req.body?.needsPrompts
      ? validateNeedsPrompts(req.body.needsPrompts)
      : defaultNeedsPrompts;
    const protocol = buildProtocol({
      availableModels: modelsConfig.models,
      categoryRows: categoriesBrands,
      needsPrompts: requestedPrompts,
      input: {
        ...req.body,
        promptTemplate: req.body?.promptTemplate || DEFAULT_CONTEXT_FREE_PROMPT,
      },
    });
    const apiKeys = normaliseApiKeys(req.body?.apiKeys);
    validateExperimentCredentials(protocol, apiKeys);

    const runId = crypto.randomUUID();
    const runToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const experiment = {
      runId,
      tokenDigest: tokenDigest(runToken),
      status: 'running',
      stage: 'context-free',
      message: 'Preparing independent context-free requests.',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      cancelRequested: false,
      config: {
        ...protocol.config,
        protocolMode: isPaperDefaultProtocol(protocol) ? 'paper-defaults' : 'custom-run',
      },
      counts: protocol.counts,
      progress: initialExperimentProgress(protocol.counts),
      completeness: {
        complete: false,
        successfulRecommendations: 0,
        expectedRecommendations: protocol.counts.recommendationCalls,
        completedReasons: 0,
        expectedReasons: protocol.counts.reasonCalls,
      },
      recommendationTasks: protocol.recommendationTasks,
      results: [],
      metrics: [],
      errors: [],
    };

    experiments[runId] = experiment;
    experimentCredentials.set(runId, apiKeys);
    persistExperiment(experiment);
    res.status(202).json({
      runId,
      runToken,
      status: experiment.status,
      counts: experiment.counts,
      protocolMode: experiment.config.protocolMode,
    });
    executeUnifiedExperiment(experiment).catch(err => failUnifiedExperiment(experiment, err));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/experiments/:id', (req, res) => {
  const experiment = authorizeExperiment(req, res);
  if (!experiment) return;
  res.json(publicExperimentStatus(experiment));
});

app.get('/api/experiments/:id/results', (req, res) => {
  const experiment = authorizeExperiment(req, res);
  if (!experiment) return;
  res.json({
    ...publicExperimentStatus(experiment),
    results: experiment.results,
    metrics: experiment.metrics,
    prompts: experiment.config.needsPrompts,
    artifacts: [
      'raw_results.csv',
      'cleaned_results.csv',
      'brand_reasons.csv',
      'metrics.csv',
      'prompt_library.csv',
      'run_configuration.json',
      'quality_report.txt',
    ],
  });
});

app.post('/api/experiments/:id/cancel', (req, res) => {
  const experiment = authorizeExperiment(req, res);
  if (!experiment) return;
  if (['completed', 'incomplete', 'failed', 'cancelled'].includes(experiment.status)) {
    return res.json(publicExperimentStatus(experiment));
  }
  experiment.cancelRequested = true;
  experiment.status = 'cancelling';
  experiment.message = 'Stopping after the current provider request.';
  persistExperiment(experiment);
  res.json(publicExperimentStatus(experiment));
});

app.post('/api/experiments/:id/retry', (req, res) => {
  const experiment = authorizeExperiment(req, res);
  if (!experiment) return;
  if (experiment.status === 'running' || experiment.status === 'cancelling') {
    return res.status(409).json({ error: 'This experiment is already running.' });
  }
  try {
    const apiKeys = normaliseApiKeys(req.body?.apiKeys);
    validateExperimentCredentials({ recommendationTasks: experiment.recommendationTasks, config: experiment.config }, apiKeys);
    experimentCredentials.set(experiment.runId, apiKeys);
    experiment.cancelRequested = false;
    experiment.status = 'running';
    experiment.stage = nextExperimentStage(experiment);
    experiment.message = 'Retrying unfinished observations only.';
    experiment.errors = [];
    experiment.finishedAt = null;
    persistExperiment(experiment);
    res.status(202).json(publicExperimentStatus(experiment));
    executeUnifiedExperiment(experiment).catch(err => failUnifiedExperiment(experiment, err));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
    followupReasons,
    reasonMaxOutputTokens,
    bypassCache,
    dryRun,
  } = req.body;

  // Validate
  const model = modelsConfig.models.find(m => m.model_id === modelId);
  if (!model) return res.status(400).json({ error: `Unknown model: ${modelId}` });

  const focalBrands = categoryIndex[category]?.[subCategory];
  if (!focalBrands) return res.status(400).json({ error: `Unknown category/sub: ${category}/${subCategory}` });

  const conditionId = promptCondition || 'context-free';

  // Build the final prompt by replacing [category] with the sub_category
  const finalPrompt = promptTemplate.replace(/\[category\]/gi, subCategory);

  const runId = crypto.randomUUID();
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
      followupReasons: Boolean(followupReasons),
      reasonMaxOutputTokens: parseInt(reasonMaxOutputTokens || maxOutputTokens || 800, 10),
      bypassCache: Boolean(bypassCache),
      dryRun: Boolean(dryRun),
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

  const batchId = crypto.randomUUID();
  const runIds = [];
  const conditionId = promptCondition || 'context-free';

  // Create a run for each category/sub-category pair
  for (const [category, subs] of Object.entries(categoryIndex)) {
    for (const [subCategory, focalBrands] of Object.entries(subs)) {
      const finalPrompt = promptTemplate.replace(/\[category\]/gi, subCategory);
      const runId = crypto.randomUUID();

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
    quotaLimited: Boolean(run.quotaLimited),
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

app.get('/api/study3/needs-prompts', (req, res) => {
  try {
    const promptFile = defaultNeedsPromptFile();
    if (!fs.existsSync(promptFile)) {
      return res.status(404).json({ error: 'config/needs_based_prompts.csv was not found.' });
    }
    const prompts = loadNeedsPrompts(promptFile);
    res.json({
      source: promptFile,
      summary: summariseNeedsPrompts(prompts, promptFile),
      preview: prompts.slice(0, 8),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/study3/needs/run', (req, res) => {
  if (study3NeedsRun?.status === 'running') {
    return res.status(409).json({ error: 'Study 3 needs-based run is already running.' });
  }

  let promptFile = defaultNeedsPromptFile();
  let sourceFilename = 'config/needs_based_prompts.csv';
  try {
    const csvText = req.body?.csvText;
    sourceFilename = req.body?.filename || sourceFilename;
    if (csvText) {
      validateNeedsPromptCSV(csvText);
      const uploadDir = dataPath('uploads', 'study3');
      fs.mkdirSync(uploadDir, { recursive: true });
      promptFile = path.join(uploadDir, `${Date.now()}-${safeFilename(sourceFilename)}`);
      fs.writeFileSync(promptFile, csvText, 'utf8');
    } else if (!fs.existsSync(promptFile)) {
      return res.status(400).json({ error: 'No Study 3 prompt CSV uploaded and no default config/needs_based_prompts.csv found.' });
    } else {
      validateNeedsPromptCSV(fs.readFileSync(promptFile, 'utf8'));
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const repeatCount = Math.max(1, Number.parseInt(req.body?.repeatCount || '2', 10));
  const runStamp = req.body?.runStamp || `needs_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = dataPath('exports', 'study3', runStamp);
  const env = {
    ...process.env,
    NEEDS_PROMPTS_FILE: promptFile,
    REPEATS: String(repeatCount),
    RUN_STAMP: runStamp,
    TEMPERATURE: String(req.body?.temperature ?? 0.7),
    MAX_OUTPUT_TOKENS: String(req.body?.maxOutputTokens ?? 800),
    WEB_SEARCH: req.body?.webSearch ? 'true' : 'false',
    DRY_RUN: req.body?.dryRun ? 'true' : 'false',
    MODELS: Array.isArray(req.body?.models) ? req.body.models.join(',') : String(req.body?.models || ''),
    CATEGORIES: Array.isArray(req.body?.categories) ? req.body.categories.join(',') : String(req.body?.categories || ''),
    CONDITIONS: Array.isArray(req.body?.conditions) ? req.body.conditions.join(',') : String(req.body?.conditions || ''),
    THEMES: Array.isArray(req.body?.themes) ? req.body.themes.join(',') : String(req.body?.themes || ''),
    PROMPT_IDS: Array.isArray(req.body?.promptIds) ? req.body.promptIds.join(',') : String(req.body?.promptIds || ''),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  study3NeedsRun = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceFilename,
    promptFile,
    outputDir,
    runStamp,
    repeatCount,
    stdout: '',
    stderr: '',
    error: '',
  };

  const child = spawn(process.execPath, ['scripts/run-needs-based-prompts.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  study3NeedsRun.pid = child.pid;

  child.stdout.on('data', chunk => {
    study3NeedsRun.stdout = `${study3NeedsRun.stdout}${chunk.toString()}`.slice(-20000);
  });
  child.stderr.on('data', chunk => {
    study3NeedsRun.stderr = `${study3NeedsRun.stderr}${chunk.toString()}`.slice(-20000);
  });
  child.on('close', code => {
    study3NeedsRun.status = code === 0 ? 'completed' : 'failed';
    study3NeedsRun.finishedAt = new Date().toISOString();
    study3NeedsRun.exitCode = code;
    if (code !== 0) study3NeedsRun.error = `Study 3 runner exited with code ${code}`;
  });

  res.json({ status: 'running', runStamp, outputDir, startedAt: study3NeedsRun.startedAt });
});

app.get('/api/study3/needs/status', (req, res) => {
  const activeOrLatest = study3NeedsRun || (() => {
    const outputDir = latestStudy3OutputDir();
    if (!outputDir) return null;
    const progress = readJSONIfExists(path.join(outputDir, 'progress.json'));
    return progress ? {
      status: progress.status || 'completed',
      outputDir,
      promptFile: progress.promptFile || '',
      startedAt: progress.startedAt || '',
      finishedAt: progress.finishedAt || '',
    } : null;
  })();

  if (!activeOrLatest) {
    return res.json({ status: 'idle' });
  }

  const outputDir = activeOrLatest.outputDir;
  const progress = readJSONIfExists(path.join(outputDir, 'progress.json')) || {};
  const status = activeOrLatest.status === 'running'
    ? 'running'
    : (progress.status || activeOrLatest.status || 'completed');

  res.json({
    ...activeOrLatest,
    ...progress,
    status,
    tables: status === 'completed' || status === 'failed'
      ? readStudy3Tables(outputDir)
      : readStudy3Tables(outputDir),
  });
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
      const uploadDir = dataPath('uploads', 'rq1');
      fs.mkdirSync(uploadDir, { recursive: true });
      sourceRawFile = path.join(uploadDir, `${Date.now()}-${safeFilename(sourceFilename)}`);
      fs.writeFileSync(sourceRawFile, csvText, 'utf8');
    }
    if (baselineCsvText) {
      validateRq1BaselineCSV(baselineCsvText);
      const uploadDir = dataPath('uploads', 'rq1');
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
    const outDir = dataPath('analysis', 'rq1');
    const summaryFile = path.join(outDir, 'rq1_summary.md');

    rq1AnalysisRun.status = err ? 'failed' : 'completed';
    rq1AnalysisRun.finishedAt = new Date().toISOString();
    rq1AnalysisRun.stdout = stdout || '';
    rq1AnalysisRun.stderr = stderr || '';
    rq1AnalysisRun.error = err ? err.message : '';
    rq1AnalysisRun.files = {
      summary: summaryFile,
      rawInput: sourceRawFile || dataPath('exports', 'study1', 'full_2026-05-05_all_models', 'raw_results_cleaned.csv'),
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

function normaliseApiKeys(value = {}) {
  return {
    openai: String(value.openai || '').trim(),
    google: String(value.google || '').trim(),
    anthropic: String(value.anthropic || '').trim(),
  };
}

function validateExperimentCredentials(protocol, apiKeys) {
  if (protocol.config?.dryRun) return;
  const tasks = protocol.recommendationTasks || [];
  const providers = [...new Set(tasks.map(task => task.provider).filter(Boolean))];
  const environmentKeys = {
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  const missing = providers.filter(provider => !apiKeys[provider] && !environmentKeys[provider]);
  if (missing.length) {
    throw new Error(`Server API key is not configured for: ${missing.join(', ')}.`);
  }
}

function isPaperDefaultProtocol(protocol) {
  const expectedModels = modelsConfig.models.map(model => model.model_id);
  const expectedCategories = [...new Set(categoriesBrands.map(row => row.sub_category))];
  const config = protocol.config;
  return (
    JSON.stringify(config.models) === JSON.stringify(expectedModels) &&
    JSON.stringify(config.categories) === JSON.stringify(expectedCategories) &&
    config.contextFreeReplicates === PAPER_DEFAULTS.contextFreeReplicates &&
    config.needsRepeats === PAPER_DEFAULTS.needsRepeats &&
    config.maxOutputTokens === PAPER_DEFAULTS.maxOutputTokens &&
    config.reasonMaxOutputTokens === PAPER_DEFAULTS.reasonMaxOutputTokens &&
    config.temperature === null &&
    config.followupReasons === true &&
    config.webSearch === false &&
    config.dryRun === false &&
    config.promptTemplate === DEFAULT_CONTEXT_FREE_PROMPT &&
    config.needsPrompts.length === defaultNeedsPrompts.length &&
    config.needsPrompts.every((prompt, index) => (
      prompt.prompt_id === defaultNeedsPrompts[index]?.prompt_id &&
      prompt.prompt === defaultNeedsPrompts[index]?.prompt
    ))
  );
}

function initialExperimentProgress(counts) {
  return {
    contextFree: { completed: 0, total: counts.contextFreeCalls, errors: 0 },
    needsBased: { completed: 0, total: counts.needsBasedCalls, errors: 0 },
    reasons: { completed: 0, total: counts.reasonCalls, errors: 0 },
    completedCalls: 0,
    totalCalls: counts.totalCalls,
    percent: 0,
  };
}

function updateUnifiedProgress(experiment) {
  const contextRows = experiment.results.filter(row => row.stage === 'context-free');
  const needsRows = experiment.results.filter(row => row.stage === 'needs-based');
  const reasonAttempted = experiment.results.filter(row => row.reason_status);
  const progress = experiment.progress;
  progress.contextFree.completed = contextRows.length;
  progress.contextFree.errors = contextRows.filter(row => row.status !== 'completed').length;
  progress.needsBased.completed = needsRows.length;
  progress.needsBased.errors = needsRows.filter(row => row.status !== 'completed').length;
  progress.reasons.completed = reasonAttempted.length;
  progress.reasons.errors = reasonAttempted.filter(row => row.reason_status !== 'completed').length;
  progress.completedCalls = contextRows.length + needsRows.length + reasonAttempted.length;
  progress.percent = progress.totalCalls
    ? Math.min(100, Math.round((progress.completedCalls / progress.totalCalls) * 1000) / 10)
    : 0;
}

function upsertUnifiedResult(experiment, row) {
  const index = experiment.results.findIndex(item => item.task_key === row.task_key);
  if (index >= 0) experiment.results[index] = row;
  else experiment.results.push(row);
  updateUnifiedProgress(experiment);
}

function nextExperimentStage(experiment) {
  const completedKeys = new Set(
    experiment.results.filter(row => row.status === 'completed').map(row => row.task_key)
  );
  if (experiment.recommendationTasks.some(task => task.stage === 'context-free' && !completedKeys.has(task.task_key))) {
    return 'context-free';
  }
  if (experiment.recommendationTasks.some(task => task.stage === 'needs-based' && !completedKeys.has(task.task_key))) {
    return 'needs-based';
  }
  if (experiment.config.followupReasons && experiment.results.some(row => row.status === 'completed' && row.reason_status !== 'completed')) {
    return 'reasons';
  }
  return 'results';
}

function apiKeyForTask(credentials, task) {
  return credentials?.[task.provider] || '';
}

async function executeUnifiedRecommendation(experiment, task, credentials) {
  let responseText = '';
  try {
    responseText = experiment.config.dryRun
      ? dryRunBrandResponse(task.sub_category)
      : await sendPrompt(
        task.provider,
        task.model_name,
        task.prompt,
        experiment.config.temperature,
        experiment.config.maxOutputTokens,
        experiment.config.webSearch,
        apiKeyForTask(credentials, task)
      );
    if (!String(responseText || '').trim()) throw new Error('Model returned an empty response.');
    const rawBrands = extractBrands(responseText);
    const standardBrands = standardiseBrands(rawBrands, aliasMap, task.sub_category);
    if (!standardBrands.length) throw new Error('No brands could be extracted from the model response.');
    upsertUnifiedResult(experiment, {
      task_key: task.task_key,
      run_id: experiment.runId,
      study: task.study,
      stage: task.stage,
      status: 'completed',
      category: task.category,
      sub_category: task.sub_category,
      model_id: task.model_id,
      model_name: task.model_name,
      provider: task.provider,
      prompt_condition: task.prompt_condition,
      theme: task.theme,
      prompt_id: task.prompt_id,
      replicate: task.replicate,
      repeat_index: task.repeat_index,
      prompt: task.prompt,
      response_text: responseText,
      extracted_brands: rawBrands.slice(0, 5),
      brand_1: standardBrands[0] || '',
      brand_2: standardBrands[1] || '',
      brand_3: standardBrands[2] || '',
      brand_4: standardBrands[3] || '',
      brand_5: standardBrands[4] || '',
      ...blankReasonFields(),
      timestamp: new Date().toISOString(),
      temperature: experiment.config.temperature === null ? '' : experiment.config.temperature,
      max_output_tokens: experiment.config.maxOutputTokens,
      session_rule: 'fresh_session_no_history',
      web_search: experiment.config.webSearch ? 'on' : 'off',
      cache: 'off',
    });
  } catch (err) {
    const error = {
      task_key: task.task_key,
      stage: task.stage,
      provider: task.provider,
      model_id: task.model_id,
      prompt_id: task.prompt_id,
      message: err.message,
      quotaLimited: isQuotaError(err.message),
      timestamp: new Date().toISOString(),
    };
    experiment.errors.push(error);
    upsertUnifiedResult(experiment, {
      task_key: task.task_key,
      run_id: experiment.runId,
      study: task.study,
      stage: task.stage,
      status: 'error',
      category: task.category,
      sub_category: task.sub_category,
      model_id: task.model_id,
      model_name: task.model_name,
      provider: task.provider,
      prompt_condition: task.prompt_condition,
      theme: task.theme,
      prompt_id: task.prompt_id,
      replicate: task.replicate,
      repeat_index: task.repeat_index,
      prompt: task.prompt,
      response_text: responseText
        ? `[ERROR] ${err.message}\n\n[RAW RESPONSE]\n${responseText}`
        : `[ERROR] ${err.message}`,
      extracted_brands: [],
      brand_1: '', brand_2: '', brand_3: '', brand_4: '', brand_5: '',
      ...blankReasonFields(),
      timestamp: new Date().toISOString(),
      temperature: experiment.config.temperature === null ? '' : experiment.config.temperature,
      max_output_tokens: experiment.config.maxOutputTokens,
      session_rule: 'fresh_session_no_history',
      web_search: experiment.config.webSearch ? 'on' : 'off',
      cache: 'off',
    });
  }
}

async function executeUnifiedReason(experiment, row, credentials) {
  const task = experiment.recommendationTasks.find(item => item.task_key === row.task_key);
  if (!task) return;
  const brands = [1, 2, 3, 4, 5].map(rank => row[`brand_${rank}`]).filter(Boolean);
  const reasonPrompt = buildReasonPrompt(row.prompt, brands);
  try {
    const reasonResponseText = experiment.config.dryRun
      ? dryRunReasonResponse(brands)
      : await sendPrompt(
        task.provider,
        task.model_name,
        reasonPrompt,
        experiment.config.temperature,
        experiment.config.reasonMaxOutputTokens,
        experiment.config.webSearch,
        apiKeyForTask(credentials, task)
      );
    if (!String(reasonResponseText || '').trim()) throw new Error('Model returned an empty reason response.');
    Object.assign(row, reasonFieldsFromResponse(row.prompt, brands, reasonResponseText));
  } catch (err) {
    Object.assign(row, {
      ...blankReasonFields(isQuotaError(err.message) ? 'quota_or_rate_limit' : 'error', err.message),
      reason_prompt: reasonPrompt,
    });
    experiment.errors.push({
      task_key: row.task_key,
      stage: 'reasons',
      provider: row.provider,
      model_id: row.model_id,
      prompt_id: row.prompt_id,
      message: err.message,
      quotaLimited: isQuotaError(err.message),
      timestamp: new Date().toISOString(),
    });
  }
  updateUnifiedProgress(experiment);
}

function updateExperimentCompleteness(experiment) {
  const successfulRecommendations = experiment.results.filter(row => row.status === 'completed').length;
  const completedReasons = experiment.results.filter(row => row.reason_status === 'completed').length;
  const expectedReasons = experiment.config.followupReasons ? experiment.counts.reasonCalls : 0;
  experiment.completeness = {
    complete: (
      successfulRecommendations === experiment.counts.recommendationCalls &&
      completedReasons === expectedReasons
    ),
    successfulRecommendations,
    expectedRecommendations: experiment.counts.recommendationCalls,
    completedReasons,
    expectedReasons,
  };
}

function maybePersistExperiment(experiment) {
  const now = Date.now();
  if (now - Number(experiment.lastPersistedAt || 0) < 5000) return;
  experiment.lastPersistedAt = now;
  persistExperiment(experiment);
}

async function executeUnifiedExperiment(experiment) {
  const credentials = experimentCredentials.get(experiment.runId) || {};
  const completedKeys = new Set(
    experiment.results.filter(row => row.status === 'completed').map(row => row.task_key)
  );

  for (const stage of ['context-free', 'needs-based']) {
    experiment.stage = stage;
    experiment.message = stage === 'context-free'
      ? 'Running independent category-only recommendations.'
      : 'Running general and detailed needs-based recommendations.';
    persistExperiment(experiment);
    const tasks = experiment.recommendationTasks.filter(task => task.stage === stage);
    for (const task of tasks) {
      if (experiment.cancelRequested) break;
      if (completedKeys.has(task.task_key)) continue;
      await executeUnifiedRecommendation(experiment, task, credentials);
      const row = experiment.results.find(item => item.task_key === task.task_key);
      if (row?.status === 'completed') completedKeys.add(task.task_key);
      maybePersistExperiment(experiment);
    }
    if (experiment.cancelRequested) break;
  }

  if (!experiment.cancelRequested && experiment.config.followupReasons) {
    experiment.stage = 'reasons';
    experiment.message = 'Collecting separate, stateless reasons for each successful recommendation.';
    persistExperiment(experiment);
    for (const row of experiment.results) {
      if (experiment.cancelRequested) break;
      if (row.status !== 'completed' || row.reason_status === 'completed') continue;
      await executeUnifiedReason(experiment, row, credentials);
      maybePersistExperiment(experiment);
    }
  }

  experiment.stage = experiment.cancelRequested ? 'cancelled' : 'results';
  experiment.metrics = calculateExperimentMetrics(
    experiment.results,
    categoriesBrands,
    experiment.recommendationTasks
  );
  updateExperimentCompleteness(experiment);
  experiment.finishedAt = new Date().toISOString();
  if (experiment.cancelRequested) {
    experiment.status = 'cancelled';
    experiment.message = 'The run was cancelled. Available metrics are provisional.';
  } else if (experiment.completeness.complete) {
    experiment.status = 'completed';
    experiment.message = 'All expected observations and reason follow-ups completed.';
  } else {
    experiment.status = 'incomplete';
    experiment.message = 'The run finished with missing observations. Metrics are provisional.';
  }
  experimentCredentials.delete(experiment.runId);
  updateUnifiedProgress(experiment);
  persistExperiment(experiment);
}

function failUnifiedExperiment(experiment, err) {
  experiment.status = 'failed';
  experiment.stage = 'failed';
  experiment.message = err.message;
  experiment.finishedAt = new Date().toISOString();
  experiment.errors.push({
    stage: 'orchestration',
    message: err.message,
    timestamp: experiment.finishedAt,
  });
  experimentCredentials.delete(experiment.runId);
  updateExperimentCompleteness(experiment);
  persistExperiment(experiment);
}

// ═══════════════════════════════════════════════════════════════════
// EXPERIMENT EXECUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Runs all replicates sequentially.  Each replicate is an independent
 * API call with no shared conversation history.
 */
async function executeRun(run) {
  const {
    provider,
    modelName,
    finalPrompt,
    replicates,
    temperature,
    maxOutputTokens,
    webSearch,
    followupReasons,
    reasonMaxOutputTokens,
    bypassCache,
    dryRun,
  } = run.config;
  const focalBrands = categoryIndex[run.config.category][run.config.subCategory];
  const cachedRows = (bypassCache || followupReasons ? [] : getCachedRows(run.config)).slice(0, replicates);

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
      responseText = dryRun
        ? dryRunBrandResponse(run.config.subCategory)
        : await sendPrompt(provider, modelName, finalPrompt, temperature, maxOutputTokens, webSearch === 'on');
      if (!responseText || responseText.trim() === '') {
        throw new Error('Model returned an empty response');
      }

      // ── Extract and standardise brands ───────────────────────────
      const rawBrands = extractBrands(responseText);
      const stdBrands = standardiseBrands(rawBrands, aliasMap, run.config.subCategory);
      if (stdBrands.length === 0) {
        throw new Error('No brands could be extracted from the model response');
      }
      let reasonFields = blankReasonFields();
      if (followupReasons) {
        const reasonPrompt = buildReasonPrompt(finalPrompt, stdBrands);
        try {
          const reasonResponseText = dryRun
            ? dryRunReasonResponse(stdBrands)
            : await sendPrompt(provider, modelName, reasonPrompt, temperature, reasonMaxOutputTokens, webSearch === 'on');
          if (!reasonResponseText || reasonResponseText.trim() === '') {
            throw new Error('Model returned an empty reason response');
          }
          reasonFields = reasonFieldsFromResponse(finalPrompt, stdBrands, reasonResponseText);
        } catch (reasonErr) {
          reasonFields = {
            ...blankReasonFields('error', reasonErr.message),
            reason_prompt: reasonPrompt,
          };
          if (isQuotaError(reasonErr.message)) {
            reasonFields.reason_status = 'quota_or_rate_limit';
            run.quotaLimited = true;
          }
        }
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
        ...reasonFields,
        timestamp: new Date().toISOString(),
        temperature,
        max_output_tokens: maxOutputTokens,
        notes: dryRun
          ? [run.config.notes, 'dry_run_no_api_call'].filter(Boolean).join('; ')
          : run.config.notes,
      };

      run.results.push(row);
      if (!bypassCache && !followupReasons) addCachedRow(run.config, row);
      run.progress.completed = i;
      if (row.reason_status === 'quota_or_rate_limit') {
        run.progress.errors++;
        break;
      }
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
        ...blankReasonFields(),
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
