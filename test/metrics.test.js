const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateMetrics } = require('../lib/metrics');

test('metrics discover every observed brand without a predefined brand list', () => {
  const drillRows = [
    { brand_1: 'Craftsman', brand_2: 'DeWalt', brand_3: 'Ryobi' },
    { brand_1: 'DeWalt', brand_2: 'Craftsman', brand_3: 'Makita' },
  ];
  const jacketRows = [
    { brand_1: 'L.L. Bean', brand_2: 'Patagonia' },
    { brand_1: 'Columbia', brand_2: 'L.L. Bean' },
  ];

  const drillMetrics = calculateMetrics(drillRows, 'cordless drills', 'test-model', 'context-free');
  const jacketMetrics = calculateMetrics(jacketRows, 'hiking jacket', 'test-model', 'context-free');
  const craftsman = drillMetrics.find(row => row.brand === 'Craftsman');
  const llBean = jacketMetrics.find(row => row.brand === 'L.L. Bean');

  assert.equal(craftsman['BRP@5'], '1.0000');
  assert.equal(craftsman.MRR, '0.7500');
  assert.equal(llBean['BRP@5'], '1.0000');
  assert.equal(llBean.MRR, '0.7500');
  assert.equal('visibility_group' in craftsman, false);
});
