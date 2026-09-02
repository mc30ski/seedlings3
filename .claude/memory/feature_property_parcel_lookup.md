---
name: feature-property-parcel-lookup
description: "Property Records — public county parcel lookup (acreage, overhead imagery, assessment) opened from a job card. Built 2026-09-01. Endpoints are settings; response SHAPES are still hardcoded — deferred by the user."
metadata:
  type: project
---

# Property parcel lookup (built 2026-09-01, prototype in dev)

A map icon on every job card opens a dialog showing the property's **acreage**,
**overhead imagery with the parcel boundary drawn**, and (admins only) the
county assessment and owner of record.

All three external services are **free and unauthenticated** — no API keys:

1. **US Census geocoder** — address → coordinate
2. **NC OneMap parcels** (ArcGIS) — parcel containing that point
3. **NC OneMap orthoimagery** (ArcGIS) — 6 in/pixel overhead view

## Why matching is coordinate-based, not text

Three sources spell the same street three ways:

```
ours    "225 Stony Branch Trl"
county  "225  STONY BRANCH TRL"   (two spaces)
Census  "225 STONEY BRANCH TRL"   (an E)
```

So: geocode → search a radius → pick the parcel whose HOUSE NUMBER matches.
The radius is required because the Census geocoder interpolates along street
centrelines, putting its point in the ROAD — a bare point-in-polygon returns
zero.

## County data gaps (real, and they vary)

- **Orange County publishes NO site addresses** — 0 of 59,366 parcels — and
  zeroes `gisacres`. Chapel Hill, Carrboro and Hillsborough are all Orange.
  Acreage falls back `gisacres` → `recareano` → measured from the polygon.
  With no address to confirm against, matching degrades to nearest-parcel and
  the dialog shows an explicit **"Approximate match"** warning.
- Chatham leaves `scity` blank — filtering on city silently drops the county.
- ArcGIS signals errors with **HTTP 200 + a JSON body**, so responses are
  checked for `content-type: image/*` and a minimum size before caching.
  An earlier version cached a 62-byte error body as a `.jpg`.

## Deferred (user, 2026-09-01)

**Endpoints are settings; response shapes are not.** All 13 tunables live in
the `parcel` settings section ("Property Records"), generated from
`PARCEL_SETTINGS` in `services/parcels.ts` so defaults can't drift from rows.
Pointing `PARCEL_SERVICE_URL` at another state's ArcGIS server works; a
different *vendor* needs code — the readers assume an ArcGIS parcel layer and
a Census-shaped geocoder response. User: "okay for now, we can pick that up
later."

Also open: Orange County's own GIS server has rooftop address points
(`ARIESAddressPointLocator`) that would make matching exact there — a
per-county override, not yet built.

## Notes

- Cached on `Property` for `PARCEL_CACHE_DAYS` (365). `parcelData` carries a
  `version`; bump `PARCEL_DATA_VERSION` when its shape changes or stale
  records serve missing fields for a year.
- Imagery cached in the existing **property-photos** R2 bucket under
  `parcel/` — no new bucket, deliberately (see [[feature-education-guides]],
  still blocked on an unset bucket env var).
- Imagery rendered in **EPSG:4326** so the boundary overlay maps linearly and
  lands exactly; a projected SR looks identical but drifts.
- Workers get a **server-redacted** payload — no value, no owner. Enforced in
  `routes/me.ts`, covered by `parcel-worker.spec.ts` asserting on the wire.
  See [[reference-worker-sensitive-data]].
- Imagery latency is wildly erratic (1.2s–24.6s measured); hence a 45s
  timeout and a retry, both settings.
