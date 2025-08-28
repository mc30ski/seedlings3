# -------- deps (workspace: apps/api) --------
FROM node:20-alpine AS deps
WORKDIR /app/apps/api
RUN apk add --no-cache libc6-compat openssl
# install only API workspace deps here (dev deps included for build)
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm ci || npm install

# -------- build (bundle with tsup) --------
FROM node:20-alpine AS builder
# Build inside the API workspace directory
WORKDIR /app/apps/api
RUN apk add --no-cache libc6-compat openssl
# bring API node_modules
COPY --from=deps /app/apps/api/node_modules ./node_modules
# bring the whole repo so tsup can see packages/**
COPY . /app
# build the API (tsup bundles to dist/start.js) and generate prisma client
RUN npm run build

# -------- run --------
FROM node:20-alpine AS runner
WORKDIR /app/apps/api
ENV NODE_ENV=production
# optional metadata (your CI can pass build args)
ARG BUILD_TIME
ARG GIT_COMMIT
ENV BUILD_TIME=${BUILD_TIME}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV COMMIT_SHA=${GIT_COMMIT}
ENV NODE_OPTIONS=--enable-source-maps

# copy minimal runtime
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/apps/api/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma

EXPOSE 8080
CMD ["node", "dist/start.js"]
