const assert = require('assert');
const {
  buildReasonPrompt,
  alignReasonsFromResponse,
  reasonFieldsFromResponse,
  buildBrandReasonRows,
} = require('../lib/followup-reasons');

const prompt = 'I need a cordless drill. What brands would you recommend? Please recommend up to five brands.';
const brands = ['DeWalt', 'Milwaukee', 'Ryobi'];

const reasonPrompt = buildReasonPrompt(prompt, brands);
assert(reasonPrompt.includes(prompt), 'reason prompt should include the original user prompt');
assert(reasonPrompt.includes('DeWalt'), 'reason prompt should include recommended brands');
assert(reasonPrompt.includes('Return valid JSON only'), 'reason prompt should require JSON only');

const response = JSON.stringify({
  reasons: [
    { brand: 'Ryobi', reason: 'Good value for casual DIY users.' },
    { brand: 'DeWalt', reason: 'Widely trusted for durable cordless tools.' },
    { brand: 'Milwaukee', reason: 'Strong professional tool ecosystem.' },
  ],
});

const aligned = alignReasonsFromResponse(response, brands);
assert.equal(aligned.error, '', 'valid JSON reasons should not produce an error');
assert.equal(aligned.reasons[0], 'Widely trusted for durable cordless tools.');
assert.equal(aligned.reasons[1], 'Strong professional tool ecosystem.');
assert.equal(aligned.reasons[2], 'Good value for casual DIY users.');

const fields = reasonFieldsFromResponse(prompt, brands, response);
assert.equal(fields.reason_status, 'completed');
assert.equal(fields.reason_1, 'Widely trusted for durable cordless tools.');

const longRows = buildBrandReasonRows([{
  study: 'study1',
  run_id: 'run-1',
  category: 'tools',
  sub_category: 'cordless drills',
  prompt_condition: 'context-free',
  model_id: 'gpt-test',
  model_name: 'GPT Test',
  replicate: 1,
  prompt,
  brand_1: 'DeWalt',
  brand_2: 'Milwaukee',
  brand_3: '',
  reason_1: 'Reason A',
  reason_2: 'Reason B',
  reason_status: 'completed',
}]);

assert.equal(longRows.length, 2, 'long format should create one row per non-empty brand');
assert.equal(longRows[0].rank, 1);
assert.equal(longRows[0].brand, 'DeWalt');
assert.equal(longRows[0].reason, 'Reason A');

console.log('Follow-up reason parser checks passed.');
