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

### Notifications (SMS & Email)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (starts with `AC...`) | [Twilio Console](https://console.twilio.com) → Dashboard |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | Same page, click to reveal |
| `TWILIO_PHONE_NUMBER` | Your Twilio SMS number in E.164 format (e.g. `+19196944750`) | Twilio Console → Phone Numbers → Manage → Active Numbers |
| `RESEND_API_KEY` | Resend email API key (starts with `re_...`) | [Resend](https://resend.com) → API Keys → Create |

**Twilio (SMS) Setup:**
- Sign up at [twilio.com](https://www.twilio.com)
- Buy a local US number with SMS capability (~$1.15/month). Pick an area code matching your business area (e.g., 919 for Chapel Hill)
- **A2P 10DLC Registration required** — US carriers require this for application-to-person messaging:
  1. Go to Messaging → Trust Hub → A2P Registration
  2. Register as Sole Proprietor (no EIN needed) or Business
  3. Create a Messaging Service and register a Campaign (category: "Staff notifications")
  4. Costs: ~$2 one-time brand registration + ~$1.50/month campaign fee
  5. Takes 1-3 business days for approval
  6. During trial/pending approval, you can still test with Verified Caller IDs
- Total cost: ~$3/month for phone number + registration

**Resend (Email) Setup:**
- Sign up at [resend.com](https://resend.com)
- Free tier: 100 emails/day, 3,000/month
- Optional: verify your domain (Domains → Add Domain) to send from `notifications@seedlingslawncare.com` instead of `onboarding@resend.dev`

**Notification System** (`apps/api/src/lib/notifications.ts`):
- `sendSMS(phone, message)` — Twilio wrapper
- `sendEmail(to, subject, body)` — Resend wrapper
- `notifyWorker(userId, message, link)` — auto-picks SMS (if phone) or email

**Daily Cron Job** (`/api/cron/daily-notifications`):
- Configured in `vercel.json` to run daily at 6pm ET (10pm UTC)
- Queries workers with jobs tomorrow
- Sends SMS or email with link to start Plan Next Work Day workflow
- Requires Vercel Pro plan for cron jobs

### Adding a New Routing Provider

1. Create `apps/api/src/lib/routing/yourprovider.ts` implementing `RoutingProvider` from `types.ts`
2. Register it in `apps/api/src/lib/routing/index.ts` in the `providers` map
3. Add any required env vars to `.env` and Vercel
4. The UI dropdown will automatically include it via the `/api/preview/routing-providers` endpoint

### All Vercel Environment Variables (copy-paste checklist)

For production deployment, add these to Vercel → Project Settings → Environment Variables:

```
DATABASE_URL=<your Neon production connection string>
CLERK_SECRET_KEY=<your Clerk secret key>
R2_ACCESS_KEY_ID=<your Cloudflare R2 access key>
R2_SECRET_ACCESS_KEY=<your Cloudflare R2 secret key>
R2_ENDPOINT=<your R2 endpoint URL>
R2_BUCKET_NAME=<photo bucket name>
R2_DOCS_BUCKET_NAME=<documents bucket name>
ANTHROPIC_API_KEY=<your Anthropic API key>
MAPBOX_ACCESS_TOKEN=<your Mapbox public token>
TWILIO_ACCOUNT_SID=<your Twilio Account SID>
TWILIO_AUTH_TOKEN=<your Twilio Auth Token>
TWILIO_PHONE_NUMBER=<your Twilio number in +1XXXXXXXXXX format>
RESEND_API_KEY=<your Resend API key>
```

For the web app (Next.js), also add:
```
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=<your Mapbox public token>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<your Clerk publishable key>
NEXT_PUBLIC_API_BASE_URL=<your API URL>
```
