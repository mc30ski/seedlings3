import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * THE CLAIMER INVARIANT, MECHANICALLY ENFORCED
 * ============================================
 *
 * An occurrence is UNCLAIMED or it has exactly one claimer. A visit with
 * workers and no claimer cannot be started, completed or paid by anyone below
 * admin — and the Jobs card shows no button and no reason, so it reads as the
 * app being broken. That state shipped, silently, for months.
 *
 * Four separate write paths could produce it, none of them obviously wrong at
 * the callsite. That is why this is a gate and not a code review note: the
 * rule has to hold for paths nobody has thought of yet.
 *
 * The rule: any function that writes `jobOccurrenceAssignee` either ends by
 * awaiting `enforceAssigneeInvariants`, or the write carries a
 * `// claimer-invariant-allow: <reason>` comment directly above it.
 */

const API_SRC = path.resolve(__dirname, "..");
const WEB_SRC = path.resolve(__dirname, "../../../web/src");

const WRITE_RE = /jobOccurrenceAssignee\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const ALLOW_RE = /claimer-invariant-allow:/;
/** Start of a new method, function, or route handler. */
const SEGMENT_RE = /^\s{0,4}(export\s+)?(async\s+)?(function\s+\w+\s*\(|\w+\s*\([^)]*\)\s*\{?\s*$|app\.(get|post|put|patch|delete)\s*\()/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

type Site = { file: string; line: number; text: string; covered: boolean; allowed: boolean };

function findWriteSites(): Site[] {
  const sites: Site[] = [];
  for (const file of walk(API_SRC)) {
    // The enforcer itself necessarily writes the table.
    if (file.endsWith(path.join("lib", "claimerInvariant.ts"))) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!WRITE_RE.test(lines[i])) continue;

      // Annotation: within the 6 lines directly above the write.
      const allowed = lines.slice(Math.max(0, i - 6), i).some((l) => ALLOW_RE.test(l));

      // Coverage: an enforcer call later in the SAME function — scan forward
      // until the next method/function/route begins.
      let covered = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (SEGMENT_RE.test(lines[j]) && !/jobOccurrenceAssignee/.test(lines[j])) break;
        if (/enforceAssigneeInvariants\s*\(/.test(lines[j])) { covered = true; break; }
      }
      sites.push({
        file: path.relative(API_SRC, file),
        line: i + 1,
        text: lines[i].trim(),
        covered,
        allowed,
      });
    }
  }
  return sites;
}

describe("[build-gate] an occurrence is UNCLAIMED or has exactly one claimer", () => {
  const sites = findWriteSites();

  it("finds the assignee write sites at all (the scan is not vacuous)", () => {
    expect(sites.length).toBeGreaterThan(15);
    const files = new Set(sites.map((s) => s.file));
    expect(files).toContain(path.join("services", "jobs.ts"));
    expect(files).toContain(path.join("services", "groups.ts"));
  });

  it("every assignee write is followed by enforceAssigneeInvariants or annotated", () => {
    const orphans = sites
      .filter((s) => !s.covered && !s.allowed)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      orphans,
      "Each of these writes JobOccurrenceAssignee without re-establishing the " +
        "claimer invariant. Either await enforceAssigneeInvariants(tx, occurrenceId, actor) " +
        "at the end of the function, or put `// claimer-invariant-allow: <why>` " +
        "directly above the write. See lib/claimerInvariant.ts.",
    ).toEqual([]);
  });

  it("every annotation carries a reason, not a bare silencer", () => {
    const api = walk(API_SRC).filter((f) => !f.endsWith(".test.ts"));
    const bare: string[] = [];
    for (const file of api) {
      fs.readFileSync(file, "utf8").split("\n").forEach((l, i) => {
        if (!ALLOW_RE.test(l)) return;
        const reason = l.split("claimer-invariant-allow:")[1]?.trim() ?? "";
        if (reason.length < 12) bare.push(`${path.relative(API_SRC, file)}:${i + 1}`);
      });
    }
    expect(bare, "annotations must explain WHY the invariant cannot break here").toEqual([]);
  });

  it("setOccurrenceAssignees upserts — createMany cannot promote a claimer", () => {
    const src = fs.readFileSync(path.join(API_SRC, "services", "jobs.ts"), "utf8");
    const fn = src.slice(src.indexOf("async setOccurrenceAssignees"));
    const body = fn.slice(0, fn.indexOf("\n  async ", 1));
    expect(body).toMatch(/jobOccurrenceAssignee\.upsert/);
    // THE SHIPPED BUG: createMany + @@unique([occurrenceId,userId]) silently
    // skipped the very rows that needed promoting to claimer.
    expect(
      body,
      "createMany can only INSERT; on a @@unique table it skips the existing " +
        "row instead of promoting it, which is how visits lost their claimer.",
    ).not.toMatch(/jobOccurrenceAssignee\.createMany/);
  });

  it("the repair is real — it updates rows and audits what it changed", () => {
    const src = fs.readFileSync(path.join(API_SRC, "lib", "claimerInvariant.ts"), "utf8");
    expect(src).toMatch(/jobOccurrenceAssignee\.update\(/);
    expect(src).toMatch(/claimer_invariant_repaired/);
    expect(src).toMatch(/AUDIT\.JOB\.ASSIGNEES_UPDATED/);
    // Unclaimed must stay legal, or claiming a fresh visit becomes impossible.
    expect(src).toMatch(/workers\.length === 0.*\n?.*claimerUserId: null/);
  });

  // A visit that has lost its claimer must always have a way OUT. Unclaim was
  // gated on `isClaimer` alone while every sibling action admitted the
  // schedule-manage capability,
  // so a claimer-less visit could not be started, completed OR unclaimed by
  // anyone at any role — a dead end with no message explaining it.
  it("someone with schedule authority can always unclaim, so a stuck visit is never a dead end", () => {
    const tab = path.join(WEB_SRC, "ui", "tabs", "JobsTab.tsx");
    if (!fs.existsSync(tab)) return;
    const src = fs.readFileSync(tab, "utf8");
    const at = src.indexOf('id="occ-unclaim"');
    expect(at, "the Unclaim button went missing").toBeGreaterThan(-1);
    // The gate is the JSX condition immediately preceding the button.
    const gate = src.slice(Math.max(0, at - 400), at);
    expect(
      gate,
      "Unclaim must admit `canManageSchedule` like every sibling action, or a visit with " +
        "no claimer can never be released by anyone.",
    ).toMatch(/\(isClaimer \|\| canManageSchedule\)[\s\S]*occ\.status === "SCHEDULED"/);
  });

  it("the server lets `schedule.manage` unclaim, which is what the UI gate mirrors", () => {
    const src = fs.readFileSync(path.join(API_SRC, "services", "jobs.ts"), "utf8");
    const fn = src.slice(src.indexOf("async unclaimOccurrence"));
    const body = fn.slice(0, fn.indexOf("\n  async ", 1));
    expect(body).toMatch(/callerCanManageSchedule/);
  });

  it("server and UI still agree on what a claimer is", () => {
    const server = fs.readFileSync(path.join(API_SRC, "services", "jobs.ts"), "utf8");
    expect(server).toMatch(/assignee\?\.assignedById === currentUserId && assignee\?\.role !== "observer"/);

    // THE WEB HAS EXACTLY ONE DEFINITION, AND NOBODY RE-DERIVES IT.
    //
    // This used to assert a single literal inside JobsTab.tsx, which proved
    // only that ONE of the web's copies matched the server. There were
    // eleven, and three had dropped the `role !== "observer"` half. The
    // result reached production: on a visit whose only self-assigned row was
    // an OBSERVER, the card line rendered that observer as "Claimer - Lead
    // Worker", the Manage Team dialog badged a different person "Claimer"
    // (it filled in the first worker when nobody had self-assigned), and the
    // API considered the visit to have no claimer at all and refused Start
    // with NOT_CLAIMER. Three answers, one screen.
    //
    // Pinning one copy cannot catch that, so the rule is now: the helper
    // holds the definition, and the expression appears nowhere else.
    const helper = path.join(WEB_SRC, "ui", "tabs", "JobsTab.utils.ts");
    expect(fs.existsSync(helper), "the shared claimer helper is gone").toBe(true);
    expect(
      fs.readFileSync(helper, "utf8"),
      "assigneeIsClaimer must carry the server's rule, both halves",
    ).toMatch(
      /export function assigneeIsClaimer[\s\S]{0,240}?a\.assignedById === a\.userId && a\.role !== "observer"/,
    );

    // Any other comparison of assignedById to a user id is the rule written
    // out again — correct today, one edit away from dropping a half.
    const REDERIVED = /assignedById === /;
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC)) {
      if (path.resolve(file) === path.resolve(helper)) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (REDERIVED.test(line)) {
          offenders.push(`${path.relative(WEB_SRC, file)}:${i + 1}  ${t.slice(0, 80)}`);
        }
      });
    }
    expect(
      offenders,
      "Use `assigneeIsClaimer` from JobsTab.utils instead of comparing " +
        "`assignedById` by hand — a copy that omits `role !== \"observer\"` " +
        "labels an observer as the claimer while the API refuses their Start.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G33 — ONLY A PAID PERSON TAKES A PAID SEAT.
//
// A non-observer assignee is someone the money system will try to pay, so
// they must be on payroll. The rule is enforced in two places and this gate
// checks both are still wired:
//
//   • `planObserverOnlyDemotions` inside `enforceAssigneeInvariants`, which
//     every assignee write path already awaits (the gate above). That is the
//     net under rows that already exist.
//   • `canHoldPaidSeat` at the add/promote boundary, which refuses up front
//     so the UI can explain itself rather than appearing to succeed.
//
// Why it is worth a gate: an UNPAID person in a paid seat does not degrade,
// it BREAKS. `rateFor` refuses to price a worker with no pay class, so
// `computeBreakdown` throws and completing the visit fails for everyone on
// it. And before that refusal existed, the same person was read as a
// contractor by every `!isEmployeeClass` in the money code — equipment fees,
// QuickBooks Contract Labor, and the employer payroll-tax base.
// ─────────────────────────────────────────────────────────────────────────────
describe("[build-gate] G33 — only a paid person takes a paid seat", () => {
  const INV = fs.readFileSync(
    path.join(__dirname, "..", "lib", "claimerInvariant.ts"),
    "utf8",
  );

  it("the demotion runs INSIDE the chokepoint every write path already awaits", () => {
    // If it moved out into its own exported function that callers must
    // remember separately, it would rot exactly the way the claimer
    // invariant did across four write paths.
    const fn = INV.slice(INV.indexOf("export async function enforceAssigneeInvariants"));
    expect(fn).toMatch(/planObserverOnlyDemotions\(/);
  });

  it("the demotion runs BEFORE the claimer repair", () => {
    // Order is load-bearing: demoting someone can remove the claimer, so the
    // repair has to see the rows as they end up. Reversed, a visit is left
    // with workers and no claimer — unstartable for everyone below admin.
    const fn = INV.slice(INV.indexOf("export async function enforceAssigneeInvariants"));
    const demote = fn.indexOf("planObserverOnlyDemotions(");
    const repair = fn.indexOf("planClaimerRepair(");
    expect(demote).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(-1);
    expect(demote).toBeLessThan(repair);
  });

  it("eligibility is asked POSITIVELY, via isPaid", () => {
    // `!isW2(x)` or `workerType !== "UNPAID"` would both let an untyped
    // person keep a paid seat, which is the same class of bug G30 covers.
    expect(INV).toMatch(/isPaid\(/);
    expect(INV).not.toMatch(/workerType\s*[!=]==\s*["']UNPAID["']/);
  });

  it("a row whose workerType was not loaded is LEFT ALONE", () => {
    // The dangerous direction. Treating an absent join as "not on payroll"
    // would demote a whole team over a missing `select`.
    const planner = INV.slice(
      INV.indexOf("export function planObserverOnlyDemotions"),
      INV.indexOf("export type ClaimerPlan") >= 0
        ? INV.length
        : INV.length,
    );
    expect(planner).toMatch(/workerType !== undefined/);
  });

  it("every demotion is audited", () => {
    // A silently-moved person would look like they were always an observer.
    const fn = INV.slice(INV.indexOf("export async function enforceAssigneeInvariants"));
    const demoteBlock = fn.slice(fn.indexOf("planObserverOnlyDemotions("));
    expect(demoteBlock).toMatch(/writeAudit\(/);
    expect(demoteBlock).toMatch(/demoted_to_observer_not_on_payroll/);
  });

  it("an observer's assignedById is cleared when they are demoted", () => {
    // A self-assigned row left behind reads as a claimer to every
    // `find(a => a.assignedById === a.userId)` downstream.
    const fn = INV.slice(INV.indexOf("export async function enforceAssigneeInvariants"));
    const demoteBlock = fn.slice(fn.indexOf("planObserverOnlyDemotions("), fn.indexOf("planClaimerRepair("));
    expect(demoteBlock).toMatch(/role: "observer"/);
    expect(demoteBlock).toMatch(/assignedById: null/);
  });

  it("the add/promote boundary refuses rather than relying on the net", () => {
    const jobs = fs.readFileSync(path.join(__dirname, "jobs.ts"), "utf8");
    expect(jobs, "changeAssigneeRole must refuse a non-paid promotion").toMatch(
      /canHoldPaidSeat\(/,
    );
    expect(jobs).toMatch(/NOT_ON_PAYROLL/);
  });

  it("leaving payroll vacates open paid seats, and leaves COMPLETED work alone", () => {
    // Promised payouts were locked at completion under the class the person
    // held then. Rewriting them restates what someone was owed for work
    // already done.
    const users = fs.readFileSync(path.join(__dirname, "users.ts"), "utf8");
    const fn = users.slice(users.indexOf("async setWorkerType"));
    const body = fn.slice(0, fn.indexOf("async setIsOwner"));
    expect(body).toMatch(/canHoldPaidSeat\(/);
    expect(body).toMatch(/completedAt: null/);
    expect(body).toMatch(/enforceAssigneeInvariants\(/);
  });
});
