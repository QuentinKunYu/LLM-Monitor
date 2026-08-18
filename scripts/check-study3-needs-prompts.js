const assert = require('assert');
const path = require('path');
const {
  buildRepeatedPromptTasks,
  calculateNeedsMetrics,
  summariseNeedsPrompts,
} = require('../lib/study3-needs');

const fixturePrompts = [
  {
    category: 'Power Tool',
    sub_category: 'cordless drills',
    prompt_condition: 'needs-based-general',
    theme: 'budget-friendly',
    prompt_id: 'drill_budget_01',
    prompt: 'Need a low-cost cordless drill. Return JSON with up to five brands.',
  },
  {
    category: 'Power Tool',
    sub_category: 'cordless drills',
    prompt_condition: 'needs-based-detailed',
    theme: 'weekend warrior',
    prompt_id: 'drill_weekend_01',
    prompt: 'Need a drill for weekend projects. Return JSON with up to five brands.',
  },
];

const focalBrands = [
  { brand: 'Ryobi', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'DeWalt', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'Milwaukee', visibility_group: 'high_visibility', sub_category: 'cordless drills' },
  { brand: 'Festool', visibility_group: 'niche', sub_category: 'cordless drills' },
];

const models = [
  { model_id: 'fixture-gpt', display_name: 'Fixture GPT' },
  { model_id: 'fixture-claude', display_name: 'Fixture Claude' },
];

const tasks = buildRepeatedPromptTasks({
  prompts: fixturePrompts,
  models,
  repeatCount: 2,
});

assert.strictEqual(tasks.length, 8, '2 prompts x 2 models x 2 repeats should create 8 tasks');
assert.deepStrictEqual(
  tasks.map(task => `${task.prompt_id}|${task.model_id}|${task.repeat_index}`).slice(0, 4),
  [
    'drill_budget_01|fixture-gpt|1',
    'drill_budget_01|fixture-gpt|2',
    'drill_budget_01|fixture-claude|1',
    'drill_budget_01|fixture-claude|2',
  ],
  'Task identity should preserve prompt_id, model_id, and repeat_index'
);

const rawRows = [
  {
    sub_category: 'cordless drills',
    model_id: 'fixture-gpt',
    prompt_condition: 'needs-based-general',
    theme: 'budget-friendly',
    prompt_id: 'drill_budget_01',
    repeat_index: 1,
    brand_1: 'Ryobi',
    brand_2: 'DeWalt',
    brand_3: '',
    brand_4: '',
    brand_5: '',
    response_text: '{"brands":["Ryobi","DeWalt"]}',
  },
  {
    sub_category: 'cordless drills',
    model_id: 'fixture-gpt',
    prompt_condition: 'needs-based-general',
    theme: 'budget-friendly',
    prompt_id: 'drill_budget_01',
    repeat_index: 2,
    brand_1: 'Ryobi',
    brand_2: 'Milwaukee',
    brand_3: '',
    brand_4: '',
    brand_5: '',
    response_text: '{"brands":["Ryobi","Milwaukee"]}',
  },
  {
    sub_category: 'cordless drills',
    model_id: 'fixture-gpt',
    prompt_condition: 'needs-based-detailed',
    theme: 'weekend warrior',
    prompt_id: 'drill_weekend_01',
    repeat_index: 1,
    brand_1: 'Festool',
    brand_2: 'Milwaukee',
    brand_3: '',
    brand_4: '',
    brand_5: '',
    response_text: '{"brands":["Festool","Milwaukee"]}',
  },
];

const { metrics, metricsByTheme, conditionSummary, themeSummary } = calculateNeedsMetrics(rawRows, focalBrands);

const ryobiOverall = metrics.find(row => row.prompt_condition === 'needs-based-general' && row.brand === 'Ryobi');
assert(ryobiOverall, 'Overall metrics should include Ryobi in needs-based-general');
assert.strictEqual(ryobiOverall.n_replicates, 2, 'Overall condition metrics should aggregate both repeats');
assert.strictEqual(ryobiOverall['BRP@5'], '1.0000', 'Ryobi should appear in both budget rows');

const festoolTheme = metricsByTheme.find(row => row.theme === 'weekend warrior' && row.brand === 'Festool');
assert(festoolTheme, 'Theme metrics should include Festool in weekend warrior');
assert.strictEqual(festoolTheme.prompt_id_count, 1, 'Theme metrics should retain prompt count context');

const generalSummary = conditionSummary.find(row => row.prompt_condition === 'needs-based-general');
assert.strictEqual(generalSummary.total_rows, 2, 'Condition summary should count raw rows');
assert.strictEqual(generalSummary.unique_prompts, 1, 'Condition summary should count unique prompt IDs');

const weekendSummary = themeSummary.find(row => row.theme === 'weekend warrior');
assert.strictEqual(weekendSummary.total_mentions, 2, 'Theme summary should count all brand mentions');

const summary = summariseNeedsPrompts(fixturePrompts);
assert.strictEqual(summary.total_prompts, 2, 'Prompt summary should count prompts');
assert.strictEqual(summary.conditions.length, 2, 'Prompt summary should list both conditions');
assert.strictEqual(path.basename(summary.source || 'fixture.csv'), 'fixture.csv', 'Summary source should be optional and stable');

console.log('Study 3 needs prompt checks passed.');
