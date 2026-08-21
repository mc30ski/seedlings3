---
name: feedback-config-driven-taxonomies
description: "User strongly prefers configuration-driven taxonomies over hardcoded enums/lists; when scope says \"keep X if used\", a picker/dropdown still counts as needing conversion"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:28:13.845Z
---

The user wants user-facing taxonomies to be JSON-settings driven, not hardcoded DB enums or TS literal unions. Adding a new value must be a Settings edit — no code change, no migration, no deploy.

**Why:** The single most likely reason anyone touches such a setting is to add a new value (a new payment processor, a new property kind). If that still requires a code change, the whole point of the setting is defeated. The user has repeatedly converted enums to JSON-settings taxonomies: `EQUIPMENT_KINDS`, `SERVICE_TYPES`, and `PAYMENT_METHODS` (the last converted the `PaymentMethod` Prisma enum to a plain `String` column validated at write time against the `PAYMENT_METHODS` setting).

**How to apply:**
- When a task scope says "keep constant X if it's still used" — a dropdown/picker that lets a user *select* a taxonomy value is NOT a legitimate static use. It must be converted to read from the taxonomy, otherwise it can never display newly-added values. Convert it; don't preserve it just because it's referenced.
- `apps/api/prisma/schema.prisma` has `// TODO:` comments above `PropertyKind` and `ContactRole` — the next time either needs a new value, convert it to a JSON-settings taxonomy (pattern: `services/paymentMethods.ts`) instead of adding the enum value.
- Enums that should STAY enums: workflow state machines (`JobStatus`, `JobOccurrenceStatus`, etc.), `Role`, `WorkerType` (tax/payroll consequences), `PaymentCommsMode`. The smell is "user-facing label that could plausibly grow," not "any enum."
- The taxonomy-driven pattern: JSON array Setting + a parse/validate helper + runtime validation on write paths + a label-lookup hook on the web side (companion: `usePaymentMethodLabels` hook resolves labels app-wide).

Related: [[financial-system-doc]] documents PAYMENT_METHODS as a canonical example of this pattern.
