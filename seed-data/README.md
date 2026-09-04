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

Figures 2, 3, 4, and 5 in the paper aggregate these per-model rows across
the six LLMs before plotting; that aggregation step is not yet checked
into this repository (see "Still missing" below).

## Still missing before this folder backs the paper's data-availability claim

- The merged brand-level marketplace-visibility dataset (BrandZ salience,
  log ad spend, log press mentions, log Brandwatch mentions, log Google
  Trends, log Wikipedia views, sqrt(MRR)) for the n=82 brands used in
  Figures 2-5 and the ridge/lasso regression. The closest artifact in the
  working tree, `data/analysis/LLM_vs_RealWorld_Brand_Metrics.xlsx`,
  covers a broader 104-brand universe with different predictors (BrandZ
  Meaningful/Different/Salient, Aspiration Score, Demand/Pricing Power)
  and no Brandwatch column, so it is a different dataset and has not been
  copied here.
- The R script that fits the fractional-logit ridge/lasso model
  (`glm`/`glmnet`, quasibinomial family) described in "Explaining Brand
  Recommendation Prominence." No `.R` file currently exists anywhere in
  the repository; `scripts/run-rq1-logit.R` was deleted, and based on
  `data/analysis/rq1/rq1_summary.md`, it was an earlier logistic-regression
  approach (binary visibility groups) that was superseded by the paper's
  final continuous-predictor ridge method.
- A data dictionary documenting variable definitions, sources, and
  collection periods (BrandZ, Kantar, LexisNexis, Brandwatch, Google
  Trends, Wikipedia) and the search specifications / category anchors
  referenced in Methodology ("Full definitions, sources, and collection
  periods are provided in the supplement").

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
