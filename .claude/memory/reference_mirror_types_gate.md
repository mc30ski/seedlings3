---
name: reference-mirror-types-gate
description: "Hand-maintained web↔API mirror types are compared field-for-field by mirror-types-build-gate.test.ts — the layer UNDER the date helpers, where a silently drifted copy defeats every downstream guard."
metadata:
  type: reference
---

Several `apps/web/src/lib/*.ts` modules are hand-written copies of an API
service's types and say so in a comment:

```ts
// Worker-workday client types — mirror services/workdays.ts exactly.
// Payroll client — mirrors apps/api/src/services/payroll.ts.
```

**Nothing checked that claim until 2026-11-13.** The copy drifts silently,
and the drift is invisible because *both sides compile* — they are separate
declarations that never meet.

## Why this is the layer that matters

The workday off-by-one ([[reference_date_handling]] rule 31) got past every
guard built for date bugs, because all of them sit DOWNSTREAM of the copy:

- the canonical helpers — all four callsites used them;
- the 31 forbidden-pattern rules — nothing raw was written;
- the `EtDateKey` brand — the web mirror **opted out** by typing the field
  `string`.

The schema said `workdayDate String // YYYY-MM-DD in ET`. The mirror said
`string`. A comment in between asserted it was an ISO datetime, and the code
believed the comment.

## The gate

`apps/api/src/services/mirror-types-build-gate.test.ts`. Finds web lib files
declaring a mirror, parses `export type X = { … }` on both sides, compares
top-level fields as normalised text.

- **Measured before building**: 5 pairs, 11 shared types, **1 difference** —
  an alias indirection. One signal, no noise. It then found the workday
  asymmetry the same hour.
- `REQUIRED_MIRRORS` names each mirror and its target. **A count floor was
  the first version and it leaked**: rewording one comment dropped that pair
  and four others still cleared a floor of four. Naming them also catches a
  repointed or renamed mirror.
- `EQUIVALENT` holds declared same-meaning spellings, keyed `Type.field`,
  with the **exact text required on both sides** — so the allowance rots
  loudly. A third test fails any entry that no longer describes a real
  difference.
- **Limits, stated**: top-level fields only, textual comparison, no alias
  resolution or generic expansion. A tripwire for drift, not a proof of
  equivalence.
- Registered in the `test:build-gate` filter list (a dead entry shrinks the
  run silently — see [[reference_build_gates_roster]]).

8 mutations, all caught: un-branding a field, dropping one, narrowing one,
rewording the comment, repointing the mirror, renaming a shared type, and
widening the equivalence into a blanket excuse.

## The LOGIC mirrors — audited 2026-11-13, not gated

Seven `.tsx`/`.ts` files mirror server LOGIC rather than types. A
text-comparison gate cannot reach them (two idioms for one rule), so they
were audited by hand instead:

| Mirror | Verdict |
|---|---|
| `ReconcileTab.payrollTypeLabelClient` | identical |
| `PromotionsTab.smsInfo` | identical arithmetic **and** char-for-char identical GSM7 charsets |
| `JobsTab.utils.assigneeIsClaimer` | identical rule to `updateOccurrenceStatus`'s NOT_CLAIMER check |
| `receiptNumber` (web ↔ api lib) | identical pattern + normalizer (`PREFIX` = `"SL-"`) |
| `VanityUrlsTab` slug pattern + RESERVED_SLUGS | identical regex, identical 13-entry list |
| `PaymentsTab.displayedTotals` | a re-aggregation of server-computed fields, not a re-derivation — different risk class |
| **`AcceptPaymentDialog` breakdown** | **DRIFTED three ways — see [[project_payment_math]]** |

**The one that re-derived money was the one that had drifted.** The durable
answer for the pure ones is to move them into `packages/` (as
`@repo/money` already did for payout math) rather than to compare copies —
opportunistic, since all six currently agree.

## Watch for

A field NAMED like a date key that is not one. `receipt.ts`'s `serviceDate`
holds `fmtDate()` output (`"11/13/2026"`, or `"—"`); `statement.ts`'s
identically-named field IS a key. `tsc` caught that when a branding pass
nearly treated them alike — both now carry a comment saying which they are.

Related: [[feedback_date_branded_types]], [[reference_date_handling]],
[[feedback_mutation_test_every_gate]].
