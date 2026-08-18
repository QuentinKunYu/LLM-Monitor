const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { norm, standardiseBrands } = require('../lib/brand-extractor');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CONTEXT_SOURCE = path.join(
  ROOT,
  'data',
  'exports',
  'study1',
  '2026-08-11_context_free_5cat_6model_40rep_repaired_with_reasons',
  'raw_results.csv'
);
const DEFAULT_NEEDS_SOURCE = path.join(
  ROOT,
  'data',
  'exports',
  'study3',
  '2026-08-07_needs_200prompts_6model_2repeat_category_explicit_merged_with_reasons',
  'simplified',
  'processed',
  'study3_main_brand_names_unified.csv'
);
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'data', 'final');
const EXPECTED_REPLICATES = 40;
const METRIC_COLUMNS = [
  'sub_category',
  'model_id',
  'brand',
  'total_mentions',
  'n_replicates',
  'BRP@1',
  'BRP@3',
  'BRP@5',
  'MRR',
  'prompt_condition',
];

function readCSV(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing source file: ${file}`);
  return parse(fs.readFileSync(file, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildAliasMap() {
  const rows = readCSV(path.join(ROOT, 'config', 'brand_alias_dictionary.csv'));
  return Object.fromEntries(rows.map(row => [
    `${row.category}|${norm(row.alias)}`,
    row.standard_brand,
  ]));
}

function loadDesign() {
  const focalRows = readCSV(path.join(ROOT, 'config', 'categories_brands.csv'));
  const modelRows = readJSON(path.join(ROOT, 'config', 'models.json')).models;
  const categories = [...new Set(focalRows.map(row => row.sub_category))];
  const models = modelRows.map(row => row.model_id);
  const focalByCategory = new Map(categories.map(category => [category, new Map()]));

  for (const row of focalRows) {
    focalByCategory.get(row.sub_category).set(row.brand, row.visibility_group);
  }

  return { categories, models, focalByCategory };
}

function normalizeSourceRows(sourceRows, aliasMap, sourceLabel) {
  const normalized = [];
  const invalidRows = [];

  for (let index = 0; index < sourceRows.length; index++) {
    const row = sourceRows[index];
    const category = String(row.sub_category || row.category || '').trim();
    const model = String(row.model_id || row.model || '').trim();
    const condition = String(row.prompt_condition || row.condition || '').trim();
    const responseText = String(row.response_text || '');
    const rawBrands = [1, 2, 3, 4, 5]
      .map(rank => String(row[`cleaned_brand_${rank}`] || row[`brand_${rank}`] || '').trim())
      .filter(Boolean);

    if (!category || !model || !condition || responseText.startsWith('[ERROR]') || rawBrands.length === 0) {
      invalidRows.push(index + 2);
      continue;
    }

    const brands = standardiseBrands(rawBrands, aliasMap, category).slice(0, 5);
    normalized.push({ category, model, condition, brands });
  }

  if (invalidRows.length > 0) {
    throw new Error(`${sourceLabel} has ${invalidRows.length} invalid/error rows; first CSV lines: ${invalidRows.slice(0, 10).join(', ')}`);
  }
  return normalized;
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.category, row.model, row.condition].join('\u001f');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function assertBalancedDesign(rows, design, conditions, sourceLabel) {
  const groups = groupRows(rows);
  const expectedKeys = new Set();

  for (const category of design.categories) {
    for (const model of design.models) {
      for (const condition of conditions) {
        const key = [category, model, condition].join('\u001f');
        expectedKeys.add(key);
        const count = groups.get(key)?.length || 0;
        if (count !== EXPECTED_REPLICATES) {
          throw new Error(`${sourceLabel} cell ${key} has ${count} rows; expected ${EXPECTED_REPLICATES}`);
        }
      }
    }
  }

  const unexpected = [...groups.keys()].filter(key => !expectedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${sourceLabel} has unexpected cells: ${unexpected.join(', ')}`);
  }

  return groups;
}

function buildUniverse(rows, design) {
  const universe = new Map();
  for (const category of design.categories) {
    universe.set(category, new Set(design.focalByCategory.get(category).keys()));
  }
  for (const row of rows) {
    const brands = universe.get(row.category);
    if (!brands) throw new Error(`Unexpected category in source: ${row.category}`);
    for (const brand of row.brands) brands.add(brand);
  }
  return universe;
}

function outputBrandName(brand) {
  const specialLetters = {
    'Æ': 'AE', 'æ': 'ae',
    'Ø': 'O', 'ø': 'o',
    'Œ': 'OE', 'œ': 'oe',
    'Ð': 'D', 'ð': 'd',
    'Þ': 'Th', 'þ': 'th',
    'Ł': 'L', 'ł': 'l',
    'ß': 'ss',
  };
  const asciiBrand = brand
    .replace(/[ÆæØøŒœÐðÞþŁłß]/g, letter => specialLetters[letter])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return norm(asciiBrand) === 'kuhl' ? 'KUHL' : asciiBrand;
}

function calculateMetricRows(rows, design, conditions, sourceLabel) {
  const groups = assertBalancedDesign(rows, design, conditions, sourceLabel);
  const universe = buildUniverse(rows, design);
  const output = [];

  for (const category of design.categories) {
    for (const model of design.models) {
      for (const condition of conditions) {
        const key = [category, model, condition].join('\u001f');
        const runs = groups.get(key);
        const categoryRows = [];

        for (const brand of universe.get(category)) {
          let brp1 = 0;
          let brp3 = 0;
          let brp5 = 0;
          let reciprocalRankSum = 0;

          for (const run of runs) {
            const rankIndex = run.brands.indexOf(brand);
            if (rankIndex < 0) continue;
            const rank = rankIndex + 1;
            if (rank <= 1) brp1++;
            if (rank <= 3) brp3++;
            if (rank <= 5) brp5++;
            reciprocalRankSum += 1 / rank;
          }

          categoryRows.push({
            sub_category: category,
            model_id: model,
            prompt_condition: condition,
            brand: outputBrandName(brand),
            total_mentions: brp5,
            n_replicates: runs.length,
            'BRP@1': (brp1 / runs.length).toFixed(4),
            'BRP@3': (brp3 / runs.length).toFixed(4),
            'BRP@5': (brp5 / runs.length).toFixed(4),
            MRR: (reciprocalRankSum / runs.length).toFixed(4),
          });
        }

        categoryRows.sort((a, b) => a.brand.localeCompare(b.brand, 'en'));
        output.push(...categoryRows);
      }
    }
  }

  return { output, universe };
}

function writeMetrics(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(rows, { header: true, columns: METRIC_COLUMNS }));
}

function validateMetricRows(rows, sourceLabel) {
  const keys = new Set();
  let zeroRows = 0;
  for (const row of rows) {
    const key = [row.sub_category, row.model_id, row.prompt_condition, row.brand].join('\u001f');
    if (keys.has(key)) throw new Error(`${sourceLabel} has duplicate metric key: ${key}`);
    keys.add(key);

    const brp1 = Number(row['BRP@1']);
    const brp3 = Number(row['BRP@3']);
    const brp5 = Number(row['BRP@5']);
    const mrr = Number(row.MRR);
    if (row.n_replicates !== EXPECTED_REPLICATES) {
      throw new Error(`${sourceLabel} metric ${key} has n_replicates=${row.n_replicates}`);
    }
    if (!(0 <= brp1 && brp1 <= brp3 && brp3 <= brp5 && brp5 <= 1)) {
      throw new Error(`${sourceLabel} has invalid BRP ordering for ${key}`);
    }
    if (!(0 <= mrr && mrr <= 1)) throw new Error(`${sourceLabel} has invalid MRR for ${key}`);
    if (Math.abs(brp5 - row.total_mentions / row.n_replicates) > 0.00005) {
      throw new Error(`${sourceLabel} BRP@5 does not reconcile to total_mentions for ${key}`);
    }
    if (row.total_mentions === 0) {
      zeroRows++;
      if (brp1 !== 0 || brp3 !== 0 || brp5 !== 0 || mrr !== 0) {
        throw new Error(`${sourceLabel} zero-mention row has non-zero metric for ${key}`);
      }
    }
  }
  if (zeroRows === 0) throw new Error(`${sourceLabel} unexpectedly has no zero-mention rows`);
}

function summarize(label, normalizedRows, result, outputFile) {
  return {
    label,
    source_rows: normalizedRows.length,
    metric_rows: result.output.length,
    category_brand_universe: Object.fromEntries(
      [...result.universe.entries()].map(([category, brands]) => [category, brands.size])
    ),
    output_file: outputFile,
  };
}

function main() {
  const [contextArg, needsArg, outputArg] = process.argv.slice(2);
  const contextSource = path.resolve(contextArg || DEFAULT_CONTEXT_SOURCE);
  const needsSource = path.resolve(needsArg || DEFAULT_NEEDS_SOURCE);
  const outputDir = path.resolve(outputArg || DEFAULT_OUTPUT_DIR);
  const aliasMap = buildAliasMap();
  const design = loadDesign();

  const contextRows = normalizeSourceRows(readCSV(contextSource), aliasMap, 'context-free');
  const needsRows = normalizeSourceRows(readCSV(needsSource), aliasMap, 'needs-based');
  const contextResult = calculateMetricRows(contextRows, design, ['context-free'], 'context-free');
  const needsResult = calculateMetricRows(
    needsRows,
    design,
    ['needs-based-general', 'needs-based-detailed'],
    'needs-based'
  );

  validateMetricRows(contextResult.output, 'context-free');
  validateMetricRows(needsResult.output, 'needs-based');

  const contextOutput = path.join(outputDir, 'context_free_brand_metrics.csv');
  const needsOutput = path.join(outputDir, 'needs_based_brand_metrics.csv');
  writeMetrics(contextOutput, contextResult.output);
  writeMetrics(needsOutput, needsResult.output);

  console.log(JSON.stringify({
    context_free: summarize('context-free', contextRows, contextResult, contextOutput),
    needs_based: summarize('needs-based', needsRows, needsResult, needsOutput),
  }, null, 2));
}

main();
