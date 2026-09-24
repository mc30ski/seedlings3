// ─────────────────────────────────────────────────────────────────────────────
// WALL DISPLAYS — pairing, tokens, and the two board payloads.
//
// See the `Display` model in schema.prisma for the security rationale. The
// short version: a display is a DEVICE, not a person. It holds a long-lived
// bearer token that only ever buys a board payload, and its `mode` decides
// which payload — enforced here, on the server, not by hiding fields in the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomInt } from "crypto";
import type { OccurrenceWorkflow } from "@prisma/client";
import { prisma } from "../db/prisma";
import { etToday, etMidnight, etEndOfDay, etAddDays, etAddMonths, etFormatDate } from "../lib/dates";
import { businessLatLng } from "../lib/businessLocation";
import { cached } from "../lib/cache";
import { fetchWeatherAlerts } from "./weatherAlerts";
import { buildLandingPageUrl, loadPromotionSettings } from "./promotions";

/** How long a pairing code is good for. Short on purpose: a code lying around
 *  for hours is a code someone can be talked into approving. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** A display is "live" if it has polled inside this window. The device polls
 *  every 30-60s, so two minutes is a couple of missed beats — long enough not
 *  to flicker, short enough that a dead TV reads as dead. */
export const LIVE_WINDOW_MS = 2 * 60 * 1000;

/** Past this, it is not "stale", it is off. */
export const OFFLINE_WINDOW_MS = 15 * 60 * 1000;

export function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** The device's own secret: long, random, never displayed. What it actually
 *  authenticates the pairing with. */
export function newDeviceSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The bearer token a paired display keeps. */
export function newDisplayToken(): string {
  return randomBytes(32).toString("hex");
}

/** Six digits, shown on the wall. `randomInt` rather than `Math.random` — this
 *  is the handle a human types to authorize a device, so it should not be
 *  predictable even though it is short-lived and single-use. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// ── Names and places, trimmed for a wall ─────────────────────────────────────

/** First name plus last initial. Even the back-office board is read by
 *  delivery drivers and the occasional client dropping off a check, so a full
 *  roster of surnames on the wall buys nothing the crew does not already know. */
export function shortPersonName(u: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
}): string {
  const first = (u.firstName ?? "").trim();
  const last = (u.lastName ?? "").trim();
  if (first) return last ? `${first} ${last[0]}.` : first;
  const display = (u.displayName ?? "").trim();
  if (!display) return "Unknown";
  const parts = display.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** Street name without the number. The crew already knows where they are
 *  going — the board answers "who and what", not "navigate me there" — and a
 *  house number is the single most identifying thing in an address. */
export function shortPlace(p?: { street1?: string | null; city?: string | null } | null): string {
  if (!p) return "";
  const street = (p.street1 ?? "").trim();
  if (!street) return (p.city ?? "").trim();
  return street.replace(/^\s*\d+[A-Za-z]?\s+/, "").trim() || street;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export async function startPairing(meta: { ip?: string | null; userAgent?: string | null }) {
  const deviceSecret = newDeviceSecret();

  // Codes are unique and short, so on the (vanishingly rare) collision just
  // try again rather than handing back someone else's pending request.
  //
  // EVERY candidate is checked, including the last. The previous shape
  // generated a replacement at the end of the final iteration and then fell
  // out of the loop without testing it, so an exhausted retry budget handed
  // an unverified code to `create` and surfaced as a unique-constraint 500 on
  // a screen that can only report it as a blank pairing panel.
  let code: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = newPairingCode();
    const clash = await prisma.displayPairing.findUnique({ where: { code: candidate } });
    if (!clash) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("Could not allocate an unused pairing code.");

  // audit-allow: a pairing REQUEST is not a state change worth a row — any
  // device that loads /display creates one, and most expire unapproved. The
  // approval is the security event, and admin.ts audits that.
  const pairing = await prisma.displayPairing.create({
    data: {
      code,
      deviceSecretHash: hashSecret(deviceSecret),
      requestedIp: meta.ip ?? null,
      requestedUserAgent: meta.userAgent ?? null,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    },
  });

  return { code: pairing.code, deviceSecret, expiresAt: pairing.expiresAt };
}

/** Housekeeping. Expired and consumed rows have no further use, and a table of
 *  stale codes is a table someone can fish in. */
export async function purgeDeadPairings() {
  // audit-allow: housekeeping. Deletes only rows that are already expired or
  // long consumed, and carries no information a trail would want.
  await prisma.displayPairing.deleteMany({
    where: {
      OR: [
        // NOT an approved request whose token is still uncollected. Deleting
        // one of those destroys the only plaintext copy of a token a Display
        // row already depends on, leaving a screen that can never connect and
        // an entry nobody holds. An approved request survives until the device
        // picks it up, and the `consumedAt` clause below sweeps it afterwards.
        { expiresAt: { lt: new Date() }, approvedAt: null },
        { consumedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
      ],
    },
  });
}


// ── Weather ──────────────────────────────────────────────────────────────────

export type BoardWeather = {
  tempF: number;
  description: string;
  icon: string;
  highF: number;
  lowF: number;
  rainChance: number;
  alerts: { event: string; severity: string }[];
  /** The next few days, today excluded. Empty when the forecast endpoint
   *  gave us nothing usable — the strip simply does not render. */
  forecast: {
    /** ET date key. The client formats the weekday from it, so the board
     *  never has to agree with the server about what "Thursday" means. */
    dateKey: string;
    highF: number;
    lowF: number;
    rainChance: number;
    icon: string;
  }[];
} | null;

/** A deliberately thin slice of what /weather returns — the display needs a
 *  number, a word and whether it is about to rain, not the five-day bar.
 *
 *  SHARES THE APP'S CACHE. Same `cached("openWeather", ...)` namespace and the
 *  same two-decimal coordinate key the worker route uses, so a display polling
 *  every 45 seconds rides the entry the rest of the app already populated
 *  rather than doubling the calls to a metered API. */
/** The next three days, folded out of the 3-hourly forecast list.
 *
 *  GROUPED BY ET DATE, FROM THE EPOCH. Every entry also carries a `dt_txt`
 *  string, which is tempting and wrong: it is UTC, so from about 8pm ET
 *  onwards its date has already rolled over and a day's entries land in the
 *  wrong bucket. `dt` is an instant; `etFormatDate` is the only thing that
 *  turns an instant into the day the business is actually having.
 *
 *  Today is excluded on purpose — the big number above the strip already IS
 *  today, and repeating it costs a column that could show Thursday. */
function buildForecastDays(
  list: any[],
  todayKey: string,
): { dateKey: string; highF: number; lowF: number; rainChance: number; icon: string }[] {
  const byDay = new Map<string, any[]>();
  for (const e of list) {
    if (!e?.dt) continue;
    const key = etFormatDate(new Date(e.dt * 1000));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(e);
    else byDay.set(key, [e]);
  }

  const out: { dateKey: string; highF: number; lowF: number; rainChance: number; icon: string }[] = [];
  for (let i = 1; i <= 3; i++) {
    const key = etAddDays(todayKey as any, i) as unknown as string;
    const entries = byDay.get(key);
    // The 5-day endpoint thins out at the far end; a missing day is skipped
    // rather than rendered as a column of zeroes.
    if (!entries || entries.length === 0) continue;

    const temps = entries.map((e) => e.main?.temp ?? 0);
    const highF = Math.round(Math.max(...entries.map((e) => e.main?.temp_max ?? e.main?.temp ?? 0), ...temps));
    const lowF = Math.round(Math.min(...entries.map((e) => e.main?.temp_min ?? e.main?.temp ?? 0), ...temps));
    const rainChance = Math.max(...entries.map((e) => Math.round((e.pop ?? 0) * 100)));

    // The day's most common condition, forced to its DAY variant: these are
    // whole-day summaries and half the samples are after dark, so picking
    // the raw winner regularly put a moon on a sunny Thursday.
    const tally = new Map<string, number>();
    for (const e of entries) {
      const raw = e.weather?.[0]?.icon;
      if (!raw) continue;
      const day = String(raw).replace(/n$/, "d");
      tally.set(day, (tally.get(day) ?? 0) + 1);
    }
    let icon = "";
    let best = 0;
    for (const [k, n] of tally) if (n > best) { icon = k; best = n; }

    out.push({ dateKey: key, highF, lowF, rainChance, icon });
  }
  return out;
}

export async function buildBoardWeather(): Promise<BoardWeather> {
  try {
    const loc = await businessLatLng();
    if (!loc) return null;

    const keySetting = await prisma.setting.findUnique({ where: { key: "WEATHER_API_KEY" } });
    const apiKey = keySetting?.value || process.env.OPENWEATHER_API_KEY;
    if (!apiKey) return null;

    const wxKey = `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}`;
    const { value: wx } = await cached("openWeather", wxKey, async () => {
      const [currentRes, forecastRes] = await Promise.all([
        fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${loc.lat}&lon=${loc.lng}&units=imperial&appid=${apiKey}`),
        fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${loc.lat}&lon=${loc.lng}&units=imperial&appid=${apiKey}`),
      ]);
      if (!currentRes.ok) throw new Error(`Weather API returned ${currentRes.status}`);
      if (!forecastRes.ok) throw new Error(`Forecast API returned ${forecastRes.status}`);
      return { current: await currentRes.json(), forecast: await forecastRes.json() };
    });

    const current: any = wx.current;
    const todayKey = etToday();
    const todayEntries = ((wx.forecast?.list ?? []) as any[]).filter(
      (e) => e.dt_txt?.split(" ")[0] === todayKey,
    );

    // Same correction the weather bar makes: on the CURRENT endpoint
    // temp_max/min are the spread of nearby stations right now, not a daily
    // forecast, so the high must fold in the forecast entries or a 97-degree
    // day reads as 83.
    const observed = current?.main?.temp ?? 0;
    const high = Math.max(
      ...todayEntries.map((e) => e.main?.temp_max ?? e.main?.temp ?? 0),
      observed,
      current?.main?.temp_max ?? observed,
    );
    const low = Math.min(
      ...todayEntries.map((e) => e.main?.temp_min ?? e.main?.temp ?? 0),
      observed,
      current?.main?.temp_min ?? observed,
    );

    // Alerts fetched separately and never folded into the Promise.all above:
    // fetchWeatherAlerts never throws, and an NWS outage must not take the
    // temperature down with it.
    const alerts = await fetchWeatherAlerts(loc.lat, loc.lng);

    return {
      tempF: Math.round(observed),
      description: current?.weather?.[0]?.description ?? "",
      icon: current?.weather?.[0]?.icon ?? "",
      highF: Math.round(high),
      lowF: Math.round(low),
      rainChance: todayEntries.length
        ? Math.max(...todayEntries.map((e) => Math.round((e.pop ?? 0) * 100)))
        : 0,
      alerts: alerts.slice(0, 2).map((a) => ({ event: a.event, severity: a.severity })),
      forecast: buildForecastDays(wx.forecast?.list ?? [], todayKey),
    };
  } catch {
    // Weather is decoration on a board whose job is jobs. A metered API being
    // down must never take the board with it.
    return null;
  }
}

// ── Board payloads ───────────────────────────────────────────────────────────

export type BoardWorker = {
  id: string;
  name: string;
  clockedInAt: string;
  onBreak: boolean;
  jobs: { id: string; title: string; place: string; status: string }[];
};

export type BoardJob = {
  id: string;
  title: string;
  client: string | null;
  place: string;
  status: string;
  startAt: string | null;
  crew: string[];
};

export type PrivateBoard = {
  mode: "PRIVATE";
  generatedAt: string;
  dateKey: string;
  onTheClock: BoardWorker[];
  /** Workers with work assigned today who have NOT clocked in. The clock and
   *  the job board disagree constantly in real use, and the disagreement is
   *  usually the most useful thing on the screen. */
  assignedNotClockedIn: { id: string; name: string; jobs: number }[];
  jobs: BoardJob[];
  /** Out right now, both of which move through the day — which is what makes
   *  them worth a panel on a board that refreshes. "In use" is an OPEN record
   *  in each case: a mileage entry with no end, a checkout with no release. */
  vehiclesOut: { id: string; name: string; driver: string; since: string }[];
  equipmentOut: { id: string; name: string; holder: string }[];
  counts: { done: number; inProgress: number; remaining: number; total: number };
  attention: { kind: string; label: string; detail: string }[];
  /** TODAY'S finished work only — not the public wall's trailing week. Same
   *  shape as the public board's so one tile component serves both. */
  photos: { id: string; url: string; takenAt: string }[];
  weather: BoardWeather;
};

export type PublicBoard = {
  mode: "PUBLIC";
  generatedAt: string;
  /** Today, live. The week/month figures barely move, so a board built only
   *  from those looks identical hour to hour and the polling has nothing to
   *  show. These three change as the day is worked. */
  today: { scheduled: number; inProgress: number; completed: number };
  completed: { today: number; week: number; month: number; quarter: number; year: number };
  photos: { id: string; url: string; takenAt: string }[];
  promotions: {
    id: string; headline: string; body: string | null; url: string | null;
    /** The campaign's own artwork, cover first. Empty for a text-only promo,
     *  which the board still shows — it just has nothing to illustrate. */
    photos: { id: string; url: string }[];
    /** The individual services this campaign is selling, in the operator's
     *  order. This is what the board pages through; the campaign headline is
     *  the cover, these are the contents. */
    items: {
      id: string; title: string; body: string;
      photo: { id: string; url: string } | null;
    }[];
  }[];
  company: { name: string | null; phone: string | null; email: string | null; serviceArea: string | null };
  weather: BoardWeather;
};

/** Statuses that mean "this visit is finished as far as the field is
 *  concerned". PENDING_PAYMENT is work done — it is a money state, not a
 *  field state, and a board that showed it as outstanding would have the crew
 *  chasing a job they already finished. */
const DONE_STATUSES = ["COMPLETED", "PENDING_PAYMENT", "CLOSED"] as const;
const ACTIVE_STATUSES = ["IN_PROGRESS", "PAUSED"] as const;

/** The public counts are about WORK, so internal workflow rows — a reminder, a
 *  task, a follow-up — must not inflate them. A client reading "9 scheduled"
 *  should be able to believe nine properties get visited. */
const NON_JOB_WORKFLOWS: OccurrenceWorkflow[] = ["TASK", "REMINDER", "FOLLOWUP", "EVENT"];
const NON_JOB_WORKFLOW_EXCLUSION = { workflow: { notIn: NON_JOB_WORKFLOWS } };

/** FINISHED FIELD WORK IN A WINDOW — the one filter every "work completed"
 *  figure on the public board is built from.
 *
 *  A function rather than five `where` clauses on purpose. The five running
 *  totals and the two today-counts beside them have to agree about what
 *  counts as work, and when they were written out by hand they did not: the
 *  totals were missing the workflow exclusion and their upper bound. Numbers
 *  that sit side by side on a wall must be produced by the same rule, because
 *  nothing about looking at them reveals that they were not. */
const doneWorkBetween = (from: Date, to: Date) => ({
  startAt: { gte: from, lte: to },
  status: { in: [...DONE_STATUSES] },
  ...NON_JOB_WORKFLOW_EXCLUSION,
});

/** Never on a board: cancelled, archived, and the estimate-proposal states,
 *  which are sales workflow rather than field work. */
const OFF_BOARD_STATUSES = ["CANCELED", "ARCHIVED", "REJECTED", "PROPOSAL_SUBMITTED"] as const;

export async function buildPrivateBoard(): Promise<PrivateBoard> {
  const dateKey = etToday();
  const dayStart = etMidnight(dateKey);
  const dayEnd = etEndOfDay(dateKey);

  const [workdays, occurrences, overdue, vehicleTrips, checkouts, weather, todayPhotos] = await Promise.all([
    prisma.workerWorkday.findMany({
      where: { workdayDate: dateKey, endedAt: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, displayName: true } },
      },
      orderBy: { startedAt: "asc" },
    }),
    prisma.jobOccurrence.findMany({
      where: {
        startAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: [...OFF_BOARD_STATUSES] },
      },
      include: {
        job: {
          select: {
            property: { select: { street1: true, city: true, client: { select: { displayName: true } } } },
          },
        },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, displayName: true } },
          },
        },
      },
      orderBy: [{ startAt: "asc" }],
    }),
    // Anything scheduled before today that never finished. This is the queue
    // that actually costs money to ignore.
    prisma.jobOccurrence.findMany({
      where: {
        startAt: { gte: etMidnight(etAddDays(dateKey, -30)), lt: dayStart },
        status: { in: ["SCHEDULED", ...ACTIVE_STATUSES] },
      },
      select: { id: true },
    }),
    // A vehicle is "in use" while its mileage entry is still open — the driver
    // started a trip and has not closed it.
    prisma.mileageEntry.findMany({
      where: { endedAt: null },
      orderBy: { startedAt: "asc" },
      select: {
        id: true,
        startedAt: true,
        vehicle: { select: { displayName: true } },
        driver: { select: { firstName: true, lastName: true, displayName: true } },
      },
    }),
    // Same shape for equipment: checked out and not yet released.
    prisma.checkout.findMany({
      where: { releasedAt: null },
      orderBy: { checkedOutAt: "asc" },
      take: 12,
      select: {
        id: true,
        equipment: { select: { type: true, brand: true, model: true, shortDesc: true } },
        user: { select: { firstName: true, lastName: true, displayName: true } },
      },
    }),
    buildBoardWeather(),
    // TODAY'S PHOTOS ONLY. The public wall trails seven days because it is
    // ambient and wants depth; the back office is a board about this shift,
    // and a photo from Tuesday sitting on it reads as something that just
    // came in.
    //
    // Same two filters as the public wall, and they are not optional here
    // either: /public/display/photo/:photoId refuses a hidden photo, and one
    // whose visit is not finished, for EVERY token whatever its mode. A
    // private board that selected more broadly would emit URLs that 404 and
    // render as a row of broken tiles.
    prisma.jobOccurrencePhoto.findMany({
      where: {
        hiddenFromPublicAt: null,
        occurrence: {
          status: { in: [...DONE_STATUSES] },
          startAt: { gte: dayStart, lte: dayEnd },
          ...NON_JOB_WORKFLOW_EXCLUSION,
        },
      },
      orderBy: { createdAt: "desc" },
      // A strip, not a wall. It shows what today looked like at a glance and
      // is deliberately shallower than the public pool's 300.
      take: 40,
      select: { id: true, createdAt: true },
    }),
  ]);

  const titleOf = (o: (typeof occurrences)[number]) =>
    (o.title ?? "").trim() || (o.jobType ?? "").trim() || "Visit";
  const placeOf = (o: (typeof occurrences)[number]) => shortPlace(o.job?.property);

  const jobs: BoardJob[] = occurrences.map((o) => ({
    id: o.id,
    title: titleOf(o),
    client: o.job?.property?.client?.displayName ?? null,
    place: placeOf(o),
    status: o.status,
    startAt: o.startAt ? o.startAt.toISOString() : null,
    crew: o.assignees.map((a) => shortPersonName(a.user)),
  }));

  // Jobs per worker, so the clock rows can say what each person is actually on.
  const jobsByUser = new Map<string, BoardJob[]>();
  for (const o of occurrences) {
    for (const a of o.assignees) {
      const list = jobsByUser.get(a.userId) ?? [];
      list.push({
        id: o.id,
        title: titleOf(o),
        client: o.job?.property?.client?.displayName ?? null,
        place: placeOf(o),
        status: o.status,
        startAt: o.startAt ? o.startAt.toISOString() : null,
        crew: [],
      });
      jobsByUser.set(a.userId, list);
    }
  }

  const onTheClock: BoardWorker[] = workdays.map((w) => ({
    id: w.userId,
    name: shortPersonName(w.user),
    clockedInAt: w.startedAt.toISOString(),
    onBreak: w.pausedAt != null,
    jobs: (jobsByUser.get(w.userId) ?? [])
      .filter((j) => !DONE_STATUSES.includes(j.status as any))
      .map((j) => ({ id: j.id, title: j.title, place: j.place, status: j.status })),
  }));

  // The other half of the truth: assigned work with nobody on the clock.
  const clockedInIds = new Set(workdays.map((w) => w.userId));
  const assignedNotClockedIn = [...jobsByUser.entries()]
    .filter(([userId]) => !clockedInIds.has(userId))
    .map(([userId, list]) => {
      const assignee = occurrences
        .flatMap((o) => o.assignees)
        .find((a) => a.userId === userId);
      return {
        id: userId,
        name: assignee ? shortPersonName(assignee.user) : "Unknown",
        jobs: list.filter((j) => !DONE_STATUSES.includes(j.status as any)).length,
      };
    })
    .filter((r) => r.jobs > 0);

  const done = jobs.filter((j) => DONE_STATUSES.includes(j.status as any)).length;
  const inProgress = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status as any)).length;

  const unclaimed = occurrences.filter(
    (o) => o.status === "SCHEDULED" && o.assignees.length === 0,
  ).length;

  // Usually empty, and that is the point — an alert strip that is blank most
  // days is one people actually look at when it lights up.
  const attention: PrivateBoard["attention"] = [];
  if (unclaimed > 0) {
    attention.push({
      kind: "unclaimed",
      label: `${unclaimed} unclaimed`,
      detail: unclaimed === 1 ? "a visit today has nobody on it" : "visits today with nobody on them",
    });
  }
  if (overdue.length > 0) {
    attention.push({
      kind: "overdue",
      label: `${overdue.length} overdue`,
      detail: "scheduled before today and never finished",
    });
  }
  if (assignedNotClockedIn.length > 0) {
    attention.push({
      kind: "not_clocked_in",
      label: `${assignedNotClockedIn.length} not clocked in`,
      detail: assignedNotClockedIn.map((r) => r.name).join(", "),
    });
  }

  return {
    mode: "PRIVATE",
    generatedAt: new Date().toISOString(),
    dateKey,
    onTheClock,
    assignedNotClockedIn,
    jobs,
    vehiclesOut: vehicleTrips.map((t) => ({
      id: t.id,
      name: t.vehicle?.displayName ?? "Vehicle",
      driver: t.driver ? shortPersonName(t.driver) : "Unknown",
      since: t.startedAt.toISOString(),
    })),
    equipmentOut: checkouts.map((c) => ({
      id: c.id,
      // Equipment has no single name column — a readable label is assembled
      // from whichever of these it actually has.
      name:
        [c.equipment?.shortDesc, c.equipment?.brand, c.equipment?.model, c.equipment?.type]
          .map((x) => (x ?? "").trim())
          .find(Boolean) ?? "Equipment",
      holder: c.user ? shortPersonName(c.user) : "Unknown",
    })),
    counts: { done, inProgress, remaining: jobs.length - done - inProgress, total: jobs.length },
    photos: todayPhotos.map((p) => ({
      id: p.id,
      url: `/api/public/display/photo/${p.id}`,
      takenAt: p.createdAt.toISOString(),
    })),
    attention,
    weather,
  };
}

/** WHO IS WORKING IS NOT ON THIS BOARD.
 *
 *  The waiting-room screen used to lead with an "Out today" panel listing the
 *  crew's first names. It was the one thing on the public board that named a
 *  person, and it is gone — along with the workday query behind it, so the
 *  names are no longer read, let alone sent. A field the client does not
 *  render is still a field on the wire, and this screen's payload travels to a
 *  device sitting in a room full of strangers.
 *
 *  The private board still shows who is on the clock. That one is in the back
 *  office, and that is the whole difference between the two. */
export async function buildPublicBoard(): Promise<PublicBoard> {
  const dateKey = etToday();
  const dayStart = etMidnight(dateKey);
  // TRAILING windows — today, plus the period behind it — not calendar periods.
  //
  // These were calendar-to-date for a while and it was wrong on a wall. The
  // board was read on a MONDAY and "this week" said 0, because a Monday-start
  // calendar week had begun that morning and a full weekend of finished work
  // had just dropped into "last week". A board that reports zero on the
  // morning after a busy weekend is worse than one that reports nothing.
  //
  // The same reasoning applies on the 1st of a month, the 1st of a quarter and
  // the 1st of January — three more days a year where a calendar window resets
  // to almost nothing while the crews have plainly been working.
  //
  // NOTE FOR ANYONE TEMPTED TO ALIGN THESE WITH THE EXPORTS: don't. Exports
  // and Reconcile deliberately use the CALENDAR week (Mon-Sun) because they
  // close a period for payroll. This board answers "how much have we been
  // getting done lately", which is a trailing question. Same words, different
  // jobs.
  //
  // Months are stepped as whole months rather than 30/90/365 days so the
  // window does not drift against the calendar across a year.
  const weekStart = etMidnight(etAddDays(dateKey, -6)); // today + the 6 before = 7 days
  const monthStart = etMidnight(etAddMonths(dateKey, -1));
  const quarterStart = etMidnight(etAddMonths(dateKey, -3));
  const yearStart = etMidnight(etAddMonths(dateKey, -12));

  const dayEnd = etEndOfDay(dateKey);
  const [
    doneToday, doneWeek, doneMonth, doneQuarter, doneYear,
    scheduledToday, inProgressToday, photos, promos, settings, weather,
  ] = await Promise.all([
    // ALL FIVE THROUGH ONE FILTER. They were five hand-written `where`
    // clauses, and every one of them had drifted from the two counts below:
    // no workflow exclusion, so completed reminders, tasks, follow-ups and
    // events were counted as work done, and no upper bound, so anything
    // finished but dated in the future counted too.
    //
    // The result sat on the public wall as "1 scheduled today" — jobs only —
    // beside a completed figure that also carried internal admin rows. The
    // rule those two counts follow is written out immediately below; these
    // five broke it silently because nobody reconciles a running total by eye.
    prisma.jobOccurrence.count({ where: doneWorkBetween(dayStart, dayEnd) }),
    prisma.jobOccurrence.count({ where: doneWorkBetween(weekStart, dayEnd) }),
    prisma.jobOccurrence.count({ where: doneWorkBetween(monthStart, dayEnd) }),
    prisma.jobOccurrence.count({ where: doneWorkBetween(quarterStart, dayEnd) }),
    prisma.jobOccurrence.count({ where: doneWorkBetween(yearStart, dayEnd) }),
    // Counts only — no client, no property, no address. A number cannot
    // identify anyone, which is why these are safe on a public screen when
    // the job list behind them is not.
    prisma.jobOccurrence.count({
      where: {
        startAt: { gte: dayStart, lte: dayEnd },
        status: "SCHEDULED",
        ...NON_JOB_WORKFLOW_EXCLUSION,
      },
    }),
    prisma.jobOccurrence.count({
      where: {
        startAt: { gte: dayStart, lte: dayEnd },
        status: { in: [...ACTIVE_STATUSES] },
        ...NON_JOB_WORKFLOW_EXCLUSION,
      },
    }),
    // Recent job photos, newest first, automatically — the same instinct as
    // the client-facing photo lists: show what is latest. Only photos someone
    // deliberately pulled down are excluded.
    //
    // Scoped to FINISHED work. A photo from a visit still in progress would
    // tell a waiting client roughly where the crews are right now, which is
    // the same thing the rest of the public board is careful not to say.
    prisma.jobOccurrencePhoto.findMany({
      where: {
        hiddenFromPublicAt: null,
        occurrence: {
          status: { in: [...DONE_STATUSES] },
          // Field work only, like every other figure on this board. A photo
          // attached to a completed reminder or an internal task is not a
          // picture of a lawn, and the waiting room is the wrong place to
          // find out what it is a picture of.
          ...NON_JOB_WORKFLOW_EXCLUSION,
        },
      },
      orderBy: { createdAt: "desc" },
      // A DEEP pool, because the wall cycles through it rather than showing a
      // fixed six. The payload carries ids and URLs only — the images
      // themselves are fetched lazily as each tile turns over, so depth costs
      // almost nothing until it is actually shown.
      //
      // 60 was too shallow: a single job can carry twenty photos, so sixty
      // newest could be three jobs and the wall would look like the company
      // only worked three properties.
      take: 300,
      select: { id: true, r2Key: true, createdAt: true, occurrenceId: true },
    }),
    prisma.promotion.findMany({
      // THE WALL IS A CHOICE, NOT A CONSEQUENCE OF BEING ACTIVE.
      //
      // This filtered on status alone, so every live campaign went up on a
      // screen in a room full of strangers whether or not it was written for
      // one — a promo aimed at a single client's invoice had no way to say
      // no. `external_display` is that way of saying no, and it lives in the
      // Promotions editor beside the invoice checkbox.
      where: {
        status: "ACTIVE",
        displaySurfaces: { array_contains: ["external_display"] },
      },
      orderBy: { startAt: "desc" },
      take: 5,
      select: {
        id: true, title: true, content: true,
        landingPage: {
          select: {
            slug: true,
            // THE ACTUAL OFFERS. A campaign is one headline over a LIST of
            // services, and these rows are that list — "Overgrowth & Brush
            // Clearing", "Limb & Debris Hauling", each with its own words and
            // its own photograph. The board walked the campaign's invoice
            // artwork instead and showed the same sentence twice, which is
            // what a single cover image looks like when you mistake it for a
            // catalogue.
            items: {
              orderBy: { ordinal: "asc" },
              take: 8,
              select: {
                id: true,
                title: true,
                description: true,
                photos: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } },
              },
            },
          },
        },
        // The campaign's own artwork. Same rows the invoice page draws on —
        // sortOrder 0 is the cover the operator chose, so the wall leads with
        // the same image a client sees on their invoice rather than picking
        // one of its own.
        invoicePhotos: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 6 },
      },
    }),
    prisma.setting.findMany({
      where: { key: { in: ["BUSINESS_NAME", "BUSINESS_PHONE", "BUSINESS_EMAIL", "BUSINESS_SERVICE_AREA"] } },
    }),
    buildBoardWeather(),
  ]);

  const setting = (k: string) => settings.find((s) => s.key === k)?.value ?? null;

  // The host a campaign's landing links should carry. Same resolution the
  // invoice surface uses, so a screen and a bill send people to the same
  // place rather than to two spellings of it.
  const promoSettings = await loadPromotionSettings();
  const promoBase = promoSettings.landingBaseUrl || promoSettings.baseUrl;

  // INTERLEAVED BY JOB, so consecutive tiles come from different properties.
  //
  // Depth alone does not fix variety: newest-first means one job that shot
  // twenty photos occupies the front of the queue, and the wall spends three
  // minutes on a single lawn before reaching anything else. Round-robin across
  // occurrences — one photo from each job in turn, then a second from each —
  // keeps every photo eligible (nothing is dropped) while spreading the jobs
  // across the rotation.
  //
  // Deterministic rather than shuffled: the wall works through the whole pool
  // predictably, and a display that reloads does not jump to a random place.
  const byOccurrence = new Map<string, typeof photos>();
  for (const p of photos) {
    const list = byOccurrence.get(p.occurrenceId) ?? [];
    list.push(p);
    byOccurrence.set(p.occurrenceId, list);
  }
  const queues = [...byOccurrence.values()];
  const interleaved: typeof photos = [];
  for (let round = 0; interleaved.length < photos.length; round++) {
    let tookAny = false;
    for (const q of queues) {
      if (round < q.length) {
        interleaved.push(q[round]);
        tookAny = true;
      }
    }
    if (!tookAny) break; // exhausted — cannot happen, but never loop forever
  }

  // Served through the API, not as presigned R2 links — the route strips EXIF
  // from the copy it hands over, and the URL dies with the display's token.
  // See /public/display/photo/:photoId.
  const photoUrls = interleaved.map((p) => ({
    id: p.id,
    url: `/api/public/display/photo/${p.id}`,
    takenAt: p.createdAt.toISOString(),
  }));

  return {
    mode: "PUBLIC",
    generatedAt: new Date().toISOString(),
    today: { scheduled: scheduledToday, inProgress: inProgressToday, completed: doneToday },
    completed: {
      today: doneToday, week: doneWeek, month: doneMonth,
      quarter: doneQuarter, year: doneYear,
    },
    photos: photoUrls,
    // THE CUSTOMER-FACING COPY, not the operator's note.
    //
    // `description` is how the campaign is labelled INSIDE the app — the
    // seeded one reads "Piggyback fall/winter service promo. Points at the
    // in-app landing page ... so you can exercise the click wrapper", which is
    // a note to whoever built it and was going up on the waiting-room wall.
    //
    // The real wording lives in `content`. `shared` is canonical, but a
    // campaign that only ever ships on one channel writes it there instead, so
    // resolve in the order that best suits a screen: the invoice page is the
    // other RENDERED surface, email is long-form, and SMS comes last because
    // it is written to 160 characters and reads clipped when given room.
    //
    // `title` is fine as a headline — "Fall Offers 2026" is customer-facing.
    // It is never used as the BODY, which is where the internal note lived.
    promotions: promos
      .map((p) => {
        const c = (p.content ?? {}) as Record<string, { headline?: string; body?: string } | undefined>;
        const pick = (k: string, f: "headline" | "body") => c[k]?.[f]?.trim() || "";
        const headline =
          pick("shared", "headline") ||
          pick("invoice_page", "headline") ||
          p.title?.trim() ||
          "";
        const body =
          pick("shared", "body") ||
          pick("invoice_page", "body") ||
          pick("email", "body") ||
          pick("sms", "body") ||
          "";
        return {
          id: p.id,
          headline,
          body: body || null,
          // `/motion/` was hardcoded here. That segment is only correct on
          // the marketing domain — buildLandingPageUrl picks it from the
          // host, and everywhere else the path is `/promotion/`. Harmless
          // while nothing rendered the link; wrong the moment anything did.
          url: p.landingPage?.slug
            ? buildLandingPageUrl(promoBase, p.landingPage.slug)
            : null,
          // Served through the API like every other image a display shows —
          // token-gated, metadata stripped, dead the moment the screen is
          // revoked. A presigned R2 link would outlive the display.
          photos: p.invoicePhotos.map((ph) => ({
            id: ph.id,
            url: `/api/public/display/promo-photo/${ph.id}`,
          })),
          items: (p.landingPage?.items ?? []).map((it) => ({
            id: it.id,
            title: it.title,
            body: it.description,
            photo: it.photos[0]
              ? { id: it.photos[0].id, url: `/api/public/display/promo-item-photo/${it.photos[0].id}` }
              : null,
          })),
        };
      })
      // No customer copy anywhere means the campaign has nothing to say on a
      // wall. Showing its internal label instead is exactly how the operator's
      // note reached the screen.
      .filter((p) => p.headline && p.body),
    company: {
      name: setting("BUSINESS_NAME"),
      phone: setting("BUSINESS_PHONE"),
      email: setting("BUSINESS_EMAIL"),
      serviceArea: setting("BUSINESS_SERVICE_AREA"),
    },
    weather,
  };
}
