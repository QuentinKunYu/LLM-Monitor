const { norm } = require('./brand-extractor');

const REASON_FIELD_NAMES = [
  'reason_prompt',
  'reason_response_text',
  'reason_1',
  'reason_2',
  'reason_3',
  'reason_4',
  'reason_5',
  'reason_status',
  'reason_error'
];

const BRAND_REASON_LONG_HEADERS = [
  'study',
  'run_id',
  'category',
  'sub_category',
  'prompt_condition',
  'theme',
  'prompt_id',
  'model_id',
  'model_name',
  'replicate',
  'repeat_index',
  'rank',
  'brand',
  'reason',
  'reason_status',
  'reason_error',
  'prompt',
  'reason_prompt'
];

function nonEmptyBrands(brands) {
  return (brands || []).map((brand) => String(brand || '').trim()).filter(Boolean);
}

function buildReasonPrompt(originalPrompt, brands) {
  const brandList = nonEmptyBrands(brands).map((brand) => `- ${brand}`).join('\n');
  return `The user asked:
${originalPrompt}

You recommended these brands:
${brandList}

Why did you recommend these brands?
Return valid JSON only, with this schema:
{"reasons":[{"brand":"Brand name","reason":"Short reason"}]}
Do not include markdown, numbering, or text outside the JSON object.`;
}

function blankReasonFields(status = '', error = '') {
  return {
    reason_prompt: '',
    reason_response_text: '',
    reason_1: '',
    reason_2: '',
    reason_3: '',
    reason_4: '',
    reason_5: '',
    reason_status: status,
    reason_error: error
  };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
  }

  return null;
}

function alignReasonsFromResponse(responseText, brands) {
  const cleanBrands = nonEmptyBrands(brands);
  const aligned = ['', '', '', '', ''];
  if (!responseText) {
    return { reasons: aligned, error: 'Missing reason response.' };
  }

  let parsed;
  try {
    parsed = extractJsonObject(responseText);
  } catch (error) {
    return { reasons: aligned, error: `Invalid reason JSON: ${error.message}` };
  }

  const reasonItems = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.reasons)
      ? parsed.reasons
      : [];

  if (!reasonItems.length) {
    return { reasons: aligned, error: 'Reason JSON did not include a non-empty reasons array.' };
  }

  const byBrand = new Map();
  reasonItems.forEach((item) => {
    const brand = String(item?.brand || '').trim();
    const reason = String(item?.reason || '').trim();
    if (brand && reason) byBrand.set(norm(brand), reason);
  });

  cleanBrands.forEach((brand, index) => {
    const matchedReason = byBrand.get(norm(brand));
    const positionalReason = String(reasonItems[index]?.reason || '').trim();
    aligned[index] = matchedReason || positionalReason || '';
  });

  const missingCount = cleanBrands.filter((_, index) => !aligned[index]).length;
  return {
    reasons: aligned,
    error: missingCount ? `Missing reasons for ${missingCount} recommended brand(s).` : ''
  };
}

function reasonFieldsFromResponse(originalPrompt, brands, responseText, status = 'completed', error = '') {
  const reasonPrompt = buildReasonPrompt(originalPrompt, brands);
  const aligned = alignReasonsFromResponse(responseText, brands);
  const finalError = error || aligned.error;
  const finalStatus = finalError ? 'error' : status;
  return {
    reason_prompt: reasonPrompt,
    reason_response_text: String(responseText || ''),
    reason_1: aligned.reasons[0] || '',
    reason_2: aligned.reasons[1] || '',
    reason_3: aligned.reasons[2] || '',
    reason_4: aligned.reasons[3] || '',
    reason_5: aligned.reasons[4] || '',
    reason_status: finalStatus,
    reason_error: finalError
  };
}

function dryRunReasonResponse(brands) {
  return JSON.stringify({
    reasons: nonEmptyBrands(brands).map((brand) => ({
      brand,
      reason: `${brand} is a relevant, recognizable option for this recommendation context.`
    }))
  });
}

function withBlankReasonFields(row, status = '', error = '') {
  return {
    ...row,
    ...blankReasonFields(status, error)
  };
}

function buildBrandReasonRows(rows) {
  const longRows = [];
  for (const row of rows || []) {
    for (let rank = 1; rank <= 5; rank += 1) {
      const brand = String(row[`cleaned_brand_${rank}`] || row[`brand_${rank}`] || '').trim();
      if (!brand) continue;
      longRows.push({
        study: row.study || '',
        run_id: row.run_id || '',
        category: row.category || row.sub_category || '',
        sub_category: row.sub_category || row.category || '',
        prompt_condition: row.prompt_condition || '',
        theme: row.theme || '',
        prompt_id: row.prompt_id || '',
        model_id: row.model_id || '',
        model_name: row.model_name || '',
        replicate: row.replicate || '',
        repeat_index: row.repeat_index || '',
        rank,
        brand,
        reason: row[`reason_${rank}`] || '',
        reason_status: row.reason_status || '',
        reason_error: row.reason_error || '',
        prompt: row.prompt || '',
        reason_prompt: row.reason_prompt || ''
      });
    }
  }
  return longRows;
}

module.exports = {
  REASON_FIELD_NAMES,
  BRAND_REASON_LONG_HEADERS,
  buildReasonPrompt,
  alignReasonsFromResponse,
  blankReasonFields,
  reasonFieldsFromResponse,
  dryRunReasonResponse,
  withBlankReasonFields,
  buildBrandReasonRows
};
