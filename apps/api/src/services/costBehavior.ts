// ─────────────────────────────────────────────────────────────────────────────
// Cost behavior — how each expense category responds to business volume.
//
// Read ONLY by the Super forecasting tool (Money → Forecast). Nothing that
// records, reports, or exports actual money touches this file.
//
// WHY THIS IS ITS OWN SETTING
// This started life as a `costBehavior` field inside EXPENSE_CATEGORIES,
// which was a mistake. That taxonomy is load-bearing: the Add Expense dialog
// validates against it, the QuickBooks export maps Schedule C lines from it,
// and the P&L groups by it. Its parser rejects unknown fields and its loader
// swallows the resulting error and returns an empty list — so adding a field
// to it took production's expense recording down completely on 2026-09-02,
// with an error message that pointed at the wrong thing.
//
// A forecasting-only attribute must not be able to do that. Keeping it in a
// separate row means the worst case for a malformed value here is that the
// forecaster falls back to defaults. The ledger never notices.
//
// TRADE-OFF ACCEPTED
// Two lists means they can drift: add an expense category and this map won't
// know about it. That is handled the cheap way — an unlisted category
// defaults to VARIABLE, which is the conservative assumption (it denies the
// forecast any margin expansion from scale rather than inventing some), and
// settings-section-build-gate.test.ts flags categories missing from the map.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";

export const COST_BEHAVIOR_SETTING = "EXPENSE_COST_BEHAVIOR";

/**
 *   VARIABLE      — scales with revenue. Fuel, vehicle maintenance.
 *   FIXED         — does not move with volume. Insurance, software, banking.
 *                   This is the category that makes scale pay: at 2x revenue
 *                   a fixed cost is half the percentage.
 *   PER_JOB       — scales with the NUMBER of jobs rather than with dollars.
 *                   Consumables like mulch and trimmer line. Distinct from
 *                   VARIABLE because a price increase raises revenue without
 *                   touching them.
 *   ONE_TIME      — startup or non-recurring. Durable tools, initial
 *                   branding. Excluded from a forward projection entirely.
 *   DISCRETIONARY — you choose the amount each period. Advertising, meals.
 *                   Held flat by default rather than scaled, because scaling
 *                   it with revenue asserts a causal link the data cannot
 *                   support.
 */
export type CostBehavior = "VARIABLE" | "FIXED" | "PER_JOB" | "ONE_TIME" | "DISCRETIONARY";

export const COST_BEHAVIOR_VALUES: CostBehavior[] = [
  "VARIABLE",
  "FIXED",
  "PER_JOB",
  "ONE_TIME",
  "DISCRETIONARY",
];

/** Unlisted categories fall back to this. Conservative on purpose — see the
 *  trade-off note in the header. */
export const DEFAULT_COST_BEHAVIOR: CostBehavior = "VARIABLE";

export type CostBehaviorMap = Record<string, CostBehavior>;

/**
 * Parse the setting. Shape is a flat object keyed by expense-category label:
 *
 *   { "Insurance": "FIXED", "Fuel": "VARIABLE", ... }
 *
 * Keyed by label rather than by id because BusinessExpense.category stores the
 * label, and so does EXPENSE_CATEGORIES — matching that convention keeps the
 * join obvious.
 *
 * Throws on a malformed value so the Settings PATCH route can reject a bad
 * save with a clear message. READERS must not propagate that — see
 * loadCostBehaviorMap.
 */
export function parseCostBehaviorSetting(raw: string | null | undefined): CostBehaviorMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${COST_BEHAVIOR_SETTING} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${COST_BEHAVIOR_SETTING} must be a JSON object of category → behavior.`);
  }
  const out: CostBehaviorMap = {};
  for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !COST_BEHAVIOR_VALUES.includes(value as CostBehavior)) {
      throw new Error(
        `${COST_BEHAVIOR_SETTING}["${label}"] must be one of: ${COST_BEHAVIOR_VALUES.join(", ")}.`,
      );
    }
    out[label] = value as CostBehavior;
  }
  return out;
}

/** Validate a PATCH of this setting. Throws so the route returns a clean 400. */
export function validateCostBehaviorJson(raw: string): CostBehaviorMap {
  return parseCostBehaviorSetting(raw);
}

/**
 * Load the map for the forecasting tool.
 *
 * Never throws. A missing or malformed setting yields an empty map and every
 * category falls back to VARIABLE — the forecast is then conservative rather
 * than absent, and nothing outside the forecast is affected either way.
 */
export async function loadCostBehaviorMap(
  client: typeof prisma | any = prisma,
): Promise<CostBehaviorMap> {
  try {
    const row = await client.setting.findUnique({ where: { key: COST_BEHAVIOR_SETTING } });
    return parseCostBehaviorSetting(row?.value);
  } catch {
    return {};
  }
}

/** Resolve one category's behavior, applying the conservative default. */
export function behaviorFor(map: CostBehaviorMap, label: string): CostBehavior {
  return map[label] ?? DEFAULT_COST_BEHAVIOR;
}
