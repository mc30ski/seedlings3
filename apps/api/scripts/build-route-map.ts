/**
 * Regenerate `docs/features/permissions-ROUTE-MAP.md` from the route guards.
 *
 * WHY THIS SCRIPT EXISTS
 * The map is what G5 compares every guard against, so it has to be exactly
 * right — and it was maintained by hand with no generator. Three separate
 * ad-hoc "reconcile" scripts have now corrupted it, each in the same way: a
 * regex that recognised only `## entitlement.name (n)` headers, which
 * silently merged the OWNERSHIP / PUBLIC / CLIENT-PORTAL / SYSTEM sections
 * into whichever entitlement group happened to precede them. Row counts
 * stayed plausible while ~143 routes sat in the wrong bucket.
 *
 * The fix is to stop hand-reconciling and derive the whole body from the one
 * source of truth: the guards themselves.
 *
 * WHAT IT PRESERVES
 * Everything above the first group header — the prose findings, the counts
 * paragraph, the warnings. That is human commentary and this script never
 * touches it. Only the group sections below it are rewritten.
 *
 * Usage:  npx tsx scripts/build-route-map.ts          (writes)
 *         npx tsx scripts/build-route-map.ts --check  (exits 1 on drift)
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, basename } from "path";

const ROUTES = resolve(__dirname, "../src/routes");
const MAPFILE = resolve(__dirname, "../../../docs/features/permissions-ROUTE-MAP.md");

/** Bucket names the gates treat as non-entitlement. Keep in sync with G24c. */
const OWNERSHIP = "OWNERSHIP";
const PUBLIC = "PUBLIC";
const CLIENT_PORTAL = "CLIENT-PORTAL";
const SYSTEM = "SYSTEM";

const norm = (p: string) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x");

type Row = { verb: string; path: string };
const groups = new Map<string, Row[]>();
const add = (g: string, verb: string, path: string) => {
  const rows = groups.get(g) ?? [];
  rows.push({ verb, path: norm(path) });
  groups.set(g, rows);
};

for (const file of readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const src = readFileSync(join(ROUTES, file), "utf8");
  // guard const -> entitlement
  const g2e = new Map<string, string>();
  for (const m of src.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*requires\(\s*"([^"]+)"\s*\)/g)) {
    g2e.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/app\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"\s*(?:,\s*([A-Za-z0-9_.]+))?/g)) {
    const verb = m[1].toUpperCase();
    const path = m[2];
    const guard = m[3] ?? "";
    const ent = g2e.get(guard);
    if (ent) { add(ent, verb, path); continue; }
    if (guard === "approvedUser") { add(OWNERSHIP, verb, path); continue; }
    if (guard === "clientGuard") { add(CLIENT_PORTAL, verb, path); continue; }
    // No recognised guard. Bucket by file: these are the routes that have no
    // principal to check, not routes somebody forgot to guard.
    const f = basename(file);
    if (f === "public.ts") add(PUBLIC, verb, path);
    else if (f === "system.ts" || f === "cron.ts") add(SYSTEM, verb, path);
    else add(OWNERSHIP, verb, path); // me.ts — your own data, caller-scoped in-handler
  }
}

const existing = readFileSync(MAPFILE, "utf8");
const lines = existing.split("\n");
// Preamble = everything before the first group header of ANY kind.
const HDR = /^## ([A-Za-z][A-Za-z.\-]*)\s+\(\d+\)\s*$/;
let bodyStart = lines.findIndex((l) => HDR.test(l));
if (bodyStart < 0) bodyStart = lines.length;
const preamble = lines.slice(0, bodyStart);

// Entitlement groups first (sorted), then the four non-entitlement buckets.
const isEnt = (g: string) => g.includes(".");
const entNames = [...groups.keys()].filter(isEnt).sort();
const bucketNames = [OWNERSHIP, CLIENT_PORTAL, PUBLIC, SYSTEM].filter((b) => groups.has(b));

const out: string[] = [...preamble];
let total = 0;
for (const name of [...entNames, ...bucketNames]) {
  const rows = [...groups.get(name)!]
    .map((r) => `| \`${r.verb}\` | \`${r.path}\` |`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  total += rows.length;
  out.push(`## ${name}  (${rows.length})`, "| | |", "|---|---|", ...rows, "");
}

const next = out.join("\n").replace(/\n+$/, "\n");
if (process.argv.includes("--check")) {
  if (next !== existing) {
    console.error("route map is STALE — run: npx tsx scripts/build-route-map.ts");
    process.exit(1);
  }
  console.log(`route map up to date (${total} rows)`);
} else {
  writeFileSync(MAPFILE, next);
  console.log(`wrote ${total} rows across ${entNames.length} entitlements + ${bucketNames.length} buckets`);
}
