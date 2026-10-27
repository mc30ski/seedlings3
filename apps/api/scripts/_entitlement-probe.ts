/**
 * For every entitlement: prove a principal WITHOUT it is refused, and that a
 * principal WITH it is not.
 *
 * Real route modules, real guards. Only `requireApproved` is stubbed, to
 * inject a chosen principal — everything downstream of it is production code,
 * including `can()` and every `requires(...)` declaration.
 *
 * "Allowed" cannot mean 200: these routes want real ids and real bodies. It
 * means NOT 403 — a 400 or 404 proves the guard let the request through,
 * which is the claim under test. Probe ids are deliberately nonexistent.
 */
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import type { Principal, Entitlement } from "@repo/permissions";
import { ENTITLEMENTS } from "@repo/permissions";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROBE_ID = "__perm_probe_no_such_row__";
let CURRENT: Principal | null = null;

/** (entitlement, method, path) for every guarded route, read from source. */
function guardedRoutes(): Array<{ ent: string; method: string; path: string }> {
  const dir = join(__dirname, "../src/routes");
  const out: Array<{ ent: string; method: string; path: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    const g2e = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*requires\(\s*"([^"]+)"\s*\)/g)) {
      g2e.set(m[1], m[2]);
    }
    for (const m of src.matchAll(/app\.(get|post|patch|delete|put)\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_]+)/g)) {
      const ent = g2e.get(m[3]);
      if (ent) out.push({ ent, method: m[1].toUpperCase(), path: m[2] });
    }
  }
  return out;
}

async function build() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  // The one stub. Guards call this first, then read `req.principal`.
  app.decorate("requireApproved", async (req: any) => {
    req.user = { id: PROBE_ID, isApproved: true };
    req.principal = CURRENT;
    if (!CURRENT) throw app.httpErrors.unauthorized("no principal");
  });

  const dir = join(__dirname, "../src/routes");
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.startsWith("_")) continue;
    const mod = await import(join(dir, f));
    if (typeof mod.default === "function") {
      await app.register(mod.default);
    }
  }
  await app.ready();
  return app;
}

function principal(entitlements: readonly string[]): Principal {
  return {
    kind: "user",
    workerType: "EMPLOYEE",
    roles: [{ roleId: "probe", name: "Probe", entitlements: entitlements as Entitlement[] }],
    perspective: null,
  };
}

(async () => {
  const app = await build();
  const all = guardedRoutes();
  const ALL_ENTS = ENTITLEMENTS as readonly string[];

  // One representative per entitlement: prefer GET, then fewest params.
  const rep = new Map<string, { method: string; path: string }>();
  for (const e of ALL_ENTS) {
    const cands = all.filter((r) => r.ent === e);
    if (!cands.length) continue;
    cands.sort((a, b) =>
      (a.method === "GET" ? 0 : 1) - (b.method === "GET" ? 0 : 1) ||
      (a.path.split(":").length - b.path.split(":").length) ||
      a.path.length - b.path.length);
    rep.set(e, { method: cands[0].method, path: cands[0].path });
  }

  // EVERY guarded route, not one sample per entitlement.
  const results: Array<{ ent: string; route: string; no: number; yes: number }> = [];
  for (const r of all) {
    const url = r.path.replace(/:[A-Za-z0-9_]+/g, PROBE_ID);
    CURRENT = principal(ALL_ENTS.filter((x) => x !== r.ent));
    const no = await app.inject({ method: r.method as any, url, payload: {} });
    CURRENT = principal([r.ent]);
    const yes = await app.inject({ method: r.method as any, url, payload: {} });
    results.push({ ent: r.ent, route: `${r.method} ${r.path}`,
                   no: no.statusCode, yes: yes.statusCode });
  }

  /**
   * ROUTES WHOSE REAL RULE IS NARROWER THAN THEIR GUARD.
   *
   * Read from each route's own `// in-handler-scoped: <reason>` annotation —
   * the same comment the e2e API suite parses. It used to be a hardcoded Map
   * right here, which made it a SECOND source of truth about authorization
   * sitting in a diagnostic script, and this repo has been bitten by every
   * one of those it has had. The annotation lives at the callsite, where the
   * person changing the handler will see it.
   *
   * This relaxes ONLY the "allowed with it" expectation. "Refused WITHOUT it"
   * still applies, so a route cannot hide a broken guard behind it.
   */
  const IN_HANDLER_SCOPED = new Map<string, string>();
  {
    const dir = join(__dirname, "../src/routes");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      const DECL = /app\.(get|post|patch|delete|put)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/;
      lines.forEach((line, i) => {
        const d = DECL.exec(line);
        if (!d) return;
        for (let j = i - 1; j >= 0; j--) {
          if (DECL.test(lines[j] ?? "")) break;
          const note = /\/\/\s*in-handler-scoped:\s*(.+)$/.exec(lines[j] ?? "");
          if (note) {
            IN_HANDLER_SCOPED.set(`${d[1].toUpperCase()} ${d[2]}`, note[1].trim());
            break;
          }
        }
      });
    }
  }

  const notBlocked = results.filter((x) => x.no !== 403);
  const notAllowed = results.filter(
    (x) => x.yes === 403 && !IN_HANDLER_SCOPED.has(x.route),
  );
  const scopedOk = results.filter(
    (x) => x.yes === 403 && IN_HANDLER_SCOPED.has(x.route),
  );

  console.log(`\nguarded endpoints probed: ${results.length}`);
  console.log(`  refused without the entitlement : ${results.length - notBlocked.length}`);
  console.log(`  passed with the entitlement     : ${results.length - notAllowed.length}`);

  if (notBlocked.length) {
    console.log(`\nLET THROUGH WITHOUT THE ENTITLEMENT (${notBlocked.length}):`);
    for (const x of notBlocked) console.log(`   ${x.ent.padEnd(20)} ${x.route.padEnd(52)} got ${x.no}`);
  }
  if (notAllowed.length) {
    console.log(`\nREFUSED EVEN WITH THE ENTITLEMENT (${notAllowed.length}):`);
    for (const x of notAllowed) console.log(`   ${x.ent.padEnd(20)} ${x.route.padEnd(52)} got ${x.yes}`);
  }

  if (scopedOk.length) {
    console.log(`\nGUARD PASSED, HANDLER SCOPED FURTHER (${scopedOk.length}) — expected:`);
    for (const x of scopedOk) {
      console.log(`   ${x.route}`);
      console.log(`      ${IN_HANDLER_SCOPED.get(x.route)}`);
    }
  }
  // WHETHER AN ANNOTATION IS STALE IS NOT A QUESTION THIS SCRIPT CAN ANSWER.
  //
  // The narrower rules these routes apply are ownership checks against a real
  // signed-in person. This probe's caller is synthetic — `requireApproved` is
  // stubbed and there is no Clerk identity — so those checks fail in a
  // different way (or never run), and three annotated routes came back
  // "allowed" here while correctly returning 403 to a real contractor. Judging
  // them from this script would mean deleting live annotations.
  //
  // `apps/web/tests/e2e/api/authz-matrix.spec.ts` asserts each annotation is
  // in force, as a real persona, which is where that check belongs.
  const annotatedNotSeen = [...IN_HANDLER_SCOPED.keys()].filter(
    (k) => !scopedOk.some((x) => x.route === k),
  );
  if (annotatedNotSeen.length) {
    console.log(
      `\nannotated but not refused HERE (${annotatedNotSeen.length}) — expected; ` +
        `the e2e API suite is what verifies these:`,
    );
    for (const k of annotatedNotSeen) console.log(`   ${k}`);
  }

  const missing = ALL_ENTS.filter((e) => !all.some((r) => r.ent === e));
  if (missing.length) console.log(`\nentitlements guarding no route: ${missing.join(", ")}`);

  const fail = notBlocked.length + notAllowed.length;
  console.log(`\nfailures: ${fail}`);
  await app.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
