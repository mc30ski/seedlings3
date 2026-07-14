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

## Third-Party Services

Complete list of external services the app integrates with. Detailed setup for each (env vars, dashboard links, costs) lives in the sections below.

### Identity / Auth

- **Clerk** — user auth on both web (`@clerk/nextjs`) and API (`@clerk/backend`). The legacy `@clerk/clerk-sdk-node` package is still installed but only used by the Playwright e2e sign-in setup.

### Database

- **Neon** — serverless Postgres (`@neondatabase/serverless`, `@prisma/adapter-neon`, `DATABASE_URL`).

### Object Storage

- **Cloudflare R2** — S3-compatible, accessed via `@aws-sdk/client-s3`. Five buckets via these env vars:
  - `R2_BUCKET_NAME` — job-occurrence photos (photos bucket, auto-delete lifecycle)
  - `R2_PROPERTY_PHOTOS_BUCKET_NAME` — property photos (auto-delete lifecycle)
  - `R2_EQUIPMENT_PHOTOS_BUCKET_NAME` — equipment photos (auto-delete lifecycle)
  - `R2_DOCS_BUCKET_NAME` — company documents (permanent, no auto-delete)
  - `R2_RECEIPTS_BUCKET_NAME` — business expense receipts (permanent, no auto-delete)

### Hosting

- **Vercel** — both `seedlings3-web` and `seedlings3-api` deploy here. `main` → Preview, `production` → Production (see [Environments & Deployment](#environments--deployment)).

### Email

- **Resend** — transactional email (`resend` SDK, `RESEND_API_KEY`).

### SMS / Voice

- **Twilio** — text + voice (`twilio` SDK, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`).

### Maps / Geocoding

- **Mapbox** — geocoding + driving distances at `api.mapbox.com` (`MAPBOX_ACCESS_TOKEN`, `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`).

### Weather

- **OpenWeather** — current weather + forecast at `api.openweathermap.org` (`OPENWEATHER_API_KEY`), called from `apps/api/src/routes/worker.ts`.

### IP Geolocation

- **ip-api.com** — keyless fallback for locating a worker if no GPS, called from `apps/api/src/routes/worker.ts`.

### Barcode / UPC Lookup

- **UPCitemDB** — public UPC → product lookup at `api.upcitemdb.com`, called from `apps/api/src/routes/admin.ts` (supplies barcode scan).

### Push Notifications

- **Web Push (VAPID)** — sent via the `web-push` library through whichever browser-vendor push service the user's browser uses (FCM for Chrome, Mozilla Autopush for Firefox, APNs for Safari). Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the web side).

### AI

- **Anthropic** — Claude via `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`. Used for AI-generated estimates and route suggestions (see [AI Features](#ai-features)).

### Long-term Backup (planned — no code yet)

- **Google Drive** — one-way backup of `CompanyDocument` records into a folder in `admin@seedlingslawncare.com`'s Drive. Auth is OAuth 2.0 as the admin user (long-lived refresh token) — NOT a service account. **Not yet implemented in code; Google Cloud setup in progress.**
  - Google Cloud project: `seedlings-documents-backup`
  - OAuth scope: `https://www.googleapis.com/auth/drive` (full Drive access — needed because we point the app at a pre-existing folder)
  - Planned env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID` (different value per environment). Sync will be gated by a `DOCUMENT_SYNC_ENABLED` Setting row (off by default in dev).
  - Full spec: [`docs/features/documents-gdrive-backup.md`](docs/features/documents-gdrive-backup.md).

> **Not integrated:** no payment processor (Stripe/Square/etc.) — payments are recorded manually after the client pays. No third-party error/observability SaaS (Sentry, Datadog, PostHog).

---

## Environments & Deployment

We use **Vercel** for both **web** and **api**.  
There are three environments:

- **Production** – deploys from the **Production Branch** (`production`)
- **Preview** – deploys from any non-production branch (e.g. `main`, feature branches, PRs)
- **Development** – local development using `script.start.api.sh` and `script.start.web.sh` scripts

### Branch strategy

- `main` → **Preview** deployments for both projects
- `production` → **Production** deployments for both projects (either push/merge to this branch or use "Promote to Production" in Vercel which rebuilds with Production env vars)

### Project wiring (Vercel)

Create **two** Vercel projects pointing at this repo:

| Project          | Root Directory | Notes                                |
| ---------------- | -------------- | ------------------------------------ |
| `seedlings3-web` | `apps/web`     | Next.js app                          |
| `seedlings3-api` | `apps/api`     | Fastify API via Serverless Functions |

Set **Node.js = 20.x** for both projects.

For the **API** project you have two options for Output Directory:

The Vercel web application uses a proxy `[...path].ts` to funnel all web requests through so that it can set the bypass tokens to allow access to the API preview.

web application → `api.ts` (adds bypass) → web server `pages/api/_proxy/[...path].ts` → (adds bypass) → API serverless functions

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

## Object Storage (Cloudflare R2)

Photos, documents, and receipts are stored in **Cloudflare R2** (S3-compatible object storage). The API is stateless with respect to bytes — it hands out presigned URLs and clients upload/download directly.

### Setup

- **Cloudflare account** with R2 enabled (free tier: 10GB storage, 10M reads, 1M writes/month).
- **Five buckets** across two categories (each has a `-dev` and prod pair):
  - **Photos** (auto-delete lifecycle):
    - `R2_BUCKET_NAME` — job-occurrence photos (e.g. `seedlings-photos` / `seedlings-photos-dev`)
    - `R2_PROPERTY_PHOTOS_BUCKET_NAME` — property photos (e.g. `seedlings-property-photos` / `-dev`)
    - `R2_EQUIPMENT_PHOTOS_BUCKET_NAME` — equipment photos (e.g. `seedlings-equipment-photos` / `-dev`)
  - **Permanent** (no lifecycle):
    - `R2_DOCS_BUCKET_NAME` — company documents (e.g. `seedlings-documents` / `-dev`) — insurance certs, W-9s, tax records
    - `R2_RECEIPTS_BUCKET_NAME` — business expense receipts (e.g. `seedlings-receipts` / `-dev`)
- **Lifecycle rules**: photo buckets auto-delete objects after their configured retention window; document + receipt buckets have NO lifecycle rules.
- **API token**: created in Cloudflare dashboard → R2 → Manage R2 API Tokens → Object Read & Write, scoped to all five buckets.

### Environment Variables

Set these in `apps/api/.env` (dev) and Vercel environment variables (production):

```
R2_ACCESS_KEY_ID=<your-r2-api-token-access-key>
R2_SECRET_ACCESS_KEY=<your-r2-api-token-secret-key>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET_NAME=seedlings-photos-dev
R2_DOCS_BUCKET_NAME=seedlings-documents-dev
R2_PROPERTY_PHOTOS_BUCKET_NAME=seedlings-property-photos-dev
R2_EQUIPMENT_PHOTOS_BUCKET_NAME=seedlings-equipment-photos-dev
R2_RECEIPTS_BUCKET_NAME=seedlings-receipts-dev
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

## Equipment QR Codes

Each piece of equipment has a `qrSlug` (e.g., `scag-vride-001`). QR codes encode a short URL: `https://seedlings.team/e/{slug}`.

When scanned with a phone camera:

- Opens the app → Equipment tab filtered to that item
- If user has a reservation → prompts to confirm checkout
- If user has an active checkout → prompts to confirm return

### Generating QR Codes

1. Go to https://really-free-qr-code-generator.com
2. Settings:
   - **Type:** URL
   - **Content:** `https://seedlings.team/e/{slug}` (replace `{slug}` with the equipment's QR slug)
   - **Size:** 128px
   - **Error correction:** M
   - **Margin:** 4
3. Download and print. Laminate for outdoor durability.

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

## Feature Overview

The app has grown well beyond its MVP scope. High-level tour of what's shipped, grouped by domain. Each area links to its canonical spec + service files where one exists.

### CRM

- **Clients / Contacts / Properties** — admin CRUD. `Client` (types: individual, household, organization, community) → many `ClientContact`s (with roles and `isPrimary`), many `Property`s (kinds: single vs aggregate site; supports `pointOfContactId` routing to a specific contact). Post-MVP `PropertyUnit` schema exists but is unused.
- **Client View-As** — Super-only read-only impersonation of a specific `ClientContact` for support/debugging. Wire uses an `x-impersonate-client-contact` header; every `GET /me/*` route is either view-as-aware or explicitly annotated. Spec: [`docs/features/client-view-as.md`](docs/features/client-view-as.md). Plugin: [`apps/api/src/plugins/clientImpersonation.ts`](apps/api/src/plugins/clientImpersonation.ts).

### Jobs & scheduling

- **Job / JobSchedule / JobOccurrence** — three-layer model. `Job` is the standing agreement (kind: ENTIRE_SITE vs SINGLE_ADDRESS; status: PROPOSED → ACCEPTED). `JobSchedule` is the auto-renew toggle + cadence. `JobOccurrence` is a real dated instance with its own lifecycle (SCHEDULED → IN_PROGRESS → COMPLETED → CLOSED) and its own kind/assignees (copied from the Job at creation, then editable).
- **Assignments** — two-layered: `JobAssigneeDefault` (usually these workers) → `JobOccurrenceAssignee` (this specific visit). Only WORKER-role users can be assigned. `Group`/`GroupMember` supports crew-based assignment.
- **Occurrence add-ons** — `OccurrenceAddon`, `OccurrenceInstruction`, `OccurrenceChangeRequest`, `OccurrenceComment`, `PinnedOccurrence`, `LikedOccurrence`.
- **Route optimization** — [`apps/api/src/lib/routing/`](apps/api/src/lib/routing/) provides a `RoutingProvider` interface; Mapbox is the only current implementation. `/api/preview/route-suggestions` combines Mapbox distances + Claude for human-readable suggestions.

### Workdays, mileage, vehicles

- **WorkerWorkday** — one row per worker per day (`workdayDate`, `startedAt`, `pausedAt`, `endedAt`, `totalPausedMs`). Approval window is admin-controlled. Services: [`apps/api/src/services/workdays.ts`](apps/api/src/services/workdays.ts).
- **Vehicle / VehicleAssignment / MileageEntry** — per-driver mileage sessions with start/end odometer, ET-anchored `entryDate` (TEXT column, YYYY-MM-DD). Approval mirrors workdays.

### Payments, expenses, taxes

- **Payment / PaymentSplit** — per-occurrence payment collection; splits distribute revenue to workers (employees/trainees made whole on underpay, contractors pro-rata). Spec: [`docs/FINANCIAL_SYSTEM.md`](docs/FINANCIAL_SYSTEM.md). Invariants locked by [`apps/api/src/services/payments-build-gate.test.ts`](apps/api/src/services/payments-build-gate.test.ts).
- **BusinessExpense** — freestanding + job-paired + supply-paired variants. Recurring rows (WEEKLY/MONTHLY/QUARTERLY/ANNUALLY) surface in the "Due to Record" panel with `recurrenceSeriesId` welding the series together across label drift.
- **GuaranteedPayoutAdvance** — time-bounded onboarding window (1–90 days) where contractor pay is decoupled from client payment. Single table does triple-duty: advance tracking, reconciliation flag on `PaymentSplit`, source of 1099 totals.
- **Business Start Date filter** — non-destructive money cleanup: when the setting is on, pre-cutoff `Payment`/`Expense`/`Checkout`/`AuditEvent` rows hide from every view and export. Helpers: [`apps/api/src/lib/businessStartCutoff.ts`](apps/api/src/lib/businessStartCutoff.ts).
- **QuickBooks / tax exports** — [`apps/api/src/services/exports.ts`](apps/api/src/services/exports.ts) generates Schedule C-aware exports. Cash-basis only; shortfall/overage/margin fields are operator-dashboard only, never tax line items. Invariant enforced in the payments build gate.

### Equipment & supplies

- **Equipment** — with QR slug (see below), photos (`EquipmentPhoto`), owner's-manual chunks (`EquipmentInstruction`), and `EquipmentCollection` groupings.
- **Checkout / CheckoutSplit** — checkout lifecycle (`reservedAt` → `checkedOutAt` → `releasedAt`). Group rentals split via `writeCheckoutSplits` at release time. Equipment can opt into per-job billing (`Equipment.equivalentJobs`); `Checkout.rentalCost` stores actual billings, not notional.
- **Supply / SupplyPurchase / SupplyHold / SupplyAdjustment** — inventory with holds during job work + audit trail on adjustments.

### Compliance

- **PolicyDocument** — policy documents with versions, enforcement levels (BLOCK/WARN/INFO), targeted worker types, and required actions (SIGN / SIGN_AND_UPLOAD / ACKNOWLEDGE / NONE).
- **PolicySignature** — immutable revoke-and-replace signatures with content digest pinning + admin-on-behalf audit.
- **PolicyException** — time-bounded excuses per user × policy. Full spec: [`docs/features/compliance.md`](docs/features/compliance.md). Enforced by [`apps/api/src/services/policies-build-gate.test.ts`](apps/api/src/services/policies-build-gate.test.ts).

### Documents

- **CompanyDocument / CompanyDocumentVersion** — company-wide filing cabinet (insurance certs, W-9s, articles of organization, etc.). Stored in R2; taxonomy driven by a `Setting` row. Google Drive backup planned (see Long-term Backup above).

### Observability

- **AuditEvent** — mutation-level audit trail written via [`apps/api/src/lib/auditLogger.ts`](apps/api/src/lib/auditLogger.ts).
- **TimelineEvent** — user-facing event/reminder log with cadence-aware `nextDueDate` and optional archival ([`apps/api/src/services/timelineEvents.ts`](apps/api/src/services/timelineEvents.ts)).
- **Notifications banner** — `BannerNotification` / `BannerRecipient` / `BannerDismissal` for broadcast messages.

### Domain model — full picture

Prisma schema has ~68 models across the areas above. For anything specific: read [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma) — it's the canonical source. Feature-level specs live under [`docs/features/`](docs/features/) and other canonical references live directly in [`docs/`](docs/) (e.g. `DATE_HANDLING.md`, `FINANCIAL_SYSTEM.md`, `VIEW_AS_ENDPOINTS.md`).

---

## API Environment Variables

All API environment variables live in `apps/api/.env` (gitignored). They must also be added to the Vercel project settings for production.

### Required

| Variable           | Description                     | Where to get it                                                          |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`     | Neon Postgres connection string | [Neon Console](https://console.neon.tech) → Project → Connection Details |
| `CLERK_SECRET_KEY` | Clerk backend secret key        | [Clerk Dashboard](https://dashboard.clerk.com) → API Keys                |

### Cloudflare R2 (Photo, Document, and Receipt Storage)

| Variable                           | Description                                                | Where to get it                                                       |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `R2_ACCESS_KEY_ID`                 | R2 API access key                                          | [Cloudflare Dashboard](https://dash.cloudflare.com) → R2 → API Tokens |
| `R2_SECRET_ACCESS_KEY`             | R2 API secret key                                          | Same as above                                                         |
| `R2_ENDPOINT`                      | R2 S3-compatible endpoint                                  | Cloudflare R2 bucket settings                                         |
| `R2_BUCKET_NAME`                   | Job-occurrence photos (auto-delete lifecycle)              | e.g. `seedlings-photos-dev`                                           |
| `R2_PROPERTY_PHOTOS_BUCKET_NAME`   | Property photos (auto-delete lifecycle)                    | e.g. `seedlings-property-photos-dev`                                  |
| `R2_EQUIPMENT_PHOTOS_BUCKET_NAME`  | Equipment photos (auto-delete lifecycle)                   | e.g. `seedlings-equipment-photos-dev`                                 |
| `R2_DOCS_BUCKET_NAME`              | Company documents (permanent, no auto-delete)              | e.g. `seedlings-documents-dev`                                        |
| `R2_RECEIPTS_BUCKET_NAME`          | Business expense receipts (permanent, no auto-delete)      | e.g. `seedlings-receipts-dev`                                         |

### AI & Routing

| Variable              | Description                                                             | Where to get it                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | Claude API key for AI features (estimate generation, route suggestions) | [Anthropic Console](https://console.anthropic.com) → API Keys → Create Key. Requires credits ($5 min).                                         |
| `MAPBOX_ACCESS_TOKEN` | Mapbox token for route optimization (geocoding, driving distances)      | [Mapbox](https://account.mapbox.com) → sign up (free) → default public token on dashboard (starts with `pk.`). Free tier: 100k requests/month. |

### Weather

| Variable              | Description                                                             | Where to get it                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENWEATHER_API_KEY` | OpenWeather current + forecast API key                                  | [OpenWeather](https://openweathermap.org/api) → sign up → API keys. Free tier: 60 calls/min, 1M calls/month.                                   |

### Web Push (VAPID)

Push notifications go through the `web-push` library and each browser's push service (FCM/Mozilla Autopush/APNs). Generate the keypair once with `npx web-push generate-vapid-keys`.

| Variable                          | Description                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`                | VAPID public key (API side, for identifying the sender)                         |
| `VAPID_PRIVATE_KEY`               | VAPID private key                                                               |
| `VAPID_SUBJECT`                   | Contact URL/mailto for the sender (e.g. `mailto:admin@seedlingslawncare.com`)   |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`    | Same public key, exposed to the web app so it can subscribe browsers            |

### Security / operational

| Variable                    | Description                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CRON_SECRET`               | Shared secret required in the `Authorization: Bearer` header for `/api/cron/*` routes; set the same value in Vercel |
| `WEB_ORIGIN`                | Comma-separated allow-list of exact origins for CORS (e.g. `https://seedlings.team,http://localhost:3000`)          |
| `WEB_ORIGIN_REGEX`          | Optional regex for wildcard preview URLs (`^https://seedlings3-web-git-.*\.vercel\.app$`)                           |
| `ADMIN_BOOTSTRAP_EMAILS`    | Comma-separated emails automatically granted ADMIN role on first sign-in (bootstrap mechanism only)                 |
| `PAYMENT_REQUEST_BASE_URL`  | Public URL used to construct client-facing payment request links (defaults to production domain when unset)         |

### AI Features

**Route Optimization** (`/api/preview/route-suggestions`):

- Uses Mapbox Optimization API for real driving distances and optimal stop ordering
- Uses Claude (Sonnet) to interpret the route data and provide human-readable suggestions
- Provider is abstracted: see `apps/api/src/lib/routing/` — add new providers by implementing `RoutingProvider` interface in `types.ts` and registering in `index.ts`
- UI dropdown for provider selection (currently only Mapbox)

**Estimate Generation** (`/api/admin/occurrences/:occurrenceId/generate-estimate`):

- Uses Claude to generate client-facing estimates with a 20% business margin
- Returns both an internal cost breakdown and a client message
- Triggered by "Generate Estimate" button on admin Jobs tab for estimate occurrences

### Domain

**Website**

- Uses Weebly (this is where I manage my domain, even though it's managed by register.com)
- Set up Google here for DNS so that it can use this domain

### Notifications (SMS & Email)

| Variable              | Description                                                  | Where to get it                                          |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`  | Twilio Account SID (starts with `AC...`)                     | [Twilio Console](https://console.twilio.com) → Dashboard |
| `TWILIO_AUTH_TOKEN`   | Twilio Auth Token                                            | Same page, click to reveal                               |
| `TWILIO_PHONE_NUMBER` | Your Twilio SMS number in E.164 format (e.g. `+19196944750`) | Twilio Console → Phone Numbers → Manage → Active Numbers |
| `RESEND_API_KEY`      | Resend email API key (starts with `re_...`)                  | [Resend](https://resend.com) → API Keys → Create         |

- Test with: curl -s -X POST http://localhost:8080/cron/test-notification -H "Content-Type: application/json" -d '{"userId": "cmexiwrfs003kvdysrjteo2hy"}'

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

- Sign up at [resend.com](https://resend.com) - admin@seedlingslawncare.com
- Free tier: 100 emails/day, 3,000/month
- Optional: verify your domain (Domains → Add Domain) to send from `notifications@seedlingslawncare.com` instead of `onboarding@resend.dev`

**Notification System** (`apps/api/src/lib/notifications.ts`):

- `sendSMS(phone, message)` — Twilio wrapper
- `sendEmail(to, subject, body)` — Resend wrapper
- `notifyWorker(userId, message, link)` — auto-picks SMS (if phone) or email

**Cron Jobs** (configured in [`apps/api/vercel.json`](apps/api/vercel.json), require Vercel Pro):

- `/api/cron/daily-notifications` — daily at 22:00 UTC (6pm ET). Queries workers with jobs tomorrow, sends SMS or email with a link to the Plan Next Work Day workflow.
- `/api/cron/guaranteed-payout-expirations` — daily at 05:05 UTC. Finds contractors whose guaranteed-payout onboarding window is expiring soon and posts a Timeline reminder for admins.

Both crons require the `Authorization: Bearer $CRON_SECRET` header (Vercel injects this automatically for scheduled invocations).

### Adding a New Routing Provider

1. Create `apps/api/src/lib/routing/yourprovider.ts` implementing `RoutingProvider` from `types.ts`
2. Register it in `apps/api/src/lib/routing/index.ts` in the `providers` map
3. Add any required env vars to `.env` and Vercel
4. The UI dropdown will automatically include it via the `/api/preview/routing-providers` endpoint

### All Vercel Environment Variables (copy-paste checklist)

For production deployment, add these to the **API** project (Vercel → Project Settings → Environment Variables):

```
# Core
DATABASE_URL=<your Neon production connection string>
CLERK_SECRET_KEY=<your Clerk secret key>

# CORS + admin bootstrap
WEB_ORIGIN=https://seedlings.team,https://seedlingslawncare.com
WEB_ORIGIN_REGEX=^https://seedlings3-web-git-.*\.vercel\.app$
ADMIN_BOOTSTRAP_EMAILS=<comma-separated emails to auto-grant ADMIN on first sign-in>

# R2 (5 buckets)
R2_ACCESS_KEY_ID=<your Cloudflare R2 access key>
R2_SECRET_ACCESS_KEY=<your Cloudflare R2 secret key>
R2_ENDPOINT=<your R2 endpoint URL>
R2_BUCKET_NAME=seedlings-photos
R2_PROPERTY_PHOTOS_BUCKET_NAME=seedlings-property-photos
R2_EQUIPMENT_PHOTOS_BUCKET_NAME=seedlings-equipment-photos
R2_DOCS_BUCKET_NAME=seedlings-documents
R2_RECEIPTS_BUCKET_NAME=seedlings-receipts

# AI + routing + weather
ANTHROPIC_API_KEY=<your Anthropic API key>
MAPBOX_ACCESS_TOKEN=<your Mapbox public token>
OPENWEATHER_API_KEY=<your OpenWeather API key>

# Notifications
TWILIO_ACCOUNT_SID=<your Twilio Account SID>
TWILIO_AUTH_TOKEN=<your Twilio Auth Token>
TWILIO_PHONE_NUMBER=<your Twilio number in +1XXXXXXXXXX format>
RESEND_API_KEY=<your Resend API key>

# Push (VAPID)
VAPID_PUBLIC_KEY=<generated with `npx web-push generate-vapid-keys`>
VAPID_PRIVATE_KEY=<generated with same command>
VAPID_SUBJECT=mailto:admin@seedlingslawncare.com

# Cron auth + payment links
CRON_SECRET=<random long string; same value on Vercel + local .env>
PAYMENT_REQUEST_BASE_URL=https://seedlings.team
```

For the **Web** project (Next.js), also add:

```
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=<your Mapbox public token>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<your Clerk publishable key>
NEXT_PUBLIC_API_BASE_URL=<your API URL>
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same value as VAPID_PUBLIC_KEY above>
```
