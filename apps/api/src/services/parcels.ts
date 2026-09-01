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

export type ParcelConfig = {
  enabled: boolean;
  /** ArcGIS FeatureServer/MapServer layer query endpoint for parcel polygons. */
  parcelServiceUrl: string;
  /** ArcGIS ImageServer exportImage endpoint for orthoimagery. */
  imageServiceUrl: string;
  /** Re-resolve once the cached record is older than this. Parcel data is
   *  revalued on a multi-year county cycle, so this is deliberately long. */
  cacheDays: number;
  /** How far from the geocoded street point to look for candidate parcels. */
  searchRadiusFt: number;
  /** Longest edge of the cached image, in pixels. */
  imageMaxPx: number;
  /** Padding around the parcel in the image, in feet. */
  imageMarginFt: number;
  /** `jpg` or `png`. Aerial imagery is photographic, so PNG's lossless
   *  encoding buys nothing and costs ~5x the bytes — 806 KB vs ~150 KB at
   *  640px measured on one parcel. Only worth PNG if you need crisp overlaid
   *  vector lines, which we don't: the boundary is drawn client-side. */
  imageFormat: "jpg" | "png";
  /** Two-letter states the parcel service covers. A property outside these
   *  gets no lookup and no icon rather than a broken dialog. */
  states: string[];
};

/** Defaults describe North Carolina. Everything is overridable from Settings
 *  so covering another state is a config change, not a deploy. */
export const PARCEL_DEFAULTS: ParcelConfig = {
  enabled: true,
  parcelServiceUrl:
    "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query",
  imageServiceUrl:
    "https://services.nconemap.gov/secure/rest/services/Imagery/Orthoimagery_20242027_analysis/ImageServer/exportImage",
  cacheDays: 365,
  searchRadiusFt: 250,
  imageMaxPx: 640,
  imageMarginFt: 50,
  imageFormat: "jpg",
  states: ["NC"],
};

export const PARCEL_SETTING_KEY = "PARCEL_LOOKUP";

/**
 * Bump when the shape of `parcelData` changes.
 *
 * A cached record written by an older version is missing whatever field was
 * just added, and with a 365-day window it would keep serving that gap for a
 * year. Observed immediately: adding `confident` left every cached record
 * reading `undefined`, so the low-confidence warning never fired on data
 * resolved minutes earlier.
 */
const PARCEL_DATA_VERSION = 2;

export async function parcelConfig(): Promise<ParcelConfig> {
  const row = await prisma.setting.findUnique({ where: { key: PARCEL_SETTING_KEY } });
  if (!row?.value) return PARCEL_DEFAULTS;
  try {
    return { ...PARCEL_DEFAULTS, ...(JSON.parse(row.value) as Partial<ParcelConfig>) };
  } catch {
    // A malformed setting must not take the feature down — SettingsTab now
    // flags invalid JSON in place, which is where it gets fixed.
    return PARCEL_DEFAULTS;
  }
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
async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
    `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const body = await fetchJson(url);
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
  if (!cfg.enabled) throw new ServiceError("DISABLED", "Parcel lookup is turned off.", 400);

  const cachedVersion = (property.parcelData as any)?.version ?? 0;
  const fresh =
    !isStaleAfterDays(property.parcelFetchedAt, cfg.cacheDays) &&
    // A lookup that found nothing has no payload to version — don't force it
    // to re-run on every schema bump.
    (property.parcelLookupError != null || cachedVersion === PARCEL_DATA_VERSION);
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

  if (!cfg.states.includes((property.state ?? "").toUpperCase())) {
    return fail(`No parcel coverage for ${property.state || "this state"}.`);
  }

  const address = [property.street1, property.city, `${property.state} ${property.postalCode}`]
    .filter(Boolean).join(", ");
  let point: { lat: number; lng: number } | null;
  try {
    point = await geocode(address);
  } catch (e: any) {
    return fail(`Geocoder unavailable (${e?.message ?? "error"}).`);
  }
  if (!point) return fail("Address could not be located.");

  // Candidate parcels near the street point. Geometry comes back so we can
  // both rank by distance and cache the boundary in one call.
  const q =
    `${cfg.parcelServiceUrl}?geometry=${point.lng},${point.lat}` +
    `&geometryType=esriGeometryPoint&inSR=4326&distance=${cfg.searchRadiusFt}` +
    `&units=esriSRUnit_Foot&spatialRel=esriSpatialRelIntersects` +
    `&outFields=parno,siteadd,cntyname,gisacres,landval,improvval,parval,parvaltype,parusedesc,ownname` +
    `&returnGeometry=true&outSR=4326&f=json`;
  let body: any;
  try {
    body = await fetchJson(q, 25000);
  } catch (e: any) {
    return fail(`Parcel service unavailable (${e?.message ?? "error"}).`);
  }
  const features: any[] = body?.features ?? [];
  if (features.length === 0) return fail("No parcel found at this address.");

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
      ? "Matched by house number"
      : `Nearest of ${scored.length} parcels, ${Math.round(best.distFt)} ft from the geocoded address`,
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
    throw new ServiceError("BAD_STATE", "Resolve the parcel before requesting imagery.", 400);
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
  const IMAGE_TIMEOUT_MS = 45000;
  let buf: Uint8Array | null = null;
  let lastErr = "";
  let lastKind: "timeout" | "upstream" | "network" = "network";
  let lastUpstream: string | null = null;
  for (let attempt = 1; attempt <= 2 && !buf; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`the imagery service returned HTTP ${res.status}`);

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
        const err: any = new Error(`the imagery service returned an error instead of an image`);
        err.upstream = upstream;
        throw err;
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      // A zero-length or absurdly small body is not a usable picture either.
      if (bytes.byteLength < 1024) {
        throw new Error(`the imagery service returned only ${bytes.byteLength} bytes`);
      }
      buf = bytes;
    } catch (e: any) {
      // Keep the KIND of failure, not just its text — a timeout and a bad
      // endpoint need different advice, and conflating them produced
      // "returned Token Required … it is often slow, try again", which is
      // both contradictory and useless.
      lastKind = e?.name === "AbortError" ? "timeout" : (e?.upstream ? "upstream" : "network");
      lastErr = e?.message ?? "the imagery service could not be reached";
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
        ? `The imagery service didn't respond within ${IMAGE_TIMEOUT_MS / 1000} seconds, twice. ` +
          `It's a free public service with no uptime guarantee and its speed varies a lot — trying again usually works.`
        : lastKind === "upstream"
          ? `The imagery service rejected the request${lastUpstream ? ` ("${lastUpstream}")` : ""}. ` +
            `That's a configuration problem rather than an outage — check the imagery URL in ` +
            `Settings → ${PARCEL_SETTING_KEY}. Retrying won't help until it's corrected.`
          : `The imagery service couldn't be reached (${lastErr}). Check the connection and try again.`;
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
