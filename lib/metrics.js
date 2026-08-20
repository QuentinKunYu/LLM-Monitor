/**
 * Metrics Calculation Module
 * ──────────────────────────
 * Computes BRP@K (Brand Recommendation Probability at K) and MRR
 * (Mean Reciprocal Rank) for EVERY brand that appeared in the results.
 *
 * APPROACH: This module discovers all unique brands across all replicates and
 * calculates metrics for each one. Brands that were never mentioned
 * are simply not included in the output.
 *
 * ── BRP@K ──────────────────────────────────────────────────────────
 * BRP@K = (# replicates where brand appears in ranks 1..K) / total replicates
 *
 * Example: brand in top-5 in 34 of 40 replicates → BRP@5 = 34/40 = 0.85
 *
 * ── MRR ────────────────────────────────────────────────────────────
 * For each replicate, reciprocal rank = 1/rank if mentioned, else 0.
 *   rank 1 → 1,  rank 2 → 0.5,  rank 3 → 0.333,  rank 4 → 0.25,  rank 5 → 0.2
 *
 * MRR = mean of reciprocal ranks across all replicates.
 *
 * Example: ranks [1, 2, -, 4, 2] → MRR = (1+0.5+0+0.25+0.5)/5 = 0.45
 */

/**
 * Calculate metrics for ALL brands that appeared in the results.
 *
 * @param {Object[]} rawResults   – array of result rows, each with brand_1..brand_5
 * @param {string}   subCategory  – sub_category label for the output
 * @param {string}   modelId      – model identifier for the output
 * @param {string}   promptCondition – prompt condition identifier
 * @returns {Object[]} metrics rows sorted by total appearances (desc)
 */
function calculateMetrics(rawResults, subCategory, modelId, promptCondition = '') {
  const R = rawResults.length;  // total number of replicates
  if (R === 0) return [];

  // ── Step 1: Discover all unique brands across all replicates ─────
  //    and collect per-brand rank data
  const brandData = {};   // brand → { brp1, brp3, brp5, rrSum, totalMentions }

  for (const row of rawResults) {
    for (let k = 1; k <= 5; k++) {
      const brand = row[`brand_${k}`];
      if (!brand || brand.trim() === '') continue;

      if (!brandData[brand]) {
        brandData[brand] = { brp1: 0, brp3: 0, brp5: 0, rrSum: 0, totalMentions: 0 };
      }
    }
  }

  // ── Step 2: For each brand, scan all replicates for rank ──────────
  for (const brand of Object.keys(brandData)) {
    const data = brandData[brand];

    for (const row of rawResults) {
      // Find the rank of this brand in the replicate (1-indexed)
      let rank = null;
      for (let k = 1; k <= 5; k++) {
        if (row[`brand_${k}`] === brand) {
          rank = k;
          break;  // use the first (highest) position
        }
      }

      if (rank !== null) {
        data.totalMentions++;
        if (rank <= 1) data.brp1++;
        if (rank <= 3) data.brp3++;
        if (rank <= 5) data.brp5++;
        data.rrSum += 1.0 / rank;
        // If brand not mentioned in this replicate → reciprocal rank = 0 (default)
      }
    }
  }

  // ── Step 3: Build output rows sorted by total mentions desc ──────
  const metrics = Object.entries(brandData)
    .map(([brand, data]) => ({
      sub_category: subCategory,
      model_id: modelId,
      prompt_condition: promptCondition,
      brand,
      n_replicates: R,
      total_mentions: data.totalMentions,
      'BRP@1': (data.brp1 / R).toFixed(4),
      'BRP@3': (data.brp3 / R).toFixed(4),
      'BRP@5': (data.brp5 / R).toFixed(4),
      'MRR':   (data.rrSum / R).toFixed(4),
    }))
    .sort((a, b) => b.total_mentions - a.total_mentions);  // most frequent first

  return metrics;
}

module.exports = { calculateMetrics };
