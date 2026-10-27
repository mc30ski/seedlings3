// ─────────────────────────────────────────────────────────────────────────────
// Audit-coverage build gate
//
// PURPOSE
// Stop mutations shipping with no audit trail. On 2026-08-22 a system-wide
// sweep found 158 unaudited mutations, 46 of them HIGH severity — five
// entire services (`expenses`, `mileage`, `supplies`, `groups`, `vehicles`)
// had ZERO audit coverage from the day they shipped. An ordinary cash
// payment wrote no audit row at all.
//
// The reason it went unnoticed for months is simple: NOTHING FAILED when a
// feature shipped unaudited. This gate is that missing failure.
//
// HOW IT WORKS — a per-file RATCHET, not a per-line assertion.
//
// Precisely attributing "is this specific mutation audited?" needs real
// scope analysis; a regex approximation would produce false positives on a
// codebase where one audited action legitimately performs several writes
// (createPayment writes a Payment plus N PaymentSplits under one
// PAYMENT.CREATED row). So instead we count, per file:
//
//     unaudited = <mutation call sites> - <writeAudit calls> - <allowed>
//
// and compare against a checked-in BASELINE. A file may not get WORSE than
// its baseline. That makes the common failure mode — adding a mutation to
// an existing file without auditing it — fail the build, while tolerating
// the imprecision of counting.
//
// TWO WAYS TO SATISFY THIS GATE when you add a mutation:
//   1. Audit it (correct answer almost always) — see
//      apps/api/src/lib/auditActions.ts for the constant list.
//   2. If it genuinely doesn't warrant an audit row — a counter, a
//      read-through cache, sync bookkeeping, a derived recomputation that
//      accompanies an already-audited action — put this on the line above:
//          // audit-allow: <reason>
//      Same convention as the date-handling and view-as gates. Say WHY.
//
// LOWERING A BASELINE is always welcome and requires no discussion.
// RAISING one means you are knowingly shipping an unaudited mutation:
// don't, unless you've added an `audit-allow` and are recording it here
// with a reason.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_DIRS = ["apps/api/src/services", "apps/api/src/routes"] as const;

/** A Prisma write through either the client or a transaction handle. */
const MUTATION =
  /\b(?:tx|prisma|client)\.[a-zA-Z_$][\w$]*\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/;

const AUDIT_CALL = /\bwriteAudit\s*\(/;
/** Direct auditEvent.create — a couple of call sites bypass the helper. */
const RAW_AUDIT = /\bauditEvent\.create\s*\(/;
const ALLOW = /\/\/\s*audit-allow:\s*\S/;

/**
 * Per-file allowance for mutation sites that legitimately carry no audit
 * row and have no inline `audit-allow` comment yet.
 *
 * These numbers are the state as of the 2026-08-22 sweep. They exist so
 * the gate can be introduced without a flag-day rewrite of every last
 * bookkeeping write. Drive them DOWN over time — every one that reaches 0
 * is a file that can never regress.
 */
const BASELINE: Record<string, number> = {
  // Large multi-write services: one audited action often performs several
  // writes (createPayment = 1 Payment + N PaymentSplits under one
  // PAYMENT.CREATED row), so a count well below the mutation total is
  // expected and healthy here.
  "apps/api/src/services/jobs.ts": 39,
  // Raised 32 → 33 on 2026-08-31 by the guaranteed-payout removal, NOT by a
  // coverage regression. The GP endpoint was a single mutation with TWO
  // audit branches (GUARANTEED_PAYOUT_STARTED / _ENDED), so deleting it
  // removed 1 mutation site and 2 writeAudit calls — the ratio gets worse
  // even though every remaining mutation is exactly as audited as before.
  // NONE OF THESE IS NEW DEBT — the routes moved.
  //
  // The route layer was split by resource. Existing unaudited mutations
  // relocated, and the arithmetic is conserved — occurrences 21 + jobs 11 +
  // equipment 4 is exactly the 36 held before the split. Nothing became
  // unaudited here.
  "apps/api/src/routes/occurrences.ts": 21,
  "apps/api/src/routes/jobs.ts": 11,
  "apps/api/src/routes/equipment.ts": 4,
  //
  // The three below moved in the first wave of the same split.
  //
  // The same split relocated more existing unaudited mutations. The
  // arithmetic is conserved: 25→20 and 18→16 frees 7, and books 2 +
  // documents 3 + calendarFeeds 2 is exactly 7. No mutation became
  // unaudited in this change; each one simply has a new address.
  // Lowered 2 → 1 on 2026-10-22: the five tax-export CSV endpoints now
  // write AUDIT.EXPORT.DOWNLOADED through `deliverPlainCsv`, and the
  // pricing-key delete moved into a transaction with its audit row.
  "apps/api/src/routes/books.ts": 1,
  "apps/api/src/routes/documents.ts": 3,
  "apps/api/src/routes/calendarFeeds.ts": 2,
  "apps/api/src/services/payments.ts": 16,
  "apps/api/src/services/supplies.ts": 14,
  // Background sync worker — queue/state bookkeeping, not user actions.
  // Best candidate for dropping to 0 via audit-allow comments.
  "apps/api/src/services/documentSyncWorker.ts": 15,
  "apps/api/src/services/promotions.ts": 13,
  "apps/api/src/services/equipment.ts": 13,
  // invoiceCharges.ts (was expenses.ts). The two "unaudited" sites are the
  // supply.update + supplyHold.update that release inventory inside
  // deleteInvoiceCharge — one audited action, and the DELETED row already
  // snapshots supplyHoldStatusBefore / supplyHoldQuantity.
  "apps/api/src/services/invoiceCharges.ts": 2,
  "apps/api/src/services/policies.ts": 7,
  "apps/api/src/services/groups.ts": 4,
  "apps/api/src/services/vanityPages.ts": 4,
  "apps/api/src/services/users.ts": 3,
  "apps/api/src/services/mileage.ts": 2,
  // Ratcheted 2 -> 1 on 2026-09-19. Removing the Client bulk pause/resume
  // pair took two well-audited mutations out of this file and exposed how
  // much slack the whole-file count had been carrying; three single-primary
  // invariant writes now carry `audit-allow`. The remaining 1 is the
  // multi-client identity propagation in updateContact — it edits contact
  // rows belonging to OTHER clients, and the CONTACT_UPDATED row beside it
  // names only the contact the operator actually edited.
  "apps/api/src/services/clients.ts": 1,
  "apps/api/src/services/documentSyncQueue.ts": 1,
  "apps/api/src/services/companyDocuments.ts": 1,
  "apps/api/src/services/banners.ts": 1,
  "apps/api/src/routes/equipmentCollections.ts": 3,
  // Was 1: the only "mutation" was `client.messages.create` — an Anthropic
  // SDK call the regex mistook for a Prisma write. Variable renamed; this
  // file has no DB mutations at all.
  "apps/api/src/routes/preview.ts": 0,
  // me.ts + public.ts were reviewed line-by-line during the sweep and
  // every site is a deliberate exemption (Clerk profile sync,
  // lastAccessedAt bump, push-subscription registration, client-side hint
  // flags). They carry inline audit-allow comments; these entries stay at
  // 0 and the comments do the work.
};

type FileStat = { file: string; mutations: number; audits: number; allowed: number };

function walk(dir: string, acc: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile() && full.endsWith(".ts") && !full.includes(".test.")) acc.push(full);
  }
}

/** Every scanned source file, repo-relative. Shares `walk` with the
 *  ratchet above so the two can never disagree about what is in scope. */
function sourceFiles(): string[] {
  const files: string[] = [];
  for (const d of [...SCAN_DIRS, "apps/api/src/lib"]) walk(join(REPO_ROOT, d), files);
  return files.map((f) => relative(REPO_ROOT, f));
}

function scan(): FileStat[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);
  const out: FileStat[] = [];
  for (const abs of files) {
    const lines = readFileSync(abs, "utf8").split("\n");
    let mutations = 0;
    let audits = 0;
    let allowed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (AUDIT_CALL.test(line) || RAW_AUDIT.test(line)) audits++;
      if (!MUTATION.test(line)) continue;
      mutations++;
      // Suppression comment on this line or within the 4 above. A real
      // justification usually needs two or three lines of prose, which put
      // the `audit-allow:` token further from the mutation than a 2-line
      // window reaches. Matches the observer-filter gate's lookback.
      const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      if (ALLOW.test(window)) allowed++;
    }
    out.push({ file: relative(REPO_ROOT, abs), mutations, audits, allowed });
  }
  return out;
}

describe("audit-coverage build gate", () => {
  const stats = scan();

  it("no file has more unaudited mutations than its recorded baseline", () => {
    const regressions: string[] = [];
    for (const s of stats) {
      if (s.mutations === 0) continue;
      const uncovered = Math.max(0, s.mutations - s.audits - s.allowed);
      const budget = BASELINE[s.file] ?? 0;
      if (uncovered > budget) {
        regressions.push(
          `  ${s.file}\n` +
            `      ${s.mutations} mutation site(s), ${s.audits} writeAudit call(s), ` +
            `${s.allowed} audit-allow\n` +
            `      → ${uncovered} unaudited, but the baseline permits ${budget}`,
        );
      }
    }
    if (regressions.length > 0) {
      expect.fail(
        `\nAudit coverage regressed in ${regressions.length} file(s).\n\n` +
          regressions.join("\n\n") +
          `\n\nEvery mutation that changes user-meaningful state must write an\n` +
          `audit row, in the SAME edit as the mutation:\n\n` +
          `    await writeAudit(tx, AUDIT.SCOPE.VERB, currentUserId, { ...metadata });\n\n` +
          `Pass \`tx\`, not \`prisma\` — the audit must commit atomically with the\n` +
          `change. Destructive paths must snapshot what they destroy BEFORE the\n` +
          `delete; money fields carry before AND after values.\n\n` +
          `If this write genuinely needs no audit (counter, cache, sync\n` +
          `bookkeeping, derived recomputation alongside an already-audited\n` +
          `action), mark it on the line above and say why:\n\n` +
          `    // audit-allow: viewCount bump, not a user-meaningful change\n`,
      );
    }
  });

  it("the baseline contains no stale entries", () => {
    // A baseline entry for a file that no longer needs it means the ratchet
    // has slack in it — someone could reintroduce an unaudited mutation for
    // free. Lowering is always safe, so make it mandatory.
    const stale: string[] = [];
    for (const [file, budget] of Object.entries(BASELINE)) {
      const s = stats.find((x) => x.file === file);
      if (!s) {
        stale.push(`  ${file} — no longer exists (or was renamed); drop the entry`);
        continue;
      }
      const uncovered = Math.max(0, s.mutations - s.audits - s.allowed);
      if (uncovered < budget) {
        stale.push(`  ${file} — baseline ${budget}, actual ${uncovered}; lower it to ${uncovered}`);
      }
    }
    if (stale.length > 0) {
      expect.fail(
        `\nThe audit-coverage baseline has slack and should be tightened:\n\n` +
          stale.join("\n") +
          `\n\nEdit BASELINE in this file. Ratchets only ever go down.\n`,
      );
    }
  });
  // ───────────────────────────────────────────────────────────────────────
  // An audit row must not be able to claim more than the database did.
  //
  // Found 2026-10-22 in `DELETE /pricing/:key`: it called
  // `writeAudit(prisma, …)` and THEN `prisma.setting.delete(…)`, neither in
  // a transaction. A delete that threw — a key already gone, a constraint —
  // left a row asserting a deletion that never happened. A trail is only
  // evidence if it cannot outrun the writes it reports.
  //
  // The rule is narrow on purpose: an audit on the BARE client with a
  // bare-client mutation close behind it. Audits inside `$transaction`
  // blocks take `tx` and are atomic by construction, and a read event
  // (DOCUMENT.VIEWED) has no following write, so neither trips this.
  // ───────────────────────────────────────────────────────────────────────
  it("no audit row is written before the mutation it reports", () => {
    const offenders: string[] = [];
    const BARE_MUTATION =
      /\bprisma\.[a-zA-Z_$][\w$]*\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/;
    for (const file of sourceFiles()) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!/\bwriteAudit\(\s*prisma\s*,/.test(line)) return;
        const after = lines.slice(i + 1, i + 7).join("\n");
        if (BARE_MUTATION.test(after)) {
          offenders.push(
            `  ${file}:${i + 1} — audit written before the write it reports; ` +
              `put both in one $transaction and audit AFTER the write`,
          );
        }
      });
    }
    expect(
      offenders,
      `\nAn audit row must not precede its own mutation:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // The verb must name what the function actually did.
  //
  // Found 2026-10-22: `customRoles.create` and `customRoles.update` both
  // wrote AUDIT.ROLE.ROLE_ASSIGNED, so defining a role and editing its icon
  // both read in the trail as somebody being GRANTED a role — a different
  // question entirely, and the one an auditor filters on. Both carried a
  // metadata `action: "role_created"` saying the truth, which is why it
  // survived: whoever opened a row saw the right thing, and whoever
  // filtered by verb did not. The web's `entryLabel` builds its text from
  // scope + verb, so the screen read "role role assigned" for an icon edit.
  //
  // Only the unambiguous direction is checked — a function whose name
  // begins create/update must not write an ASSIGNED or REMOVED verb. Those
  // name a grant, which is never what a create or an update is.
  // ───────────────────────────────────────────────────────────────────────
  it("a create/update function does not audit as a grant", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf-8").split("\n");
      let fn: string | null = null;
      lines.forEach((line, i) => {
        const m = line.match(/^\s*(?:async\s+)?(?:function\s+)?([a-zA-Z_$][\w$]*)\s*\(/);
        if (m && /^\s{0,4}(async\s+)?[a-zA-Z_$][\w$]*\s*\(/.test(line)) fn = m[1];
        const a = line.match(/writeAudit\(\s*\w+,\s*AUDIT\.(\w+)\.(\w+)/);
        if (!a || !fn) return;
        if (!/^(create|update)/i.test(fn)) return;
        if (/(ASSIGNED|REMOVED)/.test(a[2])) {
          offenders.push(
            `  ${file}:${i + 1} — ${fn}() writes AUDIT.${a[1]}.${a[2]}; ` +
              `a create/update is not a grant`,
          );
        }
      });
    }
    expect(
      offenders,
      `\nThe audit verb must name what the function did:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });
});
