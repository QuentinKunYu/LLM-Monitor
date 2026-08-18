const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { norm, standardiseBrands } = require('./brand-extractor');

const ROOT = path.join(__dirname, '..');

function loadCSV(filePath) {
  return parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function buildAliasMap() {
  const aliases = loadCSV(path.join(ROOT, 'config', 'brand_alias_dictionary.csv'));
  return Object.fromEntries(aliases.map(row => [
    `${row.category}|${norm(row.alias)}`,
    row.standard_brand,
  ]));
}

function isSuccessful(row) {
  return !String(row.response_text || '').startsWith('[ERROR]')
    && [1, 2, 3, 4, 5].some(rank => row[`cleaned_brand_${rank}`] || row[`brand_${rank}`]);
}

function canonicalBrand(row, rank, aliasMap) {
  const value = String(row[`cleaned_brand_${rank}`] || row[`brand_${rank}`] || '').trim();
  if (!value) return '';
  return standardiseBrands([value], aliasMap, row.sub_category)[0] || value;
}

function writeCSV(filePath, rows, columns) {
  fs.writeFileSync(filePath, stringify(rows, { header: true, columns }));
}

function resolveSourceFile(runDir) {
  const candidates = ['raw_results_cleaned.csv', 'raw_results.csv'];
  const filename = candidates.find(candidate => fs.existsSync(path.join(runDir, candidate)));
  if (!filename) throw new Error(`No raw results CSV found in ${runDir}`);
  return path.join(runDir, filename);
}

function exportSimplifiedResults({ runDir, study }) {
  const resolvedRunDir = path.resolve(runDir);
  const sourceFile = resolveSourceFile(resolvedRunDir);
  const sourceRows = loadCSV(sourceFile);
  const studyName = study || sourceRows[0]?.study || 'study';
  const outputDir = path.join(resolvedRunDir, 'simplified');
  fs.mkdirSync(outputDir, { recursive: true });

  const aliasMap = buildAliasMap();
  const successfulRows = sourceRows.filter(isSuccessful);
  const mainRows = [];
  const reasonRows = [];
  const summaryGroups = new Map();

  for (const row of successfulRows) {
    const mainRow = {
      category: row.sub_category,
      condition: row.prompt_condition,
      theme: row.theme || '',
      prompt_id: row.prompt_id || '',
      model: row.model_name || row.model_id,
      repeat: Number(row.repeat_index || row.replicate),
      prompt: row.prompt,
      reason_status: row.reason_status || 'not_requested',
    };

    for (let rank = 1; rank <= 5; rank++) {
      const brand = canonicalBrand(row, rank, aliasMap);
      const reason = row[`reason_${rank}`] || '';
      mainRow[`brand_${rank}`] = brand;
      mainRow[`reason_${rank}`] = reason;
      if (!brand) continue;

      if (reason) {
        reasonRows.push({
          category: row.sub_category,
          condition: row.prompt_condition,
          theme: row.theme || '',
          prompt_id: row.prompt_id || '',
          model: row.model_name || row.model_id,
          repeat: Number(row.repeat_index || row.replicate),
          rank,
          brand,
          reason,
        });
      }

      const groupKey = [row.sub_category, row.prompt_condition, row.model_id].join('\u001f');
      if (!summaryGroups.has(groupKey)) {
        summaryGroups.set(groupKey, {
          category: row.sub_category,
          condition: row.prompt_condition,
          model: row.model_name || row.model_id,
          totalMentions: 0,
          brands: new Map(),
        });
      }
      const group = summaryGroups.get(groupKey);
      group.totalMentions += 1;
      group.brands.set(brand, (group.brands.get(brand) || 0) + 1);
    }
    mainRows.push(mainRow);
  }

  const summaryRows = [];
  for (const group of summaryGroups.values()) {
    for (const [brand, count] of group.brands.entries()) {
      summaryRows.push({
        category: group.category,
        condition: group.condition,
        model: group.model,
        brand,
        recommendation_count: count,
        brand_share: Number((count / group.totalMentions).toFixed(6)),
      });
    }
  }
  summaryRows.sort((a, b) => (
    a.category.localeCompare(b.category)
    || a.condition.localeCompare(b.condition)
    || a.model.localeCompare(b.model)
    || b.recommendation_count - a.recommendation_count
    || a.brand.localeCompare(b.brand)
  ));

  const mainColumns = [
    'category', 'condition', 'theme', 'prompt_id', 'model', 'repeat', 'prompt', 'reason_status',
    'brand_1', 'reason_1', 'brand_2', 'reason_2', 'brand_3', 'reason_3',
    'brand_4', 'reason_4', 'brand_5', 'reason_5',
  ];
  const reasonColumns = [
    'category', 'condition', 'theme', 'prompt_id', 'model', 'repeat',
    'rank', 'brand', 'reason',
  ];
  const summaryColumns = [
    'category', 'condition', 'model', 'brand', 'recommendation_count', 'brand_share',
  ];

  const mainFile = path.join(outputDir, `${studyName}_main_clean.csv`);
  const reasonsFile = path.join(outputDir, `${studyName}_brand_reasons_clean.csv`);
  const summaryFile = path.join(outputDir, `${studyName}_brand_summary.csv`);
  writeCSV(mainFile, mainRows, mainColumns);
  writeCSV(reasonsFile, reasonRows, reasonColumns);
  writeCSV(summaryFile, summaryRows, summaryColumns);

  return {
    sourceFile,
    outputDir,
    mainFile,
    reasonsFile,
    summaryFile,
    sourceRows: sourceRows.length,
    successfulRows: successfulRows.length,
    excludedRows: sourceRows.length - successfulRows.length,
    brandReasonRows: reasonRows.length,
    summaryRows: summaryRows.length,
  };
}

module.exports = { exportSimplifiedResults };
