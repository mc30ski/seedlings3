---
name: feedback-header-line-height-zero
description: "The header's right-hand control strip sets inline lineHeight:0; anything rendered inside it collapses its text to zero height."
metadata:
  node_type: memory
  type: feedback
---

The right-hand control strip in the title bar (`pages/index.tsx`, the raw
`<div style={{ justifySelf: "end", …, lineHeight: 0 }}`) zeroes line height
to kill the whitespace between its icons. **Anything rendered inside it
inherits that**, including dropdown panels, because those are plain children
rather than portals.

The symptom is subtle: a menu row collapses to its PADDING alone — 16px for
`py={2}` — and the label overflows its own row. It still paints, so it looks
merely cramped rather than broken, and a row that happens to contain an icon
looks right because the icon supplies the height the text cannot.

Both header menus had it. `RoleChip` looked obviously wrong; `ThemeChip` hid
it behind its colour swatches. Fixed by setting `lineHeight="normal"` on each
PANEL, not by touching the strip — the strip needs its zero for the icons.

**How to spot it:** measure, don't look. `getBoundingClientRect().height` on
the row, or computed `lineHeight` on the label. 16px rows with `py={2}` means
zero-height content. Related: [[reference-theming]] (the other class of
header bug — contrast), [[feedback-appsplash-stable-dont-regress]].
