/**
 * THE BOARD — the week's scoreboard shown on the day's first login.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN:
 *   • No money. Not per-person, not team total, not an average.
 *   • No hours per person.
 *   • No email, ever — a worker whose displayName is blank becomes "Worker",
 *     never their address. Worker views must not leak contact details.
 * Visits, acreage, properties and same-day closes only. A leaderboard that
 * carries money stops being a locker room and becomes a payroll dispute, and
 * this payload is read by every worker, not just admins.
 *
 * WEEK BOUNDARIES are Monday–Sunday in ET, via the canonical helpers — the
 * same rule Exports uses, never a rolling today-minus-7. A UTC week boundary
 * moves the whole board at 8pm ET on a Sunday.
 *
 * COST: the week queries are bounded to 14 days. `bestWeek` and the streak
 * need history, so they are bounded explicitly (104 weeks / 180 days) rather
 * than scanning the table — a scoreboard is not worth a full-table read on
 * every first login of the day.
 */

import { prisma } from "../db/prisma";
import { JobOccurrenceStatus, OccurrenceWorkflow } from "@prisma/client";
import {
  etAddDays,
  etEndOfDay,
  etFormatDate,
  etMidnight,
  etMondayOnOrBefore,
  etToday,
  etWeekStart,
  etClockTime,
  etFormatDateOpts,
  type EtDateKey,
} from "../lib/dates";

export type BoardWorker = {
  name: string;
  initials: string;
  visits: number;
  properties: number;
  sameDayCloses: number;
};

export type BoardData = {
  weekLabel: string;
  dayLabel: string;
  visitsThisWeek: number;
  visitsLastWeek: number;
  acres: number | null;
  properties: number;
  onTimePct: number | null;
  byDay: Array<{ day: string; visits: number | null; today: boolean }>;
  roster: BoardWorker[];
  bestWeek: { visits: number; when: string } | null;
  streakDays: number | null;
  ticker: string[];
  isSample: boolean;
};

/** Real visits only. Tasks, reminders, events, announcements and estimates
 *  are not work at a property and must never inflate a visit count. */
const REAL_WORK: OccurrenceWorkflow[] = [OccurrenceWorkflow.STANDARD, OccurrenceWorkflow.ONE_OFF];

/** A cancelled or archived visit did not happen, whatever its completedAt says. */
const NOT_COUNTED: JobOccurrenceStatus[] = [
  JobOccurrenceStatus.CANCELED,
  JobOccurrenceStatus.ARCHIVED,
];

/** Minutes after the scheduled start still counted as "on time". */
const ON_TIME_GRACE_MIN = 15;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Acreage, normalised. `lotSizeUnit` is free text on the model, so anything
 *  we do not recognise is dropped rather than guessed — a wrong acreage is
 *  worse than none, and the board renders "—" for null. */
function acresOf(lotSize: number | null, unit: string | null): number | null {
  if (lotSize == null || !Number.isFinite(lotSize) || lotSize <= 0) return null;
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "acres" || u === "acre" || u === "ac") return lotSize;
  if (u === "sqft" || u === "sq ft" || u === "square feet") return lotSize / 43560;
  if (u === "hectares" || u === "hectare" || u === "ha") return lotSize * 2.47105;
  return null;
}

type Row = {
  id: string;
  startAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  job: {
    property: { id: string; displayName: string; lotSize: number | null; lotSizeUnit: string | null } | null;
  } | null;
  assignees: Array<{ userId: string; role: string | null; user: { displayName: string | null } | null }>;
};

const SELECT = {
  id: true,
  startAt: true,
  startedAt: true,
  completedAt: true,
  job: {
    select: {
      property: { select: { id: true, displayName: true, lotSize: true, lotSizeUnit: true } },
    },
  },
  assignees: {
    select: { userId: true, role: true, user: { select: { displayName: true } } },
  },
} as const;

export const board = {
  async getBoard(): Promise<BoardData> {
    const todayKey = etToday();
    const thisMon = etMondayOnOrBefore();
    const lastMon = etAddDays(thisMon, -7);
    const thisSun = etAddDays(thisMon, 6);

    // ── the two weeks on the card ──────────────────────────────────────
    const rows = (await prisma.jobOccurrence.findMany({
      where: {
        completedAt: { gte: etMidnight(lastMon), lte: etEndOfDay(thisSun) },
        workflow: { in: REAL_WORK },
        status: { notIn: NOT_COUNTED },
      },
      select: SELECT,
    })) as unknown as Row[];

    const thisWeek: Row[] = [];
    const lastWeek: Row[] = [];
    for (const r of rows) {
      if (!r.completedAt) continue;
      const key = etFormatDate(r.completedAt);
      if (key >= thisMon) thisWeek.push(r);
      else lastWeek.push(r);
    }

    // ── by day, Mon–Sun ────────────────────────────────────────────────
    const byDay = DAY_NAMES.map((day, i) => {
      const key = etAddDays(thisMon, i);
      // A day still in the future is `null` (renders "–"), not a real zero.
      const future = key > todayKey;
      return {
        day,
        visits: future ? null : thisWeek.filter((r) => etFormatDate(r.completedAt!) === key).length,
        today: key === todayKey,
      };
    });

    // ── properties + acreage ───────────────────────────────────────────
    const propsThisWeek = new Map<string, { lotSize: number | null; unit: string | null }>();
    for (const r of thisWeek) {
      const p = r.job?.property;
      if (p) propsThisWeek.set(p.id, { lotSize: p.lotSize, unit: p.lotSizeUnit });
    }
    let acresSum = 0;
    let acresKnown = 0;
    for (const p of propsThisWeek.values()) {
      const a = acresOf(p.lotSize, p.unit);
      if (a != null) { acresSum += a; acresKnown += 1; }
    }
    // Parcel coverage is patchy (some counties publish nothing). A partial
    // sum presented as the week's acreage is a wrong number, so it is all or
    // nothing: below half coverage the tile shows "—" instead.
    const acres =
      propsThisWeek.size > 0 && acresKnown >= Math.ceil(propsThisWeek.size / 2)
        ? Math.round(acresSum * 10) / 10
        : null;

    // ── on time ────────────────────────────────────────────────────────
    const timed = thisWeek.filter((r) => r.startAt && r.startedAt);
    const onTimePct =
      timed.length === 0
        ? null
        : Math.round(
            (timed.filter(
              (r) => r.startedAt!.getTime() <= r.startAt!.getTime() + ON_TIME_GRACE_MIN * 60_000,
            ).length /
              timed.length) *
              100,
          );

    // ── roster ─────────────────────────────────────────────────────────
    const sameDay = (r: Row) =>
      !!r.startAt && !!r.completedAt && etFormatDate(r.startAt) === etFormatDate(r.completedAt);

    const byWorker = new Map<string, { name: string; visits: number; props: Set<string>; same: number }>();
    for (const r of thisWeek) {
      for (const a of r.assignees) {
        if (a.role === "observer") continue;
        // displayName or a neutral fallback — never the email address.
        const name = a.user?.displayName?.trim() || "Worker";
        const entry = byWorker.get(a.userId) ?? { name, visits: 0, props: new Set<string>(), same: 0 };
        entry.visits += 1;
        if (r.job?.property) entry.props.add(r.job.property.id);
        if (sameDay(r)) entry.same += 1;
        byWorker.set(a.userId, entry);
      }
    }
    const roster: BoardWorker[] = [...byWorker.values()]
      .map((w) => ({
        name: w.name,
        initials: initialsOf(w.name),
        visits: w.visits,
        properties: w.props.size,
        sameDayCloses: w.same,
      }))
      .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name))
      .slice(0, 8);

    // ── records (bounded history) ──────────────────────────────────────
    const histFrom = etAddDays(thisMon, -7 * 104);
    const history = await prisma.jobOccurrence.findMany({
      where: {
        completedAt: { gte: etMidnight(histFrom), lt: etMidnight(thisMon) },
        workflow: { in: REAL_WORK },
        status: { notIn: NOT_COUNTED },
      },
      select: { completedAt: true, startAt: true },
    });

    const perWeek = new Map<EtDateKey, number>();
    for (const h of history) {
      if (!h.completedAt) continue;
      const wk = etWeekStart(etFormatDate(h.completedAt));
      perWeek.set(wk, (perWeek.get(wk) ?? 0) + 1);
    }
    let bestWeek: BoardData["bestWeek"] = null;
    for (const [wk, n] of perWeek) {
      if (!bestWeek || n > bestWeek.visits) {
        bestWeek = { visits: n, when: etFormatDateOpts(etMidnight(wk), { day: "numeric", month: "short", year: "numeric" }) };
      }
    }

    // ── same-day streak, walking back from today ───────────────────────
    const dayMap = new Map<EtDateKey, { total: number; same: number }>();
    for (const h of [...history, ...rows]) {
      if (!h.completedAt) continue;
      const k = etFormatDate(h.completedAt);
      const e = dayMap.get(k) ?? { total: 0, same: 0 };
      e.total += 1;
      if (h.startAt && etFormatDate(h.startAt) === k) e.same += 1;
      dayMap.set(k, e);
    }
    let streakDays: number | null = 0;
    for (let i = 0; i < 180; i++) {
      const k = etAddDays(todayKey, -i);
      const e = dayMap.get(k);
      // A day with no work neither breaks the streak nor extends it —
      // weekends and rain days should not reset the count to zero.
      if (!e || e.total === 0) continue;
      if (e.same === e.total) streakDays += 1;
      else break;
    }
    if (streakDays === 0) streakDays = null;

    // ── ticker ─────────────────────────────────────────────────────────
    const ticker = [...thisWeek]
      .filter((r) => r.completedAt)
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
      .slice(0, 8)
      .map((r) => {
        const who = r.assignees.find((a) => a.role !== "observer")?.user?.displayName?.trim();
        const first = (who || "Crew").split(/\s+/)[0];
        const where = r.job?.property?.displayName ?? "a property";
        return `${first} closed ${where} ${etClockTime(r.completedAt!)}`;
      });

    return {
      weekLabel: `Week of ${etFormatDateOpts(etMidnight(thisMon), { day: "numeric", month: "short" })}`,
      dayLabel: etFormatDateOpts(etMidnight(todayKey), { weekday: "long" }),
      visitsThisWeek: thisWeek.length,
      visitsLastWeek: lastWeek.length,
      acres,
      properties: propsThisWeek.size,
      onTimePct,
      byDay,
      roster,
      bestWeek,
      streakDays,
      ticker,
      isSample: false,
    };
  },
};
