/**
 * Functional proof for the field-level redactions that no build gate can
 * check: a guard either fires or it does not, but "this handler strips
 * `hourlyWage` for a caller without `people.manage`" is a property of the
 * RESPONSE BODY. These routes are reachable by the baseline Trainee role, so
 * the redaction is the only thing standing between a worker and a
 * colleague's wage.
 *
 * Real route modules and real handlers against the dev database; only
 * `requireApproved` is stubbed, to inject a chosen principal.
 *
 * Usage: npx tsx scripts/_verify-redaction.ts
 */
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import type { Principal, Entitlement } from "@repo/permissions";
import { PrismaClient } from "@prisma/client";
import { readdirSync } from "node:fs";
import { join } from "node:path";

let CURRENT: Principal | null = null;
const principal = (ents: string[]): Principal => ({
  kind: "user", workerType: "EMPLOYEE",
  roles: [{ roleId: "r", name: "probe", entitlements: ents as Entitlement[] }],
  perspective: null,
} as any);

(async () => {
  const prisma = new PrismaClient();
  const someUser =
    (await prisma.user.findFirst({ where: { hourlyWage: { gt: 0 } }, select: { id: true } })) ??
    (await prisma.user.findFirst({ select: { id: true } }));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate("requireApproved", async (req: any) => {
    req.user = { id: someUser!.id, isApproved: true };
    req.principal = CURRENT;
    if (!CURRENT) throw app.httpErrors.unauthorized("no principal");
  });
  app.addHook("onRequest", async (req: any) => { req.auth = { clerkUserId: "probe" }; });
  const dir = join(__dirname, "../src/routes");
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.startsWith("_")) continue;
    const mod = await import(join(dir, f));
    if (typeof mod.default === "function") await app.register(mod.default);
  }
  await app.ready();

  const SENSITIVE = ["hourlyWage", "email", "phone", "homeBaseAddress"];
  const PAY = ["totalEarnings", "netEarnings", "totalExpenses"];
  const OPS_PAY = [...PAY, "wageGross", "avgHourlyRate"];

  const check = async (label: string, url: string, ents: string[], pick: (b: any) => any, fields: string[], expectPresent: boolean) => {
    CURRENT = principal(ents);
    const res = await app.inject({ method: "GET", url });
    if (res.statusCode === 403) { console.log(`  ${label.padEnd(46)} 403 (refused)`); return; }
    if (res.statusCode >= 400) { console.log(`  ${label.padEnd(46)} HTTP ${res.statusCode} !!`); return; }
    const target = pick(res.json());
    if (target == null) { console.log(`  ${label.padEnd(46)} no sample row`); return; }
    const present = fields.filter((f) => Object.prototype.hasOwnProperty.call(target, f));
    const ok = expectPresent ? present.length === fields.length : present.length === 0;
    console.log(`  ${label.padEnd(46)} ${ok ? "PASS" : "FAIL"}  present=[${present.join(",")}]`);
  };

  console.log("GET /users  (list)");
  await check("worker (people.view only) -> stripped", "/users", ["people.view"], (b) => Array.isArray(b) ? b[0] : b?.items?.[0], [...SENSITIVE, "capabilities", "roleGrants"], false);
  await check("admin (people.manage)     -> full",     "/users", ["people.view","people.manage"], (b) => Array.isArray(b) ? b[0] : b?.items?.[0], SENSITIVE, true);

  console.log(`GET /users/:id  (${someUser!.id.slice(0,8)}…)`);
  await check("worker (people.view only) -> stripped", `/users/${someUser!.id}`, ["people.view"], (b) => b, SENSITIVE, false);
  await check("admin (people.manage)     -> full",     `/users/${someUser!.id}`, ["people.view","people.manage"], (b) => b, SENSITIVE, true);

  const range = "?from=2026-09-01&to=2026-10-13";
  console.log("GET /statistics");
  await check("reports.view only         -> no pay",   `/statistics${range}`, ["reports.view"], (b) => b?.workers?.[0], PAY, false);
  await check("+ payroll.view            -> pay",      `/statistics${range}`, ["reports.view","payroll.view"], (b) => b?.workers?.[0], PAY, true);

  console.log("GET /operations");
  await check("reports.view only         -> no pay",   `/operations${range}`, ["reports.view"], (b) => b?.workerStats?.[0], OPS_PAY, false);
  await check("+ payroll.view            -> pay",      `/operations${range}`, ["reports.view","payroll.view"], (b) => b?.workerStats?.[0], OPS_PAY, true);

  await prisma.$disconnect();
  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
