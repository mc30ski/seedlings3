---
name: feedback-payroll-estimate-actual-firewall
description: "NEVER connect imported Gusto payroll (ground truth) to the P&L's estimated employer payroll tax — user directive, enforced by a build gate"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-08-24T20:59:55.729Z
---

The app has **two** payroll-tax numbers and they must never be wired together:

- **Estimate** — `apps/api/src/services/payrollTaxEstimates.ts` holds
  operator-tunable percentages (SS 6.2 / Medicare 1.45 / FUTA 0.6 / SUTA 1.5),
  surfaced by `services/pnlReport.ts` as the synthetic
  `"Payroll:Employer payroll taxes (est.)"` line on Reconcile's P&L.
- **Ground truth** — the Payroll feature imports Gusto's actual
  `socialSecurityEmployer`, `medicareEmployer`, `futaEmployer`,
  `stateUnemploymentEmployer`, `employerCost`. See [[reference-payroll]].

User's words when this was surfaced (2026-08-24): *"Absolutely do not connect
them. One is an estimate. The other is ground truth. I don't want them
intertangled as that will cause problems over time."*

**Why:** entangling them makes every future question about a P&L number start
with "is this a period where payroll happened to be uploaded?" — and the
answer changes retroactively as periods are imported, replaced, or archived.
A number that silently changes meaning based on unrelated upload activity is
worse than one that is consistently an estimate.

**How to apply:** payroll modules must not import `pnlReport` or
`payrollTaxEstimates`, and neither may reference `PayrollEntry` /
`PayrollPeriod`. `payroll-build-gate.test.ts` asserts this bidirectionally and
also pins the `(est.)` suffix on the P&L line. If actuals should ever appear
on an operator's P&L, that is a **new separately-labelled line** — never a
substitution into the existing one.

Related: Reconcile also has a **"Worker Payroll"** card that shows Gusto-copy
fields the operator types INTO Gusto. That is the outbound leg; the Payroll
tab is the return leg. Complementary, no shared code — don't merge them either.
