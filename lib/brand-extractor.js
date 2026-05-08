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
