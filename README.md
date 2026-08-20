# LLM Brand Recommendation Experiment

This repository contains the companion app for a study of brand recommendations made by large language models. It runs the experiment, keeps the exact prompts and raw responses, and calculates brand recommendation probability (BRP@1, BRP@3, and BRP@5) and mean reciprocal rank (MRR).

The app has two pages:

- `Run experiment` configures and starts a new run.
- `Existing analysis` reads completed results and provides metric, raw-response, and reason views.

Private API keys and full research datasets are not committed to the repository.

## Study design

The paper-default protocol covers six models and five product categories. It includes:

- 1,200 category-only recommendations;
- 2,400 needs-based recommendations drawn from the 200-prompt library;
- one reason follow-up after each successful recommendation.

Each request starts in a fresh session, web search is off, and models return up to five ordered brand names as JSON. Calls run sequentially so that the saved artifacts reflect the order in which the experiment was conducted.

There is no predefined list of brands. Metrics are calculated for every brand found in the responses. Theme is available as a secondary breakdown of the needs-based conditions; it reuses the same observations and does not create more API calls.

## Run locally

Node.js 20 or newer is required.

```bash
git clone https://github.com/QuentinKunYu/LLM-Moniter.git
cd LLM-Moniter
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` for the experiment page or `http://localhost:3000/analysis.html` for the results page.

Provider credentials are only needed for live runs:

```text
OPENAI_API_KEY=
GOOGLE_API_KEY=
ANTHROPIC_API_KEY=
```

Keep `.env` private. The browser does not ask participants or visitors to supply provider keys.

## Running an experiment

1. Select the models and product categories.
2. Review the category-only template and needs-based prompt library.
3. Check the call count in the protocol summary.
4. Use `Dry run` if you want to test the interface without making provider calls.
5. Start the run and keep the run token if you need to return to the results later.

The server saves raw recommendation responses, parsed brands, reason follow-ups, run state, metric tables, and quality reports. `Reset to paper defaults` restores the documented protocol after a custom test.

## Checks

Run the automated checks before committing changes:

```bash
npm run check
```

The suite covers the experiment ledger, metric calculations, prompt fixtures, data cleaning, authentication, and dry-run behavior.

## Public deployment

The app can be deployed as a Docker web service. Use persistent storage for experiment outputs and set an application password before exposing provider-backed runs.

```text
DATA_DIR=/var/data
APP_PASSWORD=choose-a-password
```

On Render, mount the persistent disk at `/var/data` and add the provider keys as server-side environment variables. When `APP_PASSWORD` is set, the username may be anything; the password must match the configured value.
