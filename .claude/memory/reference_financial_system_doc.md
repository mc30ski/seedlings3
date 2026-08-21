---
name: financial-system-doc
description: Canonical spec for the payments/taxes/expenses system lives at docs/FINANCIAL_SYSTEM.md — consult it before any financial-feature work
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:32.580Z
---

**Two companion docs** for the financial system, both in `docs/`:

1. **`docs/FINANCIAL_SYSTEM.md`** — technical/admin-facing canonical reference.
   Covers: payment lifecycle, per-worker payout math, reconciliation
   (promised vs actual, employee made-whole, contractor pro-rata, shortfall/
   overage), processor fees + absorption model, the configurable
   PAYMENT_METHODS taxonomy, the two payment contexts, owner earnings,
   business expenses, the Accounting tab Cash Flow view, tax-integrity rules,
   the full Settings reference, exports (Gusto + QuickBooks journal-entry
   format with SLC-YYMMDD-XXXX ledger IDs + App Clearing Account architecture),
   worker earnings views, audit events.

2. **`docs/TAX_AND_PAYROLL_PICTURE.md`** — owner-facing big-picture
   walkthrough. Covers: the two tax worlds (employment vs personal business),
   day-to-day money flow per job, the weekly/monthly/quarterly/annual rhythm,
   the three-systems architecture (app + Gusto + QB), recommended Gusto-to-QB
   integration setup, NC withholding account, processor fee absorption policy
   with alternatives, Schedule C math.

**How to apply:** Before changing any payment / payout / fee / export / tax
code, read FINANCIAL_SYSTEM.md. It describes *intended* behavior — if the
code has drifted from it, treat that as a bug to investigate, not the new
normal. After intentionally changing financial behavior, update FINANCIAL_SYSTEM.md
in the same change so it stays canonical, and update TAX_AND_PAYROLL_PICTURE.md
if the change affects the owner-facing workflow (filing rhythm, three-systems
boundaries, tax treatment of a transaction class). The user maintains both as
drift-detection baselines.

Related: [[project-payment-math]], [[project-tax-export-integrity]], [[feedback-config-driven-taxonomies]], [[feature-guaranteed-payout]], [[project-equipment-rental-income]], [[feedback-payments-build-gate]].
