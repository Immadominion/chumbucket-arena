# The Gaffer backend — Bun runtime, runs TypeScript directly (no build step).
FROM oven/bun:1.3.14

WORKDIR /app

# Install deps against the lockfile first for layer caching.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
# Railway injects PORT; this is the local default.
EXPOSE 8787

CMD ["bun", "src/index.ts"]
