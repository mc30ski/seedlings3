# -------- deps (workspace: apps/api) --------
FROM node:20-bookworm-slim AS deps
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm ci || npm install

# -------- build (bundle with tsup) --------
FROM node:20-bookworm-slim AS builder
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/apps/api/node_modules ./node_modules
# Bring whole repo so tsup can see packages/**
COPY . /app
# Build (bundles to dist/start.js) and generate Prisma client
RUN npm run build

# -------- run --------
FROM node:20-bookworm-slim AS runner
WORKDIR /app/apps/api
ENV NODE_ENV=production
# Optional metadata for /version
ARG BUILD_TIME
ARG GIT_COMMIT
ENV BUILD_TIME=${BUILD_TIME}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV COMMIT_SHA=${GIT_COMMIT}
ENV NODE_OPTIONS=--enable-source-maps

# Minimal runtime payload
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/apps/api/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma

EXPOSE 8080
CMD ["node", "dist/start.js"]
