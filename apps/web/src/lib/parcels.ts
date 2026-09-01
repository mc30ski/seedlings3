// Public parcel record + overhead imagery — mirrors apps/api/src/services/parcels.ts.
//
// Admin-gated: the payload carries the owner of record and the county's
// appraised value. Public record, but not worker-facing.

import { apiGet } from "@/src/lib/api";

export type ParcelAttributes = {
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
  /** Where the acreage came from — counties disagree about which fields
   *  they populate, so the dialog says which one answered. */
  acresBasis: string;
  /** False when the parcel's own site address couldn't confirm the match —
   *  the county publishes no addresses, so we fell back to the nearest
   *  parcel to a geocode point that sits in the road. */
  confident: boolean;
  /** How the parcel was matched — house number, or nearest-within-N-feet. */
  source: string;
};

export type ParcelResult = {
  cached: boolean;
  fetchedAt: string | null;
  data: ParcelAttributes | null;
  boundary: number[][][] | null;
  lat: number | null;
  lng: number | null;
  /** Set when the lookup ran and found nothing — out of state, or an address
   *  the geocoder can't place. Shown to the operator rather than swallowed. */
  error: string | null;
  /** Our address for the property, for building outbound links. */
  address: { street1: string; city: string; state: string; postalCode: string };
  /** True when the server stripped the value + owner fields because the
   *  caller is a worker. Drives what the dialog offers, so the UI never has
   *  to guess whether a null means "redacted" or "the county has no value". */
  redacted: boolean;
};

/**
 * Zillow's address-search URL.
 *
 * A LINK, not the API — Zillow retired public API access in 2021 and the
 * Zestimate is now gated behind an MLS-membership partner programme, so the
 * only sanctioned way to see their market estimate is to open the page.
 *
 * `/homes/<slug>_rb/` is their canonical address-search form; it lands on the
 * property page when Zillow has the address and on a search result when it
 * doesn't. Punctuation is stripped because periods and commas break the slug.
 */
export function zillowUrl(a: ParcelResult["address"]): string {
  const slug = [a.street1, a.city, a.state, a.postalCode]
    .filter(Boolean)
    .join(" ")
    .replace(/[.,#]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
}

/** Google Maps, which also gets you Street View — the front-yard view an
 *  overhead shot can't give you. */
export function mapsUrl(a: ParcelResult["address"]): string {
  const q = [a.street1, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Under /me/, not /admin/: every approved role may open this. The server
// decides how much of it to send back — see routes/me.ts.
export const getPropertyParcel = (propertyId: string, refresh = false) =>
  apiGet<ParcelResult>(`/api/me/properties/${propertyId}/parcel${refresh ? "?refresh=1" : ""}`);

/**
 * Short-lived signed R2 URL for the overhead image.
 *
 * NOT the API route itself: an `<img src>` sends no Clerk token, so pointing
 * it at the admin-gated endpoint 401s and the image silently fails to render
 * (observed while prototyping, 2026-09-01). The server hands back an expiring
 * link instead — same pattern as guide assets and property photos.
 */
export type ParcelImage = {
  url: string;
  cached: boolean;
  /** Geographic extent of the image, for drawing the boundary over it. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
};

export const getParcelImageUrl = (propertyId: string) =>
  apiGet<ParcelImage>(`/api/me/properties/${propertyId}/parcel/image`);
