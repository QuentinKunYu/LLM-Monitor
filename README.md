# LLM Brand Experiment

This is a local web app for running LLM brand recommendation experiments and RQ1 analysis.

The GitHub repo does not include private API keys or research data. To run RQ1, upload the Study 1 experiment CSV in the web app.

## What You Need

- Node.js
- R
- API keys only if you want to run new LLM experiments
- A Study 1 CSV if you want to run RQ1 analysis

## 1. Download and Install

Open Terminal and run:

```bash
git clone https://github.com/QuentinKunYu/LLM-research.git
cd LLM-research
npm install
```

## 2. Add API Keys

Create a file named `.env` in the project folder.

Paste this into `.env`, then fill in the keys you have:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

You only need API keys if you want to run new experiments. If you only want to run RQ1 from an existing CSV, you can skip this step.

## 3. Start the App

Run:

```bash
npm start
```

Then open this in a browser:

```text
http://localhost:3000
```

## 4. Run a New Experiment

In the web app:

1. Click `Experiment`
2. Choose a prompt condition
3. Choose an LLM model
4. Choose a product category
5. Choose the number of replicates
6. Click `Run Experiment`
7. Export the raw CSV when the run is finished

## 5. Run RQ1 Analysis

In the web app:

1. Click `RQ Analysis`
2. Click `Choose CSV`
3. Select your Study 1 `raw_results_cleaned.csv`
4. Click `Run RQ1`

The page will show:

- Overall popularity bias
- Category heterogeneity
- Niche brands that still get recommended
- Model differences
- Visibility x model interaction
- Logistic regression results

## Study 1 CSV Format

The RQ1 CSV should include these columns:

```text
run_id
category
sub_category
model_id
model_name
replicate
prompt_condition
response_text
brand_1
brand_2
brand_3
brand_4
brand_5
```

Extra columns are fine.

## Useful Commands

Start the web app:

```bash
npm start
```

Run RQ1 from the default local CSV path:

```bash
npm run analysis:rq1
```

The easier option is to use the `RQ Analysis` page and upload the CSV there.
