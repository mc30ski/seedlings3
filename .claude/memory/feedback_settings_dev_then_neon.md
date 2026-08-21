---
name: feedback-settings-dev-then-neon
description: "When adding new Setting rows, upsert them into the dev DB directly (one-off Prisma script). User copies to prod manually via the Neon UI."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:22:43.288Z
---

**When adding a new Setting key (Prisma `Setting` model), upsert it into the dev database directly as part of the change.** Don't just stop at editing `seed.ts` — the seed only runs on a full reseed, which the user generally avoids between targeted changes.

**Why:** The user's workflow is "update dev DB → copy to prod via Neon UI" for setting-type data. Adding only to seed leaves the dev database without the row until the next reseed, which leaves the SettingsTab UI unable to surface or edit it. The user has flagged this gap explicitly.

**How to apply:** When changes introduce a new key (e.g., `MIN_WAGE_PER_HOUR`, future thresholds):

1. Add the entry to the appropriate seed list in [seed.ts](apps/api/prisma/seed.ts) so a clean reseed keeps working.
2. Also write a one-off upsert script (e.g., `apps/api/prisma/upsert-<key>.ts`) using `PrismaClient.setting.upsert({ where: { key }, create: {...}, update: { description, section } })`. Don't overwrite `value` on update (operator may have customized it).
3. Run with `cd apps/api && npx tsx prisma/upsert-<key>.ts`.
4. Delete the one-off script after — it's not source code, it's a migration-equivalent step.
5. Tell the user the row is in dev so they can copy to prod via Neon.

For setting CHANGES (description, section, default value) rather than new rows: edit seed.ts and let the user reseed; no one-off script needed unless they want the change reflected without a reseed.

**Do NOT create a Prisma migration to update Setting rows.** Migrations are for schema. Data — including backfilling description/section on rows a prior migration inserted with null fields — flows through seed.ts + one-off upsert script → user copies to prod via Neon UI. Migrations that mutate data double the surface area and make prod deploys risky. Corrected 2026-07 after mistakenly writing a data-only migration for `POLICY_STRICT_TWO_EYES` + `POLICY_DEFAULT_GRACE_HOURS`.

Reference example: MIN_WAGE_PER_HOUR was added via this pattern in 2026-06.

Related: [[feedback-always-seed-dev]] — the dev-seeding responsibility split (I always seed dev, user always seeds prod).
