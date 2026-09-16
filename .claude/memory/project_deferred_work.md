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

## AREA: theming / Profile — the Appearance picker is hidden from admins
*Deferred 2026-09-15.*

`ProfileTab` computes `targetUserId = isAdmin ? selectedUserId : me.id`, which
defaults to `""`. So an **admin or super lands on Profile and sees no Appearance
section at all** until they pick themselves in the user dropdown. Workers are
fine. Found while writing a theme e2e test, which had to work around it.

Fix is probably one line — default `selectedUserId` to `me.id` for admins — but
check it does not change the "viewing another user" flows on that tab.

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

`theme-contrast-sweep-admin.spec.ts` measures the **resting state of 34 tab
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

`tests/e2e/specs/zz-supplyform-admin.spec.ts` still carries the `zz-` scratch
prefix (it predates the 2026-09-15 session). Either rename it to the normal
convention or confirm it is intentionally scratch.
