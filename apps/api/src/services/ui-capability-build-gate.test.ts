/**
 * G15 — a mutating file asks for the capability it mutates behind.
 *
 * THE BUG THIS EXISTS FOR. The UI gated on a role and the server gated on a
 * capability, and the two drifted: the Unclaim button checked `isClaimer`
 * while the route allowed `isClaimer || schedule.manage`, so a claimer-less visit
 * could be released by nobody. Every such pair is a button that is missing,
 * or a button that 403s.
 *
 * WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT. The honest check is
 * "the condition on the BUTTON matches the guard on its route", and that is
 * not statically decidable here — the handler is usually defined far from
 * the JSX, behind a callback, in an 11k-line file. So this asks a weaker
 * question that is still worth asking: a file that calls a guarded mutation
 * must mention that entitlement SOMEWHERE. A file that posts to a route
 * requiring `money.approve` and never says "money.approve" is relying
 * entirely on where it happens to be mounted.
 *
 * RELYING ON THE MOUNT POINT IS NOT A SECURITY HOLE — the server checks
 * every request and fails closed. It is a DRIFT surface: move the component,
 * reuse the dialog from a second place, and the gate silently does not come
 * with it.
 *
 * PENDING IS SHRINK-ONLY. The list may only get shorter — a new entry means
 * new code that mutates without asking, and the gate refuses it.
 *
 * NO COUNT IS WRITTEN HERE ON PURPOSE. This paragraph used to open "58 files
 * are in this state" and the list had held 38 for some time; nothing asserted
 * the number, so it rotted the first time an entry came off. The list below
 * IS the count, and "PENDING only shrinks" keeps it exact in both directions
 * — an entry that no longer offends fails the gate just as a new offender
 * does. A number in prose beside a gated list is a second source of truth
 * with nothing holding it to the first.
 *
 * It once read 71, which was wrong in a way worth remembering: 13 of those
 * were files calling OWNERSHIP routes, misattributed to an entitlement by a
 * regex that skipped the uppercase buckets. A backlog with false entries in
 * it teaches people to ignore it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const WEB = path.join(REPO, "apps/web");
const ROUTE_MAP = path.join(REPO, "docs/features/permissions-ROUTE-MAP.md");

/**
 * Buckets that are not entitlements.
 *
 * SPELLED EXACTLY AS THE MAP SPELLS THEM. The first version of this guessed
 * ("CLIENT", "DEVICE") and the map says `CLIENT-PORTAL` and `SYSTEM`, so two
 * of the four never matched. That was survivable only because of a second
 * bug that hid it — see `routeEntitlements`.
 */
const NOT_AN_ENTITLEMENT = new Set(["OWNERSHIP", "CLIENT-PORTAL", "PUBLIC", "SYSTEM"]);

/**
 * Files that mutate behind a capability they never name.
 *
 * SHRINK-ONLY. Removing a line means that file now asks. Adding one is
 * refused: write the check instead.
 */
const PENDING: readonly string[] = [
    "src/ui/components/ClientContactLinkActions.tsx",
    "src/ui/components/ClientRequestsSection.tsx",
    "src/ui/components/DocumentSyncStatusPanel.tsx",
    "src/ui/components/NewJobSetupWorkflow.tsx",
    "src/ui/components/NextStartOverrideAffordance.tsx",
    "src/ui/components/OutstandingRequestsSection.tsx",
    "src/ui/components/PendingApprovalsSection.tsx",
    "src/ui/components/StreamPauseControls.tsx",
    "src/ui/components/tasks/PendingUserSignupsSection.tsx",
    "src/ui/components/tasks/UnapprovedHoursSection.tsx",
    "src/ui/dialogs/AddAssigneeDialog.tsx",
    "src/ui/dialogs/ApproveAndLinkClientDialog.tsx",
    "src/ui/dialogs/AssigneeDialog.tsx",
    "src/ui/dialogs/DefaultCrewDialog.tsx",
    "src/ui/dialogs/EquipmentInstructionsDialog.tsx",
    "src/ui/dialogs/JobDefaultGuidanceDialog.tsx",
    "src/ui/dialogs/JobDialog.tsx",
    "src/ui/dialogs/ManageInvoiceChargesDialog.tsx",
    "src/ui/dialogs/MileageReviewDialog.tsx",
    "src/ui/dialogs/OccurrenceDialog.tsx",
    "src/ui/dialogs/PinnedNoteDialog.tsx",
    "src/ui/dialogs/TimelineEventDialog.tsx",
    "src/ui/tabs/ComplianceTab.tsx",
    "src/ui/tabs/NotifyTab.tsx",
    "src/ui/tabs/BusinessExpensesTab.tsx",
    "src/ui/tabs/DisplaysTab.tsx",
    "src/ui/tabs/JobsTab.tsx",
    "src/ui/tabs/PaymentsTab.tsx",
    "src/ui/tabs/PreviewRoutesTab.tsx",
    "src/ui/tabs/PromotionsTab.tsx",
    "src/ui/tabs/ServicesTab.tsx",
    "src/ui/tabs/SettingsTab.tsx",
    "src/ui/tabs/UsersTab.tsx",
    "src/ui/tabs/VanityUrlsTab.tsx",
    "src/ui/tabs/WorkdaysTab.tsx",
    "src/ui/workflows/PlanWorkdayWorkflow.tsx",
];

function routeEntitlements(): Map<string, string> {
  const map = new Map<string, string>();
  let group: string | null = null;
  for (const line of fs.readFileSync(ROUTE_MAP, "utf8").split("\n")) {
    // CASE-INSENSITIVE, and that matters. Anchored on `[a-z]` this skipped
    // the four UPPERCASE buckets, so `group` stayed on the last lowercase
    // entitlement and all 143 OWNERSHIP / CLIENT-PORTAL / PUBLIC / SYSTEM
    // routes were attributed to `work.complete` — which has three. Every
    // file calling `/me/...` was then reported as mutating behind a
    // capability it never named, and the PENDING list below was inflated
    // with entries that were never real.
    const h = line.match(/^## ([A-Za-z][A-Za-z.\- ]*?)\s+\((\d+)\)/);
    if (h) { group = h[1].trim(); continue; }
    const r = line.match(/^\|\s*`(GET|POST|PATCH|PUT|DELETE)`\s*\|\s*`([^`]+)`/);
    if (r && group) map.set(`${r[1]} ${r[2].replace(/:[A-Za-z0-9_]+/g, ":x")}`, group);
  }
  return map;
}

function webFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
  };
  walk(path.join(WEB, "src"));
  out.push(path.join(WEB, "pages/index.tsx"));
  return out;
}

/** file (web-relative) → the entitlements it mutates behind but never names. */
function offenders(): Map<string, string[]> {
  const routes = routeEntitlements();
  const VERB: Record<string, string> = { Post: "POST", Patch: "PATCH", Delete: "DELETE", Put: "PUT" };
  const result = new Map<string, string[]>();
  for (const file of webFiles()) {
    const src = fs.readFileSync(file, "utf8");
    const needed = new Set<string>();
    for (const m of src.matchAll(/api(Post|Patch|Delete|Put)[^(]*\(\s*`?\/api\/([A-Za-z0-9/:${}._-]+)/g)) {
      const p = "/" + m[2].split("?")[0].replace(/\$\{[^}]*\}/g, ":x").replace(/\/$/, "");
      const ent = routes.get(`${VERB[m[1]]} ${p}`);
      if (ent && !NOT_AN_ENTITLEMENT.has(ent)) needed.add(ent);
    }
    const missing = [...needed].filter((e) => !src.includes(`"${e}"`));
    if (missing.length) {
      result.set(path.relative(WEB, file), missing.sort());
    }
  }
  return result;
}

describe("G15 — the UI asks for what it mutates", () => {
  it("finds the mutations at all", () => {
    // A scan that resolves nothing passes vacuously. If the route map's
    // format changes, or the api helpers are renamed, this is what says so
    // rather than the gate quietly going green.
    const routes = routeEntitlements();
    expect(routes.size, "route map parsed to nothing — the format changed")
      .toBeGreaterThan(500);
  });

  it("no file mutates behind a capability it never names, outside PENDING", () => {
    const found = [...offenders().keys()].sort();
    const unexpected = found.filter((f) => !PENDING.includes(f));
    expect(
      unexpected,
      "new code mutating behind a capability it never asks for — add the " +
        "scope.can() check rather than an entry to PENDING",
    ).toEqual([]);
  });

  it("PENDING only shrinks", () => {
    const found = new Set(offenders().keys());
    const fixed = PENDING.filter((f) => !found.has(f));
    expect(
      fixed,
      "these now ask for the capability — delete them from PENDING so the " +
        "list keeps meaning something",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// G46 — a TAB asks for the capability it READS behind.
//
// G15 above covers mutations. It stops at them deliberately — a write is
// where damage lives — and that left the more common failure uncovered: a
// GET that fires the moment a tab opens, needing a capability the tab's own
// gate does not imply.
//
// A refused write tells somebody. A refused read does not. Seven of these
// were found between 2026-10-19 and 2026-10-22 and every one failed
// silently — a `catch {}` that left a panel at zero, a picker with nobody
// in it, a receipt search that looked like it found nothing. One was worse:
// `/holdings` sat in a Promise.all with no catch, so the 403 rejected the
// whole load and the Users tab rendered "Failed to load users" for anyone
// holding `people.view` without `equipment.view`.
//
// THE RULE, same shape as G15: a tab file that GETs a guarded route must
// name that entitlement somewhere, unless the tab's own TAB_REQUIREMENTS
// row already demands it. Naming it is not proof the call is gated
// correctly — that is not statically decidable — but a file that never
// says the word is relying on where it happens to be mounted.
//
// PENDING IS SHRINK-ONLY, and these entries are NOT live bugs: in each one
// the tab's gate happens to imply the endpoint for every role that exists
// today. That is a property of the roles currently in the database, not of
// the code — an operator can build a role in the Roles tab that breaks any
// of them, and then the read fails silently like the other seven.
const PENDING_READS: readonly string[] = [
  "HistoryTab.tsx GET /users",
  "JobsTab.tsx GET /occurrences/:x/comments",
  "JobsTab.tsx GET /occurrences/:x/photos",
  "PromotionsTab.tsx GET /promotions/:x/audit",
  "PropertiesTab.tsx GET /jobs",
  "ServicesTab.tsx GET /occurrences/:x/comments",
];

/** tab component file → the tab id it is registered under in index.tsx. */
function tabIdByFile(): Map<string, string> {
  const idx = fs.readFileSync(path.join(WEB, "pages/index.tsx"), "utf8");
  const out = new Map<string, string>();
  for (const m of idx.matchAll(/value:\s*"([A-Za-z][A-Za-z0-9-]*)",[\s\S]{0,600}?<([A-Z]\w*Tab)\b/g)) {
    if (!out.has(m[2] + ".tsx")) out.set(m[2] + ".tsx", m[1]);
  }
  return out;
}

/** tab id → the entitlements that open it. ALWAYS means "no capability". */
function tabRequirements(): Map<string, string[]> {
  const src = fs.readFileSync(path.join(WEB, "src/lib/tabRequirements.ts"), "utf8");
  const body = src.slice(
    src.indexOf("export const TAB_REQUIREMENTS = {"),
    src.indexOf("} as const satisfies"),
  );
  const out = new Map<string, string[]>();
  for (const m of body.matchAll(/^\s{2}"?([A-Za-z][A-Za-z0-9-]*)"?:\s*(ALWAYS|\[[^\]]*\]),/gm)) {
    out.set(m[1], m[2] === "ALWAYS" ? [] : [...m[2].matchAll(/"([^"]+)"/g)].map((e) => e[1]));
  }
  return out;
}

/** "File.tsx GET /path" for every read a tab makes but never names. */
function unnamedReads(): string[] {
  const routes = routeEntitlements();
  const byFile = tabIdByFile();
  const reqs = tabRequirements();
  const found = new Set<string>();
  const dir = path.join(WEB, "src/ui/tabs");
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".tsx")) continue;
    const tab = byFile.get(name);
    if (!tab || !reqs.has(tab)) continue;
    const opens = reqs.get(tab)!;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    for (const m of src.matchAll(/apiGet[^(]*\(\s*`?\/api\/([A-Za-z0-9/:${}._-]+)/g)) {
      const p = "/" + m[1].split("?")[0].replace(/\$\{[^}]*\}/g, ":x").replace(/\/$/, "");
      const ent = routes.get(`GET ${p}`);
      if (!ent || NOT_AN_ENTITLEMENT.has(ent)) continue;
      if (opens.includes(ent)) continue;
      if (src.includes(`"${ent}"`)) continue;
      found.add(`${name} GET ${p}`);
    }
  }
  return [...found].sort();
}

describe("G46 — the UI asks for what it reads", () => {
  it("finds the reads at all", () => {
    // A parser that matches nothing passes every assertion below. The
    // tab files make hundreds of guarded reads between them.
    const routes = routeEntitlements();
    expect(routes.size, "the route map parsed to nothing").toBeGreaterThan(400);
    expect(tabIdByFile().size, "no tab files mapped to tab ids").toBeGreaterThan(20);
    expect(tabRequirements().size, "TAB_REQUIREMENTS parsed to nothing").toBeGreaterThan(20);
  });

  it("no tab reads behind a capability it never names, outside PENDING_READS", () => {
    const surprises = unnamedReads().filter((r) => !PENDING_READS.includes(r));
    expect(
      surprises,
      "a tab GETs a route guarded on a capability it never asks for. The " +
        "refusal will be invisible — an empty panel, a picker with nobody " +
        "in it, or a whole tab that fails to load. Ask `scope.can(...)` for " +
        "the capability the route is guarded on (docs/features/" +
        "permissions-ROUTE-MAP.md) and skip the call, rather than firing it " +
        "and swallowing the 403.",
    ).toEqual([]);
  });

  it("PENDING_READS only shrinks", () => {
    const live = unnamedReads();
    const stale = PENDING_READS.filter((r) => !live.includes(r));
    expect(
      stale,
      "these no longer read behind an unnamed capability — delete them from " +
        "PENDING_READS. A backlog with dead entries in it teaches people to " +
        "ignore the live ones.",
    ).toEqual([]);
  });
});
