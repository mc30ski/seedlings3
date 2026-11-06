"use client";

// THE PORTFOLIO MAP — a portfolio's properties as pins, on an OpenStreetMap basemap.
//
// The Leaflet lifecycle (lazy import, the tile `max-width` reset, the observed
// resize, the re-fit, teardown) lives in `leafletMap.tsx`, and the two-phase
// read-then-geocode fetch in `usePropertyPoints`. Both are shared with the day
// map on the Jobs tab. What stays here is the only thing the two maps do
// differently: WHAT is drawn and how it is coloured.

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, HStack, Progress, Text } from "@chakra-ui/react";
import { portfolioNames } from "@/src/lib/portfolios";
import { paletteFor, resolvePaletteColor, type PortfolioPalette } from "@/src/lib/portfolioColors";
import { usePropertyPoints } from "@/src/lib/usePropertyPoints";
import {
  MapControls,
  MapExpandButton,
  MapHost,
  escapeMapHtml,
  expandedOverlayProps,
  mapToken,
  useEscapeToCollapse,
  useLeafletMap,
} from "@/src/ui/components/leafletMap";

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
  const { ensure, fitTo } = useLeafletMap(hostRef);

  const { data, failed, resolving, total, placed, pending, unplaceable } =
    usePropertyPoints({ portfolioId, status });

  /** Full-page. A 420px strip is enough to see that pins exist and not
   *  enough to see where they are relative to each other, which is the
   *  question the map is for. */
  const [expanded, setExpanded] = useState(false);
  useEscapeToCollapse(expanded, () => setExpanded(false));

  /** Bands switched OFF. Stored as the hidden set rather than the shown
   *  one so a band added later (a new zone) starts visible — the opposite
   *  default would silently hide new work. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());

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

  // Draw. Redraws on a legend toggle, because that changes what should be on
  // screen and does not change `data`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!data) return;
      const handles = await ensure();
      if (!handles || cancelled) return;
      const { L, layer } = handles;

      layer.clearLayers();
      const noPortfolio = mapToken("--chakra-colors-red-solid");
      const centre = mapToken("--chakra-colors-blue-solid");

      // Hidden bands are not drawn AND not framed, so switching the big
      // one off actually zooms into what is left rather than leaving the
      // view sitting over the gap it used to fill.
      const shown = data.points.filter(
        (p) => p.lat != null && p.lng != null && !hidden.has(bandOf.get(p.id) ?? ""),
      );
      for (const p of shown) {
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
            `<strong>${escapeMapHtml(p.displayName)}</strong><br/>` +
              `${escapeMapHtml([p.street1, p.city].filter(Boolean).join(", "))}<br/>` +
              `<em>${escapeMapHtml(portfolioNames(p).join(" · ") || "No portfolio")}</em>`,
          )
          .addTo(layer);
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
            `<strong>${escapeMapHtml(c.name)} — portfolio center</strong><br/>` +
              `Weather for this portfolio is forecast from here.`,
          )
          .addTo(layer);
      }

      // The centre counts toward the frame, so a point set miles from the
      // work is visible rather than cropped out of the view that would
      // have revealed it.
      fitTo([
        ...shown.map((p) => [p.lat!, p.lng!] as [number, number]),
        ...(c ? [[c.lat, c.lng] as [number, number]] : []),
      ]);
    })();
    return () => { cancelled = true; };
  }, [data, hidden, bandOf, paletteOf, ensure, fitTo]);

  if (failed) return <Text fontSize="xs" color="red.fg">Couldn&rsquo;t load the map.</Text>;

  /** The legend, catch-all last. Bands with nothing in them are dropped —
   *  a colour key listing zones that contribute no pins is noise. */
  const legend = [
    ...bands.map((b) => ({ id: b.id, name: b.name, palette: paletteOf.get(b.id)! })),
    { id: "", name: `In ${portfolioName} directly`, palette: paletteOf.get("")! },
  ].filter((b) => (counts.get(b.id) ?? 0) > 0);

  return (
    <Box {...expandedOverlayProps(expanded)}>
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

      <Box position="relative">
        <MapHost hostRef={hostRef} expanded={expanded} testId="portfolio-map" />
        <MapControls>
          <MapExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </MapControls>
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
            ◎ portfolio center — the weather is forecast from here
          </Text>
        )}
        {resolving && <Text fontSize="2xs" color="purple.fg">Locating…</Text>}
      </HStack>
    </Box>
  );
}
