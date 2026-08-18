/**
 * Brand Extractor Module
 * ──────────────────────
 * Extracts up to five brand names from an LLM response and
 * standardises them using the alias dictionary.
 *
 * Strategy:
 *   1. Try to detect a numbered list (1. Brand — …  or  1) Brand: …)
 *   2. Try to detect bold markdown headers (**Brand** — …)
 *   3. Fallback: split on double-newlines and grab the first word-group.
 *
 * After extraction the raw brand strings are matched against the alias
 * dictionary for the given sub-category, normalising casing, accents,
 * and common abbreviations (e.g. "TNF" → "The North Face").
 */

// ── Normalisation helper (mirrors Python `norm()`) ─────────────────
function norm(s) {
  if (!s) return '';
  s = repairText(s);
  // NFKD decomposition → strip combining marks → lowercase
  return s.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairText(s) {
  return String(s)
    .replace(/‚Äô|‚Äò|‚Äô/g, "'")
    .replace(/‚Äì|‚Äî/g, '-')
    .replace(/‚Äú|‚Äù/g, '"')
    .replace(/‚Ä¢/g, '-')
    .replace(/√©/g, 'é')
    .replace(/√®/g, 'è')
    .replace(/√º/g, 'ü')
    .replace(/’|‘/g, "'")
    .replace(/“|”/g, '"')
    .replace(/\u00c2/g, '');
}

function cleanBrandCandidate(value) {
  if (!value) return '';

  let brand = repairText(value).trim();
  brand = brand
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/g, '')
    .replace(/^[\s{"'\[]+/, '')
    .replace(/[\s,"'\]}]+$/, '')
    .trim();

  const boldMatch = brand.match(/^\*\*([^*]+?)\*\*/);
  if (boldMatch) {
    brand = boldMatch[1].trim();
  }

  brand = brand
    .replace(/^\*+|\*+$/g, '')
    .replace(/[\(\[].*$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .trim();

  const delimiterIdx = brand.search(/\s[—–]\s|:/);
  if (delimiterIdx > 0) {
    brand = brand.substring(0, delimiterIdx).trim();
  }

  // If the model groups sibling brands in one rank, keep the first
  // named brand rather than treating the whole phrase as a new brand.
  if (/\s*\/\s*/.test(brand)) {
    brand = brand.split(/\s*\/\s*/)[0].trim();
  }

  brand = brand.replace(/\s+/g, ' ').trim();
  const lower = brand.toLowerCase();
  const exactNonBrands = new Set([
    'brands',
    'brand',
    'json',
    '{',
    '}',
    '[',
    ']',
  ]);
  if (exactNonBrands.has(lower)) return '';

  const nonBrandPhrases = [
    'evidence-based',
    'regulated options',
    'healthcare professional',
    'weight-loss medications',
    'common prescription',
    'prescription-only',
    'prescription only',
    'up to five brands',
    'brand names',
    'common options',
  ];
  if (nonBrandPhrases.some(phrase => lower.includes(phrase))) return '';

  return brand;
}

function pushUniqueBrand(brands, candidate) {
  const brand = cleanBrandCandidate(candidate);
  if (!brand || brand.length >= 80) return;
  if (brands.some(existing => norm(existing) === norm(brand))) return;
  brands.push(brand);
}

function parseJSONBrands(responseText) {
  const candidates = [];
  const text = repairText(responseText)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  candidates.push(text);

  for (const segment of extractJSONSegments(text)) {
    candidates.push(segment);
  }

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const values = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed.brands) ? parsed.brands : []);

      const brands = [];
      for (const value of values) {
        if (typeof value === 'string') {
          pushUniqueBrand(brands, value);
        } else if (value && typeof value === 'object') {
          pushUniqueBrand(brands, value.brand || value.name);
        }
        if (brands.length >= 5) break;
      }
      if (brands.length >= 1) return brands;
    } catch (_) {
      // Try the next candidate.
    }
  }

  return [];
}

function parseLooseJSONBrands(responseText) {
  const text = repairText(responseText)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const brandsKey = text.match(/["']?brands["']?\s*:\s*\[([\s\S]*)/i);
  if (!brandsKey) return [];

  const listText = brandsKey[1].split(/\]\s*[,}]*\s*$/)[0];
  const brands = [];
  const quotedPattern = /"((?:\\.|[^"\\])+)"/g;
  let match;
  while ((match = quotedPattern.exec(listText)) !== null && brands.length < 5) {
    pushUniqueBrand(brands, match[1]);
  }
  if (brands.length === 0) {
    const singleQuotedPattern = /'((?:\\.|[^'\\])*)'/g;
    while ((match = singleQuotedPattern.exec(listText)) !== null && brands.length < 5) {
      pushUniqueBrand(brands, match[1]);
    }
  }
  return brands;
}

function extractJSONSegments(text) {
  const segments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === '}' || ch === ']') && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        segments.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return segments;
}

function applyCategoryCleaning(rawBrand, subCategory) {
  const brand = cleanBrandCandidate(rawBrand);
  const n = norm(brand);
  if (!brand) return '';

  if (subCategory === 'carry-on luggage') {
    if (n === 'tumi') return 'Tumi';
  }

  if (subCategory === 'digital camera') {
    if (n === 'panasonic lumix' || n.startsWith('panasonic lumix ')) return 'Panasonic';
  }

  if (subCategory === 'humidifier') {
    if (n === 'brands') return '';
    if (n === 'crane') return 'Crane';
    if (n === 'dyson') return 'Dyson';
  }

  if (subCategory === 'laptop') {
    if (n === 'asus') return 'ASUS';
  }

  if (subCategory === 'pot') {
    if (n === 'made in') return '';
    if (n === 'stainless steel options from tramontina') return 'Tramontina';
  }

  if (subCategory === 'car battery') {
    if (n === 'interstate') return 'Interstate Batteries';
    if (n === 'optima') return 'Optima Batteries';
  }

  if (subCategory === 'weight loss pills') {
    if (n === 'all') return 'Alli';
    if (n === 'xanical' || n === 'xanical alli') return 'Xenical';
    if (n === 'garcinia cambogia plus') return 'Garcinia Cambogia';
    if (n === 'hydroxicut') return 'Hydroxycut';
    if (n === 'oxyshred') return 'OxyShred';
    if (n === 'zantrex 3') return 'Zantrex';
  }

  if (subCategory === 'hair dye') {
    if (n === 'wella color charm' || n === 'wella colorcharm') return 'Wella';
    if (n === 'l oreal' || n === 'loreal' || n.startsWith('l oreal paris') || n.startsWith('loreal paris')) return 'L’Oréal';
    if (n.startsWith('clairol nice')) return 'Clairol';
    if (n === 'garnier nutrisse' || n === 'garnier olia') return 'Garnier';
    if (n === 'revlon colorsilk' || n === 'revlon color silk') return 'Revlon';
  }

  if (subCategory === 'hiking jacket') {
    if (n === 'arc teryx' || n === 'arcteryx') return "Arc'teryx";
    if (n === 'arc teryx veilance' || n === 'veilance') return "Arc'teryx";
    if (n === 'rei' || n === 'rei co op' || n === 'rei coop') return 'REI Co-op';
    if (n === 'llbean' || n === 'l l bean') return 'L.L. Bean';
    if (n === 'fjallraven') return 'Fjällräven';
    if (n === 'vaude') return 'VAUDE';
    if (n === 'rains') return 'RAINS';
    if (n === 'tentree') return 'Tentree';
    if (n === 'picture organic' || n === 'picture organic clothing') return 'Picture Organic Clothing';
    if (n === 'houdini') return 'Houdini Sportswear';
    if (n === 'decathlon quechua' || n === 'quechua') return 'Decathlon';
  }

  if (subCategory === 'cordless drills') {
    if (n === 'milwaukee tool') return 'Milwaukee';
    if (n === 'craftsman') return 'Craftsman';
    if (n === 'ridgid') return 'Ridgid';
    if (n === 'skil') return 'SKIL';
    if (n === 'porter cable') return 'Porter-Cable';
    if (n === 'metabo hpt') return 'Metabo HPT';
    if (n === 'avid power') return 'Avid Power';
    if (n === 'bauer') return 'Bauer';
    if (n === 'hart') return 'HART';
    if (n === 'hercules') return 'Hercules';
    if (n === 'workpro') return 'WORKPRO';
    if (n === 'wen') return 'WEN';
    if (n === 'worx') return 'WORX';
    if (n === 'flex') return 'FLEX';
  }

  if (subCategory === 'coffee maker') {
    if (n === 'aeropress') return 'AeroPress';
    if (n === 'black decker') return 'Black+Decker';
    if (n === 'bunn') return 'BUNN';
    if (n === 'cafe bustelo') return 'Café Bustelo';
    if (n === 'dunkin') return "Dunkin'";
    if (n === 'illy') return 'Illy';
    if (n === 'krups') return 'KRUPS';
    if (n === 'oxo brew') return 'OXO';
    if (n === 'ge appliances') return 'GE';
    if (n === 'blue bottle coffee') return 'Blue Bottle';
    if (n === 'counter culture coffee') return 'Counter Culture';
    if (n === 'eight o clock coffee') return "Eight O'Clock";
    if (n === 'flair espresso') return 'Flair';
    if (n === 'hamilton beach flexbrew') return 'Hamilton Beach';
    if (n === 'intelligentsia coffee') return 'Intelligentsia';
    if (n === 'lavazza a modo mio') return 'Lavazza';
    if (n === 'nescafe' || n === 'nescafe dolce gusto' || n === 'dolce gusto') return 'Nescafé';
    if (n === 'stumptown coffee roasters') return 'Stumptown';
  }

  if (subCategory === 'cat food') {
    if (n === '9lives') return '9 Lives';
    if (n.startsWith('blue buffalo') || n === 'blue natural veterinary diet ks kidney support') return 'Blue Buffalo';
    if (n === 'darwin' || n.startsWith('darwin s natural')) return "Darwin's Natural Pet Products";
    if (n.startsWith('eukanuba veterinary')) return 'Eukanuba';
    if (n.startsWith('fancy feast')) return 'Fancy Feast';
    if (n.startsWith('farmina vet life')) return 'Farmina Vet Life';
    if (n.startsWith('forza10')) return 'Forza10';
    if (n === 'hill' || n === 'hills' || n.startsWith('hill s prescription diet') || n.startsWith('hill s science diet') || n.startsWith('hills prescription diet') || n.startsWith('hills science diet')) return "Hill's Science Diet";
    if (n.startsWith('iams proactive') || n.startsWith('iams veterinary')) return 'Iams';
    if (n === 'instinct pet food' || n === 'instinct by nature s variety') return 'Instinct';
    if (n === 'justcats' || n === 'justfoodforcats') return 'Just Food For Cats';
    if (n === 'nomnomnow') return 'Nom Nom';
    if (n.startsWith('purina pro plan') || n.startsWith('purina cat chow') || n.startsWith('purina friskies')) return 'Purina';
    if (n === 'rachael ray nutrish') return 'Rachael Ray Nutrish';
    if (n.startsWith('royal canin')) return 'Royal Canin';
    if (n === 'sheba perfect portions' || n.startsWith('sheba perfect portions') || n.startsWith('sheba wet') || n === 'sheba premium') return 'Sheba';
    if (n === 'smallbatch pets') return 'SmallBatch';
    if (n === 'smalls for cats') return 'Smalls';
    if (n.startsWith('tiki cat') || n === 'tiki cats') return 'Tiki Cat';
    if (n.startsWith('wellness core') || n.startsWith('wellness complete')) return 'Wellness';
    if (n.startsWith('weruva')) return 'Weruva';
    if (n === 'ziwi peak') return 'Ziwi Peak';
  }

  if (subCategory === 'boat cruises') {
    if (n === 'carnival cruise line') return 'Carnival';
    if (n === 'holland america line') return 'Holland America';
    if (n === 'cunard line') return 'Cunard';
    if (n === 'crystal cruises') return 'Crystal';
    if (n === 'emerald waterways') return 'Emerald Cruises';
    if (n === 'norwegian cruise line' || n === 'ncl') return 'Norwegian Cruise Line';
    if (n === 'p o cruises adult only sailings') return 'P&O Cruises';
    if (n === 'pandaw river expeditions') return 'Pandaw';
    if (n === 'regent seven seas cruises') return 'Regent Seven Seas';
    if (n === 'riu hotels resorts') return 'RIU';
    if (n === 'royal caribbean international') return 'Royal Caribbean';
    if (n === 'sandals resorts') return 'Sandals';
    if (n === 'scenic cruises' || n === 'scenic luxury cruises' || n === 'scenic luxury cruises tours' || n === 'scenic river cruises') return 'Scenic';
    if (n === 'seabourn cruise line') return 'Seabourn';
    if (n === 'secrets resorts spas') return 'Secrets Resorts';
    if (n === 'silversea cruises') return 'Silversea';
    if (n === 'tauck river cruises' || n === 'tauck river cruising') return 'Tauck';
    if (n === 'uncruise adventures') return 'Un-Cruise Adventures';
    if (n.startsWith('uniworld boutique river')) return 'Uniworld';
    if (n === 'viking cruises' || n === 'viking ocean cruises' || n === 'viking river cruises') return 'Viking';
  }

  return brand;
}

// ── Extract brands from response text ──────────────────────────────
function extractBrands(responseText) {
  if (!responseText) return [];

  const brands = [];

  // Strategy 0 — structured JSON prompt:
  // {"brands":["Canon","Nikon","Sony","Fujifilm","Leica"]}
  const jsonBrands = parseJSONBrands(responseText);
  if (jsonBrands.length >= 1) return jsonBrands.slice(0, 5);

  const looseJSONBrands = parseLooseJSONBrands(responseText);
  if (looseJSONBrands.length >= 1) return looseJSONBrands.slice(0, 5);

  // Strategy 1 — numbered lines: "1. **Canon** — ..." or "1. Canon"
  const numberedLinePattern = /(?:^|\n)\s*\d+[\.\)]\s*([^\n]+)/gm;
  let match;
  while ((match = numberedLinePattern.exec(responseText)) !== null && brands.length < 5) {
    pushUniqueBrand(brands, match[1]);
  }
  if (brands.length >= 1) return brands.slice(0, 5);

  // Strategy 2 — numbered list with inline delimiter
  const numberedPattern = /(?:^|\n)\s*\d+[\.\)]\s*\**([^*:\n—–-]+?)[\*]*\s*[:\—–\-]/gm;
  while ((match = numberedPattern.exec(responseText)) !== null && brands.length < 5) {
    pushUniqueBrand(brands, match[1]);
  }
  if (brands.length >= 2) return brands.slice(0, 5);

  // Strategy 3 — bold markdown: "**Canon** — ..."
  const boldPattern = /\*\*([^*]+?)\*\*/g;
  const boldBrands = [];
  while ((match = boldPattern.exec(responseText)) !== null && boldBrands.length < 5) {
    pushUniqueBrand(boldBrands, match[1]);
  }
  if (boldBrands.length >= 2) return boldBrands.slice(0, 5);

  // Strategy 4 — strict prompt fallback: brand names on plain lines,
  // or a single comma-separated line when the model skips numbering.
  const plainLines = responseText
    .split(/\n+/)
    .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

  if (plainLines.length >= 2) {
    for (const line of plainLines) {
      if (brands.length >= 5) break;
      pushUniqueBrand(brands, line);
    }
    if (brands.length >= 2) return brands.slice(0, 5);
  }

  if (plainLines.length === 1 && plainLines[0].includes(',')) {
    for (const part of plainLines[0].split(',')) {
      if (brands.length >= 5) break;
      pushUniqueBrand(brands, part);
    }
    if (brands.length >= 2) return brands.slice(0, 5);
  }

  return brands.slice(0, 5);
}

// ── Standardise brands using alias dictionary ──────────────────────
/**
 * @param {string[]} rawBrands  - ordered list of extracted brand strings
 * @param {Object} aliasMap     - { "sub_category|normalised_alias": "StandardBrand" }
 * @param {string} subCategory  - the sub_category key
 * @returns {string[]} standardised brand names (same order)
 */
function standardiseBrands(rawBrands, aliasMap, subCategory) {
  const standardBrands = [];
  for (const raw of rawBrands) {
    const cleaned = applyCategoryCleaning(raw, subCategory);
    if (!cleaned) continue;

    const key = `${subCategory}|${norm(cleaned)}`;
    const standard = aliasMap[key] || cleaned;
    if (!standard || standardBrands.some(existing => norm(existing) === norm(standard))) continue;
    standardBrands.push(standard);
  }
  return standardBrands;
}

module.exports = { extractBrands, standardiseBrands, norm };
