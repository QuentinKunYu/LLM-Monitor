const API = '';
const PROMPTS_PER_PAGE = 40;
const TERMINAL_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'interrupted']);

const state = {
  config: null,
  serviceAvailable: false,
  defaultPrompts: [],
  prompts: [],
  promptPage: 1,
  editingPromptId: '',
  currentRunId: '',
  currentRunToken: '',
  pollTimer: null,
  lastStatus: null,
  lastResults: null,
  liveErrors: [],
  metricsSort: { key: null, dir: null },
  aspirationScores: new Map(),
  appPassword: sessionStorage.getItem('brandLabAppPassword') || '',
};

let passwordDialogResolve = null;

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function loadAspirationScores() {
  try {
    const response = await fetch(`${API}/aspiration-scores.json`);
    if (!response.ok) return;
    const data = await response.json();
    for (const entry of data.entries || []) {
      state.aspirationScores.set(entry.key, entry);
    }
  } catch (_) {
    // Aspiration scores are a supplementary layer; missing data shouldn't block the results page.
  }
}

function looseBrandKey(subCategory, brand) {
  const normalized = String(brand || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `${subCategory}|${normalized}`;
}

function withAspiration(rows) {
  return rows.map(row => {
    const entry = state.aspirationScores.get(looseBrandKey(row.sub_category, row.brand));
    return {
      ...row,
      aspiration_e: entry?.scoreE ?? null,
      aspiration_s: entry?.scoreS ?? null,
      aspiration_ed: entry?.ed ?? null,
      aspiration_avg: entry?.avg ?? null,
    };
  });
}

async function init() {
  loadAspirationScores();
  wireStaticEvents();
  state.config = browserFallbackConfig();
  const bundledPrompts = Array.isArray(globalThis.DEFAULT_NEEDS_PROMPTS) ? globalThis.DEFAULT_NEEDS_PROMPTS : [];
  state.defaultPrompts = structuredClone(bundledPrompts);
  state.prompts = structuredClone(bundledPrompts);
  updateSelectionCounts();
  updateContextPreview();
  renderPromptThemeOptions();
  renderPromptLibrary();
  updateProtocolUI();
  try {
    const [configResponse, promptResponse] = await Promise.all([
      fetch(`${API}/api/config`),
      fetch(`${API}/api/prompts`),
    ]);
    if (!configResponse.ok) throw new Error('The research configuration could not be loaded.');
    state.config = await configResponse.json();
    state.serviceAvailable = true;
    if (promptResponse.ok) {
      const promptData = await promptResponse.json();
      if (promptData.prompts?.length) {
        state.defaultPrompts = structuredClone(promptData.prompts);
        state.prompts = structuredClone(state.defaultPrompts);
      }
    } else if (!state.defaultPrompts.length) {
      throw new Error('The needs-based prompt library could not be loaded.');
    }
    renderConfigurationOptions();
    resetToPaperDefaults({ announce: false });
    if (!new URLSearchParams(window.location.search).has('new')) resumeRunFromSession();
  } catch (error) {
    state.serviceAvailable = false;
    $('configuration-status').classList.remove('is-hidden');
    updateSelectionCounts();
    updateProtocolUI();
    toast(error.message, 'error');
  }
}

function browserFallbackConfig() {
  const models = $$('[data-model-option]').map(input => {
    const option = input.closest('.choice-option');
    const [provider = ''] = (option?.querySelector('small')?.textContent || '').split('·');
    return {
      model_id: input.value,
      provider: provider.trim(),
      display_name: option?.querySelector('strong')?.textContent?.trim() || input.value,
    };
  });
  const categoryItems = $$('[data-category-option]').map(input => ({
    category: input.closest('.choice-option')?.querySelector('small')?.textContent?.trim() || '',
    sub_category: input.value,
  }));
  return {
    models,
    categories: categoryItems.map(item => ({
      category: item.category,
      sub_categories: [{ sub_category: item.sub_category, brands: [] }],
    })),
    paperDefaults: {
      models: models.map(model => model.model_id),
      categories: categoryItems.map(item => item.sub_category),
      promptTemplate: $('context-prompt').defaultValue.trim(),
      includeContextFree: $('include-context-free').defaultChecked,
      includeNeedsBased: $('include-needs-based').defaultChecked,
      contextFreeReplicates: Number($('context-replicates').defaultValue),
      needsRepeats: Number($('needs-repeats').defaultValue),
      maxOutputTokens: Number($('max-output-tokens').defaultValue),
      reasonMaxOutputTokens: Number($('reason-max-output-tokens').defaultValue),
    },
  };
}

function wireStaticEvents() {
  document.addEventListener('change', handleProtocolChange);
  document.addEventListener('input', handleProtocolInput);
  document.addEventListener('click', handleDocumentClick);
  $('reset-defaults-btn').addEventListener('click', () => resetToPaperDefaults({ announce: true }));
  $('run-experiment-btn').addEventListener('click', startExperiment);
  $('mobile-run-btn').addEventListener('click', startExperiment);
  $('cancel-run-btn').addEventListener('click', cancelExperiment);
  $('retry-run-btn').addEventListener('click', retryExperiment);
  $('download-prompts-btn').addEventListener('click', () => downloadCSV('needs_based_prompts.csv', promptCsvRows(state.prompts)));
  $('prompt-search').addEventListener('input', resetPromptPageAndRender);
  $('preview-category').addEventListener('change', handlePromptCategoryChange);
  $('prompt-condition-filter').addEventListener('change', resetPromptPageAndRender);
  $('prompt-theme-filter').addEventListener('change', resetPromptPageAndRender);
  $('prompt-prev-btn').addEventListener('click', () => changePromptPage(-1));
  $('prompt-next-btn').addEventListener('click', () => changePromptPage(1));
  $('dialog-save-btn').addEventListener('click', savePromptEdit);
  $('dialog-reset-btn').addEventListener('click', restoreEditingPrompt);
  $('password-submit-btn').addEventListener('click', submitPasswordDialog);
  $('password-input').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitPasswordDialog();
  });
  $('password-dialog').addEventListener('close', () => {
    if (!passwordDialogResolve) return;
    const resolve = passwordDialogResolve;
    passwordDialogResolve = null;
    resolve($('password-dialog').returnValue === 'submit');
  });
  $('download-menu-btn').addEventListener('click', toggleDownloadMenu);
}

function handleDocumentClick(event) {
  const selectAllButton = event.target.closest('[data-select-all]');
  if (selectAllButton) selectAllOptions(selectAllButton.dataset.selectAll);

  const editButton = event.target.closest('[data-edit-prompt]');
  if (editButton) openPromptDialog(editButton.dataset.editPrompt);

  const resultTab = event.target.closest('[data-result-tab]');
  if (resultTab) switchResultTab(resultTab.dataset.resultTab);

  const exportButton = event.target.closest('[data-export]');
  if (exportButton) exportArtifact(exportButton.dataset.export);

  const sortButton = event.target.closest('[data-sort-key]');
  if (sortButton) toggleMetricsSort(sortButton.dataset.sortKey);

  if (!event.target.closest('.download-menu')) $('download-popover').classList.add('is-hidden');
}

function toggleMetricsSort(key) {
  if (state.metricsSort.key !== key) {
    state.metricsSort = { key, dir: 'desc' };
  } else if (state.metricsSort.dir === 'desc') {
    state.metricsSort = { key, dir: 'asc' };
  } else {
    state.metricsSort = { key: null, dir: null };
  }
  updateSortIndicators();
  renderMetricsTable();
}

function updateSortIndicators() {
  $$('.sort-icon').forEach(icon => {
    const key = icon.dataset.sortIcon;
    const active = state.metricsSort.key === key;
    icon.classList.toggle('is-active', active);
    icon.textContent = active ? (state.metricsSort.dir === 'asc' ? '▲' : '▼') : '⇅';
  });
}

function handleProtocolChange(event) {
  if (event.target.id === 'temperature-override') {
    $('temperature-value').disabled = !event.target.checked;
  }
  if (event.target.matches('[data-model-option], [data-category-option], #include-context-free, #include-needs-based, #temperature-override, #followup-reasons, #web-search, #dry-run')) {
    if (event.target.matches('[data-category-option]')) setActivePromptCategory(event.target.value);
    updateSelectionCounts();
    updateProtocolUI();
  }
}

function handleProtocolInput(event) {
  if (event.target.id === 'context-prompt') updateContextPreview();
  if (event.target.matches('#context-prompt, #context-replicates, #needs-repeats, #max-output-tokens, #reason-max-output-tokens, #temperature-value')) {
    updateProtocolUI();
  }
  if (event.target.matches('#result-analysis-level, #result-category-filter, #result-model-filter, #result-condition-filter, #result-theme-filter, #result-brand-filter')) {
    if (event.target.id === 'result-category-filter') {
      populateResultThemeFilter(state.lastResults?.metricsByTheme || []);
    }
    renderMetricsTable();
  }
  if (event.target.matches('#raw-category-filter, #raw-model-filter, #raw-condition-filter, #raw-theme-filter, #raw-text-filter')) {
    if (event.target.id === 'raw-category-filter') {
      populateObservationThemeFilter('raw', state.lastResults?.results || []);
    }
    renderRawTable();
  }
  if (event.target.matches('#reason-category-filter, #reason-model-filter, #reason-condition-filter, #reason-theme-filter, #reason-text-filter')) {
    if (event.target.id === 'reason-category-filter') {
      populateObservationThemeFilter('reason', state.lastResults?.results || []);
    }
    renderReasonsTable();
  }
}

function renderConfigurationOptions() {
  $('model-options').innerHTML = state.config.models.map(model => `
    <label class="choice-option">
      <input type="checkbox" value="${escapeHtml(model.model_id)}" data-model-option />
      <strong>${escapeHtml(model.display_name)}</strong>
      <small>${escapeHtml(model.provider)} · ${escapeHtml(model.model_id)}</small>
    </label>
  `).join('');

  const categories = flatCategories();
  $('category-options').innerHTML = categories.map(item => `
    <label class="choice-option">
      <input type="checkbox" value="${escapeHtml(item.sub_category)}" data-category-option />
      <strong>${escapeHtml(titleCase(item.sub_category))}</strong>
      <small>${escapeHtml(item.category)}</small>
    </label>
  `).join('');

  const categoryOptions = categories.map(item => `<option value="${escapeHtml(item.sub_category)}">${escapeHtml(titleCase(item.sub_category))}</option>`).join('');
  $('preview-category').innerHTML = categoryOptions;
  $('result-category-filter').innerHTML = `<option value="">All</option>${categoryOptions}`;
  $('result-model-filter').innerHTML = `<option value="">All</option>${state.config.models.map(model => `<option value="${escapeHtml(model.model_id)}">${escapeHtml(shortModelName(model.display_name))}</option>`).join('')}`;
}

function flatCategories() {
  return state.config.categories.flatMap(group => group.sub_categories.map(item => ({
    category: group.category,
    sub_category: item.sub_category,
  })));
}

function resetToPaperDefaults({ announce = true } = {}) {
  const defaults = state.config.paperDefaults;
  $$('[data-model-option]').forEach(input => { input.checked = defaults.models.includes(input.value); });
  $$('[data-category-option]').forEach(input => { input.checked = defaults.categories.includes(input.value); });
  $('context-prompt').value = defaults.promptTemplate;
  $('include-context-free').checked = defaults.includeContextFree !== false;
  $('include-needs-based').checked = defaults.includeNeedsBased !== false;
  $('context-replicates').value = defaults.contextFreeReplicates;
  $('needs-repeats').value = defaults.needsRepeats;
  $('max-output-tokens').value = defaults.maxOutputTokens;
  $('reason-max-output-tokens').value = defaults.reasonMaxOutputTokens;
  $('temperature-override').checked = false;
  $('temperature-value').value = '0.70';
  $('temperature-value').disabled = true;
  $('followup-reasons').checked = true;
  $('web-search').checked = false;
  $('dry-run').checked = false;
  state.prompts = structuredClone(state.defaultPrompts);
  state.promptPage = 1;
  $('prompt-search').value = '';
  $('preview-category').value = defaults.categories[0] || flatCategories()[0]?.sub_category || '';
  $('prompt-condition-filter').value = '';
  $('prompt-theme-filter').value = '';
  renderPromptThemeOptions();
  renderPromptLibrary();
  updateContextPreview();
  updateProtocolUI();
  if (announce) toast('Paper defaults restored.', 'success');
}

function selectedModelIds() {
  return $$('[data-model-option]:checked').map(input => input.value);
}

function selectedCategories() {
  return $$('[data-category-option]:checked').map(input => input.value);
}

function protocolSnapshot() {
  const temperature = $('temperature-override').checked ? numberValue('temperature-value', 0.7) : null;
  return {
    models: selectedModelIds(),
    categories: selectedCategories(),
    promptTemplate: $('context-prompt').value.trim(),
    includeContextFree: $('include-context-free').checked,
    includeNeedsBased: $('include-needs-based').checked,
    contextFreeReplicates: integerValue('context-replicates', 40),
    needsRepeats: integerValue('needs-repeats', 2),
    maxOutputTokens: integerValue('max-output-tokens', 800),
    reasonMaxOutputTokens: integerValue('reason-max-output-tokens', 800),
    temperature,
    followupReasons: $('followup-reasons').checked,
    webSearch: $('web-search').checked,
    dryRun: $('dry-run').checked,
    needsPrompts: state.prompts,
  };
}

function protocolCounts(snapshot = protocolSnapshot()) {
  const selectedPromptCount = snapshot.needsPrompts.filter(prompt => snapshot.categories.includes(prompt.sub_category)).length;
  const contextFreeCalls = snapshot.includeContextFree
    ? snapshot.models.length * snapshot.categories.length * snapshot.contextFreeReplicates
    : 0;
  const needsBasedCalls = snapshot.includeNeedsBased
    ? selectedPromptCount * snapshot.models.length * snapshot.needsRepeats
    : 0;
  const recommendationCalls = contextFreeCalls + needsBasedCalls;
  const reasonCalls = snapshot.followupReasons ? recommendationCalls : 0;
  return {
    selectedPromptCount,
    contextFreeCalls,
    needsBasedCalls,
    recommendationCalls,
    reasonCalls,
    totalCalls: recommendationCalls + reasonCalls,
  };
}

function isPaperDefaults(snapshot = protocolSnapshot()) {
  const defaults = state.config.paperDefaults;
  return (
    equalArrays(snapshot.models, defaults.models) &&
    equalArrays(snapshot.categories, defaults.categories) &&
    snapshot.promptTemplate === defaults.promptTemplate &&
    snapshot.includeContextFree &&
    snapshot.includeNeedsBased &&
    snapshot.contextFreeReplicates === defaults.contextFreeReplicates &&
    snapshot.needsRepeats === defaults.needsRepeats &&
    snapshot.maxOutputTokens === defaults.maxOutputTokens &&
    snapshot.reasonMaxOutputTokens === defaults.reasonMaxOutputTokens &&
    snapshot.temperature === null &&
    snapshot.followupReasons && !snapshot.webSearch && !snapshot.dryRun &&
    state.prompts.length === state.defaultPrompts.length &&
    state.prompts.every((prompt, index) => prompt.prompt_id === state.defaultPrompts[index]?.prompt_id && prompt.prompt === state.defaultPrompts[index]?.prompt)
  );
}

function updateProtocolUI() {
  if (!state.config) return;
  const snapshot = protocolSnapshot();
  const counts = protocolCounts(snapshot);
  const paper = isPaperDefaults(snapshot);
  const offline = !state.serviceAvailable;
  const modeLabel = paper ? 'Paper defaults' : 'Custom run';
  const total = formatInteger(counts.totalCalls);

  const summaryMode = $('summary-mode');
  summaryMode.textContent = offline ? 'Service offline' : modeLabel;
  summaryMode.hidden = paper && !offline;
  summaryMode.classList.toggle('is-custom', !paper && !offline);
  summaryMode.classList.toggle('is-offline', offline);
  $('mobile-mode').textContent = offline ? 'Service offline' : modeLabel;
  $('review-title').textContent = offline ? 'Experiment service unavailable' : paper ? 'Ready to reproduce' : 'Review custom protocol';
  $('summary-context').textContent = formatInteger(counts.contextFreeCalls);
  $('summary-needs').textContent = formatInteger(counts.needsBasedCalls);
  $('summary-reasons').textContent = formatInteger(counts.reasonCalls);
  $('summary-total').textContent = total;
  $('mobile-total').textContent = `${total} calls`;
  $('summary-search').textContent = snapshot.webSearch ? 'On · custom' : 'Off';
  $('summary-temperature').textContent = snapshot.temperature === null ? 'Provider default' : String(snapshot.temperature);
  const runLabel = snapshot.includeContextFree && snapshot.includeNeedsBased
    ? 'Run full experiment'
    : snapshot.includeContextFree
      ? 'Run context-free'
      : 'Run needs-based';
  $('run-experiment-btn').textContent = `${runLabel} — ${total} calls`;
  $('mobile-run-btn').textContent = snapshot.dryRun ? 'Run dry preview' : 'Run experiment';
  $('model-selection-count').textContent = `${snapshot.models.length} of ${state.config.models.length} selected`;
  $('category-selection-count').textContent = `${snapshot.categories.length} of ${flatCategories().length} selected`;
  $('context-replicates').disabled = !snapshot.includeContextFree;
  $('needs-repeats').disabled = !snapshot.includeNeedsBased;
  const invalid = snapshot.models.length === 0 || snapshot.categories.length === 0 ||
    (!snapshot.includeContextFree && !snapshot.includeNeedsBased) ||
    (snapshot.includeContextFree && !snapshot.promptTemplate.includes('[category]')) ||
    (snapshot.includeNeedsBased && snapshot.needsPrompts.length === 0);
  $('run-experiment-btn').disabled = invalid || offline;
  $('mobile-run-btn').disabled = invalid || offline;
}

function updateContextPreview() {
  const category = $('preview-category').value || selectedCategories()[0] || 'cordless drills';
  $('context-preview').textContent = $('context-prompt').value.replace(/\[category\]/gi, category);
  $('context-preview-category').textContent = titleCase(category);
}

function handlePromptCategoryChange() {
  setActivePromptCategory($('preview-category').value, { resetFilters: true });
}

function setActivePromptCategory(category, { resetFilters = false } = {}) {
  const hasCategory = Array.from($('preview-category').options).some(option => option.value === category);
  if (!category || !hasCategory) return;
  $('preview-category').value = category;
  if (resetFilters) {
    $('prompt-search').value = '';
    $('prompt-condition-filter').value = '';
    $('prompt-theme-filter').value = '';
  }
  state.promptPage = 1;
  renderPromptThemeOptions();
  renderPromptLibrary();
  updateContextPreview();
}

function selectAllOptions(type) {
  const selector = type === 'models' ? '[data-model-option]' : '[data-category-option]';
  const inputs = $$(selector);
  const shouldSelect = inputs.some(input => !input.checked);
  inputs.forEach(input => { input.checked = shouldSelect; });
  updateSelectionCounts();
  updateProtocolUI();
}

function updateSelectionCounts() {
  const modelOptions = $$('[data-model-option]');
  const categoryOptions = $$('[data-category-option]');
  $('model-selection-count').textContent = `${modelOptions.filter(input => input.checked).length} of ${modelOptions.length} selected`;
  $('category-selection-count').textContent = `${categoryOptions.filter(input => input.checked).length} of ${categoryOptions.length} selected`;
}

function filteredPrompts() {
  const query = $('prompt-search').value.trim().toLowerCase();
  const category = $('preview-category').value;
  const condition = $('prompt-condition-filter').value;
  const theme = $('prompt-theme-filter').value;
  return state.prompts.filter(prompt => (
    (!query || `${prompt.prompt_id} ${prompt.prompt}`.toLowerCase().includes(query)) &&
    (!category || prompt.sub_category === category) &&
    (!condition || prompt.prompt_condition === condition) &&
    (!theme || prompt.theme === theme)
  ));
}

function renderPromptLibrary() {
  const category = $('preview-category').value;
  const categoryPrompts = state.prompts.filter(prompt => prompt.sub_category === category);
  const generalCount = categoryPrompts.filter(prompt => prompt.prompt_condition === 'needs-based-general').length;
  const detailedCount = categoryPrompts.filter(prompt => prompt.prompt_condition === 'needs-based-detailed').length;
  const filtered = filteredPrompts();
  const maxPage = Math.max(1, Math.ceil(filtered.length / PROMPTS_PER_PAGE));
  state.promptPage = Math.min(state.promptPage, maxPage);
  const start = (state.promptPage - 1) * PROMPTS_PER_PAGE;
  const pageRows = filtered.slice(start, start + PROMPTS_PER_PAGE);
  $('prompt-table-body').innerHTML = pageRows.length ? pageRows.map(prompt => `
    <tr>
      <td>${escapeHtml(prompt.prompt_id)}</td>
      <td>${escapeHtml(titleCase(prompt.sub_category))}<span class="condition-label">${prompt.prompt_condition.includes('detailed') ? 'Detailed' : 'General'}</span></td>
      <td>${escapeHtml(prompt.theme)}</td>
      <td>${escapeHtml(prompt.prompt)}</td>
      <td><button class="text-button" type="button" data-edit-prompt="${escapeHtml(prompt.prompt_id)}">Edit</button></td>
    </tr>
  `).join('') : `<tr><td colspan="5">No prompts match these filters.</td></tr>`;
  const end = Math.min(filtered.length, start + PROMPTS_PER_PAGE);
  $('prompt-page-label').textContent = filtered.length ? `Showing ${start + 1}–${end} of ${filtered.length}` : 'Showing 0 prompts';
  $('prompt-prev-btn').disabled = state.promptPage <= 1;
  $('prompt-next-btn').disabled = state.promptPage >= maxPage;
  $('prompt-category-heading').textContent = titleCase(category);
  $('library-category-name').textContent = titleCase(category);
  $('prompt-set-counts').textContent = `1 context-free · ${generalCount} general · ${detailedCount} detailed`;
}

function renderPromptThemeOptions() {
  const current = $('prompt-theme-filter').value;
  const category = $('preview-category').value;
  const themes = [...new Set(state.prompts.filter(prompt => prompt.sub_category === category).map(prompt => prompt.theme))].sort();
  $('prompt-theme-filter').innerHTML = `<option value="">All themes</option>${themes.map(theme => `<option value="${escapeHtml(theme)}">${escapeHtml(theme)}</option>`).join('')}`;
  if (themes.includes(current)) $('prompt-theme-filter').value = current;
}

function resetPromptPageAndRender() { state.promptPage = 1; renderPromptLibrary(); }
function changePromptPage(delta) { state.promptPage += delta; renderPromptLibrary(); }

function openPromptDialog(promptId) {
  const prompt = state.prompts.find(item => item.prompt_id === promptId);
  if (!prompt) return;
  state.editingPromptId = promptId;
  $('dialog-title').textContent = prompt.prompt_id;
  $('dialog-meta').innerHTML = `
    <div><dt>Category</dt><dd>${escapeHtml(prompt.sub_category)}</dd></div>
    <div><dt>Condition</dt><dd>${escapeHtml(prompt.prompt_condition)}</dd></div>
    <div><dt>Theme</dt><dd>${escapeHtml(prompt.theme)}</dd></div>
  `;
  $('dialog-prompt-text').value = prompt.prompt;
  $('prompt-dialog').showModal();
}

function savePromptEdit() {
  const text = $('dialog-prompt-text').value.trim();
  if (!text) return toast('Prompt text cannot be empty.', 'error');
  const prompt = state.prompts.find(item => item.prompt_id === state.editingPromptId);
  if (!prompt) return;
  prompt.prompt = text;
  $('prompt-dialog').close();
  renderPromptLibrary();
  updateProtocolUI();
  toast('Prompt updated.', 'success');
}

function restoreEditingPrompt() {
  const original = state.defaultPrompts.find(item => item.prompt_id === state.editingPromptId);
  if (!original) return;
  $('dialog-prompt-text').value = original.prompt;
}

function ensureRunPassword() {
  if (state.appPassword) return Promise.resolve(true);
  return new Promise(resolve => {
    passwordDialogResolve = resolve;
    $('password-error').classList.add('is-hidden');
    $('password-input').value = '';
    $('password-dialog').showModal();
    $('password-input').focus();
  });
}

function submitPasswordDialog() {
  const value = $('password-input').value.trim();
  if (!value) {
    $('password-error').textContent = 'Enter a password.';
    $('password-error').classList.remove('is-hidden');
    return;
  }
  state.appPassword = value;
  sessionStorage.setItem('brandLabAppPassword', value);
  $('password-dialog').close('submit');
}

function clearStoredRunPassword() {
  state.appPassword = '';
  sessionStorage.removeItem('brandLabAppPassword');
}

function runPasswordHeaders() {
  return state.appPassword ? { 'X-App-Password': state.appPassword } : {};
}

function validateProtocol(snapshot) {
  if (!snapshot.models.length) throw new Error('Select at least one model.');
  if (!snapshot.categories.length) throw new Error('Select at least one category.');
  if (!snapshot.includeContextFree && !snapshot.includeNeedsBased) throw new Error('Select at least one condition to run.');
  if (snapshot.includeContextFree && !snapshot.promptTemplate.includes('[category]')) throw new Error('The context-free prompt must include [category].');
  if (snapshot.includeNeedsBased && !snapshot.needsPrompts.length) throw new Error('The needs-based prompt library is empty.');
}

async function startExperiment() {
  if (state.lastStatus?.status === 'running') return;
  try {
    const snapshot = protocolSnapshot();
    validateProtocol(snapshot);
    const authorized = await ensureRunPassword();
    if (!authorized) return;
    state.liveErrors = [];
    renderExperimentErrors([]);
    setRunButtonsDisabled(true);
    showExecutionPanel();
    $('execution-title').textContent = 'Creating experiment ledger';
    $('execution-message').textContent = 'Validating prompts, model provenance, and server provider access.';
    const response = await fetch(`${API}/api/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...runPasswordHeaders() },
      body: JSON.stringify(snapshot),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) clearStoredRunPassword();
      throw new Error(data.error || 'The experiment could not be started.');
    }
    state.currentRunId = data.runId;
    state.currentRunToken = data.runToken;
    sessionStorage.setItem('brandLabRun', JSON.stringify({ runId: data.runId, runToken: data.runToken }));
    toast('Experiment started with the server provider configuration.', 'success');
    pollExperiment();
  } catch (error) {
    setRunButtonsDisabled(false);
    showExecutionPanel();
    $('execution-title').textContent = 'Experiment could not start';
    $('execution-message').textContent = error.message;
    appendExecutionError({ stage: 'setup', message: error.message });
    toast(error.message, 'error');
  }
}

async function pollExperiment() {
  clearTimeout(state.pollTimer);
  if (!state.currentRunId || !state.currentRunToken) return;
  try {
    const response = await fetch(`${API}/api/experiments/${state.currentRunId}`, {
      headers: runTokenHeaders(),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Run status is unavailable.');
    state.lastStatus = data;
    renderExperimentStatus(data);
    if (TERMINAL_STATUSES.has(data.status)) {
      setRunButtonsDisabled(false);
      if (data.status === 'completed' || data.status === 'incomplete' || data.status === 'cancelled') await loadExperimentResults();
      return;
    }
    state.pollTimer = setTimeout(pollExperiment, 1200);
  } catch (error) {
    showExecutionPanel();
    $('execution-title').textContent = 'Run status connection interrupted';
    $('execution-message').textContent = 'The web app could not refresh the run status. Retrying automatically.';
    appendExecutionError({ stage: 'connection', message: error.message });
    state.pollTimer = setTimeout(pollExperiment, 3000);
    toast(error.message, 'error');
  }
}

function renderExperimentStatus(data) {
  showExecutionPanel();
  const progress = data.progress || {};
  $('execution-title').textContent = statusTitle(data.status, data.stage);
  $('execution-message').textContent = data.message || '';
  $('execution-percent').textContent = `${progress.percent || 0}%`;
  $('overall-progress-fill').style.width = `${progress.percent || 0}%`;
  renderStageProgress('context', progress.contextFree);
  renderStageProgress('needs', progress.needsBased);
  renderStageProgress('reason', progress.reasons);
  state.liveErrors = Array.isArray(data.errors) ? data.errors : [];
  renderExperimentErrors(state.liveErrors);
  $$('.stage-row').forEach(row => row.classList.toggle('is-current', row.dataset.stage === data.stage));
  const terminal = TERMINAL_STATUSES.has(data.status);
  $('cancel-run-btn').classList.toggle('is-hidden', terminal);
  $('retry-run-btn').classList.toggle('is-hidden', !['incomplete', 'failed', 'cancelled', 'interrupted'].includes(data.status));
}

function renderStageProgress(prefix, progress = {}) {
  $(`${prefix}-progress`).textContent = `${formatInteger(progress.completed || 0)} / ${formatInteger(progress.total || 0)}`;
  $(`${prefix}-errors`).textContent = `${formatInteger(progress.errors || 0)} errors`;
}

function appendExecutionError(error) {
  const entry = {
    stage: error.stage || 'run',
    provider: error.provider || '',
    model_id: error.model_id || '',
    prompt_id: error.prompt_id || '',
    message: error.message || 'Unknown experiment error.',
    quotaLimited: Boolean(error.quotaLimited),
    timestamp: error.timestamp || new Date().toISOString(),
  };
  const previous = state.liveErrors[state.liveErrors.length - 1];
  if (!previous || previous.stage !== entry.stage || previous.message !== entry.message) {
    state.liveErrors = [...state.liveErrors, entry].slice(-50);
  }
  renderExperimentErrors(state.liveErrors);
}

function renderExperimentErrors(errors = []) {
  const panel = $('execution-errors');
  const visibleErrors = errors.slice(-20).reverse();
  panel.classList.toggle('is-hidden', errors.length === 0);
  $('execution-error-count').textContent = `${formatInteger(errors.length)} ${errors.length === 1 ? 'error' : 'errors'}`;
  $('execution-error-list').innerHTML = visibleErrors.map(error => {
    const context = [error.provider, error.model_id, error.prompt_id].filter(Boolean).join(' · ');
    const time = error.timestamp ? new Date(error.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return `
      <li class="${error.quotaLimited ? 'is-quota-error' : ''}">
        <div class="execution-error-meta">
          <span>${escapeHtml(stageErrorLabel(error.stage))}${error.quotaLimited ? ' · quota/rate limit' : ''}</span>
          ${time ? `<time datetime="${escapeHtml(error.timestamp)}">${escapeHtml(time)}</time>` : ''}
        </div>
        <p>${escapeHtml(error.message || 'Unknown experiment error.')}</p>
        ${context ? `<small>${escapeHtml(context)}</small>` : ''}
      </li>
    `;
  }).join('');
  const hiddenCount = Math.max(0, errors.length - visibleErrors.length);
  $('execution-errors-note').textContent = hiddenCount ? `${formatInteger(hiddenCount)} earlier errors are omitted from this live view and remain available in the quality report.` : '';
  $('execution-errors-note').classList.toggle('is-hidden', hiddenCount === 0);
}

function stageErrorLabel(stage) {
  const labels = {
    'context-free': 'Context-free',
    'needs-based': 'Needs-based',
    reasons: 'Reason follow-up',
    setup: 'Experiment setup',
    connection: 'Status connection',
    run: 'Experiment',
  };
  return labels[stage] || titleCase(stage || 'Experiment');
}

async function cancelExperiment() {
  if (!state.currentRunId) return;
  $('cancel-run-btn').disabled = true;
  try {
    const response = await fetch(`${API}/api/experiments/${state.currentRunId}/cancel`, {
      method: 'POST',
      headers: runTokenHeaders(),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The run could not be cancelled.');
    state.lastStatus = data;
    renderExperimentStatus(data);
    pollExperiment();
  } catch (error) {
    appendExecutionError({ stage: 'connection', message: error.message });
    toast(error.message, 'error');
  } finally {
    $('cancel-run-btn').disabled = false;
  }
}

async function retryExperiment() {
  const authorized = await ensureRunPassword();
  if (!authorized) return;
  try {
    $('retry-run-btn').disabled = true;
    const response = await fetch(`${API}/api/experiments/${state.currentRunId}/retry`, {
      method: 'POST',
      headers: { ...runTokenHeaders(), ...runPasswordHeaders() },
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) clearStoredRunPassword();
      throw new Error(data.error || 'Unfinished observations could not be retried.');
    }
    state.lastStatus = data;
    renderExperimentStatus(data);
    pollExperiment();
  } catch (error) {
    appendExecutionError({ stage: 'setup', message: error.message });
    toast(error.message, 'error');
  } finally {
    $('retry-run-btn').disabled = false;
  }
}

async function loadExperimentResults() {
  window.location.assign('/analysis.html');
}

async function loadArchivedResults() {
  const response = await fetch(`${API}/api/archive/results`);
  if (!response.ok) return;
  const data = await response.json();
  state.lastResults = data;
  renderResults(data, { scroll: false });
}

function applyResultConfiguration(data) {
  const config = data.config || {};
  if (Array.isArray(config.models)) {
    $$('[data-model-option]').forEach(input => { input.checked = config.models.includes(input.value); });
  }
  if (Array.isArray(config.categories)) {
    $$('[data-category-option]').forEach(input => { input.checked = config.categories.includes(input.value); });
  }
  if (config.promptTemplate) $('context-prompt').value = config.promptTemplate;
  $('include-context-free').checked = config.includeContextFree !== false;
  $('include-needs-based').checked = config.includeNeedsBased !== false;
  if (config.contextFreeReplicates) $('context-replicates').value = config.contextFreeReplicates;
  if (config.needsRepeats) $('needs-repeats').value = config.needsRepeats;
  if (config.maxOutputTokens) $('max-output-tokens').value = config.maxOutputTokens;
  if (config.reasonMaxOutputTokens) $('reason-max-output-tokens').value = config.reasonMaxOutputTokens;
  $('temperature-override').checked = config.temperature !== null && config.temperature !== undefined && config.temperature !== '';
  $('temperature-value').disabled = !$('temperature-override').checked;
  if ($('temperature-override').checked) $('temperature-value').value = config.temperature;
  $('followup-reasons').checked = config.followupReasons !== false;
  $('web-search').checked = Boolean(config.webSearch);
  $('dry-run').checked = Boolean(config.dryRun);
  if (Array.isArray(data.prompts) && data.prompts.length) state.prompts = structuredClone(data.prompts);
  state.promptPage = 1;
  renderPromptThemeOptions();
  renderPromptLibrary();
  updateContextPreview();
  updateProtocolUI();
}

function renderResults(data, { scroll = true } = {}) {
  $('results-section').classList.remove('is-hidden');
  populateResultConditionFilter(data.metrics || []);
  populateResultThemeFilter(data.metricsByTheme || []);
  populateObservationFilters('raw', data.results || []);
  populateObservationFilters('reason', data.results || []);
  renderMetricsTable();
  renderRawTable();
  renderReasonsTable();
  if (scroll) $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function populateResultConditionFilter(metrics) {
  const current = $('result-condition-filter').value;
  const conditions = [...new Set(metrics.map(row => row.prompt_condition))];
  $('result-condition-filter').innerHTML = `<option value="">All</option>${conditions.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(conditionLabel(value))}</option>`).join('')}`;
  if (conditions.includes(current)) $('result-condition-filter').value = current;
}

function populateResultThemeFilter(metrics) {
  const current = $('result-theme-filter').value;
  const category = $('result-category-filter').value;
  const themes = [...new Set(metrics
    .filter(row => !category || row.sub_category === category)
    .map(row => row.theme)
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  $('result-theme-filter').innerHTML = `<option value="">All themes</option>${themes.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(titleCase(value))}</option>`).join('')}`;
  if (themes.includes(current)) $('result-theme-filter').value = current;
}

function populateSelectFilter(id, values, allLabel, labelFor = value => value) {
  const select = $(id);
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelFor(value))}</option>`).join('')}`;
  if (values.includes(current)) select.value = current;
}

function populateObservationFilters(prefix, rows) {
  const values = field => [...new Set(rows.map(row => row[field]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  populateSelectFilter(`${prefix}-category-filter`, values('sub_category'), 'All categories', titleCase);
  populateSelectFilter(`${prefix}-model-filter`, values('model_id'), 'All models', shortModelId);
  populateSelectFilter(`${prefix}-condition-filter`, values('prompt_condition'), 'All conditions', conditionLabel);
  populateObservationThemeFilter(prefix, rows);
}

function populateObservationThemeFilter(prefix, rows) {
  const category = $(`${prefix}-category-filter`).value;
  const themes = [...new Set(rows
    .filter(row => (!category || row.sub_category === category) && row.theme)
    .map(row => row.theme))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  populateSelectFilter(`${prefix}-theme-filter`, themes, 'All themes', titleCase);
}

function renderMetricsTable() {
  const analysisLevel = $('result-analysis-level').value;
  const metrics = analysisLevel === 'theme'
    ? (state.lastResults?.metricsByTheme || [])
    : (state.lastResults?.metrics || []);
  const category = $('result-category-filter').value;
  const model = $('result-model-filter').value;
  const condition = $('result-condition-filter').value;
  const theme = $('result-theme-filter').value;
  const brand = $('result-brand-filter').value.trim().toLowerCase();
  $('result-theme-filter').disabled = analysisLevel !== 'theme';
  const filtered = metrics.filter(row => (
    (!category || row.sub_category === category) &&
    (!model || row.model_id === model) &&
    (!condition || row.prompt_condition === condition) &&
    (analysisLevel !== 'theme' || !theme || row.theme === theme) &&
    (!brand || String(row.brand).toLowerCase().includes(brand))
  ));
  const groupHeading = analysisLevel === 'theme'
    ? 'Theme'
    : 'Grouping';
  $('result-group-heading').textContent = groupHeading;
  const sorted = sortMetricsRows(withAspiration(filtered));
  $('metrics-table-body').innerHTML = sorted.length ? sorted.slice(0, 500).map(row => `
    <tr class="${row.provisional ? 'provisional-row' : ''}">
      <td>${escapeHtml(row.brand)}</td>
      <td>${escapeHtml(titleCase(row.sub_category))}</td>
      <td title="${escapeHtml(row.model_id)}">${escapeHtml(shortModelId(row.model_id))}</td>
      <td>${escapeHtml(conditionLabel(row.prompt_condition))}</td>
      <td>${escapeHtml(analysisLevel === 'theme' ? row.theme : 'Overall')}</td>
      ${metricCell(row['BRP@1'])}
      ${metricCell(row['BRP@3'])}
      ${metricCell(row['BRP@5'])}
      ${metricCell(row.MRR)}
      <td>${escapeHtml(row.denominator || row.n_replicates)}${row.provisional ? ' / provisional' : ''}</td>
      ${aspirationCell(row.aspiration_e)}${aspirationCell(row.aspiration_s)}${aspirationCell(row.aspiration_ed)}${aspirationCell(row.aspiration_avg)}
    </tr>
  `).join('') : `<tr><td colspan="14">No metric rows match these filters.</td></tr>`;
}

function sortMetricsRows(rows) {
  const { key, dir } = state.metricsSort;
  if (!key || !dir) return rows;
  return [...rows].sort((a, b) => {
    const diff = (Number(a[key]) || 0) - (Number(b[key]) || 0);
    return dir === 'asc' ? diff : -diff;
  });
}

function metricCell(value) {
  const number = Math.max(0, Math.min(1, Number(value) || 0));
  return `<td class="metric-cell"><span class="metric-value">${number.toFixed(4)}</span><div class="metric-bar"><span style="width:${number * 100}%"></span></div></td>`;
}

function aspirationCell(value) {
  if (value === null || value === undefined || value === '') return '<td class="metric-cell aspiration-cell"><span class="metric-value metric-value--muted">—</span></td>';
  const number = Math.max(1, Math.min(5, Number(value)));
  const pct = ((number - 1) / 4) * 100;
  return `<td class="metric-cell aspiration-cell"><span class="metric-value">${number.toFixed(1)}</span><div class="metric-bar"><span style="width:${pct}%"></span></div></td>`;
}

function brandsForRow(row) {
  return [1, 2, 3, 4, 5].map(rank => row[`brand_${rank}`]).filter(Boolean);
}

function filterObservationRows(prefix, rows) {
  const category = $(`${prefix}-category-filter`).value;
  const model = $(`${prefix}-model-filter`).value;
  const condition = $(`${prefix}-condition-filter`).value;
  const theme = $(`${prefix}-theme-filter`).value;
  const query = $(`${prefix}-text-filter`).value.trim().toLowerCase();
  return rows.filter(row => {
    const searchable = prefix === 'reason'
      ? [...brandsForRow(row), ...[1, 2, 3, 4, 5].map(rank => row[`reason_${rank}`] || '')].join(' ')
      : [row.prompt, row.response_text, ...brandsForRow(row)].join(' ');
    return (
      (!category || row.sub_category === category) &&
      (!model || row.model_id === model) &&
      (!condition || row.prompt_condition === condition) &&
      (!theme || row.theme === theme) &&
      (!query || searchable.toLowerCase().includes(query))
    );
  });
}

function renderRawTable() {
  const rows = filterObservationRows('raw', state.lastResults?.results || []);
  const shown = rows.slice(0, 250);
  $('raw-results-count').textContent = `${formatInteger(rows.length)} responses match · showing ${formatInteger(shown.length)}`;
  $('raw-table-body').innerHTML = shown.length ? shown.map(row => `
    <tr>
      <td>${escapeHtml(shortModelId(row.model_id))}</td>
      <td>${escapeHtml(titleCase(row.sub_category))}</td>
      <td>${escapeHtml(conditionLabel(row.prompt_condition))}</td>
      <td>${escapeHtml(truncate(row.prompt, 180))}</td>
      <td>${brandsForRow(row).map(escapeHtml).join(' · ') || '—'}</td>
      <td><details><summary>View response</summary><pre>${escapeHtml(row.response_text || '')}</pre></details></td>
    </tr>
  `).join('') : '<tr><td colspan="6">No raw responses match these filters.</td></tr>';
}

function reasonRows() {
  const output = [];
  for (const row of (state.lastResults?.results || [])) {
    for (let rank = 1; rank <= 5; rank += 1) {
      const brand = row[`brand_${rank}`];
      if (!brand) continue;
      output.push({
        model_id: row.model_id,
        sub_category: row.sub_category,
        prompt_condition: row.prompt_condition,
        theme: row.theme || '',
        prompt_id: row.prompt_id || '',
        replicate: row.replicate || row.repeat_index || '',
        brand,
        rank,
        reason: row[`reason_${rank}`] || '',
        status: row.reason_status || 'not requested',
      });
    }
  }
  return output;
}

function renderReasonsTable() {
  const rows = filterObservationRows('reason', state.lastResults?.results || []);
  const shown = rows.slice(0, 50);
  $('reason-results-count').textContent = `${formatInteger(rows.length)} response groups match · showing ${formatInteger(shown.length)}`;
  $('reasons-table-body').innerHTML = shown.length ? shown.map((row, index) => {
    const reasons = [1, 2, 3, 4, 5].map(rank => ({
      rank,
      brand: row[`brand_${rank}`] || '',
      reason: row[`reason_${rank}`] || '',
    })).filter(item => item.brand);
    const status = row.reason_status || 'not requested';
    const promptLabel = row.prompt_id || (row.prompt_condition === 'context-free' ? 'Context-free request' : 'Needs-based request');
    const replicate = row.replicate || row.repeat_index || '—';
    return `
      <tr class="reason-group-summary">
        <td colspan="4">
          <span class="reason-response-kicker">Response group ${index + 1}</span>
          <strong>${escapeHtml(shortModelId(row.model_id))} · ${escapeHtml(titleCase(row.sub_category))}</strong>
          <small>${escapeHtml(conditionLabel(row.prompt_condition))}${row.theme ? ` · ${escapeHtml(titleCase(row.theme))}` : ''} · ${escapeHtml(promptLabel)} · replicate ${escapeHtml(replicate)}</small>
          <span class="reason-together"><b>Recommended together:</b> ${brandsForRow(row).map(escapeHtml).join(' · ') || '—'}</span>
          <details><summary>View original prompt</summary><p>${escapeHtml(row.prompt || '—')}</p></details>
        </td>
      </tr>
      ${reasons.map((item, reasonIndex) => `<tr class="reason-group-row ${reasonIndex === reasons.length - 1 ? 'is-end' : ''}"><td>${item.rank}</td><td><strong>${escapeHtml(item.brand)}</strong></td><td>${escapeHtml(item.reason || '—')}</td><td><span class="reason-status ${status === 'completed' ? 'is-complete' : 'is-error'}">${escapeHtml(titleCase(status))}</span></td></tr>`).join('')}
      <tr class="reason-group-spacer" aria-hidden="true"><td colspan="4"></td></tr>`;
  }).join('') : '<tr><td colspan="4">No reason groups match these filters.</td></tr>';
}

function switchResultTab(tab) {
  $$('.result-tab').forEach(button => button.classList.toggle('is-active', button.dataset.resultTab === tab));
  $$('[data-result-panel]').forEach(panel => panel.classList.toggle('is-hidden', panel.dataset.resultPanel !== tab));
}

function toggleDownloadMenu() {
  const popover = $('download-popover');
  popover.classList.toggle('is-hidden');
  $('download-menu-btn').setAttribute('aria-expanded', String(!popover.classList.contains('is-hidden')));
}

function exportArtifact(type) {
  if (!state.lastResults) return toast('Run results are not available yet.', 'error');
  const results = state.lastResults.results || [];
  const config = state.lastResults.config || {};
  if (type === 'metrics') return downloadCSV('metrics.csv', state.lastResults.metrics || []);
  if (type === 'theme-metrics') return downloadCSV('metrics_by_theme.csv', state.lastResults.metricsByTheme || []);
  if (type === 'raw') return downloadCSV('raw_results.csv', results);
  if (type === 'cleaned') return downloadCSV('cleaned_results.csv', results.map(cleanResultRow));
  if (type === 'reasons') return downloadCSV('brand_reasons.csv', reasonRows());
  if (type === 'prompts') return downloadCSV('prompt_library.csv', promptCsvRows(state.lastResults.prompts || state.prompts));
  if (type === 'config') return downloadBlob('run_configuration.json', JSON.stringify({ ...config, counts: state.lastResults.counts }, null, 2), 'application/json');
  if (type === 'quality') return downloadBlob('quality_report.txt', qualityReport(state.lastResults), 'text/plain');
}

function cleanResultRow(row) {
  const { extracted_brands, ...clean } = row;
  return clean;
}

function qualityReport(data) {
  const c = data.completeness || {};
  return [
    'LLM Brand Recommendation Experiment — Quality Report',
    `Run ID: ${data.runId}`,
    `Status: ${data.status}`,
    `Protocol: ${data.config?.protocolMode}`,
    `Recommendations: ${c.successfulRecommendations || 0} / ${c.expectedRecommendations || 0}`,
    `Reason follow-ups: ${c.completedReasons || 0} / ${c.expectedReasons || 0}`,
    `Errors: ${(data.errors || []).length}`,
    `Complete dataset: ${c.complete ? 'yes' : 'no'}`,
    '',
    ...(data.errors || []).map(error => `- ${error.stage || 'run'} · ${error.model_id || ''} · ${error.prompt_id || ''}: ${error.message}`),
  ].join('\n');
}

function resumeRunFromSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('brandLabRun') || 'null');
    if (!saved?.runId || !saved?.runToken) return false;
    state.currentRunId = saved.runId;
    state.currentRunToken = saved.runToken;
    pollExperiment();
    return true;
  } catch (_) {
    sessionStorage.removeItem('brandLabRun');
    return false;
  }
}

function showExecutionPanel() {
  $('execution-panel').classList.remove('is-hidden');
}

function setRunButtonsDisabled(disabled) {
  $('run-experiment-btn').disabled = disabled;
  $('mobile-run-btn').disabled = disabled;
}

function runTokenHeaders() {
  return { 'X-Run-Token': state.currentRunToken };
}

function statusTitle(status, stage) {
  if (status === 'completed') return 'Dataset complete';
  if (status === 'incomplete') return 'Run finished with gaps';
  if (status === 'cancelled') return 'Run cancelled';
  if (status === 'interrupted') return 'Run interrupted';
  if (status === 'failed') return 'Run failed';
  if (status === 'cancelling') return 'Stopping experiment';
  const labels = { 'context-free': 'Running context-free observations', 'needs-based': 'Running needs-based observations', reasons: 'Collecting reasons' };
  return labels[stage] || 'Running experiment';
}

function promptCsvRows(prompts) {
  return prompts.map(prompt => ({
    category: prompt.category,
    sub_category: prompt.sub_category,
    prompt_condition: prompt.prompt_condition,
    theme: prompt.theme,
    prompt_id: prompt.prompt_id,
    prompt: prompt.prompt,
  }));
}

function downloadCSV(filename, rows) {
  if (!rows.length) return toast('There are no rows to download.', 'error');
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const csv = [headers.map(csvEscape).join(','), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(','))].join('\n');
  downloadBlob(filename, `${csv}\n`, 'text/csv;charset=utf-8');
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  $('download-popover').classList.add('is-hidden');
}

function csvEscape(value) {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toast(message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;
  element.textContent = message;
  $('toast-region').appendChild(element);
  setTimeout(() => element.remove(), 5000);
}

function integerValue(id, fallback) {
  const number = Number.parseInt($(id).value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function numberValue(id, fallback) {
  const number = Number($(id).value);
  return Number.isFinite(number) ? number : fallback;
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatInteger(value) { return Number(value || 0).toLocaleString('en-US'); }
function formatNumber(value, digits = 2) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : '—'; }
function conditionLabel(value) { return value === 'context-free' ? 'Context-free' : value === 'needs-based-general' ? 'Needs · general' : value === 'needs-based-detailed' ? 'Needs · detailed' : value || '—'; }
function shortModelName(value) { return String(value || '').replace(/^OpenAI\s+|^Google\s+|^Anthropic\s+/, ''); }
function shortModelId(value) { return String(value || '').replace(/^gemini-/, 'Gemini ').replace(/^claude-/, 'Claude ').replace(/^gpt-/, 'GPT-'); }
function titleCase(value) { return String(value || '').replace(/\b\w/g, letter => letter.toUpperCase()); }
function truncate(value, length) { const text = String(value || ''); return text.length > length ? `${text.slice(0, length)}…` : text; }
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
