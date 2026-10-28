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
 *
 * TWO TIERS, BECAUSE A LONGER LIST IS A WORSE PICKER. The first group is
 * what the picker shows: twenty glyphs for the roles a service business
 * actually has. Everything else is behind "Show more" — two hundred of
 * them, which is a fine library to pick FROM and a terrible grid to be
 * handed unasked. The split is presentation only: `PERSPECTIVE_ICONS` is still
 * the whole set and still the only thing the database and the API
 * validate against, so a role already wearing an icon from the second
 * tier keeps it whatever the picker happens to be showing.
 *
 * THE SECOND TIER IS GROUPED, AND THE ORDER IS THE GROUPING. There are no
 * group headings in the UI — the picker is one grid — so the only thing
 * making two hundred icons scannable is that neighbours mean related
 * things.
 * Add a key next to its kin, never at the end.
 */
export const PERSPECTIVE_ICONS_COMMON = [
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

/**
 * Offered behind "Show more". Same standing as the common ones once chosen.
 * Grouped, and the group order is load-bearing — see the header. These are
 * not lawn-care specific on purpose: an operator naming a bookkeeper, a
 * dispatcher or a safety officer should find a glyph that fits without
 * settling for a leaf.
 */
export const PERSPECTIVE_ICONS_MORE = [
  // Oversight — an auditor, a reviewer, a checker
  "scale",
  "search",
  "clipboard-check",
  // Money
  "receipt",
  // The work itself
  "sprout",
  "tree",
  "scissors",
  // Where the work is
  "map-pin",
  "route",
  // The office
  "calendar",
  "phone",
  "lock",
  // People and roles
  "user-check",
  "user-plus",
  "id-card",
  "handshake",
  // Standing and recognition
  "crown",
  "award",
  "trophy",
  "gavel",
  "badge-check",
  // Places and premises
  "building",
  "factory",
  "store",
  "warehouse",
  "landmark",
  // Paper and records
  "folder",
  "file-text",
  "archive",
  "inbox",
  "book-open",
  "printer",
  "signature",
  // Money
  "dollar-sign",
  "coins",
  "credit-card",
  "wallet",
  "piggy-bank",
  "trending-up",
  "chart-pie",
  "percent",
  "hand-coins",
  // Time
  "calendar-check",
  "calendar-clock",
  "clock",
  "timer",
  "history",
  // Talking to people
  "phone-call",
  "message-square",
  "mail",
  "megaphone",
  "bell",
  "headset",
  // Vehicles and the road
  "car",
  "bus",
  "bike",
  "plane",
  "forklift",
  "tractor",
  "fuel",
  // Tools and maintenance
  "hammer",
  "drill",
  "settings",
  "sliders",
  "gauge",
  "zap",
  "lightbulb",
  "spray-can",
  // Where things are
  "map",
  "navigation",
  "compass",
  "globe",
  "land-plot",
  // Weather and ground
  "tree-pine",
  "flower2",
  "sun",
  "cloud-sun",
  "cloud-rain",
  "droplets",
  "thermometer",
  // Keys and locks
  "unlock",
  "key-round",
  "fingerprint",
  "shield-alert",
  // Status and attention
  "circle-check",
  "circle-alert",
  "triangle-alert",
  "info",
  "heart",
  "sparkles",
  "target",
  // Lists and screens
  "list-checks",
  "layout-dashboard",
  "filter",
  "refresh-cw",
  "database",
  // Odds and ends
  "package",
  "boxes",
  "coffee",
  "camera",
  // Oversight and inspection
  "scan-eye",
  "search-check",
  "file-search",
  "binoculars",
  "microscope",
  "glasses",
  "zoom-in",
  "radar",
  "file-check",
  "book-check",
  // Selling and the storefront
  "shopping-cart",
  "shopping-bag",
  "badge-percent",
  "ticket",
  "barcode",
  "qr-code",
  "gift",
  "scan",
  // Contracts and the law
  "file-signature",
  "file-pen",
  "stamp",
  "scroll-text",
  "file-lock",
  // Hiring and the team
  "user-round-search",
  "user-minus",
  "user-x",
  "contact",
  "briefcase-business",
  // Training and knowledge
  "library",
  "presentation",
  "projector",
  "square-pen",
  "pencil-ruler",
  // Numbers and reporting
  "chart-column",
  "chart-line",
  "chart-spline",
  "trending-down",
  "table",
  "file-spreadsheet",
  // Banking and billing
  "banknote-arrow-up",
  "banknote-arrow-down",
  "circle-dollar-sign",
  "receipt-text",
  "file-clock",
  "split",
  // The building and the site
  "building2",
  "hotel",
  "school",
  "fence",
  "door-open",
  "construction",
  // Trades and the shop
  "paint-roller",
  "paintbrush",
  "ruler",
  "axe",
  "shovel",
  "cog",
  // Growing things
  "shrub",
  "clover",
  "carrot",
  "wheat",
  "bug",
  "dog",
  // Ground and water
  "mountain",
  "waves",
  "wind",
  "cloud-lightning",
  "cloud-snow",
  "umbrella",
  // Moving things
  "truck-electric",
  "caravan",
  "container",
  "package-check",
  "package-open",
  "train-front",
  // Screens and systems
  "server",
  "cloud",
  "wifi",
  "smartphone",
  "laptop",
  // Safety and the first-aid kit
  "siren",
  "fire-extinguisher",
  "life-buoy",
  "octagon-alert",
  "ambulance",
  "stethoscope",
  // Getting the word out
  "rss",
  "share2",
  "at-sign",
  "link",
  "newspaper",
  // Rest and refreshment
  "cup-soda",
  "pizza",
  "utensils",
  "cake",
  "beer",
  // Odds and ends two
  "puzzle",
  "rocket",
  "flag",
  "bookmark",
  "paperclip",
  "pin",
] as const;

export const PERSPECTIVE_ICONS = [
  ...PERSPECTIVE_ICONS_COMMON,
  ...PERSPECTIVE_ICONS_MORE,
] as const;

export type PerspectiveIcon = (typeof PERSPECTIVE_ICONS)[number];

export function isPerspectiveIcon(v: unknown): v is PerspectiveIcon {
  return typeof v === "string" && (PERSPECTIVE_ICONS as readonly string[]).includes(v);
}
