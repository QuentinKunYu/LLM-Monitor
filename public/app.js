/**
 * ═══════════════════════════════════════════════════════════════════
 * LLM Brand Recommendation Experiment — Frontend Controller
 * ═══════════════════════════════════════════════════════════════════
 *
 * Handles:
 *  • Loading configuration (models, categories, focal brands)
 *  • Wiring UI controls (selectors, sliders, prompt editor)
 *  • Running the experiment via the backend API
 *  • Polling for progress and displaying results
 *  • Exporting raw results CSV, metrics CSV, and config JSON
 */

const API = '';  // same origin

// ── State ─────────────────────────────────────────────────────────
let config = null;          // loaded from /api/config
let currentRunId = null;    // active run UUID
let currentBatchId = null;  // active batch UUID
let currentBatchRunIds = []; // run UUIDs inside active batch
let pollInterval = null;    // setInterval handle
let lastResults = null;     // cached full results for export
let rqInteractionRows = [];

// ── DOM References ────────────────────────────────────────────────
const $modelSelect     = document.getElementById('model-select');
const $conditionSelect = document.getElementById('condition-select');
const $personaGroup    = document.getElementById('persona-field-group');
const $personaSelect   = document.getElementById('persona-select');
const $categorySelect  = document.getElementById('category-select');
const $subcatDisplay   = document.getElementById('subcategory-display');
const $promptTemplate  = document.getElementById('prompt-template');
const $promptPreview   = document.getElementById('prompt-preview');
const $replicatesSlider = document.getElementById('replicates-slider');
const $replicatesInput = document.getElementById('replicates-input');
const $tempSlider      = document.getElementById('temperature-slider');
const $tempInput       = document.getElementById('temperature-input');
const $maxTokensInput  = document.getElementById('max-tokens-input');
const $websearchToggle = document.getElementById('websearch-toggle');
const $runBtn          = document.getElementById('run-btn');
const $runAllBtn       = document.getElementById('run-all-btn');
const $pauseBtn        = document.getElementById('pause-btn');
const $resetBtn        = document.getElementById('reset-btn');
const $runSummary      = document.getElementById('run-summary');
const $progressCard    = document.getElementById('progress-card');
const $progressFill    = document.getElementById('progress-fill');
const $progressCount   = document.getElementById('progress-count');
const $progressErrors  = document.getElementById('progress-errors');
const $progressStatus  = document.getElementById('progress-status');
const $batchCard       = document.getElementById('batch-progress-card');
const $batchFill       = document.getElementById('batch-progress-fill');
const $batchCount      = document.getElementById('batch-progress-count');
const $batchErrors     = document.getElementById('batch-progress-errors');
const $batchCatList    = document.getElementById('batch-category-list');
const $batchStatus     = document.getElementById('batch-status');
const $resultsCard     = document.getElementById('results-card');
const $resultsTbody    = document.getElementById('results-tbody');
const $metricsCard     = document.getElementById('metrics-card');
const $metricsTbody    = document.getElementById('metrics-tbody');
const $exportRawBtn    = document.getElementById('export-raw-btn');
const $exportMetricsBtn = document.getElementById('export-metrics-btn');
const $exportConfigBtn = document.getElementById('export-config-btn');
const $conditionBadge  = document.getElementById('condition-badge');
const $headerSubtitle  = document.getElementById('header-subtitle');
const $navExperiment    = document.getElementById('nav-experiment');
const $navRq            = document.getElementById('nav-rq');
const $experimentViews  = document.querySelectorAll('.experiment-view');
const $rqArea           = document.getElementById('rq-area');
const $runRq1Btn       = document.getElementById('run-rq1-btn');
const $rq1CsvInput      = document.getElementById('rq1-csv-input');
const $rq1CsvFilename   = document.getElementById('rq1-csv-filename');
const $rq1CsvStatus     = document.getElementById('rq1-csv-status');
const $rq1BaselineInput = document.getElementById('rq1-baseline-input');
const $rq1BaselineFilename = document.getElementById('rq1-baseline-filename');
const $rq1BaselineStatus = document.getElementById('rq1-baseline-status');
const $rq1Status       = document.getElementById('rq1-status');
const $rq1Results      = document.getElementById('rq1-results');
const $rq1KeyStats     = document.getElementById('rq1-key-stats');
const $rq1OverviewTable = document.getElementById('rq1-overview-table');
const $rqTabs          = document.querySelectorAll('.rq-tab');
const $rqPanels        = document.querySelectorAll('.rq-panel');
const $rq1VisibilityChart = document.getElementById('rq1-visibility-chart');
const $rq1ModelVisibilityChart = document.getElementById('rq1-model-visibility-chart');
const $rq1ModelBiasChart = document.getElementById('rq1-model-bias-chart');
const $rq1RegressionTable = document.getElementById('rq1-regression-table');
const $rq1CategoryTable = document.getElementById('rq1-category-table');
const $rq1CategoryBiasTable = document.getElementById('rq1-category-bias-table');
const $rq1NicheOpportunitiesTable = document.getElementById('rq1-niche-opportunities-table');
const $rqReferenceSelect = document.getElementById('rq-reference-select');
const $rq1InteractionTable = document.getElementById('rq1-interaction-table');
const $rq1BaselineBiasTable = document.getElementById('rq1-baseline-bias-table');
const $rq1AspirationBiasTable = document.getElementById('rq1-aspiration-bias-table');
const $rq1OrrTable = document.getElementById('rq1-orr-table');
const $rq1SegmentBiasTable = document.getElementById('rq1-segment-bias-table');
const $rq1CategoryModelRegressionTable = document.getElementById('rq1-category-model-regression-table');
const $rq1BaselinePills = document.querySelectorAll('.rq1-baseline-pill');

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    const res = await fetch(`${API}/api/config`);
    config = await res.json();
    populateConditions();
    populatePersonas();
    populateModels();
    populateCategories();
    setDefaults();
    wireEvents();
    applyInitialView();
    updatePreview();
    updateSummary();
    hydrateRq1Status();
  } catch (err) {
    showToast(`Failed to load configuration: ${err.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
// POPULATE CONTROLS
// ═══════════════════════════════════════════════════════════════════

function populateModels() {
  $modelSelect.innerHTML = '';
  if ($rqReferenceSelect) $rqReferenceSelect.innerHTML = '';
  for (const m of config.models) {
    const opt = document.createElement('option');
    opt.value = m.model_id;
    opt.textContent = m.display_name;
    $modelSelect.appendChild(opt);

    if ($rqReferenceSelect) {
      const refOpt = document.createElement('option');
      refOpt.value = m.model_id;
      refOpt.textContent = m.display_name;
      $rqReferenceSelect.appendChild(refOpt);
    }
  }
}

function populateConditions() {
  $conditionSelect.innerHTML = '';
  const conditions = config.promptConditions || [{
    id: 'context-free',
    display_name: 'Context-Free',
    experiment: 'study1',
    prompt_template: config.defaultPrompt,
  }];

  for (const condition of conditions) {
    const opt = document.createElement('option');
    opt.value = condition.id;
    opt.textContent = `${condition.display_name} (${condition.experiment.toUpperCase()})`;
    $conditionSelect.appendChild(opt);
  }
}

function populatePersonas() {
  $personaSelect.innerHTML = '';
  for (const persona of (config.syntheticPersonas || [])) {
    const opt = document.createElement('option');
    opt.value = persona.persona_id;
    opt.textContent = `${persona.persona_id} (${persona.persona_type})`;
    $personaSelect.appendChild(opt);
  }
}

function populateCategories() {
  $categorySelect.innerHTML = '';
  for (const cat of config.categories) {
    for (const sub of cat.sub_categories) {
      const opt = document.createElement('option');
      opt.value = `${cat.category}||${sub.sub_category}`;
      opt.textContent = `${sub.sub_category} (${cat.category})`;
      $categorySelect.appendChild(opt);
    }
  }
  updateSubcategory();
}

function setDefaults() {
  applySelectedCondition();
  updatePersonaVisibility();
  $replicatesInput.value = config.defaults.replicates;
  $replicatesSlider.value = config.defaults.replicates;
  $tempInput.value = config.defaults.temperature.toFixed(2);
  $tempSlider.value = Math.round(config.defaults.temperature * 100);
  $maxTokensInput.value = config.defaults.maxOutputTokens;
  $websearchToggle.checked = false;
  $websearchToggle.disabled = false;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════════

function wireEvents() {
  $conditionSelect.addEventListener('change', () => {
    applySelectedCondition();
    updatePersonaVisibility();
    updatePreview();
    updateSummary();
  });

  $personaSelect.addEventListener('change', () => {
    updatePreview();
    updateSummary();
  });

  // Category change
  $categorySelect.addEventListener('change', () => {
    updateSubcategory();
    updatePreview();
    updateSummary();
  });

  // Model change
  $modelSelect.addEventListener('change', updateSummary);

  // Prompt template change
  $promptTemplate.addEventListener('input', () => {
    updatePreview();
    updateSummary();
  });

  // Replicates slider ↔ input sync
  $replicatesSlider.addEventListener('input', () => {
    $replicatesInput.value = $replicatesSlider.value;
    updateSummary();
  });
  $replicatesInput.addEventListener('change', () => {
    $replicatesSlider.value = $replicatesInput.value;
    updateSummary();
  });

  // Temperature slider ↔ input sync
  $tempSlider.addEventListener('input', () => {
    $tempInput.value = ($tempSlider.value / 100).toFixed(2);
    updateSummary();
  });
  $tempInput.addEventListener('change', () => {
    $tempSlider.value = Math.round(parseFloat($tempInput.value) * 100);
    updateSummary();
  });

  $maxTokensInput.addEventListener('change', updateSummary);
  $websearchToggle.addEventListener('change', updateSummary);

  // Buttons
  $runBtn.addEventListener('click', startExperiment);
  $runAllBtn.addEventListener('click', startBatchExperiment);
  $pauseBtn.addEventListener('click', pauseActiveRun);
  $resetBtn.addEventListener('click', resetDefaults);
  $exportRawBtn.addEventListener('click', exportRawCSV);
  $exportMetricsBtn.addEventListener('click', exportMetricsCSV);
  $exportConfigBtn.addEventListener('click', exportConfigJSON);
  $runRq1Btn.addEventListener('click', runRq1Analysis);
  $rq1CsvInput.addEventListener('change', updateRq1CsvStatus);
  $rq1BaselineInput.addEventListener('change', updateRq1BaselineStatus);
  $rqTabs.forEach(tab => {
    tab.addEventListener('click', () => switchRqTab(tab.dataset.rqTab));
  });
  if ($rqReferenceSelect) {
    $rqReferenceSelect.addEventListener('change', () => renderInteractionTable(rqInteractionRows));
  }
  document.addEventListener('click', handleMiniTableSort);
  $navExperiment.addEventListener('click', () => switchView('experiment'));
  $navRq.addEventListener('click', () => switchView('rq'));
}

// ═══════════════════════════════════════════════════════════════════
// UI UPDATE HELPERS
// ═══════════════════════════════════════════════════════════════════

function getSelectedCategory() {
  const val = $categorySelect.value;
  const [category, subCategory] = val.split('||');
  return { category, subCategory };
}

function switchRqTab(tabName = 'overview') {
  $rqTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.rqTab === tabName);
  });
  $rqPanels.forEach(panel => {
    panel.classList.toggle('active', panel.dataset.rqPanel === tabName);
  });
}

function getPromptConditions() {
  return config.promptConditions || [{
    id: 'context-free',
    display_name: 'Context-Free',
    experiment: 'study1',
    prompt_template: config.defaultPrompt,
  }];
}

function getSelectedCondition() {
  return getPromptConditions().find(condition => condition.id === $conditionSelect.value) || getPromptConditions()[0];
}

function getSelectedPersona() {
  return (config.syntheticPersonas || []).find(persona => persona.persona_id === $personaSelect.value) || null;
}

function selectedConditionNeedsProfile() {
  return Boolean(getSelectedCondition()?.prompt_template?.includes('[profile]'));
}

function profileText(persona) {
  if (!persona) return '';
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

function updatePersonaVisibility() {
  const show = selectedConditionNeedsProfile();
  $personaGroup.classList.toggle('hidden', !show);
  $runAllBtn.disabled = show;
  $runAllBtn.title = show ? 'Study 2b UI runs one category and one persona at a time.' : '';
}

function applySelectedCondition() {
  const condition = getSelectedCondition();
  if (!condition) return;
  $promptTemplate.value = condition.prompt_template;
  if (!isRqViewActive()) {
    if ($conditionBadge) $conditionBadge.textContent = condition.display_name;
    if ($headerSubtitle) $headerSubtitle.textContent = `${condition.experiment.toUpperCase()} Brand Recommendation Audit`;
  }
}

function updateSubcategory() {
  const { subCategory } = getSelectedCategory();
  $subcatDisplay.value = subCategory || '';
}

function updatePreview() {
  const { subCategory } = getSelectedCategory();
  const template = $promptTemplate.value;
  const persona = getSelectedPersona();
  $promptPreview.textContent = template
    .replace(/\[category\]/gi, subCategory || '[category]')
    .replace(/\[profile\]/gi, persona ? profileText(persona) : '[select a synthetic persona]');
}

function updateSummary() {
  const { category, subCategory } = getSelectedCategory();
  const model = config.models.find(m => m.model_id === $modelSelect.value);
  const condition = getSelectedCondition();
  const persona = getSelectedPersona();
  const reps = parseInt($replicatesInput.value, 10);

  $runSummary.innerHTML = `
    <div class="summary-item">
      <div class="summary-item-label">Model</div>
      <div class="summary-item-value">${model?.display_name || '—'}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Category</div>
      <div class="summary-item-value">${subCategory}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Replicates</div>
      <div class="summary-item-value accent">${reps}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">API Calls</div>
      <div class="summary-item-value accent">${reps}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Prompt Condition</div>
      <div class="summary-item-value">${condition?.display_name || '—'}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Study</div>
      <div class="summary-item-value">${condition?.experiment?.toUpperCase() || '—'}</div>
    </div>
    ${selectedConditionNeedsProfile() ? `
      <div class="summary-item">
        <div class="summary-item-label">Persona</div>
        <div class="summary-item-value">${persona?.persona_id || '—'}</div>
      </div>
    ` : ''}
    <div class="summary-item">
      <div class="summary-item-label">Session Rule</div>
      <div class="summary-item-value">Fresh / No History</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Web Search / Tools</div>
      <div class="summary-item-value">${$websearchToggle.checked ? 'On' : 'Off'}</div>
    </div>
    <div class="summary-item">
      <div class="summary-item-label">Metrics</div>
      <div class="summary-item-value">BRP@K, MRR</div>
    </div>
  `;
}



function resetDefaults() {
  setDefaults();
  updatePersonaVisibility();
  updatePreview();
  updateSummary();
}

function isRqViewActive() {
  return !$rqArea.classList.contains('hidden');
}

function applyInitialView() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get('view');
  const legacyRqFlag = (params.get('v') || '').includes('rq');
  switchView(requestedView === 'rq' || legacyRqFlag ? 'rq' : 'experiment', { replaceUrl: false });
}

function switchView(view, options = {}) {
  const isRq = view === 'rq';
  $experimentViews.forEach(el => el.classList.toggle('hidden', isRq));
  $rqArea.classList.toggle('hidden', !isRq);
  $navExperiment.classList.toggle('active', !isRq);
  $navRq.classList.toggle('active', isRq);

  if ($headerSubtitle) {
    $headerSubtitle.textContent = isRq
      ? 'Analysis'
      : `${getSelectedCondition()?.experiment?.toUpperCase() || 'STUDY1'} Brand Recommendation Audit`;
  }
  if ($conditionBadge) $conditionBadge.textContent = isRq ? 'Analysis' : (getSelectedCondition()?.display_name || 'Context-Free');

  if (options.replaceUrl !== false) {
    const url = new URL(window.location.href);
    url.searchParams.set('view', isRq ? 'rq' : 'experiment');
    window.history.replaceState({}, '', url);
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPERIMENT EXECUTION
// ═══════════════════════════════════════════════════════════════════

async function startExperiment() {
  const { category, subCategory } = getSelectedCategory();
  const modelId = $modelSelect.value;
  const replicates = parseInt($replicatesInput.value, 10);
  const temperature = parseFloat($tempInput.value);
  const maxOutputTokens = parseInt($maxTokensInput.value, 10);
  const webSearch = $websearchToggle.checked;
  const promptTemplate = $promptTemplate.value;
  const promptCondition = $conditionSelect.value || 'context-free';
  const persona = getSelectedPersona();
  const needsProfile = selectedConditionNeedsProfile();

  if (!modelId || !category || !subCategory) {
    showToast('Please select a model and category.', 'error');
    return;
  }
  if (needsProfile && !persona) {
    showToast('Please select a synthetic persona.', 'error');
    return;
  }

  const profile = needsProfile ? profileText(persona) : '';
  const finalPromptTemplate = needsProfile
    ? promptTemplate.replace(/\[profile\]/gi, profile)
    : promptTemplate;

  // Disable run button while experiment is in progress
  $runBtn.disabled = true;
  $runAllBtn.disabled = true;
  showPauseButton();
  $runBtn.innerHTML = `
    <svg class="pulse" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
      <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
    </svg>
    Running…
  `;

  // Show progress, hide old results
  $progressCard.classList.remove('hidden');
  $resultsCard.classList.add('hidden');
  $metricsCard.classList.add('hidden');
  $progressFill.style.width = '0%';
  $progressCount.textContent = `0 / ${replicates}`;
  $progressErrors.textContent = '';
  $progressStatus.textContent = 'Starting experiment…';
  $progressStatus.className = 'progress-status';

  try {
    const res = await fetch(`${API}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        category,
        subCategory,
        promptTemplate: finalPromptTemplate,
        replicates,
        temperature,
        maxOutputTokens,
        webSearch,
        promptCondition,
        personaId: needsProfile ? persona.persona_id : '',
        personaType: needsProfile ? persona.persona_type : '',
        profileText: profile,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start run');
    }

    const { runId } = await res.json();
    currentRunId = runId;
    currentBatchId = null;
    currentBatchRunIds = [];
    startPolling(runId, replicates);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    resetRunButton();
  }
}

// ═══════════════════════════════════════════════════════════════════
// BATCH EXPERIMENT (RUN ALL CATEGORIES)
// ═══════════════════════════════════════════════════════════════════

async function startBatchExperiment() {
  const modelId = $modelSelect.value;
  const replicates = parseInt($replicatesInput.value, 10);
  const temperature = parseFloat($tempInput.value);
  const maxOutputTokens = parseInt($maxTokensInput.value, 10);
  const webSearch = $websearchToggle.checked;
  const promptTemplate = $promptTemplate.value;
  const promptCondition = $conditionSelect.value || 'context-free';
  if (selectedConditionNeedsProfile()) {
    showToast('Study 2b UI runs one category and one persona at a time.', 'error');
    return;
  }

  if (!modelId) {
    showToast('Please select a model.', 'error');
    return;
  }

  // Disable both run buttons
  $runBtn.disabled = true;
  $runAllBtn.disabled = true;
  showPauseButton();
  $runAllBtn.innerHTML = `
    <svg class="pulse" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
      <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
    </svg>
    Running All…
  `;

  // Show batch progress, hide single-run cards
  $batchCard.classList.remove('hidden');
  $progressCard.classList.add('hidden');
  $resultsCard.classList.add('hidden');
  $metricsCard.classList.add('hidden');
  $batchFill.style.width = '0%';
  $batchCount.textContent = 'Starting…';
  $batchErrors.textContent = '';
  $batchCatList.innerHTML = '';
  $batchStatus.textContent = 'Queueing all categories…';
  $batchStatus.className = 'progress-status';

  try {
    const res = await fetch(`${API}/api/run-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, promptTemplate, replicates, temperature, maxOutputTokens, webSearch, promptCondition }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start batch');
    }

    const { batchId, runIds, totalCategories } = await res.json();
    currentRunId = null;
    currentBatchId = batchId;
    currentBatchRunIds = runIds.map(r => r.runId);

    // Show category tiles
    $batchCatList.innerHTML = runIds.map(r => `
      <div class="batch-cat-item" id="batch-cat-${r.runId}">
        <span class="batch-cat-name">${r.subCategory}</span>
        <span class="batch-cat-status">queued</span>
      </div>
    `).join('');
    $batchCount.textContent = `0 / ${totalCategories} categories`;

    startBatchPolling(batchId, runIds, totalCategories);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    resetBatchButtons();
  }
}

function startBatchPolling(batchId, runIds, totalCategories) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/batch/${batchId}/status`);
      const data = await res.json();

      // Update overall progress
      const pct = totalCategories > 0 ? (data.completedCategories / totalCategories) * 100 : 0;
      $batchFill.style.width = `${pct}%`;
      $batchCount.textContent = `${data.completedCategories} / ${totalCategories} categories`;

      // Update each category tile
      let totalErrors = 0;
      for (const r of data.runs) {
        const tile = document.getElementById(`batch-cat-${r.runId}`);
        if (!tile) continue;
        tile.className = `batch-cat-item ${r.status}`;
        const statusEl = tile.querySelector('.batch-cat-status');
        if (r.status === 'completed') {
          statusEl.textContent = `✓ ${r.progress.completed}/${r.progress.total}`;
        } else if (r.status === 'running') {
          statusEl.textContent = `${r.progress.completed}/${r.progress.total}`;
        } else {
          statusEl.textContent = r.status;
        }
        totalErrors += (r.progress?.errors || 0);
      }
      $batchErrors.textContent = totalErrors > 0 ? `${totalErrors} errors` : '';

      // Find currently running category
      const running = data.runs.find(r => r.status === 'running');
      if (running) {
        $batchStatus.textContent = `Running: ${running.subCategory} (${running.progress.completed}/${running.progress.total})…`;
      }

      if (data.status === 'completed' || data.status === 'cancelled') {
        clearInterval(pollInterval);
        pollInterval = null;

        const cancelled = data.status === 'cancelled';
        $batchStatus.textContent = cancelled
          ? `Paused after ${data.completedCategories} / ${totalCategories} categories`
          : `✓ All ${totalCategories} categories completed`;
        $batchStatus.className = `progress-status ${cancelled ? 'cancelled' : 'completed'}`;

        // Collect all results and metrics across all runs
        await loadBatchResults(runIds.map(r => r.runId));

        resetBatchButtons();
        hidePauseButton();
        showToast(
          cancelled ? 'Batch paused. Partial results are available.' : `Batch completed — ${totalCategories} categories processed!`,
          cancelled ? 'error' : 'success'
        );
      }
    } catch (err) {
      console.error('Batch polling error:', err);
    }
  }, 2000);
}

async function loadBatchResults(runIds) {
  const allResults = [];
  const allMetrics = [];
  let batchConfig = null;

  for (const runId of runIds) {
    try {
      const res = await fetch(`${API}/api/run/${runId}/results`);
      const data = await res.json();
      allResults.push(...(data.results || []));
      allMetrics.push(...(data.metrics || []));
      if (!batchConfig) batchConfig = data.config;
    } catch (e) {
      console.error(`Failed to load results for ${runId}:`, e);
    }
  }

  // Store combined results for export
  lastResults = {
    config: { ...batchConfig, subCategory: 'all_categories', category: 'batch' },
    results: allResults,
    metrics: allMetrics,
  };

  // Show combined tables
  renderResults(allResults);
  $resultsCard.classList.remove('hidden');
  renderMetrics(allMetrics);
  $metricsCard.classList.remove('hidden');
}

function resetBatchButtons() {
  $runBtn.disabled = false;
  $runAllBtn.disabled = false;
  updatePersonaVisibility();
  hidePauseButton();
  $runAllBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
    Run All Categories
  `;
}

// ═══════════════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════════════

function startPolling(runId, totalReplicates) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/run/${runId}/results`);
      const data = await res.json();

      // Update progress
      const { completed, total, errors } = data.progress;
      const pct = total > 0 ? (completed / total) * 100 : 0;
      $progressFill.style.width = `${pct}%`;
      $progressCount.textContent = `${completed} / ${total}`;
      $progressErrors.textContent = errors > 0 ? `${errors} error${errors > 1 ? 's' : ''}` : '';

      // Update results table in real-time
      renderResults(data.results);

      if (data.status === 'completed' || data.status === 'cancelled') {
        clearInterval(pollInterval);
        pollInterval = null;
        lastResults = data;

        const cancelled = data.status === 'cancelled';
        $progressStatus.textContent = cancelled
          ? `Paused after ${completed} / ${total} replicates, ${errors} errors`
          : `✓ Experiment completed — ${completed} replicates, ${errors} errors`;
        $progressStatus.className = `progress-status ${cancelled ? 'cancelled' : 'completed'}`;

        // Show metrics
        renderMetrics(data.metrics);
        $metricsCard.classList.remove('hidden');

        resetRunButton();
        hidePauseButton();
        showToast(
          cancelled ? 'Run paused. Partial results are available.' : 'Experiment completed successfully!',
          cancelled ? 'error' : 'success'
        );
      } else {
        $progressStatus.textContent = `Running replicate ${completed + 1} of ${total}…`;
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 1500);
}

// ═══════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════

function renderResults(results) {
  if (!results || results.length === 0) return;
  $resultsCard.classList.remove('hidden');

  $resultsTbody.innerHTML = results.map(r => `
    <tr>
      <td>${r.replicate}</td>
      <td>${r.model_id}</td>
      <td>${r.sub_category}</td>
      <td class="brand-cell">${r.brand_1 || '—'}</td>
      <td class="brand-cell">${r.brand_2 || '—'}</td>
      <td class="brand-cell">${r.brand_3 || '—'}</td>
      <td class="brand-cell">${r.brand_4 || '—'}</td>
      <td class="brand-cell">${r.brand_5 || '—'}</td>
    </tr>
  `).join('');
}

function renderMetrics(metrics) {
  if (!metrics || metrics.length === 0) return;

  $metricsTbody.innerHTML = metrics.map(m => {
    // Visibility group styling: high_visibility (green), niche (purple), other (default)
    let visCls = '';
    let visLabel = '';
    if (m.visibility_group === 'high_visibility') {
      visCls = 'visibility-high';
      visLabel = 'High Vis';
    } else if (m.visibility_group === 'niche') {
      visCls = 'visibility-niche';
      visLabel = 'Niche';
    } else {
      visCls = 'visibility-other';
      visLabel = 'Other';
    }
    return `
      <tr>
        <td class="brand-cell">${m.brand}</td>
        <td class="${visCls}">${visLabel}</td>
        <td>${m.total_mentions}</td>
        <td>${m.n_replicates}</td>
        <td class="${metricClass(m['BRP@1'])}">${m['BRP@1']}</td>
        <td class="${metricClass(m['BRP@3'])}">${m['BRP@3']}</td>
        <td class="${metricClass(m['BRP@5'])}">${m['BRP@5']}</td>
        <td class="${metricClass(m['MRR'])}">${m['MRR']}</td>
      </tr>
    `;
  }).join('');
}

function metricClass(val) {
  const v = parseFloat(val);
  if (isNaN(v)) return '';
  if (v >= 0.5) return 'metric-high';
  if (v >= 0.15) return 'metric-mid';
  return 'metric-low';
}

function resetRunButton() {
  $runBtn.disabled = false;
  $runAllBtn.disabled = false;
  updatePersonaVisibility();
  hidePauseButton();
  $runBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Run Experiment
  `;
}

async function pauseActiveRun() {
  if (!$pauseBtn.classList.contains('hidden')) {
    $pauseBtn.disabled = true;
    $pauseBtn.innerHTML = `
      <svg class="pulse" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
      Pausing…
    `;
  }

  try {
    if (currentBatchId) {
      await fetch(`${API}/api/batch/${currentBatchId}/cancel`, { method: 'POST' });
      $batchStatus.textContent = 'Pausing after the current API call finishes…';
      $batchStatus.className = 'progress-status cancelled';
      showToast('Pause requested for batch.', 'success');
      return;
    }

    if (currentRunId) {
      await fetch(`${API}/api/run/${currentRunId}/cancel`, { method: 'POST' });
      $progressStatus.textContent = 'Pausing after the current API call finishes…';
      $progressStatus.className = 'progress-status cancelled';
      showToast('Pause requested for run.', 'success');
    }
  } catch (err) {
    showToast(`Failed to pause: ${err.message}`, 'error');
    $pauseBtn.disabled = false;
  }
}

function showPauseButton() {
  $pauseBtn.classList.remove('hidden');
  $pauseBtn.disabled = false;
  $pauseBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
    Pause Run
  `;
}

function hidePauseButton() {
  $pauseBtn.classList.add('hidden');
  $pauseBtn.disabled = false;
}

async function runRq1Analysis() {
  $runRq1Btn.disabled = true;
  $rq1Status.textContent = 'Starting analysis models...';
  $rq1Status.className = 'progress-status';
  $rq1Results.classList.add('hidden');

  try {
    const payload = await buildRq1Payload();
    const res = await fetch(`${API}/api/analysis/rq1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start analysis');
    pollRq1Analysis();
  } catch (err) {
    $runRq1Btn.disabled = false;
    $rq1Status.textContent = `Error: ${err.message}`;
    $rq1Status.className = 'progress-status cancelled';
    showToast(`Analysis failed: ${err.message}`, 'error');
  }
}

function updateRq1CsvStatus() {
  const file = $rq1CsvInput.files?.[0];
  if (!file) {
    $rq1CsvFilename.textContent = 'No file selected';
    $rq1CsvStatus.textContent = 'No upload selected.';
    return;
  }
  const sizeMb = file.size / (1024 * 1024);
  $rq1CsvFilename.textContent = file.name;
  $rq1CsvStatus.textContent = `Selected: ${file.name} (${sizeMb.toFixed(2)} MB).`;
}

function updateRq1BaselineStatus() {
  const file = $rq1BaselineInput.files?.[0];
  if (!file) {
    $rq1BaselineFilename.textContent = 'Using TEST DATA';
    $rq1BaselineStatus.textContent = 'Baseline source: TEST DATA.';
    $rq1BaselineStatus.classList.add('test-data-note');
    return;
  }
  const sizeMb = file.size / (1024 * 1024);
  $rq1BaselineFilename.textContent = file.name;
  $rq1BaselineStatus.textContent = `Selected real baseline: ${file.name} (${sizeMb.toFixed(2)} MB).`;
  $rq1BaselineStatus.classList.remove('test-data-note');
}

async function buildRq1Payload() {
  const file = $rq1CsvInput.files?.[0];
  const baselineFile = $rq1BaselineInput.files?.[0];
  const payload = {};
  if (file && !file.name.toLowerCase().endsWith('.csv')) {
    throw new Error('Please upload a CSV file.');
  }
  if (baselineFile && !baselineFile.name.toLowerCase().endsWith('.csv')) {
    throw new Error('Please upload a baseline CSV file.');
  }
  if (file) {
    const csvText = await file.text();
    if (!csvText.trim()) {
      throw new Error('The selected CSV file is empty.');
    }
    payload.filename = file.name;
    payload.csvText = csvText;
  }
  if (baselineFile) {
    const baselineCsvText = await baselineFile.text();
    if (!baselineCsvText.trim()) {
      throw new Error('The selected baseline CSV file is empty.');
    }
    payload.baselineFilename = baselineFile.name;
    payload.baselineCsvText = baselineCsvText;
  }
  return payload;
}

async function hydrateRq1Status() {
  try {
    const res = await fetch(`${API}/api/analysis/rq1/status`);
    const data = await res.json();
    if (data.status === 'completed') {
      $rq1Status.textContent = 'Analysis completed.';
      $rq1Status.className = 'progress-status completed';
      renderRq1Results(data);
    } else if (data.status === 'running') {
      pollRq1Analysis();
    }
  } catch (err) {
    console.error('Failed to load analysis status:', err);
  }
}

async function pollRq1Analysis() {
  try {
    const res = await fetch(`${API}/api/analysis/rq1/status`);
    const data = await res.json();

    if (data.status === 'running') {
      $rq1Status.textContent = `Running analysis models since ${data.startedAt}...`;
      setTimeout(pollRq1Analysis, 1200);
      return;
    }

    $runRq1Btn.disabled = false;
    if (data.status === 'completed') {
      $rq1Status.textContent = 'Analysis completed.';
      $rq1Status.className = 'progress-status completed';
      renderRq1Results(data);
      showToast('Analysis completed.', 'success');
      return;
    }

    if (data.status === 'failed') {
      $rq1Status.textContent = 'Analysis failed.';
      $rq1Status.className = 'progress-status cancelled';
      showToast('Analysis failed.', 'error');
      return;
    }

    $rq1Status.textContent = 'Analysis is idle.';
  } catch (err) {
    $runRq1Btn.disabled = false;
    $rq1Status.textContent = `Error: ${err.message}`;
    $rq1Status.className = 'progress-status cancelled';
  }
}

function renderRq1Results(data) {
  const tables = data.tables || {};
  const visibilityRates = tables.visibilityRates || [];
  const modelRows = tables.visibilityModel || [];
  const interactionRows = tables.visibilityModelInteraction || [];
  const interactionAllRefRows = tables.visibilityModelInteractionAllRefs || [];
  const categoryRows = tables.categoryVisibilityRates || [];
  const categoryBiasRows = tables.categoryPopularityBias || [];
  const nicheOpportunityRows = tables.nicheBrandOpportunities || [];
  const modelBiasRows = tables.modelPopularityBias || [];
  const baselineBiasRows = tables.baselineDistributionBias || [];
  const baselineModelRows = tables.baselineModelBias || [];
  const orrRows = tables.brandBaselineOverrecommendation || [];
  const segmentBiasRows = tables.segmentShareBias || [];
  const categoryModelRegressionRows = tables.categoryModelBiasModels || [];
  const highVis = modelRows.find(row => row.term === 'visibility_grouphigh_visibility');
  const strongestCategory = categoryBiasRows[0];
  const strongestModel = modelBiasRows[0];
  const strongestBaseline = baselineBiasRows[0];
  const baselineMode = data.baselineMode || 'test_data';

  $rq1Results.classList.remove('hidden');
  updateBaselinePills(baselineMode);
  $rq1KeyStats.innerHTML = [
    statCard('High-Visibility OR', highVis ? formatNumber(highVis.odds_ratio, 2) : '—'),
    statCard('Log-Odds', highVis ? formatNumber(highVis.estimate, 3) : '—'),
    statCard('p-value', highVis ? formatP(highVis.p_value) : '—'),
    statCard('Rows', visibilityRates.reduce((sum, row) => sum + Number(row.n_observations || 0), 0).toLocaleString()),
    statCard('Strongest Category', strongestCategory ? strongestCategory.sub_category : '—'),
    statCard('Largest Model Gap', strongestModel ? strongestModel.model_id : '—'),
    statCard('Highest JSD', strongestBaseline ? formatNumber(strongestBaseline.js_divergence, 3) : '—'),
    statCard('Baseline Source', baselineMode === 'test_data' ? 'TEST DATA' : 'Uploaded'),
  ].join('');

  renderOverviewTable({
    highVis,
    strongestCategory,
    strongestModel,
    strongestBaseline,
    baselineMode,
  });
  renderBaselineBiasTable(baselineBiasRows);
  renderAspirationBiasTable(baselineBiasRows, baselineModelRows);
  renderOrrTable(orrRows);
  renderSegmentBiasTable(segmentBiasRows);
  renderCategoryModelRegressionTable(categoryModelRegressionRows);
  renderVisibilityChart(visibilityRates, $rq1VisibilityChart);
  renderVisibilityChart(visibilityRates, $rq1ModelVisibilityChart);
  renderModelBiasChart(modelBiasRows);
  renderRegressionTable(modelRows);
  renderCategoryVisibilityTable(categoryRows);
  renderCategoryBiasTable(categoryBiasRows);
  renderNicheOpportunitiesTable(nicheOpportunityRows);
  rqInteractionRows = interactionAllRefRows.length ? interactionAllRefRows : interactionRows;
  syncReferenceSelector(rqInteractionRows);
  renderInteractionTable(rqInteractionRows);
  switchRqTab('overview');
}

function statCard(label, value) {
  return `
    <div class="analysis-item">
      <div class="summary-item-label">${label}</div>
      <div class="summary-item-value">${value}</div>
    </div>
  `;
}

function updateBaselinePills(baselineMode) {
  $rq1BaselinePills.forEach(pill => {
    pill.textContent = baselineMode === 'test_data' ? 'TEST DATA' : 'UPLOADED';
    pill.classList.toggle('test-data-pill', baselineMode === 'test_data');
    pill.classList.toggle('uploaded-data-pill', baselineMode !== 'test_data');
  });
}

function renderOverviewTable(items) {
  const rows = [
    {
      result: 'Visibility popularity bias',
      value: items.highVis ? `OR ${formatNumber(items.highVis.odds_ratio, 2)}` : '—',
      note: items.highVis ? `p = ${formatP(items.highVis.p_value)}` : 'Needs analysis run',
    },
    {
      result: 'Strongest category gap',
      value: items.strongestCategory ? items.strongestCategory.sub_category : '—',
      note: items.strongestCategory ? formatPercent(Number(items.strongestCategory.bias_gap || 0)) : 'Needs analysis run',
    },
    {
      result: 'Largest model visibility gap',
      value: items.strongestModel ? modelLabel(items.strongestModel.model_id) : '—',
      note: items.strongestModel ? formatPercent(Number(items.strongestModel.bias_gap || 0)) : 'Needs analysis run',
    },
    {
      result: 'Largest baseline divergence',
      value: items.strongestBaseline ? `${items.strongestBaseline.sub_category} / ${modelLabel(items.strongestBaseline.model_id)}` : '—',
      note: items.strongestBaseline ? `JSD ${formatNumber(items.strongestBaseline.js_divergence, 3)}` : 'Needs baseline data',
    },
    {
      result: 'Baseline source',
      value: items.baselineMode === 'test_data' ? 'TEST DATA' : 'Uploaded CSV',
      note: items.baselineMode === 'test_data' ? 'Replace before final paper results' : 'Using uploaded baseline',
    },
  ];
  $rq1OverviewTable.innerHTML = miniTable(['result', 'value', 'note'], rows);
}

function renderVisibilityChart(rows, target = $rq1VisibilityChart) {
  if (!rows.length) {
    target.innerHTML = '<div class="bar-label">No chart data available.</div>';
    return;
  }
  const maxRate = Math.max(...rows.map(row => Number(row.recommendation_rate || 0)), 0.01);
  target.innerHTML = rows.map(row => {
    const rate = Number(row.recommendation_rate || 0);
    const width = Math.max(2, (rate / maxRate) * 100);
    return `
      <div class="bar-row">
        <div class="bar-label">${row.visibility_group}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <div class="bar-value">${formatPercent(rate)}</div>
      </div>
    `;
  }).join('');
}

function renderModelBiasChart(rows) {
  if (!rows.length) {
    $rq1ModelBiasChart.innerHTML = '<div class="bar-label">No model data available.</div>';
    return;
  }
  const maxGap = Math.max(...rows.map(row => Number(row.bias_gap || 0)), 0.01);
  $rq1ModelBiasChart.innerHTML = rows.map(row => {
    const gap = Number(row.bias_gap || 0);
    const width = Math.max(2, (gap / maxGap) * 100);
    return `
      <div class="bar-row bar-row-wide-label">
        <div class="bar-label">${modelLabel(row.model_id)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <div class="bar-value">${formatPercent(gap)}</div>
      </div>
    `;
  }).join('');
}

function modelLabel(modelId) {
  const model = (config?.models || []).find(m => m.model_id === modelId);
  if (!model) return modelId || 'Reference model';
  return model.display_name
    .replace(/^OpenAI\s+/, '')
    .replace(/^Anthropic\s+/, '')
    .replace(/^Google\s+/, '');
}

function regressionTermLabel(term) {
  if (term === '(Intercept)') return 'Intercept';
  if (term === 'visibility_grouphigh_visibility') return 'High-visibility brands';
  if (term.startsWith('model_id')) return modelLabel(term.replace(/^model_id/, ''));
  return term;
}

function interactionTermLabel(term) {
  if (term === 'visibility_grouphigh_visibility') return referenceModelLabel();
  const modelId = term
    .replace(/^model_id/, '')
    .replace(/:visibility_grouphigh_visibility$/, '')
    .replace(/^visibility_grouphigh_visibility:model_id/, '');
  return modelLabel(modelId);
}

function metricLabel(metric) {
  const labels = {
    js_divergence: 'JSD',
    hhi_amplification: 'HHI amp',
    top1_amplification: 'Top-1 amp',
    top3_amplification: 'Top-3 amp',
    entropy_amplification: 'Entropy amp',
    gini_amplification: 'Gini amp',
    aspiration_bias: 'Aspiration',
  };
  return labels[metric] || metric;
}

function categoryModelTermLabel(term) {
  if (term === '(Intercept)') return 'Intercept';
  if (term.startsWith('model_id')) return modelLabel(term.replace(/^model_id/, ''));
  if (term.startsWith('sub_category')) return term.replace(/^sub_category/, '');
  return term;
}

function referenceModelLabel() {
  const referenceModelId = $rqReferenceSelect?.value ||
    (config?.models || []).map(model => model.model_id).sort()[0] ||
    'claude-opus-4-7';
  return modelLabel(referenceModelId);
}

function renderRegressionTable(rows) {
  const wanted = rows.filter(row =>
    row.term === 'visibility_grouphigh_visibility' ||
    row.term === '(Intercept)' ||
    row.term.startsWith('model_id')
  );
  $rq1RegressionTable.innerHTML = miniTable(
    ['predictor', 'estimate', 'odds_ratio', 'p_value'],
    wanted.map(row => ({
      predictor: regressionTermLabel(row.term),
      estimate: formatNumber(row.estimate, 3),
      odds_ratio: formatNumber(row.odds_ratio, 2),
      p_value: formatP(row.p_value),
    }))
  );
}

function renderBaselineBiasTable(rows) {
  const compact = rows.slice(0, 18).map(row => ({
    sub_category: row.sub_category,
    model: modelLabel(row.model_id),
    jsd: formatNumber(row.js_divergence, 3),
    top1_amp: formatPercent(Number(row.top1_amplification || 0)),
    top3_amp: formatPercent(Number(row.top3_amplification || 0)),
    hhi_amp: formatNumber(row.hhi_amplification, 3),
    entropy_amp: formatNumber(row.entropy_amplification, 3),
    gini_amp: formatNumber(row.gini_amplification, 3),
    data: row.data_status || 'test_data',
  }));
  $rq1BaselineBiasTable.innerHTML = miniTable(
    ['sub_category', 'model', 'jsd', 'top1_amp', 'top3_amp', 'hhi_amp', 'entropy_amp', 'gini_amp', 'data'],
    compact
  );
}

function renderAspirationBiasTable(categoryRows, modelRows) {
  const modelCompact = modelRows.slice(0, 6).map(row => ({
    scope: 'model avg',
    item: modelLabel(row.model_id),
    aspiration_bias: formatNumber(row.aspiration_bias, 3),
    jsd: formatNumber(row.js_divergence, 3),
    data: row.data_status || 'test_data',
  }));
  const categoryCompact = categoryRows
    .slice()
    .sort((a, b) => Number(b.aspiration_bias || 0) - Number(a.aspiration_bias || 0))
    .slice(0, 12)
    .map(row => ({
      scope: 'category-model',
      item: `${row.sub_category} / ${modelLabel(row.model_id)}`,
      aspiration_bias: formatNumber(row.aspiration_bias, 3),
      jsd: formatNumber(row.js_divergence, 3),
      data: row.data_status || 'test_data',
    }));
  $rq1AspirationBiasTable.innerHTML = miniTable(
    ['scope', 'item', 'aspiration_bias', 'jsd', 'data'],
    [...modelCompact, ...categoryCompact]
  );
}

function renderOrrTable(rows) {
  const compact = rows
    .filter(row => Number.isFinite(Number(row.over_recommendation_ratio)))
    .slice()
    .sort((a, b) => Number(b.over_recommendation_ratio || 0) - Number(a.over_recommendation_ratio || 0))
    .slice(0, 20)
    .map(row => ({
      sub_category: row.sub_category,
      brand: row.brand,
      model: modelLabel(row.model_id),
      llm_q: formatPercent(Number(row.llm_q || 0)),
      baseline_p: formatPercent(Number(row.baseline_p || 0)),
      orr: formatNumber(row.over_recommendation_ratio, 2),
      aspiration: formatNumber(row.aspiration_score, 1),
      data: row.data_status || 'test_data',
    }));
  $rq1OrrTable.innerHTML = miniTable(
    ['sub_category', 'brand', 'model', 'llm_q', 'baseline_p', 'orr', 'aspiration', 'data'],
    compact
  );
}

function renderSegmentBiasTable(rows) {
  const compact = rows
    .slice()
    .sort((a, b) => Math.abs(Number(b.share_difference || 0)) - Math.abs(Number(a.share_difference || 0)))
    .slice(0, 24)
    .map(row => ({
      sub_category: row.sub_category,
      model: modelLabel(row.model_id),
      segment_group: row.segment_group,
      segment: row.segment,
      llm_q: formatPercent(Number(row.llm_q || 0)),
      baseline_p: formatPercent(Number(row.baseline_p || 0)),
      q_minus_p: formatPercent(Number(row.share_difference || 0)),
      data: row.data_status || 'test_data',
    }));
  $rq1SegmentBiasTable.innerHTML = miniTable(
    ['sub_category', 'model', 'segment_group', 'segment', 'llm_q', 'baseline_p', 'q_minus_p', 'data'],
    compact
  );
}

function renderCategoryModelRegressionTable(rows) {
  const compact = rows
    .filter(row => row.term === '(Intercept)' || row.term.startsWith('model_id'))
    .slice(0, 56)
    .map(row => ({
      metric: metricLabel(row.metric),
      predictor: categoryModelTermLabel(row.term),
      estimate: formatNumber(row.estimate, 3),
      p_value: formatP(row.p_value),
    }));
  $rq1CategoryModelRegressionTable.innerHTML = miniTable(
    ['metric', 'predictor', 'estimate', 'p_value'],
    compact
  );
}

function renderCategoryBiasTable(rows) {
  const compact = rows.slice(0, 12).map(row => ({
    sub_category: row.sub_category,
    bias_gap: formatPercent(Number(row.bias_gap || 0)),
    high_visibility_rate: formatPercent(Number(row.high_visibility_rate || 0)),
    niche_rate: formatPercent(Number(row.niche_rate || 0)),
    niche_mentions: row.niche_mentions,
  }));
  $rq1CategoryBiasTable.innerHTML = miniTable(
    ['sub_category', 'bias_gap', 'high_visibility_rate', 'niche_rate', 'niche_mentions'],
    compact
  );
}

function renderNicheOpportunitiesTable(rows) {
  const compact = rows.slice(0, 20).map(row => ({
    sub_category: row.sub_category,
    brand: row.brand,
    recommendation_rate: formatPercent(Number(row.recommendation_rate || 0)),
    total_mentions: row.total_mentions,
  }));
  $rq1NicheOpportunitiesTable.innerHTML = miniTable(
    ['sub_category', 'brand', 'recommendation_rate', 'total_mentions'],
    compact
  );
}

function renderInteractionTable(rows) {
  const selectedReference = $rqReferenceSelect?.value || rows[0]?.reference_model_id || '';
  const scopedRows = rows.some(row => row.reference_model_id)
    ? rows.filter(row => row.reference_model_id === selectedReference)
    : rows;
  const interactionRows = scopedRows
    .filter(row => row.term.includes(':') || row.term === 'visibility_grouphigh_visibility')
    .map(row => ({
      model: interactionTermLabel(row.term),
      estimate: formatNumber(row.estimate, 3),
      odds_ratio: formatNumber(row.odds_ratio, 2),
      p_value: formatP(row.p_value),
    }));
  $rq1InteractionTable.innerHTML = miniTable(
    ['model', 'estimate', 'odds_ratio', 'p_value'],
    interactionRows
  );
}

function syncReferenceSelector(rows) {
  if (!$rqReferenceSelect || !rows.length || !rows.some(row => row.reference_model_id)) return;
  const availableRefs = new Set(rows.map(row => row.reference_model_id));
  Array.from($rqReferenceSelect.options).forEach(option => {
    option.disabled = !availableRefs.has(option.value);
  });
  if (!availableRefs.has($rqReferenceSelect.value)) {
    $rqReferenceSelect.value = rows[0].reference_model_id;
  }
}

function renderCategoryVisibilityTable(rows) {
  const compact = rows
    .filter(row => row.visibility_group === 'high_visibility' || row.visibility_group === 'niche')
    .map(row => ({
      sub_category: row.sub_category,
      visibility_group: row.visibility_group,
      recommendation_rate: formatPercent(Number(row.recommendation_rate || 0)),
      total_mentions: row.total_mentions,
      n_observations: row.n_observations,
    }));
  $rq1CategoryTable.innerHTML = miniTable(
    ['sub_category', 'visibility_group', 'recommendation_rate', 'total_mentions', 'n_observations'],
    compact
  );
}

function miniTable(headers, rows) {
  if (!rows.length) return '<div class="analysis-output">No rows available.</div>';
  const numericHeaders = new Set(headers.filter(header =>
    rows.some(row => Number.isFinite(parseSortNumber(row[header])))
  ));
  return `
    <table class="mini-table">
      <thead><tr>${headers.map(h => {
        const label = escapeHtml(h);
        if (!numericHeaders.has(h)) return `<th>${label}</th>`;
        return `
          <th>
            <button type="button" class="mini-table-sort" data-sort-key="${label}">
              <span>${label}</span>
              <span class="sort-indicator">↕</span>
            </button>
          </th>
        `;
      }).join('')}</tr></thead>
      <tbody>
        ${rows.map(row => `<tr>${headers.map(h => {
          const value = row[h] ?? '';
          const sortValue = parseSortNumber(value);
          const sortAttr = Number.isFinite(sortValue) ? ` data-sort-value="${sortValue}"` : '';
          return `<td${sortAttr}>${escapeHtml(value)}</td>`;
        }).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;
}

function handleMiniTableSort(event) {
  const button = event.target.closest('.mini-table-sort');
  if (!button) return;

  const table = button.closest('table');
  const th = button.closest('th');
  const tbody = table?.querySelector('tbody');
  if (!table || !th || !tbody) return;

  const headerCells = Array.from(th.parentElement.children);
  const columnIndex = headerCells.indexOf(th);
  const nextDir = button.dataset.sortDir === 'desc' ? 'asc' : 'desc';

  table.querySelectorAll('.mini-table-sort').forEach(otherButton => {
    if (otherButton !== button) {
      otherButton.dataset.sortDir = '';
      const indicator = otherButton.querySelector('.sort-indicator');
      if (indicator) indicator.textContent = '↕';
    }
  });

  button.dataset.sortDir = nextDir;
  const indicator = button.querySelector('.sort-indicator');
  if (indicator) indicator.textContent = nextDir === 'desc' ? '↓' : '↑';

  const sortedRows = Array.from(tbody.querySelectorAll('tr')).sort((a, b) => {
    const aValue = Number(a.children[columnIndex]?.dataset.sortValue);
    const bValue = Number(b.children[columnIndex]?.dataset.sortValue);
    if (!Number.isFinite(aValue) && !Number.isFinite(bValue)) return 0;
    if (!Number.isFinite(aValue)) return 1;
    if (!Number.isFinite(bValue)) return -1;
    return nextDir === 'desc' ? bValue - aValue : aValue - bValue;
  });

  sortedRows.forEach(row => tbody.appendChild(row));
}

function parseSortNumber(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (!text || text === '—') return NaN;
  if (text.startsWith('<')) {
    const lessThanValue = Number(text.replace(/[<\s,]/g, ''));
    return Number.isFinite(lessThanValue) ? lessThanValue : NaN;
  }
  const isPercent = text.endsWith('%');
  const cleaned = text.replace(/[%,$,\s]/g, '');
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return NaN;
  return isPercent ? number / 100 : number;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatP(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 0.001) return '< .001';
  return n.toFixed(3);
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function exportRawCSV() {
  if (!lastResults?.results?.length) {
    showToast('No results to export.', 'error');
    return;
  }

  const headers = [
    'run_id','category','sub_category','model_id','model_name','replicate',
    'prompt_condition','persona_id','persona_type','profile_text','prompt','response_text','brand_1','brand_2','brand_3',
    'brand_4','brand_5','timestamp','temperature','max_output_tokens','notes'
  ];

  const rows = lastResults.results.map(r =>
    headers.map(h => csvEscape(r[h] ?? '')).join(',')
  );

  downloadCSV(`raw_results_${lastResults.config.subCategory}_${lastResults.config.modelId}.csv`,
    headers.join(',') + '\n' + rows.join('\n'));

  showToast('Raw results CSV exported.', 'success');
}

function exportMetricsCSV() {
  if (!lastResults?.metrics?.length) {
    showToast('No metrics to export.', 'error');
    return;
  }

  const headers = ['sub_category','model_id','prompt_condition','brand','visibility_group','total_mentions','n_replicates','BRP@1','BRP@3','BRP@5','MRR'];
  const rows = lastResults.metrics.map(m =>
    headers.map(h => csvEscape(m[h] ?? '')).join(',')
  );

  downloadCSV(`metrics_${lastResults.config.subCategory}_${lastResults.config.modelId}.csv`,
    headers.join(',') + '\n' + rows.join('\n'));

  showToast('Metrics CSV exported.', 'success');
}

function exportConfigJSON() {
  if (!lastResults?.config) {
    showToast('No experiment config to export.', 'error');
    return;
  }

  const configData = {
    experiment_name: `${lastResults.config.promptCondition || 'brand'}_brand_recommendation_audit`,
    ...lastResults.config,
    primary_metrics: ['BRP@1', 'BRP@3', 'BRP@5', 'MRR'],
    language: 'English',
    export_timestamp: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(configData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `config_${lastResults.config.subCategory}_${lastResults.config.modelId}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('Config JSON exported.', 'success');
}

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Toast Notifications ───────────────────────────────────────────
let toastContainer = null;

function showToast(message, type = 'success') {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
