# LLM Brand Recommendation Experiment

This repository contains the companion application for a study of brand recommendations made by large language models (LLMs). It can run the documented experiment, retain the exact prompts and raw model responses, standardise brand names, and calculate Brand Recommendation Probability (BRP@1, BRP@3, and BRP@5) and Mean Reciprocal Rank (MRR).

The application has two main pages:

- **Run experiment** (`/`) configures, previews, and starts a run.
- **Existing analysis** (`/analysis.html`) reads completed or archived results and provides metrics, raw responses, follow-up reasons, real-world signals, and category-level views.

Provider API keys are server-side secrets. They must never be committed to the repository or entered into a public browser session.

## Study design

The paper-default protocol uses six models and five product categories.

| Component | Design | Calls |
| --- | --- | ---: |
| Category-only baseline | 5 categories x 6 models x 40 independent repetitions | 1,200 |
| Needs-based prompts | 200 prompts x 6 models x 2 independent repetitions | 2,400 |
| Reason follow-ups | One follow-up after each successful recommendation response | Up to 3,600 |
| Maximum full protocol | Recommendation calls plus follow-ups | Up to 7,200 |

The five product categories are cordless drills, hiking jackets, coffee makers, cat food, and boat cruises. The configured model list is stored in `config/models.json` and the prompt library is stored in `config/needs_based_prompts_category_explicit_v2.csv`.

The implementation preserves the following methodological rules:

- every recommendation request is a new, stateless API call;
- no conversation history or user profile is carried between repetitions;
- web search and external retrieval tools are disabled;
- every response is requested as ordered JSON containing up to five brands;
- calls are executed sequentially so the saved artifacts preserve execution order;
- brand aliases are standardised after collection with category-specific dictionaries; and
- metrics are calculated for every observed brand rather than from a predefined recommendation list.

Theme is a secondary breakdown of the needs-based observations. It reuses the same responses and does not add provider calls.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server.js` | Express server, API routes, run orchestration, persistence, and exports |
| `public/` | Browser interface and analysis pages |
| `config/` | Models, categories, prompt libraries, conditions, and alias dictionaries |
| `lib/` | Provider clients, extraction, metrics, and experiment logic |
| `scripts/` | Data checks, cleaning, repair, and export utilities |
| `test/` | Automated unit, protocol, deployment, and fixture checks |
| `data/` | Local run state and generated outputs; ignored by Git |
| `seed-data/` | Curated public result snapshots when included in a distribution |
| `Dockerfile` | Reproducible Node.js container used by Render |
| `render.yaml` | Render Blueprint configuration; it does not deploy anything by itself |

## Requirements

- Node.js 20 LTS (the Docker and Render image uses Node 20; newer major versions are not the validated target)
- npm 10 or newer
- Provider API keys only when making live model calls
- Docker Desktop only for the optional container test

Confirm the local versions with:

```bash
node --version
npm --version
```

## Quick start

Clone the canonical repository and enter the project directory:

```bash
git clone <ANONYMIZED_REPO_URL>
cd LLM-Monitor
```

### One-command start

On macOS or Linux:

```bash
./start.sh
```

The script checks Node.js, installs dependencies when needed, creates `.env` from `.env.example` if it is missing, starts the server, and opens `http://localhost:3000/analysis.html`. Stop the server with `Ctrl+C`.

On macOS, `start.command` can also be opened from Finder.

### Manual start

```bash
npm ci
cp .env.example .env
npm start
```

Then open:

- `http://localhost:3000` to configure a run; or
- `http://localhost:3000/analysis.html` to inspect existing results.

Use `npm install` instead of `npm ci` only when intentionally changing dependencies. `npm ci` reproduces the versions recorded in `package-lock.json`.

## Environment variables

Copy `.env.example` to `.env` for local work. The `.env` file is ignored by both Git and Docker.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Live OpenAI runs only | Server-side OpenAI credential |
| `ANTHROPIC_API_KEY` | Live Anthropic runs only | Server-side Anthropic credential |
| `GOOGLE_API_KEY` | Live Gemini runs only | Server-side Google credential |
| `APP_PASSWORD` | Recommended for any public deployment | Protects endpoints that start or retry paid runs |
| `DATA_DIR` | No | Output directory; defaults to `./data` locally |
| `PORT` | No | HTTP port; defaults to `3000` locally and is supplied by Render |

Example local configuration:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
APP_PASSWORD=
DATA_DIR=
```

Leaving provider keys blank is safe for browsing results and running the dry-run workflow. Leaving `APP_PASSWORD` blank disables the run-password check, which is convenient locally but inappropriate for a public service that contains funded provider keys.

`APP_PASSWORD` does not hide the website or analysis pages. It protects only endpoints that can initiate paid provider calls. The browser asks for this password when a visitor starts or retries a run.

## Running the experiment

1. Open the **Run experiment** page.
2. Select the required models and categories.
3. Review the category-only prompt and needs-based prompt library.
4. Confirm the protocol summary and projected call count.
5. Select **Dry run** for interface and persistence testing without provider calls.
6. Start the run and save the returned run token.
7. Use **Existing analysis** to inspect metrics, raw responses, and quality information.

Use **Reset to paper defaults** after a custom test to restore the documented protocol.

### Dry run versus live run

- A **dry run** exercises scheduling, persistence, metrics, exports, and the browser workflow with synthetic responses. It does not require provider keys and should not incur model charges.
- A **live run** sends requests to the selected providers. Review the maximum call count and provider pricing before starting it.

Do not run the full paper-default protocol merely as a smoke test. Start with one model, one category, one repetition, and dry-run mode.

## Data and generated outputs

By default, local state is written below `data/`. On Render, `DATA_DIR=/var/data` directs all runtime state to the attached persistent disk.

Important generated files include:

- `data/experiments/<run-id>.json` for resumable experiment state;
- `data/exports/.../raw_results.csv` for raw and parsed recommendations;
- `data/exports/.../metrics.csv` for BRP and MRR outputs;
- `data/exports/.../metrics_by_theme.csv` for needs-based theme summaries; and
- `data/exports/.../quality_report.txt` or `.md` for validation findings.

The `data/` directory can contain raw model text and research data. Review it before sharing files, and never place API keys or participant-sensitive information in exported fields.

## Automated checks

Install dependencies, then run the complete local check suite:

```bash
npm ci
npm run check
```

The suite covers data cleaning, protocol call counts, metric grouping, brand discovery, prompt fixtures, password protection, persistence, and dry-run behavior. It does not require provider API keys and should not make paid LLM calls.

Useful focused commands are:

```bash
npm test
npm run test:followup-reasons
npm run test:study3-needs
npm audit --omit=dev
```

## Test the Render container locally

The following smoke test builds the same Dockerfile that Render uses. It does not create a Render service and does not deploy or push an image.

```bash
docker build -t llm-brand-experiment:render-test .
docker volume create llm-brand-render-test-data
docker run --rm \
  --name llm-brand-render-test \
  --publish 127.0.0.1:10000:10000 \
  --env PORT=10000 \
  --env DATA_DIR=/var/data \
  --env APP_PASSWORD=local-test-only \
  --volume llm-brand-render-test-data:/var/data \
  llm-brand-experiment:render-test
```

In another terminal, verify the public configuration endpoint:

```bash
curl --fail http://127.0.0.1:10000/api/config
```

Open `http://127.0.0.1:10000/analysis.html` to verify the analysis page. Use dry-run mode if testing the run workflow.

Stop the foreground container with `Ctrl+C`. Remove the temporary test volume only when its test data is no longer needed:

```bash
docker volume rm llm-brand-render-test-data
```

## Render configuration

The included `render.yaml` defines one Docker web service with:

- the `starter` paid compute plan;
- a 1 GB persistent disk mounted at `/var/data`;
- `DATA_DIR=/var/data` so run state survives restarts and redeploys;
- `/api/config` as a non-secret health-check endpoint; and
- dashboard-supplied values for `APP_PASSWORD` and the three provider keys.

A persistent disk is intentional because a normal Render filesystem is ephemeral. Only files written beneath `/var/data` are retained. A disk-backed service runs as a single instance and has a brief interruption during redeploys, so this configuration prioritises experiment-state integrity over horizontal scaling and zero-downtime releases.

With Render CLI 2.7.0 or newer and an active workspace, validate the Blueprint without deploying it:

```bash
render blueprints validate render.yaml
```

The same structure can be checked by editors that support Render's official schema at `https://render.com/schema/render.yaml.json`.

### Before the first Render deployment

1. Run `npm run check` locally.
2. Complete the local Docker smoke test above.
3. Confirm that `render.yaml` passes the current Render Blueprint schema.
4. Review the selected Render plan, disk size, region, and expected monthly cost.
5. Generate a strong, unique `APP_PASSWORD`.
6. Add provider credentials only in the Render dashboard; never add them to `render.yaml`.
7. Begin with a dry run after deployment.
8. Confirm that a generated experiment remains available after a service restart before starting a paid live run.

When deployment is eventually approved, create a new Render Blueprint from this repository, review the proposed resources, supply each variable marked `sync: false`, and only then apply the Blueprint. Merely committing `render.yaml` does not create a service unless the repository is already linked to Render.

## Security and cost notes

- Treat provider keys and `APP_PASSWORD` as secrets.
- Do not commit `.env`, local `data/`, logs, or copied dashboard values.
- A visitor who knows `APP_PASSWORD` can initiate billable calls using the server-side provider keys.
- Public analysis endpoints can expose archived research results. Review the published dataset before deployment.
- The full default protocol can produce up to 7,200 provider calls when every recommendation receives a reason follow-up.
- Rotate a key immediately if it appears in Git history, logs, screenshots, or exported files.

## Troubleshooting

### The server does not start

- Prefer Node.js 20 LTS and confirm it with `node --version`.
- Run `npm ci` again if dependencies are missing.
- Check whether another process is already using the configured `PORT`.
- Verify that `DATA_DIR` exists or can be created by the current user.

### A live run reports a missing provider key

Confirm that the key for every selected provider is set in `.env` locally or in the Render dashboard. Restart the service after changing local environment variables.

### A public deployment returns `401` when starting a run

The request did not include the current `APP_PASSWORD`. Reload the page and enter the password again. Reading the analysis pages should remain public.

### Results disappear after a restart

Confirm that `DATA_DIR` is `/var/data` and that the Render disk is mounted at exactly `/var/data`. Files written elsewhere in the container are ephemeral.

### Render cannot detect the web port

Do not hard-code a production port. The server reads Render's `PORT` environment variable, and the Docker container must expose the same listening process.

### Docker commands cannot reach the daemon

Start Docker Desktop and wait until `docker info` succeeds before building the image.

## Citation and reuse

If this software or its archived results are used in research, cite the associated paper and record the Git commit SHA, model identifiers, prompt files, run timestamps, and provider settings used for the analysis. Model behavior and provider APIs can change over time, so the commit and run metadata are part of the reproducibility record.
