---
name: reference_weather_config
description: "Two weather systems. The WeatherBar needs WEATHER_API_KEY (OpenWeather) which the seed NEVER creates; the hourly occurrence forecast uses open-meteo and needs no key. Location precedence is BUSINESS_ADDRESS, then device, then IP."
metadata:
  node_type: memory
  type: reference
---

**There are TWO weather systems and only one of them can break on a missing key.**

1. **The WeatherBar / title-bar chip** → `/api/weather/location` + `/api/weather`
   → **OpenWeatherMap**, needs `WEATHER_API_KEY` (Setting row, falling back to
   `OPENWEATHER_API_KEY` in env). Four callers gate on that one value:
   `routes/weather.ts`, `services/displays.ts`, `services/occurrenceWeather.ts`,
   `lib/businessLocation.ts`.
2. **The hour-by-hour occurrence forecast** → **open-meteo**, no key, driven by
   `HOURLY_WEATHER_*` settings. Works in dev with no configuration.

So "weather is broken" is usually half-broken, which is why it reads as a bug
rather than as missing config.

**`WEATHER_API_KEY` IS NOT SEEDED AND NEVER HAS BEEN.** It appears in `seed.ts`
only in the map that stamps each setting's *section* for the Settings tab, and
that stamping step is an `updateMany` — a no-op on a key with no row. Verified
with `git log -S`: it has only ever entered seed.ts as a section label. Dev had
no row at all until 2026-10-26, when it was copied from prod (prod has had a
32-char key all along).

**Settings upserts preserve the VALUE.** The seed's pattern is
`update: { description, updatedById }` — it refreshes the description and
deliberately leaves `value` alone. Consequences worth knowing:
- A hand-set dev value SURVIVES a reseed. If a setting goes missing, suspect a
  database reset/recreate, not `db:seed`.
- Changing a default in `seed.ts` only affects a FRESH database. To change an
  existing one you must upsert it directly — see
  [[feedback_settings_dev_then_neon]].

**`BUSINESS_ADDRESS` now defaults to the real address in `seed.ts`**
(2026-10-26) because it is not just statement letterhead — `businessLatLng()`
geocodes it, and with it blank the weather bar falls back to geolocating the
developer's own device.

**Location precedence in `WeatherBar.tsx`**, and the reason for it:
`BUSINESS_ADDRESS` → browser geolocation (only when `allowGeolocation`) →
server IP lookup. Business-first is DELIBERATE: device location answers "where
is the person holding the phone", and checking tomorrow's schedule from another
town silently returned that town's forecast. A side effect worth keeping — with
the address set, workers never see the location permission prompt.

**Weather at a specific job is already solved better than device GPS**:
`hourlyForecastForOccurrence` uses the PROPERTY's `lat`/`lng` (populated by the
parcel lookup), so it reports the weather at the work, not at the worker.

**THE AREA LENS OVERRIDES THE BUSINESS ADDRESS — built 2026-10-26.**
`Area.lat`/`Area.lng` added (migration `20261026183303_area_lat_lng`), set per
area on the Areas tab. Precedence in `GET /weather/location` is now
**area lens → BUSINESS_ADDRESS → device → IP**.

- **Operator-set, NOT a centroid of the area's properties.** A centroid moves
  every time a client joins or leaves, so the forecast anchor would drift for
  reasons that are not geography. (An earlier note here suggested the centroid
  and claimed it needed no schema change — true of the centroid, irrelevant
  once the user chose real columns.)
- **Both coordinates or neither**, enforced in `areas.rename` and mirrored in
  the editor. Half a point reads as "configured" and then resolves to nothing.
- **A SOLE ROOT GETS NO COORDINATE FIELDS.** "All areas" is the container,
  not a territory, and the argument is mechanical rather than philosophical:
  the lens picker already leaves a sole root out (its path prefixes
  everything, so choosing it filters nothing), so it can never BE the lens,
  so coordinates on it could never be read. The editor shows "Weather here
  uses the business address" instead, and omits lat/lng from the PATCH
  entirely rather than sending null — a form that never offered the control
  must not wipe a value through it.
- **No ancestor walk.** A district with no point falls through to the business
  address rather than borrowing its region's — an inherited coordinate is
  indistinguishable from a deliberate one when the forecast is for the wrong
  town.
- `routes/weather.ts` is the fourth file admitted to **G47**'s `lensPath`
  allow-list. The test for admission is not "it needs the lens" but "nothing
  it does with the lens can become a refusal" — a wrong coordinate is a bad
  forecast, not a locked door.
- `WeatherBar` listens for `AREA_LENS_CHANGED_EVENT`: it lives in the header,
  so the tab-content remount on a lens change does not reach it.

Dev areas carry real points (Durham 35.994/-78.899, Chapel Hill 35.913/-79.056)
so the two forecast differently and a test cannot pass by coincidence. Bound by
the "forecast follows the lens" case in `area-lens-owner.spec.ts`.

**THE AREA MAP (2026-10-26)** — Areas tab → pick an area → List/Map
toggle. Leaflet + OpenStreetMap tiles; no API key, no cost.

- **Pins fill in PROGRESSIVELY — no cron, no backfill script.** The free
  Census geocoder takes **~3.5 SECONDS per address** (measured, not
  assumed). A whole area in one request exceeds the serverless budget and
  returns nothing, so the map opens instantly on what is known and asks
  `POST /properties/points/resolve` for batches of five until `remaining`
  hits zero. Every point is PERSISTED as found: the cost is paid once per
  property ever, and closing the page halfway loses nothing.
- Progress reads **"3/8 loaded"**. Without a denominator a slowly-filling
  map looks broken rather than busy.
- **Prod was ALREADY 42/93 geocoded** before any of this, filled lazily by
  the parcel/weather paths. There was never a backfill to run — I claimed
  otherwise once; check before repeating it.
- ~1 in 3 of the dev fixture's invented addresses will not geocode (real
  prod addresses do far better). A failure writes `parcelLookupError` so
  it is skipped rather than retried at 3s a go forever, and the map SAYS
  "N couldn't be placed" instead of quietly showing fewer pins than the
  list.
- **The AREA'S OWN POINT is drawn** as a dashed ring labelled "area centre
  — the weather is forecast from here". That is the only way to notice the
  weather anchor sitting in the wrong place. Absent when the area has none,
  and it counts toward the map's bounds so a badly-placed one is not
  cropped out of the very view that would reveal it.
- A property with **no area** is drawn in red — the map is the best place
  to notice one.
- Marker colours are theme tokens read via `getComputedStyle`, NOT hex.
  Leaflet sets `fill`/`stroke` as SVG **attributes**, where `var(--…)` does
  not resolve — only in a CSS property.

**A React bug worth not repeating.** The batch loop first depended on
`data?.pending === 0`, which is `false` both while `data` is null and once
points are pending — so it never changed and the loop never ran. Fixing
that exposed a second one: `setResolving(true)` changed the effect's deps,
React ran the cleanup, and the already-fetched batch hit a `cancelled`
check BEFORE folding its results in — points saved on the server, thrown
away in the browser, while the network log showed success. The loop is now
guarded by a ref (one per area) and gated only on "is the component still
mounted".

See [[project_area_hierarchy_design]] for the lens itself.
