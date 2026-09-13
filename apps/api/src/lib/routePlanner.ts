// ─────────────────────────────────────────────────────────────────────────────
// Building a day's route, deterministically.
//
// This replaced an LLM call. The division of labour was always lopsided: the
// routing provider solved the travelling-salesman part with real driving times
// and the model was told, in the prompt's own words, "the driving times above
// are REAL — use them instead of guessing". What was left for it was
// arithmetic (does the day fit in the stated hours), a sort key (has this
// worker been to this property before), and three lines of grey caption text.
//
// None of that needs a language model, and two of them are actively worse for
// having one:
//
//   • The budget is addition. A model asked to "do the math before selecting
//     jobs" can get it wrong, and did — a worker who had claimed 22 jobs for a
//     Saturday had most of the day binned against a 4-hour default he never
//     set. The prompt accumulated NEVER-REMOVE-A-JOB guardrails to push it
//     back toward what code does for free.
//
//   • A generated reason narrates an ordering it did not compute, so it can
//     say "closest to your previous stop" about a stop that is not. Rendered
//     as muted italic nobody scrutinises, a plausible wrong reason survives.
//     Every reason here is built from a number that is actually true.
//
// WHAT IS NOT HERE: the route itself. That stays with the routing provider.
// This takes its stop order and decides what to do with it.
// ─────────────────────────────────────────────────────────────────────────────

import { etFormatDateOpts, etMidnight, type EtDateKey } from "./dates";

/** A job as the preview route shapes it. */
export type PlannerJob = {
  id: string;
  jobId: string | null;
  type: "claimed" | "claimable";
  property: string;
  address: string;
  price: number | null;
  estimatedMinutes: number | null;
  currentDate: string | null;
};

/** One leg of the provider's optimized order. */
export type PlannerLeg = {
  /** Index into the jobs array. */
  inputIndex: number;
  /** Seconds and metres from the previous stop, as the provider measured. */
  durationFromPrev: number;
  distanceFromPrev: number;
};

export type PlannedStop = {
  occurrenceId: string;
  order: number;
  property: string;
  address: string;
  reason: string;
  dateChanged: boolean;
  originalDate: string | null;
  suggestedDate: string | null;
};

export type PlannedDay = {
  date: string;
  dayLabel: string;
  route: PlannedStop[];
  estimatedEarnings: number;
  estimatedHours: number;
  daySummary: string;
};

export type RoutePlan = {
  days: PlannedDay[];
  summary: string;
  totalEstimatedEarnings: number;
  dateChangeCount: number;
  additionalJobsToConsider: string[];
};

/** No estimate on the job — assume an hour, erring large, as the old prompt
 *  also instructed. */
const DEFAULT_JOB_MINUTES = 60;

/** The stated budget is a guide, not a wall: 5% over still counts as fitting.
 *  Same tolerance the prompt used. */
const BUDGET_TOLERANCE = 1.05;

const minutesOf = (j: PlannerJob) => j.estimatedMinutes ?? DEFAULT_JOB_MINUTES;

function fmtDuration(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

const fmtMiles = (metres: number) => `${Math.round((metres / 1609.34) * 10) / 10} mi`;

/**
 * Order the jobs.
 *
 * The provider's order wins for everything it could place. Jobs it could not
 * geocode keep their original relative order and go last — they have no
 * spatial information, so any position claiming otherwise would be a fiction.
 */
function orderJobs(jobs: PlannerJob[], legs: PlannerLeg[]): { job: PlannerJob; leg: PlannerLeg | null }[] {
  const placed = new Set<number>();
  const out: { job: PlannerJob; leg: PlannerLeg | null }[] = [];
  for (const leg of legs) {
    const job = jobs[leg.inputIndex];
    if (!job || placed.has(leg.inputIndex)) continue;
    placed.add(leg.inputIndex);
    out.push({ job, leg });
  }
  for (let i = 0; i < jobs.length; i++) {
    if (!placed.has(i)) out.push({ job: jobs[i], leg: null });
  }
  return out;
}

/**
 * The reason line for one stop — assembled from facts, never narrated.
 *
 * Every clause is something measured or looked up: a provider-reported drive
 * leg, a date the job is currently on, whether this worker has been to the
 * property, whether the running total has passed what they said they had.
 */
function buildReason(args: {
  index: number;
  leg: PlannerLeg | null;
  job: PlannerJob;
  familiar: boolean;
  movedFrom: string | null;
  pastBudget: boolean;
  fromCurrentLocation: boolean;
}): string {
  const { index, leg, job, familiar, movedFrom, pastBudget, fromCurrentLocation } = args;
  const parts: string[] = [];

  if (!leg) {
    parts.push(
      job.address === "No address"
        ? "No address on file — not included in distance optimisation"
        : "Couldn't be placed on the map — position is a guess",
    );
  } else if (index === 0) {
    parts.push(
      fromCurrentLocation
        ? `First stop — ${fmtDuration(leg.durationFromPrev / 60)} from where you are`
        : leg.durationFromPrev > 0
          ? `First stop — ${fmtDuration(leg.durationFromPrev / 60)} from your start`
          : "First stop",
    );
  } else {
    parts.push(`${fmtDuration(leg.durationFromPrev / 60)} / ${fmtMiles(leg.distanceFromPrev)} from the previous stop`);
  }

  if (movedFrom) parts.push(`moved from ${movedFrom} — needs the client's OK`);
  if (familiar) parts.push("you've serviced this property before");
  if (pastBudget) parts.push("past the hours you said you had — optional");

  return parts.join(" · ");
}

/**
 * Plan the day.
 *
 * CLAIMED MODE takes every claimed job, in the provider's order, on the target
 * day. No job is ever dropped and no budget is enforced: the worker already
 * committed to this work, and the question they asked was the ORDER.
 *
 * SUGGEST MODE keeps all the claimed work and appends the rest best-first —
 * cheapest additional driving, with a nudge toward familiar properties —
 * marking where the stated hours run out rather than truncating there. How
 * much of it they take on stays their call.
 */
export function planRoute(args: {
  jobs: PlannerJob[];
  legs: PlannerLeg[];
  targetDate: EtDateKey;
  mode: "claimed" | "suggest";
  /** 0 means the worker stated no budget — nothing is marked optional. */
  availableHours: number;
  bufferPercent: number;
  /** Property display names this worker has serviced before. */
  familiarProperties: Set<string>;
  fromCurrentLocation: boolean;
  totalDriveSeconds: number | null;
}): RoutePlan {
  const {
    jobs, legs, targetDate, mode, availableHours, bufferPercent,
    familiarProperties, fromCurrentLocation, totalDriveSeconds,
  } = args;

  // CLAIMED MODE IS CLAIMED WORK ONLY. The route fetches claimable jobs too
  // (the same query serves both modes), so without this the "just order what
  // I've already taken" view quietly grew suggestions — and counted them as
  // date changes. The old prompt said "Do not suggest additional jobs"; this
  // is that instruction as a filter rather than a request.
  const inScope = mode === "claimed" ? jobs.filter((j) => j.type === "claimed") : jobs;
  const keep = new Set(inScope.map((j) => j.id));
  const scopedLegs = legs.filter((l) => {
    const j = jobs[l.inputIndex];
    return !!j && keep.has(j.id);
  });
  // Re-point the leg indices at the filtered array.
  const indexById = new Map(inScope.map((j, i) => [j.id, i]));
  const remapped = scopedLegs.map((l) => ({
    ...l,
    inputIndex: indexById.get(jobs[l.inputIndex]!.id)!,
  }));

  const ordered = orderJobs(inScope, remapped);

  // Claimed work first and intact; extras after it, best-first. `sort` is
  // stable in Node, so the provider's order survives inside each group.
  const rank = (e: { job: PlannerJob; leg: PlannerLeg | null }) => {
    if (e.job.type === "claimed") return -1;
    // Cheaper detours first; a familiar property is worth a five-minute
    // detour, which is what the bonus below is scaled to.
    const driveMins = e.leg ? e.leg.durationFromPrev / 60 : 999;
    return driveMins - (familiarProperties.has(e.job.property) ? 5 : 0);
  };
  const sequence = mode === "suggest"
    ? ordered.slice().sort((a, b) => rank(a) - rank(b))
    : ordered;

  const budgetMins = availableHours > 0 ? availableHours * 60 * BUDGET_TOLERANCE : Infinity;

  // DRIVING THE DAY COSTS MORE THAN THE LEGS BETWEEN STOPS. On a round trip
  // the provider's total includes the leg home, which belongs to no stop and
  // so never showed up in the running total below — the budget understated the
  // day by exactly that drive, and the last suggestion could read as fitting
  // when it did not. Reserve the difference up front: it is a fixed cost of
  // working the day at all.
  const attributableMins = sequence.reduce((t, e) => t + (e.leg ? e.leg.durationFromPrev / 60 : 0), 0);
  const reservedDriveMins =
    totalDriveSeconds != null ? Math.max(0, totalDriveSeconds / 60 - attributableMins) : 0;

  const route: PlannedStop[] = [];
  let workMins = 0;
  let driveMins = 0;
  let earnings = 0;
  let dateChangeCount = 0;
  const additional: string[] = [];

  sequence.forEach((entry, i) => {
    const { job, leg } = entry;
    const jobMins = minutesOf(job) * (1 + bufferPercent / 100);
    const legMins = leg ? leg.durationFromPrev / 60 : 0;

    // Past the stated budget — reported, never used to drop the stop. A
    // claimed job is never "optional" regardless of the running total.
    const pastBudget =
      job.type !== "claimed"
      && reservedDriveMins + workMins + driveMins + jobMins + legMins > budgetMins;

    const movedFrom =
      job.type !== "claimed" && job.currentDate && job.currentDate !== targetDate
        ? job.currentDate
        : null;
    if (movedFrom) dateChangeCount++;
    if (job.type !== "claimed") additional.push(job.id);

    workMins += jobMins;
    driveMins += legMins;
    earnings += job.price ?? 0;

    route.push({
      occurrenceId: job.id,
      order: i + 1,
      property: job.property,
      address: job.address,
      reason: buildReason({
        index: i,
        leg,
        job,
        familiar: familiarProperties.has(job.property),
        movedFrom,
        pastBudget,
        fromCurrentLocation,
      }),
      dateChanged: !!movedFrom,
      originalDate: movedFrom,
      suggestedDate: movedFrom ? targetDate : null,
    });
  });

  // Prefer the provider's own total over the sum of the legs actually used —
  // it includes the return leg on a round trip, which no stop carries.
  const totalDrive = totalDriveSeconds != null ? totalDriveSeconds / 60 : driveMins;
  const estimatedHours = Math.round(((workMins + totalDrive) / 60) * 10) / 10;

  // Via the canonical ET helpers — etMidnight turns the day key into the
  // instant, etFormatDateOpts renders it in ET. Neither step touches the
  // server's clock or locale.
  const dayLabel = etFormatDateOpts(etMidnight(targetDate), { weekday: "long", month: "short", day: "numeric" });

  const daySummary = [
    `${route.length} stop${route.length === 1 ? "" : "s"}`,
    `${fmtDuration(workMins)} of work`,
    totalDrive > 0 ? `${fmtDuration(totalDrive)} driving` : null,
    earnings > 0 ? `$${earnings.toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");

  const overBudget = availableHours > 0 && workMins + totalDrive > budgetMins;
  const summary = mode === "claimed"
    ? `${route.length} claimed job${route.length === 1 ? "" : "s"} on ${dayLabel}, ordered for the shortest drive.`
    : [
        `${route.filter((s) => !additional.includes(s.occurrenceId)).length} claimed`,
        additional.length > 0 ? ` plus ${additional.length} suggested` : "",
        ` on ${dayLabel}.`,
        overBudget && availableHours > 0
          ? ` The full list runs past the ${availableHours}h you said you had — the later suggestions are the ones to drop.`
          : "",
      ].join("");

  return {
    days: [{
      date: targetDate,
      dayLabel,
      route,
      estimatedEarnings: Math.round(earnings * 100) / 100,
      estimatedHours,
      daySummary,
    }],
    summary,
    totalEstimatedEarnings: Math.round(earnings * 100) / 100,
    dateChangeCount,
    additionalJobsToConsider: additional,
  };
}
