const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const predictorData = require(path.join(ROOT, 'public', 'predictor-correlations.json'));

test('Brandwatch covers the documented 104-brand analysis universe', () => {
  assert.equal(predictorData.brands.length, 104);
  assert.equal(new Set(predictorData.brands.map(brand => `${brand.sub_category}|${brand.brand}`)).size, 104);

  const predictor = predictorData.predictors.find(item => item.key === 'log_Brandwatch Mentions 12mo');
  assert.ok(predictor, 'Brandwatch predictor should be present');
  assert.equal(predictor.is_log, true);
  assert.equal(predictor.label, 'Online Conversation / Earned-Media Salience — Brandwatch (log)');

  const populated = predictorData.brands.filter(brand => brand.brandwatch_mentions_12mo != null);
  assert.equal(populated.length, 103);
  for (const brand of populated) {
    assert.equal(Number.isFinite(brand.brandwatch_mentions_12mo), true);
    assert.equal(brand.brandwatch_mentions_12mo >= 0, true);
    assert.equal(brand.values['log_Brandwatch Mentions 12mo'], brand.brandwatch_mentions_12mo);
  }

  const missing = predictorData.brands.filter(brand => brand.brandwatch_mentions_12mo == null);
  assert.deepEqual(missing.map(brand => brand.brand), ['City Cruises by Hornblower']);

  const expected = {
    cf_BRP5: 0.5313,
    cf_MRR: 0.4837,
    nb_BRP5: 0.4677,
    nb_MRR: 0.424,
  };
  for (const [outcome, r] of Object.entries(expected)) {
    assert.deepEqual(predictor.outcomes[outcome], { r, p: 0, n: 103 });
  }

  assert.match(predictorData.meta.brandwatch_note, /5% sample scaled ×20/);
  assert.match(predictorData.meta.brandwatch_note, /relative comparison/);
  assert.match(predictorData.meta.brandwatch_note, /not social performance/);
});

test('final aspiration scores use the merged workbook coverage', () => {
  const aspiration = predictorData.predictors.find(item => item.key === 'aspiration_avg');
  assert.ok(aspiration);
  for (const outcome of ['cf_BRP5', 'cf_MRR', 'nb_BRP5', 'nb_MRR']) {
    assert.equal(aspiration.outcomes[outcome].n, 103);
  }

  const uniworld = predictorData.brands.find(brand => brand.brand === 'Uniworld Boutique River Cruises');
  const nutrish = predictorData.brands.find(brand => brand.brand === 'Nutrish');
  assert.equal(uniworld.aspiration_avg, 4.5);
  assert.equal(uniworld.values.aspiration_avg, 4.5);
  assert.equal(nutrish.aspiration_avg, 2);
  assert.equal(nutrish.values.aspiration_avg, 2);
});

test('analysis page exposes Brandwatch values and methodology', () => {
  const script = fs.readFileSync(path.join(ROOT, 'public', 'analysis.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'analysis.html'), 'utf8');
  assert.match(script, /meta\.brandwatch_note/);
  assert.match(script, /brandwatch_mentions_12mo/);
  assert.match(html, /Online mentions \(Brandwatch 12mo est\.\)/);
});
