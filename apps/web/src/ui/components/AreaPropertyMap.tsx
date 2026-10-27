"use client";

// THE AREA MAP — an area's properties as pins, on an OpenStreetMap basemap.
//
// WHY THE POINTS ARRIVE IN DRIBS. Geocoding is the slow part: the free US
// Census geocoder takes about three and a half SECONDS per address
// (measured, not assumed), and production has dozens of properties with no
// point yet. One request that geocoded them all would take roughly a minute
// and exceed the serverless budget, returning nothing. So the map opens on
// whatever is already known and asks for small batches until `remaining`
// reaches zero, dropping pins in as they land.
//
// EVERY POINT IS PERSISTED AS IT IS FOUND, which is why this needs no cron
// and no backfill script: the cost is paid once per property, ever, and
// closing the page halfway loses nothing. It is also why the progress
// counter matters — without it a slowly-filling map looks broken rather
// than busy.
//
// LEAFLET IS LOADED LAZILY, inside an effect. It touches `window` at import
// time, so a top-level import breaks the server render; and it is only
// needed by whoever actually opens the map.

import { useEffect, useRef, useState } from "react";
import { Box, Button, HStack, Progress, Text } from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";

type Point = {
  id: string;
  displayName: string;
  street1: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  parcelLookupError: string | null;
  area: { id: string; name: string } | null;
  client: { displayName: string | null } | null;
};

type PointsResponse = {
  /** The area's own configured point — what its weather is anchored on. */
  areaCentre: { id: string; name: string; lat: number; lng: number } | null;
  points: Point[];
  total: number;
  placed: number;
  pending: number;
  unplaceable: number;
};

export default function AreaPropertyMap({ areaId }: { areaId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  const [data, setData] = useState<PointsResponse | null>(null);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Stops the batch loop when the component goes away mid-flight — each
  // batch is seconds long, so this is a real window, not a formality.
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  // 1. The fast read. Always first, so the map appears immediately.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    loopFor.current = null;
    (async () => {
      try {
        const res = await apiGet<PointsResponse>(`/api/properties/points?areaId=${encodeURIComponent(areaId)}`);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [areaId]);

  // One fill loop per area, ever. A ref rather than an effect dependency:
  // the loop writes `data` on every batch, so any dep derived from `data`
  // either re-triggers it or — as happened first — never changes at all.
  // The original condition was `data?.pending === 0`, which is `false`
  // both while `data` is null AND once points are pending, so the
  // dependency never flipped and the loop never started: the map filled to
  // whatever was already geocoded and quietly stopped.
  const loopFor = useRef<string | null>(null);

  // 2. The slow fill, in small batches, until nothing is pending.
  useEffect(() => {
    if (!data || data.pending === 0) return;
    if (loopFor.current === areaId) return;
    loopFor.current = areaId;
    (async () => {
      setResolving(true);
      try {
        while (liveRef.current) {
          const res = await apiPost<{ resolved: Array<{ id: string; lat: number; lng: number }>; remaining: number }>(
            "/api/properties/points/resolve",
            { areaId, limit: 5 },
          );
          // NOT GATED ON AN EFFECT-SCOPED `cancelled` FLAG. It was, and
          // the batch's results were being thrown away: `setResolving(true)`
          // changed this effect's dependencies, React ran the cleanup, the
          // flag flipped, and the already-fetched points hit `break` before
          // the fold below. They were persisted on the server and lost in
          // the browser, so the map sat at its opening count while the
          // network log showed batches succeeding.
          //
          // `liveRef` is the right test: it asks "is the component still
          // mounted", which is the only reason to discard an answer we
          // have already paid three seconds an address for.
          if (!liveRef.current) break;
          // Fold the new points into what is already drawn rather than
          // refetching the list — a refetch would redraw every pin and
          // fight the user's pan/zoom.
          setData((prev) => {
            if (!prev) return prev;
            const byId = new Map(res.resolved.map((r) => [r.id, r]));
            const points = prev.points.map((p) =>
              byId.has(p.id) ? { ...p, lat: byId.get(p.id)!.lat, lng: byId.get(p.id)!.lng } : p,
            );
            return {
              ...prev,
              points,
              placed: points.filter((p) => p.lat != null).length,
              pending: res.remaining,
              unplaceable: points.filter((p) => p.lat == null && !!p.parcelLookupError).length,
            };
          });
          if (res.remaining === 0) break;
          // Nothing moved and nothing left to try — stop rather than spin.
          if (res.resolved.length === 0) break;
        }
      } catch {
        // A failed batch stops the fill; the points already found stay on
        // the map and reopening tries again.
      } finally {
        if (liveRef.current) setResolving(false);
      }
    })();
    // `!!data` only: the loop needs to start once, when the first read
    // lands. Depending on `data` itself would re-run this on every batch
    // it folds in, and depending on `resolving` would re-run it the moment
    // it sets its own flag. The ref above is what keeps it to one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaId, !!data]);

  // 3. Draw. Leaflet is imported here, not at module scope.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!hostRef.current || !data) return;
      const L = leafletRef.current ?? (await import("leaflet")).default;
      if (cancelled) return;
      leafletRef.current = L;

      if (!mapRef.current) {
        mapRef.current = L.map(hostRef.current, { scrollWheelZoom: false });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors",
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
      }

      layerRef.current.clearLayers();
      // THEME TOKENS, RESOLVED TO VALUES. Leaflet sets `fill` and `stroke`
      // as SVG ATTRIBUTES, and `var(--…)` does not resolve in an attribute
      // — only in a CSS property. So the token is read off the document
      // here and the concrete colour handed over. Hardcoding the hex would
      // paint the same two colours in all fourteen themes, which is what
      // the theming gate exists to stop.
      // NO HEX FALLBACK. A literal here would be the same colour in all
      // fourteen themes, which is the thing being avoided; if a token is
      // ever missing, `undefined` lets Leaflet fall back to its own
      // default rather than freezing one theme's palette into the code.
      const token = (name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
      const inArea = token("--chakra-colors-purple-solid");
      const noArea = token("--chakra-colors-red-solid");
      const centre = token("--chakra-colors-blue-solid");

      const placed = data.points.filter((p) => p.lat != null && p.lng != null);
      for (const p of placed) {
        // A property with NO area is drawn differently on purpose — the
        // map is the best place to notice one, and an untagged property is
        // invisible to every area-scoped reader.
        const colour = p.area ? inArea : noArea;
        L.circleMarker([p.lat!, p.lng!], {
          radius: 7,
          color: colour,
          fillColor: colour,
          fillOpacity: 0.85,
          weight: 2,
        })
          .bindPopup(
            `<strong>${escapeHtml(p.displayName)}</strong><br/>` +
              `${escapeHtml([p.street1, p.city].filter(Boolean).join(", "))}<br/>` +
              `<em>${escapeHtml(p.area?.name ?? "No area")}</em>`,
          )
          .addTo(layerRef.current);
      }

      // THE AREA'S OWN POINT, drawn differently and said out loud.
      //
      // It is not another property — it is the coordinate the area's
      // WEATHER is forecast from. Showing it against the real properties
      // is the only way to notice it is in the wrong place, which is a
      // mistake that otherwise surfaces as a forecast quietly describing
      // somewhere else. A hollow ring with a crosshair reads as "a
      // reference point" rather than "a thing you visit".
      const c = data.areaCentre;
      if (c) {
        L.circleMarker([c.lat, c.lng], {
          radius: 11,
          color: centre,
          fillColor: centre,
          fillOpacity: 0.12,
          weight: 3,
          dashArray: "4 3",
        })
          .bindPopup(
            `<strong>${escapeHtml(c.name)} — area centre</strong><br/>` +
              `Weather for this area is forecast from here.`,
          )
          .addTo(layerRef.current);
      }

      // The centre counts toward the frame, so a point set miles from the
      // work is visible rather than cropped out of the view that would
      // have revealed it.
      const framePoints: Array<[number, number]> = [
        ...placed.map((p) => [p.lat!, p.lng!] as [number, number]),
        ...(c ? [[c.lat, c.lng] as [number, number]] : []),
      ];
      if (framePoints.length > 0) {
        const bounds = L.latLngBounds(framePoints);
        mapRef.current.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
      } else {
        // Nothing placed yet — sit on the state rather than the null island
        // off the coast of Africa, which is where [0,0] would put you.
        mapRef.current.setView([35.78, -78.9], 8);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  // Tear the map down with the component, or Leaflet keeps the container.
  useEffect(() => () => {
    try { mapRef.current?.remove(); } catch { /* already gone */ }
    mapRef.current = null;
  }, []);

  if (failed) return <Text fontSize="xs" color="red.fg">Couldn&rsquo;t load the map.</Text>;

  const total = data?.total ?? 0;
  const placed = data?.placed ?? 0;
  const pending = data?.pending ?? 0;
  const unplaceable = data?.unplaceable ?? 0;

  return (
    <Box>
      {/* THE PROGRESS LINE. Without it a map that fills in over a minute
          reads as broken rather than busy — and the denominator is the
          point: "2/51" says both that it is working and how long it has
          to go. It disappears once there is nothing pending. */}
      {data && pending > 0 && (
        <Box mb={2}>
          <HStack justify="space-between" mb={1}>
            <Text fontSize="xs" color="fg.muted">
              Locating properties — {placed}/{total} loaded
            </Text>
            <Text fontSize="2xs" color="fg.muted">first time only</Text>
          </HStack>
          <Progress.Root value={total ? (placed / total) * 100 : 0} size="xs" colorPalette="purple">
            <Progress.Track><Progress.Range /></Progress.Track>
          </Progress.Root>
        </Box>
      )}

      <Box
        ref={hostRef}
        h="420px"
        w="full"
        rounded="md"
        borderWidth="1px"
        borderColor="border"
        overflow="hidden"
        data-testid="area-map"
      />

      <HStack mt={2} gap={3} wrap="wrap">
        <Text fontSize="2xs" color="fg.muted">
          {placed} of {total} shown
        </Text>
        {unplaceable > 0 && (
          // SAY SO rather than quietly showing fewer pins than the list.
          <Text fontSize="2xs" color="orange.fg">
            {unplaceable} couldn&rsquo;t be placed from {unplaceable === 1 ? "its address" : "their addresses"}
          </Text>
        )}
        {data?.areaCentre && (
          <Text fontSize="2xs" color="blue.fg">
            ◎ area centre — the weather is forecast from here
          </Text>
        )}
        {resolving && <Text fontSize="2xs" color="purple.fg">Locating…</Text>}
      </HStack>
    </Box>
  );
}

/** Popups take an HTML string, so anything from the database is escaped. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
