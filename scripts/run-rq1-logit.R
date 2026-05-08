#!/usr/bin/env Rscript

root <- normalizePath(getwd(), mustWork = TRUE)
default_raw_file <- file.path(root, "data", "exports", "study1", "full_2026-05-05_all_models", "raw_results_cleaned.csv")
raw_file_env <- Sys.getenv("RQ1_RAW_FILE", unset = "")
raw_file <- if (nzchar(raw_file_env)) raw_file_env else default_raw_file
brands_file <- file.path(root, "config", "categories_brands.csv")
out_dir <- file.path(root, "data", "analysis", "rq1")

dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

if (!file.exists(raw_file)) {
  stop(
    paste0(
      "RQ1 raw results CSV not found: ", raw_file,
      ". Upload a Study 1 CSV in the RQ Analysis page or place raw_results_cleaned.csv at the default Study 1 path."
    )
  )
}

clean_name <- function(x) {
  x <- trimws(as.character(x))
  x[x == ""] <- NA_character_
  x
}

write_model_table <- function(model, file) {
  coefs <- summary(model)$coefficients
  out <- data.frame(
    term = rownames(coefs),
    estimate = coefs[, "Estimate"],
    std_error = coefs[, "Std. Error"],
    z_value = coefs[, "z value"],
    p_value = coefs[, "Pr(>|z|)"],
    odds_ratio = exp(coefs[, "Estimate"]),
    row.names = NULL,
    check.names = FALSE
  )
  write.csv(out, file, row.names = FALSE, na = "")
  invisible(out)
}

raw <- read.csv(raw_file, stringsAsFactors = FALSE, check.names = FALSE)
focal <- read.csv(brands_file, stringsAsFactors = FALSE, check.names = FALSE)

required_cols <- c(
  "run_id", "category", "sub_category", "model_id", "model_name",
  "replicate", "prompt_condition", "response_text",
  paste0("brand_", 1:5)
)
missing_cols <- setdiff(required_cols, names(raw))
if (length(missing_cols) > 0) {
  stop(paste0("RQ1 raw results CSV is missing required columns: ", paste(missing_cols, collapse = ", ")))
}

brand_cols <- paste0("brand_", 1:5)
for (col in brand_cols) raw[[col]] <- clean_name(raw[[col]])

raw$row_id <- seq_len(nrow(raw))
raw$is_error <- startsWith(as.character(raw$response_text), "[ERROR]")
successful <- raw[!raw$is_error, , drop = FALSE]

candidate_brands <- unique(focal[, c("sub_category", "brand")])
candidate_brands <- candidate_brands[order(candidate_brands$sub_category, candidate_brands$brand), ]

visibility_lookup <- focal[, c("sub_category", "brand", "visibility_group")]
candidate_brands <- merge(
  candidate_brands,
  visibility_lookup,
  by = c("sub_category", "brand"),
  all.x = TRUE
)
candidate_brands$visibility_group[is.na(candidate_brands$visibility_group)] <- "unknown"

rows <- vector("list", nrow(successful))
for (i in seq_len(nrow(successful))) {
  rr <- successful[i, , drop = FALSE]
  candidates <- candidate_brands[candidate_brands$sub_category == rr$sub_category, , drop = FALSE]
  recommended <- unname(unlist(rr[brand_cols], use.names = FALSE))
  recommended <- recommended[!is.na(recommended)]
  rank <- match(candidates$brand, recommended)

  rows[[i]] <- data.frame(
    source_row_id = rr$row_id,
    run_id = rr$run_id,
    model_id = rr$model_id,
    model_name = rr$model_name,
    category = rr$category,
    sub_category = rr$sub_category,
    replicate = rr$replicate,
    prompt_condition = rr$prompt_condition,
    brand = candidates$brand,
    visibility_group = candidates$visibility_group,
    rec = as.integer(!is.na(rank)),
    rank = rank,
    in_top1 = as.integer(!is.na(rank) & rank <= 1),
    in_top3 = as.integer(!is.na(rank) & rank <= 3),
    in_top5 = as.integer(!is.na(rank) & rank <= 5),
    stringsAsFactors = FALSE
  )
}

binary <- do.call(rbind, rows)
binary$visibility_group <- factor(binary$visibility_group, levels = c("niche", "high_visibility", "other"))
binary$model_id <- factor(binary$model_id)
binary$sub_category <- factor(binary$sub_category)
binary$brand <- factor(binary$brand)

binary_file <- file.path(out_dir, "study1_brand_binary_dataset_focal.csv")
write.csv(binary, binary_file, row.names = FALSE, na = "")

predictor_template <- unique(binary[, c("sub_category", "brand", "visibility_group")])
predictor_template$brandz_salience <- NA_real_
predictor_template$brandz_difference <- NA_real_
predictor_template$brandz_meaningful <- NA_real_
predictor_template$awareness <- NA_real_
predictor_template$consideration <- NA_real_
predictor_template$ad_spend <- NA_real_
predictor_template$search_volume <- NA_real_
predictor_template$wikipedia_views <- NA_real_
predictor_template$news_mentions <- NA_real_
predictor_template <- predictor_template[order(predictor_template$sub_category, predictor_template$brand), ]
predictor_file <- file.path(out_dir, "brand_predictors_template.csv")
write.csv(predictor_template, predictor_file, row.names = FALSE, na = "")

model0 <- glm(rec ~ model_id + sub_category, family = binomial(), data = binary)
model1 <- glm(rec ~ model_id + sub_category + visibility_group, family = binomial(), data = binary)
model2 <- glm(rec ~ model_id + sub_category + brand, family = binomial(), data = binary)
model3 <- glm(rec ~ sub_category + model_id * visibility_group, family = binomial(), data = binary)

coef0 <- write_model_table(model0, file.path(out_dir, "logit_model0_model_category.csv"))
coef1 <- write_model_table(model1, file.path(out_dir, "logit_model1_visibility.csv"))
coef2 <- write_model_table(model2, file.path(out_dir, "logit_model2_brand_fixed_effects.csv"))
coef3 <- write_model_table(model3, file.path(out_dir, "logit_model3_visibility_model_interaction.csv"))

fit_stats <- data.frame(
  model = c("model0_model_category", "model1_visibility", "model2_brand_fixed_effects", "model3_visibility_model_interaction"),
  formula = c(
    "rec ~ model_id + sub_category",
    "rec ~ model_id + sub_category + visibility_group",
    "rec ~ model_id + sub_category + brand",
    "rec ~ sub_category + model_id * visibility_group"
  ),
  n = c(nobs(model0), nobs(model1), nobs(model2), nobs(model3)),
  logLik = c(as.numeric(logLik(model0)), as.numeric(logLik(model1)), as.numeric(logLik(model2)), as.numeric(logLik(model3))),
  AIC = c(AIC(model0), AIC(model1), AIC(model2), AIC(model3)),
  BIC = c(BIC(model0), BIC(model1), BIC(model2), BIC(model3)),
  stringsAsFactors = FALSE
)
write.csv(fit_stats, file.path(out_dir, "logit_fit_stats.csv"), row.names = FALSE)

recommendation_rates <- aggregate(
  rec ~ sub_category + brand + visibility_group,
  data = binary,
  FUN = mean
)
names(recommendation_rates)[names(recommendation_rates) == "rec"] <- "recommendation_rate"
mention_counts <- aggregate(
  rec ~ sub_category + brand + visibility_group,
  data = binary,
  FUN = sum
)
names(mention_counts)[names(mention_counts) == "rec"] <- "total_mentions"
recommendation_summary <- merge(
  recommendation_rates,
  mention_counts,
  by = c("sub_category", "brand", "visibility_group")
)
recommendation_summary <- recommendation_summary[order(
  recommendation_summary$sub_category,
  -recommendation_summary$recommendation_rate,
  recommendation_summary$brand
), ]
write.csv(recommendation_summary, file.path(out_dir, "brand_recommendation_rates.csv"), row.names = FALSE)

visibility_rate <- aggregate(
  rec ~ visibility_group,
  data = binary,
  FUN = mean
)
names(visibility_rate)[names(visibility_rate) == "rec"] <- "recommendation_rate"
visibility_n <- aggregate(
  rec ~ visibility_group,
  data = binary,
  FUN = length
)
names(visibility_n)[names(visibility_n) == "rec"] <- "n_observations"
visibility_mentions <- aggregate(
  rec ~ visibility_group,
  data = binary,
  FUN = sum
)
names(visibility_mentions)[names(visibility_mentions) == "rec"] <- "total_mentions"
visibility_summary <- merge(merge(visibility_rate, visibility_n, by = "visibility_group"), visibility_mentions, by = "visibility_group")
visibility_summary <- visibility_summary[order(visibility_summary$visibility_group), ]
write.csv(visibility_summary, file.path(out_dir, "visibility_recommendation_rates.csv"), row.names = FALSE)

category_visibility_rate <- aggregate(
  rec ~ sub_category + visibility_group,
  data = binary,
  FUN = mean
)
names(category_visibility_rate)[names(category_visibility_rate) == "rec"] <- "recommendation_rate"
category_visibility_n <- aggregate(
  rec ~ sub_category + visibility_group,
  data = binary,
  FUN = length
)
names(category_visibility_n)[names(category_visibility_n) == "rec"] <- "n_observations"
category_visibility_mentions <- aggregate(
  rec ~ sub_category + visibility_group,
  data = binary,
  FUN = sum
)
names(category_visibility_mentions)[names(category_visibility_mentions) == "rec"] <- "total_mentions"
category_visibility_summary <- merge(
  merge(category_visibility_rate, category_visibility_n, by = c("sub_category", "visibility_group")),
  category_visibility_mentions,
  by = c("sub_category", "visibility_group")
)
category_visibility_summary <- category_visibility_summary[order(category_visibility_summary$sub_category, category_visibility_summary$visibility_group), ]
write.csv(category_visibility_summary, file.path(out_dir, "category_visibility_recommendation_rates.csv"), row.names = FALSE)

rate_for <- function(data, group_col, group_value, visibility_value) {
  subset_rows <- data[
    as.character(data[[group_col]]) == as.character(group_value) &
      as.character(data$visibility_group) == visibility_value,
    ,
    drop = FALSE
  ]
  if (nrow(subset_rows) == 0) return(NA_real_)
  mean(subset_rows$rec)
}

count_for <- function(data, group_col, group_value, visibility_value) {
  subset_rows <- data[
    as.character(data[[group_col]]) == as.character(group_value) &
      as.character(data$visibility_group) == visibility_value,
    ,
    drop = FALSE
  ]
  nrow(subset_rows)
}

mentions_for <- function(data, group_col, group_value, visibility_value) {
  subset_rows <- data[
    as.character(data[[group_col]]) == as.character(group_value) &
      as.character(data$visibility_group) == visibility_value,
    ,
    drop = FALSE
  ]
  if (nrow(subset_rows) == 0) return(NA_real_)
  sum(subset_rows$rec)
}

make_visibility_bias <- function(data, group_col) {
  group_values <- sort(unique(as.character(data[[group_col]])))
  out <- do.call(rbind, lapply(group_values, function(group_value) {
    high_rate <- rate_for(data, group_col, group_value, "high_visibility")
    niche_rate <- rate_for(data, group_col, group_value, "niche")
    data.frame(
      group = group_value,
      high_visibility_rate = high_rate,
      niche_rate = niche_rate,
      bias_gap = high_rate - niche_rate,
      bias_ratio = ifelse(is.na(niche_rate) || niche_rate == 0, NA_real_, high_rate / niche_rate),
      high_visibility_mentions = mentions_for(data, group_col, group_value, "high_visibility"),
      niche_mentions = mentions_for(data, group_col, group_value, "niche"),
      high_visibility_n = count_for(data, group_col, group_value, "high_visibility"),
      niche_n = count_for(data, group_col, group_value, "niche"),
      stringsAsFactors = FALSE
    )
  }))
  out[order(-out$bias_gap, -out$high_visibility_rate, out$group), ]
}

category_bias <- make_visibility_bias(binary, "sub_category")
names(category_bias)[names(category_bias) == "group"] <- "sub_category"
write.csv(category_bias, file.path(out_dir, "category_popularity_bias.csv"), row.names = FALSE, na = "")

niche_opportunities <- recommendation_summary[
  recommendation_summary$visibility_group == "niche" &
    recommendation_summary$total_mentions > 0,
  ,
  drop = FALSE
]
niche_opportunities <- niche_opportunities[order(
  -niche_opportunities$recommendation_rate,
  -niche_opportunities$total_mentions,
  niche_opportunities$sub_category,
  niche_opportunities$brand
), ]
write.csv(niche_opportunities, file.path(out_dir, "niche_brand_opportunities.csv"), row.names = FALSE)

model_visibility_rate <- aggregate(
  rec ~ model_id + visibility_group,
  data = binary,
  FUN = mean
)
names(model_visibility_rate)[names(model_visibility_rate) == "rec"] <- "recommendation_rate"
model_visibility_n <- aggregate(
  rec ~ model_id + visibility_group,
  data = binary,
  FUN = length
)
names(model_visibility_n)[names(model_visibility_n) == "rec"] <- "n_observations"
model_visibility_mentions <- aggregate(
  rec ~ model_id + visibility_group,
  data = binary,
  FUN = sum
)
names(model_visibility_mentions)[names(model_visibility_mentions) == "rec"] <- "total_mentions"
model_visibility_summary <- merge(
  merge(model_visibility_rate, model_visibility_n, by = c("model_id", "visibility_group")),
  model_visibility_mentions,
  by = c("model_id", "visibility_group")
)
model_visibility_summary <- model_visibility_summary[order(model_visibility_summary$model_id, model_visibility_summary$visibility_group), ]
write.csv(model_visibility_summary, file.path(out_dir, "model_visibility_recommendation_rates.csv"), row.names = FALSE)

model_bias <- make_visibility_bias(binary, "model_id")
names(model_bias)[names(model_bias) == "group"] <- "model_id"
write.csv(model_bias, file.path(out_dir, "model_popularity_bias.csv"), row.names = FALSE, na = "")

visibility_terms <- coef1[grepl("^visibility_group", coef1$term), , drop = FALSE]
interaction_terms <- coef3[grepl(":visibility_group|visibility_group.*:model_id", coef3$term), , drop = FALSE]
summary_lines <- c(
  "# RQ1 Logistic Regression Summary",
  "",
  paste0("Generated: ", format(Sys.time(), "%Y-%m-%d %H:%M:%S %Z")),
  paste0("Source raw file: ", raw_file),
  paste0("Successful replicate rows used: ", nrow(successful)),
  paste0("Excluded error rows: ", sum(raw$is_error)),
  paste0("Binary brand-level rows: ", nrow(binary)),
  paste0("Unique model/category/replicate cells: ", length(unique(paste(successful$model_id, successful$sub_category, successful$replicate, sep = "|")))),
  paste0("Candidate brand-category rows: ", nrow(candidate_brands)),
  "Candidate universe: pre-defined focal brands from config/categories_brands.csv",
  "",
  "Models estimated:",
  "- model0: rec ~ model_id + sub_category",
  "- model1: rec ~ model_id + sub_category + visibility_group",
  "- model2: rec ~ model_id + sub_category + brand",
  "- model3: rec ~ sub_category + model_id * visibility_group",
  "",
  "Current predictor status:",
  "- External brand predictors are not merged yet.",
  "- Fill brand_predictors_template.csv, then run the next RQ1 predictor model using those columns.",
  "",
  "Visibility effects from model1, with niche as the reference group:"
)

if (nrow(visibility_terms) > 0) {
  for (i in seq_len(nrow(visibility_terms))) {
    summary_lines <- c(
      summary_lines,
      paste0(
        "- ", visibility_terms$term[i],
        ": log-odds = ", round(visibility_terms$estimate[i], 4),
        ", OR = ", round(visibility_terms$odds_ratio[i], 3),
        ", p = ", signif(visibility_terms$p_value[i], 4)
      )
    )
  }
}

summary_lines <- c(
  summary_lines,
  "",
  "Strongest category-level popularity bias, measured as high-visibility rate minus niche rate:"
)
if (nrow(category_bias) > 0) {
  for (i in seq_len(min(5, nrow(category_bias)))) {
    summary_lines <- c(
      summary_lines,
      paste0(
        "- ", category_bias$sub_category[i],
        ": gap = ", round(category_bias$bias_gap[i] * 100, 1), " pp",
        ", high-vis = ", round(category_bias$high_visibility_rate[i] * 100, 1), "%",
        ", niche = ", round(category_bias$niche_rate[i] * 100, 1), "%"
      )
    )
  }
}

summary_lines <- c(
  summary_lines,
  "",
  "Model interaction terms from model3:"
)
if (nrow(interaction_terms) > 0) {
  for (i in seq_len(nrow(interaction_terms))) {
    summary_lines <- c(
      summary_lines,
      paste0(
        "- ", interaction_terms$term[i],
        ": log-odds = ", round(interaction_terms$estimate[i], 4),
        ", OR = ", round(interaction_terms$odds_ratio[i], 3),
        ", p = ", signif(interaction_terms$p_value[i], 4)
      )
    )
  }
}

writeLines(summary_lines, file.path(out_dir, "rq1_summary.md"))

cat("RQ1 analysis complete.\n")
cat("Binary dataset: ", binary_file, "\n", sep = "")
cat("Predictor template: ", predictor_file, "\n", sep = "")
cat("Summary: ", file.path(out_dir, "rq1_summary.md"), "\n", sep = "")
