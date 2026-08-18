const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const [mainFileArg, baseMapFileArg, provenanceFileArg, outputDirArg] = process.argv.slice(2);
if (!mainFileArg || !baseMapFileArg || !provenanceFileArg || !outputDirArg) {
  throw new Error(
    'Usage: node scripts/standardize-study3-brand-names.js <main.csv> <base-map.csv> <provenance.csv> <output-dir>'
  );
}

const mainFile = path.resolve(mainFileArg);
const baseMapFile = path.resolve(baseMapFileArg);
const provenanceFile = path.resolve(provenanceFileArg);
const outputDir = path.resolve(outputDirArg);

function loadCSV(file) {
  return parse(fs.readFileSync(file, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function taskKey(row) {
  return `${row.prompt_id}|${row.model || row.model_id}|${Number(row.repeat || row.repeat_index)}`;
}

const mainRows = loadCSV(mainFile);
const provenanceRows = loadCSV(provenanceFile);
const baseRules = loadCSV(baseMapFile);
const addedRules = [
  {
    category: 'cordless drills', observed_brand: 'Crafstman', canonical_brand: 'Craftsman',
    mapping_type: 'spelling', confidence: 'high',
    note: 'Misspelling aligned to the existing Craftsman name.',
  },
  {
    category: 'coffee maker', observed_brand: 'GEVI', canonical_brand: 'Gevi',
    mapping_type: 'capitalization', confidence: 'high',
    note: 'Capitalization variant aligned to the existing Gevi name.',
  },
  {
    category: 'coffee maker', observed_brand: 'ESPRO', canonical_brand: 'Espro',
    mapping_type: 'capitalization', confidence: 'high',
    note: 'Capitalization variant aligned to the existing Espro name.',
  },
  {
    category: 'cat food', observed_brand: "The Farmer's Dog Cat", canonical_brand: "The Farmer's Dog",
    mapping_type: 'alias', confidence: 'high',
    note: 'Hallucinated category suffix removed; category validity is not changed.',
  },
  {
    category: 'cat food', observed_brand: 'Freshpet Vital', canonical_brand: 'Freshpet',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Freshpet product-line name reduced to the manufacturer brand.',
  },
  {
    category: 'cat food', observed_brand: 'Purina Kit & Kaboodle', canonical_brand: 'Kit & Caboodle',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Parent-brand prefix removed and aligned to the existing product brand.',
  },
  {
    category: 'cat food', observed_brand: 'Eukanuba Renal', canonical_brand: 'Eukanuba',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Product-line suffix reduced to the existing manufacturer brand.',
  },
  {
    category: 'cat food', observed_brand: 'Rayne Clinical Nutrition Adult Renal', canonical_brand: 'Rayne Clinical Nutrition',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Therapeutic product suffix removed.',
  },
  {
    category: 'cat food', observed_brand: 'Rayne Clinical Nutrition Adult Health-RSS', canonical_brand: 'Rayne Clinical Nutrition',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Therapeutic product suffix removed.',
  },
  {
    category: 'cat food', observed_brand: 'Sheba Pate', canonical_brand: 'Sheba',
    mapping_type: 'product_to_brand', confidence: 'high',
    note: 'Product-form suffix reduced to the existing brand.',
  },
  {
    category: 'cat food', observed_brand: 'Koha', canonical_brand: 'KOHA Pet Food',
    mapping_type: 'alias', confidence: 'high',
    note: 'Short form expanded to the official brand styling.',
  },
  {
    category: 'cat food', observed_brand: 'Kohapet', canonical_brand: 'KOHA Pet Food',
    mapping_type: 'alias', confidence: 'high',
    note: 'Website-style form aligned to the official brand styling.',
  },
  {
    category: 'cat food', observed_brand: 'Kohana Pet', canonical_brand: 'KOHA Pet Food',
    mapping_type: 'spelling', confidence: 'high',
    note: 'Likely misspelling aligned to the official brand styling.',
  },
  {
    category: 'hiking jacket', observed_brand: 'Aether Apparel', canonical_brand: 'Aether',
    mapping_type: 'alias', confidence: 'high',
    note: 'Corporate descriptor removed and aligned to the existing name.',
  },
  {
    category: 'hiking jacket', observed_brand: 'Norrona', canonical_brand: 'Norrøna',
    mapping_type: 'diacritic', confidence: 'high',
    note: 'Unaccented spelling aligned to the existing official styling.',
  },
  {
    category: 'hiking jacket', observed_brand: 'Klattermusen', canonical_brand: 'Klättermusen',
    mapping_type: 'diacritic', confidence: 'high',
    note: 'Unaccented spelling aligned to the official brand styling.',
  },
];

const ruleMap = new Map();
for (const rule of [...baseRules, ...addedRules]) {
  ruleMap.set(`${rule.category}|${rule.observed_brand}`, { ...rule });
}

const observedCounts = new Map();
for (const row of mainRows) {
  for (let rank = 1; rank <= 5; rank++) {
    const brand = String(row[`brand_${rank}`] || '').trim();
    if (!brand) continue;
    const key = `${row.category}|${brand}`;
    observedCounts.set(key, (observedCounts.get(key) || 0) + 1);
  }
}

const provenanceByKey = new Map(provenanceRows.map(row => [row.task_key, row]));
const standardizedRows = [];
let changedMentions = 0;
let totalMentions = 0;

for (const row of mainRows) {
  const provenance = provenanceByKey.get(taskKey(row));
  if (!provenance) throw new Error(`Missing provenance for ${taskKey(row)}`);

  const next = {
    category: row.category,
    condition: row.condition,
    theme: row.theme,
    prompt_id: row.prompt_id,
    model: row.model,
    repeat: row.repeat,
    prompt_changed: provenance.prompt_changed,
    prompt_revision: provenance.prompt_revision,
    source_run_stamp: provenance.source_run_stamp,
    prompt: row.prompt,
    reason_status: row.reason_status,
  };
  const firstRankByCanonical = new Map();
  const duplicateRanks = [];

  for (let rank = 1; rank <= 5; rank++) {
    const observed = String(row[`brand_${rank}`] || '').trim();
    const rule = ruleMap.get(`${row.category}|${observed}`);
    const canonical = observed ? (rule?.canonical_brand || observed) : '';
    next[`brand_${rank}`] = observed;
    next[`canonical_brand_${rank}`] = canonical;
    next[`reason_${rank}`] = row[`reason_${rank}`] || '';
    if (!observed) continue;
    totalMentions++;
    if (canonical !== observed) changedMentions++;
    if (firstRankByCanonical.has(canonical)) duplicateRanks.push(rank);
    else firstRankByCanonical.set(canonical, rank);
  }
  next.canonical_duplicate_ranks = duplicateRanks.join(';');
  next.canonical_unique_brand_count = firstRankByCanonical.size;
  standardizedRows.push(next);
}

const nameMapRows = [...ruleMap.values()]
  .map(rule => ({
    category: rule.category,
    observed_brand: rule.observed_brand,
    canonical_brand: rule.canonical_brand,
    mapping_type: rule.mapping_type,
    confidence: rule.confidence,
    observed_mentions: observedCounts.get(`${rule.category}|${rule.observed_brand}`) || 0,
    note: rule.note,
  }))
  .sort((a, b) => (
    a.category.localeCompare(b.category)
    || b.observed_mentions - a.observed_mentions
    || a.observed_brand.localeCompare(b.observed_brand)
  ));

const invalidRules = {
  'cat food': {
    brands: new Set(["The Farmer's Dog", "Farmer's Dog", "The Farmer's Dog Cat", 'Ollie']),
    flag_type: 'off_category_brand',
    evidence: 'Official brand pages describe dog food, not cat food.',
    source_url: 'https://www.thefarmersdog.com/why-fresh ; https://www.myollie.com/fresh-dog-food/',
  },
  'boat cruises': {
    brands: new Set(['couples.com Cruises']),
    flag_type: 'nonexistent_or_off_category_brand',
    evidence: 'Couples.com is the official site of Couples Resorts Jamaica, not a cruise line.',
    source_url: 'https://couples.com/',
  },
};

const validityFlags = [];
for (const row of standardizedRows) {
  const invalid = invalidRules[row.category];
  if (!invalid) continue;
  for (let rank = 1; rank <= 5; rank++) {
    const observed = row[`brand_${rank}`];
    if (!invalid.brands.has(observed)) continue;
    validityFlags.push({
      category: row.category,
      condition: row.condition,
      theme: row.theme,
      prompt_id: row.prompt_id,
      model: row.model,
      repeat: row.repeat,
      rank,
      observed_brand: observed,
      canonical_brand: row[`canonical_brand_${rank}`],
      flag_type: invalid.flag_type,
      confidence: 'high',
      recommended_action: 'Review and exclude or code invalid before category-level analysis.',
      evidence: invalid.evidence,
      model_reason: row[`reason_${rank}`],
      source_url: invalid.source_url,
    });
  }
}

// Analysis-ready version: canonical names replace the observed brand fields.
// Duplicate canonical brands created by consolidation keep the first rank only;
// later unique recommendations are compacted upward with their reasons.
const unifiedRows = standardizedRows.map(row => {
  const next = {
    category: row.category,
    condition: row.condition,
    theme: row.theme,
    prompt_id: row.prompt_id,
    model: row.model,
    repeat: row.repeat,
    prompt: row.prompt,
    reason_status: row.reason_status,
  };
  const seen = new Set();
  const recommendations = [];
  for (let rank = 1; rank <= 5; rank++) {
    const brand = String(row[`canonical_brand_${rank}`] || '').trim();
    if (!brand || seen.has(brand)) continue;
    seen.add(brand);
    recommendations.push({ brand, reason: row[`reason_${rank}`] || '' });
  }
  for (let rank = 1; rank <= 5; rank++) {
    next[`brand_${rank}`] = recommendations[rank - 1]?.brand || '';
    next[`reason_${rank}`] = recommendations[rank - 1]?.reason || '';
  }
  return next;
});

const standardizedColumns = [
  'category', 'condition', 'theme', 'prompt_id', 'model', 'repeat',
  'prompt_changed', 'prompt_revision', 'source_run_stamp', 'prompt', 'reason_status',
  'brand_1', 'canonical_brand_1', 'reason_1',
  'brand_2', 'canonical_brand_2', 'reason_2',
  'brand_3', 'canonical_brand_3', 'reason_3',
  'brand_4', 'canonical_brand_4', 'reason_4',
  'brand_5', 'canonical_brand_5', 'reason_5',
  'canonical_duplicate_ranks', 'canonical_unique_brand_count',
];
const nameMapColumns = [
  'category', 'observed_brand', 'canonical_brand', 'mapping_type',
  'confidence', 'observed_mentions', 'note',
];
const validityColumns = [
  'category', 'condition', 'theme', 'prompt_id', 'model', 'repeat', 'rank',
  'observed_brand', 'canonical_brand', 'flag_type', 'confidence',
  'recommended_action', 'evidence', 'model_reason', 'source_url',
];
const unifiedColumns = [
  'category', 'condition', 'theme', 'prompt_id', 'model', 'repeat',
  'prompt', 'reason_status',
  'brand_1', 'reason_1', 'brand_2', 'reason_2', 'brand_3', 'reason_3',
  'brand_4', 'reason_4', 'brand_5', 'reason_5',
];

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'study3_main_names_standardized.csv'),
  stringify(standardizedRows, { header: true, columns: standardizedColumns })
);
fs.writeFileSync(
  path.join(outputDir, 'study3_brand_name_map.csv'),
  stringify(nameMapRows, { header: true, columns: nameMapColumns })
);
fs.writeFileSync(
  path.join(outputDir, 'study3_content_validity_flags.csv'),
  stringify(validityFlags, { header: true, columns: validityColumns })
);
fs.writeFileSync(
  path.join(outputDir, 'study3_main_brand_names_unified.csv'),
  stringify(unifiedRows, { header: true, columns: unifiedColumns })
);

console.log(JSON.stringify({
  rows: standardizedRows.length,
  totalMentions,
  changedMentions,
  mappingRules: nameMapRows.length,
  activeMappingRules: nameMapRows.filter(row => row.observed_mentions > 0).length,
  canonicalDuplicateTasks: standardizedRows.filter(row => row.canonical_duplicate_ranks).length,
  unifiedMentions: unifiedRows.reduce((total, row) => (
    total + [1, 2, 3, 4, 5].filter(rank => row[`brand_${rank}`]).length
  ), 0),
  validityFlags: validityFlags.length,
  outputDir,
}, null, 2));
