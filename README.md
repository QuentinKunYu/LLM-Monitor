# LLM Brand Recommendation Experiment

Interactive web application for running context-free LLM brand recommendation experiments. Measures **Brand Recommendation Probability at K (BRP@K)** and **Mean Reciprocal Rank (MRR)** for focal brands across multiple LLM providers.

---

## Quick Start

### 1. Install Dependencies

```bash
cd llm-brand-experiment
npm install
```

### 2. Configure API Keys

Copy `.env.example` to `.env` and add your API keys:

```bash
cp .env.example .env
```

Edit `.env` and fill in the keys for the providers you plan to use:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...
```

> **Note:** You only need keys for the providers you intend to test. Unused providers will return an error if selected.

### 3. Start the Server

```bash
npm start
```

Open **http://localhost:3000** in your browser.

---

## Experiment Design

### Prompt Condition: Context-Free

The experiment uses a **context-free** prompt condition. This means:

- ❌ No user identity, profile, or demographics
- ❌ No budget, preference, or need-based constraints
- ❌ No location or behavioral data
- ❌ No prior conversation history
- ❌ No web search or tool use

### Default Prompt Template

```
I'm looking for a [category]. What brands would you recommend?
Please list up to five brands and briefly explain each.
```

The `[category]` placeholder is automatically replaced with the selected product sub-category (e.g., "hiking jacket", "cordless drills").

### Session Rule

Each replicate is treated as a **fresh, independent API call** with no shared conversation history. This ensures that:
1. Brand recommendations are not influenced by prior outputs.
2. Results are statistically independent.
3. Temperature introduces natural variation between replicates.

---

## Metrics

### BRP@K — Brand Recommendation Probability at K

Measures the probability that a focal brand appears within the **top K** recommended brands across all replicates.

```
BRP@K = (# replicates where brand appears in ranks 1..K) / total replicates
```

The app calculates **BRP@1**, **BRP@3**, and **BRP@5**.

**Example:** If "Canon" appears in the top-5 recommendations in 34 out of 40 replicates:
```
BRP@5 = 34 / 40 = 0.85
```

### MRR — Mean Reciprocal Rank

Measures how highly a brand tends to be ranked.

| Rank | Reciprocal |
|------|------------|
| 1    | 1.000      |
| 2    | 0.500      |
| 3    | 0.333      |
| 4    | 0.250      |
| 5    | 0.200      |
| Not mentioned | 0.000 |

```
MRR = mean(reciprocal ranks across all replicates)
```

**Example:** Ranks [1, 2, -, 4, 2] across 5 replicates:
```
MRR = (1 + 0.5 + 0 + 0.25 + 0.5) / 5 = 0.45
```

---

## Application Workflow

1. Open the app at `http://localhost:3000`
2. Select an **LLM model** from the dropdown
3. Select a **product category** (e.g., hiking jacket, CPU, mattress)
4. Optionally edit the **prompt template**
5. Set **number of replicates** (default: 40)
6. Adjust **temperature** (default: 0.7) and **max output tokens** (default: 300)
7. Click **Run Experiment**
8. Watch real-time progress as replicates complete
9. View **raw results** (brands extracted per replicate)
10. View **metrics table** (BRP@1, BRP@3, BRP@5, MRR per focal brand)
11. **Export** raw results CSV, metrics CSV, or experiment config JSON

---

## Project Structure

```
llm-brand-experiment/
├── server.js                  # Express backend & API routes
├── package.json
├── .env                       # API keys (not committed)
├── .env.example               # Template for .env
│
├── config/
│   ├── models.json            # Model definitions (editable)
│   ├── categories_brands.csv  # Product categories & focal brands
│   └── brand_alias_dictionary.csv  # Brand name normalization
│
├── lib/
│   ├── llm-clients.js         # OpenAI / Anthropic / Google API clients
│   ├── brand-extractor.js     # Multi-strategy brand extraction
│   └── metrics.js             # BRP@K and MRR calculations
│
└── public/
    ├── index.html             # Main interface
    ├── index.css              # Stylesheet
    └── app.js                 # Frontend controller
```

---

## Data Files

### `config/categories_brands.csv`

Defines product categories and their focal brands (3 high-visibility + 3 niche per category):

```csv
category,sub_category,brand,visibility_group
camping/hiking,hiking jacket,Patagonia,high_visibility
camping/hiking,hiking jacket,Outdoor Research,niche
```

### `config/brand_alias_dictionary.csv`

Maps brand name variations to a standardized form:

```csv
category,standard_brand,alias,visibility_group
hiking jacket,The North Face,TNF,high_visibility
hiking jacket,The North Face,North Face,high_visibility
```

### `config/models.json`

Lists available LLM models. Edit this file to add or modify models:

```json
{
  "models": [
    {
      "model_id": "gpt-4o",
      "provider": "openai",
      "model_name": "gpt-4o",
      "display_name": "OpenAI GPT-4o",
      "status": "primary"
    }
  ]
}
```

---

## Output Format

### Raw Results CSV

One row per replicate:

| Column | Description |
|--------|-------------|
| `run_id` | Unique experiment run identifier |
| `category` | Parent category |
| `sub_category` | Specific product category |
| `model_id` | Model identifier |
| `model_name` | Model name |
| `replicate` | Replicate number (1-indexed) |
| `prompt_condition` | Always "context-free" |
| `prompt` | The exact prompt sent |
| `response_text` | Full LLM response |
| `brand_1` – `brand_5` | Extracted brands in rank order |
| `timestamp` | ISO timestamp |
| `temperature` | Temperature used |
| `max_output_tokens` | Token limit used |
| `notes` | Any notes or error messages |

### Metrics CSV

One row per focal brand:

| Column | Description |
|--------|-------------|
| `sub_category` | Product category |
| `model_id` | Model used |
| `brand` | Focal brand name |
| `visibility_group` | `high_visibility` or `niche` |
| `n_replicates` | Total replicates |
| `BRP@1` | Brand Recommendation Probability at 1 |
| `BRP@3` | Brand Recommendation Probability at 3 |
| `BRP@5` | Brand Recommendation Probability at 5 |
| `MRR` | Mean Reciprocal Rank |

---

## Adding New Categories

1. Add rows to `config/categories_brands.csv` with the new category, sub-category, brands, and visibility groups
2. Add corresponding alias entries to `config/brand_alias_dictionary.csv`
3. Restart the server

---

## Adding New Models

Edit `config/models.json` and add a new entry:

```json
{
  "model_id": "your-model-id",
  "provider": "openai",       // "openai", "anthropic", or "google"
  "model_name": "gpt-4-turbo",
  "display_name": "OpenAI GPT-4 Turbo",
  "status": "optional"
}
```

Restart the server to pick up changes.

---

## Methodological Notes

- **Independence:** Each replicate is a fresh API call with no shared state.
- **Reproducibility:** Temperature, max tokens, prompt, and model are recorded per run.
- **Auditability:** Full response text is preserved for manual review.
- **Standardization:** Brand alias dictionary ensures consistent brand name matching.
- **No personalization:** Prompts contain zero user-specific context by design.

---

## License

Research use. All rights reserved.
