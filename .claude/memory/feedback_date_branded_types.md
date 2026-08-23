---
name: feedback-date-branded-types
description: "Phase 2 shipped — TypeScript brands `EtDateKey` and `IsoInstant` distinguish the two date shapes; arithmetic/parse helpers reject raw `string` at the type layer. Combines with Phase 1 formatter auto-route to make both shipped date-bug classes mechanically impossible."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:20:25.087Z
---

## What shipped (session `d1686705`)

Two brand types with structural (nominal-ish) TypeScript identity, shared between web and API via matching brand strings:

```ts
type EtDateKey  = string & { readonly __brand: "EtDateKey" };
type IsoInstant = string & { readonly __brand: "IsoInstant" };
```

Constructors (throw on bad input):
- Web:  `etDateKey(s)`  / `isoInstant(s)` in `apps/web/src/lib/dates.ts`
- API:  `toEtDateKey(s)` / `toIsoInstant(s)` in `apps/api/src/lib/dates.ts`

**Every producer** (`bizToday`, `bizAddDays`, `bizDateKey`, `etToday`, `etAddDays`, `etFormatDate`, `etMondayOnOrBefore`, `etSundayOnOrBefore`, `etStartOfMonth`, `etStartOfYear`, and their web-side twins) returns `EtDateKey`.

**Every arithmetic/parse consumer** (`bizAddDays`, `bizAddMonths`, `bizAddYears`, `bizDaysBetween`, `bizYearOf`, `bizInstantFromEtParts`, `etAddDays`, `etDaysBetween`, `etMidnight`, `etEndOfDay`, `etInstantFromParts`) **requires `EtDateKey`** — a raw `string` won't type-check without an explicit `as EtDateKey` cast (trusted boundary) or `etDateKey()` / `toEtDateKey()` call (validates at runtime).

**Formatters (`fmtDate`, `fmtDateKey`, `fmtDateTime`, `fmtDateOpts`, `fmtTimeOpts`, `fmtDateWeekday`, `fmtDateShort`, `fmtDateLong`, `prettyDate`) accept everything** — Date, ISO datetime string, or YYYY-MM-DD key — via the Phase 1 auto-router. Display is safe regardless of caller.

## How this catches bugs the previous state didn't

| Previous silent failure | Now |
|---|---|
| `bizAddDays(occ.startAt, 7)` where `startAt` is ISO datetime — regex fails, returns `""`, downstream `fmtDate("")` shows `"—"`, operator confused | Compile error at the callsite — TypeScript rejects `string` for `EtDateKey` param |
| `etMidnight(q.from)` where `q.from` is unvalidated — regex fails, returns Invalid Date, downstream Prisma throws | Compile error unless caller wraps with `q.from as EtDateKey` (documented as regex-validated) or `toEtDateKey(q.from)` (runtime-validates) |
| `bizDaysBetween(a, b)` where `a` is an ISO instant — regex fails, returns NaN, downstream comparisons silently wrong | Compile error at the callsite |
| `useState(bizToday())` inferred as `string` — child DateInput's onChange overwrites the state with anything | State now inferred as `EtDateKey`; DateInput's onChange emits `EtDateKey` (branded at the native `<input type="date">` boundary) |

## Trusted-boundary cast pattern

Casting `x as EtDateKey` is intentionally allowed. It's the "I've already validated this string; trust me" boundary marker. Common legitimate spots:
- Query params that route handlers regex-tested before use.
- Request body fields validated by a route guard.
- Hard-coded literal date-strings in tests / seed data.
- The output of `<input type="date">` (via `DateInput` component — already branded).

When the source hasn't been validated (e.g. arbitrary user input, external API response), prefer the constructor form `toEtDateKey(s)` — it throws on bad shape instead of silently accepting garbage.

## Files touched (Phase 2)

- `apps/web/src/lib/dates.ts` — brands + constructors + 10 producer/consumer signature updates
- `apps/api/src/lib/dates.ts` — brands + constructors + 10 producer/consumer signature updates
- `apps/web/src/ui/components/DateInput.tsx` — onChange returns EtDateKey (native input boundary)
- `apps/api/src/lib/policyPredicate.ts` — return type + internal usage
- `apps/api/src/lib/businessStartCutoff.ts` — one boundary cast
- ~10 API route/service files — bulk `as EtDateKey` at regex-validated query-param boundaries
- ~13 web tab/dialog files — bulk `as EtDateKey` at trusted boundaries
- 2 test files — bulk cast for literal date strings

Total: **~30 production files touched, ~65 casts added, 0 runtime behavior change.**

## What's still not enforced (future work)

No build-gate rule limits `as EtDateKey` casts to an allowlist. In this session there were too many legitimate boundary casts to allowlist practically. If future casts start to feel abusive (e.g. someone casting to bypass a real bug), consider a rule that forbids `as EtDateKey` in specific directories (like `apps/web/src/ui/`) — but leave route handlers + trusted lib code exempt.

Prefer the constructor form (`etDateKey(s)` / `toEtDateKey(s)`) at new callsites when the source isn't already validated. The runtime throw protects against a wrong shape sneaking through.

## Sibling memories

- [[feedback-fmtdate-eats-date-keys]] — Phase 1 runtime auto-router for formatters. Complements this session's compile-time typing.
- [[date-handling-reference]] — canonical policy doc + build gate list.
- [[feedback-run-build-gate-after-changes]] — the build gate that catches new violations at CI time.
