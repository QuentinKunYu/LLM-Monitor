# LLM Brand Recommendation Experiment

This repository contains the complete research application for studying brand recommendations made by large language models (LLMs). It runs the documented experiments, preserves prompts and raw model responses, standardises brand names, and calculates Brand Recommendation Probability (BRP@1, BRP@3, and BRP@5) and Mean Reciprocal Rank (MRR).

The application has two local pages:

- **Run experiment** (`/`) configures, previews, and starts an experiment.
- **Existing analysis** (`/analysis.html`) displays completed results, raw responses, follow-up reasons, category breakdowns, and real-world predictor comparisons.

API keys remain on the local server. Never commit `.env` or paste credentials into tracked files.

## Study design

The paper-default protocol uses six models and five product categories.

| Component | Design | Calls |
| --- | --- | ---: |
| Category-only baseline | 5 categories × 6 models × 40 independent repetitions | 1,200 |
| Needs-based prompts | 200 prompts × 6 models × 2 independent repetitions | 2,400 |
| Reason follow-ups | One follow-up after every successful recommendation response | Up to 3,600 |
| Maximum complete protocol | Recommendation calls plus reason follow-ups | Up to 7,200 |

The five product categories are cordless drills, hiking jackets, coffee makers, cat food, and boat cruises. The exact model configuration is in `config/models.json`; the category-explicit needs prompt library is in `config/needs_based_prompts_category_explicit_v2.csv`.

The implementation follows these methodological rules:

- each recommendation request is an independent, stateless API call;
- no conversation history or user profile carries across repetitions;
- web search and external retrieval tools are disabled;
- responses are requested as ordered JSON with up to five brand names;
- calls execute sequentially so saved artifacts preserve collection order;
- aliases are standardised after collection with category-specific dictionaries; and
- metrics are computed for every observed brand, not from a predefined brand list.

Theme is a secondary breakdown of the needs-based observations. It reuses the same responses and does not add model calls.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server.js` | Local Express server, API routes, run orchestration, persistence, and exports |
| `public/` | Experiment interface, analysis interface, and committed analysis inputs |
| `config/` | Models, categories, prompt libraries, experimental conditions, and alias dictionaries |
| `lib/` | Provider clients, response extraction, metrics, and orchestration logic |
| `scripts/` | Data validation, cleaning, repair, prompt preparation, and export utilities |
| `test/` | Automated protocol, metrics, persistence, authentication, and data checks |
| `seed-data/` | Curated Study 1 and Study 3 result snapshots included for reproducibility |
| `data/` | Locally generated run state and outputs; ignored by Git |

## Requirements

- Node.js 20 LTS
- npm 10 or newer
- Provider API keys only for live model calls

Node 20 is the validated runtime. Check your local versions with:

```bash
node --version
npm --version
```

## Quick start

Clone the repository:

```bash
git clone https://github.com/QuentinKunYu/LLM-Monitor.git
cd LLM-Monitor
```

### One-command local start

On macOS or Linux:

```bash
./start.sh
```

The launcher checks Node.js, installs locked dependencies on the first run, creates `.env` from `.env.example` when needed, starts the server, and opens the analysis page. Stop it with `Ctrl+C`.

On macOS, `start.command` may also be opened from Finder.

### Manual start

```bash
npm ci
cp .env.example .env
npm start
```

Then open:

- `http://localhost:3000` to configure an experiment; or
- `http://localhost:3000/analysis.html` to inspect results.

Use `npm install` only when intentionally changing dependencies. For normal setup and reproducible checks, use `npm ci` so the versions in `package-lock.json` are respected.

## Environment variables

Copy `.env.example` to `.env` for local work. `.env` is ignored by Git.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI live runs only | Server-side OpenAI credential |
| `ANTHROPIC_API_KEY` | Anthropic live runs only | Server-side Anthropic credential |
| `GOOGLE_API_KEY` | Gemini live runs only | Server-side Google credential |
| `APP_PASSWORD` | No | Optional password for endpoints that start or retry runs |
| `DATA_DIR` | No | Local output directory; defaults to `./data` |
| `PORT` | No | Local HTTP port; defaults to `3000` |

Example:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
APP_PASSWORD=
DATA_DIR=
PORT=3000
```

Leaving the provider keys blank is safe for reading committed analyses and using dry-run mode. Leaving `APP_PASSWORD` blank disables the run-password check for local research use.

## Running an experiment

1. Open **Run experiment**.
2. Select the models and product categories.
3. Review the category-only template and needs-based prompt library.
4. Confirm the protocol summary and projected request count.
5. Select **Dry run** when testing the interface or persistence.
6. Start the run and retain its run token.
7. Open **Existing analysis** to inspect metrics, raw responses, reasons, and validation information.

Use **Reset to paper defaults** after a custom test to restore the documented protocol.

### Dry run versus live run

- A **dry run** exercises scheduling, persistence, metric generation, exports, and the browser workflow with synthetic responses. It requires no provider keys and makes no paid model calls.
- A **live run** sends requests to the selected model providers. Review the projected request count and current provider pricing before starting.

For a smoke test, use one model, one category, one repetition, and dry-run mode. Do not use the full default protocol simply to verify that the application starts.

## Data and generated outputs

Local run state is written under `data/` unless `DATA_DIR` specifies another location.

Important outputs include:

- `data/experiments/<run-id>.json` — resumable experiment state;
- `data/exports/.../raw_results.csv` — prompts, raw responses, and parsed recommendations;
- `data/exports/.../metrics.csv` — BRP and MRR outputs;
- `data/exports/.../metrics_by_theme.csv` — needs-based theme summaries; and
- `data/exports/.../quality_report.*` — validation and data-quality findings.

The `data/` directory may contain raw model text or unpublished research results. Review generated files before sharing them.

## Metrics

For a brand \(b\) across \(N\) independent recommendation responses:

- **BRP@k** is the proportion of responses in which \(b\) appears within the first \(k\) positions.
- **MRR** averages \(1/rank_b\) when the brand is present and zero when it is absent.

The implementation reports these metrics by experiment, model, category, and supported secondary groupings. See `lib/metrics.js` and `test/metrics.test.js` for the executable definitions and edge cases.

## Analysis data

The repository includes curated Study 1 and Study 3 snapshots under `seed-data/` and browser-ready analysis inputs under `public/`. These files allow the analysis interface and its predictor views to be checked without starting a new paid run.

Real-world predictors are descriptive comparison variables, not causal estimates. Their labels, coverage notes, transformations, and missing-data information are stored with the analysis data and displayed by the interface.

## Automated checks

Install dependencies and run the complete suite:

```bash
npm ci
npm run check
```

The suite checks experiment ledgers, default call counts, brand discovery, BRP/MRR grouping, prompt fixtures, follow-up reasons, persistence, password protection, dry-run behavior, data cleaning, and committed predictor coverage. It requires no provider keys and should make no paid model calls.

Useful focused commands:

```bash
npm test
npm run test:data-cleaning
npm run test:followup-reasons
npm run test:study2b-fixture
npm run test:study3-fixture
npm run test:study3-needs
npm audit --omit=dev
```

## Reproducibility checklist

Before recording or publishing a result:

1. Record the Git commit SHA.
2. Save the exact model identifiers and provider settings.
3. Preserve the prompt and configuration files used for the run.
4. Record run timestamps and the selected repetitions.
5. Keep the raw response export together with the cleaned and metric outputs.
6. Review the quality report and document any repair or exclusion.
7. Never overwrite an earlier raw export with a cleaned derivative.

Model behavior and provider APIs can change over time. The source commit and run metadata are therefore part of the empirical record.

## Troubleshooting

### The server does not start

- Confirm that Node.js 20 is active with `node --version`.
- Run `npm ci` again if dependencies are missing or inconsistent.
- Check whether another process is already using `PORT`.
- Confirm that `DATA_DIR` exists or can be created.

### A live run reports a missing key

Set the credential for every selected provider in `.env`, then restart the local server. Do not add provider keys to `.env.example`.

### A run request returns `401`

`APP_PASSWORD` is set on the local server, but the submitted password is missing or incorrect. Clear `APP_PASSWORD` and restart for an unprotected local session, or enter the matching password in the run dialog.

### Results are not visible

Verify which `DATA_DIR` the server is using and confirm that the expected run state and exports are stored there. The committed snapshots are separate from newly generated local runs.

### Tests behave differently on another machine

Use Node.js 20 and `npm ci`, then compare the commit SHA and `package-lock.json`. Provider-backed live responses are not deterministic, but the automated dry-run and fixture checks should be reproducible.

## Branches

- `main` is the research-focused branch documented here.
- `render-deploy` contains the separate online deployment configuration.

Keeping deployment infrastructure outside `main` makes the experiment implementation and reproducibility materials easier to review.

## Citation and reuse

If you use this software or its archived results in research, cite the associated paper and record the commit SHA, model identifiers, prompt files, run timestamps, and provider settings used for the analysis.
