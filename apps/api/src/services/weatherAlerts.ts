// ─────────────────────────────────────────────────────────────────────────────
// Severe-weather alerts — National Weather Service (api.weather.gov)
//
// PURELY ADDITIVE. OpenWeather remains the source for temperature, forecast
// and icons. This adds the thing OpenWeather's free tier does not carry:
// actual government alerts — Heat Advisory, Severe Thunderstorm, Flash Flood.
//
// THE LOAD-BEARING RULE: this service can never break the weather bar.
// The weather proxy renders on every screen in the app. So:
//   • Every failure path returns [] and logs. Nothing throws to the caller.
//   • It is NEVER awaited inside the Promise.all that fetches OpenWeather —
//     that block throws on a non-ok response, so a bad NWS day would take
//     temperature down with it.
//   • Disabled by a setting, so it can be switched off without a deploy.
//
// Free, no API key. NWS asks for a User-Agent identifying the caller and
// rate-limits without one, which is why it's a setting rather than a
// hardcoded string.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { etAddDays, etFormatDate } from "../lib/dates";

export const ALERT_SETTINGS: Record<string, [string, string]> = {
  NWS_ALERTS_ENABLED: [
    "true",
    "Master switch for National Weather Service severe-weather alerts (heat advisories, thunderstorms, flash floods) shown on the weather bar, job cards and the title bar. Turn off to hide them everywhere without a deploy. Temperature and forecast come from OpenWeather and are unaffected either way.",
  ],
  NWS_ALERTS_URL: [
    "https://api.weather.gov/alerts/active?point={lat},{lng}",
    "Endpoint for active weather alerts. {lat} and {lng} are substituted. The National Weather Service is free and needs no API key — US coverage only. Changing this to another provider requires a matching response shape.",
  ],
  NWS_ALERTS_USER_AGENT: [
    "SeedlingsLawnCare/1.0 (admin@seedlingslawncare.com)",
    "The National Weather Service requires a User-Agent identifying who is calling, with contact details, and throttles requests without one. Keep a real address here.",
  ],
  NWS_ALERTS_CACHE_MINUTES: [
    "15",
    "How long an alert lookup is reused before re-fetching. Alerts are issued in hourly-ish cycles, and every worker's screen polls the weather, so this keeps us well inside what the NWS considers polite.",
  ],
  NWS_ALERTS_MIN_SEVERITY: [
    "Moderate",
    "Lowest severity to show: Extreme, Severe, Moderate, or Minor. A Heat Advisory is Moderate; a Severe Thunderstorm Warning is Severe. Setting this to Severe hides heat advisories.",
  ],
  NWS_ALERTS_EVENT_KEYWORDS: [
    JSON.stringify([
      "heat", "thunderstorm", "tornado", "flood", "wind", "air quality",
      "winter storm", "ice storm", "freeze", "frost", "fog", "red flag",
      "hurricane", "tropical",
    ]),
    "Which alerts matter to an outdoor crew, matched as case-insensitive substrings of the event name — so \"heat\" catches Heat Advisory, Excessive Heat Warning and Heat Watch alike. Substring matching rather than an exact list so a newly-named NWS product isn't silently dropped. An empty array [] shows every alert type.",
  ],
};

/** Severity ladder, most to least urgent. NWS also emits "Unknown". */
const SEVERITY_ORDER = ["Extreme", "Severe", "Moderate", "Minor"] as const;
export type AlertSeverity = (typeof SEVERITY_ORDER)[number];

export type WeatherAlert = {
  id: string;
  /** e.g. "Heat Advisory", "Severe Thunderstorm Warning". */
  event: string;
  severity: AlertSeverity | "Unknown";
  /** Full sentence from the NWS, e.g. "Heat Advisory issued September 2…". */
  headline: string;
  /** What to actually do about it. Often the most useful field for a crew. */
  instruction: string | null;
  /** ISO instants. `ends` is null for alerts with no stated end. */
  onset: string | null;
  ends: string | null;
  /** ET date keys (YYYY-MM-DD) this alert covers, so a per-day surface can
   *  show it only on the days it applies to. */
  dateKeys: string[];
  /** Bucketed for the UI: which icon and colour to use. Derived from the
   *  event name so the app never depends on NWS's own icon hosting. */
  kind: AlertKind;
};

/** Presentation buckets. Deliberately coarse — the UI needs an icon and a
 *  colour, not 120 distinct NWS product types. */
export type AlertKind =
  | "heat" | "cold" | "storm" | "tornado" | "flood"
  | "wind" | "air" | "fog" | "fire" | "other";

const KIND_RULES: Array<[AlertKind, RegExp]> = [
  ["tornado", /tornado/i],
  ["flood", /flood|flash flood|hydrolog/i],
  ["storm", /thunderstorm|hurricane|tropical|storm|blizzard/i],
  ["heat", /heat|excessive heat/i],
  ["cold", /freeze|frost|cold|wind chill|winter|ice storm/i],
  ["wind", /wind/i],
  ["air", /air quality|smoke|dust/i],
  ["fog", /fog/i],
  ["fire", /red flag|fire weather/i],
];

export function kindFor(event: string): AlertKind {
  for (const [kind, re] of KIND_RULES) if (re.test(event)) return kind;
  return "other";
}

async function loadSettings() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.keys(ALERT_SETTINGS) } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k) ?? ALERT_SETTINGS[k][0];
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(get("NWS_ALERTS_EVENT_KEYWORDS"));
    if (Array.isArray(parsed)) keywords = parsed.map((k) => String(k).toLowerCase());
  } catch {
    // Malformed keyword list must not suppress alerts — fall through to
    // "show everything" rather than "show nothing".
    keywords = [];
  }
  return {
    enabled: get("NWS_ALERTS_ENABLED") !== "false",
    url: get("NWS_ALERTS_URL"),
    userAgent: get("NWS_ALERTS_USER_AGENT"),
    cacheMinutes: Math.max(1, Number(get("NWS_ALERTS_CACHE_MINUTES")) || 15),
    minSeverity: get("NWS_ALERTS_MIN_SEVERITY") as AlertSeverity,
    keywords,
  };
}

// In-process cache. Keyed by rounded coordinates: alerts are issued per
// county/zone, so two crews a mile apart are under the identical alert and
// should share one lookup.
const cache = new Map<string, { at: number; alerts: WeatherAlert[] }>();

function severityRank(s: string): number {
  const i = SEVERITY_ORDER.indexOf(s as AlertSeverity);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/** ET date keys spanned by an alert, capped so an open-ended alert doesn't
 *  produce an unbounded list.
 *
 *  Walks CALENDAR days via etAddDays rather than stepping the instant by
 *  86,400,000ms — a fixed-millisecond step drifts across a DST boundary and
 *  would drop or double a day twice a year. */
function coveredDateKeys(onset: string | null, ends: string | null): string[] {
  const start = onset ? new Date(onset) : new Date();
  if (Number.isNaN(start.getTime())) return [];
  const stop = ends ? new Date(ends) : start;

  const startKey = etFormatDate(start);
  const stopKey = Number.isNaN(stop.getTime()) ? startKey : etFormatDate(stop);

  const keys: string[] = [];
  let key = startKey;
  for (let guard = 0; guard < 10; guard++) {
    keys.push(key);
    if (key >= stopKey) break;
    key = etAddDays(key, 1);
  }
  return keys;
}

/**
 * Active alerts for a point. NEVER throws and NEVER returns a rejected
 * promise — an outage, a timeout, a shape change or a disabled setting all
 * produce an empty array.
 */
export async function fetchWeatherAlerts(lat: number, lng: number): Promise<WeatherAlert[]> {
  try {
    const cfg = await loadSettings();
    if (!cfg.enabled) return [];

    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cfg.cacheMinutes * 60_000) return hit.alerts;

    const url = cfg.url.replace("{lat}", String(lat)).replace("{lng}", String(lng));
    const res = await fetch(url, {
      headers: { "User-Agent": cfg.userAgent, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`NWS returned ${res.status}`);
    const json: any = await res.json();

    const minRank = severityRank(cfg.minSeverity);
    const raw: WeatherAlert[] = (json.features ?? [])
      .map((f: any) => {
        const p = f?.properties ?? {};
        const event = String(p.event ?? "").trim();
        return {
          id: String(p.id ?? f?.id ?? event),
          event,
          severity: (p.severity ?? "Unknown") as WeatherAlert["severity"],
          headline: String(p.headline ?? event),
          instruction: p.instruction ? String(p.instruction).replace(/\s+/g, " ").trim() : null,
          onset: p.onset ?? p.effective ?? null,
          ends: p.ends ?? p.expires ?? null,
          dateKeys: coveredDateKeys(p.onset ?? p.effective ?? null, p.ends ?? p.expires ?? null),
          kind: kindFor(event),
        };
      })
      .filter((a: WeatherAlert) => a.event)
      .filter((a: WeatherAlert) => severityRank(a.severity) <= minRank)
      .filter((a: WeatherAlert) =>
        cfg.keywords.length === 0 || cfg.keywords.some((k) => a.event.toLowerCase().includes(k)),
      );

    // Collapse repeats of the same event, MERGING their coverage.
    //
    // The NWS routinely has several instances of one product active at once,
    // each covering a different stretch. Chapel Hill on 2026-09-02 had two
    // Heat Advisories: one 1:46pm-8pm that day, another 11am-8pm the next.
    //
    // An earlier version kept only the longest-lived instance, which silently
    // discarded TODAY's coverage — the title bar (not date-scoped) showed the
    // advisory while the Today section header (date-scoped) did not. Showing
    // "Heat Advisory" twice is noise; dropping a day is a lie.
    //
    // So: one row per event, carrying the union of every instance's days and
    // the full span. The representative is the most severe instance, then the
    // one in effect soonest — its headline is the one worth reading now.
    const byEvent = new Map<string, WeatherAlert>();
    for (const a of raw) {
      const prev = byEvent.get(a.event);
      if (!prev) {
        byEvent.set(a.event, a);
        continue;
      }
      const better =
        severityRank(a.severity) < severityRank(prev.severity) ||
        (severityRank(a.severity) === severityRank(prev.severity) &&
          (a.onset ?? "") < (prev.onset ?? ""));
      const rep = better ? a : prev;
      byEvent.set(a.event, {
        ...rep,
        dateKeys: [...new Set([...prev.dateKeys, ...a.dateKeys])].sort(),
        onset: [prev.onset, a.onset].filter(Boolean).sort()[0] ?? rep.onset,
        ends: [prev.ends, a.ends].filter(Boolean).sort().pop() ?? rep.ends,
      });
    }

    const alerts = [...byEvent.values()].sort(
      (x, y) => severityRank(x.severity) - severityRank(y.severity),
    );
    cache.set(key, { at: Date.now(), alerts });
    return alerts;
  } catch {
    // Swallowed on purpose. Alerts are an enhancement; temperature is not.
    // Returning [] keeps every weather surface rendering exactly as it did
    // before this service existed.
    return [];
  }
}

/** Test seam — the cache is process-local and would otherwise leak between runs. */
export function __clearAlertCache() {
  cache.clear();
}
