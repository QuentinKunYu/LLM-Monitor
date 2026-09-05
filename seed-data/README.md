# Supplementary Data for "The Silent Gatekeeper" (JAR submission)

This folder contains the curated public snapshots referenced in the paper's
Methodology and Results sections ("the online supplement" / "our anonymous
GitHub site").

## What's here

- `prompts/needs_based_prompts.csv` — the 200-prompt needs-based library (5
  categories x 40 prompts) referenced in Methodology ("The complete set of
  prompts is available in the online supplement"). Source:
  `config/needs_based_prompts_category_explicit_v2.csv`.
- `prompts/craftsman_llbean_positioning_probes.csv` — the diagnostic
  positioning-probe prompts for Craftsman and L.L.Bean used in the
  needs-based illustrative case (Diagnose stage / positioning probes).
  Source: `data/analysis/needs_based_probe_craftsman_llbean.csv`.
- `results/context_free_brand_metrics.csv` — per-model, per-brand,
  per-category BRP@1/3/5 and MRR from the category-only (context-free)
  baseline (1,200 recommendation lists). Source:
  `data/final/context_free_brand_metrics.csv`.
- `results/needs_based_brand_metrics.csv` — per-model, per-brand,
  per-category BRP@1/3/5 and MRR from the needs-based condition (2,400
  recommendation lists). Source: `data/final/needs_based_brand_metrics.csv`.
- `marketplace/brand_metrics_salient.csv` — per-brand, per-category
  marketplace measures: BrandZ brand equity (Meaningful, Different,
  Salient, Demand Power, Pricing Power), Kantar Brand/Ad Spend, Wikipedia
  page views, LexisNexis (Nexis Uni) press mentions (brand-only and
  brand+category), and Google Trends (brand-only and brand+category).
  Aspiration Score has been dropped from this export -- it belongs to a
  separate, unrelated coding exercise (see "Deliberately excluded" below)
  and is not used anywhere in this paper. Source:
  `brand_metrics_salient.xlsx` (research folder root, "BrandData"-style
  per-category sheets).
- `marketplace/brandwatch_mentions.csv` — estimated 12-month Brandwatch
  mention volume for the same 104-brand, five-category universe. Values
  are available for 103 brands; `City Cruises by Hornblower` is the only
  missing observation. Source: the Brandwatch column in
  `brand_metrics_merged.xlsx`.
- `marketplace/metric_metadata.csv` — collection date, period, and source
  for the marketplace metrics above, including the exact LexisNexis
  search strings per category (e.g. cordless drills:
  `"[brand]" AND ("cordless drill" OR "power drill")`) and the Google
  Trends anchor-normalization formula. The Brandwatch rows record the
  information preserved with the available source: August 2026 collection,
  a rolling 12-month period, and a 5% sampled estimate scaled by 20.
  Source: `brand_metrics_salient.xlsx`, "Metric Metadata" sheet, plus the
  Brandwatch source note in `brand_metrics_merged.xlsx`.

Figures 2, 3, 4, and 5 in the paper aggregate the per-model result rows
across the six LLMs and merge them with the marketplace measures before
plotting; that aggregation/merge step is not yet checked into this
repository (see "Still missing" below).

## Also included

- `study1/raw_results.csv` and `study3/raw_results.csv` -- the full raw,
  per-replicate LLM responses (prompt + response text) behind the
  category-only (study1) and needs-based (study3) conditions. Pulled from
  this project's separate (non-anonymized) deployment repository, which
  already had these committed. This is the rawest level of the data
  -- more complete than `results/*_brand_metrics.csv` above, since anyone
  can recompute BRP/MRR from these directly. Checked for identifying
  strings before copying; found none.

## Brandwatch provenance limitation

The Brandwatch values are now included, but the available source does not
preserve the exact start and end dates, per-brand query syntax, geographic
or language filters, or the original Brandwatch export. The numbers support
inspection and merging, but those missing collection details still limit
independent reproduction of the measure.

## Still missing before this folder backs the paper's data-availability claim

- **The merged n=82 brand-level dataset** actually used in the ridge/lasso
  regression (Figures 4-5), i.e. `brand_metrics_salient.csv` joined with
  the aggregated MRR/BRP results and restricted/filtered down to n=82
  brands. Not found as a saved artifact anywhere.
- **The final R script** that fits the fractional-logit ridge/lasso model
  (`glm`/`glmnet`, quasibinomial family) described in "Explaining Brand
  Recommendation Prominence." The included `scripts/run-rq1-logit.R` is an earlier
  logistic-regression approach (binary visibility groups) superseded by
  the paper's final continuous-predictor ridge method -- not a substitute.

## Deliberately excluded

- `public/aspiration-scores.json` and
  `data/analysis/LLM_vs_RealWorld_Brand_Metrics.xlsx` — belong to a
  related but separate aspiration-scoring project not referenced anywhere
  in this paper; the former also names the human coders who scored it.
- `public/predictor-correlations.json` and `data/analysis/rq1/*` — earlier
  exploratory analyses with a different sample size and predictor set that
  don't match the numbers reported in the paper.

Fill the two remaining gaps above and complete the Brandwatch provenance
details before publishing the anonymized link, or the
supplement will not actually contain what the paper's text promises.
