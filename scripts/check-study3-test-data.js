const fs = require('fs');
const path = require('path');
const { calculateMetrics } = require('../lib/metrics');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const outDir = path.join(DATA_DIR, 'exports', 'study3', 'fixture_check');
const rawOut = path.join(outDir, 'raw_results.csv');
const metricsOut = path.join(outDir, 'metrics.csv');
const reportOut = path.join(outDir, 'quality_report.md');

const fixtureResponses = [
  {
    prompt_condition: 'functional-need',
    rows: [
      ['DeWalt', 'Milwaukee', 'Makita', 'Bosch', 'Ryobi'],
      ['Ryobi', 'DeWalt', 'Makita', 'Milwaukee', 'Bosch'],
      ['DeWalt', 'Makita', 'Milwaukee', 'Ryobi', 'Bosch'],
      ['Milwaukee', 'DeWalt', 'Ryobi', 'Makita', 'Bosch'],
    ],
  },
  {
    prompt_condition: 'aspirational-need',
    rows: [
      ['Festool', 'Milwaukee', 'Hilti', 'DeWalt', 'Makita'],
      ['Hilti', 'Festool', 'Milwaukee', 'Makita', 'DeWalt'],
      ['Festool', 'Hilti', 'Milwaukee', 'DeWalt', 'Makita'],
      ['Milwaukee', 'Festool', 'Hilti', 'Makita', 'DeWalt'],
    ],
  },
];

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

function buildRawRows() {
  const rows = [];
  for (const condition of fixtureResponses) {
    for (let i = 0; i < condition.rows.length; i++) {
      const brands = condition.rows[i];
      rows.push({
        run_id: `fixture-${condition.prompt_condition}`,
        category: 'power tool',
        sub_category: 'cordless drills',
        model_id: 'fixture-model',
        model_name: 'fixture-model',
        replicate: i + 1,
        prompt_condition: condition.prompt_condition,
        prompt: `Fixture prompt for ${condition.prompt_condition}`,
        response_text: JSON.stringify({ brands }),
        brand_1: brands[0],
        brand_2: brands[1],
        brand_3: brands[2],
        brand_4: brands[3],
        brand_5: brands[4],
        timestamp: '2026-05-07T00:00:00.000Z',
        temperature: 0.7,
        max_output_tokens: 800,
        notes: 'fixture_only_no_api_call',
      });
    }
  }
  return rows;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const rawRows = buildRawRows();
  const metrics = [];

  for (const condition of fixtureResponses) {
    const rows = rawRows.filter(row => row.prompt_condition === condition.prompt_condition);
    metrics.push(...calculateMetrics(
      rows,
      'cordless drills',
      'fixture-model',
      condition.prompt_condition
    ));
  }

  const rawHeaders = [
    'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
    'prompt_condition', 'prompt', 'response_text', 'brand_1', 'brand_2',
    'brand_3', 'brand_4', 'brand_5', 'timestamp', 'temperature',
    'max_output_tokens', 'notes',
  ];
  const metricHeaders = [
    'sub_category', 'model_id', 'prompt_condition', 'brand',
    'total_mentions', 'n_replicates', 'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
  ];

  writeCSV(rawOut, rawRows, rawHeaders);
  writeCSV(metricsOut, metrics, metricHeaders);

  const conditions = [...new Set(rawRows.map(row => row.prompt_condition))].sort();
  const metricConditions = [...new Set(metrics.map(row => row.prompt_condition))].sort();
  const functionalFestool = metrics.find(row => row.prompt_condition === 'functional-need' && row.brand === 'Festool');
  const aspirationalFestool = metrics.find(row => row.prompt_condition === 'aspirational-need' && row.brand === 'Festool');

  assert(rawRows.length === 8, `Expected 8 raw rows, got ${rawRows.length}`);
  assert(conditions.join(',') === 'aspirational-need,functional-need', `Unexpected raw conditions: ${conditions.join(',')}`);
  assert(metricConditions.join(',') === 'aspirational-need,functional-need', `Unexpected metric conditions: ${metricConditions.join(',')}`);
  assert(!functionalFestool, 'Festool should not appear in functional fixture metrics');
  assert(aspirationalFestool && aspirationalFestool['BRP@5'] === '1.0000', 'Festool should appear in all aspirational fixture rows');

  const report = [
    '# Study 3 Fixture Check',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Raw rows: ${rawRows.length}`,
    `Metric rows: ${metrics.length}`,
    `Conditions: ${conditions.join(', ')}`,
    '',
    'Checks passed:',
    '- raw rows include prompt_condition',
    '- metrics include prompt_condition',
    '- functional and aspirational metrics are calculated separately',
    '- fixture uses no API calls',
    '',
  ].join('\n');
  fs.writeFileSync(reportOut, report);

  console.log(`Study 3 fixture check passed.`);
  console.log(`Raw CSV: ${rawOut}`);
  console.log(`Metrics CSV: ${metricsOut}`);
  console.log(`Quality report: ${reportOut}`);
}

main();
