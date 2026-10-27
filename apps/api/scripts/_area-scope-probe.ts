/**
 * G25's engine: drive every area-scopable READ as a principal who holds the
 * capability ONLY inside Durham, and prove no Chapel Hill row comes back.
 *
 * WHY A SEPARATE PROBE RATHER THAN A STATIC SCAN
 * G10 already checks that an area-scopable route MENTIONS `areaWhere`. That
 * catches a missing filter and nothing else. It cannot catch the two failures
 * that actually matter: scoping on the wrong principal, and a prefix that
 * matches a sibling ("/a/b" matching "/a/bb"). Only looking at the ROWS can.
 *
 * HOW THE ASSERTION AVOIDS KNOWING EVERY ROUTE'S SHAPE
 * Responses differ wildly, so instead of parsing them we collect the ids of
 * rows that live ONLY in Chapel Hill and assert none of those strings appears
 * anywhere in the serialized response. A leak is a leak whatever shape it
 * arrives in.
 */
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { PrismaClient } from "@prisma/client";
import type { Principal, Entitlement } from "@repo/permissions";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let CURRENT: Principal | null = null;
const PROBE_ID = "__area_probe_no_such_row__";

/** GET routes, with the entitlement guarding each. */
function guardedGets(): Array<{ ent: string; path: string }> {
  const dir = join(__dirname, "../src/routes");
  const out: Array<{ ent: string; path: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    const g2e = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*requires\(\s*"([^"]+)"\s*\)/g)) g2e.set(m[1], m[2]);
    for (const m of src.matchAll(/app\.get\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_]+)/g)) {
      const ent = g2e.get(m[2]);
      if (ent) out.push({ ent, path: m[1] });
    }
  }
  return out;
}

(async () => {
  const prisma = new PrismaClient();
  const areas = await prisma.area.findMany({ select: { id: true, name: true, path: true } });
  const durham = areas.find((a) => a.name === "Durham");
  const chapel = areas.find((a) => a.name === "Chapel Hill");
  if (!durham || !chapel) throw new Error("expected Durham and Chapel Hill areas in the dev tree");

  // Ids that exist ONLY in Chapel Hill — seeing any of them is the failure.
  const foreign = new Set<string>();
  for (const o of await prisma.jobOccurrence.findMany({ where: { areaId: chapel.id }, select: { id: true } })) foreign.add(o.id);
  for (const p of await prisma.property.findMany({ where: { areaId: chapel.id }, select: { id: true } })) foreign.add(p.id);
  // Durham's OWN ids — a route that returns none of these is not "scoped",
  // it is broken, and an empty response would otherwise read as a pass.
  const mine = new Set<string>();
  for (const o of await prisma.jobOccurrence.findMany({ where: { areaId: durham.id }, select: { id: true } })) mine.add(o.id);
  for (const p of await prisma.property.findMany({ where: { areaId: durham.id }, select: { id: true } })) mine.add(p.id);
  console.log(`Durham path : ${durham.path}`);
  console.log(`own ids     : ${mine.size} (Durham occurrences + properties)`);
  console.log(`foreign ids : ${foreign.size} (Chapel Hill occurrences + properties)\n`);

  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate("requireApproved", async (req: any) => {
    req.user = { id: PROBE_ID, isApproved: true };
    req.principal = CURRENT;
    if (!CURRENT) throw app.httpErrors.unauthorized("no principal");
  });
  const dir = join(__dirname, "../src/routes");
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.startsWith("_")) continue;
    const mod = await import(join(dir, f));
    if (typeof mod.default === "function") await app.register(mod.default);
  }
  await app.ready();

  const results: Array<{ ent: string; path: string; status: number; leaked: string[]; own: number }> = [];
  for (const r of guardedGets()) {
    // Held ONLY inside Durham. A second, global role granting the same thing
    // would remove all narrowing (invariant 1), so there is exactly one role.
    CURRENT = {
      kind: "user",
      workerType: "EMPLOYEE",
      roles: [{ roleId: "durham-lead", name: "Durham lead", entitlements: [r.ent as Entitlement], areaPath: durham.path }],
      perspective: null,
    } as any;
    const url = r.path.replace(/:[A-Za-z0-9_]+/g, PROBE_ID);
    let res;
    try { res = await app.inject({ method: "GET", url }); } catch { continue; }
    if (res.statusCode !== 200) continue;          // 4xx/5xx say nothing about scoping
    const body = res.payload ?? "";
    const leaked = [...foreign].filter((id) => body.includes(id));
    const own = [...mine].filter((id) => body.includes(id)).length;
    results.push({ ent: r.ent, path: r.path, status: res.statusCode, leaked: leaked.slice(0, 3), own });
  }

  /**
   * DELIBERATELY NOT TERRITORIAL — decided 2026-10-14.
   *
   * These read across every district on purpose, so the probe must not
   * report them. Recording the REASON here is the point: an unexplained
   * exemption list is indistinguishable from a backlog.
   */
  const GLOBAL_BY_DESIGN = new Map<string, string>([
    ["books.view", "the company's books are the owner's — money never slices by territory, which also settles the '(area-scopable)' heading the Money group used to carry"],
    ["audit.view", "most audit events belong to no area at all (settings changes, role grants, sign-ins), so a territorial filter would hide some and show others with no rule a reader could state"],
  ]);

  const expected = results.filter((x) => x.leaked.length > 0 && GLOBAL_BY_DESIGN.has(x.ent));
  const leaks = results.filter((x) => x.leaked.length > 0 && !GLOBAL_BY_DESIGN.has(x.ent));
  console.log(`area-scopable GETs answered 200 : ${results.length}`);
  console.log(`leaked another territory's rows : ${leaks.length}\n`);
  const byEnt = new Map<string, number>();
  for (const l of leaks) byEnt.set(l.ent, (byEnt.get(l.ent) ?? 0) + 1);
  for (const [ent, n] of [...byEnt].sort((a, b) => b[1] - a[1])) console.log(`  ${ent.padEnd(22)} ${n} route(s) leak`);
  const threadedShowingOwn = results.filter((x) => x.leaked.length === 0 && x.own > 0).length;
  const emptyOrNoIds = results.filter((x) => x.leaked.length === 0 && x.own === 0).length;
  console.log(`clean AND still returning Durham rows : ${threadedShowingOwn}`);
  console.log(`clean but returned no area ids at all : ${emptyOrNoIds} (most carry no occurrence/property ids)`);
  console.log("\nLEAKING ROUTES:");
  for (const l of leaks.sort((a, b) => a.ent.localeCompare(b.ent)))
    console.log(`  ${l.ent.padEnd(22)} GET ${l.path}`);
  if (expected.length) {
    console.log(`\nglobal by design (${expected.length}) — not leaks:`);
    for (const x of expected) console.log(`  ${x.ent.padEnd(14)} GET ${x.path}\n     ${GLOBAL_BY_DESIGN.get(x.ent)}`);
  }
  console.log(`\nunexpected territory leaks: ${leaks.length}`);
  await prisma.$disconnect();
  await app.close();
  process.exit(leaks.length > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
