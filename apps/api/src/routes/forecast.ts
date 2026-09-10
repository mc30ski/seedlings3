// ─────────────────────────────────────────────────────────────────────────────
// Forecast routes — Super only (Money → Forecast)
//
// Every route here is SUPER-gated. The tool exposes whole-business economics
// and per-person pay outcomes; an admin has no business in it.
//
// Nothing on this surface mutates live money. The forecast is advisory —
// see services/forecast.ts and forecast-build-gate.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { Role as RoleVal } from "@prisma/client";
import { etToday, etAddDays, type EtDateKey } from "../lib/dates";
import {
  buildBaselineWithBacktest,
  listForecasts,
  getForecast,
  createForecast,
  updateForecast,
  duplicateForecast,
  archiveForecast,
  deleteForecast,
  saveAssessment,
} from "../services/forecast";
import {
  simulate, defaultAssumptions, describePayShape, migrateAssumptions,
  type Assumptions,
} from "@repo/money";

export default async function forecastRoutes(app: FastifyInstance) {
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  /**
   * The dataset behind the sliders.
   *
   * Deliberately returns the WHOLE window in one response rather than a
   * computed answer: every assumption change then recomputes in the browser
   * against the same pure model the server uses. A round trip per slider drag
   * would make the tool feel broken, and re-deriving the numbers client-side
   * would reintroduce exactly the drift the shared package exists to prevent.
   */
  app.get("/super/forecast/baseline", superGuard, async (req: any) => {
    const today = etToday();
    const from = (req.query?.from as EtDateKey) ?? etAddDays(today, -90);
    const to = (req.query?.to as EtDateKey) ?? today;
    return buildBaselineWithBacktest(from, to);
  });

  // ── Saved scenarios ──────────────────────────────────────────────────────

  app.get("/super/forecasts", superGuard, async (req: any) =>
    listForecasts(req.query?.includeArchived === "1"),
  );

  app.get("/super/forecasts/:id", superGuard, async (req: any) => getForecast(req.params.id));

  app.post("/super/forecasts", superGuard, async (req: any) =>
    createForecast(req.body, req.user.id),
  );

  app.patch("/super/forecasts/:id", superGuard, async (req: any) =>
    updateForecast(req.params.id, req.body, req.user.id),
  );

  app.post("/super/forecasts/:id/duplicate", superGuard, async (req: any) =>
    duplicateForecast(req.params.id, req.user.id),
  );

  app.post("/super/forecasts/:id/archive", superGuard, async (req: any) =>
    archiveForecast(req.params.id, req.body?.archived !== false, req.user.id),
  );

  app.delete("/super/forecasts/:id", superGuard, async (req: any) =>
    deleteForecast(req.params.id, req.user.id),
  );

  // ── AI assessment ────────────────────────────────────────────────────────

  /**
   * Hand a scenario to Claude for a written assessment.
   *
   * Same shape as the route planner in routes/preview.ts: a defensive parse,
   * and an explicit `error` field whenever the output can't be read, so the
   * client shows a banner instead of silently rendering nothing.
   *
   * The assessment is ADVICE ABOUT A PROJECTION — two layers of uncertainty
   * deep. The prompt says so, and the stored result carries the assumptions
   * it was written about so it can never be read next to numbers it wasn't
   * describing.
   */
/**
 * The shape the assessment must come back in.
 *
 * Declared as a SCHEMA rather than described in prose at the end of the
 * prompt, because prose lost. The prompt did say "Respond with ONLY a JSON
 * object", but that instruction sat under ~2,000 tokens of financial
 * context and the model answered conversationally instead — no braces
 * anywhere in the response, so the brace-hunting parse found nothing and
 * the operator got "came back in a format we couldn't read".
 *
 * Structured outputs make that failure impossible: the API constrains
 * generation to this schema, so there is no prose path to fall into.
 * `additionalProperties: false` plus a complete `required` list is what the
 * API needs to enforce it.
 *
 * NOT assistant prefill (seeding the reply with "{"), which is the other
 * classic fix — prefill returns a 400 on Sonnet 5 and every other current
 * model, so it would have traded a bad assessment for a hard failure.
 */
const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["strong", "workable", "risky", "bad"] },
    headline: { type: "string" },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    fairness: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: { action: { type: "string" }, why: { type: "string" } },
        required: ["action", "why"],
        additionalProperties: false,
      },
    },
    questionsToResolve: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict", "headline", "summary", "strengths",
    "concerns", "fairness", "recommendations", "questionsToResolve",
  ],
  additionalProperties: false,
} as const;

  app.post("/super/forecasts/:id/assess", superGuard, async (req: any) => {
    const forecast = await getForecast(req.params.id);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        assessment: null,
        error:
          "The AI assessment isn't configured on this environment — no Anthropic API key is set. Everything else in the forecast still works.",
      };
    }

    const { baseline, backtest } = await buildBaselineWithBacktest(
      forecast.windowFrom as EtDateKey,
      forecast.windowTo as EtDateKey,
    );
    // Stored scenarios can predate the additive pay structure, where
    // "RATE_CARD" genuinely suppressed the share. Replaying one without
    // migrating would pay both and overstate crew cost.
    const assumptions = migrateAssumptions(
      forecast.assumptions as unknown as Record<string, unknown>,
    ) as unknown as Assumptions;
    const scenario = simulate(baseline, assumptions);
    const statusQuo = simulate(baseline, defaultAssumptions(baseline));

    const prompt = buildAssessmentPrompt({
      name: forecast.name,
      notes: forecast.notes,
      window: `${forecast.windowFrom} to ${forecast.windowTo}`,
      backtestPercent: backtest.differencePercent,
      statusQuo,
      scenario,
      assumptions,
      baseline,
    });

    let parsed: any = null;
    let parseError = "";
    let text = "";
    try {
      // Named `anthropic`, not `client`: the audit-coverage gate matches
      // `client.<x>.create(` as a Prisma mutation, and an SDK call is not one.
      const anthropic = new Anthropic({ apiKey });
      // `.parse()` with a schema format — not `.create()` and then hunting
      // for braces in free text. The API constrains generation to
      // ASSESSMENT_SCHEMA, so the prose answer this used to return is no
      // longer a reachable outcome.
      //
      // max_tokens was 4000, now 16000 (the documented default for a
      // non-streaming request). The old ceiling sat close enough to a full
      // assessment — recommendations and questionsToResolve are open-ended
      // lists — that a long one could be cut off mid-object, which surfaces
      // to the operator as the same unreadable-format error.
      const response = await anthropic.messages.parse({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        output_config: { format: jsonSchemaOutputFormat(ASSESSMENT_SCHEMA) },
        messages: [{ role: "user", content: prompt }],
      });
      text = response.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      parsed = response.parsed_output ?? null;
      if (!parsed) {
        // Still reachable if generation is cut short: the format guarantees
        // the SHAPE, not that the model finished. Name which one it was, and
        // log it — the old code returned the raw text to the client but
        // logged nothing, so there was nothing to look at afterwards.
        parseError =
          response.stop_reason === "max_tokens"
            ? "the assessment ran past its length limit"
            : `no parsable output (stop_reason: ${response.stop_reason})`;
        app.log.error({
          where: "forecast/assess",
          stopReason: response.stop_reason,
          outputTokens: response.usage?.output_tokens,
          textPreview: text.slice(0, 300),
        });
      }
    } catch (err: any) {
      app.log.error({ where: "forecast/assess", err: err?.message });
      return {
        assessment: null,
        error: `The assessment couldn't be generated: ${err?.message ?? "unknown error"}. The forecast itself is unaffected — try again in a moment.`,
      };
    }

    if (!parsed) {
      return {
        assessment: null,
        raw: text,
        error: `The assessment came back in a format we couldn't read (${parseError}). Try again.`,
      };
    }

    // Stamp what the assessment was actually about. Without this a saved
    // assessment can end up displayed beside assumptions it never saw.
    const stored = {
      ...parsed,
      generatedAt: new Date().toISOString(),
      aboutAssumptions: assumptions,
      backtestPercent: backtest.differencePercent,
    };

    await saveAssessment(forecast.id, stored, req.user.id);

    return { assessment: stored, error: undefined };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function buildAssessmentPrompt(ctx: {
  name: string;
  notes: string | null;
  window: string;
  backtestPercent: number;
  statusQuo: ReturnType<typeof simulate>;
  scenario: ReturnType<typeof simulate>;
  assumptions: Assumptions;
  baseline: Awaited<ReturnType<typeof buildBaselineWithBacktest>>["baseline"];
}): string {
  const { statusQuo: sq, scenario: sc, assumptions: a, baseline: b } = ctx;
  // Pay structure is additive — there is no mode to report, so the prompt
  // describes what the levers add up to rather than naming a setting.
  const shape = describePayShape(a);

  const workerLines = sc.workers
    // Pay, not hours, is the test for inclusion — a per-period guarantee can
    // pay someone who clocked nothing, and leaving them out would hide exactly
    // the person the guarantee was written for.
    .filter((w) => w.clockedHours > 0 || w.totalPay > 0)
    .map((w) => {
      const before = sq.workers.find((x) => x.userId === w.userId);
      const wasRate = before ? before.effectiveHourly : 0;
      return `  - ${w.name} (${w.workerType ?? "unclassified"}${w.isOwner ? ", OWNER" : ""}${w.hypothetical ? ", HYPOTHETICAL HIRE" : ""}): ${w.clockedHours}h, $${w.totalPay.toFixed(0)} total, $${w.effectiveHourly.toFixed(2)}/hr (was $${wasRate.toFixed(2)}/hr)${w.guaranteedTopUpHours > 0 ? `, of which ${w.guaranteedTopUpHours.toFixed(1)}h ($${w.guaranteedTopUpPay.toFixed(0)}) is guaranteed time not worked` : ""}${w.claimerPremiumHours > 0 ? `, and ${w.claimerPremiumHours.toFixed(1)}h ($${w.claimerPremiumPay.toFixed(0)}) earning the claimer premium for leading a crew` : ""}`;
    })
    .join("\n");

  const costLines = sc.costs
    .map((c) => `  - ${c.category} [${c.behavior}]: ${money(c.amount)}`)
    .join("\n");

  const warnLines = sc.warnings.length
    ? sc.warnings.map((w) => `  - [${w.level.toUpperCase()}] ${w.message}`).join("\n")
    : "  (none)";

  return `You are advising the owner of a small lawn-care business in North Carolina on a pay-structure scenario he has modelled. Give him a direct, numerate assessment — the kind a good CFO friend would give over coffee, not a consulting deck.

WHAT YOU ARE LOOKING AT
This is a SIMULATION replayed over a window of real jobs that already happened. It is not a budget and not a forecast of demand. The app's figures are a close estimate; QuickBooks, Gusto and the bank are the source of truth. Treat everything below as directional.

Scenario name: ${ctx.name}
${ctx.notes ? `Operator's note: ${ctx.notes}\n` : ""}Window replayed: ${ctx.window} (${b.jobs.length} paid jobs, ${sq.totalClockedHours}h clocked)
Model fidelity: replaying today's settings reproduces the books to within ${ctx.backtestPercent}% of revenue.

TODAY (unchanged settings)
  Revenue ${money(sq.revenue)} · crew pay ${money(sq.crewPay)} · employer burden ${money(sq.employerBurden)}
  Operating costs ${money(sq.costsTotal)} (of which fixed ${money(sq.fixedCosts)})
  Operating profit ${money(sq.profitBeforeOwnerLabor)} · LLC Owner share ${money(sq.ownerPay)} · retained ${money(sq.profitAfterOwnerLabor)} (${sq.marginPercent}% margin)
  Labor is ${sq.laborPercentOfRevenue}% of revenue. Revenue per clocked hour ${money(sq.revenuePerClockedHour)}.

THE SCENARIO
  Pay structure: ${shape.name ?? "a blend with no standard name"} — workers are paid ${shape.detail}${a.leadHourlyBonus ? `, plus $${a.leadHourlyBonus}/hr to the claimer of any job someone else also worked (applied to the share of their hours spent on those jobs, not their whole week)` : ""}
  Business keeps ${a.employeeMarginPercent}% from employees, ${a.contractorFeePercent}% from contractors${
    a.guaranteedHoursPerPeriod > 0
      ? `\n  Pay guarantee: every ${a.guaranteeContractors ? "worker including contractors" : "W-2 worker"} is paid for at least ${a.guaranteedHoursPerPeriod}h in each of the ${b.payPeriods.keys.length} ${b.payPeriods.cadence.toLowerCase()} periods in this window, INCLUDING periods they did not work at all. That buys ${sc.workers.reduce((t, w) => t + w.guaranteedTopUpHours, 0).toFixed(0)}h of unworked time.`
      : ""
  }
  Price change ${a.priceIncreasePercent}% · minimum invoice ${money(a.minimumInvoice)} · volume ×${a.volumeMultiplier}
  Employer tax ${a.employerTaxPercent}% · workers comp ${a.workersCompPercent}% of W-2 wages
  LLC Owner share is its OWN line — neither a business cost nor profit. Operating profit is before it; "retained in the business" is after it. Replacing the owner's hours with a hire converts that share into crew pay, which is the comparison to reason about.

  RESULT: revenue ${money(sc.revenue)} · crew pay ${money(sc.crewPay)} · LLC Owner share ${money(sc.ownerPay)} · operating profit ${money(sc.profitBeforeOwnerLabor)} · retained after owner share ${money(sc.profitAfterOwnerLabor)} (${sc.marginPercent}% margin)
  Labor ${sc.laborPercentOfRevenue}% of revenue (was ${sq.laborPercentOfRevenue}%)

PER PERSON, UNDER THIS SCENARIO
${workerLines}

COSTS UNDER THIS SCENARIO
${costLines}

GUARDRAILS THE MODEL RAISED
${warnLines}

CONTEXT FOR JUDGING FAIRNESS
Local market rate for lawn crew is roughly $15-18/hr; an experienced crew lead $19-24/hr. Federal minimum is $7.25 and North Carolina has no higher floor. Piece-rate pay must average at least the federal minimum in EVERY workweek, not on average across a season. Employees are W-2 and carry employer tax plus workers comp; contractors are 1099 and carry neither, but misclassification is a real legal risk and NC is not forgiving about it.

WHAT TO WRITE
Be specific and quantitative. Name people and numbers. Say plainly when the scenario is a bad idea, and say plainly when it is fine. Do not hedge everything into mush, and do not cheerlead. If the scenario improves margin by hurting one person disproportionately, lead with that. If the margin gain is real and the pay is still generous, say so.

Fill in every field of the required structure. "verdict" is one of strong, workable, risky or bad. "headline" is one sentence under 20 words saying what this scenario really does. "summary" is 2-4 sentences of plain assessment. "fairness" is 2-3 sentences on whether this is fair to the named workers, referencing their actual per-hour outcomes. "strengths" and "concerns" are specific and carry numbers. Each recommendation pairs what to change with the number that supports it. "questionsToResolve" are things the data cannot answer that the operator should check.`;
}
