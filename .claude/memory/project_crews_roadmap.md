---
name: project-crews-roadmap
description: Crews (Group model + GroupMember + CheckoutSplit + writeCheckoutSplits) are built and operational. Equipment cost splitting is live for group checkouts; two existing policy quirks to be aware of.
metadata:
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:23:34.664Z
---

The Crews feature is implemented. The earlier "deferred until Crews ships" notes are stale.

**Why this matters:** The 1-checkout-1-payer model that an older memory described as "intentional for now" was superseded once Crews landed. Group checkouts split equipment cost across crew members at release time via CheckoutSplit rows.

**How to apply:** When working on equipment billing, charge listings, or any per-user money view that touches rentals, assume group splits exist alongside solo checkouts. Read both `Checkout` rows (for solo) and `CheckoutSplit` rows (for group members) — see `listEquipmentCharges` in [services/equipment.ts](apps/api/src/services/equipment.ts) for the canonical pattern.

## What's built

**Schema** ([apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma)):
- `Group` — id, name, description, claimerUserId, archivedAt, preferredEquipment, checkouts, occurrences, defaultForJobs.
- `GroupMember` — groupId, userId, role ("worker"/"observer"), `equipmentCostPercent`. Unique on (groupId, userId).
- `Checkout.groupId` — non-null when the checkout is on behalf of a crew. The Checkout.userId is the claimer.
- `JobOccurrence.assignedGroupId` — the crew that's executing the occurrence.
- `CheckoutSplit` — per-worker share of a group rental. Unique on (checkoutId, userId). Fields: percent, amount.
- `GroupPreferredEquipment` — display-only "preferred kit" for a crew.

**Service layer:**
- `writeCheckoutSplits()` in [services/equipment.ts:50](apps/api/src/services/equipment.ts#L50) materializes CheckoutSplit rows on release. Includes the claimer (treated as a worker) + all non-observer GroupMembers. Distributes by `equipmentCostPercent` when every worker has one (and they sum to 100); otherwise even-split. Upserts per (checkoutId, userId) so re-runs are idempotent.
- Called from `release()` and the QR-return path in equipment.ts.
- `listEquipmentCharges` reads BOTH `Checkout` rows (solo) AND `CheckoutSplit` rows (group), normalizes them into a single charge feed per user.

## Policy quirks worth knowing (potential gaps)

These shape behavior in mixed-crew cases — not necessarily bugs, but worth confirming intent before touching equipment billing logic:

1. **The claimer's worker type decides whether the whole crew pays.** `computeRentalCost` is called with `holder?.workerType` where holder = checkout.userId = the claimer. If the claimer is EMPLOYEE/TRAINEE, rental returns null → `writeCheckoutSplits` is skipped (only runs when `rental?.rentalCost` is truthy) → no member is charged, regardless of how many contractors are on the crew. Possibly intentional ("if a W-2 brings it, it's company tools"), but the effect is mixed-crew contractors get free equipment when an employee claims.

2. **Employees inside a contractor-claimed crew currently get charged.** `writeCheckoutSplits` doesn't filter by workerType — it writes a row for every non-observer worker. So if a contractor claims and the crew has employee members, the employees get `CheckoutSplit.amount > 0`. That contradicts the solo "employees use equipment for free" rule from [project-equipment-rental-income](project_equipment_rental_income.md).

Treat both as known asymmetries when building new equipment billing features — either reuse the existing logic with the same quirks, or explicitly fix them.

**Related:**
- [[project-equipment-rental-income]] — solo equipment rental policy (contractors charged, equipment income to business). The mixed-crew fix in [[feature-per-job-equipment-billing]] closed the two quirks above; re-read both memos before touching group billing.
- [[feature-business-start-date]] — Checkout cutoff anchor is `releasedAt`; CheckoutSplit rows inherit the parent's cutoff treatment.
- [[feature-per-job-equipment-billing]] — later billing-mode extension that also touched this codepath.
