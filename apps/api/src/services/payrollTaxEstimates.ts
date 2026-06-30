// ─────────────────────────────────────────────────────────────────────────────
// PAYROLL_TAX_ESTIMATES setting — operator-tunable percentages used to
// estimate the employer-side payroll tax burden on the Reconcile P&L.
// Surfaces as a synthetic "Employer payroll taxes (est.)" expense line
// that deducts from Net Operating Income so the figure reads as
// company-perspective operating profit, not as QB-tied accrual.
//
// IMPORTANT — what this MODELS:
//   • Social Security (employer share)  6.20% of W-2 wages
//   • Medicare (employer share)         1.45% of W-2 wages
//   • Federal Unemployment (FUTA)       0.60% of W-2 wages (effective after
//                                       state credit; the wage-base cap is
//                                       ignored — see "what this DOESN'T
//                                       model" below)
//   • State Unemployment (SUTA)         operator-set %, taxes W-2 wages
//
// IMPORTANT — what this DOESN'T model:
//   • Wage-base caps. Real SS caps at the annual SS wage base; FUTA caps at
//     $7k/employee/year; SUTA at the state wage base. The synthetic line
//     applies a flat % to all wages in the period, so the estimate is
//     slightly high once any worker crosses a cap.
//   • Additional Medicare. Employer doesn't owe this; employee withholding
//     above $200k/year only. No effect here.
//   • Workers' Compensation. Modeled as a separate BusinessExpense (it's
//     insurance, not a tax) — adding it here would double-count.
//   • Contractor pay. 1099 contractors pay their own SE tax; the business
//     pays no payroll tax on them. So this rate applies ONLY to the
//     employee-class Wages base, NEVER to Contract Labor.
//
// Tunable for any state via the SUTA field. NC small-employer default of
// 1.5% is a reasonable mid-range starting point; the operator should
// replace it with the rate from their NCDES "Tax Rate Notice" once they
// have it.
// ─────────────────────────────────────────────────────────────────────────────

import { ServiceError } from "../lib/errors";

export type PayrollTaxEstimateConfig = {
  socialSecurityEmployerPct: number;
  medicareEmployerPct: number;
  futaEmployerPct: number;
  sutaEmployerPct: number;
};

// Reasonable defaults if the setting is missing entirely — used by the
// reader so the P&L still produces an estimate before the operator has
// touched Settings. Matches what we seed into dev (and what the
// migration upsert into prod will write).
export const PAYROLL_TAX_ESTIMATE_DEFAULTS: PayrollTaxEstimateConfig = {
  socialSecurityEmployerPct: 6.2,
  medicareEmployerPct: 1.45,
  futaEmployerPct: 0.6,
  sutaEmployerPct: 1.5,
};

const ALLOWED_KEYS = new Set([
  "socialSecurityEmployerPct",
  "medicareEmployerPct",
  "futaEmployerPct",
  "sutaEmployerPct",
]);

/**
 * Parse the PAYROLL_TAX_ESTIMATES setting from raw JSON. Tolerant of
 * missing fields (defaults applied), strict on unknown fields so a
 * misspelled key surfaces fast instead of silently dropping a rate.
 */
export function parsePayrollTaxEstimates(raw: string | null | undefined): PayrollTaxEstimateConfig {
  if (!raw) return { ...PAYROLL_TAX_ESTIMATE_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAYROLL_TAX_ESTIMATES setting is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAYROLL_TAX_ESTIMATES setting must be a JSON object.");
  }
  const row = parsed as Record<string, unknown>;
  for (const k of Object.keys(row)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(`PAYROLL_TAX_ESTIMATES has unknown field "${k}".`);
    }
  }
  const num = (key: keyof PayrollTaxEstimateConfig): number => {
    const v = row[key];
    if (v == null) return PAYROLL_TAX_ESTIMATE_DEFAULTS[key];
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`PAYROLL_TAX_ESTIMATES.${String(key)} must be a number.`);
    }
    return n;
  };
  return {
    socialSecurityEmployerPct: num("socialSecurityEmployerPct"),
    medicareEmployerPct: num("medicareEmployerPct"),
    futaEmployerPct: num("futaEmployerPct"),
    sutaEmployerPct: num("sutaEmployerPct"),
  };
}

/**
 * Validate a PATCH payload before write. Same parser checks plus range
 * limits: percentages can't be negative, and 100% is a hard ceiling
 * (real-world employer burdens never approach that; a typo'd 62 instead
 * of 6.2 would otherwise sail through). Route layer surfaces failures
 * as 400 Bad Request.
 */
export function validatePayrollTaxEstimatesJson(raw: string): PayrollTaxEstimateConfig {
  const config = parsePayrollTaxEstimates(raw);
  for (const [key, value] of Object.entries(config)) {
    if (value < 0 || value > 100) {
      throw new Error(`PAYROLL_TAX_ESTIMATES.${key} must be between 0 and 100 (got ${value}).`);
    }
  }
  return config;
}

/**
 * Sum of all four employer-side rates as a percentage. The synthetic
 * P&L line applies this to the wages base; the label embeds this
 * percent so operators can sanity-check at a glance.
 */
export function totalEmployerTaxPct(config: PayrollTaxEstimateConfig): number {
  return (
    config.socialSecurityEmployerPct +
    config.medicareEmployerPct +
    config.futaEmployerPct +
    config.sutaEmployerPct
  );
}

/**
 * Per-component breakdown ready for the expandable P&L row. Each entry
 * holds the rate, the dollar contribution, and a stable display label
 * — kept here (not in the renderer) so the wording is consistent
 * across the API response and any future tie-out script.
 */
export function breakdownEmployerTaxes(wages: number, config: PayrollTaxEstimateConfig) {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return [
    {
      key: "socialSecurity",
      label: "Social Security",
      ratePct: config.socialSecurityEmployerPct,
      amount: round2((wages * config.socialSecurityEmployerPct) / 100),
    },
    {
      key: "medicare",
      label: "Medicare",
      ratePct: config.medicareEmployerPct,
      amount: round2((wages * config.medicareEmployerPct) / 100),
    },
    {
      key: "futa",
      label: "FUTA",
      ratePct: config.futaEmployerPct,
      amount: round2((wages * config.futaEmployerPct) / 100),
    },
    {
      key: "suta",
      label: "SUTA",
      ratePct: config.sutaEmployerPct,
      amount: round2((wages * config.sutaEmployerPct) / 100),
    },
  ];
}

/**
 * Loader — reads the PAYROLL_TAX_ESTIMATES setting from Prisma and
 * returns a parsed config. Returns defaults when the row is missing
 * entirely (dev DBs that pre-date the seed addition).
 */
export async function loadPayrollTaxEstimates(prismaClient: {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string | null } | null> };
}): Promise<PayrollTaxEstimateConfig> {
  try {
    const row = await prismaClient.setting.findUnique({
      where: { key: "PAYROLL_TAX_ESTIMATES" },
    });
    return parsePayrollTaxEstimates(row?.value ?? null);
  } catch (err) {
    // A malformed setting should NOT crash the P&L. Log + fall back to
    // the defaults so the operator sees a reasonable estimate while
    // they fix the bad JSON.
    if (err instanceof ServiceError) throw err;
    return { ...PAYROLL_TAX_ESTIMATE_DEFAULTS };
  }
}
