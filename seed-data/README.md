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
- `marketplace/metric_metadata.csv` — collection date, period, and source
  for every marketplace metric above, including the exact LexisNexis
  search strings per category (e.g. cordless drills:
  `"[brand]" AND ("cordless drill" OR "power drill")`) and the Google
  Trends anchor-normalization formula. This is the "full definitions,
  sources, and collection periods" / "search specifications, category
  anchors" content the Methodology section promises is in the supplement.
  Source: `brand_metrics_salient.xlsx`, "Metric Metadata" sheet.

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

## Regression artifact (resolves the three items formerly listed as missing)

- `regression/all.csv` -- the full merged brand-level dataset (100 rows
  across the 5 categories) joining LLM recommendation metrics (BRP1/3/5,
  MRR) with BrandZ equity, Kantar Ad Spend, Wikipedia, LexisNexis News,
  Google Trends, Statista market share, AND Brandwatch mention volume.
  Filtering to complete cases on the 5 marketplace-visibility predictors +
  MRR + Category yields exactly n=82, matching the paper's reported ridge
  regression sample size.
- `regression/LLMmonitorJAR.Rmd` -- the actual R script that fits the
  fractional-logit ridge/lasso model (`glmnet`, quasibinomial family,
  `cv.glmnet` for lambda selection) plus lasso and OLS robustness checks,
  matching the paper's "Explaining Brand Recommendation Prominence"
  section. Received already anonymized (the `setwd()` path reads
  `/Users/XXX/...`).
- Received from a collaborator along with `all.xlsx` and a knitted
  `llmmonitorJAS.html` -- **neither of those two is included here.**
  `all.xlsx`'s hidden file metadata (`docProps/core.xml`) names the
  collaborator's full real name as last-modified-by, and its
  `workbook.xml` embeds their real `/Users/<initials>/...` file path;
  the `.html` knit output echoes that same real path in visible source
  code. `all.csv` carries none of this (plain text, no metadata), so it
  fully replaces the `.xlsx` for this repo.
- The collaborator noted the ridge results are changing slightly and the
  manuscript will be updated to match -- check with them before finalizing
  Figures 4-5 numbers in the paper text.

## Deliberately excluded

- `public/aspiration-scores.json` and
  `data/analysis/LLM_vs_RealWorld_Brand_Metrics.xlsx` — belong to a
  related but separate aspiration-scoring project not referenced anywhere
  in this paper; the former also names the human coders who scored it.
- `public/predictor-correlations.json` and `data/analysis/rq1/*` — earlier
  exploratory analyses with a different sample size and predictor set that
  don't match the numbers reported in the paper.

Fill the three gaps above before publishing the anonymized link, or the
supplement will not actually contain what the paper's text promises.
