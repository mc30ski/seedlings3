---
name: reference-theming
description: "The 14-theme system — how it works, and the rule that every new feature must be checked against all themes, not just Light and Dark."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-16T00:42:54.057Z
---

# Theming — 14 themes, and why a two-theme habit breaks them

**THE RULE: any new feature, component or colour decision must be checked
against ALL themes, not just Light and Dark.** Half of this system is
dark-grounded or tinted, and the defects below rendered *perfectly* in Light
and Dark while being unusable elsewhere. Nothing throws. Nothing warns.

Run before merging anything that touches UI colour:

```bash
cd apps/api && npm run test:build-gate          # ~1s, catches the static defects
cd apps/web && THEME_SWEEP=1 npx playwright test --project=super \
  theme-contrast-sweep --workers=1              # ~47 min, measures every element
```

## The themes

| Group | Themes |
|---|---|
| Appearance | Light (id `original`) · Dark · High contrast |
| Season | Spring · Summer · Fall · Winter |
| Play | Funkadelic · Retro |
| Warm | Coffeehouse · Espresso |
| Bold | Urban · Jelly · Juice |

**Light's id is `original`.** It has been relabelled twice ("Original" →
"Normal" → "Light"). The ID MUST NOT change — it is what sits in localStorage
and is stamped as `data-theme`, so renaming it silently resets everyone
already on it.

**Dark-grounded but NOT the Dark theme:** Funkadelic, Retro, Espresso, Urban.
This is the single most common source of bugs — `_dark` does not match them.

## The token scale

`faint(.50) → subtle(.100) → muted(.200) → emphasized(.300) → strong(.400) →
solid(.600)`, plus `fg` (ink) and `contrast` (ink that sits ON solid).

`faint` and `strong` exist because Chakra's scale starts at `.100` and jumps
`.300 → .600`. Without them, 455 pale fills and 30 borders landed a step off
and Original stopped matching production.

**`solid` is a FILL that carries `contrast` ink. It is not a text colour** —
`green.solid` is 3.30:1 on plain white and fails outright on a tinted panel.
Use `.fg` for text.

## What is DERIVED, not hand-written

Everything below follows from `SURFACES` in
[`apps/web/src/styles/themeTokens.ts`](apps/web/src/styles/themeTokens.ts):
70 palette tokens per theme, pulse ring tints, splash + boot colours, native
control `color-scheme`. **Adding a theme is one `SURFACES` entry plus a
condition.** Do not hand-write per-theme values — the pulse tints were
hand-written for two themes and every theme added later silently inherited the
light values.

## The failure modes, all of which shipped

1. **`{ base: X, _dark: Y }`** knows two worlds. The `danger` button variant
   used it, so every Delete button was dark-red-on-dark at **1.26:1** on four
   themes. *Gated.*
2. **A raw ramp value or hex is one colour forever.** The title bar was
   `#dce5d0` and rendered identical sage in all 14. *Gated.*
3. **`solid` used as text.** *Gated.*
4. **Adding a theme touches seven maps.** Miss one and it half-lands —
   Funkadelic shipped with the Light header because `buildSemanticColors`
   never learned about it. *Gated.*
5. **`var(--chakra-colors-fg-muted)` resolves to NOTHING.** Chakra emits CSS
   variables only for tokens it knows and for colour palettes; our custom
   namespaces are inlined per condition. Use the prop form, or
   `gradientFrom`/`gradientTo` for gradients. *Gated in
   `section-pattern-build-gate`.*
6. **Inheriting `color` from the title bar.** A dropdown that paints its own
   `bg.panel` but no ink inherited `chrome.headerFg` — white labels on a white
   panel in High contrast, Spring and Fall. A panel that paints a background
   must state its ink.
7. **Anything the boot script sets once.** `--seedlings-boot-bg` is an inline
   style on `<html>`; only the boot script wrote it, so switching theme live
   re-skinned every card and left the page on the previous colour.

## Coverage, and its limits

The sweep measures the **resting state of 34 tab bodies**. It does NOT cover
dialogs, menus, transient/loading states, hover styling, or the Tasks overlay.
Bugs found there were all found by eye, not by the sweep — a loading scrim
pinned to white, the splash flash, the role dropdown. **A clean sweep is not
the same as a clean app.**

Persistence is **per browser** (`localStorage`), never per account — see
[[reference-theming-persistence]] if that ever needs changing.

Related: [[feedback-run-build-gate-after-changes]],
[[reference-build-gates-roster]], [[feedback-never-ship-a-red-spec]].
