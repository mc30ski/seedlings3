# API (Fastify + Prisma)

- Serverless Functions on Vercel (Fastify + Prisma)

## DB (Neon postgresql)

- Dev
  npm run prisma:generate
  npm run prisma:migrate:dev
  npm run db:seed

- Production/CI:
  npm run prisma:generate
  npm run prisma:migrate:deploy
  npm run db:seed

## Environment Variables

All API environment variables live in `apps/api/.env` (gitignored). They must also be added to the Vercel project settings for production.

### Required

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `DATABASE_URL` | Neon Postgres connection string | [Neon Console](https://console.neon.tech) → Project → Connection Details |
| `CLERK_SECRET_KEY` | Clerk backend secret key | [Clerk Dashboard](https://dashboard.clerk.com) → API Keys |

### Cloudflare R2 (Photo & Document Storage)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `R2_ACCESS_KEY_ID` | R2 API access key | [Cloudflare Dashboard](https://dash.cloudflare.com) → R2 → API Tokens |
| `R2_SECRET_ACCESS_KEY` | R2 API secret key | Same as above |
| `R2_ENDPOINT` | R2 S3-compatible endpoint | Cloudflare R2 bucket settings |
| `R2_BUCKET_NAME` | Photo bucket name (has auto-delete lifecycle) | e.g. `seedlings-photos-dev` |
| `R2_DOCS_BUCKET_NAME` | Document bucket name (permanent, no auto-delete) | e.g. `seedlings-documents-dev` |

### AI & Routing

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `ANTHROPIC_API_KEY` | Claude API key for AI features (estimate generation, route suggestions) | [Anthropic Console](https://console.anthropic.com) → API Keys → Create Key. Requires credits ($5 min). |
| `MAPBOX_ACCESS_TOKEN` | Mapbox token for route optimization (geocoding, driving distances) | [Mapbox](https://account.mapbox.com) → sign up (free) → default public token on dashboard (starts with `pk.`). Free tier: 100k requests/month. |

### AI Features

**Route Optimization** (`/api/preview/route-suggestions`):
- Uses Mapbox Optimization API for real driving distances and optimal stop ordering
- Uses Claude (Sonnet) to interpret the route data and provide human-readable suggestions
- Provider is abstracted: see `apps/api/src/lib/routing/` — add new providers by implementing `RoutingProvider` interface in `types.ts` and registering in `index.ts`
- UI dropdown for provider selection (currently only Mapbox)

**Estimate Generation** (`/api/admin/occurrences/:id/generate-estimate`):
- Uses Claude to generate client-facing estimates with a 20% business margin
- Returns both an internal cost breakdown and a client message
- Triggered by "Generate Estimate" button on admin Jobs tab for estimate occurrences

### Adding a New Routing Provider

1. Create `apps/api/src/lib/routing/yourprovider.ts` implementing `RoutingProvider` from `types.ts`
2. Register it in `apps/api/src/lib/routing/index.ts` in the `providers` map
3. Add any required env vars to `.env` and Vercel
4. The UI dropdown will automatically include it via the `/api/preview/routing-providers` endpoint
