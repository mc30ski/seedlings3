---
name: reference-worker-class
description: Pay class is decided in packages/money/workerClass.ts and never by negation; TRAINEE is gone, UNPAID exists, and !isW2 is a build failure.
metadata:
  type: reference
---

**Worker type is a TAX fact, never a permission.** `EMPLOYEE | CONTRACTOR |
UNPAID`. TRAINEE was removed — it was a worker type standing in for a
permission, so a trainee is now an EMPLOYEE without the Field Clearance role.
See [[reference-financial-system-doc]] §1 and [[reference-claimer-invariant]].

Everything routes through `packages/money/workerClass.ts`:

- `classify(wt)` → `"w2" | "contractor" | "unpaid" | "unclassified"`, an
  exhaustive switch whose `never` check makes a fourth type a compile error.
- `isW2` / `isFeeable` / `isPaid` / `isUnpaid` — all POSITIVE.
- `rateFor(wt, rates)` **throws** for unpaid and unclassified. A payout must
  refuse rather than guess; a wrong figure on a 1099 is not recoverable.
- `rateForProjection(wt, rates)` returns **0** for those. A dashboard must
  still render.
- `WORKER_TYPES` / `isWorkerType` for validation — never a hand-written chain.

**`!isW2(x)` is forbidden and G30 fails the build on it.** It reads as
"therefore a contractor" but is false for UNPAID and for an untyped worker
too, so both land in the fee branch. That single shape:

- charged an unclassified worker a contractor fee on **every split**
- listed them in **QuickBooks Contract Labor** (a tax line)
- swept them into the **employer payroll-tax base** via the forecast's
  trailing `else`
- showed an unpaid helper being **charged a 20% commission** in the
  AcceptPayment dialog

G30 lives in `payments-build-gate.test.ts`, scoped to a roster of files where
a worker-class decision moves money — a draft that scanned everything flagged
40 badge palettes, and a noisy gate gets switched off. Three checks: the
negation, a `workerType === "..."` string comparison, and a `? fee : margin`
rate ternary (there were **five** separate copies of the rate rule).

**Widened 2026-10-25, and both halves mattered.** The roster held the services
and two dialogs, so the TABS that render pay were never scanned; and the
negation regex required a call, so it caught `!isW2(x)` but walked past
`const isEmployeeClass = isW2(wt)` followed by `!isEmployeeClass &&` — the
same decision with no parenthesis. Adding the tabs plus a `\b` match found
six lines: two contractor notices and two `contingent:` flags in PaymentsTab,
and two `workerType === "CONTRACTOR"` comparisons in PayrollTab. A SKIP
(`if (!isFeeable(x)) continue`) is not this bug — it excludes a class rather
than relabelling it — and takes a `worker-class-allow:` marker.

Watch for gates that codify the banned shape: `job-materials-build-gate` was
REQUIRING `workerType === "CONTRACTOR"` in those same explainers, so fixing
the code turned that gate red. It now requires `isFeeable(`.

Exemption is per-line: `// worker-class-allow: <reason>`. The real one is the
legacy re-derivation path in `payments.ts` — those rows were PRICED by the old
rule, so the reader must reproduce it or it disagrees with the number it is
dividing up.
