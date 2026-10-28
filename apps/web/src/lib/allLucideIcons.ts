/**
 * EVERY LUCIDE ICON, IN ONE LAZY CHUNK.
 *
 * This module exists to be `import()`ed, never imported statically. A
 * namespace import defeats tree-shaking on purpose: webpack puts the whole
 * of lucide-react — around 1,850 components — into the single async chunk
 * this file becomes, and nothing of it reaches the main bundle.
 *
 * WHY NOT THE OBVIOUS ALTERNATIVES.
 *
 * Static named imports for all 1,850 would add roughly a megabyte of
 * JavaScript to the first paint of every page, because the icon map is
 * reachable from the header chip, which is on screen always.
 *
 * `DynamicIcon` / `dynamicIconImports` loads ONE icon per chunk, which is
 * right for one icon and catastrophic for a grid: the picker mounts every
 * icon at once, so it would ask for 1,835 separate chunks in a single
 * frame. One 1MB chunk beats 1,835 small ones by a wide margin, and it is
 * only ever fetched by somebody who opened the picker.
 *
 * Callers go through `lib/perspectiveIcons.tsx`, which serves the common
 * icons synchronously from a static map and only reaches here for the rest.
 */
import * as Lucide from "lucide-react";

/**
 * Lucide's kebab name → its component.
 *
 * The transform is theirs, not ours: split on "-", capitalise each part,
 * join. `flower-2` → `Flower2`, `a-arrow-down` → `AArrowDown`. An earlier
 * hand-rolled version split on letter/digit boundaries too and produced
 * `flower2`, which is not a name lucide knows — see the legacy aliases in
 * `@repo/permissions`.
 */
export function lucideByKebab(key: string): React.ElementType | null {
  const pascal = key
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("");
  const found = (Lucide as unknown as Record<string, unknown>)[pascal];
  return typeof found === "function" || (typeof found === "object" && found !== null)
    ? (found as React.ElementType)
    : null;
}
