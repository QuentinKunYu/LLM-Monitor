const API = '';
const state = { lastResults: null };

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireEvents();
  try {
    state.lastResults = await loadResults();
    populateFilters(state.lastResults);
    renderMetricsTable();
    renderRawTable();
    renderReasonsTable();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadResults() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('brandLabRun') || 'null');
    if (saved?.runId && saved?.runToken) {
      const response = await fetch(`${API}/api/experiments/${saved.runId}/results`, {
        headers: { 'X-Run-Token': saved.runToken },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.results?.length) return data;
      }
    }
  } catch (_) {
    // Fall back to the existing full dataset.
  }

  const response = await fetch(`${API}/api/archive/results`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Results could not be loaded.');
  return data;
}

function wireEvents() {
  document.addEventListener('input', handleFilterInput);
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-result-tab]');
    if (tab) switchResultTab(tab.dataset.resultTab);
    const exportButton = event.target.closest('[data-export]');
    if (exportButton) exportArtifact(exportButton.dataset.export);
    if (event.target.closest('#download-menu-btn')) toggleDownloadMenu();
    if (!event.target.closest('.download-menu')) $('download-popover').classList.add('is-hidden');
  });
}

function handleFilterInput(event) {
  if (event.target.matches('#result-analysis-level, #result-category-filter, #result-model-filter, #result-condition-filter, #result-theme-filter, #result-brand-filter')) {
    if (event.target.id === 'result-category-filter') populateMetricThemes();
    renderMetricsTable();
  }
  if (event.target.matches('#raw-category-filter, #raw-model-filter, #raw-condition-filter, #raw-theme-filter, #raw-text-filter')) {
    if (event.target.id === 'raw-category-filter') populateObservationThemes('raw');
    renderRawTable();
  }
  if (event.target.matches('#reason-category-filter, #reason-model-filter, #reason-condition-filter, #reason-theme-filter, #reason-text-filter')) {
    if (event.target.id === 'reason-category-filter') populateObservationThemes('reason');
    renderReasonsTable();
  }
}

function populateFilters(data) {
  const metrics = data.metrics || [];
  const rows = data.results || [];
  populateSelect('result-category-filter', unique(metrics, 'sub_category'), 'All categories', titleCase);
  populateSelect('result-model-filter', unique(metrics, 'model_id'), 'All models', shortModelId);
  populateSelect('result-condition-filter', unique(metrics, 'prompt_condition'), 'All conditions', conditionLabel);
  populateMetricThemes();
  populateObservationFilters('raw', rows);
  populateObservationFilters('reason', rows);
}

function unique(rows, field) {
  return [...new Set(rows.map(row => row[field]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function populateSelect(id, values, allLabel, labelFor = value => value) {
  const select = $(id);
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelFor(value))}</option>`).join('')}`;
  if (values.includes(current)) select.value = current;
}

function populateMetricThemes() {
  const category = $('result-category-filter').value;
  const rows = state.lastResults?.metricsByTheme || [];
  const themes = [...new Set(rows
    .filter(row => !category || row.sub_category === category)
    .map(row => row.theme)
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  populateSelect('result-theme-filter', themes, 'All themes', titleCase);
}

function populateObservationFilters(prefix, rows) {
  populateSelect(`${prefix}-category-filter`, unique(rows, 'sub_category'), 'All categories', titleCase);
  populateSelect(`${prefix}-model-filter`, unique(rows, 'model_id'), 'All models', shortModelId);
  populateSelect(`${prefix}-condition-filter`, unique(rows, 'prompt_condition'), 'All conditions', conditionLabel);
  populateObservationThemes(prefix);
}

function populateObservationThemes(prefix) {
  const category = $(`${prefix}-category-filter`).value;
  const rows = state.lastResults?.results || [];
  const themes = [...new Set(rows
    .filter(row => (!category || row.sub_category === category) && row.theme)
    .map(row => row.theme))].sort((a, b) => String(a).localeCompare(String(b)));
  populateSelect(`${prefix}-theme-filter`, themes, 'All themes', titleCase);
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
  $('result-group-heading').textContent = analysisLevel === 'theme' ? 'Theme' : 'Grouping';
  $('metrics-table-body').innerHTML = filtered.length ? filtered.slice(0, 500).map(row => `
    <tr class="${row.provisional ? 'provisional-row' : ''}">
      <td>${escapeHtml(row.brand)}</td>
      <td>${escapeHtml(titleCase(row.sub_category))}</td>
      <td title="${escapeHtml(row.model_id)}">${escapeHtml(shortModelId(row.model_id))}</td>
      <td>${escapeHtml(conditionLabel(row.prompt_condition))}</td>
      <td>${escapeHtml(analysisLevel === 'theme' ? row.theme : 'Overall')}</td>
      ${metricCell(row['BRP@1'])}${metricCell(row['BRP@3'])}${metricCell(row['BRP@5'])}${metricCell(row.MRR)}
      <td>${escapeHtml(row.denominator || row.n_replicates)}${row.provisional ? ' / provisional' : ''}</td>
    </tr>
  `).join('') : '<tr><td colspan="10">No metric rows match these filters.</td></tr>';
}

function metricCell(value) {
  const number = Math.max(0, Math.min(1, Number(value) || 0));
  return `<td class="metric-cell"><span class="metric-value">${number.toFixed(4)}</span><div class="metric-bar"><span style="width:${number * 100}%"></span></div></td>`;
}

function brandsForRow(row) {
  return [1, 2, 3, 4, 5].map(rank => row[`brand_${rank}`]).filter(Boolean);
}

function filterObservationRows(prefix) {
  const rows = state.lastResults?.results || [];
  const category = $(`${prefix}-category-filter`).value;
  const model = $(`${prefix}-model-filter`).value;
  const condition = $(`${prefix}-condition-filter`).value;
  const theme = $(`${prefix}-theme-filter`).value;
  const query = $(`${prefix}-text-filter`).value.trim().toLowerCase();
  return rows.filter(row => {
    const searchable = prefix === 'reason'
      ? [...brandsForRow(row), ...[1, 2, 3, 4, 5].map(rank => row[`reason_${rank}`] || '')].join(' ')
      : [row.prompt, row.response_text, ...brandsForRow(row)].join(' ');
    return (!category || row.sub_category === category) &&
      (!model || row.model_id === model) &&
      (!condition || row.prompt_condition === condition) &&
      (!theme || row.theme === theme) &&
      (!query || searchable.toLowerCase().includes(query));
  });
}

function renderRawTable() {
  const rows = filterObservationRows('raw');
  const shown = rows.slice(0, 250);
  $('raw-results-count').textContent = `${formatInteger(rows.length)} responses match · showing ${formatInteger(shown.length)}`;
  $('raw-table-body').innerHTML = shown.length ? shown.map(row => `
    <tr><td>${escapeHtml(shortModelId(row.model_id))}</td><td>${escapeHtml(titleCase(row.sub_category))}</td><td>${escapeHtml(conditionLabel(row.prompt_condition))}</td><td>${escapeHtml(truncate(row.prompt, 180))}</td><td>${brandsForRow(row).map(escapeHtml).join(' · ') || '—'}</td><td><details><summary>View response</summary><pre>${escapeHtml(row.response_text || '')}</pre></details></td></tr>
  `).join('') : '<tr><td colspan="6">No raw responses match these filters.</td></tr>';
}

function reasonRows() {
  const output = [];
  for (const row of (state.lastResults?.results || [])) {
    for (let rank = 1; rank <= 5; rank += 1) {
      const brand = row[`brand_${rank}`];
      if (!brand) continue;
      output.push({
        model_id: row.model_id, sub_category: row.sub_category,
        prompt_condition: row.prompt_condition, theme: row.theme || '',
        prompt_id: row.prompt_id || '', replicate: row.replicate || row.repeat_index || '',
        brand, rank, reason: row[`reason_${rank}`] || '',
        status: row.reason_status || 'not requested',
      });
    }
  }
  return output;
}

function renderReasonsTable() {
  const rows = filterObservationRows('reason');
  const shown = rows.slice(0, 50);
  $('reason-results-count').textContent = `${formatInteger(rows.length)} response groups match · showing ${formatInteger(shown.length)}`;
  $('reasons-table-body').innerHTML = shown.length ? shown.map((row, index) => {
    const reasons = [1, 2, 3, 4, 5].map(rank => ({ rank, brand: row[`brand_${rank}`] || '', reason: row[`reason_${rank}`] || '' })).filter(item => item.brand);
    const status = row.reason_status || 'not requested';
    const promptLabel = row.prompt_id || (row.prompt_condition === 'context-free' ? 'Context-free request' : 'Needs-based request');
    const replicate = row.replicate || row.repeat_index || '—';
    return `
      <tr class="reason-group-summary"><td colspan="4"><span class="reason-response-kicker">Response group ${index + 1}</span><strong>${escapeHtml(shortModelId(row.model_id))} · ${escapeHtml(titleCase(row.sub_category))}</strong><small>${escapeHtml(conditionLabel(row.prompt_condition))}${row.theme ? ` · ${escapeHtml(titleCase(row.theme))}` : ''} · ${escapeHtml(promptLabel)} · replicate ${escapeHtml(replicate)}</small><span class="reason-together"><b>Recommended together:</b> ${brandsForRow(row).map(escapeHtml).join(' · ') || '—'}</span><details><summary>View original prompt</summary><p>${escapeHtml(row.prompt || '—')}</p></details></td></tr>
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
  const results = state.lastResults?.results || [];
  const config = state.lastResults?.config || {};
  if (type === 'metrics') return downloadCSV('metrics.csv', state.lastResults.metrics || []);
  if (type === 'theme-metrics') return downloadCSV('metrics_by_theme.csv', state.lastResults.metricsByTheme || []);
  if (type === 'raw') return downloadCSV('raw_results.csv', results);
  if (type === 'cleaned') return downloadCSV('cleaned_results.csv', results.map(cleanResultRow));
  if (type === 'reasons') return downloadCSV('brand_reasons.csv', reasonRows());
  if (type === 'prompts') return downloadCSV('prompt_library.csv', promptCsvRows(state.lastResults.prompts || []));
  if (type === 'config') return downloadBlob('run_configuration.json', JSON.stringify({ ...config, counts: state.lastResults.counts }, null, 2), 'application/json');
  if (type === 'quality') return downloadBlob('quality_report.txt', qualityReport(state.lastResults), 'text/plain');
}

function cleanResultRow(row) { const { extracted_brands, ...clean } = row; return clean; }
function promptCsvRows(prompts) { return prompts.map(({ category, sub_category, prompt_condition, theme, prompt_id, prompt }) => ({ category, sub_category, prompt_condition, theme, prompt_id, prompt })); }
function qualityReport(data) {
  const c = data.completeness || {};
  return ['LLM Brand Recommendation Experiment — Quality Report', `Run ID: ${data.runId}`, `Status: ${data.status}`, `Protocol: ${data.config?.protocolMode}`, `Recommendations: ${c.successfulRecommendations || 0} / ${c.expectedRecommendations || 0}`, `Reason follow-ups: ${c.completedReasons || 0} / ${c.expectedReasons || 0}`, `Errors: ${(data.errors || []).length}`, `Complete dataset: ${c.complete ? 'yes' : 'no'}`].join('\n');
}

function downloadCSV(filename, rows) {
  if (!rows.length) return toast('There are no rows to download.', 'error');
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const csv = [headers.map(csvEscape).join(','), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(','))].join('\n');
  downloadBlob(filename, `${csv}\n`, 'text/csv;charset=utf-8');
}
function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  $('download-popover').classList.add('is-hidden');
}
function csvEscape(value) { const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? ''); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function toast(message, type = 'info') { const el = document.createElement('div'); el.className = `toast toast--${type}`; el.textContent = message; $('toast-region').appendChild(el); setTimeout(() => el.remove(), 5000); }
function formatInteger(value) { return Number(value || 0).toLocaleString('en-US'); }
function conditionLabel(value) { return value === 'context-free' ? 'Context-free' : value === 'needs-based-general' ? 'Needs · general' : value === 'needs-based-detailed' ? 'Needs · detailed' : value || '—'; }
function shortModelId(value) { return String(value || '').replace(/^gemini-/, 'Gemini ').replace(/^claude-/, 'Claude ').replace(/^gpt-/, 'GPT-'); }
function titleCase(value) { return String(value || '').replace(/\b\w/g, letter => letter.toUpperCase()); }
function truncate(value, length) { const text = String(value || ''); return text.length > length ? `${text.slice(0, length)}…` : text; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
