// ─────────────────────────────────────────────────────────────────────────────
// Alert ordering build gate
//
// PURPOSE
// The operator's pending work is listed in TWO places: the header alerts
// dropdown (`apps/web/pages/index.tsx`) and the Tasks page
// (`apps/web/src/ui/pages/TasksPage.tsx`). They are separate files with
// separate hand-maintained lists, and TasksPage carried a comment claiming
// "Section order mirrors the alerts dropdown's push order".
//
// On 2026-08-26 the user asked why the two orders differed. They did:
// FOUR entries were in different positions ("Documents to sign", "Paused
// repeating to review", "Announcements", "Payroll names to match"), and
// one Tasks section ("Unlinked client accounts") had no dropdown alert at
// all — so an operator who never opened Tasks had no signal for it.
//
// The comment had been wrong for a long time. Nothing checked it, so it
// rotted quietly. That is the actual failure mode this gate addresses: a
// claimed invariant with no enforcement is just a comment.
//
// WHAT THIS GATE REQUIRES
//   1. Every dropdown alert has a Tasks counterpart, and vice versa.
//   2. Both appear in the SAME relative order.
//   3. The one sanctioned one-to-many mapping ("Payments to review" ->
//      two Tasks sections) is declared here explicitly, so adding a
//      second such split is a deliberate edit to this file rather than a
//      silent divergence.
//
// This is a pure source-parse: no DOM, no server. It cannot prove the
// rendered order matches (role gates decide what each viewer sees), but
// order is positional in both files, so parsing is enough to catch drift.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");

const DROPDOWN_SRC = readFileSync(join(REPO_ROOT, "apps/web/pages/index.tsx"), "utf8");
const TASKS_SRC = readFileSync(
  join(REPO_ROOT, "apps/web/src/ui/pages/TasksPage.tsx"),
  "utf8",
);

/**
 * Dropdown label -> the Tasks label(s) that cover it, in order.
 *
 * Labels differ by design: the dropdown is a terse one-line row ("Overdue")
 * while a Tasks card has room to say what it is ("Overdue jobs"). Mapping
 * them explicitly is better than loose matching — a renamed label should
 * fail LOUDLY here rather than quietly stop being checked.
 *
 * "Payments to review" is the ONLY one-to-many entry: the dropdown rolls
 * pending approvals and outstanding invoices into one row that routes to a
 * single tab, while the Tasks page has room to show both inline. Adding
 * another split means editing this table on purpose.
 */
const ALERT_TO_TASKS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Overdue", ["Overdue jobs"]],
  ["Pending Users", ["User sign-ups awaiting approval"]],
  ["Payments to review", ["Pending payment approvals", "Outstanding client invoices"]],
  ["Workdays / mileage to review", ["Workdays to approve"]],
  ["Ledger followups", ["Ledger follow-ups"]],
  ["Due to record", ["Due to record"]],
  ["Paused repeating to review", ["Paused repeating to review"]],
  ["Next visits expiring", ["Next visits expiring"]],
  ["Next visits expired", ["Next visits expired"]],
  ["Compliance uploads to review", ["Compliance uploads to review"]],
  ["Policy versions awaiting approval", ["Policy versions awaiting approval"]],
  ["Documents to sign", ["Documents to sign"]],
  ["Client requests", ["Client change requests"]],
  ["Unlinked client accounts", ["Unlinked client accounts"]],
  ["Estimate follow-ups", ["Estimate follow-ups"]],
  ["Payroll names to match", ["Payroll names to match"]],
  ["Guides awaiting approval", ["Guides awaiting approval"]],
  ["Job hours awaiting review", ["Job hours awaiting payroll review"]],
  ["Unclaimed", ["Unclaimed jobs"]],
  ["Announcements", ["Announcements"]],
  ["Timeline", ["Timeline"]],
] as const;

/** Labels in `alerts.push({...})` order, including multi-line pushes. */
function dropdownOrder(): string[] {
  const start = DROPDOWN_SRC.indexOf("const alerts: { label: string; count: number");
  const end = DROPDOWN_SRC.indexOf("if (alerts.length === 0) return null;", start);
  expect(start, "could not locate the alerts array in pages/index.tsx").toBeGreaterThan(-1);
  expect(end, "could not locate the end of the alerts array").toBeGreaterThan(start);
  const segment = DROPDOWN_SRC.slice(start, end);

  const labels: string[] = [];
  const pushRe = /alerts\.push\(/g;
  let m: RegExpExecArray | null;
  while ((m = pushRe.exec(segment))) {
    // The label may be on the same line or well down the object literal —
    // the workdays entry carries a six-line comment before its `label:`,
    // which sat 478 chars in and only just fit an earlier 500-char window.
    const lm = /label:\s*"([^"]+)"/.exec(segment.slice(m.index, m.index + 2000));
    // A push with no findable label becomes a sentinel rather than being
    // skipped. Skipping is how a parser quietly stops covering an entry —
    // the gate would go green while checking one fewer alert than exists.
    labels.push(lm ? lm[1] : "<<unparseable alerts.push>>");
  }
  return labels;
}

/**
 * Card labels in render order, from the section list only.
 *
 * Anchored to the CARD ELEMENT, not to a bare `label=` — the "Goto Task"
 * icon button inside each card also carries a `label` prop, and matching
 * loosely swept those in as phantom sections.
 */
function tasksOrder(): string[] {
  const start = TASKS_SRC.indexOf("Section order mirrors");
  expect(start, "could not locate the Tasks section list").toBeGreaterThan(-1);
  const segment = TASKS_SRC.slice(start);
  return [...segment.matchAll(/<(?:ShortcutCard|CollapsibleSectionCard)\b[\s\S]{0,300}?label="([^"]+)"/g)].map(
    (m) => m[1],
  );
}

describe("alert ordering build gate", () => {
  it("the dropdown's alert list is parseable and non-trivial", () => {
    // A parse that silently returns [] would make every assertion below
    // vacuously pass — the exact way this class of gate goes green while
    // checking nothing.
    const dd = dropdownOrder();
    const tk = tasksOrder();
    expect(dd.length).toBeGreaterThanOrEqual(10);
    expect(tk.length).toBeGreaterThanOrEqual(10);
    expect(
      dd.filter((l) => l.startsWith("<<")),
      "an alerts.push had no parseable label — widen the lookahead window",
    ).toEqual([]);
  });

  // NOTE ON WHAT THESE COMPARE AGAINST.
  //
  // Both directions check the parsed source of the OTHER file, not just
  // membership in ALERT_TO_TASKS. An earlier draft compared each file only
  // to the table, and a mutation test caught it: deleting the "Unlinked
  // client accounts" push from the dropdown left the table and the Tasks
  // section untouched, so the gate stayed green — while reintroducing the
  // exact bug it was written for. The table declares INTENT; both files
  // have to actually contain their side of it.

  it("every dropdown alert has a Tasks counterpart that really exists", () => {
    const mapping = new Map(ALERT_TO_TASKS.map(([a, t]) => [a, t]));
    const tasks = new Set(tasksOrder());
    for (const label of dropdownOrder()) {
      const counterparts = mapping.get(label);
      expect(
        counterparts,
        `dropdown alert "${label}" has no entry in ALERT_TO_TASKS — add the ` +
          "matching Tasks section, or declare the mapping here on purpose",
      ).toBeDefined();
      for (const t of counterparts ?? []) {
        expect(
          tasks.has(t),
          `dropdown alert "${label}" maps to Tasks section "${t}", which is ` +
            "not in TasksPage — the operator sees the alert but Tasks has " +
            "nowhere to act on it",
        ).toBe(true);
      }
    }
  });

  it("every Tasks section has a dropdown alert that really exists", () => {
    // The direction that actually broke: "Unlinked client accounts" was a
    // Tasks section with no alert, so it was invisible to an operator who
    // never opened Tasks.
    const owner = new Map<string, string>();
    for (const [alert, tasks] of ALERT_TO_TASKS) {
      for (const t of tasks) owner.set(t, alert);
    }
    const dropdown = new Set(dropdownOrder());
    for (const label of tasksOrder()) {
      const alert = owner.get(label);
      expect(
        alert,
        `Tasks section "${label}" has no dropdown alert — an operator who ` +
          "never opens Tasks would get no signal for it",
      ).toBeDefined();
      expect(
        dropdown.has(alert!),
        `Tasks section "${label}" claims dropdown alert "${alert}", but no ` +
          "such alerts.push exists in pages/index.tsx",
      ).toBe(true);
    }
  });

  it("both surfaces list their entries in the SAME order", () => {
    const expectedDropdown = ALERT_TO_TASKS.map(([a]) => a);
    const expectedTasks = ALERT_TO_TASKS.flatMap(([, t]) => t);

    // Compare only the entries actually present in each file, so adding a
    // new alert fails the membership tests above with a clear message
    // rather than producing a confusing order diff here.
    const actualDropdown = dropdownOrder().filter((l) => expectedDropdown.includes(l));
    const actualTasks = tasksOrder().filter((l) => expectedTasks.includes(l));

    expect(
      actualDropdown,
      "the alerts dropdown is out of canonical order — see ALERT_TO_TASKS",
    ).toEqual(expectedDropdown.filter((l) => actualDropdown.includes(l)));

    expect(
      actualTasks,
      "the Tasks page is out of canonical order — it must follow the same " +
        "sequence as the alerts dropdown",
    ).toEqual(expectedTasks.filter((l) => actualTasks.includes(l)));
  });

  it("only ONE dropdown alert maps to multiple Tasks sections", () => {
    // The split exists because the dropdown row routes to a single tab
    // while Tasks has room to show both queues inline. It is a deliberate
    // exception; a second one should be a conscious edit, not drift.
    const splits = ALERT_TO_TASKS.filter(([, t]) => t.length > 1);
    expect(splits.map(([a]) => a)).toEqual(["Payments to review"]);
  });
});
