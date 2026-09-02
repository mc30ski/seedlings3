// ─────────────────────────────────────────────────────────────────────────────
// Public parcel lookup — county assessor records + overhead imagery.
//
// WHY THIS EXISTS
// Admins pricing a job want to know how big a property actually is. The
// county publishes surveyed parcel geometry and appraisal values for free,
// and the state publishes 6-inch orthoimagery. Both are open endpoints with
// no key and no quota.
//
// ── WHY WE MATCH ON A COORDINATE, NOT AN ADDRESS ────────────────────────────
// The obvious approach — search the parcel layer for the address text —
// cannot be made reliable. Observed on one property, 2026-09-01:
//
//   our record         "225 Stony Branch Trl"
//   county record      "225  STONY BRANCH TRL"   (two spaces)
//   Census record      "225 STONEY BRANCH TRL"   (different spelling)
//
// Three sources, three spellings of the same street. Chatham County also
// leaves `scity` blank, so filtering on city silently drops every parcel in
// the county. No amount of normalising fixes this class of problem.
//
// So: geocode the address to a point, then ask which parcel polygon contains
// it. That is geometry, not text.
//
// ── WHY A SEARCH RADIUS, NOT A BARE POINT-IN-POLYGON ────────────────────────
// The Census geocoder interpolates along street CENTRELINES, so its point
// lands in the road rather than on the house — a plain intersects query
// returns zero. We search a small radius instead and pick the candidate whose
// HOUSE NUMBER matches, falling back to the nearest. Comparing an integer
// sidesteps the spelling problem entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { isStaleAfterDays } from "../lib/dates";
import { getDownloadUrl, headObject, putObjectBuffer } from "../lib/r2";

/**
 * Every tunable for this feature, one Settings row each.
 *
 * Deliberately NOT a single JSON blob: the operator asked to be able to see
 * and change each value on its own, and a blob means editing raw JSON in a
 * text box to move one number. Grouped under the "Property Records" section.
 *
 * NOTHING about the external services is hardcoded — all three endpoints are
 * here, so covering another state or swapping a county's own geocoder in is a
 * settings change. (The RESPONSE SHAPES are still assumed: an ArcGIS parcel
 * layer and a Census-style geocoder. A different vendor needs code.)
 */
export type ParcelConfig = {
  enabled: boolean;
  geocoderUrl: string;
  geocoderQuery: string;
  parcelServiceUrl: string;
  imageServiceUrl: string;
  cacheDays: number;
  searchRadiusFt: number;
  imageMaxPx: number;
  imageMarginFt: number;
  imageFormat: string;
  imageTimeoutSeconds: number;
  imageAttempts: number;
  queryTimeoutSeconds: number;
  queryAttempts: number;
  failureRetryHours: number;
  useWorkerGps: boolean;
  states: string[];
};

/** key -> [default, description]. The single source of truth: the seed reads
 *  this to create the rows, so a new tunable can never drift from its row. */
export const PARCEL_SETTINGS = {
  PARCEL_ENABLED: ["true", "Master switch for the property-record lookup. When off, the icon still appears but the dialog reports the feature is disabled."],
  PARCEL_GEOCODER_URL: ["https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
    "Turns a street address into a coordinate. The US Census geocoder is free, national and needs no key. Swap for a county's own address locator if you want rooftop accuracy — Census interpolates along street centrelines, so its point lands in the road."],
  PARCEL_GEOCODER_QUERY: ["?address={address}&benchmark=Public_AR_Current&format=json",
    "Query string appended to the geocoder URL. {address} is replaced with the URL-encoded address."],
  PARCEL_SERVICE_URL: ["https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query",
    "ArcGIS parcel-polygon layer, queried for the parcel containing the geocoded point. NC OneMap covers every NC county."],
  PARCEL_IMAGE_SERVICE_URL: ["https://services.nconemap.gov/secure/rest/services/Imagery/Orthoimagery_20242027_analysis/ImageServer/exportImage",
    "ArcGIS ImageServer that renders the overhead view. NC's statewide orthoimagery is 6 inches per pixel and flown leaf-off in winter."],
  PARCEL_CACHE_DAYS: ["365",
    "How long a resolved parcel and its cached image are reused before re-querying. Counties revalue on a multi-year cycle, so this is deliberately long."],
  PARCEL_SEARCH_RADIUS_FT: ["250",
    "How far from the geocoded point to look for candidate parcels. Needed because the geocoder returns a point in the road, not on the house; the parcel whose house number matches wins."],
  PARCEL_IMAGE_MAX_PX: ["640", "Longest edge of the cached overhead image, in pixels."],
  PARCEL_IMAGE_MARGIN_FT: ["50", "Padding around the parcel in the overhead image, in feet."],
  PARCEL_IMAGE_FORMAT: ["jpg", "jpg or png. Aerial imagery is photographic, so PNG's lossless encoding costs ~5x the bytes for no visible gain (806 KB vs 104 KB measured)."],
  PARCEL_IMAGE_TIMEOUT_SECONDS: ["45",
    "How long to wait for the imagery service. Its latency is very erratic — eight identical requests measured 1.2s to 24.6s — so this is deliberately generous."],
  PARCEL_IMAGE_ATTEMPTS: ["2", "How many times to try the imagery service before giving up. The fast responses cluster after a slow one, so a retry usually returns quickly."],
  PARCEL_QUERY_TIMEOUT_SECONDS: ["45",
    "How long to wait for the parcel service. Like the imagery service its latency is erratic, and a timeout here is the most common reason a lot fails to resolve while its neighbours succeed."],
  PARCEL_QUERY_ATTEMPTS: ["2", "How many times to try the parcel service before giving up."],
  PARCEL_FAILURE_RETRY_HOURS: ["6",
    "How long a FAILED lookup is remembered before being retried. Much shorter than the success cache: most failures are transient (a timeout, a service blip), and caching one for a year would strand a property that would resolve fine on the next try."],
  PARCEL_USE_WORKER_GPS: ["true",
    "When the geocoder can't place an address, fall back to the coordinates a worker's phone recorded when starting a job at that property. Newer subdivisions are often missing from the Census geocoder, and a worker who stood there is a better source than an address database."],
  PARCEL_STATES: ["NC",
    "Comma-separated two-letter states the parcel service covers. A property outside these gets no lookup and no dialog rather than a broken one."],
} as const;

/**
 * Bump when the shape of `parcelData` changes.
 *
 * A cached record written by an older version is missing whatever field was
 * just added, and with a year-long window it would keep serving that gap.
 * Observed: adding `confident` left records resolved minutes earlier reading
 * `undefined`, so the low-confidence warning never fired.
 */
const PARCEL_DATA_VERSION = 2;

/**
 * Does a stored state value match one of the configured states?
 *
 * Production stores the same state three different ways — "NC" (48
 * properties), "North Carolina" (21) and "North" (22, evidently truncated) —
 * so a plain `states.includes(value)` rejected 47% of them with "no parcel
 * coverage". Address fields are free text and always will be.
 *
 * Matches a two-letter code, the full name, or an unambiguous prefix of the
 * full name of a CONFIGURED state. "North" is accepted as North Carolina here
 * only because NC is configured and North Dakota is not; if both were
 * configured it would correctly match neither.
 */
const STATE_NAMES: Record<string, string> = {
  AL: "ALABAMA", AK: "ALASKA", AZ: "ARIZONA", AR: "ARKANSAS", CA: "CALIFORNIA",
  CO: "COLORADO", CT: "CONNECTICUT", DE: "DELAWARE", FL: "FLORIDA", GA: "GEORGIA",
  HI: "HAWAII", ID: "IDAHO", IL: "ILLINOIS", IN: "INDIANA", IA: "IOWA",
  KS: "KANSAS", KY: "KENTUCKY", LA: "LOUISIANA", ME: "MAINE", MD: "MARYLAND",
  MA: "MASSACHUSETTS", MI: "MICHIGAN", MN: "MINNESOTA", MS: "MISSISSIPPI",
  MO: "MISSOURI", MT: "MONTANA", NE: "NEBRASKA", NV: "NEVADA",
  NH: "NEW HAMPSHIRE", NJ: "NEW JERSEY", NM: "NEW MEXICO", NY: "NEW YORK",
  NC: "NORTH CAROLINA", ND: "NORTH DAKOTA", OH: "OHIO", OK: "OKLAHOMA",
  OR: "OREGON", PA: "PENNSYLVANIA", RI: "RHODE ISLAND", SC: "SOUTH CAROLINA",
  SD: "SOUTH DAKOTA", TN: "TENNESSEE", TX: "TEXAS", UT: "UTAH", VT: "VERMONT",
  VA: "VIRGINIA", WA: "WASHINGTON", WV: "WEST VIRGINIA", WI: "WISCONSIN", WY: "WYOMING",
};

export function stateMatches(stored: string | null | undefined, configured: string[]): boolean {
  const v = (stored ?? "").trim().toUpperCase().replace(/\.$/, "");
  if (!v) return false;
  const candidates = configured.map((c) => c.trim().toUpperCase());
  if (candidates.includes(v)) return true;
  const full = candidates.map((c) => STATE_NAMES[c]).filter(Boolean);
  if (full.includes(v)) return true;
  // Prefix, but only if it is unambiguous across the configured states.
  const hits = full.filter((f) => f.startsWith(v));
  return v.length >= 3 && hits.length === 1;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export async function parcelConfig(): Promise<ParcelConfig> {
  const keys = Object.keys(PARCEL_SETTINGS);
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const d = (k: keyof typeof PARCEL_SETTINGS) => v.get(k) ?? PARCEL_SETTINGS[k][0];
  return {
    enabled: d("PARCEL_ENABLED") !== "false",
    geocoderUrl: d("PARCEL_GEOCODER_URL"),
    geocoderQuery: d("PARCEL_GEOCODER_QUERY"),
    parcelServiceUrl: d("PARCEL_SERVICE_URL"),
    imageServiceUrl: d("PARCEL_IMAGE_SERVICE_URL"),
    cacheDays: num(d("PARCEL_CACHE_DAYS"), 365),
    searchRadiusFt: num(d("PARCEL_SEARCH_RADIUS_FT"), 250),
    imageMaxPx: num(d("PARCEL_IMAGE_MAX_PX"), 640),
    imageMarginFt: num(d("PARCEL_IMAGE_MARGIN_FT"), 50),
    imageFormat: d("PARCEL_IMAGE_FORMAT") === "png" ? "png" : "jpg",
    imageTimeoutSeconds: num(d("PARCEL_IMAGE_TIMEOUT_SECONDS"), 45),
    imageAttempts: Math.max(1, num(d("PARCEL_IMAGE_ATTEMPTS"), 2)),
    queryTimeoutSeconds: num(d("PARCEL_QUERY_TIMEOUT_SECONDS"), 45),
    queryAttempts: Math.max(1, num(d("PARCEL_QUERY_ATTEMPTS"), 2)),
    failureRetryHours: num(d("PARCEL_FAILURE_RETRY_HOURS"), 6),
    useWorkerGps: d("PARCEL_USE_WORKER_GPS") !== "false",
    states: d("PARCEL_STATES").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
  };
}

export type ParcelAttributes = {
  /** Shape version — see PARCEL_DATA_VERSION. Records below the current
   *  version are re-resolved even inside the cache window. */
  version: number;
  parcelNumber: string | null;
  siteAddress: string | null;
  county: string | null;
  acres: number | null;
  landValue: number | null;
  improvementValue: number | null;
  totalValue: number | null;
  valueType: string | null;
  useDescription: string | null;
  owner: string | null;
  /** Where the acreage came from — county field or measured from the
   *  polygon. Surfaced because the counties disagree about which fields
   *  they populate. */
  acresBasis: string;
  /**
   * True only when the parcel's own site address confirmed the match.
   *
   * Keyed on the match METHOD, not on a county name, because the cause is a
   * data gap that any county can have: Orange publishes no `siteadd` at all
   * (0 of 59,366 parcels), so there is nothing to confirm against and we fall
   * back to the parcel nearest the geocoded point — which sits in the ROAD,
   * not on the house. That can land on the neighbour.
   */
  confident: boolean;
  /** Acquisition/vintage note for the imagery, shown so nobody reads a
   *  leaf-off winter capture as "this property has no trees". */
  source: string;
};

const FT_PER_DEG_LAT = 364000;

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Free, national, no key. Returns null when the address can't be placed. */
async function geocode(address: string, cfg: ParcelConfig): Promise<{ lat: number; lng: number } | null> {
  const url = cfg.geocoderUrl + cfg.geocoderQuery.replace("{address}", encodeURIComponent(address));
  const body = await fetchJson(url);
  // Census response shape. Swapping to a different geocoder needs this reader
  // changed too — a configurable URL only gets you a compatible service.
  const m = body?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const lat = Number(m.coordinates.y);
  const lng = Number(m.coordinates.x);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** OUR address for the property, not the county's — `siteadd` is blank in
 *  some counties and oddly spaced in others, and outbound links need
 *  something a consumer site will recognise. */
const addressOf = (p: { street1: string | null; city: string | null; state: string | null; postalCode: string | null }) => ({
  street1: p.street1 ?? "",
  city: p.city ?? "",
  state: p.state ?? "",
  postalCode: p.postalCode ?? "",
});

/**
 * Where a worker's phone said they were when they started a job here.
 *
 * The Census geocoder is built from TIGER address ranges and simply does not
 * know newer subdivisions — "87 Monteith Dr, Chapel Hill" returns no match in
 * any spelling, while the parcel sits right there in Chatham's data. A worker
 * who physically stood on the property is a better source than an address
 * database, and this is data we already collect.
 *
 * Uses the MEDIAN of the recorded fixes, not the mean: one bad GPS lock (a
 * worker who hit start from the road two streets away) would drag an average
 * off the lot, while a median ignores it.
 */
async function workerGps(propertyId: string): Promise<{ lat: number; lng: number } | null> {
  const rows = await prisma.jobOccurrence.findMany({
    where: { job: { propertyId }, startLat: { not: null }, startLng: { not: null } },
    select: { startLat: true, startLng: true },
    orderBy: { startAt: "desc" },
    take: 15,
  });
  if (rows.length === 0) return null;
  const mid = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return {
    lat: mid(rows.map((r) => r.startLat!)),
    lng: mid(rows.map((r) => r.startLng!)),
  };
}

const houseNumberOf = (s: string | null | undefined): number | null => {
  const n = String(s ?? "").trim().match(/^(\d+)/)?.[1];
  return n ? Number(n) : null;
};

/**
 * Acres for a parcel, with a fallback chain.
 *
 * ORANGE COUNTY REPORTS `gisacres` AS 0. Chatham and Durham populate it;
 * Orange — which is Chapel Hill, Carrboro and Hillsborough — does not, so the
 * headline figure in the dialog read "0.00 acres" for most of the service
 * area. It carries `recareano` (recorded area) instead, and the polygon is
 * always there regardless.
 *
 * Planar shoelace is accurate at parcel scale: on one parcel it matched the
 * county's own gisacres to 4 decimal places (3.1755 vs 3.17547).
 */
function acresFor(attrs: any, rings: number[][][] | null): { acres: number | null; basis: string } {
  const gis = Number(attrs?.gisacres);
  if (Number.isFinite(gis) && gis > 0) return { acres: gis, basis: "county GIS acreage" };
  const rec = Number(attrs?.recareano);
  if (Number.isFinite(rec) && rec > 0) return { acres: rec, basis: "county recorded area" };
  if (rings?.length) {
    const ring = rings[0];
    const midLat = ring.reduce((t, q) => t + q[1], 0) / ring.length;
    const ftLon = FT_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ftLon * (ring[i + 1][1] * FT_PER_DEG_LAT)
         - ring[i + 1][0] * ftLon * (ring[i][1] * FT_PER_DEG_LAT);
    }
    const acres = Math.abs(a) / 2 / 43560;
    return { acres: Math.round(acres * 10000) / 10000, basis: "measured from the parcel boundary" };
  }
  return { acres: null, basis: "unavailable" };
}

const ringCentroid = (rings: number[][][]): { x: number; y: number } => {
  const pts = rings.flat();
  return {
    x: pts.reduce((a, p) => a + p[0], 0) / pts.length,
    y: pts.reduce((a, p) => a + p[1], 0) / pts.length,
  };
};

/**
 * Strip everything a worker has no business seeing.
 *
 * Workers get the SIZE and the IMAGERY — what they need to plan the work —
 * and nothing else. The county's appraised value and the owner of record are
 * public record, but they are not operational data and have no place on a
 * phone in someone's yard.
 *
 * Applied on the SERVER, not by hiding fields in the UI: a redaction that
 * only exists in the client is visible in the network payload to anyone who
 * opens devtools. Same rule the team/groups worker endpoints follow.
 */
export function redactParcelForWorker<T extends { data: ParcelAttributes | null }>(r: T): T & { redacted: true } {
  return {
    ...r,
    redacted: true as const,
    data: r.data
      ? {
          ...r.data,
          landValue: null,
          improvementValue: null,
          totalValue: null,
          valueType: null,
          owner: null,
        }
      : null,
  };
}

/**
 * Resolve and cache the parcel record for a property.
 *
 * Returns the cached row untouched when it is inside the configured window,
 * so this is safe to call on every dialog open.
 */
export async function resolveParcel(propertyId: string, opts: { force?: boolean } = {}) {
  const cfg = await parcelConfig();
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true, displayName: true, street1: true, street2: true, city: true,
      state: true, postalCode: true, lat: true, lng: true,
      parcelData: true, parcelBoundary: true, parcelFetchedAt: true, parcelLookupError: true,
    },
  });
  if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);
  if (!cfg.enabled) {
    throw new ServiceError(
      "DISABLED",
      "Property records are switched off for this business. A Super can turn them back on in Settings, under Property Records.",
      400,
    );
  }

  const cachedVersion = (property.parcelData as any)?.version ?? 0;
  // A FAILURE is remembered for hours, a SUCCESS for a year.
  //
  // Both used to share `cacheDays`, so one transient timeout stranded a
  // property for 365 days — the single worst behaviour in this feature, since
  // the most common failure (a slow upstream) is also the most transient.
  const fresh = property.parcelLookupError != null
    ? !isStaleAfterDays(property.parcelFetchedAt, cfg.failureRetryHours / 24)
    : !isStaleAfterDays(property.parcelFetchedAt, cfg.cacheDays) &&
      cachedVersion === PARCEL_DATA_VERSION;
  if (!opts.force && fresh && (property.parcelData || property.parcelLookupError)) {
    return {
      cached: true,
      fetchedAt: property.parcelFetchedAt,
      data: property.parcelData as ParcelAttributes | null,
      boundary: property.parcelBoundary as number[][][] | null,
      lat: property.lat, lng: property.lng,
      error: property.parcelLookupError,
      address: addressOf(property),
    };
  }

  const fail = async (message: string) => {
    // audit-allow: caches the reason a public-record lookup found nothing so
    // it isn't retried on every dialog open. No business state changes.
    await prisma.property.update({
      where: { id: propertyId },
      data: { parcelLookupError: message, parcelFetchedAt: new Date() },
    });
    return {
      cached: false, fetchedAt: new Date(), data: null, boundary: null,
      lat: null, lng: null, error: message, address: addressOf(property),
    };
  };

  if (!stateMatches(property.state, cfg.states)) {
    return fail(
      `This property is in ${property.state || "another state"}. County property records are only ` +
      `set up for North Carolina right now, so there's nothing to look up.`,
    );
  }

  const address = [property.street1, property.city, `${property.state} ${property.postalCode}`]
    .filter(Boolean).join(", ");
  let point: { lat: number; lng: number } | null = null;
  let located = "geocoded address";
  try {
    point = await geocode(address, cfg);
  } catch {
    point = null; // fall through to the GPS fallback before giving up
  }
  if (!point && cfg.useWorkerGps) {
    point = await workerGps(propertyId);
    if (point) located = "a worker's recorded location at this property";
  }
  if (!point) {
    return fail(
      "We couldn't work out where this property is on the map. The national address " +
      "directory doesn't have this street — common for newer neighbourhoods — and nobody " +
      "has started a job here yet, so there's no location from a phone to fall back on " +
      "either. It should sort itself out once someone works here. If it doesn't, check " +
      "the street address for a typo.",
    );
  }

  // Candidate parcels near the street point. Geometry comes back so we can
  // both rank by distance and cache the boundary in one call.
  const q =
    `${cfg.parcelServiceUrl}?geometry=${point.lng},${point.lat}` +
    `&geometryType=esriGeometryPoint&inSR=4326&distance=${cfg.searchRadiusFt}` +
    `&units=esriSRUnit_Foot&spatialRel=esriSpatialRelIntersects` +
    `&outFields=parno,siteadd,cntyname,gisacres,landval,improvval,parval,parvaltype,parusedesc,ownname` +
    `&returnGeometry=true&outSR=4326&f=json`;
  // Retry, for the same reason the imagery fetch does: this service times out
  // intermittently and a single 25s attempt was the top cause of "the
  // neighbour's lot resolves but mine doesn't". Observed in one run: the same
  // address failed and succeeded minutes apart.
  let body: any = null;
  let queryErr = "";
  for (let attempt = 1; attempt <= cfg.queryAttempts && !body; attempt++) {
    try {
      body = await fetchJson(q, cfg.queryTimeoutSeconds * 1000);
    } catch (e: any) {
      queryErr = e?.name === "AbortError"
        ? `it took longer than ${cfg.queryTimeoutSeconds} seconds to reply`
        : "we couldn't reach it";
    }
  }
  if (!body) {
    return fail(
      `The county's property records aren't answering right now — ${queryErr}. This is ` +
      `almost always temporary and nothing to do with this property; it'll try again by ` +
      `itself shortly, or you can hit refresh.`,
    );
  }
  const features: any[] = body?.features ?? [];
  if (features.length === 0) {
    return fail(
      "We found the address on the map, but the county has no property record at that " +
      "spot. That usually means the address points somewhere slightly off — a shared " +
      "driveway, or the road rather than the lot. Worth checking the address.",
    );
  }

  // House number first — an integer compare, immune to the spelling
  // differences between our record, the county's and the Census's. Distance
  // is only the tie-breaker.
  const want = houseNumberOf(property.street1);
  const scored = features
    .map((f) => {
      const c = ringCentroid(f.geometry?.rings ?? [[[point!.lng, point!.lat]]]);
      const dLat = (c.y - point!.lat) * FT_PER_DEG_LAT;
      const dLng = (c.x - point!.lng) * FT_PER_DEG_LAT * Math.cos((point!.lat * Math.PI) / 180);
      return {
        f,
        numberMatch: want != null && houseNumberOf(f.attributes?.siteadd) === want,
        distFt: Math.hypot(dLat, dLng),
      };
    })
    .sort((a, b) => (Number(b.numberMatch) - Number(a.numberMatch)) || (a.distFt - b.distFt));

  const best = scored[0];
  const a = best.f.attributes ?? {};
  const rings = (best.f.geometry?.rings ?? null) as number[][][] | null;
  const { acres, basis: acresBasis } = acresFor(a, rings);
  const data: ParcelAttributes = {
    version: PARCEL_DATA_VERSION,
    parcelNumber: a.parno ?? null,
    siteAddress: (a.siteadd ?? "").replace(/\s+/g, " ").trim() || null,
    county: a.cntyname ?? null,
    acres,
    acresBasis,
    landValue: typeof a.landval === "number" ? a.landval : null,
    improvementValue: typeof a.improvval === "number" ? a.improvval : null,
    totalValue: typeof a.parval === "number" ? a.parval : null,
    valueType: a.parvaltype ?? null,
    useDescription: a.parusedesc ?? null,
    owner: a.ownname ?? null,
    confident: best.numberMatch,
    source: best.numberMatch
      ? `Matched by house number, from ${located}`
      : `Nearest of ${scored.length} parcels, ${Math.round(best.distFt)} ft from ${located}`,
  };

  // audit-allow: caches the county's public parcel record against the
  // property. Nothing here is operator-entered or operator-changeable — a
  // refresh re-reads the same public source.
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      lat: point.lat, lng: point.lng,
      parcelData: data as any,
      parcelBoundary: rings as any,
      parcelFetchedAt: new Date(),
      parcelLookupError: null,
      // A new parcel means the cached picture is of the wrong place.
      parcelImageKey: null,
      parcelImageAt: null,
    },
  });

  return {
    cached: false, fetchedAt: new Date(), data,
    boundary: rings,
    lat: point.lat, lng: point.lng, error: null,
    address: addressOf(property),
  };
}

/**
 * The overhead image for a property, cached in R2.
 *
 * Cached because each render is ~200-400 KB against a free public service,
 * and the ground does not move. Keyed by property under a `parcel/` prefix in
 * the existing property-photos bucket — no new bucket to provision.
 */
/**
 * A browser-usable URL for the property's overhead image.
 *
 * Returns a short-lived SIGNED R2 URL rather than the bytes, because an
 * `<img src>` carries no Clerk token — pointing it at the admin-gated route
 * 401s and the image silently fails to render. Same pattern the guide assets
 * and property photos already use. The endpoint that hands out the URL stays
 * admin-gated; only the opaque, expiring link reaches the browser.
 *
 * Fetches and caches on first call. Cached because each render is ~100 KB
 * against a free public service, and the ground does not move.
 */
export type ParcelImage = {
  url: string;
  cached: boolean;
  /** The geographic extent the image covers, so the caller can draw the
   *  parcel boundary over it. See the imageSR note below for why a plain
   *  linear mapping from these degrees to pixels is exact. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
};

export async function parcelImageUrl(propertyId: string): Promise<ParcelImage> {
  const cfg = await parcelConfig();
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, parcelBoundary: true, parcelImageKey: true, parcelImageAt: true, parcelImageBox: true, lat: true, lng: true },
  });
  if (!p) throw new ServiceError("NOT_FOUND", "Property not found.", 404);

  if (p.parcelImageKey && !isStaleAfterDays(p.parcelImageAt, cfg.cacheDays)) {
    try {
      // Confirm the object is really there — a stale key would otherwise
      // produce a signed URL that 404s inside an <img>, which is invisible.
      // Validate the cached object, don't just confirm it exists.
      //
      // An earlier bug stored ArcGIS's 62-byte JSON error body as a .jpg —
      // and with a 365-day window that poison would have been served for a
      // year, failing silently inside an <img>. Anything too small to be a
      // photograph is treated as a cache miss and re-fetched.
      const head = await headObject(p.parcelImageKey, "property-photos");
      const meta = p.parcelImageBox as (ParcelImage["bbox"] & { width: number; height: number }) | null;
      if (head && head.sizeBytes >= 1024 && meta) {
        return {
          url: await getDownloadUrl(p.parcelImageKey, 900, "property-photos"),
          cached: true,
          bbox: { minX: meta.minX, minY: meta.minY, maxX: meta.maxX, maxY: meta.maxY },
          width: meta.width, height: meta.height,
        };
      }
      // Missing, too small to be an image, or cached before the extent was
      // recorded — fall through and re-render.
    } catch {
      // Fall through and re-fetch.
    }
  }

  const rings = p.parcelBoundary as number[][][] | null;
  if (!rings?.length && (p.lat == null || p.lng == null)) {
    throw new ServiceError(
      "BAD_STATE",
      "We need to find the property on the map before we can fetch a photo of it. Close this and open it again.",
      400,
    );
  }

  // Bounding box in degrees, padded, then converted to a pixel size that
  // preserves the real-world aspect ratio — a degree of longitude is shorter
  // than a degree of latitude, so using the raw ratio stretches the image.
  const pts = rings?.flat() ?? [[p.lng!, p.lat!]];
  const lons = pts.map((q) => q[0]);
  const lats = pts.map((q) => q[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = cfg.imageMarginFt / FT_PER_DEG_LAT;
  const padLon = padLat / Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  const minX = Math.min(...lons) - padLon, maxX = Math.max(...lons) + padLon;
  const minY = Math.min(...lats) - padLat, maxY = Math.max(...lats) + padLat;

  const wFt = (maxX - minX) * FT_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  const hFt = (maxY - minY) * FT_PER_DEG_LAT;
  const scale = cfg.imageMaxPx / Math.max(wFt, hFt);
  const wPx = Math.max(64, Math.round(wFt * scale));
  const hPx = Math.max(64, Math.round(hFt * scale));

  // imageSR MATCHES bboxSR (4326) on purpose.
  //
  // Rendering into a projected SR (6543) looks identical but makes the
  // degrees-to-pixels mapping non-linear, so a boundary drawn from lat/lng
  // would drift against the imagery. In 4326 the mapping is linear per axis
  // and therefore exactly invertible — the overlay lands on the pixel it
  // should.
  //
  // The image is NOT stretched by this: `size` is derived from the real-world
  // extent in feet above, so feet-per-pixel is equal on both axes even though
  // degrees-per-pixel is not.
  const url =
    `${cfg.imageServiceUrl}?bbox=${minX},${minY},${maxX},${maxY}` +
    `&bboxSR=4326&imageSR=4326&size=${wPx},${hPx}&format=${cfg.imageFormat}&f=image`;

  // TIMEOUT AND RETRY.
  //
  // The imagery service is free and its latency is wildly variable. Eight
  // identical requests, measured 2026-09-01:
  //
  //   1163  1192  1363  1462  5839  11630  14058  24632 ms
  //
  // Median 5.8s, worst 24.6s, zero hard failures — so the old 30s ceiling
  // wasn't erroring, it was just being crossed by the tail. Hence a much
  // longer deadline plus one retry: the fast runs cluster after a slow one,
  // which looks like a cold tile warming upstream, so a second attempt
  // usually returns quickly.
  const IMAGE_TIMEOUT_MS = cfg.imageTimeoutSeconds * 1000;
  let buf: Uint8Array | null = null;
  let lastErr = "";
  let lastKind: "timeout" | "upstream" | "network" = "network";
  let lastUpstream: string | null = null;
  for (let attempt = 1; attempt <= cfg.imageAttempts && !buf; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`the service reported an error (code ${res.status})`);

      // ARCGIS SIGNALS ERRORS WITH HTTP 200.
      //
      // A missing service, an expired token or bad parameters all come back
      // as `200 application/json` with an {error:{message}} body — not a 4xx.
      // Without this check we buffered 62 bytes of JSON, stored it in R2 as a
      // .jpg, and cached that for a year; the browser just failed to decode
      // it and the dialog showed a generic "didn't respond".
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.startsWith("image/")) {
        const text = (await res.text()).slice(0, 400);
        let upstream = text;
        try { upstream = JSON.parse(text)?.error?.message ?? text; } catch { /* not JSON */ }
        const err: any = new Error(`it sent back an error message instead of a photo`);
        err.upstream = upstream;
        throw err;
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      // A zero-length or absurdly small body is not a usable picture either.
      if (bytes.byteLength < 1024) {
        throw new Error(`it sent back a file too small to be a photo (${bytes.byteLength} bytes)`);
      }
      buf = bytes;
    } catch (e: any) {
      // Keep the KIND of failure, not just its text — a timeout and a bad
      // endpoint need different advice, and conflating them produced
      // "returned Token Required … it is often slow, try again", which is
      // both contradictory and useless.
      lastKind = e?.name === "AbortError" ? "timeout" : (e?.upstream ? "upstream" : "network");
      lastErr = e?.message ?? "we couldn't reach it";
      lastUpstream = e?.upstream ?? null;
    } finally {
      clearTimeout(t);
    }
  }
  if (!buf) {
    // Written to be shown to an operator verbatim, and phrased per CAUSE.
    // "Try again" is good advice for a slow service and bad advice for a
    // broken endpoint, so the two don't share a message.
    const message =
      lastKind === "timeout"
        ? `The state's aerial photo service didn't answer, even after ${cfg.imageAttempts === 1 ? "one try" : `${cfg.imageAttempts} tries`}. ` +
          `It's a free public service and its speed is very unpredictable — some minutes it answers instantly, ` +
          `some not at all. Trying again usually works.`
        : lastKind === "upstream"
          ? `The state's aerial photo service turned the request away${lastUpstream ? ` — it said: "${lastUpstream}"` : ""}. ` +
            `That points to a setting being wrong rather than the service being down, so trying again won't help. ` +
            `A Super should check the aerial photo address in Settings, under Property Records.`
          : `We couldn't reach the state's aerial photo service at all. That's usually a network problem ` +
            `on this end rather than anything to do with the property — check the connection and try again.`;
    throw new ServiceError("IMAGERY_UNAVAILABLE", message, 502);
  }

  const mime = cfg.imageFormat === "png" ? "image/png" : "image/jpeg";
  const key = `parcel/${propertyId}-${Date.now()}.${cfg.imageFormat}`;
  await putObjectBuffer(key, buf, mime, "property-photos");
  // audit-allow: records where the cached public-imagery file landed in R2.
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      parcelImageKey: key,
      parcelImageAt: new Date(),
      parcelImageBox: { minX, minY, maxX, maxY, width: wPx, height: hPx } as any,
    },
  });
  return {
    url: await getDownloadUrl(key, 900, "property-photos"),
    cached: false,
    bbox: { minX, minY, maxX, maxY },
    width: wPx, height: hPx,
  };
}
