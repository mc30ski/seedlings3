# Phase 2 — Branded Date Types

**Status:** Draft. No code changes yet. Awaiting operator approval before starting.
**Companion doc:** [`DATE_HANDLING.md`](DATE_HANDLING.md) (current policy + runtime helpers).
**Motivation memory:** `feedback_fmtdate_eats_date_keys.md` (the shipped bug that triggered Phase 1 + this plan).

---

## Why

Phase 1 (runtime auto-routing in every date formatter) closed the concrete class of bug that ate the operator's schedule: any formatter given a `YYYY-MM-DD` calendar key OR a full ISO datetime OR a Date now produces the correct ET-anchored display.

Phase 1 does NOT close two remaining failure modes:

1. **Arithmetic and comparison** on the wrong shape. `bizAddDays(instantIsoString, 7)` silently returns `""` (regex fails). `date1 > date2` where one is a UTC-midnight-parsed key and the other is an ET-anchored instant compares wrong. Neither path is guarded at compile time.
2. **DB storage mismatches.** Prisma `String` fields that store date-keys (`WorkerWorkday.workdayDate`, `JobOccurrence.nextStartOverride`, `Vehicle.inServiceDate`, `MileageEntry.entryDate`) and Prisma `DateTime` fields that store instants both surface as `string` in generated types. Application code cannot distinguish them; passing the wrong one to a helper compiles cleanly.

Phase 2 encodes the shape distinction in the type system so the compiler rejects miscalls that Phase 1 forgives at runtime. **Wrong code stops compiling. No memory required.**

---

## The two brands

```ts
/** An ET calendar-day string in YYYY-MM-DD form. Produced by
 *  bizToday, bizAddDays, bizDateKey, and by every schema String field
 *  documented as a date-key. */
export type EtDateKey = string & { readonly __brand: "EtDateKey" };

/** A full ISO datetime string with a time component (unambiguous
 *  UTC instant, e.g. "2026-08-12T12:00:00.000Z"). Produced by every
 *  Prisma DateTime field's JSON serialization + every helper that
 *  returns an instant. */
export type IsoInstant = string & { readonly __brand: "IsoInstant" };
```

Two constructor functions (single point of trust):

```ts
export function etDateKey(s: string): EtDateKey {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Not a YYYY-MM-DD key: ${s}`);
  return s as EtDateKey;
}

export function isoInstant(s: string): IsoInstant {
  if (isNaN(new Date(s).getTime())) throw new Error(`Not a valid ISO instant: ${s}`);
  return s as IsoInstant;
}
```

Helpers acquire strict signatures:

```ts
// Producers return branded types
export function bizToday(): EtDateKey;
export function bizAddDays(key: EtDateKey, n: number): EtDateKey;
export function bizDateKey(d: Date | IsoInstant): EtDateKey;

// Consumers accept only their intended brand
export function fmtDateKey(key: EtDateKey): string;

// The generic formatters keep accepting all shapes (auto-route from Phase 1).
// TypeScript can now distinguish which shape you meant to pass at the callsite.
export function fmtDate(d: EtDateKey | IsoInstant | Date | null | undefined): string;
```

---

## Migration surface

Estimated **~90 files touched**, split into phases:

### Phase 2a — Foundation (no user-facing changes)
1. Add `EtDateKey` + `IsoInstant` types + constructors to `apps/web/src/lib/lib.ts` and `apps/api/src/lib/dates.ts`.
2. Update helper signatures (`bizToday`, `bizAddDays`, `bizDateKey`, `bizDaysBetween`, `bizAddMonths`, `bizAddYears`, `etAddDays`, `etDaysBetween`, `etFormatDate`, `etMidnight`, `etInstantFromParts`) to accept/return branded types.
3. **Zero migration required at this stage** — every existing caller passes `string`, which is compatible with the branded type at the JS level; TypeScript will complain about specific misuses only after step 2b.

**Files touched:** 2. **Risk:** none — additive types.

### Phase 2b — Prisma type overrides
1. Create `apps/api/src/db/prismaTypes.ts` — re-exports Prisma-generated types with the date-key `String` fields overridden to `EtDateKey` and DateTime fields overridden to `IsoInstant` at their JSON boundary.
2. Update every service/route that returns a JobOccurrence / WorkerWorkday / Vehicle / MileageEntry / etc. to type its response as the branded variant.
3. Update every API response type consumed on the web side (`types.ts`, per-tab local response types) to import the branded variant.

**Files touched:** ~15. **Risk:** low — only type-level changes, no runtime shift.

### Phase 2c — Wire the source
Compiler now flags every mismatch. Walk the errors, fix each callsite either by:
- Correcting the actual bug (e.g. passing a key where an instant was expected).
- Explicitly casting through the constructor (`isoInstant(x)`) at a boundary where the shape is genuinely known (e.g. deserializing from a trusted external source).

Expected error count: **~40–70** across the codebase, mostly clustered in the areas the audit already flagged (JobsTab, PaymentsTab, ReconcileTab, WorkdaysTab, VehiclesTab, compliance surfaces).

**Files touched:** ~70. **Risk:** medium — each fix is small but the sheer volume needs careful review. **Every fix is a real latent bug being closed.**

### Phase 2d — Build-gate rules for the boundary
1. Forbid raw `string` in date-typed prop declarations (e.g. `startAt: string` in a React component prop) — must be `IsoInstant | Date`.
2. Forbid `as EtDateKey` / `as IsoInstant` casts outside of `lib.ts` / `dates.ts` / trusted-boundary files — force use of the constructor functions.

**Files touched:** 1 (build gate). **Risk:** none.

---

## What Phase 2 does NOT do

- **Doesn't renormalize schema.** The `String` vs `DateTime` split stays as-is — the audit confirmed that decision was correct (String is right for calendar-day fields; a DateTime would require picking a fictitious time-of-day and add ambiguity). Phase 2 only annotates the existing choice at the type level.
- **Doesn't change any runtime behavior.** Every input that compiles today under Phase 1 will still produce the same output after Phase 2. The value-add is that miscalls become compile errors.
- **Doesn't move any dates through the JSON boundary differently.** Prisma still serializes DateTime → ISO string; the brand is a compile-time-only lens on that string.

---

## Rollback

Every phase is independent and can be reverted in a single commit. Branded types compile to `string` at runtime, so a rollback of the type overrides doesn't touch runtime behavior — the code still works, just without the compile-time guardrails.

---

## Estimated scope

| Phase | Files | Review time | Risk |
|---|---|---|---|
| 2a — Types + helper sigs | 2 | 30 min | none |
| 2b — Prisma overrides | ~15 | 2 hours | low |
| 2c — Fix compile errors | ~70 | 4–6 hours | medium (each fix warrants review) |
| 2d — Build-gate rules | 1 | 20 min | none |
| **Total** | **~90** | **~1 focused day** | — |

Recommend splitting into two sessions: **2a + 2b in one** (setup + Prisma boundary), **2c + 2d in the next** (walk the compile errors, add rules). Each session is a bounded, review-able PR.

---

## Decision required

Approve → I execute in two sessions, one per PR. Both go through the same test + build-gate discipline as Phase 1.

Redirect → tell me which part you want narrower or broader.
