"use client";

// THE PORTFOLIO MAP — a portfolio's properties as pins, on an OpenStreetMap basemap.
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

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, HStack, Progress, Text } from "@chakra-ui/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { portfolioNames } from "@/src/lib/portfolios";
import { paletteFor, resolvePaletteColor, type PortfolioPalette } from "@/src/lib/portfolioColors";

/**
 * One band of the legend: a portfolio whose properties are drawn together
 * in one colour.
 *
 * DEEPEST FIRST, which is what makes the colouring mean anything. A
 * property in both a zone and the district above it belongs, visually, to
 * the zone — the most specific true answer — and that is the same rule the
 * grouped list uses, so the two cannot disagree about where a property is
 * filed.
 */
export type MapBand = { id: string; name: string; color: string | null };

type Point = {
  id: string;
  displayName: string;
  street1: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  parcelLookupError: string | null;
  portfolios: { portfolio: { id: string; name: string } }[];
  client: { displayName: string | null } | null;
};

type PointsResponse = {
  /** The portfolio's own configured point — what its weather is anchored on. */
  portfolioCentre: { id: string; name: string; lat: number; lng: number } | null;
  points: Point[];
  total: number;
  placed: number;
  pending: number;
  unplaceable: number;
};

export default function PortfolioPropertyMap({
  portfolioId,
  portfolioName,
  bands,
  status,
}: {
  portfolioId: string;
  portfolioName: string;
  /** The portfolios beneath this one, deepest first. Empty for a leaf, and
   *  then the map is a single colour — there is nothing to tell apart. */
  bands: MapBand[];
  /** "ALL" (the default) pins archived properties too. Owned by the panel
   *  so one toggle moves the list and the map together. */
  status: "ACTIVE" | "ALL";
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  const [data, setData] = useState<PointsResponse | null>(null);
  /** Full-page. A 420px strip is enough to see that pins exist and not
   *  enough to see where they are relative to each other, which is the
   *  question the map is for. */
  const [expanded, setExpanded] = useState(false);
  /** Bands switched OFF. Stored as the hidden set rather than the shown
   *  one so a band added later (a new zone) starts visible — the opposite
   *  default would silently hide new work. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Stops the batch loop when the component goes away mid-flight — each
  // batch is seconds long, so this is a real window, not a formality.
  const liveRef = useRef(true);
  /** The points the current view was fitted to, so a resize can re-fit to
   *  them instead of leaving a full-page map zoomed for a 420px strip. */
  const frameRef = useRef<Array<[number, number]>>([]);

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
        const res = await apiGet<PointsResponse>(`/api/properties/points?portfolioId=${encodeURIComponent(portfolioId)}&status=${status}`);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
    // `status` too: switching archived off must re-read, or the map keeps
    // pins the list beside it has already dropped.
  }, [portfolioId, status]);

  // One fill loop per portfolio, ever. A ref rather than an effect dependency:
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
    if (loopFor.current === portfolioId) return;
    loopFor.current = portfolioId;
    (async () => {
      setResolving(true);
      try {
        while (liveRef.current) {
          const res = await apiPost<{ resolved: Array<{ id: string; lat: number; lng: number }>; remaining: number }>(
            "/api/properties/points/resolve",
            { portfolioId, limit: 5, status },
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
  }, [portfolioId, status, !!data]);

  /**
   * Which band each point belongs to, and how many are in each.
   *
   * `bands` arrives deepest-first, so the FIRST match is the most specific
   * portfolio the property is in — a property in both Briar Chapel and the
   * Chapel Hill district above it is drawn as Briar Chapel. The band id
   * `""` is the catch-all: in this portfolio directly, or in none of the
   * descendants.
   */
  const bandOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data?.points ?? []) {
      const ids = new Set((p.portfolios ?? []).map((x) => x.portfolio.id));
      m.set(p.id, bands.find((b) => ids.has(b.id))?.id ?? "");
    }
    return m;
  }, [data, bands]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const [, bandId] of bandOf) c.set(bandId, (c.get(bandId) ?? 0) + 1);
    return c;
  }, [bandOf]);

  /** Palette per band id, including the catch-all. Index-based fallback
   *  runs over the band order, so auto-coloured siblings stay distinct. */
  const paletteOf = useMemo(() => {
    const m = new Map<string, PortfolioPalette>();
    bands.forEach((b, i) => m.set(b.id, paletteFor(b, i)));
    m.set("", paletteFor({ color: "purple" }, 0));
    return m;
  }, [bands]);

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
      const noPortfolio = token("--chakra-colors-red-solid");
      const centre = token("--chakra-colors-blue-solid");

      // Hidden bands are not drawn AND not framed, so switching the big
      // one off actually zooms into what is left rather than leaving the
      // view sitting over the gap it used to fill.
      const placed = data.points.filter(
        (p) => p.lat != null && p.lng != null && !hidden.has(bandOf.get(p.id) ?? ""),
      );
      for (const p of placed) {
        // A property in NO portfolio is drawn differently on purpose — the
        // map is the best place to notice one, and such a property is
        // invisible to every portfolio-scoped reader and counts toward no
        // rollup. Being in several is normal and needs no special mark.
        const band = bandOf.get(p.id) ?? "";
        const colour =
          p.portfolios.length === 0
            ? noPortfolio
            : resolvePaletteColor(paletteOf.get(band) ?? "purple");
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
              `<em>${escapeHtml(portfolioNames(p).join(" · ") || "No portfolio")}</em>`,
          )
          .addTo(layerRef.current);
      }

      // THE PORTFOLIO'S OWN POINT, drawn differently and said out loud.
      //
      // It is not another property — it is the coordinate the portfolio's
      // WEATHER is forecast from. Showing it against the real properties
      // is the only way to notice it is in the wrong place, which is a
      // mistake that otherwise surfaces as a forecast quietly describing
      // somewhere else. A hollow ring with a crosshair reads as "a
      // reference point" rather than "a thing you visit".
      const c = data.portfolioCentre;
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
            `<strong>${escapeHtml(c.name)} — portfolio centre</strong><br/>` +
              `Weather for this portfolio is forecast from here.`,
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
      frameRef.current = framePoints;
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
    // Redraws on a legend toggle and after the container resizes, because
    // both change what should be on screen and neither changes `data`.
  }, [data, hidden, bandOf, paletteOf]);

  /**
   * TELL LEAFLET THE BOX CHANGED SIZE — observed, never timed.
   *
   * Leaflet caches the container size and only fetches tiles for the
   * viewport it believes in. Grow the box to full page without saying so
   * and you get the markers (re-projected from coordinates) on a blank
   * background (no tiles requested for the new area) — which is exactly
   * what going full-page looked like.
   *
   * This WAS a 60ms setTimeout after the `expanded` flip, which is a guess
   * at when the browser finishes laying out, and the guess is the bug: the
   * callback can land before the box has its new height, Leaflet re-reads
   * the OLD size, and nothing ever corrects it. A ResizeObserver fires on
   * the actual size change, however long that takes and whatever caused it
   * — expanding, a window resize, a phone rotating.
   *
   * Re-fitting is part of it. Without it a full-page map keeps the zoom
   * chosen for a 420px strip, so the pins sit in a tiny clump in the
   * middle of all that new space.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const map = mapRef.current;
      const L = leafletRef.current;
      if (!map || !L) return;
      try {
        map.invalidateSize();
        if (frameRef.current.length > 0) {
          map.fitBounds(L.latLngBounds(frameRef.current), { padding: [28, 28], maxZoom: 15 });
        }
      } catch {
        // Mid-teardown. The next draw sets it right.
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Escape leaves full-page. A map covering the window with its own close
  // button somewhere in the corner is a trap on a laptop.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

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

  /** The legend, catch-all last. Bands with nothing in them are dropped —
   *  a colour key listing zones that contribute no pins is noise. */
  const legend = [
    ...bands.map((b) => ({ id: b.id, name: b.name, palette: paletteOf.get(b.id)! })),
    { id: "", name: `In ${portfolioName} directly`, palette: paletteOf.get("")! },
  ].filter((b) => (counts.get(b.id) ?? 0) > 0);

  return (
    <Box
      // FULL PAGE IS A FIXED OVERLAY, not a taller box. Growing in place
      // would leave the map below the tab chrome and the detail panel,
      // scrolled halfway down a long page — which is the position the
      // expand is trying to escape.
      {...(expanded
        ? {
            position: "fixed" as const,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1400,
            bg: "bg.panel",
            p: 3,
            overflow: "auto" as const,
          }
        : {})}
    >
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

      {/* THE KEY, AND THE CONTROL. Each band is a toggle, because the
          question a colour-coded map answers is usually about one or two
          of them — "where does Briar Chapel actually reach" is unanswerable
          while forty-eight of its pins are buried under everything else.

          The count rides on the chip so the legend doubles as the
          breakdown, which is the number somebody came to the map for
          anyway. A band switched off keeps its colour at low opacity
          rather than turning grey: grey would read as a band that HAS no
          colour, and that is a different thing. */}
      {legend.length > 1 && (
        <HStack gap={1.5} wrap="wrap" mb={2}>
          {legend.map((b) => {
            const off = hidden.has(b.id);
            return (
              <HStack
                key={b.id || "__direct__"}
                as="button"
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(b.id)) next.delete(b.id);
                    else next.add(b.id);
                    return next;
                  })
                }
                aria-pressed={!off}
                aria-label={`${off ? "Show" : "Hide"} ${b.name}`}
                gap={1.5}
                px={2}
                py={1}
                rounded="full"
                borderWidth="1px"
                borderColor={off ? "border" : `${b.palette}.solid`}
                bg={off ? "transparent" : `${b.palette}.subtle`}
                opacity={off ? 0.55 : 1}
                cursor="pointer"
              >
                <Box w="10px" h="10px" rounded="full" bg={`${b.palette}.solid`} opacity={off ? 0.4 : 1} />
                <Text fontSize="2xs" textDecoration={off ? "line-through" : undefined}>
                  {b.name}
                </Text>
                <Text fontSize="2xs" color="fg.muted">{counts.get(b.id) ?? 0}</Text>
              </HStack>
            );
          })}
          {hidden.size > 0 && (
            <Button size="2xs" variant="ghost" onClick={() => setHidden(new Set())}>
              Show all
            </Button>
          )}
        </HStack>
      )}

      {/* AN EXPLICIT HEIGHT, MEASURED FROM THE VIEWPORT.
          This was a flex child at `flex: 1` with the map absolutely
          positioned inside it, and the map came out TWO PIXELS TALL —
          measured, not guessed. Percentage and flex heights both resolve
          against a parent chain that has to have committed to a height
          first, and one link in that chain had not, so the whole thing
          collapsed to its content.
          `100vh` minus the chrome is arithmetic the browser can always
          do. Less elegant, no ambiguity. The chrome is the 12px padding
          top and bottom, the legend row and the footer line. */}
      <Box position="relative">
        <Box
          ref={hostRef}
          h={expanded ? "calc(100vh - 118px)" : "420px"}
          w="full"
          /**
           * TILES MUST NOT BE CONSTRAINED BY THE IMAGE RESET.
           *
           * A tile is a 256px <img> inside a chain of zero-width absolute
           * panes, so `max-width: 100%` resolves it to ZERO — present in
           * the DOM, `leaflet-tile-loaded`, fully opaque, and nought
           * pixels wide. That is what "the map expands and shows nothing"
           * actually was: measured at width 0, height 256.
           *
           * Leaflet ships `.leaflet-container img { max-width: none }` for
           * exactly this reason and it was losing here, so the rule is
           * asserted where it cannot be outranked — scoped to this host,
           * so no other image in the app is affected.
           */
          css={{ "& img": { maxWidth: "none", maxHeight: "none" } }}
          rounded="md"
          borderWidth="1px"
          borderColor="border"
          overflow="hidden"
          data-testid="portfolio-map"
        />
        <Button
          size="xs"
          variant="solid"
          colorPalette="gray"
          position="absolute"
          top={2}
          right={2}
          zIndex={500}
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Shrink the map" : "Expand the map to the whole page"}
          title={expanded ? "Shrink (Esc)" : "Expand"}
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </Button>
      </Box>

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
        {data?.portfolioCentre && (
          <Text fontSize="2xs" color="blue.fg">
            ◎ portfolio centre — the weather is forecast from here
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
