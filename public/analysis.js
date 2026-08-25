const API = '';
const state = { lastResults: null, metricsSort: { key: null, dir: null }, aspirationScores: new Map(), resultSource: null, predictorData: null };

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireEvents();
  try {
    const [results] = await Promise.all([loadResults(), loadAspirationScores(), loadPredictorData()]);
    state.lastResults = results;
    renderResultSourceBadge();
    populateFilters(state.lastResults);
    renderMetricsTable();
    renderRawTable();
    renderReasonsTable();
    renderPredictorSection();
    renderFacetSection();
  } catch (error) {
    toast(error.message, 'error');
  }
}

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

async function loadPredictorData() {
  try {
    const response = await fetch(`${API}/predictor-correlations.json`);
    if (!response.ok) return;
    state.predictorData = await response.json();
  } catch (_) {
    // Real-world predictor correlations are a supplementary layer; missing data shouldn't block the results page.
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

async function loadResults() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('brandLabRun') || 'null');
    if (saved?.runId && saved?.runToken) {
      const response = await fetch(`${API}/api/experiments/${saved.runId}/results`, {
        headers: { 'X-Run-Token': saved.runToken },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.results?.length) {
          state.resultSource = 'new-run';
          return data;
        }
      }
    }
  } catch (_) {
    // Fall back to the existing full dataset.
  }

  const response = await fetch(`${API}/api/archive/results`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Results could not be loaded.');
  state.resultSource = 'existing';
  return data;
}

// Shows which dataset is currently on screen (a run just started on this device vs.
// the existing/archived dataset), and offers a one-click way to flip between them
// when both are available.
function renderResultSourceBadge() {
  const badge = $('result-source-badge');
  const switchLink = $('result-source-switch');
  if (!badge || !switchLink) return;

  const saved = JSON.parse(sessionStorage.getItem('brandLabRun') || 'null');
  const hasSavedRun = Boolean(saved?.runId && saved?.runToken);

  if (state.resultSource === 'new-run') {
    badge.textContent = 'New run result';
    badge.dataset.source = 'new-run';
  } else {
    badge.textContent = 'Existing dataset result';
    badge.dataset.source = 'existing';
  }
  badge.classList.remove('is-hidden');

  if (state.resultSource === 'new-run') {
    switchLink.textContent = 'View existing dataset result instead';
    switchLink.classList.remove('is-hidden');
    switchLink.onclick = () => switchResultSource('existing');
  } else if (hasSavedRun) {
    switchLink.textContent = 'View your new run result instead';
    switchLink.classList.remove('is-hidden');
    switchLink.onclick = () => switchResultSource('new-run');
  } else {
    switchLink.classList.add('is-hidden');
    switchLink.onclick = null;
  }
}

async function switchResultSource(target) {
  try {
    let data;
    if (target === 'existing') {
      const response = await fetch(`${API}/api/archive/results`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Results could not be loaded.');
      state.resultSource = 'existing';
    } else {
      const saved = JSON.parse(sessionStorage.getItem('brandLabRun') || 'null');
      if (!saved?.runId || !saved?.runToken) return;
      const response = await fetch(`${API}/api/experiments/${saved.runId}/results`, {
        headers: { 'X-Run-Token': saved.runToken },
      });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Results could not be loaded.');
      state.resultSource = 'new-run';
    }
    state.lastResults = data;
    renderResultSourceBadge();
    populateFilters(state.lastResults);
    renderMetricsTable();
    renderRawTable();
    renderReasonsTable();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function wireEvents() {
  document.addEventListener('input', handleFilterInput);
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-result-tab]');
    if (tab) switchResultTab(tab.dataset.resultTab);
    const exportButton = event.target.closest('[data-export]');
    if (exportButton) exportArtifact(exportButton.dataset.export);
    const sortButton = event.target.closest('[data-sort-key]');
    if (sortButton) toggleMetricsSort(sortButton.dataset.sortKey);
    if (event.target.closest('#download-menu-btn')) toggleDownloadMenu();
    if (!event.target.closest('.download-menu')) $('download-popover').classList.add('is-hidden');
  });
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
  const sorted = sortMetricsRows(withAspiration(filtered));
  $('metrics-table-body').innerHTML = sorted.length ? sorted.slice(0, 500).map(row => `
    <tr class="${row.provisional ? 'provisional-row' : ''}">
      <td>${escapeHtml(row.brand)}</td>
      <td>${escapeHtml(titleCase(row.sub_category))}</td>
      <td title="${escapeHtml(row.model_id)}">${escapeHtml(shortModelId(row.model_id))}</td>
      <td>${escapeHtml(conditionLabel(row.prompt_condition))}</td>
      <td>${escapeHtml(analysisLevel === 'theme' ? row.theme : 'Overall')}</td>
      ${metricCell(row['BRP@1'])}${metricCell(row['BRP@3'])}${metricCell(row['BRP@5'])}${metricCell(row.MRR)}
      <td>${escapeHtml(row.denominator || row.n_replicates)}${row.provisional ? ' / provisional' : ''}</td>
      ${aspirationCell(row.aspiration_e)}${aspirationCell(row.aspiration_s)}${aspirationCell(row.aspiration_ed)}${aspirationCell(row.aspiration_avg)}
    </tr>
  `).join('') : '<tr><td colspan="14">No metric rows match these filters.</td></tr>';
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

const PREDICTOR_OUTCOME_LABELS = {
  cf_BRP5: 'context-free BRP@5', cf_MRR: 'context-free MRR',
  nb_BRP5: 'needs-based BRP@5', nb_MRR: 'needs-based MRR',
};
const DEFAULT_PREDICTOR_X = 'log_Google Trends (Brand + Cat)';
let predictorBrandFilterWired = false;
let predictorControlsWired = false;
const predictorState = { x: DEFAULT_PREDICTOR_X };

// Aspiration Score (1-5) bucketed the same way as the reference chart: brands scoring
// 2.5 or below are "Low", 3-3.5 is "Mid", 4+ is "High", and unmatched brands are "N/A".
const ASPIRATION_BUCKET_LABEL = { low: 'Low', mid: 'Mid', high: 'High', na: 'N/A' };
function aspirationBucket(avg) {
  if (avg == null) return 'na';
  if (avg <= 2.5) return 'low';
  if (avg <= 3.5) return 'mid';
  return 'high';
}

// BrandZ Salient score drives dot size (area-proportional, like the reference bubble chart).
// Brands BrandZ doesn't track show as an X mark instead of a dot, sized at the bottom of the range.
function salienceDomain() {
  const values = (state.predictorData?.brands || []).map(b => b.brandz_salient).filter(v => v != null);
  if (!values.length) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

function salienceRadius(value, [min, max], [rMin, rMax]) {
  if (value == null || max <= min) return rMin;
  const t = (value - min) / (max - min);
  const areaMin = rMin * rMin, areaMax = rMax * rMax;
  return Math.sqrt(areaMin + t * (areaMax - areaMin));
}

// Builds one bubble (circle) or, for brands with no BrandZ Salient score, an X mark —
// both colored by Aspiration Score bucket. Kept as a single helper so the two scatter
// views (single chart + by-category facets) render markers identically.
function brandMarkerSvg(b, x, y, radiusRange, tip) {
  const bucket = aspirationBucket(b.aspiration_avg);
  const hasSalience = b.brandz_salient != null;
  const r = salienceRadius(b.brandz_salient, salienceDomain(), radiusRange);
  const cls = `predictor-dot predictor-dot--${bucket}`;
  if (hasSalience) {
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" class="${cls}" tabindex="0" data-tip="${escapeHtml(tip)}"></circle>`;
  }
  const s = r * 0.85;
  return `<g class="${cls} predictor-x-mark" tabindex="0" data-tip="${escapeHtml(tip)}">
    <line x1="${(x - s).toFixed(1)}" y1="${(y - s).toFixed(1)}" x2="${(x + s).toFixed(1)}" y2="${(y + s).toFixed(1)}"></line>
    <line x1="${(x - s).toFixed(1)}" y1="${(y + s).toFixed(1)}" x2="${(x + s).toFixed(1)}" y2="${(y - s).toFixed(1)}"></line>
  </g>`;
}

function brandTip(b, yKey, includeCategory) {
  const yLabel = yKey.endsWith('BRP5') ? `${Math.round(b[yKey] * 100)}%` : b[yKey].toFixed(3);
  const asp = b.aspiration_avg != null ? `${ASPIRATION_BUCKET_LABEL[aspirationBucket(b.aspiration_avg)]} (${b.aspiration_avg.toFixed(1)})` : 'N/A';
  const sal = b.brandz_salient != null ? b.brandz_salient.toFixed(0) : 'no BrandZ data';
  const parts = [b.brand];
  if (includeCategory) parts.push(titleCase(b.sub_category));
  parts.push(`${PREDICTOR_OUTCOME_LABELS[yKey] || yKey} ${yLabel}`, `aspiration ${asp}`, `salience ${sal}`);
  return parts.join(' · ');
}

function renderPredictorLegend(containerId) {
  const el = $(containerId);
  if (!el) return;
  const [min, max] = salienceDomain();
  const mid = Math.round((min + max) / 2);
  const sizeFor = v => (salienceRadius(v, [min, max], [7, 20]) * 2).toFixed(0);
  el.innerHTML = `
    <div class="predictor-legend-group">
      <span class="predictor-legend-title">Aspiration Score</span>
      ${['low', 'mid', 'high', 'na'].map(bucket => `<span class="predictor-legend-item"><i class="predictor-legend-swatch predictor-dot--${bucket}"></i>${ASPIRATION_BUCKET_LABEL[bucket]}${bucket === 'low' ? ' (≤2.5)' : bucket === 'mid' ? ' (3–3.5)' : bucket === 'high' ? ' (≥4)' : ''}</span>`).join('')}
    </div>
    <div class="predictor-legend-group">
      <span class="predictor-legend-title">BrandZ Salient</span>
      <span class="predictor-legend-item"><span class="predictor-legend-size" style="width:${sizeFor(min)}px;height:20px"><i style="width:${sizeFor(min)}px;height:${sizeFor(min)}px"></i></span>${min.toFixed(0)}</span>
      <span class="predictor-legend-item"><span class="predictor-legend-size" style="width:${sizeFor(mid)}px;height:20px"><i style="width:${sizeFor(mid)}px;height:${sizeFor(mid)}px"></i></span>${mid}</span>
      <span class="predictor-legend-item"><span class="predictor-legend-size" style="width:${sizeFor(max)}px;height:20px"><i style="width:${sizeFor(max)}px;height:${sizeFor(max)}px"></i></span>${max.toFixed(0)}</span>
      <span class="predictor-legend-item"><span class="predictor-legend-x">✕</span>no BrandZ data</span>
    </div>`;
}

function renderPredictorSection() {
  const panel = document.querySelector('[data-result-panel="predictors"]');
  if (!panel) return;
  if (!state.predictorData) {
    panel.innerHTML = '<p class="filter-result-count">Real-world brand signal data is not available for this dataset.</p>';
    return;
  }
  populatePredictorXSelect();
  renderPredictorLegend('predictor-legend');
  renderPredictorScatter();
  renderPredictorTable();
  renderPredictorMethodology();
  renderPredictorBrandTable();
  if (!predictorControlsWired) {
    $('predictor-x-select')?.addEventListener('change', event => {
      predictorState.x = event.target.value;
      renderPredictorScatter();
      renderPredictorTable();
    });
    $('predictor-outcome-select')?.addEventListener('change', () => {
      renderPredictorScatter();
      renderPredictorTable();
    });
    $('predictor-table-body')?.addEventListener('click', event => {
      const row = event.target.closest('tr[data-predictor-key]');
      if (!row) return;
      predictorState.x = row.dataset.predictorKey;
      $('predictor-x-select').value = predictorState.x;
      renderPredictorScatter();
      renderPredictorTable();
    });
    $('predictor-brand-filter')?.addEventListener('input', renderPredictorBrandTable);
    predictorControlsWired = true;
    predictorBrandFilterWired = true;
  }
}

function predictorFor(key) {
  return state.predictorData.predictors.find(p => p.key === key);
}

function formatPValue(p) {
  if (p === null || p === undefined) return '—';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

function populatePredictorXSelect() {
  const select = $('predictor-x-select');
  if (!select || select.options.length) return;
  select.innerHTML = state.predictorData.predictors
    .map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('');
  select.value = predictorState.x;
}

function renderPredictorScatter() {
  const container = $('predictor-scatter');
  if (!container) return;
  const xKey = predictorState.x;
  const yKey = $('predictor-outcome-select')?.value || 'cf_BRP5';
  const xPred = predictorFor(xKey);
  if (!xPred) { container.innerHTML = '<p class="filter-result-count">No data available.</p>'; return; }

  const brands = state.predictorData.brands.filter(b => b.values?.[xKey] != null && b[yKey] != null);
  const titleEl = $('predictor-chart-title');
  const subtitleEl = $('predictor-chart-subtitle');
  if (titleEl) titleEl.textContent = `${xPred.label} vs. ${PREDICTOR_OUTCOME_LABELS[yKey] || yKey}`;
  if (subtitleEl) subtitleEl.textContent = `Each marker is one of ${brands.length} brands with matching data — color is Aspiration Score, size is BrandZ Salient (✕ = no BrandZ data). Hover for details.`;

  if (!brands.length) { container.innerHTML = '<p class="filter-result-count">No overlapping data for this combination.</p>'; return; }

  const stat = xPred.outcomes?.[yKey];
  const xValue = b => xPred.is_log ? Math.log1p(b.values[xKey]) : b.values[xKey];

  const W = 760, H = 420, M = { top: 20, right: 20, bottom: 46, left: 56 };
  const xs = brands.map(xValue);
  const ys = brands.map(b => b[yKey]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xPad = (xMax - xMin) * 0.06 || 1;
  const yMin = Math.min(0, ...ys), yMax = Math.max(...ys, 0.0001);
  const yPad = (yMax - yMin) * 0.06 || 0.01;
  const xScale = v => M.left + (v - (xMin - xPad)) / ((xMax + xPad) - (xMin - xPad)) * (W - M.left - M.right);
  const yScale = v => H - M.bottom - (v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad)) * (H - M.top - M.bottom);
  const yIsRate = yKey.endsWith('BRP5');

  const gridCount = 5;
  const gridLines = Array.from({ length: gridCount }, (_, i) => yMin + (i / (gridCount - 1)) * (yMax - yMin)).map(g => `
    <line x1="${M.left}" x2="${W - M.right}" y1="${yScale(g).toFixed(1)}" y2="${yScale(g).toFixed(1)}" class="predictor-gridline"></line>
    <text x="${M.left - 10}" y="${(yScale(g) + 4).toFixed(1)}" class="predictor-axis-label" text-anchor="end">${yIsRate ? Math.round(g * 100) + '%' : g.toFixed(2)}</text>
  `).join('');

  const points = brands.map(b => {
    const x = xScale(xValue(b));
    const y = yScale(b[yKey]);
    return brandMarkerSvg(b, x, y, [6, 20], brandTip(b, yKey, true));
  }).join('');

  const xAxisLabel = xPred.is_log ? `log(1 + ${xPred.label.replace(' (log)', '')})` : xPred.label;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter plot of ${escapeHtml(xPred.label)} versus ${escapeHtml(PREDICTOR_OUTCOME_LABELS[yKey] || yKey)}">
      ${gridLines}
      <line x1="${M.left}" x2="${W - M.right}" y1="${(H - M.bottom).toFixed(1)}" y2="${(H - M.bottom).toFixed(1)}" class="predictor-axis"></line>
      ${points}
      <text x="${((M.left + W - M.right) / 2).toFixed(1)}" y="${H - 8}" class="predictor-axis-label" text-anchor="middle">${escapeHtml(xAxisLabel)}</text>
      <text x="14" y="${((M.top + H - M.bottom) / 2).toFixed(1)}" class="predictor-axis-label" text-anchor="middle" transform="rotate(-90 14 ${((M.top + H - M.bottom) / 2).toFixed(1)})">${escapeHtml(PREDICTOR_OUTCOME_LABELS[yKey] || yKey)}</text>
    </svg>
    ${stat ? `<p class="predictor-chart-stat">r = ${stat.r >= 0 ? '+' : ''}${stat.r.toFixed(2)}, p ${formatPValue(stat.p) === '< 0.001' ? '&lt; 0.001' : '= ' + formatPValue(stat.p)}, n = ${stat.n} brands</p>` : ''}
    <div class="predictor-tooltip" id="predictor-tooltip"></div>
  `;
  wirePredictorTooltips(container);
}

function wirePredictorTooltips(container, tooltipId = 'predictor-tooltip') {
  const tooltip = container.querySelector('#' + tooltipId);
  if (!tooltip) return;
  container.querySelectorAll('.predictor-dot').forEach(dot => {
    const show = () => { tooltip.textContent = dot.dataset.tip; tooltip.classList.add('is-visible'); };
    const hide = () => tooltip.classList.remove('is-visible');
    const position = event => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX !== undefined ? event.clientX - rect.left : rect.width / 2;
      const y = event.clientY !== undefined ? event.clientY - rect.top : rect.height / 2;
      tooltip.style.left = `${x + 12}px`;
      tooltip.style.top = `${y + 12}px`;
    };
    dot.addEventListener('mouseenter', event => { show(); position(event); });
    dot.addEventListener('mousemove', position);
    dot.addEventListener('mouseleave', hide);
    dot.addEventListener('focus', event => { show(); position(event); });
    dot.addEventListener('blur', hide);
  });
}

function renderPredictorTable() {
  const select = $('predictor-outcome-select');
  const outcome = select ? select.value : 'cf_BRP5';
  const rows = [...state.predictorData.predictors]
    .filter(p => p.outcomes[outcome]?.r != null)
    .sort((a, b) => Math.abs(b.outcomes[outcome].r) - Math.abs(a.outcomes[outcome].r));
  $('predictor-table-body').innerHTML = rows.length ? rows.map(p => {
    const { r, p: pval, n } = p.outcomes[outcome];
    const sig = pval != null && pval < 0.05;
    const pct = Math.min(100, Math.abs(r) * 100);
    const active = p.key === predictorState.x;
    return `<tr data-predictor-key="${escapeHtml(p.key)}" class="${active ? 'is-active' : ''}" tabindex="0">
      <td>${escapeHtml(p.label)}</td>
      <td class="metric-cell"><span class="metric-value predictor-r-value ${sig ? 'is-significant' : ''}">${r >= 0 ? '+' : ''}${r.toFixed(2)}</span><div class="metric-bar predictor-r-bar"><span class="${sig ? 'is-significant' : ''}" style="width:${pct}%"></span></div></td>
      <td>${n}</td>
      <td>${formatPValue(pval) === '< 0.001' ? '&lt; 0.001' : formatPValue(pval)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4">No signals available for ${escapeHtml(PREDICTOR_OUTCOME_LABELS[outcome] || outcome)}.</td></tr>`;
}

function renderPredictorMethodology() {
  const meta = state.predictorData.meta || {};
  $('predictor-methodology').innerHTML = [meta.source_note, meta.coverage_note, meta.brandwatch_note, meta.method_note, meta.excluded_note]
    .filter(Boolean)
    .map(text => `<p>${escapeHtml(text)}</p>`)
    .join('');
}

function renderPredictorBrandTable() {
  const query = ($('predictor-brand-filter')?.value || '').trim().toLowerCase();
  const all = [...state.predictorData.brands].sort((a, b) =>
    a.sub_category.localeCompare(b.sub_category) || a.brand.localeCompare(b.brand));
  const rows = query
    ? all.filter(b => `${b.brand} ${b.sub_category}`.toLowerCase().includes(query))
    : all;
  const countEl = $('predictor-brand-count');
  if (countEl) countEl.textContent = `${formatInteger(rows.length)} of ${formatInteger(all.length)} brands shown`;
  $('predictor-brand-table-body').innerHTML = rows.length ? rows.map(b => `
    <tr>
      <td>${escapeHtml(titleCase(b.sub_category))}</td>
      <td>${escapeHtml(b.brand)}</td>
      <td>${escapeHtml(titleCase(String(b.visibility_group || '').replace(/_/g, ' ')))}</td>
      <td>${b.cf_BRP5 != null ? (b.cf_BRP5 * 100).toFixed(1) + '%' : '—'}</td>
      <td>${b.nb_BRP5 != null ? (b.nb_BRP5 * 100).toFixed(1) + '%' : '—'}</td>
      <td>${b.awareness_pct != null ? b.awareness_pct.toFixed(1) + '%' : '—'}</td>
      <td>${b.search_volume_brand_cat != null ? Math.round(b.search_volume_brand_cat).toLocaleString('en-US') : '—'}</td>
      <td>${b.brandwatch_mentions_12mo != null ? formatInteger(b.brandwatch_mentions_12mo) : '—'}</td>
      <td>${b.aspiration_avg != null ? b.aspiration_avg.toFixed(1) : '—'}</td>
    </tr>
  `).join('') : '<tr><td colspan="9">No brands match this filter.</td></tr>';
}

let facetControlsWired = false;
const facetState = { x: DEFAULT_PREDICTOR_X };

function renderFacetSection() {
  const panel = document.querySelector('[data-result-panel="by-category"]');
  if (!panel) return;
  if (!state.predictorData) {
    panel.innerHTML = '<p class="filter-result-count">Real-world brand signal data is not available for this dataset.</p>';
    return;
  }
  populateFacetXSelect();
  renderPredictorLegend('predictor-facet-legend');
  renderFacetGrid();
  if (!facetControlsWired) {
    $('predictor-facet-x-select')?.addEventListener('change', event => {
      facetState.x = event.target.value;
      renderFacetGrid();
    });
    $('predictor-facet-y-select')?.addEventListener('change', renderFacetGrid);
    facetControlsWired = true;
  }
}

function populateFacetXSelect() {
  const select = $('predictor-facet-x-select');
  if (!select || select.options.length) return;
  select.innerHTML = state.predictorData.predictors
    .map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('');
  select.value = facetState.x;
}

function renderFacetGrid() {
  const grid = $('predictor-facet-grid');
  if (!grid) return;
  const xKey = facetState.x;
  const yKey = $('predictor-facet-y-select')?.value || 'cf_BRP5';
  const xPred = predictorFor(xKey);
  if (!xPred) { grid.innerHTML = '<p class="filter-result-count">No data available.</p>'; return; }

  const allBrands = state.predictorData.brands.filter(b => b.values?.[xKey] != null && b[yKey] != null);
  if (!allBrands.length) { grid.innerHTML = '<p class="filter-result-count">No overlapping data for this combination.</p>'; return; }

  const xValue = b => xPred.is_log ? Math.log1p(b.values[xKey]) : b.values[xKey];
  const xs = allBrands.map(xValue);
  const ys = allBrands.map(b => b[yKey]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xPad = (xMax - xMin) * 0.08 || 1;
  const yMin = Math.min(0, ...ys), yMax = Math.max(...ys, 0.0001);
  const yPad = (yMax - yMin) * 0.08 || 0.01;
  const yIsRate = yKey.endsWith('BRP5');

  const categories = [...new Set(allBrands.map(b => b.sub_category))].sort((a, b) => a.localeCompare(b));

  const W = 380, H = 280, M = { top: 12, right: 14, bottom: 40, left: 48 };
  const xScale = v => M.left + (v - (xMin - xPad)) / ((xMax + xPad) - (xMin - xPad)) * (W - M.left - M.right);
  const yScale = v => H - M.bottom - (v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad)) * (H - M.top - M.bottom);

  const cards = categories.map(cat => {
    const brands = allBrands.filter(b => b.sub_category === cat);
    const stat = (() => {
      const n = brands.length;
      if (n < 3) return null;
      const xv = brands.map(xValue), yv = brands.map(b => b[yKey]);
      const mx = xv.reduce((a, c) => a + c, 0) / n, my = yv.reduce((a, c) => a + c, 0) / n;
      let num = 0, dx2 = 0, dy2 = 0;
      for (let i = 0; i < n; i++) { const dx = xv[i] - mx, dy = yv[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
      const denom = Math.sqrt(dx2 * dy2);
      return denom ? num / denom : null;
    })();

    const gridLines = [0, 0.5, 1].map(g => {
      const v = yMin + g * (yMax - yMin);
      return `<line x1="${M.left}" x2="${W - M.right}" y1="${yScale(v).toFixed(1)}" y2="${yScale(v).toFixed(1)}" class="predictor-gridline"></line>`;
    }).join('');

    const points = brands.map(b => {
      const x = xScale(xValue(b));
      const y = yScale(b[yKey]);
      return brandMarkerSvg(b, x, y, [4, 13], brandTip(b, yKey, false));
    }).join('');

    return `
      <div class="predictor-facet-card">
        <h4>${escapeHtml(titleCase(cat))} <span style="font-weight:400;color:var(--muted)">(n=${brands.length})</span></h4>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(titleCase(cat))} scatter">
          ${gridLines}
          <line x1="${M.left}" x2="${W - M.right}" y1="${(H - M.bottom).toFixed(1)}" y2="${(H - M.bottom).toFixed(1)}" class="predictor-axis"></line>
          ${points}
        </svg>
        <p class="predictor-chart-stat">${stat != null ? `r = ${stat >= 0 ? '+' : ''}${stat.toFixed(2)}` : 'n too small'}</p>
      </div>`;
  }).join('');

  grid.innerHTML = cards + '<div class="predictor-tooltip" id="predictor-facet-tooltip"></div>';
  wirePredictorTooltips(grid, 'predictor-facet-tooltip');
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
