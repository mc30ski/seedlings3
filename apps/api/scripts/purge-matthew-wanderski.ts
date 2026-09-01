// ─────────────────────────────────────────────────────────────────────────────
// Purge the test user "Matthew Wanderski" from production, reassigning his work
// and money to the owner. Same shape as purge-mark-baliff.ts, but with two
// hazards that case did not have — see the guards below.
//
// DRY RUN BY DEFAULT.
//   dry:       npx tsx scripts/purge-matthew-wanderski.ts
//   rehearsal: REHEARSE=1 ...   (runs everything, then ROLLS BACK)
//   for real:  APPLY=1 ...
//
// ── HAZARD 1: THE SURNAME IS SHARED ──────────────────────────────────────────
// Mark Baliff's purge could safely replace the bare surname "Baliff", because
// nothing else in the database contained it. "Wanderski" is shared with the
// OWNER, Jacob, David and Family Wanderski — Jacob and David are real, paid
// employees. So this script matches ONLY the full string "Matthew Wanderski",
// his user id, his email and his Clerk id. Never the surname. Never the bare
// first name either: "Matthew Wolfe" is a different, real user.
//
// ── HAZARD 2: THE OWNER IS NOT ON THESE JOBS ─────────────────────────────────
// Mark shared jobs with the owner, so reassignment was a merge. Matthew's two
// jobs are `Jacob + Matthew` and `Jacob + Matthew + Justin` — the owner is on
// neither. Reassignment therefore ADDS the owner as an assignee to two jobs he
// did not work. Accepted deliberately (2026-09-01): the money is his either
// way, conservation holds automatically, and the app is not the source of
// record — Gusto and QuickBooks are.
//
// Reassigning to Jacob was rejected: he is a real W-2 employee in Gusto, and
// inflating his in-app earnings would make the app diverge from payroll for an
// actual person.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { createClerkClient } from "@clerk/backend";
import * as fs from "fs";

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const MATT = "cmgihqddt000akz04gvlp9b2b";
const MIKE = "cmg2wvwqz0001jx04rb3ch2bq";
const MATT_NAME = "Matthew Wanderski";
const MATT_EMAIL = "mx.wanderski@gmail.com";
const CLERK_ID = "user_33ngYi5sguk0bi7CM0ytbkpDABU";
const CREW_ID = "cmp0glz3k0001jm04y9jodbfq"; // "Wanderski Crew"

/**
 * Users this script must never touch, verified by fingerprint before and after.
 * Jacob and David are real paid workers and share both the surname and, in
 * Jacob's case, both of Matthew's jobs. Justin and Caleb are real Gusto
 * employees. The owner is excluded because he is the reassignment target.
 */
const PROTECTED: Record<string, string> = {
  "cmg2y87x00000jp04ssm8r7bn": "Jacob Wanderski",
  "cmgihm6to0007kz04oa8od044": "David Wanderski",
};

const APPLY = process.env.APPLY === "1";
const MODE: "dry" | "rehearse" | "apply" =
  APPLY ? "apply" : process.env.REHEARSE === "1" ? "rehearse" : "dry";

const HANDLED_FK = new Set([
  "JobOccurrenceAssignee.userId",
  "PaymentSplit.userId",
  "GroupMember.userId",
  "PushSubscription.userId",
  "UserRole.userId",
]);

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
type Db = PrismaClient | Tx;
type Op = { label: string; expected?: number; run: (tx: Tx) => Promise<unknown> };
const mutations: Op[] = [];
const queue = (run: Op["run"], label = "(row op)", expected?: number) => mutations.push({ run, label, expected });
const affectedCount = (r: unknown): number | undefined =>
  typeof r === "number" ? r : typeof (r as any)?.count === "number" ? (r as any).count : undefined;

const plan: Array<{ step: string; rows: number }> = [];
const add = (step: string, detail: string, rows: number) => {
  plan.push({ step, rows });
  console.log(`  ${String(rows).padStart(4)}  ${step.padEnd(34)} ${detail}`);
};

/** Split totals + row counts for the protected users, to prove they never move. */
async function fingerprint(db: Db) {
  const out: Record<string, string> = {};
  for (const id of Object.keys(PROTECTED)) {
    const sp = await db.paymentSplit.findMany({ where: { userId: id }, select: { amount: true, tipAmount: true } });
    const asg = await db.jobOccurrenceAssignee.count({ where: { userId: id } });
    const wd = await db.workerWorkday.count({ where: { userId: id } });
    const gm = await db.groupMember.count({ where: { userId: id } });
    const money = sp.reduce((a, b) => a + b.amount + (b.tipAmount ?? 0), 0);
    out[id] = `splits=${sp.length} $${money.toFixed(2)} assignees=${asg} workdays=${wd} crews=${gm}`;
  }
  return out;
}

async function main() {
  console.log({
    dry: "\n=== DRY RUN — planning only, nothing will be written ===\n",
    rehearse: "\n=== REHEARSAL — real statements, real verification, then ROLLBACK ===\n",
    apply: "\n*** APPLY MODE — THIS WILL WRITE ***\n",
  }[MODE]);

  const matt = await prisma.user.findUnique({ where: { id: MATT }, select: { id: true, displayName: true, email: true, workerType: true } });
  const mike = await prisma.user.findUnique({ where: { id: MIKE }, select: { id: true, displayName: true, email: true, isOwner: true } });
  if (!matt) throw new Error(`Matthew (${MATT}) not found — already purged?`);
  if (!mike?.isOwner) throw new Error("Owner not found or not flagged isOwner — wrong database?");
  if (matt.displayName !== MATT_NAME) throw new Error(`Expected "${MATT_NAME}", found "${matt.displayName}" — refusing.`);
  console.log(`FROM: ${matt.displayName} <${matt.email}> (${matt.workerType})  ${MATT}`);
  console.log(`TO:   ${mike.displayName} (owner)  ${MIKE}\n`);

  // Preflight: nothing referencing him may be unaccounted for.
  const fks: Array<{ tbl: string; col: string }> = await prisma.$queryRawUnsafe(
    `SELECT src.relname::text AS tbl, att.attname::text AS col
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_class tgt ON tgt.oid = con.confrelid
     JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f' AND tgt.relname = 'User'`);
  const unknown: string[] = [];
  for (const fk of fks) {
    const key = `${fk.tbl}.${fk.col}`;
    if (HANDLED_FK.has(key)) continue;
    const r: Array<{ n: number }> = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "${fk.tbl}" WHERE "${fk.col}" = $1`, MATT);
    if (r[0].n > 0) unknown.push(`${key} (${r[0].n} rows)`);
  }
  if (unknown.length) throw new Error(`UNHANDLED references:\n  ${unknown.join("\n  ")}`);
  console.log(`Preflight: checked ${fks.length} FK columns referencing User; all rows accounted for.\n`);

  const protectedBefore = await fingerprint(prisma);
  for (const [id, name] of Object.entries(PROTECTED)) console.log(`  PROTECTED ${name.padEnd(18)} ${protectedBefore[id]}`);
  console.log();

  // ── 1. Assignments — no collisions, so a straight reassignment ─────────────
  const asg = await prisma.jobOccurrenceAssignee.findMany({ where: { userId: MATT }, select: { id: true, occurrenceId: true, role: true } });
  const mikeOcc = new Set((await prisma.jobOccurrenceAssignee.findMany({
    where: { userId: MIKE, occurrenceId: { in: asg.map((a) => a.occurrenceId) } }, select: { occurrenceId: true },
  })).map((r) => r.occurrenceId));
  if (mikeOcc.size > 0) throw new Error("Owner is already assigned to one of these occurrences — merge logic needed, which this script does not have.");
  add("JobOccurrenceAssignee.userId", "-> owner (adds him to 2 jobs he wasn't on — accepted)", asg.length);
  for (const a of asg) queue((tx) => tx.jobOccurrenceAssignee.update({ where: { id: a.id }, data: { userId: MIKE } }));

  // ── 2. The money ───────────────────────────────────────────────────────────
  const splits = await prisma.paymentSplit.findMany({ where: { userId: MATT }, include: { payment: { select: { amountPaid: true } } } });
  const mikeSplit = await prisma.paymentSplit.count({ where: { userId: MIKE, paymentId: { in: splits.map((s) => s.paymentId) } } });
  if (mikeSplit > 0) throw new Error("Owner already has a split on one of these payments — merge logic needed.");
  const total = splits.reduce((a, b) => a + b.amount, 0);
  add("PaymentSplit.userId", `ownerEarnings=true, $${total.toFixed(2)} (no amount changes)`, splits.length);
  for (const s of splits) queue((tx) => tx.paymentSplit.update({ where: { id: s.id }, data: { userId: MIKE, ownerEarnings: true } }));

  // ── 3. Crew membership — deleted, not moved ────────────────────────────────
  // Reassigning would put the owner into the Wanderski Crew, changing its
  // composition. He was never a member; Jacob and David remain untouched.
  const gm = await prisma.groupMember.count({ where: { userId: MATT } });
  add("GroupMember", "DELETE (crew keeps Jacob + David)", gm);
  if (gm > 0) queue((tx) => tx.groupMember.deleteMany({ where: { userId: MATT } }), "GroupMember", gm);

  // ── 4. Audit metadata — full name only, NEVER the surname ─────────────────
  const WHERE_META = `(metadata)::text LIKE $1 OR (metadata)::text ILIKE $2
     OR (metadata)::text ILIKE $3 OR (metadata)::text LIKE $4`;
  const metaArgs = [`%${MATT}%`, `%${MATT_NAME}%`, `%${MATT_EMAIL}%`, `%${CLERK_ID}%`];
  const metaHits: Array<{ n: number }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "AuditEvent" WHERE ${WHERE_META}`, ...metaArgs);
  add("AuditEvent.metadata", "id + FULL name + email + Clerk id (never the surname)", metaHits[0].n);
  queue((tx) => tx.$executeRawUnsafe(
    `UPDATE "AuditEvent" SET metadata =
       replace(replace(replace(replace((metadata)::text, $5, $6), $7, $8), $9, $10), $11, $12)::jsonb
     WHERE ${WHERE_META}`,
    ...metaArgs,
    MATT_NAME, mike.displayName ?? "Michael Wanderski",
    MATT, MIKE,
    MATT_EMAIL, mike.email ?? "",
    CLERK_ID, ""), "AuditEvent.metadata", metaHits[0].n);

  // ── 5. Deletions + the user ────────────────────────────────────────────────
  for (const [label, run, count] of [
    ["PushSubscription", (tx: any) => tx.pushSubscription.deleteMany({ where: { userId: MATT } }), await prisma.pushSubscription.count({ where: { userId: MATT } })],
    ["UserRole", (tx: any) => tx.userRole.deleteMany({ where: { userId: MATT } }), await prisma.userRole.count({ where: { userId: MATT } })],
  ] as const) {
    add(label as string, "DELETE", count as number);
    if ((count as number) > 0) queue(run as Op["run"], label as string, count as number);
  }
  const ghost = await prisma.clientContact.count({ where: { clerkUserId: CLERK_ID } });
  add("ClientContact.clerkUserId", "unlink stale Clerk pointers", ghost);
  if (ghost > 0) queue((tx) => tx.clientContact.updateMany({ where: { clerkUserId: CLERK_ID }, data: { clerkUserId: null } }), "ClientContact.clerkUserId", ghost);
  add("User", `DELETE ${MATT_NAME}`, 1);
  queue((tx) => tx.user.delete({ where: { id: MATT } }));

  // ── Money baseline ─────────────────────────────────────────────────────────
  const paymentIds = [...new Set(splits.map((s) => s.paymentId))];
  const before = await conservation(prisma, paymentIds);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`${plan.reduce((s, a) => s + a.rows, 0)} rows across ${plan.filter((a) => a.rows > 0).length} operations | ${mutations.length} queued statements`);

  const snapshotPath = `${process.env.HOME}/Documents/seedlings-backups/purge-matthew-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.mkdirSync(`${process.env.HOME}/Documents/seedlings-backups`, { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify({
    capturedAt: new Date().toISOString(), mode: MODE, matt, mike,
    assignees: asg, paymentSplits: splits, protectedBefore,
    payments: await prisma.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, amountPaid: true, businessMarginAmount: true, platformFeeAmount: true } }),
  }, null, 1));
  console.log(`Pre-change snapshot: ${snapshotPath}`);

  if (MODE === "dry") {
    console.log("\nDRY RUN — nothing was written. REHEARSE=1 runs it for real and rolls back.");
    await verify(prisma, false);
    return;
  }

  class RollbackSentinel extends Error {}
  let verified = false;
  try {
    await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      const overreach: string[] = [];
      for (const op of mutations) {
        const n = affectedCount(await op.run(tx));
        if (op.expected != null && n != null && n !== op.expected) overreach.push(`${op.label}: touched ${n}, plan said ${op.expected}`);
      }
      if (overreach.length) throw new Error(`BLAST RADIUS MISMATCH:\n  ${overreach.join("\n  ")}`);
      await postConditions(tx, { before, paymentIds, protectedBefore });
      verified = true;
      if (MODE === "rehearse") throw new RollbackSentinel();
    }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
    console.log("\nREHEARSAL COMPLETE — every statement ran, every post-condition passed, ROLLED BACK.");
    return;
  }
  if (!verified) throw new Error("Transaction finished without post-conditions — refusing to report success.");
  console.log("\nTransaction committed. All post-conditions passed.");

  // ── Clerk, with the guard that was missing last time ──────────────────────
  // The Mark Baliff run reported "already gone" because apps/api/.env holds a
  // TEST secret key: it asked the DEV Clerk instance about a PRODUCTION user
  // id, which 404s trivially. Refuse to touch Clerk unless the key is live.
  const key = process.env.CLERK_SECRET_KEY ?? "";
  if (!key.startsWith("sk_live_")) {
    console.log(`\n!! CLERK NOT TOUCHED — CLERK_SECRET_KEY is "${key.slice(0, 8)}…", not sk_live_.`);
    console.log(`   Local .env holds the TEST key, so any result here would be meaningless.`);
    console.log(`   Delete ${CLERK_ID} (${MATT_EMAIL}) by hand: Clerk Dashboard -> PRODUCTION instance.`);
  } else {
    try {
      await clerk.users.deleteUser(CLERK_ID);
      console.log(`Clerk account ${CLERK_ID} deleted.`);
    } catch (e: any) {
      console.log(e?.status === 404 ? `Clerk account already gone.` : `!! CLERK DELETE FAILED (${e?.status}) — delete ${CLERK_ID} by hand.`);
    }
  }
  console.log(`\nDONE. Snapshot: ${snapshotPath}`);
}

async function conservation(db: Db, paymentIds: string[]) {
  const pays = await db.payment.findMany({
    where: { id: { in: paymentIds } },
    include: { splits: true, occurrence: { select: { expenses: { select: { cost: true } } } } },
  });
  const out = new Map<string, { residual: number; splitTotal: number }>();
  for (const p of pays) {
    const splitTotal = p.splits.reduce((a, b) => a + b.amount + (b.tipAmount ?? 0), 0);
    const accounted = splitTotal + (p.platformFeeAmount ?? 0) + (p.businessMarginAmount ?? 0)
      + (p.tipToBusinessAmount ?? 0) + (p.overageAmount ?? 0) - (p.shortfallAmount ?? 0)
      + (p.occurrence?.expenses ?? []).reduce((a, e) => a + e.cost, 0);
    out.set(p.id, { residual: Math.round((accounted - p.amountPaid) * 100) / 100, splitTotal: Math.round(splitTotal * 100) / 100 });
  }
  return out;
}

async function postConditions(tx: Tx, ctx: {
  before: Map<string, { residual: number; splitTotal: number }>;
  paymentIds: string[];
  protectedBefore: Record<string, string>;
}) {
  const fail = (m: string) => { throw new Error(m); };

  if (await tx.user.findUnique({ where: { id: MATT } })) fail("User row still exists.");
  const fks: Array<{ tbl: string; col: string }> = await tx.$queryRawUnsafe(
    `SELECT src.relname::text AS tbl, att.attname::text AS col
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_class tgt ON tgt.oid = con.confrelid
     JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f' AND tgt.relname = 'User'`);
  for (const fk of fks) {
    const r: Array<{ n: number }> = await tx.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${fk.tbl}" WHERE "${fk.col}" = $1`, MATT);
    if (r[0].n > 0) fail(`${fk.tbl}.${fk.col} still has ${r[0].n} rows referencing him.`);
  }
  console.log("  ✓ user deleted; zero FK references remain");

  // THE GUARD THAT MATTERS MOST HERE: real workers must be untouched.
  const after = await fingerprint(tx);
  for (const [id, name] of Object.entries(PROTECTED)) {
    if (after[id] !== ctx.protectedBefore[id]) {
      fail(`PROTECTED USER CHANGED — ${name}\n    before: ${ctx.protectedBefore[id]}\n    after:  ${after[id]}`);
    }
  }
  console.log(`  ✓ protected users unchanged (${Object.values(PROTECTED).join(", ")})`);

  const now = await conservation(tx, ctx.paymentIds);
  for (const [id, b] of ctx.before) {
    const a = now.get(id);
    if (!a) fail(`${id}: payment vanished`);
    if (Math.abs(a!.residual - b.residual) > 0.02) fail(`${id}: residual ${b.residual} -> ${a!.residual}`);
    if (Math.abs(a!.splitTotal - b.splitTotal) > 0.02) fail(`${id}: split total ${b.splitTotal} -> ${a!.splitTotal}`);
  }
  console.log(`  ✓ money unchanged across ${ctx.paymentIds.length} payments`);

  const crew = await tx.groupMember.findMany({ where: { groupId: CREW_ID }, include: { user: { select: { displayName: true } } } });
  console.log(`  ✓ Wanderski Crew now: ${crew.map((c) => c.user?.displayName).join(", ")}`);

  await verify(tx, true);
}

/** Scan every text/JSON column for his name, id, email or Clerk id. */
async function verify(db: Db, afterWrite: boolean) {
  const cols: Array<{ t: string; c: string; d: string }> = await db.$queryRawUnsafe(
    `SELECT table_name::text AS t, column_name::text AS c, data_type::text AS d
     FROM information_schema.columns
     WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json') ORDER BY 1,2`);
  const residue: string[] = [];
  for (let i = 0; i < cols.length; i += 30) {
    const chunk = cols.slice(i, i + 30);
    const sql = chunk.map((col) => {
      const cast = col.d.startsWith("j") ? `("${col.c}")::text` : `"${col.c}"`;
      return `SELECT '${col.t}.${col.c}' AS col,
        COUNT(*) FILTER (WHERE ${cast} ILIKE '%${MATT_NAME}%')::int AS nm,
        COUNT(*) FILTER (WHERE ${cast} LIKE '%${MATT}%')::int AS idn,
        COUNT(*) FILTER (WHERE ${cast} ILIKE '%${MATT_EMAIL}%')::int AS em,
        COUNT(*) FILTER (WHERE ${cast} LIKE '%${CLERK_ID}%')::int AS ck FROM "${col.t}"`;
    }).join(" UNION ALL ");
    for (const r of await db.$queryRawUnsafe<any[]>(sql)) {
      if (r.nm || r.idn || r.em || r.ck) residue.push(`${r.col}: ${r.nm} name / ${r.idn} id / ${r.em} email / ${r.ck} clerk`);
    }
  }
  if (!residue.length) { console.log(`  ✓ no trace of him in any text or JSON column`); return; }
  console.log(afterWrite ? "\n✗ RESIDUE REMAINS AFTER WRITE:" : "\nWould still remain (this is the work above):");
  for (const r of residue) console.log("   ", r);
  if (afterWrite) throw new Error("Purge incomplete — see residue above.");
}

main().catch((e) => { console.error("\nFAILED:", e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
