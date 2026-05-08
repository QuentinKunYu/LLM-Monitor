const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { extractBrands, standardiseBrands, norm } = require('../lib/brand-extractor');
const { calculateMetrics } = require('../lib/metrics');

const exportDir = process.argv[2] || path.join(__dirname, '..', 'data', 'exports', 'study1', 'full_2026-05-05_all_models');
const stateFile = path.join(exportDir, 'state.json');
const rawOut = path.join(exportDir, 'raw_results_cleaned.csv');
const metricsOut = path.join(exportDir, 'metrics_cleaned.csv');
const reportOut = path.join(exportDir, 'quality_report_cleaned.md');

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

function normaliseForIssue(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCSV(filename) {
  return parse(fs.readFileSync(path.join(__dirname, '..', 'config', filename), 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function buildAliasMap() {
  const aliasMap = {};
  for (const row of loadCSV('brand_alias_dictionary.csv')) {
    aliasMap[`${row.category}|${norm(row.alias)}`] = row.standard_brand;
  }
  return aliasMap;
}

function buildFocalIndex() {
  const index = {};
  for (const row of loadCSV('categories_brands.csv')) {
    if (!index[row.sub_category]) index[row.sub_category] = [];
    index[row.sub_category].push({
      brand: row.brand,
      visibility_group: row.visibility_group,
      sub_category: row.sub_category,
    });
  }
  return index;
}

function analyseRows(modelId, subCategory, rows) {
  const issues = [];
  const errorRows = rows.filter(row => String(row.response_text || '').startsWith('[ERROR]'));
  if (errorRows.length) issues.push(`${errorRows.length} API/parser error rows`);

  const blankRows = rows.filter(row => [1, 2, 3, 4, 5].every(k => !row[`brand_${k}`]));
  if (blankRows.length) issues.push(`${blankRows.length} rows have no extracted brands`);

  const brandValues = [];
  for (const row of rows) {
    for (let k = 1; k <= 5; k++) {
      if (row[`brand_${k}`]) brandValues.push(row[`brand_${k}`]);
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
      lower.includes('null')
    );
  }))];
  if (suspicious.length) issues.push(`Suspicious brand strings: ${suspicious.join('; ')}`);

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
  if (spellingVariants.length) {
    issues.push(`Case/accent variants: ${spellingVariants.map(values => values.join(' / ')).join('; ')}`);
  }

  return {
    model_id: modelId,
    sub_category: subCategory,
    completed: rows.length,
    errors: errorRows.length,
    issues,
    errorSamples: errorRows.slice(0, 3).map(row => ({
      replicate: row.replicate,
      error: String(row.response_text || '').slice(0, 300),
    })),
  };
}

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const aliasMap = buildAliasMap();
const focalIndex = buildFocalIndex();

const cleanedRows = state.rawResults.map(row => {
  const next = { ...row };
  if (!String(row.response_text || '').startsWith('[ERROR]')) {
    const rawBrands = extractBrands(row.response_text);
    const stdBrands = standardiseBrands(rawBrands, aliasMap, row.sub_category);
    for (let k = 1; k <= 5; k++) next[`brand_${k}`] = stdBrands[k - 1] || '';
  }
  return next;
});

const grouped = {};
for (const row of cleanedRows) {
  const key = `${row.model_id}|${row.sub_category}`;
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(row);
}

const cleanedMetrics = [];
const reports = [];
for (const [key, rows] of Object.entries(grouped)) {
  const [modelId, subCategory] = key.split('|');
  const successfulRows = rows.filter(row => !String(row.response_text || '').startsWith('[ERROR]'));
  const promptCondition = rows[0]?.prompt_condition || '';
  cleanedMetrics.push(...calculateMetrics(successfulRows, focalIndex[subCategory] || [], subCategory, modelId, promptCondition));
  reports.push(analyseRows(modelId, subCategory, rows));
}

writeCSV(rawOut, cleanedRows, [
  'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
  'prompt_condition', 'prompt', 'response_text', 'brand_1', 'brand_2',
  'brand_3', 'brand_4', 'brand_5', 'timestamp', 'temperature',
  'max_output_tokens', 'notes',
]);
writeCSV(metricsOut, cleanedMetrics, [
  'sub_category', 'model_id', 'prompt_condition', 'brand', 'visibility_group', 'total_mentions',
  'n_replicates', 'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
]);

const lines = [
  '# LLM Brand Experiment Quality Report (Cleaned)',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Source state: ${stateFile}`,
  '',
];

for (const report of reports) {
  lines.push(`## ${report.model_id} / ${report.sub_category}`);
  lines.push('');
  lines.push(`Completed rows: ${report.completed}; errors ${report.errors}`);
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

fs.writeFileSync(reportOut, `${lines.join('\n')}\n`);
console.log(`Cleaned raw CSV: ${rawOut}`);
console.log(`Cleaned metrics CSV: ${metricsOut}`);
console.log(`Cleaned quality report: ${reportOut}`);
