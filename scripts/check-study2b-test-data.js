const fs = require('fs');
const path = require('path');
const { calculateMetrics } = require('../lib/metrics');

const outDir = path.join(__dirname, '..', 'data', 'exports', 'study2', 'fixture_check');
const rawOut = path.join(outDir, 'raw_results.csv');
const metricsOut = path.join(outDir, 'metrics.csv');
const reportOut = path.join(outDir, 'quality_report.md');

const focalBrands = [
  { brand: 'Ryobi', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'DeWalt', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'Milwaukee', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'Festool', visibility_group: 'niche', sub_category: 'cordless drills' },
  { brand: 'Hilti', visibility_group: 'niche', sub_category: 'cordless drills' },
  { brand: 'Makita', visibility_group: 'niche', sub_category: 'cordless drills' },
];

const fixture = [
  {
    persona_id: 'sp_fixture_budget',
    profile_text: 'Budget-oriented beginner who wants a reliable practical drill.',
    rows: [
      ['Ryobi', 'DeWalt', 'Makita', 'Milwaukee', 'Bosch'],
      ['Ryobi', 'Milwaukee', 'DeWalt', 'Makita', 'Bosch'],
    ],
  },
  {
    persona_id: 'sp_fixture_aspiring_pro',
    profile_text: 'Aspirational DIY enthusiast who wants brands that signal expertise.',
    rows: [
      ['Festool', 'Milwaukee', 'Hilti', 'DeWalt', 'Makita'],
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const rawRows = [];

  for (const persona of fixture) {
    for (let i = 0; i < persona.rows.length; i++) {
      const brands = persona.rows[i];
      rawRows.push({
        run_id: `fixture-${persona.persona_id}`,
        category: 'power tool',
        sub_category: 'cordless drills',
        model_id: 'fixture-model',
        model_name: 'fixture-model',
        replicate: i + 1,
        prompt_condition: 'synthetic-profile',
        persona_id: persona.persona_id,
        persona_type: 'synthetic',
        profile_text: persona.profile_text,
        prompt: `Fixture synthetic profile prompt for ${persona.persona_id}`,
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

  const metrics = calculateMetrics(rawRows, focalBrands, 'cordless drills', 'fixture-model', 'synthetic-profile')
    .map(row => ({
      ...row,
      persona_type: 'synthetic',
      n_personas: new Set(rawRows.map(raw => raw.persona_id)).size,
    }));

  writeCSV(rawOut, rawRows, [
    'run_id', 'category', 'sub_category', 'model_id', 'model_name', 'replicate',
    'prompt_condition', 'persona_id', 'persona_type', 'profile_text', 'prompt',
    'response_text', 'brand_1', 'brand_2', 'brand_3', 'brand_4', 'brand_5',
    'timestamp', 'temperature', 'max_output_tokens', 'notes',
  ]);
  writeCSV(metricsOut, metrics, [
    'sub_category', 'model_id', 'prompt_condition', 'persona_type', 'n_personas',
    'brand', 'visibility_group', 'total_mentions', 'n_replicates',
    'BRP@1', 'BRP@3', 'BRP@5', 'MRR',
  ]);

  assert(rawRows.length === 4, `Expected 4 raw rows, got ${rawRows.length}`);
  assert(new Set(rawRows.map(row => row.persona_id)).size === 2, 'Expected two personas');
  assert(rawRows.every(row => row.prompt_condition === 'synthetic-profile'), 'Unexpected prompt condition');
  assert(metrics.every(row => row.n_personas === 2), 'Metrics should include n_personas=2');
  assert(metrics.some(row => row.brand === 'Ryobi'), 'Expected Ryobi in aggregate metrics');
  assert(metrics.some(row => row.brand === 'Festool'), 'Expected Festool in aggregate metrics');

  fs.writeFileSync(reportOut, [
    '# Study 2b Fixture Check',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Raw rows: ${rawRows.length}`,
    `Metric rows: ${metrics.length}`,
    'Checks passed:',
    '- raw rows include persona_id, persona_type, and profile_text',
    '- raw rows are in prompt_condition synthetic-profile',
    '- metrics aggregate across synthetic personas',
    '- fixture uses no API calls',
    '',
  ].join('\n'));

  console.log('Study 2b fixture check passed.');
  console.log(`Raw CSV: ${rawOut}`);
  console.log(`Metrics CSV: ${metricsOut}`);
  console.log(`Quality report: ${reportOut}`);
}

main();
