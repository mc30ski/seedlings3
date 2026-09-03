// Forecast client — Super → Money → Forecast.
//
// The simulator itself is NOT here. It lives in @repo/money and is the same
// code the API runs, so a scenario computed while dragging a slider and a
// scenario computed server-side for the AI assessment can never disagree.
// This module is only transport plus the little bits of presentation the tab
// needs.

import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { assumptionsDiffer } from "@repo/money";
import type {
  Assumptions,
  ForecastBaseline,
  ForecastResult,
  HypotheticalWorker,
} from "@repo/money";

export type {
  Assumptions,
  ForecastBaseline,
  ForecastResult,
  HypotheticalWorker,
  WorkerOutcome,
  MarketRateInfo,
  CapacityMode,
  PayModel,
  CostBehavior,
} from "@repo/money";

export type BaselineResponse = {
  baseline: ForecastBaseline;
  /** How closely replaying today's settings reproduces the books. Not a
   *  precision claim — a smoke detector for a broken model. */
  backtest: { modelled: number; actual: number; differencePercent: number };
  statusQuo: ForecastResult;
};

/** List rows carry `assumptions` (needed to replay each scenario for the
 *  side-by-side comparison) but NOT `assessment` — that blob is fetched only
 *  for the scenario actually being opened. */
export type SavedForecast = {
  id: string;
  name: string;
  notes: string | null;
  windowFrom: string;
  windowTo: string;
  compareFrom: string | null;
  compareTo: string | null;
  assumptions: Assumptions;
  assessment?: ForecastAssessment | null;
  assessedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: { id: string; displayName: string | null } | null;
};

export type ForecastAssessment = {
  verdict: "strong" | "workable" | "risky" | "bad";
  headline: string;
  summary: string;
  strengths: string[];
  concerns: string[];
  fairness: string;
  recommendations: Array<{ action: string; why: string }>;
  questionsToResolve: string[];
  generatedAt: string;
  /** The assumptions this assessment was actually written about. Compared
   *  against the live ones so stale advice is never shown as current. */
  aboutAssumptions: Assumptions;
  backtestPercent: number;
};

export const fetchBaseline = (from: string, to: string) =>
  apiGet<BaselineResponse>(
    `/api/super/forecast/baseline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );

export const fetchForecasts = (includeArchived = false) =>
  apiGet<SavedForecast[]>(`/api/super/forecasts${includeArchived ? "?includeArchived=1" : ""}`);

export const fetchForecast = (id: string) => apiGet<SavedForecast>(`/api/super/forecasts/${id}`);

export const createForecast = (input: {
  name: string;
  notes?: string | null;
  windowFrom: string;
  windowTo: string;
  compareFrom?: string | null;
  compareTo?: string | null;
  assumptions: Assumptions;
}) => apiPost<SavedForecast>("/api/super/forecasts", input);

export const updateForecast = (id: string, input: Partial<Parameters<typeof createForecast>[0]>) =>
  apiPatch<SavedForecast>(`/api/super/forecasts/${id}`, input);

export const duplicateForecast = (id: string) =>
  apiPost<SavedForecast>(`/api/super/forecasts/${id}/duplicate`, {});

export const archiveForecast = (id: string, archived: boolean) =>
  apiPost<SavedForecast>(`/api/super/forecasts/${id}/archive`, { archived });

export const deleteForecast = (id: string) =>
  apiDelete<{ ok: true }>(`/api/super/forecasts/${id}`);

export const assessForecast = (id: string) =>
  apiPost<{ assessment: ForecastAssessment | null; error?: string; raw?: string }>(
    `/api/super/forecasts/${id}/assess`,
    {},
  );

// ── Presentation helpers ────────────────────────────────────────────────────

export function money(n: number, cents = false): string {
  const abs = Math.abs(n);
  return `${n < 0 ? "−" : ""}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

export function pct(n: number, places = 1): string {
  // Same minus glyph money() uses — an ASCII hyphen beside an en-dash minus
  // reads as a typo when the two sit in adjacent cards.
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(places)}%`;
}

/** Signed delta, for before/after columns. */
export function delta(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

export const VERDICT_LABEL: Record<ForecastAssessment["verdict"], string> = {
  strong: "Strong",
  workable: "Workable",
  risky: "Risky",
  bad: "Don't do this",
};

/** Chakra color palette per verdict, so the chip reads at a glance. */
export const VERDICT_TONE: Record<ForecastAssessment["verdict"], string> = {
  strong: "green",
  workable: "blue",
  risky: "orange",
  bad: "red",
};

/** True when a cached assessment describes assumptions that have since moved.
 *  Showing stale advice beside fresh numbers is worse than showing none. */
export function assessmentIsStale(
  assessment: ForecastAssessment | null,
  current: Assumptions,
): boolean {
  if (!assessment?.aboutAssumptions) return false;
  // Key-order-independent: the stored copy has been through Postgres jsonb,
  // which reorders keys, so a plain stringify comparison always says "stale".
  return assumptionsDiffer(assessment.aboutAssumptions, current);
}

/** A new hypothetical worker, defaulted to the neutral assumption: they are
 *  as productive as the crew already is. */
export function newHypothetical(
  index: number,
  crewRevenuePerHour: number,
): HypotheticalWorker {
  return {
    id: `hyp-${index}`,
    name: `New hire ${index}`,
    workerType: "CONTRACTOR",
    hours: 40,
    mode: "SUBSTITUTION",
    revenuePerHour: Math.round(crewRevenuePerHour) || 60,
    substituteForUserId: null,
  };
}
