FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

COPY seed-data/study1/raw_results.csv ./data/exports/study1/2026-08-11_context_free_5cat_6model_40rep_repaired_with_reasons/raw_results.csv
COPY seed-data/study3/raw_results.csv ./data/exports/study3/2026-08-07_needs_200prompts_6model_2repeat_category_explicit_merged_with_reasons/raw_results.csv

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
