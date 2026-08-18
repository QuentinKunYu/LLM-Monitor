# LLM Brand Experiment

This is an interactive research appendix for reproducing the LLM brand recommendation experiment, editing its prompt library, and calculating BRP@1, BRP@3, BRP@5, and MRR.

The GitHub repo does not include private API keys or research data. To run RQ1, upload the Study 1 experiment CSV in the web app.

## What You Need

- Node.js 20 or newer
- R
- Provider API keys configured in the server environment if you want to run new LLM experiments
- A Study 1 CSV if you want to run RQ1 analysis

## 1. Download and Install

Open Terminal and run:

```bash
git clone https://github.com/QuentinKunYu/LLM-Moniter.git
cd LLM-Moniter
npm install
```

Copy the environment template if you plan to run provider calls or protect a
public deployment:

```bash
cp .env.example .env
```

Keep `.env` private. It is ignored by Git and must never be committed.

## 2. Start the App

Run:

```bash
npm start
```

Then open this in a browser:

```text
http://localhost:3000
```

## 3. Run a New Experiment

In the web app:

1. Open `Run experiment`.
2. Keep the paper defaults or select a custom model/category scope.
3. Review or edit the context-free template and 200-prompt needs library.
4. Configure the selected providers in `.env` with `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and/or `ANTHROPIC_API_KEY`. The public interface never asks visitors for credentials.
5. Click the run button. A full paper-default run contains 3,600 recommendation calls and 3,600 separate reason follow-ups.
6. Inspect the automatically calculated BRP and MRR tables, then download the research artifacts.

Enable `Dry run` under Advanced overrides to test the complete interface without provider calls or API keys. `Reset to paper defaults` restores all documented controls. On a public deployment, set `APP_PASSWORD` so untrusted visitors cannot spend the server account's provider quota.

## 4. Run RQ1 Analysis

In the web app:

1. Click `Advanced analysis`
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

Run the automated checks:

```bash
npm run check
```

## Public Hosting

For a shared version that other people can use without installing Node or R,
deploy the app as a Docker web service.

Recommended Render settings:

- Root directory: this project folder
- Environment: Docker
- Persistent disk mount path: `/var/data`
- Environment variables:
  - `DATA_DIR=/var/data`
  - `APP_PASSWORD=your-shared-password`
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` as needed

When `APP_PASSWORD` is set, browsers will ask for a username and password.
The username can be anything; the password must match `APP_PASSWORD`.
