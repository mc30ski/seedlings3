---
name: project-deferred-work
description: Running list of work we consciously deferred — Claude should read this when starting related work and surface anything relevant before writing code.
metadata: 
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-16T00:44:32.905Z
---

# Deferred work — read this when picking up related work

Things we decided NOT to do at the time, with enough context to judge whether
now is the moment. **This is not a backlog of ideas** — every item here was hit
in real work, understood, and consciously postponed.

**How to use it:** when starting work that touches one of the AREA tags below,
raise the matching item before writing code. Delete an item when it is done or
when it stops being true. Add the date it was deferred.

---

## AREA: theming / High contrast — it isn't fully high-contrast
*Deferred 2026-09-15.*

~52 raw pale ramp literals (`bg="gray.50"`, `"orange.50"`) still render as
faint tints in the High contrast theme rather than white. It is **legible
everywhere** — the theme passes the contrast sweep with zero findings — but it
does not live up to its own description ("Maximum contrast, no subtle tints").

The mid-ramp steps (`.400`–`.600`) were already fixed by overriding the raw
ramp under `html[data-theme=contrast]` in `themeTokens.ts` (`CONTRAST_RAMP_CSS`)
— 25 of 30 were failing white-text AA, `yellow.400` worst at 1.53:1.

**Why steps 50–300 were deliberately left alone:** one CSS variable serves both
pale fills AND borders. Forcing `gray.200` to white would erase every border
that uses it as readily as it lightens the fills it was meant to fix. Doing this
properly means either converting the ~52 literals to semantic tokens
individually, or splitting fill/border usage first.

Size: a few hours. Low risk to other themes (the override is scoped to the
contrast condition), but needs the full sweep to verify.

---

## ~~AREA: theming / Profile — the Appearance picker is hidden from holders of `schedule.manage`~~
*Deferred 2026-09-15. **FIXED 2026-10-17.***

`ProfileTab` computed `targetUserId` as "the selected user, or nothing",
defaulting to `""`, so anyone who could view other people's profiles landed
on Profile with no user selected and therefore no Appearance section, no
calendar feed and no season override — all self-only. They had to pick
themselves out of a dropdown to see their own profile. Found while writing a
theme e2e test, which had to work around it.

It was the predicted one-liner: the fallback is now `me?.id`. Picking someone
else still works, and clearing the picker returns you to your own profile.

---

## AREA: theming / fidelity — two known deltas from production
*Deferred 2026-09-15 (both accepted deliberately).*

1. **Secondary text is darker than production.** `fg.muted` went 4.02:1 →
   4.95:1 and `fg.subtle` 2.26:1 → 4.55:1 so they clear AA. This is the ONLY
   intentional visual change to the Light theme. One-line revert in `SURFACES`
   if it is disliked after living with it.
2. **The high-priority card border** is `purple.solid` (`.600`) where
   production had `purple.500`. It is the only ramp value with no exact
   semantic step; adding a sixth step for one site was judged not worth it.

---

## AREA: testing — the contrast sweep does not cover everything
*Noted 2026-09-15.*

`theme-contrast-sweep-owner.spec.ts` measures the **resting state of 34 tab
bodies**. It does NOT cover dialogs, menus, transient/loading states, hover
styling, or the Tasks overlay. Every bug found in those areas was found by eye.
**A clean sweep is not a clean app.** If a theming bug is reported in a dialog,
do not trust the sweep to confirm the fix — measure that dialog directly.

---

## AREA: memory — MEMORY.md is over its size limit
*Noted 2026-09-15.*

~25.8KB against a ~24.4KB soft limit, so it is being TRUNCATED on load — some
index entries are not reaching context at all. It was already over before the
theming entry was added. Needs older entries trimmed into their topic files.
Do not do this unilaterally; it is the user's index.

---

## AREA: deploy — outstanding production steps
*Carried from earlier in 2026-09-15.*

- Several Prisma migrations may still need `prisma migrate deploy` against
  production (dev is current).
- `HOURLY_WEATHER_ENABLED`, `HOURLY_WEATHER_BASE_URL`,
  `HOURLY_WEATHER_ARCHIVE_URL` Setting rows need copying to prod via the Neon
  UI. **The user runs all production writes** — see
  [[feedback-never-write-production-db]].
- None of the theming work touches the database.

---

## AREA: testing — leftover scratch-named spec
*Noted 2026-09-15.*

`tests/e2e/specs/zz-supplyform-owner.spec.ts` still carries the `zz-` scratch
prefix (it predates the 2026-09-15 session). Either rename it to the normal
convention or confirm it is intentionally scratch.

---

## ~~AREA: permissions / areas — the two taxonomy Settings were never created~~
*Noted 2026-10-18. **DONE the same day** — both rows seeded in the `catalogs`
section, AreasTab tier field is a Select-with-Other over `AREA_TIER_NAMES`,
RolesTab offers `MANAGER_TITLES` as chips. Kept here only so the reasoning
below is not lost.*

`docs/features/permissions.md` section **E — Settings** calls for two
config-driven taxonomies, `AREA_TIER_NAMES` and `MANAGER_TITLES`. Sections
A–D of that design all shipped; E did not. Neither Setting row exists and no
code reads either key.

The gap is visible but small:
- `Area.tier` IS a real nullable column, and its schema comment cites
  `AREA_TIER_NAMES` — but nothing populates or suggests from it, so a tier is
  free text today. Two people can type "Region" and "region".
- The role builder suggests no titles when naming a custom role.

Size: small. Add the two rows the way every other taxonomy is added (see
[[feedback-config-driven-taxonomies]] — JSON Setting, not a DB enum), then
have the area editor and the role-name field read them. Remember the Setting
rows must be upserted into dev directly and copied to prod via the Neon UI
([[feedback-settings-dev-then-neon]]).

---

## AREA: exports — there is no QuickBooks export at all
*Noted 2026-10-18. Corrected the same day — the first version of this note
overstated the problem.*

Three things that sound related, all true:

1. There is **no QuickBooks export**. The whole export surface is five
   routes: `expenses.csv`, `capital.csv`, `income.csv`, `workdays.csv`,
   `payroll.csv`. No `qb-journal-expenses.csv` exists, in the working tree
   or at HEAD.
2. **No export emits Contract Labor rows.** `CONTRACT_LABOR_CATEGORY` is
   declared in `services/exports.ts` and referenced nowhere else.
3. `QB_INCLUDE_CONTRACT_LABOR`, a Setting that claimed to switch those rows
   off, was deleted on 2026-10-18 because no code read it. It had been
   rendered as a live toggle on the Settings tab, doing nothing. The
   operator had it set to `false` in production since 2026-06-09.

So **nothing is broken and nothing is owed right now.** The reason this note
exists is the day someone builds a QuickBooks export: contractor payments
must appear EITHER from the app OR from Gusto's own QB integration, never
both, or the books double-count contractor labour. Build the switch in the
same change as the export, not afterwards.

---

## ~~AREA: permissions / areas — area scoping~~ — CLOSED 2026-10-18
*Kept because the reasoning is worth not relitigating.*

**Backlog reached zero-work.** 13 scopable, 7 threaded, 6 remaining — and all
6 are zero-work: five have no GET route at all (`clients.manage`,
`crews.manage`, `estimates.accept`, `money.approve`, `money.record`), and
`clients.contribute`'s only one is `/properties/:x/photos`, a by-id read.
They clear themselves if such a route is ever added, because adding the group
to `THREADED` makes G10 binding. The ratchet ceiling is now 6 and must only
fall.

**Verification exists.** `scripts/verify-area-scope.ts` builds a real
principal, applies the real `areaWhere`, runs real Prisma queries and
compares rows. Eight checks. Run it after `npm run db:seed`.

**The fixture that made it possible:** seed creates **District Lead
(Durham)** — EMPLOYEE, approved, NO company-wide role, Admin only via an
`AreaAssignment` on Durham. Every other persona holds its role company-wide,
and a company-wide grant wins, so without this every scope test passes
vacuously. That is why the gap survived so long.

**Seed bug it found:** a new area tree was built on EVERY reseed — 10 roots,
10 Durhams — because the root was located with an unordered
`findFirst({ parentId: null })` that sometimes grabbed an `E2E_MUT_… Area`
and renamed it, stranding the real data under whichever tree won. Root is now
name + oldest id, duplicates are pruned, the seed is idempotent.

**Decisions taken (operator, 2026-10-18), all recorded in
`GLOBAL_BY_DECISION` with reasons:**
- A lead sees ALL people → `people.view`, and by the same logic
  `crews.view` (a crew is people, not a place), `pricing.view` (one
  catalogue) and `schedule.manage` (its scopable GET is a taxonomy).
- Timesheets and driving are a PERSON and a DAY → `time.view` and
  `routes.plan`. `WorkerWorkday` and `MileageEntry` carry no `areaId` and
  sensibly could not: a Tuesday across two districts belongs to neither.
  `time.manage`, which APPROVES those rows, was already global, so scoping
  the view would have been the inconsistency.

**Do NOT confuse the two "hours" surfaces.** `time.approve` covers per-visit
hours on `JobOccurrence`, which DOES carry an area, and stays territorial.
Workdays and mileage are the other surface and are global. Both get called
"hours"; only one happens in a place.

**If a district lead's workday queue should ever be genuinely theirs**, that
is the point to derive territory from the day's occurrences — a migration
plus an answer to the two-districts question. Not before.
