# -------- deps --------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# -------- build --------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client & then build TS -> dist
RUN npx prisma generate && npm run build

# -------- run --------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Accept build-time metadata (optionally passed via --build-arg)
ARG BUILD_TIME
ARG GIT_COMMIT
# Expose as runtime env vars for the /version endpoint
ENV BUILD_TIME=${BUILD_TIME}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV COMMIT_SHA=${GIT_COMMIT}

# (Optional) nicer stack traces in prod
ENV NODE_OPTIONS=--enable-source-maps

# App files
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

EXPOSE 8080
CMD ["node", "dist/index.js"]
