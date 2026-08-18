FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends r-base \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/var/data

EXPOSE 3000

CMD ["npm", "start"]
