// ─────────────────────────────────────────────────────────────────────────────
// Purge the test user "Mark Baliff" from production, reassigning everything he
// did to the LLC owner so the books read as if the owner did the work.
//
// DRY RUN BY DEFAULT. Prints every row it would touch and changes nothing.
// To execute:  APPLY=1 npx tsx scripts/purge-mark-baliff.ts
//
// Usage (dry run):   cd apps/api && npx tsx scripts/purge-mark-baliff.ts
// Against prod:      DATABASE_URL="<prod url>" npx tsx scripts/purge-mark-baliff.ts
//
// ── WHY REASSIGN RATHER THAN DELETE ──────────────────────────────────────────
// His 47 PaymentSplits sit on $3,740 of REAL client revenue across 23 real
// clients. Deleting those payments would erase real income; deleting only the
// splits would break the payment conservation identity that
// payments-build-gate.test.ts enforces. So the money stays exactly where it is
// and only the name on it changes.
//
// Splits move with `ownerEarnings: true`, which is how the owner's cut is
// already stamped (loadOwnerSet in services/payments.ts). exports.ts filters
// labor to `ownerEarnings: false`, so this moves ~$2,870.50 out of wage/1099
// expense — a correction, since he was never in Gusto and that money never
// actually left the business as wages.
//
// Fee/margin is deliberately NOT recomputed. computeBreakdown keys only on
// workerType and never on isOwner, so owners DO incur margin in this system —
// the owner's existing 30 splits carry $675.37 of it. Leaving the stored
// ratePercent/feeAmount keeps these rows consistent with those, keeps every
// payment balanced, and has zero effect on net income (retained margin and
// owner draw are both excluded from labor expense).
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { createClerkClient } from "@clerk/backend";
import * as fs from "fs";

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const MARK = "cmgih3yce0000kz04ip0rib2g";
const MIKE = "cmg2wvwqz0001jx04rb3ch2bq";
const MARK_NAME = "Mark Baliff";
const MARK_EMAIL = "mark.baliff@gmail.com";
// The surname appears alone in deleted-test-client snapshots, so it needs its
// own pass. Safe to replace globally: nothing else in this database contains
// "Baliff" — verified by a full scan of all 537 text/JSON columns.
const MARK_SURNAME = "Baliff";
const OWNER_SURNAME = "Wanderski";
const CLERK_ID = "user_33neQv3KcwN1athxK5pgFbtioQn";

const APPLY = process.env.APPLY === "1";
// Three modes. `dry` plans only. `rehearse` runs every statement and every
// post-condition inside a transaction and then ROLLS BACK — the only way to
// exercise the write path, which a dry run structurally cannot reach.
const MODE: "dry" | "rehearse" | "apply" =
  APPLY ? "apply" : process.env.REHEARSE === "1" ? "rehearse" : "dry";
// Clerk is NOT branchable. A Neon branch gives you a throwaway copy of the
// database, but there is only one Clerk tenant — so a rehearsal run with
// APPLY=1 against a branch would delete the REAL account, and he could not
// sign in again even though the rehearsal was meant to change nothing.
// Set SKIP_CLERK=1 for every run that is not against production.
const SKIP_CLERK = process.env.SKIP_CLERK === "1";

// `r2Key` embeds the uploader's id in the object path
// (photos/<occId>/<userId>-<ts>-<file>.jpeg). Renaming 132 objects means a
// copy+delete round trip each, against paths that are never rendered and never
// appear in an export. Left alone deliberately — the final verification scan
// treats it as a known exception rather than a failure.
const ALLOWED_RESIDUE = new Set(["JobOccurrencePhoto.r2Key"]);

// Every FK column referencing User that this script knowingly handles. The
// preflight asserts that NOTHING ELSE has rows for him — so if the schema
// grows a new User reference later, this script refuses to run rather than
// silently leaving rows behind. This list is the machine-checkable version of
// "did we miss an edge case".
const HANDLED_FK = new Set([
  "AuditEvent.actorUserId",
  "Checkout.userId",
  "Expense.createdById",
  "JobOccurrence.hoursApprovedById",
  "JobOccurrenceAssignee.assignedById",
  "JobOccurrenceAssignee.userId",
  "JobOccurrencePhoto.uploadedById",
  "OccurrenceComment.authorId",
  "Payment.collectedById",
  "PaymentSplit.userId",
  "PolicyException.grantedById",
  "PolicyException.userId",
  "PolicyReadingProgress.userId",
  "PolicySignature.signedByUserId",
  "PolicySignature.userId",
  "PushSubscription.userId",
  "UserRole.userId",
  "CheckoutSplit.userId",
  "WorkerWorkday.approvedById",
  "WorkerWorkday.userId",
]);

type Action = { step: string; detail: string; rows: number };
const plan: Action[] = [];
const add = (step: string, detail: string, rows: number) => {
  plan.push({ step, detail, rows });
  console.log(`  ${String(rows).padStart(5)}  ${step.padEnd(38)} ${detail}`);
};

// Every mutation is queued as a closure and only invoked inside the
// transaction, so the dry run genuinely cannot touch the database.
type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
type Db = PrismaClient | Tx;
type Mutation = (tx: Tx) => Promise<unknown>;

/**
 * `expected` is the blast radius. The plan is computed OUTSIDE the
 * transaction, so a bulk `updateMany`/raw UPDATE could match more rows than
 * were counted — a WHERE clause that is subtly wider than intended, or data
 * that moved in between. Every bulk op declares how many rows it may touch and
 * the run aborts if reality disagrees.
 */
type Op = { label: string; expected?: number; run: Mutation };
const mutations: Op[] = [];
const queue = (run: Mutation, label = "(row op)", expected?: number) =>
  mutations.push({ run, label, expected });
const affectedCount = (r: unknown): number | undefined =>
  typeof r === "number" ? r : typeof (r as any)?.count === "number" ? (r as any).count : undefined;

async function main() {
  console.log({
    dry: "\n=== DRY RUN — planning only, nothing will be written ===\n",
    rehearse: "\n=== REHEARSAL — real statements, real verification, then ROLLBACK ===\n",
    apply: "\n*** APPLY MODE — THIS WILL WRITE ***\n",
  }[MODE]);

  // ── Preflight ──────────────────────────────────────────────────────────────
  const mark = await prisma.user.findUnique({ where: { id: MARK }, select: { id: true, displayName: true, email: true, clerkUserId: true } });
  const mike = await prisma.user.findUnique({ where: { id: MIKE }, select: { id: true, displayName: true, email: true, isOwner: true } });
  if (!mark) throw new Error(`Mark (${MARK}) not found — already purged?`);
  if (!mike) throw new Error(`Owner (${MIKE}) not found — wrong database?`);
  if (!mike.isOwner) throw new Error(`Target ${mike.displayName} is not flagged isOwner — refusing to proceed.`);
  console.log(`FROM: ${mark.displayName} <${mark.email}>  ${MARK}`);
  console.log(`TO:   ${mike.displayName} (owner)          ${MIKE}\n`);

  // ── Preflight: prove no User reference is unaccounted for ──────────────────
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
      `SELECT COUNT(*)::int AS n FROM "${fk.tbl}" WHERE "${fk.col}" = $1`, MARK);
    if (r[0].n > 0) unknown.push(`${key} (${r[0].n} rows)`);
  }
  if (unknown.length > 0) {
    throw new Error(`UNHANDLED references — this script would leave rows behind:\n  ${unknown.join("\n  ")}`);
  }
  console.log(`Preflight: checked ${fks.length} FK columns referencing User; all rows accounted for.\n`);

  // ── 1. Assignees — merge where both are present ────────────────────────────
  //
  // NOT a plain reassignment. On 3 of the 5 shared occurrences the owner is
  // only an `observer`, and observers are excluded from payouts (see
  // observer-filter-build-gate.test.ts). Moving Mark's split to an observer row
  // would create an observer holding a payout — a state the system says cannot
  // exist. So the surviving row is promoted to the STRONGER role first
  // (worker beats observer; role === null means worker).
  console.log("1. JobOccurrenceAssignee");
  const markAsg = await prisma.jobOccurrenceAssignee.findMany({ where: { userId: MARK }, select: { id: true, occurrenceId: true, role: true, assignedAt: true } });
  const mikeAsg = await prisma.jobOccurrenceAssignee.findMany({ where: { userId: MIKE }, select: { id: true, occurrenceId: true, role: true, assignedAt: true } });
  const mikeByOcc = new Map(mikeAsg.map((a) => [a.occurrenceId, a]));

  let asgMoved = 0;
  const merges: string[] = [];
  for (const a of markAsg) {
    const mine = mikeByOcc.get(a.occurrenceId);
    if (!mine) {
      asgMoved++;
      queue((tx) => tx.jobOccurrenceAssignee.update({ where: { id: a.id }, data: { userId: MIKE } }));
      continue;
    }
    const survivingRole = a.role === null || mine.role === null ? null : mine.role;
    const promoted = survivingRole !== mine.role;
    const earliest = a.assignedAt < mine.assignedAt ? a.assignedAt : mine.assignedAt;
    merges.push(`occ ${a.occurrenceId.slice(-6)}: mark[${a.role ?? "worker"}] + owner[${mine.role ?? "worker"}] -> owner[${survivingRole ?? "worker"}]${promoted ? " (PROMOTED)" : ""}`);
    queue((tx) => tx.jobOccurrenceAssignee.update({ where: { id: mine.id }, data: { role: survivingRole, assignedAt: earliest } }));
    queue((tx) => tx.jobOccurrenceAssignee.delete({ where: { id: a.id } }));
  }
  add("assignee rows reassigned", "userId -> owner", asgMoved);
  add("assignee rows MERGED", "role promoted, duplicate deleted", merges.length);
  for (const m of merges) console.log(`         - ${m}`);

  const asgBy = await prisma.jobOccurrenceAssignee.count({ where: { assignedById: MARK } });
  add("assignee.assignedById", "-> owner", asgBy);
  queue((tx) => tx.jobOccurrenceAssignee.updateMany({ where: { assignedById: MARK }, data: { assignedById: MIKE } }), "assignee.assignedById", asgBy);

  // ── 2. PaymentSplit — the money ────────────────────────────────────────────
  //
  // `(paymentId, userId)` is unique. There are zero collisions today, but the
  // merge branch is here so a future run can't die on a constraint: two splits
  // on one payment collapse into one row with every money column summed, which
  // keeps the payment's conservation identity intact.
  console.log("\n2. PaymentSplit (the money)");
  const markSplits = await prisma.paymentSplit.findMany({
    where: { userId: MARK },
    include: { payment: { select: { amountPaid: true, shortfallAmount: true } } },
  });
  const mikeSplits = await prisma.paymentSplit.findMany({ where: { userId: MIKE }, select: { id: true, paymentId: true, amount: true, tipAmount: true, grossAmount: true, feeAmount: true, netAmount: true, topUpAmount: true } });
  const mikeSplitByPayment = new Map(mikeSplits.map((s) => [s.paymentId, s]));

  // ZERO-CASH MAKE-WHOLE TOP-UPS.
  //
  // Four of his splits sit on payments the client never paid (skipped or
  // written off). They are not job pay: gross and fee are 0 and `amount`
  // equals `topUpAmount` — the business making an employee whole under the
  // guarantee policy, with `shortfallAmount` carrying the uncollected invoice
  // so the conservation identity still closes (35.75 + 19.25 − 55 = 0).
  //
  // Since he never existed, that money never actually left the business, so
  // the top-up is as fictional as the wages. Zeroing it therefore has to move
  // the OTHER side too or conservation breaks by the same amount:
  //
  //   before:  35.75 split + 19.25 margin − 55.00 shortfall = 0
  //   after:    0.00 split + 19.25 margin − 19.25 shortfall = 0
  //
  // which states the truth — client didn't pay, nobody got paid, the business
  // absorbed the margin it never earned.
  const zeroCash = markSplits.filter((s) => (s.payment?.amountPaid ?? 0) === 0 && s.amount > 0);

  let splitMoved = 0, splitMerged = 0, movedTotal = 0;
  for (const s of markSplits) {
    const mine = mikeSplitByPayment.get(s.paymentId);
    movedTotal += s.amount;
    if (!mine) {
      splitMoved++;
      const isZeroCash = (s.payment?.amountPaid ?? 0) === 0 && s.amount > 0;
      queue((tx) => tx.paymentSplit.update({
        where: { id: s.id },
        data: isZeroCash
          ? { userId: MIKE, ownerEarnings: true, amount: 0, topUpAmount: 0, tipAmount: 0 }
          : { userId: MIKE, ownerEarnings: true },
      }));
      if (isZeroCash) {
        const newShortfall = Math.round(((s.payment?.shortfallAmount ?? 0) - s.amount) * 100) / 100;
        queue((tx) => tx.payment.update({ where: { id: s.paymentId }, data: { shortfallAmount: newShortfall } }));
      }
      continue;
    }
    splitMerged++;
    const sum = (a: number | null | undefined, b: number | null | undefined) =>
      a == null && b == null ? null : Math.round(((a ?? 0) + (b ?? 0)) * 100) / 100;
    queue((tx) => tx.paymentSplit.update({
      where: { id: mine.id },
      data: {
        amount: sum(mine.amount, s.amount) ?? 0,
        tipAmount: sum(mine.tipAmount, s.tipAmount) ?? 0,
        grossAmount: sum(mine.grossAmount, s.grossAmount),
        feeAmount: sum(mine.feeAmount, s.feeAmount),
        netAmount: sum(mine.netAmount, s.netAmount),
        topUpAmount: sum(mine.topUpAmount, s.topUpAmount),
        ownerEarnings: true,
      },
    }));
    queue((tx) => tx.paymentSplit.delete({ where: { id: s.id } }));
  }
  add("splits reassigned", `ownerEarnings=true, $${movedTotal.toFixed(2)} total`, splitMoved);
  add("  ^ zero-cash top-ups ZEROED", `$${zeroCash.reduce((a, b) => a + b.amount, 0).toFixed(2)} of fictional make-whole, shortfall reduced to match`, zeroCash.length);
  add("splits MERGED into an existing row", "money columns summed", splitMerged);

  const collected = await prisma.payment.count({ where: { collectedById: MARK } });
  add("Payment.collectedById", "-> owner", collected);
  queue((tx) => tx.payment.updateMany({ where: { collectedById: MARK }, data: { collectedById: MIKE } }), "Payment.collectedById", collected);

  // ── 3. The JSON snapshots a userId reassignment does NOT reach ─────────────
  //
  // THE TRAP. `UPDATE PaymentSplit SET userId` leaves his id embedded in
  // JobOccurrence.promisedPayouts, which is the snapshot the payment card reads
  // to choose its money basis. Leave it stale and `promisedByUser.get(userId)`
  // misses, `usePromised` goes false, and the card silently falls back to the
  // actual-collected basis — reintroducing the wrong-equation bug on every one
  // of these occurrences.
  console.log("\n3. JSON snapshots (invisible to FK reassignment)");

  const touchedOccIds: string[] = [];
  const csOccs = await prisma.jobOccurrence.findMany({
    where: { completionSplits: { not: null } },
    select: { id: true, completionSplits: true },
  });
  let csCount = 0;
  for (const o of csOccs) {
    const arr = o.completionSplits as unknown as Array<{ userId: string; percent: number }> | null;
    if (!Array.isArray(arr) || !arr.some((r) => r?.userId === MARK)) continue;
    csCount++;
    touchedOccIds.push(o.id);
    const out: Array<{ userId: string; percent: number }> = [];
    for (const row of arr) {
      const uid = row.userId === MARK ? MIKE : row.userId;
      const dup = out.find((r) => r.userId === uid);
      // Both present -> one combined share, not two rows for the same person.
      if (dup) dup.percent = Math.round((dup.percent + row.percent) * 100) / 100;
      else out.push({ ...row, userId: uid });
    }
    queue((tx) => tx.jobOccurrence.update({ where: { id: o.id }, data: { completionSplits: out as any } }));
  }
  add("JobOccurrence.completionSplits", "userId rewritten, shares merged", csCount);

  const ppTouchedOccIds: string[] = [];
  const ppOccs = await prisma.jobOccurrence.findMany({
    where: { promisedPayouts: { not: null } },
    select: { id: true, promisedPayouts: true },
  });
  let ppCount = 0;
  for (const o of ppOccs) {
    const arr = o.promisedPayouts as unknown as Array<any> | null;
    if (!Array.isArray(arr) || !arr.some((r) => r?.userId === MARK)) continue;
    ppCount++;
    ppTouchedOccIds.push(o.id);
    const out: Array<any> = [];
    for (const row of arr) {
      const uid = row.userId === MARK ? MIKE : row.userId;
      const dup = out.find((r) => r.userId === uid);
      if (dup) {
        // Summing gross/fee/net keeps the snapshot reconciling to the same
        // pool; splitPercent is additive by definition.
        const r2 = (n: number) => Math.round(n * 100) / 100;
        dup.gross = r2((dup.gross ?? 0) + (row.gross ?? 0));
        dup.fee = r2((dup.fee ?? 0) + (row.fee ?? 0));
        dup.net = r2((dup.net ?? 0) + (row.net ?? 0));
        dup.splitPercent = r2((dup.splitPercent ?? 0) + (row.splitPercent ?? 0));
      } else out.push({ ...row, userId: uid });
    }
    queue((tx) => tx.jobOccurrence.update({ where: { id: o.id }, data: { promisedPayouts: out as any } }));
  }
  add("JobOccurrence.promisedPayouts", "userId rewritten, entries merged", ppCount);

  // AuditEvent.metadata holds whole record snapshots — his id, his name and his
  // email appear as literal text inside the JSON, so changing actorUserId alone
  // leaves the body naming him. Text-level replace, then cast back to jsonb.
  // His CLERK id is in here too, on one row. Easy to miss: it shares no
  // substring with his database id, his name or his email, so a scan for
  // those three finds nothing and the row survives the purge.
  // TWO-PASS, AND THE ORDER MATTERS.
  //
  // He also existed as a test CLIENT (since deleted), and those record
  // snapshots store the surname on its own — `"lastName": "Baliff"` with no
  // first name — so a replace keyed only on the full "Mark Baliff" leaves them
  // behind. The post-run verification scans for `%aliff%`, so those survivors
  // would fail the run AFTER the transaction had already committed.
  //
  // Full name first ("Mark Baliff" -> "Michael Wanderski"), then the bare
  // surname ("Baliff" -> "Wanderski") to catch the rest. Reverse the order and
  // every full name degrades to "Mark Wanderski".
  //
  // `firstName: "Mark"` is deliberately NOT replaced — "Mark" alone is a real
  // client name here (Mark Taylor), and a bare first name identifies nobody.
  const WHERE_META = `(metadata)::text ILIKE $1 OR (metadata)::text LIKE $2
     OR (metadata)::text ILIKE $3 OR (metadata)::text LIKE $4`;
  const metaArgs = [`%aliff%`, `%${MARK}%`, `%${MARK_EMAIL}%`, `%${CLERK_ID}%`];
  const metaHits: Array<{ n: number }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "AuditEvent" WHERE ${WHERE_META}`, ...metaArgs);
  add("AuditEvent.metadata", "id + full name + bare surname + email + Clerk id", metaHits[0].n);
  queue((tx) => tx.$executeRawUnsafe(
    `UPDATE "AuditEvent" SET metadata =
       replace(replace(replace(replace(replace((metadata)::text,
         $5, $6), $7, $8), $9, $10), $11, $12), $13, $14)::jsonb
     WHERE ${WHERE_META}`,
    ...metaArgs,
    MARK_NAME, mike.displayName ?? "Michael Wanderski",   // must precede the surname pass
    MARK_SURNAME, OWNER_SURNAME,
    MARK, MIKE,
    MARK_EMAIL, mike.email ?? "",
    CLERK_ID, ""), "AuditEvent.metadata", metaHits[0].n);

  const note = await prisma.client.count({ where: { notesInternal: { contains: "aliff", mode: "insensitive" } } });
  add("Client.notesInternal", `free text naming him ("… established this job.")`, note);
  queue((tx) => tx.$executeRawUnsafe(
    `UPDATE "Client" SET "notesInternal" = replace("notesInternal", $1, $2) WHERE "notesInternal" ILIKE $3`,
    MARK_NAME, mike.displayName ?? "Michael Wanderski", `%${MARK_NAME}%`), "Client.notesInternal", note);

  // ── 4. Straight reassignments ──────────────────────────────────────────────
  console.log("\n4. Straight reassignments");
  for (const [label, run, count] of [
    ["AuditEvent.actorUserId", (tx: any) => tx.auditEvent.updateMany({ where: { actorUserId: MARK }, data: { actorUserId: MIKE } }), await prisma.auditEvent.count({ where: { actorUserId: MARK } })],
    ["JobOccurrencePhoto.uploadedById", (tx: any) => tx.jobOccurrencePhoto.updateMany({ where: { uploadedById: MARK }, data: { uploadedById: MIKE } }), await prisma.jobOccurrencePhoto.count({ where: { uploadedById: MARK } })],
    ["OccurrenceComment.authorId", (tx: any) => tx.occurrenceComment.updateMany({ where: { authorId: MARK }, data: { authorId: MIKE } }), await prisma.occurrenceComment.count({ where: { authorId: MARK } })],
    ["JobOccurrence.hoursApprovedById", (tx: any) => tx.jobOccurrence.updateMany({ where: { hoursApprovedById: MARK }, data: { hoursApprovedById: MIKE } }), await prisma.jobOccurrence.count({ where: { hoursApprovedById: MARK } })],
    ["Expense.createdById", (tx: any) => tx.expense.updateMany({ where: { createdById: MARK }, data: { createdById: MIKE } }), await prisma.expense.count({ where: { createdById: MARK } })],
    ["WorkerWorkday.approvedById", (tx: any) => tx.workerWorkday.updateMany({ where: { approvedById: MARK }, data: { approvedById: MIKE } }), await prisma.workerWorkday.count({ where: { approvedById: MARK } })],
  ] as const) {
    add(label as string, "-> owner", count as number);
    if ((count as number) > 0) queue(run as Mutation);
  }

  // ── 5. Workdays — a genuinely lossy merge ──────────────────────────────────
  //
  // Unique on (userId, workdayDate), and the row holds ONE startedAt/endedAt —
  // two shifts on one date cannot be represented. Union the span and sum the
  // paused time. These hours feed only the P&L estimate, never payroll (he was
  // never in Gusto), so this can't corrupt anything real — but both rows are
  // already approved, so approved hours on these dates will change.
  console.log("\n5. WorkerWorkday");
  const markWd = await prisma.workerWorkday.findMany({ where: { userId: MARK } });
  const mikeWd = await prisma.workerWorkday.findMany({ where: { userId: MIKE } });
  const mikeWdByDate = new Map(mikeWd.map((w) => [String(w.workdayDate), w]));
  let wdMoved = 0; const wdMerges: string[] = [];
  for (const w of markWd) {
    const mine = mikeWdByDate.get(String(w.workdayDate));
    if (!mine) { wdMoved++; queue((tx) => tx.workerWorkday.update({ where: { id: w.id }, data: { userId: MIKE } })); continue; }
    const startedAt = mine.startedAt && w.startedAt ? (w.startedAt < mine.startedAt ? w.startedAt : mine.startedAt) : (mine.startedAt ?? w.startedAt);
    const endedAt = mine.endedAt && w.endedAt ? (w.endedAt > mine.endedAt ? w.endedAt : mine.endedAt) : (mine.endedAt ?? w.endedAt);
    wdMerges.push(`${String(w.workdayDate).slice(0, 10)}: union span, paused ${(mine.totalPausedMs ?? 0)}+${(w.totalPausedMs ?? 0)}ms`);
    queue((tx) => tx.workerWorkday.update({ where: { id: mine.id }, data: { startedAt, endedAt, totalPausedMs: (mine.totalPausedMs ?? 0) + (w.totalPausedMs ?? 0) } }));
    queue((tx) => tx.workerWorkday.delete({ where: { id: w.id } }));
  }
  add("workdays reassigned", "-> owner", wdMoved);
  add("workdays MERGED (lossy)", "min(start), max(end), paused summed", wdMerges.length);
  for (const m of wdMerges) console.log(`         - ${m}`);

  // ── 6. Deletions — things that must NOT become the owner ───────────────────
  //
  // PolicySignature carries typedNameRaw = "Mark Baliff": he physically typed
  // that name to sign. Reassigning it would manufacture a compliance signature
  // the owner never made — a forged legal record. Verified: all 4 are his own,
  // none signed on behalf of anyone, none carry an uploaded file, and no
  // PolicyReadingProgress rows reference them.
  console.log("\n6. Deletions (must not become the owner)");
  for (const [label, run, count] of [
    ["PolicySignature (typedNameRaw = his name)", (tx: any) => tx.policySignature.deleteMany({ where: { userId: MARK } }), await prisma.policySignature.count({ where: { userId: MARK } })],
    ["PolicyException", (tx: any) => tx.policyException.deleteMany({ where: { userId: MARK } }), await prisma.policyException.count({ where: { userId: MARK } })],
    ["PolicyReadingProgress", (tx: any) => tx.policyReadingProgress.deleteMany({ where: { userId: MARK } }), await prisma.policyReadingProgress.count({ where: { userId: MARK } })],
    ["PushSubscription", (tx: any) => tx.pushSubscription.deleteMany({ where: { userId: MARK } }), await prisma.pushSubscription.count({ where: { userId: MARK } })],
    ["UserRole", (tx: any) => tx.userRole.deleteMany({ where: { userId: MARK } }), await prisma.userRole.count({ where: { userId: MARK } })],
    ["CheckoutSplit", (tx: any) => tx.checkoutSplit.deleteMany({ where: { userId: MARK } }), await prisma.checkoutSplit.count({ where: { userId: MARK } })],
  ] as const) {
    add(label as string, "DELETE", count as number);
    if ((count as number) > 0) queue(run as Mutation, label as string, count as number);
  }
  // PolicySignature rows where he signed for SOMEONE ELSE stay — only the
  // pointer moves, or the other person's signature would vanish with him.
  for (const [label, run, count] of [
    ["PolicySignature.signedByUserId (others')", (tx: any) => tx.policySignature.updateMany({ where: { signedByUserId: MARK }, data: { signedByUserId: MIKE } }), await prisma.policySignature.count({ where: { signedByUserId: MARK, userId: { not: MARK } } })],
    ["PolicyException.grantedById (others')", (tx: any) => tx.policyException.updateMany({ where: { grantedById: MARK }, data: { grantedById: MIKE } }), await prisma.policyException.count({ where: { grantedById: MARK, userId: { not: MARK } } })],
  ] as const) {
    add(label as string, "-> owner (not deleted)", count as number);
    if ((count as number) > 0) queue(run as Mutation, label as string, count as number);
  }

  // Equipment he still holds. Deleting the Checkout rows alone leaves the gear
  // RESERVED to nobody, permanently unbookable — reset the status too.
  const openCo = await prisma.checkout.findMany({ where: { userId: MARK, releasedAt: null }, select: { equipmentId: true, equipment: { select: { status: true, brand: true, model: true } } } });
  add("Checkout", "DELETE", await prisma.checkout.count({ where: { userId: MARK } }));
  add("  ^ open holds stranding equipment", openCo.map((c) => `${c.equipment?.brand} ${c.equipment?.model} (${c.equipment?.status})`).join(", ") || "none", openCo.length);
  const openEquipmentIds = openCo.map((c) => c.equipmentId);
  for (const c of openCo) queue((tx) => tx.equipment.update({ where: { id: c.equipmentId }, data: { status: "AVAILABLE" } }));
  queue((tx) => tx.checkout.deleteMany({ where: { userId: MARK } }), "Checkout", await prisma.checkout.count({ where: { userId: MARK } }));

  // ── 7. The user row ────────────────────────────────────────────────────────
  //
  // Mirrors services/users.ts `remove()`. Zero rows today, but left in because
  // the failure mode is invisible: a ClientContact still carrying his
  // clerkUserId shows "Linked" forever, and blocks the next sign-up with that
  // email from auto-linking (/client/link matches on clerkUserId: null).
  console.log("\n7. Finally");
  const ghostLinks = await prisma.clientContact.count({ where: { clerkUserId: CLERK_ID } });
  add("ClientContact.clerkUserId", "unlink stale Clerk pointers", ghostLinks);
  if (ghostLinks > 0) queue((tx) => tx.clientContact.updateMany({ where: { clerkUserId: CLERK_ID }, data: { clerkUserId: null } }));

  add("User", `DELETE ${MARK_NAME}`, 1);
  queue((tx) => tx.user.delete({ where: { id: MARK } }));

  // ── Money invariants, captured BEFORE any write ────────────────────────────
  //
  // Deliberately a BEFORE/AFTER comparison, not an absolute "everything
  // balances" assertion: 14 of these 47 payments already fail conservation
  // today, all of them pre-dating BUSINESS_START_DATE 2026-05-11 (legacy rows,
  // already excluded from every export). Asserting balance would fail on data
  // this script never touches. Reassignment changes no amount, so the correct
  // invariant is that each payment's residual is EXACTLY what it was.
  const affectedPaymentIds = [...new Set(markSplits.map((s) => s.paymentId))];
  const before = await conservation(prisma, affectedPaymentIds);
  const beforeMoney = [...before.values()].reduce((a, b) => a + b.splitTotal, 0);
  console.log(`\nMoney baseline: ${affectedPaymentIds.length} affected payments, $${beforeMoney.toFixed(2)} in splits, ` +
    `${[...before.values()].filter((v) => Math.abs(v.residual) > 0.02).length} already out of balance (all pre-cutoff legacy).`);

  // ── Execute (or not) ───────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}`);
  console.log(`${plan.reduce((s, a) => s + a.rows, 0)} rows across ${plan.filter((a) => a.rows > 0).length} operations | ${mutations.length} queued statements`);

  // A rollback-able record of every value this run is about to overwrite.
  // Written in EVERY mode, before anything executes.
  const snapshotPath = `/tmp/purge-mark-baliff-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(snapshotPath, JSON.stringify({
    capturedAt: new Date().toISOString(), mark, mike, mode: MODE,
    paymentSplits: markSplits,
    assignees: markAsg,
    workdays: markWd,
    occurrenceJson: await prisma.jobOccurrence.findMany({
      where: { id: { in: [...new Set([...touchedOccIds, ...ppTouchedOccIds])] } },
      select: { id: true, completionSplits: true, promisedPayouts: true },
    }),
    payments: await prisma.payment.findMany({
      where: { id: { in: affectedPaymentIds } },
      select: { id: true, amountPaid: true, shortfallAmount: true, businessMarginAmount: true, platformFeeAmount: true, collectedById: true },
    }),
  }, null, 1));
  console.log(`Pre-change snapshot written to ${snapshotPath}`);

  if (MODE === "dry") {
    console.log("\nDRY RUN — nothing was written.");
    console.log("Next: REHEARSE=1 executes the real write path against this database and rolls back.");
    await verify(prisma, false);
    return;
  }

  // ── The write path ─────────────────────────────────────────────────────────
  //
  // REHEARSE runs every statement and every post-condition INSIDE the
  // transaction, then throws a sentinel to force a rollback. That exercises the
  // real mutations against real data and leaves nothing behind — the dry run
  // can only ever prove the plan, never the execution.
  //
  // One interactive transaction holds a lock on the User row, and /api/me
  // touches that row on every request, so a long run blocks the app for
  // everyone. This is also the payload shape Neon has hung on before (see
  // project_neon_pipelineconnect_workaround). Run it at low traffic.
  class RollbackSentinel extends Error {}
  let verified = false;
  try {
    await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      const overreach: string[] = [];
      for (const op of mutations) {
        const n = affectedCount(await op.run(tx));
        if (op.expected != null && n != null && n !== op.expected) {
          overreach.push(`${op.label}: touched ${n} rows, plan said ${op.expected}`);
        }
      }
      if (overreach.length > 0) {
        throw new Error(`BLAST RADIUS MISMATCH — a statement hit rows the plan did not account for:\n  ${overreach.join("\n  ")}`);
      }
      await postConditions(tx, { before, affectedPaymentIds, zeroCash, touchedOccIds, ppTouchedOccIds, openEquipmentIds });
      verified = true;
      if (MODE === "rehearse") throw new RollbackSentinel();
    }, { timeout: 180_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
    console.log(`\n${"─".repeat(78)}`);
    console.log("REHEARSAL COMPLETE — every statement ran, every post-condition passed, transaction ROLLED BACK.");
    console.log("Nothing was written. Re-run with APPLY=1 to commit the same work.");
    return;
  }
  if (!verified) throw new Error("Transaction finished without running post-conditions — refusing to report success.");
  console.log("\nTransaction committed. All post-conditions passed.");

  // AFTER the commit, never inside it: a Clerk deletion cannot be rolled back,
  // so doing it in-transaction (as users.remove() does) can leave the Clerk
  // account gone while the DB work aborts. Not optional either way —
  // plugins/auth.ts auto-provisions a User on first sign-in, so leaving the
  // account alive means he re-materialises the moment it opens the app.
  if (SKIP_CLERK) {
    console.log(`Clerk delete SKIPPED (SKIP_CLERK=1). Account ${CLERK_ID} is untouched.`);
  } else try {
    await clerk.users.deleteUser(CLERK_ID);
    console.log(`Clerk account ${CLERK_ID} deleted.`);
  } catch (e: any) {
    const gone = typeof e?.status === "number" && e.status === 404;
    console.log(gone
      ? `Clerk account ${CLERK_ID} was already gone.`
      : `!! CLERK DELETE FAILED (${e?.status ?? "?"}) — delete ${CLERK_ID} by hand or he can sign back in.`);
  }

  console.log(`
DONE. Next:
  1. cd apps/api && npm run test:build-gate
  2. Spot-check two or three rewritten AuditEvent.metadata rows.
  3. Snapshot of every overwritten value: ${snapshotPath}`);
}

/**
 * Everything that must be true once the work has run. Takes the transaction
 * client so it can be executed against uncommitted state during a rehearsal.
 * Throws on the first violation — a partial purge must never report success.
 */
async function postConditions(tx: Tx, ctx: {
  before: Map<string, { residual: number; splitTotal: number }>;
  affectedPaymentIds: string[];
  zeroCash: Array<{ paymentId: string; amount: number }>;
  touchedOccIds: string[];
  ppTouchedOccIds: string[];
  openEquipmentIds: string[];
}) {
  const fail = (m: string) => { throw new Error(m); };

  // 1. He is gone, and nothing references him.
  if (await tx.user.findUnique({ where: { id: MARK } })) fail("User row still exists.");
  const fks: Array<{ tbl: string; col: string }> = await tx.$queryRawUnsafe(
    `SELECT src.relname::text AS tbl, att.attname::text AS col
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_class tgt ON tgt.oid = con.confrelid
     JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f' AND tgt.relname = 'User'`);
  for (const fk of fks) {
    const r: Array<{ n: number }> = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "${fk.tbl}" WHERE "${fk.col}" = $1`, MARK);
    if (r[0].n > 0) fail(`${fk.tbl}.${fk.col} still has ${r[0].n} rows referencing him.`);
  }
  console.log("  ✓ user deleted; zero FK references remain");

  // 2. Money did not move. Residual is the invariant — 14 of these payments
  //    are already out of balance (pre-cutoff legacy) and must STAY that way.
  const after = await conservation(tx, ctx.affectedPaymentIds);
  const drift: string[] = [];
  for (const [id, b] of ctx.before) {
    const a = after.get(id);
    if (!a) { drift.push(`${id}: payment vanished`); continue; }
    if (Math.abs(a.residual - b.residual) > 0.02) drift.push(`${id}: residual ${b.residual.toFixed(2)} -> ${a.residual.toFixed(2)}`);
    const expectedDrop = ctx.zeroCash.filter((z) => z.paymentId === id).reduce((acc, z) => acc + z.amount, 0);
    if (Math.abs((b.splitTotal - expectedDrop) - a.splitTotal) > 0.02)
      drift.push(`${id}: splits ${b.splitTotal.toFixed(2)} -> ${a.splitTotal.toFixed(2)} (expected drop ${expectedDrop.toFixed(2)})`);
  }
  if (drift.length > 0) fail(`MONEY MOVED:\n  ${drift.join("\n  ")}`);
  console.log(`  ✓ money unchanged across ${ctx.affectedPaymentIds.length} payments`);

  // 3. Rewritten JSON still describes a whole job, with no duplicate person.
  const occs = await tx.jobOccurrence.findMany({
    where: { id: { in: [...new Set([...ctx.touchedOccIds, ...ctx.ppTouchedOccIds])] } },
    select: { id: true, completionSplits: true, promisedPayouts: true },
  });
  for (const o of occs) {
    for (const [field, arr] of [["completionSplits", o.completionSplits], ["promisedPayouts", o.promisedPayouts]] as const) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const ids = (arr as any[]).map((r) => r?.userId);
      if (new Set(ids).size !== ids.length) fail(`${o.id}: ${field} lists the same person twice after the merge.`);
      if (ids.includes(MARK)) fail(`${o.id}: ${field} still references him.`);
    }
    const cs = o.completionSplits as unknown as Array<{ percent: number }> | null;
    if (Array.isArray(cs) && cs.length > 0) {
      const sum = Math.round(cs.reduce((a, r) => a + (r.percent ?? 0), 0) * 100) / 100;
      if (Math.abs(sum - 100) > 0.02) fail(`${o.id}: completionSplits sum to ${sum}%, not 100.`);
    }
  }
  console.log(`  ✓ ${occs.length} rewritten snapshots: no duplicates, shares still total 100%`);

  // 4. Nobody holds a payout on a job they are not assigned to. This is what a
  //    botched assignee merge looks like, and the UI renders a raw cuid for it.
  const splits = await tx.paymentSplit.findMany({
    where: { paymentId: { in: ctx.affectedPaymentIds } },
    select: { userId: true, payment: { select: { occurrenceId: true } } },
  });
  const occIds = [...new Set(splits.map((s) => s.payment?.occurrenceId).filter(Boolean) as string[])];
  const asg = await tx.jobOccurrenceAssignee.findMany({ where: { occurrenceId: { in: occIds } }, select: { occurrenceId: true, userId: true } });
  const asgSet = new Set(asg.map((a) => `${a.occurrenceId}:${a.userId}`));
  for (const sp of splits) {
    const occId = sp.payment?.occurrenceId;
    if (occId && !asgSet.has(`${occId}:${sp.userId}`)) fail(`split for ${sp.userId} on ${occId}, who is not an assignee there.`);
  }
  console.log(`  ✓ every payout on those jobs belongs to an actual assignee`);

  // 5. Equipment he was holding is free, not stranded.
  for (const id of ctx.openEquipmentIds) {
    const eq = await tx.equipment.findUnique({ where: { id }, select: { status: true } });
    if (eq?.status !== "AVAILABLE") fail(`equipment ${id} left as ${eq?.status}, not AVAILABLE.`);
    const open = await tx.checkout.count({ where: { equipmentId: id, releasedAt: null } });
    if (open > 0) fail(`equipment ${id} still has ${open} open checkout(s).`);
  }
  console.log(`  ✓ ${ctx.openEquipmentIds.length} previously-held items released`);

  // 6. No trace of him in any text or JSON column.
  await verify(tx, true);
}

/**
 * Per-payment money snapshot. `residual` is the conservation gap
 * (see payments-build-gate.test.ts identity C); `splitTotal` is what workers
 * were paid. Both must be byte-identical before and after a pure reassignment.
 */
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

/** Re-scan every text and JSON column for any surviving trace of him. */
async function verify(db: Db, afterWrite: boolean) {
  const cols: Array<{ t: string; c: string; d: string }> = await db.$queryRawUnsafe(
    `SELECT table_name::text AS t, column_name::text AS c, data_type::text AS d
     FROM information_schema.columns
     WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json')
     ORDER BY table_name, column_name`);

  const residue: string[] = [];
  // Batched into single round trips — 537 sequential queries is enough
  // connection churn to make Neon drop some, which silently hides hits.
  for (let i = 0; i < cols.length; i += 30) {
    const chunk = cols.slice(i, i + 30);
    const sql = chunk.map((col) => {
      const cast = col.d.startsWith("j") ? `("${col.c}")::text` : `"${col.c}"`;
      return `SELECT '${col.t}.${col.c}' AS col,
        COUNT(*) FILTER (WHERE ${cast} ILIKE '%aliff%')::int AS name_n,
        COUNT(*) FILTER (WHERE ${cast} LIKE '%${MARK}%')::int AS id_n FROM "${col.t}"`;
    }).join(" UNION ALL ");
    const rows: Array<{ col: string; name_n: number; id_n: number }> = await db.$queryRawUnsafe(sql);
    for (const r of rows) {
      if (r.name_n === 0 && r.id_n === 0) continue;
      if (ALLOWED_RESIDUE.has(r.col)) { console.log(`\n  (known, left deliberately) ${r.col}: ${r.id_n} rows`); continue; }
      residue.push(`${r.col}: ${r.name_n} by name, ${r.id_n} by id`);
    }
  }

  if (residue.length === 0) {
    console.log(`\n✓ Verification: no trace of him in any text or JSON column${afterWrite ? "" : " OTHER than what this plan covers"}.`);
    return;
  }
  console.log(`\n${afterWrite ? "✗ RESIDUE REMAINS AFTER WRITE:" : "Would still remain (expected before a run — this is the work above):"}`);
  for (const r of residue) console.log("   ", r);
  if (afterWrite) throw new Error("Purge incomplete — see residue above.");
}

main()
  .catch((e) => { console.error("\nFAILED:", e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
