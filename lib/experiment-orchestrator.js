const { calculateMetrics } = require('./metrics');

const PAPER_DEFAULTS = Object.freeze({
  contextFreeReplicates: 40,
  needsRepeats: 2,
  maxOutputTokens: 800,
  reasonMaxOutputTokens: 800,
  temperature: null,
  webSearch: false,
  followupReasons: true,
  bypassCache: true,
  sequential: true,
});

function positiveInteger(value, fallback, min = 1, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalTemperature(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error('Temperature must be blank (provider default) or between 0 and 2.');
  }
  return parsed;
}

function buildProtocol({
  availableModels,
  categoryRows,
  needsPrompts,
  input = {},
}) {
  const modelIds = Array.isArray(input.models) && input.models.length
    ? input.models
    : availableModels.map(model => model.model_id);
  const categoryNames = Array.isArray(input.categories) && input.categories.length
    ? input.categories
    : [...new Set(categoryRows.map(row => row.sub_category))];

  const models = modelIds.map(modelId => {
    const model = availableModels.find(item => item.model_id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    return model;
  });
  const categoryIndex = new Map();
  for (const row of categoryRows) {
    if (!categoryIndex.has(row.sub_category)) categoryIndex.set(row.sub_category, row.category);
  }
  for (const subCategory of categoryNames) {
    if (!categoryIndex.has(subCategory)) throw new Error(`Unknown category: ${subCategory}`);
  }

  const contextFreeReplicates = positiveInteger(
    input.contextFreeReplicates,
    PAPER_DEFAULTS.contextFreeReplicates
  );
  const needsRepeats = positiveInteger(input.needsRepeats, PAPER_DEFAULTS.needsRepeats, 1, 10);
  const maxOutputTokens = positiveInteger(input.maxOutputTokens, PAPER_DEFAULTS.maxOutputTokens, 50, 4096);
  const reasonMaxOutputTokens = positiveInteger(
    input.reasonMaxOutputTokens,
    PAPER_DEFAULTS.reasonMaxOutputTokens,
    50,
    4096
  );
  const temperature = optionalTemperature(input.temperature);
  const promptTemplate = String(input.promptTemplate || '').trim();
  if (!promptTemplate || !/\[category\]/i.test(promptTemplate)) {
    throw new Error('The context-free prompt must include a [category] placeholder.');
  }

  const selectedNeedsPrompts = needsPrompts.filter(prompt => categoryNames.includes(prompt.sub_category));
  if (!selectedNeedsPrompts.length) throw new Error('No needs-based prompts match the selected categories.');

  const recommendationTasks = [];
  for (const subCategory of categoryNames) {
    for (const model of models) {
      for (let replicate = 1; replicate <= contextFreeReplicates; replicate += 1) {
        recommendationTasks.push({
          task_key: `context-free|${subCategory}|${model.model_id}|${replicate}`,
          stage: 'context-free',
          study: 'study1',
          category: categoryIndex.get(subCategory),
          sub_category: subCategory,
          prompt_condition: 'context-free',
          theme: '',
          prompt_id: `context_free_${subCategory.replace(/[^a-z0-9]+/gi, '_')}`,
          prompt: promptTemplate.replace(/\[category\]/gi, subCategory),
          replicate,
          repeat_index: '',
          model_id: model.model_id,
          model_name: model.model_name,
          display_name: model.display_name,
          provider: model.provider,
        });
      }
    }
  }

  for (const promptRow of selectedNeedsPrompts) {
    for (const model of models) {
      for (let repeatIndex = 1; repeatIndex <= needsRepeats; repeatIndex += 1) {
        recommendationTasks.push({
          task_key: `${promptRow.prompt_id}|${model.model_id}|${repeatIndex}`,
          stage: 'needs-based',
          study: 'study3',
          category: promptRow.category,
          sub_category: promptRow.sub_category,
          prompt_condition: promptRow.prompt_condition,
          theme: promptRow.theme,
          prompt_id: promptRow.prompt_id,
          prompt: promptRow.prompt,
          replicate: repeatIndex,
          repeat_index: repeatIndex,
          model_id: model.model_id,
          model_name: model.model_name,
          display_name: model.display_name,
          provider: model.provider,
        });
      }
    }
  }

  const contextFreeCalls = recommendationTasks.filter(task => task.stage === 'context-free').length;
  const needsBasedCalls = recommendationTasks.length - contextFreeCalls;
  const followupReasons = input.followupReasons !== false;
  const reasonCalls = followupReasons ? recommendationTasks.length : 0;

  return {
    config: {
      models: models.map(model => model.model_id),
      categories: categoryNames,
      promptTemplate,
      needsPrompts: selectedNeedsPrompts,
      contextFreeReplicates,
      needsRepeats,
      maxOutputTokens,
      reasonMaxOutputTokens,
      temperature,
      followupReasons,
      webSearch: Boolean(input.webSearch),
      dryRun: Boolean(input.dryRun),
      sessionRule: 'fresh_session_no_history',
      cache: 'off',
      execution: 'sequential',
    },
    recommendationTasks,
    counts: {
      models: models.length,
      categories: categoryNames.length,
      needsPrompts: selectedNeedsPrompts.length,
      contextFreeCalls,
      needsBasedCalls,
      recommendationCalls: recommendationTasks.length,
      reasonCalls,
      totalCalls: recommendationTasks.length + reasonCalls,
    },
  };
}

function calculateExperimentMetrics(results, categoryRows, expectedTasks) {
  const successful = results.filter(row => row.status === 'completed' && !String(row.response_text || '').startsWith('[ERROR]'));
  const groupedRows = groupBy(successful, row => [row.sub_category, row.model_id, row.prompt_condition].join('|'));
  const expectedGroups = groupBy(expectedTasks, task => [task.sub_category, task.model_id, task.prompt_condition].join('|'));
  const metrics = [];

  for (const [key, rows] of groupedRows.entries()) {
    const [subCategory, modelId, promptCondition] = key.split('|');
    const expected = expectedGroups.get(key)?.length || rows.length;
    const focalBrands = categoryRows
      .filter(row => row.sub_category === subCategory)
      .map(row => ({
        brand: row.brand,
        visibility_group: row.visibility_group,
        sub_category: row.sub_category,
      }));
    for (const metric of calculateMetrics(rows, focalBrands, subCategory, modelId, promptCondition)) {
      metrics.push({
        ...metric,
        denominator: rows.length,
        expected_observations: expected,
        provisional: rows.length !== expected,
      });
    }
  }

  return metrics.sort((a, b) => (
    a.sub_category.localeCompare(b.sub_category) ||
    a.model_id.localeCompare(b.model_id) ||
    a.prompt_condition.localeCompare(b.prompt_condition) ||
    Number(b['BRP@5']) - Number(a['BRP@5'])
  ));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

module.exports = {
  PAPER_DEFAULTS,
  buildProtocol,
  calculateExperimentMetrics,
};
