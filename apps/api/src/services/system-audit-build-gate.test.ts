// ─────────────────────────────────────────────────────────────────────────────
// System Audit build gate
//
// PURPOSE
// The audit's check registry lives in TWO PLACES and nothing joined them:
//
//   apps/web/src/ui/tabs/AuditTab.tsx   AUDIT_CHECKS — id, label, description,
//                                       severity. Severity is CLIENT-ONLY; the
//                                       server never sends one.
//   apps/api/src/routes/admin.ts        POST /admin/system-audit — a chain of
//                                       `if (checks.includes("<id>"))` blocks,
//                                       each pushing { check, label, issues }.
//
// WHY THAT IS DANGEROUS HERE SPECIFICALLY
// The client sends the ticked ids and renders a card per RETURNED result. So a
// check the server does not handle returns nothing, renders nothing, and the
// operator sees no card at all — which is indistinguishable from "this check
// found no problems". In an audit tool, a drifted id does not look like a bug.
// It looks like a clean bill of health.
//
// The mirror case is quieter but real: a result whose id the client does not
// know falls back to "issue" severity, so a warning renders as an Issue.
//
// Three separate bugs in one session came from a value stored in two places
// that drifted, or a lookup that quietly matched nothing. This is that shape.
//
// WHAT THIS GATE REQUIRES
//   1. Every client check id is handled by the route.
//   2. Every id the route handles is declared on the client.
//   3. The label is identical on both sides (it is duplicated, not derived).
//   4. Every severity is one of the three the renderer knows how to draw.
//   5. The tax-category check keeps the properties that make it correct.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const TAB_SRC = readFileSync(
  join(REPO_ROOT, "apps/web/src/ui/tabs/AuditTab.tsx"),
  "utf8",
);
const ROUTE_SRC = readFileSync(
  join(REPO_ROOT, "apps/api/src/routes/admin.ts"),
  "utf8",
);

/** The AUDIT_CHECKS array body, so the scan can't stray into other code. */
function registryBody(): string {
  const start = TAB_SRC.indexOf("const AUDIT_CHECKS");
  expect(start, "AUDIT_CHECKS must exist on the client").toBeGreaterThan(-1);
  const end = TAB_SRC.indexOf("\n];", start);
  expect(end, "AUDIT_CHECKS must be a closed array literal").toBeGreaterThan(start);
  return TAB_SRC.slice(start, end);
}

/** Client-declared checks, in registry order. */
function clientChecks(): Array<{ id: string; label: string; severity: string }> {
  const body = registryBody();
  const out: Array<{ id: string; label: string; severity: string }> = [];
  const re = /id:\s*"([a-z0-9_]+)"\s*,\s*\n\s*label:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?severity:\s*"([a-z]+)"/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    out.push({ id: m[1], label: m[2], severity: m[3] });
  }
  return out;
}

/** Ids the route actually branches on. */
function routeHandledIds(): string[] {
  const out: string[] = [];
  const re = /checks\.includes\("([a-z0-9_]+)"\)/g;
  for (let m = re.exec(ROUTE_SRC); m; m = re.exec(ROUTE_SRC)) out.push(m[1]);
  return [...new Set(out)];
}

/** { check, label } pairs the route pushes. Whitespace-normalised because the
 *  newer blocks wrap the object across lines. */
function routePushed(): Array<{ id: string; label: string }> {
  const flat = ROUTE_SRC.replace(/\s+/g, " ");
  const out: Array<{ id: string; label: string }> = [];
  const re = /check:\s*"([a-z0-9_]+)"\s*,\s*label:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(flat); m; m = re.exec(flat)) out.push({ id: m[1], label: m[2] });
  return out;
}

/** Just the tax-category block, so assertions about it can't pass by matching
 *  some other check's code further up the route. */
function taxCheckBlock(): string {
  const start = ROUTE_SRC.indexOf('checks.includes("unmapped_expense_tax_category")');
  expect(start, "the tax-category check must exist").toBeGreaterThan(-1);
  const end = ROUTE_SRC.indexOf("return { results };", start);
  expect(end).toBeGreaterThan(start);
  return ROUTE_SRC.slice(start, end);
}

describe("[build-gate] the System Audit registry cannot drift from the route", () => {
  it("parses a non-trivial registry from both sides", () => {
    // Guards the gate itself: a regex that silently matches nothing would make
    // every assertion below vacuously true.
    expect(clientChecks().length).toBeGreaterThanOrEqual(8);
    expect(routeHandledIds().length).toBeGreaterThanOrEqual(8);
    expect(routePushed().length).toBeGreaterThanOrEqual(8);
  });

  it("every client check is handled by the server", () => {
    // The failure this prevents: a ticked check returns no result, renders no
    // card, and reads to the operator as "nothing wrong here".
    const handled = new Set(routeHandledIds());
    for (const c of clientChecks()) {
      expect(handled.has(c.id), `check "${c.id}" is offered in the UI but the route never runs it`)
        .toBe(true);
    }
  });

  it("every server check is declared on the client", () => {
    // The mirror: an unknown id falls back to "issue" severity, so a warning
    // would render in the Issues band.
    const declared = new Set(clientChecks().map((c) => c.id));
    for (const id of routeHandledIds()) {
      expect(declared.has(id), `the route runs "${id}" but AUDIT_CHECKS does not declare it`)
        .toBe(true);
    }
  });

  it("every handled check actually pushes a result", () => {
    // A block that runs but never pushes produces the same invisible silence
    // as one that is missing entirely.
    const pushed = new Set(routePushed().map((p) => p.id));
    for (const id of routeHandledIds()) {
      expect(pushed.has(id), `"${id}" is handled but pushes no result`).toBe(true);
    }
  });

  it("the label is identical on both sides", () => {
    // It is duplicated rather than derived, so the two can disagree and the
    // card would be titled differently from the checkbox that ran it.
    const byId = new Map(clientChecks().map((c) => [c.id, c.label]));
    for (const p of routePushed()) {
      const clientLabel = byId.get(p.id);
      if (clientLabel === undefined) continue; // covered by the test above
      expect(p.label, `label mismatch for "${p.id}"`).toBe(clientLabel);
    }
  });

  it("every severity is one the renderer can draw", () => {
    for (const c of clientChecks()) {
      expect(["issue", "warning", "info"], `"${c.id}" has an unrenderable severity`)
        .toContain(c.severity);
    }
  });
});

describe("[build-gate] the tax-category audit check", () => {
  it("is registered as a WARNING", () => {
    const c = clientChecks().find((x) => x.id === "unmapped_expense_tax_category");
    expect(c, "the check must be registered").toBeTruthy();
    expect(c!.severity).toBe("warning");
    expect(c!.label).toBe("Expenses Without a Tax Category");
  });

  it("respects the Business Start Date cutoff", () => {
    // It is a money query. Without the cutoff it reports pre-business rows the
    // operator has deliberately hidden from every other surface — findings they
    // cannot act on and would not recognise.
    const block = taxCheckBlock();
    expect(block).toMatch(/resolveCutoff\(req\)/);
    expect(block).toMatch(/cutoffWhere\("BusinessExpense", cutoff\)/);
  });

  it("looks at real expenses only, not equity movements", () => {
    // CAPITAL_CONTRIBUTION and OWNER_DRAW have no Schedule C line by
    // definition; flagging them would be pure noise.
    expect(taxCheckBlock()).toMatch(/type: "EXPENSE"/);
  });

  it("keys on the SCHEDULE C LINE, which is what the tax export writes", () => {
    // "Mapped" has to mean the thing with the consequence. A category present
    // in the taxonomy but carrying no line still exports a blank column.
    const block = taxCheckBlock();
    expect(block).toMatch(/scheduleCLine\.trim\(\) !== ""/);
    expect(block).toMatch(/scheduleCLine\.trim\(\) === ""/);
  });

  it("does NOT flag a missing QuickBooks account", () => {
    // A null qbAccount is a SUPPORTED state with documented behaviour: the row
    // lands under "Unmapped" in the QB CSV and is re-categorised inside QB
    // after import. It is not a tax-mapping gap, and including it would bury
    // the real findings under rows working exactly as designed.
    expect(taxCheckBlock()).not.toMatch(/qbAccount/);
  });

  it("reports the EMPTY TAXONOMY as one finding instead of flagging every row", () => {
    // loadExpenseCategories swallows a parse error and returns [], so a
    // malformed EXPENSE_CATEGORIES setting would mark every expense unmapped —
    // hundreds of findings whose single real cause the flood would hide.
    const block = taxCheckBlock();
    expect(block).toMatch(/cats\.length === 0/);
    expect(block).toMatch(/empty or unreadable/);
    // And the per-row scan must be skipped in that case, not merely preceded by
    // a message: an `else` (or equivalent) has to gate the query.
    const emptyGuardAt = block.indexOf("cats.length === 0");
    const queryAt = block.indexOf("businessExpense.findMany");
    expect(queryAt, "the row query must come after the empty-taxonomy guard")
      .toBeGreaterThan(emptyGuardAt);
    expect(block.slice(emptyGuardAt, queryAt)).toMatch(/\}\s*else\s*\{/);
  });

  it("groups a whole missing category but lists uncategorised rows one by one", () => {
    // Different fixes. An unknown label is ONE Settings decision however many
    // rows carry it; a row with no category at all needs the operator to say
    // what it was, per row.
    const block = taxCheckBlock();
    expect(block).toMatch(/unknownLabels/);
    expect(block).toMatch(/no category set/);
    expect(block).toMatch(/not in the expense-category taxonomy/);
  });

  it("uses a canonical ET date helper for the row description", () => {
    // Same rule as everywhere else — see docs/DATE_HANDLING.md. The
    // date-handling gate would catch a raw slice, but asserting it here keeps
    // the reason attached to the code that needs it.
    expect(taxCheckBlock()).toMatch(/etFormatDate\(r\.date\)/);
  });
});
