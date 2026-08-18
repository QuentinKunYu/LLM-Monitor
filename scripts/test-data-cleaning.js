const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { extractBrands, standardiseBrands, norm } = require('../lib/brand-extractor');

function loadAliasMap() {
  const csvPath = path.join(__dirname, '..', 'config', 'brand_alias_dictionary.csv');
  const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const aliasMap = {};
  for (const row of rows) {
    aliasMap[`${row.category}|${norm(row.alias)}`] = row.standard_brand;
  }
  return aliasMap;
}

function cleanFromResponse(subCategory, responseText) {
  return standardiseBrands(extractBrands(responseText), loadAliasMap(), subCategory);
}

function numberedList(items) {
  return items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
}

const cases = [
  {
    name: 'json object response',
    category: 'cordless drills',
    responseText: '{"brands":["DeWalt","Makita","Milwaukee","Bosch","Ryobi"]}',
    expected: ['DeWalt', 'Makita', 'Milwaukee', 'Bosch', 'Ryobi'],
  },
  {
    name: 'json array response',
    category: 'cordless drills',
    responseText: '["DeWalt","Makita","Milwaukee","Bosch","Ryobi"]',
    expected: ['DeWalt', 'Makita', 'Milwaukee', 'Bosch', 'Ryobi'],
  },
  {
    name: 'concatenated json object response',
    category: 'humidifier',
    responseText: '{"brands":["Levoit","Crane","Honeywell","Dyson","Vicks"]}{"brands":["Levoit","Crane","Honeywell","Dyson","Vicks"]}',
    expected: ['Levoit', 'Crane', 'Honeywell', 'Dyson', 'Vicks'],
  },
  {
    name: 'plain line fallback',
    category: 'cordless drills',
    responseText: ['DeWalt', 'Makita', 'Milwaukee', 'Bosch', 'Ryobi'].join('\n'),
    expected: ['DeWalt', 'Makita', 'Milwaukee', 'Bosch', 'Ryobi'],
  },
  {
    name: 'cordless drill casing alias',
    category: 'cordless drills',
    raw: ['BLACK+DECKER', 'Black+Decker'],
    expected: ['Black+Decker'],
  },
  {
    name: 'comma separated fallback',
    category: 'cordless drills',
    responseText: 'DeWalt, Makita, Milwaukee, Bosch, Ryobi',
    expected: ['DeWalt', 'Makita', 'Milwaukee', 'Bosch', 'Ryobi'],
  },
  {
    name: 'carry-on luggage casing',
    category: 'carry-on luggage',
    raw: ['TUMI', 'Tumi', 'Samsonite'],
    expected: ['Tumi', 'Samsonite'],
  },
  {
    name: 'camera subbrand',
    category: 'digital camera',
    raw: ['Panasonic Lumix', 'Panasonic', 'Sony'],
    expected: ['Panasonic', 'Sony'],
  },
  {
    name: 'laptop casing',
    category: 'laptop',
    raw: ['Asus', 'ASUS', 'Apple'],
    expected: ['ASUS', 'Apple'],
  },
  {
    name: 'pot phrase and excluded brand',
    category: 'pot',
    raw: ['Made In', 'Stainless steel options from Tramontina', 'All-Clad'],
    expected: ['Tramontina', 'All Clad'],
  },
  {
    name: 'car battery canonical company name',
    category: 'car battery',
    raw: ['Interstate', 'Interstate Batteries', 'Optima'],
    expected: ['Interstate Batteries', 'Optima Batteries'],
  },
  {
    name: 'weight loss misspellings and slash grouping',
    category: 'weight loss pills',
    raw: ['All', 'Xenical/Alli alternative class', 'Qsymia'],
    expected: ['Alli', 'Xenical', 'Qsymia'],
  },
  {
    name: 'hair dye product lines and mojibake',
    category: 'hair dye',
    raw: [
      'L‚ÄôOr√©al Paris Excellence',
      'Wella Color Charm',
      'Clairol Nice‚Äôn Easy',
      'Garnier Olia',
      'Revlon Colorsilk',
    ],
    expected: ['L’Oréal', 'Wella', 'Clairol', 'Garnier', 'Revlon'],
  },
  {
    name: 'hiking jacket apostrophe mojibake',
    category: 'hiking jacket',
    raw: ['Arc‚Äôteryx', "Arc'teryx", 'Patagonia'],
    expected: ["Arc'teryx", 'Patagonia'],
  },
  {
    name: 'battery and supplement cleanup',
    category: 'car battery',
    raw: ['Optima', 'Interstate'],
    expected: ['Optima Batteries', 'Interstate Batteries'],
  },
  {
    name: 'humidifier JSON fragment cleanup',
    category: 'humidifier',
    raw: ['{“brands”', 'Crane', 'Dyson'],
    expected: ['Crane', 'Dyson'],
  },
  {
    name: 'weight loss supplement variants',
    category: 'weight loss pills',
    raw: ['Garcinia Cambogia Plus', 'Hydroxicut', 'Oxyshred', 'Zantrex-3'],
    expected: ['Garcinia Cambogia', 'Hydroxycut', 'OxyShred', 'Zantrex'],
  },
  {
    name: 'new category aliases',
    category: 'boat cruises',
    raw: ['NCL', 'Royal Caribbean International', 'Oceania'],
    expected: ['Norwegian Cruise Line', 'Royal Caribbean', 'Oceania Cruises'],
  },
  {
    name: 'observed new category other aliases',
    category: 'cat food',
    raw: ['Purina Pro Plan', "Hill's Science Diet", 'Royal Canin', 'Blue Buffalo', 'Wellness'],
    expected: ['Purina', "Hill's Science Diet", 'Royal Canin', 'Blue Buffalo', 'Wellness'],
  },
  {
    name: 'observed new category cruise aliases',
    category: 'boat cruises',
    raw: ['Princess', 'Celebrity', 'Carnival Cruise Line'],
    expected: ['Princess Cruises', 'Celebrity Cruises', 'Carnival'],
  },
  {
    name: 'observed coffee maker DeLonghi variants',
    category: 'coffee maker',
    raw: ['DeLonghi', "De'Longhi", 'De Longhi', 'Delonghi', 'Breville'],
    expected: ["De'Longhi", 'Breville'],
  },
  {
    name: 'observed hiking jacket REI variants',
    category: 'hiking jacket',
    raw: ['REI', 'REI Co-op', 'REI Coop', 'Patagonia'],
    expected: ['REI Co-op', 'Patagonia'],
  },
  {
    name: 'observed hiking jacket Lululemon variants',
    category: 'hiking jacket',
    raw: ['lululemon', 'Lululemon', 'Patagonia'],
    expected: ['Lululemon', 'Patagonia'],
  },
  {
    name: 'observed cat food subbrand variants',
    category: 'cat food',
    raw: ['Purina ONE', 'Purina One', 'Purina Fancy Feast', "Hill's", 'Wellness Core'],
    expected: ['Purina', 'Fancy Feast', "Hill's Science Diet", 'Wellness'],
  },
  {
    name: 'observed cat food Smallbatch variants',
    category: 'cat food',
    raw: ['SmallBatch', 'Smallbatch', 'SmallBatch Pets', 'Tiki Cat'],
    expected: ['Smallbatch', 'Tiki Cat'],
  },
];

for (const testCase of cases) {
  const responseText = testCase.responseText || numberedList(testCase.raw);
  const actual = cleanFromResponse(testCase.category, responseText);
  assert.deepStrictEqual(actual, testCase.expected, testCase.name);
}

console.log(`Data cleaning tests passed (${cases.length} cases).`);
