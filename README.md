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
