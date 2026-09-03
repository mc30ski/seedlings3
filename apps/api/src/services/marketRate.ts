// ─────────────────────────────────────────────────────────────────────────────
// Local market wage — official, from the business's own location
//
// The Forecast tab draws a "market rate" band behind every worker's hourly
// figure. That band decides whether someone reads as underpaid, whether the
// retention warning fires, and which way the "should I hire someone to do my
// hours" comparison points.
//
// It used to be two constants I invented from general knowledge ($15-24).
// For Durham-Chapel Hill the real 25th-75th is $17.78-$22.33 — the low end
// was $1.78/hr out, in the direction that made the crew look better paid than
// they are. A number that steers a pay decision has to be sourced.
//
// TWO FREE GOVERNMENT LOOKUPS, NO API KEYS:
//   1. Census geocoder: BUSINESS_ADDRESS -> Metropolitan Statistical Area.
//   2. BLS OEWS: that MSA + an SOC occupation code -> hourly percentiles.
//
// CACHING. Keyed by the address AND every other input that shapes the answer,
// so changing BUSINESS_ADDRESS, the SOC code or the percentiles misses the
// cache and re-resolves — there is no invalidation hook to forget to call.
//
// Goes through lib/cache.ts (namespace `marketRate`), NOT a Setting row:
// Settings are operator config and render in the Settings tab, where a
// machine-managed blob has no business sitting next to the rates and
// endpoints someone actually edits.
//
// Stale-on-error matters here more than anywhere. The keyless BLS quota is
// ~25 requests/day; when it is exhausted or BLS is down, last month's real
// figure is far better than the generic estimate — and the provenance panel
// says which one is on screen.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { cached } from "../lib/cache";

export const MARKET_RATE_SETTINGS: Record<string, [string, string]> = {
  MARKET_RATE_ENABLED: [
    "true",
    "Look up the local market wage from the Bureau of Labor Statistics for the metro area your business address sits in. Used only by the Super forecasting tool, to draw the market band behind each worker's hourly rate. Turn off to fall back to the manual override below.",
  ],
  MARKET_RATE_SOC_CODE: [
    "373011",
    "Federal occupation code (SOC) to price against, digits only. 373011 is Landscaping & Groundskeeping Workers. 119021 is Construction Managers, 373012 Pesticide Handlers, 471011 First-Line Supervisors of Construction. Change this if the work you're comparing against isn't groundskeeping.",
  ],
  MARKET_RATE_PERCENTILES: [
    "25,75",
    "Which two wage percentiles form the band, low first. 25,75 is the middle half of the local market — the typical range. Use 10,90 for the full spread, or 25,50 to compare against the lower half only. Valid values: 10, 25, 50, 75, 90.",
  ],
  MARKET_RATE_OVERRIDE: [
    "",
    "Manual override, as \"low,high\" (e.g. \"18,24\"). Set this when you know your market better than the survey does — it wins over the BLS figure and is used as the fallback whenever the lookup fails. Leave blank to always use BLS.",
  ],
  MARKET_RATE_GEOCODER_URL: [
    "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address={address}&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json",
    "Resolves the business address to a Metropolitan Statistical Area. {address} is substituted. The US Census geocoder is free and needs no API key.",
  ],
  MARKET_RATE_BLS_URL: [
    "https://api.bls.gov/publicAPI/v1/timeseries/data/",
    "Bureau of Labor Statistics OEWS endpoint. The keyless v1 API allows roughly 25 requests per day, which is why results are cached (TTL is declared per namespace in lib/cache.ts). Registering a free BLS key would raise that to 500/day and require switching this to the v2 URL.",
  ],
};

/** OEWS datatype codes for HOURLY percentiles. Verified empirically against
 *  the annual ladder (datatypes 11-15) divided by 2080 — every one matched to
 *  the cent. Do not trust a remembered mapping here; an off-by-one returns
 *  annual salaries formatted as hourly wages. */
const HOURLY_DATATYPE: Record<number, string> = {
  10: "06",
  25: "07",
  50: "08",
  75: "09",
  90: "10",
};

export type MarketRate = {
  low: number;
  high: number;
  /** Where the number came from, so the UI can say so plainly. */
  source: "bls" | "override" | "fallback";
  /** Human description of the area, e.g. "Durham-Chapel Hill, NC Metro Area". */
  areaName: string | null;
  areaCode: string | null;
  /** OEWS survey year. */
  year: string | null;
  occupation: string | null;
  percentiles: [number, number];
  /** When the lookup ran. Null for override/fallback. */
  fetchedAt: string | null;
  /** Set when the lookup failed and something else is being shown instead. */
  note: string | null;
};

/** Last-resort band. Deliberately labelled `fallback` so the UI never presents
 *  an unsourced number as though it came from the BLS. */
const FALLBACK: MarketRate = {
  low: 15, high: 24, source: "fallback",
  areaName: null, areaCode: null, year: null, occupation: null,
  percentiles: [25, 75], fetchedAt: null,
  note: "Using a generic estimate — no local figure has been looked up yet.",
};

async function loadCfg() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...Object.keys(MARKET_RATE_SETTINGS), "BUSINESS_ADDRESS"] } },
    select: { key: true, value: true },
  });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => m.get(k) ?? MARKET_RATE_SETTINGS[k]?.[0] ?? "";
  const pcts = get("MARKET_RATE_PERCENTILES")
    .split(",").map((x) => Number(x.trim()))
    .filter((n) => n in HOURLY_DATATYPE);
  return {
    enabled: get("MARKET_RATE_ENABLED") !== "false",
    soc: get("MARKET_RATE_SOC_CODE").replace(/\D/g, ""),
    percentiles: (pcts.length === 2 ? pcts : [25, 75]) as [number, number],
    override: get("MARKET_RATE_OVERRIDE").trim(),
    geocoderUrl: get("MARKET_RATE_GEOCODER_URL"),
    blsUrl: get("MARKET_RATE_BLS_URL"),
    address: (m.get("BUSINESS_ADDRESS") ?? "").trim(),
  };
}

function parseOverride(raw: string): [number, number] | null {
  const parts = raw.split(",").map((x) => Number(x.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return [Math.min(...parts), Math.max(...parts)];
}

/** BUSINESS_ADDRESS -> { code, name } for the enclosing metro area. */
async function resolveArea(address: string, urlTemplate: string) {
  const url = urlTemplate.replace("{address}", encodeURIComponent(address));
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Census geocoder returned ${res.status}`);
  const j: any = await res.json();
  const geos = j?.result?.addressMatches?.[0]?.geographies ?? {};
  const layer = Object.entries(geos).find(([name]) => /^Metropolitan Statistical Areas$/i.test(name))
    ?? Object.entries(geos).find(([name]) => /Metropolitan/i.test(name));
  const hit: any = (layer?.[1] as any[])?.[0];
  if (!hit?.GEOID) throw new Error("no metropolitan area found for that address");
  return { code: String(hit.GEOID), name: String(hit.NAME ?? hit.BASENAME ?? hit.GEOID) };
}

/** Hourly percentile wages for one occupation in one metro area. */
async function fetchWages(
  blsUrl: string, areaCode: string, soc: string, pcts: [number, number],
) {
  // OEWS series: OEU + areaType(M) + 7-digit area + industry(000000) + SOC + datatype
  const area = `M${areaCode.padStart(7, "0")}`;
  const ids = pcts.map((p) => `OEU${area}000000${soc}${HOURLY_DATATYPE[p]}`);
  const res = await fetch(blsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seriesid: ids }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`BLS returned ${res.status}`);
  const j: any = await res.json();
  if (j.status !== "REQUEST_SUCCEEDED") {
    throw new Error(j.message?.[0] ?? "BLS request was not successful");
  }
  const out: Array<{ value: number; year: string }> = [];
  for (const id of ids) {
    const series = (j.Results?.series ?? []).find((s: any) => s.seriesID === id);
    const latest = series?.data?.[0];
    if (!latest?.value) throw new Error(`no OEWS data for ${id} — check the SOC code and area`);
    out.push({ value: Number(latest.value), year: String(latest.year) });
  }
  if (out.some((o) => !Number.isFinite(o.value) || o.value <= 0 || o.value > 500)) {
    // An implausible hourly figure means the datatype mapping is wrong and
    // we are about to render annual salaries as wages. Refuse rather than
    // publish a number that is off by three orders of magnitude.
    throw new Error("OEWS returned an implausible hourly wage — datatype mapping may be wrong");
  }
  return { low: out[0].value, high: out[1].value, year: out[0].year };
}

/**
 * The local market band. NEVER throws: any failure degrades to the manual
 * override, then to a clearly-labelled generic estimate.
 */
export async function getMarketRate(): Promise<MarketRate> {
  let cfg: Awaited<ReturnType<typeof loadCfg>> | null = null;
  try {
    cfg = await loadCfg();
    const override = parseOverride(cfg.override);

    // An explicit override always wins — the operator knows their market.
    if (override) {
      return {
        low: override[0], high: override[1], source: "override",
        areaName: null, areaCode: null, year: null, occupation: null,
        percentiles: cfg.percentiles, fetchedAt: null,
        note: "Manually set in Settings, overriding the BLS figure.",
      };
    }
    if (!cfg.enabled) return { ...FALLBACK, note: "Market-rate lookup is switched off in Settings." };
    if (!cfg.address) return { ...FALLBACK, note: "No BUSINESS_ADDRESS is set, so the metro area can't be resolved." };

    // Cache key includes the address AND every input that shapes the answer,
    // so changing any of them re-resolves instead of serving a stale band.
    const key = [cfg.address, cfg.soc, cfg.percentiles.join("-")].join("|");
    const { value, stale, fetchedAt } = await cached("marketRate", key, async () => {
      const area = await resolveArea(cfg!.address, cfg!.geocoderUrl);
      const wages = await fetchWages(cfg!.blsUrl, area.code, cfg!.soc, cfg!.percentiles);
      return { area, wages };
    });

    const rate: MarketRate = {
      low: value.wages.low,
      high: value.wages.high,
      source: "bls",
      areaName: value.area.name,
      areaCode: value.area.code,
      year: value.wages.year,
      occupation: cfg.soc,
      percentiles: cfg.percentiles,
      fetchedAt,
      // Say it plainly when the refresh failed and this is the last good
      // answer — a silently stale wage band is the thing to avoid.
      note: stale
        ? "Couldn't reach the BLS just now, so this is the last figure we retrieved."
        : null,
    };
    return rate;
  } catch (err: any) {
    const override = cfg ? parseOverride(cfg.override) : null;
    if (override) {
      return {
        low: override[0], high: override[1], source: "override",
        areaName: null, areaCode: null, year: null, occupation: null,
        percentiles: cfg!.percentiles, fetchedAt: null,
        note: `Lookup failed (${err?.message ?? "unknown error"}), using the manual override.`,
      };
    }
    return { ...FALLBACK, note: `Couldn't look up the local rate (${err?.message ?? "unknown error"}). Showing a generic estimate — set MARKET_RATE_OVERRIDE in Settings to replace it.` };
  }
}
