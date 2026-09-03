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
import { simulate, defaultAssumptions, type Assumptions } from "@repo/money";

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
    const assumptions = forecast.assumptions as unknown as Assumptions;
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
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      });
      text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        parsed = JSON.parse(text.slice(start, end + 1));
      } else {
        parseError = "no JSON object in the response";
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

  const workerLines = sc.workers
    .filter((w) => w.clockedHours > 0)
    .map((w) => {
      const before = sq.workers.find((x) => x.userId === w.userId);
      const wasRate = before ? before.effectiveHourly : 0;
      return `  - ${w.name} (${w.workerType ?? "unclassified"}${w.isOwner ? ", OWNER" : ""}${w.hypothetical ? ", HYPOTHETICAL HIRE" : ""}): ${w.clockedHours}h, $${w.totalPay.toFixed(0)} total, $${w.effectiveHourly.toFixed(2)}/hr (was $${wasRate.toFixed(2)}/hr)`;
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
  Pay model: ${a.payModel}${a.payModel === "HOURLY_PLUS_SHARE" ? ` — $${a.hourlyBase}/hr base${a.leadHourlyBonus ? ` (+$${a.leadHourlyBonus}/hr lead)` : ""}` : ""}${a.payModel === "RATE_CARD" ? ` — $${a.rateCardPerJob} per job` : ""}
  Business keeps ${a.employeeMarginPercent}% from employees, ${a.contractorFeePercent}% from contractors
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

Respond with ONLY a JSON object in this exact shape:
{
  "verdict": "strong" | "workable" | "risky" | "bad",
  "headline": "One sentence, under 20 words, that says what this scenario really does.",
  "summary": "2-4 sentences of plain assessment.",
  "strengths": ["specific, with numbers"],
  "concerns": ["specific, with numbers"],
  "fairness": "2-3 sentences specifically on whether this is fair to the named workers, referencing their actual per-hour outcomes.",
  "recommendations": [
    { "action": "What to change", "why": "The reasoning, with the number that supports it" }
  ],
  "questionsToResolve": ["Things the data cannot answer that the operator should check"]
}`;
}
