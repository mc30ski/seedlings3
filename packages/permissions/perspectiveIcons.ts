/**
 * The icons a perspective may be given, as stable KEYS.
 *
 * WHY KEYS AND NOT COMPONENT NAMES. The database stores what an operator
 * picked, and a database must not hold a reference into a UI library — the
 * icon set can be swapped, renamed or dropped, and a column full of
 * `GrUserAdmin` would then point at nothing with no way to tell which rows
 * were affected. A key is ours: `shield` keeps meaning "shield" whatever
 * draws it.
 *
 * WHY THE LIST LIVES HERE. Both halves need it — the web to render the
 * picker and the chip, the API to refuse a value that is not on it — and
 * `@repo/permissions` is the one package both already depend on. The list
 * is plain strings; nothing here imports a UI library.
 *
 * ADDING ONE is two edits: a key here, and its component in the web's
 * `perspectiveIcons.ts` map. The map is exhaustive over this type, so
 * forgetting the second is a type error rather than a blank space in a
 * dropdown.
 */
export const PERSPECTIVE_ICONS = [
  "home",
  "user",
  "user-cog",
  "user-key",
  "users",
  "shield",
  "shield-check",
  "briefcase",
  "clipboard",
  "wrench",
  "truck",
  "leaf",
  "calculator",
  "banknote",
  "chart",
  "key",
  "eye",
  "star",
  "graduation-cap",
  "hard-hat",
] as const;

export type PerspectiveIcon = (typeof PERSPECTIVE_ICONS)[number];

export function isPerspectiveIcon(v: unknown): v is PerspectiveIcon {
  return typeof v === "string" && (PERSPECTIVE_ICONS as readonly string[]).includes(v);
}
