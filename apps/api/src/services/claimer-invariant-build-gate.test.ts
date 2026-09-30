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
 * awaiting `enforceClaimerInvariant`, or the write carries a
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
        if (/enforceClaimerInvariant\s*\(/.test(lines[j])) { covered = true; break; }
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

  it("every assignee write is followed by enforceClaimerInvariant or annotated", () => {
    const orphans = sites
      .filter((s) => !s.covered && !s.allowed)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      orphans,
      "Each of these writes JobOccurrenceAssignee without re-establishing the " +
        "claimer invariant. Either await enforceClaimerInvariant(tx, occurrenceId, actor) " +
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
  // gated on `isClaimer` alone while every sibling action admitted `forAdmin`,
  // so a claimer-less visit could not be started, completed OR unclaimed by
  // anyone at any role — a dead end with no message explaining it.
  it("an admin can always unclaim, so a stuck visit is never a dead end", () => {
    const tab = path.join(WEB_SRC, "ui", "tabs", "JobsTab.tsx");
    if (!fs.existsSync(tab)) return;
    const src = fs.readFileSync(tab, "utf8");
    const at = src.indexOf('id="occ-unclaim"');
    expect(at, "the Unclaim button went missing").toBeGreaterThan(-1);
    // The gate is the JSX condition immediately preceding the button.
    const gate = src.slice(Math.max(0, at - 400), at);
    expect(
      gate,
      "Unclaim must admit forAdmin like every sibling action, or a visit with " +
        "no claimer can never be released by anyone.",
    ).toMatch(/\(isClaimer \|\| forAdmin\)[\s\S]*occ\.status === "SCHEDULED"/);
  });

  it("the server lets an admin unclaim, which is what the UI gate mirrors", () => {
    const src = fs.readFileSync(path.join(API_SRC, "services", "jobs.ts"), "utf8");
    const fn = src.slice(src.indexOf("async unclaimOccurrence"));
    const body = fn.slice(0, fn.indexOf("\n  async ", 1));
    expect(body).toMatch(/callerIsAdmin/);
  });

  it("server and UI still agree on what a claimer is", () => {
    const server = fs.readFileSync(path.join(API_SRC, "services", "jobs.ts"), "utf8");
    expect(server).toMatch(/assignee\?\.assignedById === currentUserId && assignee\?\.role !== "observer"/);
    const tab = path.join(WEB_SRC, "ui", "tabs", "JobsTab.tsx");
    if (fs.existsSync(tab)) {
      expect(fs.readFileSync(tab, "utf8")).toMatch(/myAssignee\.assignedById === myId/);
    }
  });
});
