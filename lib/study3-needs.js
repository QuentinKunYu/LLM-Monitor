const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { calculateMetrics } = require('./metrics');

const REQUIRED_PROMPT_COLUMNS = [
  'category',
  'sub_category',
  'prompt_condition',
  'theme',
  'prompt_id',
  'prompt',
];

function loadNeedsPrompts(filePath) {
  const csvText = fs.readFileSync(filePath, 'utf8');
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return validateNeedsPrompts(rows);
}

function validateNeedsPrompts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Needs-based prompt CSV has no rows.');
  }

  const columns = Object.keys(rows[0] || {});
  const missing = REQUIRED_PROMPT_COLUMNS.filter(column => !columns.includes(column));
  if (missing.length) {
    throw new Error(`Needs-based prompt CSV is missing columns: ${missing.join(', ')}`);
  }

  const seenPromptIds = new Set();
  const duplicatePromptIds = new Set();
  const normalized = rows.map((row, index) => {
    const item = {};
    for (const column of REQUIRED_PROMPT_COLUMNS) {
      item[column] = String(row[column] || '').trim();
      if (!item[column]) {
        throw new Error(`Needs-based prompt CSV row ${index + 1} is missing ${column}.`);
      }
    }
    if (seenPromptIds.has(item.prompt_id)) duplicatePromptIds.add(item.prompt_id);
    seenPromptIds.add(item.prompt_id);
    return item;
  });

  if (duplicatePromptIds.size > 0) {
    throw new Error(`Needs-based prompt CSV has duplicate prompt_id values: ${[...duplicatePromptIds].join(', ')}`);
  }

  return normalized;
}

function summariseNeedsPrompts(prompts, source = 'fixture.csv') {
  const byCategory = countBy(prompts, 'sub_category');
  const byCondition = countBy(prompts, 'prompt_condition');
  const byTheme = {};

  for (const prompt of prompts) {
    const key = `${prompt.sub_category}|${prompt.theme}`;
    byTheme[key] = (byTheme[key] || 0) + 1;
  }

  return {
    source,
    total_prompts: prompts.length,
    categories: Object.entries(byCategory).map(([sub_category, prompt_count]) => ({ sub_category, prompt_count })),
    conditions: Object.entries(byCondition).map(([prompt_condition, prompt_count]) => ({ prompt_condition, prompt_count })),
    themes: Object.entries(byTheme).map(([key, prompt_count]) => {
      const [sub_category, theme] = key.split('|');
      return { sub_category, theme, prompt_count };
    }),
  };
}

function buildRepeatedPromptTasks({ prompts, models, repeatCount = 2 }) {
  const repeats = Number.parseInt(repeatCount, 10);
  if (!Number.isFinite(repeats) || repeats < 1) {
    throw new Error('repeatCount must be a positive integer.');
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('At least one model is required.');
  }

  const tasks = [];
  for (const promptRow of prompts) {
    for (const model of models) {
      for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
        tasks.push({
          ...promptRow,
          model_id: model.model_id,
          model_name: model.model_name || model.display_name || model.model_id,
          provider: model.provider || '',
          display_name: model.display_name || model.model_id,
          repeat_index: repeatIndex,
          task_key: `${promptRow.prompt_id}|${model.model_id}|${repeatIndex}`,
        });
      }
    }
  }
  return tasks;
}

function calculateNeedsMetrics(rawRows, focalBrands = []) {
  const successfulRows = rawRows.filter(row => !String(row.response_text || '').startsWith('[ERROR]'));
  const metrics = [];
  const metricsByTheme = [];

  for (const [key, rows] of groupRows(successfulRows, row => [
    row.sub_category,
    row.model_id,
    row.prompt_condition,
  ].join('|'))) {
    const [subCategory, modelId, promptCondition] = key.split('|');
    metrics.push(...calculateMetrics(
      rows,
      focalBrands.filter(row => row.sub_category === subCategory),
      subCategory,
      modelId,
      promptCondition
    ));
  }

  for (const [key, rows] of groupRows(successfulRows, row => [
    row.sub_category,
    row.model_id,
    row.prompt_condition,
    row.theme,
  ].join('|'))) {
    const [subCategory, modelId, promptCondition, theme] = key.split('|');
    const promptIdCount = new Set(rows.map(row => row.prompt_id).filter(Boolean)).size;
    const themeMetrics = calculateMetrics(
      rows,
      focalBrands.filter(row => row.sub_category === subCategory),
      subCategory,
      modelId,
      promptCondition
    );
    for (const row of themeMetrics) {
      metricsByTheme.push({
        ...row,
        theme,
        prompt_id_count: promptIdCount,
      });
    }
  }

  return {
    metrics,
    metricsByTheme,
    conditionSummary: summariseRows(successfulRows, ['prompt_condition']),
    themeSummary: summariseRows(successfulRows, ['prompt_condition', 'sub_category', 'theme']),
    modelSummary: summariseRows(successfulRows, ['model_id']),
    categorySummary: summariseRows(successfulRows, ['sub_category']),
  };
}

function summariseRows(rows, fields) {
  return [...groupRows(rows, row => fields.map(field => row[field] || '').join('|')).entries()]
    .map(([key, group]) => {
      const parts = key.split('|');
      const out = {};
      fields.forEach((field, index) => {
        out[field] = parts[index] || '';
      });
      out.total_rows = group.length;
      out.unique_prompts = new Set(group.map(row => row.prompt_id).filter(Boolean)).size;
      out.total_mentions = countMentions(group);
      out.error_rows = group.filter(row => String(row.response_text || '').startsWith('[ERROR]')).length;
      return out;
    })
    .sort((a, b) => b.total_mentions - a.total_mentions);
}

function countMentions(rows) {
  let total = 0;
  for (const row of rows) {
    for (let k = 1; k <= 5; k++) {
      if (row[`brand_${k}`]) total++;
    }
  }
  return total;
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = row[field] || '';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function groupRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

module.exports = {
  REQUIRED_PROMPT_COLUMNS,
  buildRepeatedPromptTasks,
  calculateNeedsMetrics,
  loadNeedsPrompts,
  summariseNeedsPrompts,
  validateNeedsPrompts,
};
