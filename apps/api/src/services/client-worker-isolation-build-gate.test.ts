// ─────────────────────────────────────────────────────────────────────────────
// A LIST OF THE TEAM MUST NOT CONTAIN A CUSTOMER.
//
// WHAT THIS EXISTS FOR
// A customer's login is an ordinary `User` row with no `workerType` — that
// is the whole design: `can()` returns false for a null worker type before
// it walks any role, so the payroll gate, not a client flag, is what keeps a
// customer out of the staff app. The cost of that design is that `GET
// /users` returns customers and staff in one list, and every caller has to
// say which it wants.
//
// Six of them thought they had. They passed a `?role=` parameter naming a
// value of the DELETED role enum. The route stopped reading `role` when
// the enum went and never objected, so the filter became a no-op and the
// callers were handed every customer login:
//
//   · the pay-per-hour cards        — customers rendered as team members
//   · the crew picker               — a customer could be added to a visit
//   · the default-crew picker       — and would then recur on every visit
//   · the estimate picker
//   · both compliance pickers       — policies assigned to customers
//
// It survived because the response still looked like a list of people. The
// screen that finally exposed it was a dashboard card showing twenty
// customers with a blank hourly rate.
//
// THE RULES
//   1. `role=` and `includeInactive=` are dead parameters. Nothing may send
//      them, and the route rejects them rather than ignoring them.
//      (`role` named the deleted enum; `includeInactive` never existed.)
//   2. Every `/api/users` call in the web says which population it wants.
//   3. `hasWorkerType` must actually filter, so it cannot rot into a
//      no-op the way `role` did.
//
// WIRED VIA `test:build-gate` in package.json.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const WEB = path.join(REPO, "apps/web");
const API_SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const WEB_FILES = [
  ...walk(path.join(WEB, "src")),
  ...walk(path.join(WEB, "pages")),
];

/** Every `/api/users...` URL literal the web sends, with where it came from. */
function userCalls(): Array<{ file: string; line: number; url: string }> {
  const out: Array<{ file: string; line: number; url: string }> = [];
  for (const f of WEB_FILES) {
    fs.readFileSync(f, "utf8").split("\n").forEach((text, i) => {
      const t = text.trim();
      if (t.startsWith("//") || t.startsWith("*")) return;
      for (const m of text.matchAll(/["'`](\/api\/users[^"'`]*)["'`]/g)) {
        out.push({ file: path.relative(WEB, f), line: i + 1, url: m[1] });
      }
    });
  }
  return out;
}

/**
 * Calls that deliberately want EVERY login, customers included, and label
 * them on screen. Add to this only for a view that shows the difference —
 * never to silence a picker.
 */
const SHOWS_EVERYONE = new Set([
  // The Roles → People view: lists all logins, badges a customer-only one
  // as "Customer", hides them behind a toggle, and counts only staff as
  // "holding no role".
  "src/ui/tabs/RolesTab.tsx",
  // The people directory itself. It MUST see customer logins — approving a
  // sign-up and linking it to a client record both happen here — and it
  // separates them into their own section via `isCustomerOnly`.
  "src/ui/tabs/UsersTab.tsx",
  // Not a picker: an id -> email map for labelling audit actors, and a
  // customer who files a reschedule request IS an actor.
  "src/ui/tabs/HistoryTab.tsx",
]);

describe("[build-gate] clients stay out of staff lists", () => {
  it("reads a meaningful number of web files", () => {
    // A walk that silently returns nothing would pass every check below.
    expect(WEB_FILES.length).toBeGreaterThan(100);
    expect(userCalls().length).toBeGreaterThan(3);
  });

  it("nothing sends a filter the route does not read", () => {
    // `role=` named the deleted enum; `includeInactive=` was never a
    // parameter either. Both were accepted in silence and returned
    // everybody. A filter that does nothing is worse than no filter: the
    // caller stops thinking about it.
    const offenders = userCalls()
      .filter((c) => /[?&](role|includeInactive)=/.test(c.url))
      .map((c) => `${c.file}:${c.line}  ${c.url}`);
    expect(
      offenders,
      "`role` and `includeInactive` are not parameters of GET /users. Use " +
        "`hasWorkerType=true` to exclude customer logins, `roleKey=<key>` " +
        "for holders of one role, or GET /workers for who may be given work.",
    ).toEqual([]);
  });

  it("every /api/users call says which population it wants", () => {
    const offenders = userCalls()
      .filter((c) => !SHOWS_EVERYONE.has(c.file))
      // `approved=false` is the pending sign-up queue — nobody has a worker
      // type yet, so staff-filtering it would empty it.
      .filter((c) => !/[?&]approved=false/.test(c.url))
      // `roleKey=` already narrows to holders of a role, and a customer
      // holding one is the documented "customer who also works for you".
      .filter((c) => !/[?&]roleKey=/.test(c.url))
      .filter((c) => !/[?&]hasWorkerType=true/.test(c.url))
      // A call to one person by id is not a population.
      .filter((c) => !/\/api\/users\/[^?]/.test(c.url))
      .map((c) => `${c.file}:${c.line}  ${c.url}`);
    expect(
      offenders,
      "GET /users returns customers too — a customer's login is a User row " +
        "with no worker type. Add `hasWorkerType=true`, or use GET /workers.",
    ).toEqual([]);
  });

  it("the route REFUSES the dead parameter rather than ignoring it", () => {
    const src = fs.readFileSync(path.join(API_SRC, "routes", "people.ts"), "utf8");
    expect(src, "GET /users must reject `role` loudly").toMatch(
      /if \(q\.role !== undefined\)[\s\S]{0,200}badRequest/,
    );
  });

  it("`hasWorkerType` actually filters, so it cannot rot into a no-op", () => {
    // This is the lesson from `role=`: the parameter outlived the code that
    // honoured it. If this assertion ever fails, `hasWorkerType=true` has
    // become decoration and every picker above is quietly wrong again.
    const src = fs.readFileSync(path.join(API_SRC, "services", "users.ts"), "utf8");
    expect(src).toMatch(/params\?\.hasWorkerType[\s\S]{0,120}workerType = \{ not: null \}/);
  });

  it("nobody decides who is a customer by role absence", () => {
    // THE RULE THIS REPLACES SHIPPED. `UsersTab` had:
    //
    //     const isClientUser = (u) => u.isApproved && !holdsAnyRole(u);
    //
    // "holds nothing, therefore a customer" — which is true of every new
    // hire on their first day. They were filed under Clients, and the tab
    // hides role controls for a client, so the screen that grants a first
    // role would not grant one to the people who had none. Four accounts
    // in production were stuck there, and the fix for each was a script.
    //
    // The boundary is the payroll gate, and it lives in lib/people.ts.
    const helper = path.join(WEB, "src/lib/people.ts");
    expect(fs.existsSync(helper), "the shared customer/staff rule is gone").toBe(true);
    expect(fs.readFileSync(helper, "utf8")).toMatch(
      /export function isCustomerOnly[\s\S]{0,200}!!u\.isClientContact && !u\.workerType/,
    );

    // A "client/customer" decision derived from whether someone holds a
    // role, anywhere in the web.
    const RE = /\b(isClient|isCustomer|client|customer)\w*\s*=\s*[^;\n]*!\s*(holdsAnyRole|hasRole)\b/i;
    const offenders: string[] = [];
    for (const f of WEB_FILES) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (RE.test(line)) offenders.push(`${path.relative(WEB, f)}:${i + 1}  ${t.slice(0, 80)}`);
      });
    }
    expect(
      offenders,
      "Role absence is not the customer test — a new hire holds nothing. " +
        "Use `isCustomerOnly` from lib/people.ts (no worker type AND an " +
        "active client contact).",
    ).toEqual([]);
  });

  it("GET /workers still filters on the capability, not a worker type", () => {
    // The other half of the boundary. `work.claim` excludes a customer by
    // construction, because `can()` refuses a null worker type before it
    // reads a role — so this list cannot contain one without the payroll
    // gate itself breaking.
    const src = fs.readFileSync(path.join(API_SRC, "routes", "people.ts"), "utf8");
    const route = src.slice(src.indexOf('app.get("/workers"'));
    const body = route.slice(0, route.indexOf("app.get(", 1));
    expect(body).toMatch(/work\.claim/);
  });
});
