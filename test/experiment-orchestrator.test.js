const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { parse } = require('csv-parse/sync');
const {
  buildProtocol,
  calculateExperimentMetrics,
  calculateExperimentThemeMetrics,
} = require('../lib/experiment-orchestrator');

const ROOT = path.join(__dirname, '..');
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8')).models;
const categoryRows = parse(fs.readFileSync(path.join(ROOT, 'config', 'categories.csv'), 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});
const needsPrompts = parse(fs.readFileSync(path.join(ROOT, 'config', 'needs_based_prompts.csv'), 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});
const promptTemplate = 'I am looking for a [category]. Return valid JSON only, with this schema: {"brands":["Brand name"]}. Include up to five brand names. Do not include explanations, markdown, numbering, or any text outside the JSON object.';

test('paper protocol builds the documented 1,200 + 2,400 + 3,600 call ledger', () => {
  const protocol = buildProtocol({
    availableModels: models,
    categoryRows,
    needsPrompts,
    input: { promptTemplate, followupReasons: true },
  });

  assert.equal(protocol.counts.models, 6);
  assert.equal(protocol.counts.categories, 5);
  assert.equal(protocol.counts.needsPrompts, 200);
  assert.equal(protocol.counts.contextFreeCalls, 1200);
  assert.equal(protocol.counts.needsBasedCalls, 2400);
  assert.equal(protocol.counts.recommendationCalls, 3600);
  assert.equal(protocol.counts.reasonCalls, 3600);
  assert.equal(protocol.counts.totalCalls, 7200);
  assert.equal(protocol.config.temperature, null);
  assert.equal(protocol.config.webSearch, false);
  assert.equal(protocol.config.cache, 'off');
});

test('protocol can run context-free observations without needs-based tasks', () => {
  const protocol = buildProtocol({
    availableModels: models,
    categoryRows,
    needsPrompts: [],
    input: {
      models: [models[0].model_id],
      categories: ['cordless drills'],
      promptTemplate,
      includeContextFree: true,
      includeNeedsBased: false,
      contextFreeReplicates: 2,
      followupReasons: false,
    },
  });

  assert.equal(protocol.config.includeContextFree, true);
  assert.equal(protocol.config.includeNeedsBased, false);
  assert.equal(protocol.counts.contextFreeCalls, 2);
  assert.equal(protocol.counts.needsBasedCalls, 0);
  assert.equal(protocol.counts.totalCalls, 2);
  assert.equal(protocol.recommendationTasks.every(task => task.stage === 'context-free'), true);
});

test('protocol can run needs-based tasks without a context-free template', () => {
  const protocol = buildProtocol({
    availableModels: models,
    categoryRows,
    needsPrompts,
    input: {
      models: [models[0].model_id],
      categories: ['cordless drills'],
      promptTemplate: '',
      includeContextFree: false,
      includeNeedsBased: true,
      needsRepeats: 1,
      followupReasons: false,
    },
  });

  assert.equal(protocol.config.includeContextFree, false);
  assert.equal(protocol.config.includeNeedsBased, true);
  assert.equal(protocol.counts.contextFreeCalls, 0);
  assert.equal(protocol.counts.needsBasedCalls, 40);
  assert.equal(protocol.counts.totalCalls, 40);
  assert.equal(protocol.recommendationTasks.every(task => task.stage === 'needs-based'), true);
});

test('protocol rejects a run with no selected condition', () => {
  assert.throws(() => buildProtocol({
    availableModels: models,
    categoryRows,
    needsPrompts,
    input: {
      promptTemplate,
      includeContextFree: false,
      includeNeedsBased: false,
    },
  }), /Select at least one condition/);
});

test('metrics remain grouped by category, model, and prompt condition', () => {
  const taskBase = {
    sub_category: 'cordless drills',
    model_id: 'gpt-test',
    prompt_condition: 'context-free',
  };
  const tasks = [1, 2].map(replicate => ({ ...taskBase, task_key: `task-${replicate}` }));
  const results = [
    { ...taskBase, task_key: 'task-1', status: 'completed', response_text: '{}', brand_1: 'DeWalt', brand_2: 'Makita' },
    { ...taskBase, task_key: 'task-2', status: 'completed', response_text: '{}', brand_1: 'Makita', brand_2: 'DeWalt' },
  ];
  const metrics = calculateExperimentMetrics(results, tasks);
  const dewalt = metrics.find(row => row.brand === 'DeWalt');
  assert.equal(dewalt['BRP@1'], '0.5000');
  assert.equal(dewalt['BRP@3'], '1.0000');
  assert.equal(dewalt.MRR, '0.7500');
  assert.equal(dewalt.denominator, 2);
  assert.equal(dewalt.provisional, false);
});

test('secondary theme metrics reuse existing observations', () => {
  const taskBase = {
    sub_category: 'cordless drills',
    model_id: 'gpt-test',
    prompt_condition: 'needs-based-detailed',
    theme: 'weekend warrior',
    prompt_id: 'drill_weekend_01',
  };
  const tasks = [1, 2].map(replicate => ({ ...taskBase, task_key: `detail-${replicate}` }));
  const results = [
    { ...tasks[0], status: 'completed', response_text: '{}', brand_1: 'Craftsman', brand_2: 'DeWalt' },
    { ...tasks[1], status: 'completed', response_text: '{}', brand_1: 'DeWalt', brand_2: 'Craftsman' },
  ];

  const themeMetrics = calculateExperimentThemeMetrics(results, tasks);
  const themeCraftsman = themeMetrics.find(row => row.brand === 'Craftsman');

  assert.equal(themeCraftsman.theme, 'weekend warrior');
  assert.equal(themeCraftsman.denominator, 2);
});
