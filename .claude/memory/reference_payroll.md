---
name: reference-payroll
description: "Payroll feature — Gusto CSV import, three-tier visibility, decoupled from the financial system; spec at docs/features/payroll.md"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-08-24T21:00:15.000Z
---

Money → Payroll. Imports a **Gusto Payroll Journal CSV** so workers can see
what they were actually paid. Shipped 2026-08-24.

**Canonical spec: `docs/features/payroll.md`** — read before touching any of
it. The visibility rules were signed off in writing before code existed.

## Visibility (server-side, never client filtering)

| Role | Whose rows | What |
|---|---|---|
| Worker | own only | full detail incl. every tax line (own pay stub) |
| Admin | any worker | **hours / gross / net / check only** |
| Super | any worker | full detail + unmatched rows + all mutations |

The admin restriction is applied when BUILDING the payload — tax fields are
absent from the response, not hidden with CSS.

## Things that bit during the build

- **Rate columns are NOT additive.** `Regular (Rate)` shows 7.25 in the
  totals row when two workers are both at 7.25 — not 14.50. Summing it
  rejects every legitimate upload. Columns carry an `additive` flag.
- **Blank ≠ zero.** `""` → null, `"0.00"` → 0. Preserved end-to-end and
  visible in the UI ("—" vs "$0.00"). Collapsing them makes "did we owe
  FUTA?" unanswerable.
- **Natural key is `(periodStart, periodEnd)` — payDay EXCLUDED.** Otherwise
  re-uploading to fix a wrong pay day creates a second period for the week.
- **Names are never auto-matched.** The CSV has no employee identifier; a
  Super confirms once via `PayrollIdentity` and it back-fills history.
- State tax column names are jurisdiction-specific (`NC State Tax
  (Employee)`) — matched by pattern, and every row keeps a verbatim `raw` Json.
- `sourceKind` discriminator exists for future 1099 contractor imports
  (different Gusto report, different shape). Parser is a named adapter.

## Testing

`payrollImport.test.ts` (36) + `payroll-build-gate.test.ts` (24) in the API
build gate. Browser: `payroll-worker.spec.ts` (employee),
`adminrole-payroll.spec.ts`, `payroll-admin.spec.ts` (super).

**New Playwright project `admin-role`** (storageState `admin.json`, specs
prefixed `adminrole-`). It exists because SUPER outranks ADMIN — an
admin-only restriction is invisible from a `super` session, so testing it
there would pass while proving nothing.

## Hard rules

- **Decoupled from the financial system** — no Expense, no P&L, no tax
  export, not even `employerCost`. See
  [[feedback-payroll-estimate-actual-firewall]].
- Re-upload is the ONLY edit path; individual values are not hand-editable.
- Delete is soft (`archivedAt`), Super only, snapshots before hiding.
- No "next pay day" anywhere — uploads are manual, so it would be inferred
  and wrong the first time a schedule changes.
