# seedlings3 Monorepo

Monorepo managed with Turborepo.

- **Web**: Next.js + Chakra UI (deployed on Vercel)
- **API**: Fastify (TypeScript) + Prisma + Neon (deployed on Vercel using Serverless Functions)
- **Mobile**: Expo (React Native) + React Native Paper

## Quickstart

```bash
npm install
npm run dev
```

- Web: `apps/web` on http://localhost:3000
- API: `apps/api` on http://localhost:8080
- Mobile: `apps/mobile` via `npx expo start` (or `npm run dev` inside `apps/mobile`)

---

## Environments & Deployment

We use **Vercel** for both **web** and **api**.  
There are three environments:

- **Production** – deploys from the **Production Branch** (`production`)
- **Preview** – deploys from any non-production branch (e.g. `main`, feature branches, PRs)
- **Development** – local development using `script.start.api.sh` and `script.start.web.sh` scripts

### Branch strategy

- `main` → **Preview** deployments for both projects
- `production` → **Production** deployments for both projects  
  (either push/merge to this branch or use “Promote to Production” in Vercel which rebuilds with Production env vars)

### Project wiring (Vercel)

Create **two** Vercel projects pointing at this repo:

| Project          | Root Directory | Notes                                |
| ---------------- | -------------- | ------------------------------------ |
| `seedlings3-web` | `apps/web`     | Next.js app                          |
| `seedlings3-api` | `apps/api`     | Fastify API via Serverless Functions |

Set **Node.js = 20.x** for both projects.

For the **API** project you have two options for Output Directory:

The Vercel web application uses a proxy `[...path].ts` to funnel all web requests through so that it can set the bypass tokens to allow access to the API preview.

web application → `api.ts` (adds bypass) → web server `pages/api/_proxy/[...path].ts` → (adds bypass) → api server less functions

---

## Database & Prisma Workflow

The project uses **Prisma** with a **Neon Postgres** database.  
Neon has two branches:

- `production` (parent) — live database.
- `development` (child) — for dev/testing.

### Local Development

1. Ensure `DATABASE_URL` in your local `.env` points to the **Neon development branch**.
2. Make schema changes in `apps/api/prisma/schema.prisma`.
3. Run:

   ```bash
   npm -w apps/api run prisma:migrate:dev   # creates & applies a new migration to Neon dev
   npm -w apps/api run db:seed             # optional, dev-only
   ```

   This both writes a new timestamped migration to `apps/api/prisma/migrations` **and** updates the Neon development DB.

4. Commit the migration files and open a PR to `main`.

### Promoting to Production

When ready to release:

1. Merge `main` → `production` branch of your **code**.
2. Set `DATABASE_URL` to the Neon **production** branch and run:

   ```bash
   npm -w apps/api run prisma:generate
   npm -w apps/api run prisma:migrate:deploy
   ```

   `migrate:deploy` applies the committed migrations to Neon production.

3. Deploy the web/API to Vercel with the production env vars (Neon prod `DATABASE_URL`, Clerk prod keys, etc.).

You can run these promotion steps manually from your laptop or later automate them in CI/CD.

### Key Points & Best Practices

- **Environment separation**  
  Keep two DATABASE_URLs: one for the Neon development branch, one for production.  
  Configure them separately in Vercel (preview vs production) and your local `.env`.

- **Migrations**

  - Use `prisma migrate dev` only in development.
  - Use `prisma migrate deploy` for production to apply already-generated migrations.

- **Seeding**  
  The `db:seed` script is intended for development and test data.  
  If you ever seed production, make it idempotent and safe to re-run.

- **Enum changes / destructive updates**  
  Add enum values in separate migrations. For breaking changes, use a 2-phase rollout (add new column → backfill → remove old).

---

## Photo Storage (Cloudflare R2)

Job occurrence photos are stored in **Cloudflare R2** (S3-compatible object storage).

### Setup

- **Cloudflare account** with R2 enabled (free tier: 10GB storage, 10M reads, 1M writes/month)
- **Four buckets** across two categories:
  - **Photos** (auto-delete after 90 days via lifecycle rules):
    - `seedlings-photos-dev` — development
    - `seedlings-photos` — production
  - **Documents** (permanent — no lifecycle rules):
    - `seedlings-documents-dev` — development
    - `seedlings-documents` — production
- **Lifecycle rules**: photo buckets have an object lifecycle rule to auto-delete after 90 days. Document buckets have NO lifecycle rules (insurance certs, W-9s, etc. are permanent).
- **API token**: created in Cloudflare dashboard → R2 → Manage R2 API Tokens → Object Read & Write, scoped to all four buckets

### Environment Variables

Set these in `apps/api/.env` (dev) and Vercel environment variables (production):

```
R2_ACCOUNT_ID=<your-cloudflare-account-id>
R2_ACCESS_KEY_ID=<your-r2-api-token-access-key>
R2_SECRET_ACCESS_KEY=<your-r2-api-token-secret-key>
R2_BUCKET_NAME=seedlings-photos-dev         # or seedlings-photos for production
R2_DOCS_BUCKET_NAME=seedlings-documents-dev # or seedlings-documents for production
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

### How It Works

1. Worker completes a job and taps "Add Photos"
2. Browser compresses images client-side (max 1200px, 80% JPEG quality) before upload
3. Frontend requests presigned upload URLs from the API
4. Frontend uploads directly to R2 (API never handles image bytes)
5. API saves photo metadata (`JobOccurrencePhoto` table) with the R2 object key
6. R2 lifecycle rule auto-deletes files after the configured retention period

### Key Points

- **No image data in Postgres** — only metadata (R2 key, uploader, timestamp)
- **Presigned URLs** — uploads/downloads go directly to R2, not through your API/Vercel functions
- **Client-side compression** — reduces 5MB phone photos to ~150KB before upload
- **Auto-expiration** — Cloudflare lifecycle rules handle cleanup, no cron needed

---

## Summary Workflow

**Development**

```bash
# Feature branch
npm -w apps/api run prisma:migrate:dev   # Neon dev branch
npm -w apps/api run db:seed              # optional
git add apps/api/prisma/migrations
git commit -m "feat(db): schema update"
# PR -> merge to main
```

**Production Promotion**

```bash
# After merge main -> production
export DATABASE_URL="postgres://...neon.tech?branch=production"
npm -w apps/api run prisma:generate
npm -w apps/api run prisma:migrate:deploy
# Deploy API + Web via Vercel with prod env vars
```

# Domain Model - Clients/Properties/Jobs

## Core Objects

- Client — who we serve (individual, household, organization, community)
- ClientContact — people we call/text/email for a Client
- Property — where we serve (single address or aggregate site/community)
- PropertyUnit (optional, post-MVP) — sub-locations inside an aggregate site

- Client

  - 1──< ClientContact
  - 1──< Property (attr:pointOfContactId ──► ClientContact) 1──< PropertyUnit (optional, post-MVP)

## What Ships Now (Admin-Only)

- Admins create/edit Clients, Contacts, and Properties.
- No prospect/approval states in MVP.
- Default comms routing: use `Property.pointOfContactId`.

## Entity Notes

- Client
  - Types: `individual | household | organization | community`
  - Has many **ClientContacts** and **Properties**
  - Keep `notesInternal`
- ClientContact
  - `isPrimary` (prefer exactly one)
  - Optional `role` (`owner | spouse | community_manager | property_manager | billing | technical | operations | legal | other`)
  - `normalizedPhone` + unique `email` for dedupe
- Property
  - `kind`: `single | aggregate_site`
  - Aggregate site extras: `siteName`, `unitLabel` (e.g., “home”), `unitCount` (rough OK), optional `siteBoundaryGeo`
  - `pointOfContactId` → **ClientContact** (default POC)
- PropertyUnit (post-MVP)
  - Optional sub-locations for aggregate sites (only if you need per-unit notes/codes/photos)

1. Job = the template
   A Job represents the standing “work agreement” for a Property.

- kind (required): ENTIRE_SITE vs SINGLE_ADDRESS
- status: PROPOSED → ACCEPTED
- clients: which business entities are involved (owner/payer/etc.)
- contacts: which people to communicate with (decision maker/on-site/notify)

2. JobSchedule = the auto-renew toggle
   Instead of true recurring calendar events, JobSchedule just stores:

- autoRenew on/off
- a simple cadence (weekly/biweekly/monthly) + a couple parameters
- optional preferred time window
- helpers like horizonDays / nextGenerateAt

3. JobOccurrence = a real calendar entry (the instance)
   Each scheduled visit is a real row.

- has dates (windowStart/windowEnd and/or startAt/endAt)
- has its own lifecycle (SCHEDULED → COMPLETED)
- has its own kind (required), initially copied from the Job but editable

Important: the “copy Job.kind → JobOccurrence.kind” happens in your service code when creating the occurrence.

4. Assignments are two-layered (defaults + per-instance overrides)

- JobAssigneeDefault: “usually these workers do this job”
- JobOccurrenceAssignee: “these workers are assigned to this specific visit”

When you create an occurrence, you typically:

- copy Job.kind → JobOccurrence.kind
- copy JobAssigneeDefault (active) → JobOccurrenceAssignee

After creation, you can change the occurrence assignees without touching defaults.

5. Only WORKER users can be assigned
   This is enforced in your API/service layer:

- only allow assignment if user.roles.some({ role: WORKER })
- (optionally) also require user.isApproved = true

## Post-MVP Plug-Ins (drop-in later)

- **Worker submissions & approvals**: add `reviewStatus` to Client (`PENDING | APPROVED | REJECTED`), optional `Property.status` (`PENDING | ACTIVE`)
- **Jobs**: add `Job`, `JobContact`, `JobClient`, optional `Job.scope` (`entire_site | single_address`) and `JobUnit`
- **Granularity** for sites: add `PropertyUnit` when per-unit state is needed
- **Security/PII**: encrypt sensitive `accessNotes` if you store codes; audit reads

---

## API Environment Variables

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
