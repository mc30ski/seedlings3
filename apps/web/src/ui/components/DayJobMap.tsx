"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE DAY MAP — one day's visits as pins, in place of that day's cards.
//
// WHY IT EXISTS. The feed answers "what is on today" and answers it well. It
// cannot answer "where is today" — whether the day is one tight loop or four
// corners of the county, which two visits are on the same street, whether the
// unclaimed one is anywhere near somebody already out. Those are questions
// about geography, and a list cannot be read for geography at any length.
//
// IT REPLACES THE DAY'S CARDS RATHER THAN SITTING ABOVE THEM. A map and a
// twelve-card list stacked together is a page nobody can see either half of on
// a phone, and the toggle is per day: mapping today while reading tomorrow is
// the normal case, not an edge one.
//
// COLOURED BY WHAT STATE THE VISIT IS IN, which is the question a day asks —
// what is done, what is running, what has not been picked up. The portfolio map
// next door colours by portfolio because the question THERE is "where does this
// zone reach". Same machinery (see `leafletMap.tsx` and `usePropertyPoints`),
// different question, so deliberately different colours.
//
// NO NUMBERS ON THE PINS. Numbering would read as a route, and the Jobs feed
// does not commit to an order — the Routes tab is where a day is actually
// planned and sequenced. A map that implied an order it does not have would be
// worse than one that stays silent about it.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, HStack, Progress, Text } from "@chakra-ui/react";
import { RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { usePropertyPoints } from "@/src/lib/usePropertyPoints";
import {
  MapControls,
  MapExpandButton,
  MapHost,
  escapeMapHtml,
  expandedOverlayProps,
  paletteSolid,
  useEscapeToCollapse,
  useLeafletMap,
} from "@/src/ui/components/leafletMap";

/**
 * One visit, as much of it as the map needs.
 *
 * A narrow shape on purpose: the feed's own row type carries a hundred fields
 * and half the tab's logic with it, and a map that accepted it would be
 * impossible to render anywhere else or to test on its own.
 */
export type DayStop = {
  occurrenceId: string;
  propertyId: string;
  propertyName: string;
  clientName: string | null;
  /** JobOccurrence.status, verbatim. */
  status: string;
  /** Who is on it. Empty means nobody has picked it up. */
  assignees: string[];
};

/**
 * THE BANDS, AND THE ONE PLACE THEY ARE DECIDED.
 *
 * Order is the rule, not decoration: a finished visit is finished whether or
 * not anybody is still listed on it, so the terminal states are tested before
 * "has nobody on it". Reversing those two would file every completed unclaimed
 * visit under Unclaimed and tell the operator there is work outstanding that
 * is not.
 *
 * The hues follow the card vocabulary already on this tab — yellow unclaimed,
 * orange paused, green awaiting payment, grey done — and blue for a visit in
 * progress, which is the colour the card's own pulse uses for running work.
 */
const DAY_BANDS = [
  { id: "done", label: "Done", palette: "gray" },
  { id: "payment", label: "Awaiting payment", palette: "green" },
  { id: "active", label: "In progress", palette: "blue" },
  { id: "paused", label: "Paused", palette: "orange" },
  { id: "unclaimed", label: "Unclaimed", palette: "yellow" },
  { id: "scheduled", label: "Scheduled", palette: "teal" },
] as const;

type BandId = (typeof DAY_BANDS)[number]["id"];

const BAND = new Map(DAY_BANDS.map((b) => [b.id as BandId, b]));

const DONE_STATUSES = new Set(["CLOSED", "COMPLETED", "ESTIMATE_ACCEPTED", "ESTIMATE_REJECTED", "CANCELED"]);
const PAUSED_STATUSES = new Set(["PAUSED", "STREAM_PAUSED"]);

/**
 * One visit in words: its state, and who is on it.
 *
 * The two are not always two facts. "Unclaimed" IS the answer to who is on
 * it, so naming both produced "Unclaimed · unclaimed" on every pin of an
 * unpicked-up visit — which is most of a morning's map.
 */
export function stopLine(s: DayStop): string {
  const band = BAND.get(bandOfStop(s))!.label;
  return s.assignees.length ? `${band} · ${s.assignees.join(", ")}` : band;
}

export function bandOfStop(s: DayStop): BandId {
  if (DONE_STATUSES.has(s.status)) return "done";
  if (s.status === "PENDING_PAYMENT") return "payment";
  if (s.status === "IN_PROGRESS") return "active";
  if (PAUSED_STATUSES.has(s.status)) return "paused";
  if (s.assignees.length === 0) return "unclaimed";
  return "scheduled";
}

/**
 * HOW TALL THE MAP IS, ON THE TAB'S OWN DENSITY SETTING.
 *
 * The same control that cycles the cards ultra → semi → expanded sizes the
 * map, because it is the same question asked of the same day: how much of the
 * screen is this day worth right now. Giving the map its own height control
 * would mean two settings meaning one thing, and the second one forgotten.
 *
 * Ultra is deliberately still useful rather than a sliver — below about 200px
 * a county-wide spread of pins collapses into one smudge and the map stops
 * answering anything. Full-page is a FOURTH state and a different kind of
 * thing: a temporary overlay you escape out of, not a density you live in.
 */
const MAP_HEIGHT: Record<"ultra" | "semi" | "expanded", Record<string, string>> = {
  // A PHONE IS NOT A SHORT DESKTOP. The desktop heights were applied
  // everywhere at first, and on a 390×844 phone the expanded map was 640px —
  // the whole screen, with the day's header scrolled off the top and nothing
  // below it to say the feed continued. Even Ultra at 220px took a third of
  // the viewport for the smallest state there is.
  //
  // The phone column is sized so the map stays a thing ON the page: the
  // header above it and the start of the next day below it both remain in
  // view, which is what keeps the density a density rather than a takeover.
  // Whoever does want the whole screen has the expand button, and that is a
  // state you escape out of rather than scroll out of.
  //
  // Fixed pixels, not `vh`. A mobile browser's viewport unit changes as the
  // URL bar hides and shows, so a `vh` map resizes while you scroll — and
  // every resize re-fits the view, so the pins would drift under your thumb.
  ultra: { base: "150px", md: "220px" },
  semi: { base: "250px", md: "420px" },
  expanded: { base: "370px", md: "640px" },
};

/**
 * AND WHAT EACH PIN SAYS, which is the other half of a density.
 *
 * A card does not merely get taller as you expand it — it says more. A map
 * that only grew would be the same map at two sizes, so the pins gain a
 * permanent label at Expanded: the property, and under it the state and who
 * is on it. That is the density actually paying for the room it took.
 *
 * NOT AT THE SMALLER TWO. Labels are the width of their text, and a day's
 * visits cluster on the same few streets — at 220px a handful of them
 * overlap into an unreadable pile that also hides the pins underneath. The
 * popup is still there at every density for a pin you ask about; this is
 * about what the map says without being asked.
 */
const LABELS_AT: Record<"ultra" | "semi" | "expanded", boolean> = {
  ultra: false,
  semi: false,
  expanded: true,
};

/**
 * The size control's own vocabulary.
 *
 * NOT THE TOOLBAR'S ICONS. The tab's density button draws List / LayoutList /
 * Maximize2 — glyphs that describe how a CARD is laid out, which says nothing
 * on a map that has no cards; and its Maximize2 is the same glyph as the
 * full-page button that would sit right beside this one, which is the one
 * thing two adjacent controls must not share.
 *
 * THE GLYPH IS THE MAP'S OWN SHAPE at each size: a short wide box, a square,
 * a tall box. Nothing to learn — the icon is a picture of what you get, which
 * is why it beats both of the things it replaced. "S / M / L" was a code that
 * read as an initial for something and could only be learned by pressing it;
 * spelling out "Medium" fixed that and then sat a word on top of the map,
 * which is the one surface in the app where every pixel is content.
 *
 * It names the CURRENT size, not the next one — the same rule the day's
 * Map/List toggle follows, and the tooltip says what pressing it does.
 */
const SIZE_META: Record<"ultra" | "semi" | "expanded", { icon: typeof Square; name: string }> = {
  ultra: { icon: RectangleHorizontal, name: "Small" },
  semi: { icon: Square, name: "Medium" },
  expanded: { icon: RectangleVertical, name: "Large" },
};

const NEXT_SIZE: Record<"ultra" | "semi" | "expanded", "ultra" | "semi" | "expanded"> = {
  ultra: "semi",
  semi: "expanded",
  expanded: "ultra",
};

export default function DayJobMap({
  stops,
  /** Rows in this day that can never be pinned — an announcement, a reminder,
   *  a standalone task. Counted, not hidden: a map showing eight pins for a
   *  day whose header says twelve has to account for the other four. */
  unmappableCount = 0,
  /** The tab's card density, reused as the map's height. */
  density = "semi",
  /** Cycle THIS map's size, independent of the tab's. Omitted, the control
   *  is not drawn and the map simply follows the tab. */
  onCycleDensity,
}: {
  stops: DayStop[];
  unmappableCount?: number;
  density?: "ultra" | "semi" | "expanded";
  onCycleDensity?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { ensure, fitTo } = useLeafletMap(hostRef);

  /** One property can hold several of the day's visits. Ask for each address
   *  once; the pin then speaks for all the visits at it. */
  const propertyIds = useMemo(
    () => Array.from(new Set(stops.map((s) => s.propertyId))).sort(),
    [stops],
  );

  // ALL, not ACTIVE: a visit scheduled on an archived property still happens
  // today, and dropping its pin would make the map disagree with the feed it
  // replaced.
  const { data, failed, resolving, total, placed, pending, unplaceable } =
    usePropertyPoints({ propertyIds, status: "ALL" });

  const [expanded, setExpanded] = useState(false);
  useEscapeToCollapse(expanded, () => setExpanded(false));

  /** Bands switched OFF — the hidden set, so a band that appears later in the
   *  day (the first visit to go IN_PROGRESS) starts visible. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  /** The day's visits grouped by the property they are at, so one pin can
   *  name all of them. */
  const stopsByProperty = useMemo(() => {
    const m = new Map<string, DayStop[]>();
    for (const s of stops) {
      const list = m.get(s.propertyId);
      if (list) list.push(s);
      else m.set(s.propertyId, [s]);
    }
    return m;
  }, [stops]);

  /**
   * A property's band is the band of the most URGENT thing on it.
   *
   * Two visits at one address can be in different states, and the pin can only
   * be one colour. It takes the one that still needs attention — an unclaimed
   * visit at a property whose other visit is finished must not be drawn as
   * finished, because the whole point of looking is to find the work left.
   */
  const bandOfProperty = useMemo(() => {
    const rank: BandId[] = ["unclaimed", "active", "paused", "scheduled", "payment", "done"];
    const m = new Map<string, BandId>();
    for (const [propertyId, list] of stopsByProperty) {
      const bands = list.map(bandOfStop);
      m.set(propertyId, rank.find((r) => bands.includes(r)) ?? "scheduled");
    }
    return m;
  }, [stopsByProperty]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const [, b] of bandOfProperty) c.set(b, (c.get(b) ?? 0) + 1);
    return c;
  }, [bandOfProperty]);

  // Draw.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!data) return;
      const handles = await ensure();
      if (!handles || cancelled) return;
      const { L, layer } = handles;

      layer.clearLayers();

      // Hidden bands are not drawn AND not framed, so switching Done off
      // actually zooms into the work that is left rather than leaving the view
      // sitting over the part of the county already finished.
      const shown = data.points.filter(
        (p) => p.lat != null && p.lng != null && !hidden.has(bandOfProperty.get(p.id) ?? "scheduled"),
      );

      for (const p of shown) {
        const band = bandOfProperty.get(p.id) ?? "scheduled";
        const colour = paletteSolid(BAND.get(band)!.palette);
        const here = stopsByProperty.get(p.id) ?? [];
        const lines = here.map((s) => escapeMapHtml(stopLine(s)));
        const marker = L.circleMarker([p.lat!, p.lng!], {
          radius: 7,
          color: colour,
          fillColor: colour,
          fillOpacity: 0.85,
          weight: 2,
        })
          .bindPopup(
            `<strong>${escapeMapHtml(p.displayName)}</strong><br/>` +
              `${escapeMapHtml([p.street1, p.city].filter(Boolean).join(", "))}<br/>` +
              (p.client?.displayName ? `${escapeMapHtml(p.client.displayName)}<br/>` : "") +
              `<em>${lines.join("<br/>")}</em>`,
          )
          .addTo(layer);

        if (LABELS_AT[density]) {
          // ONE LINE PER PROPERTY, not per visit. Two visits at one address
          // already share a pin; stacking both their lines beside it would
          // make the biggest label sit on the busiest part of the map.
          // The second and later ones are counted instead.
          const first = here[0];
          const extra = here.length > 1 ? ` +${here.length - 1} more` : "";
          const sub = first ? `${stopLine(first)}${extra}` : "";
          marker.bindTooltip(
            `${escapeMapHtml(p.displayName)}` +
              (sub ? `<span class="seedlings-map-label__sub">${escapeMapHtml(sub)}</span>` : ""),
            {
              permanent: true,
              direction: "right",
              offset: [9, 0],
              className: "seedlings-map-label",
              // Leaflet puts tooltips in their own pane ABOVE the markers,
              // so a label would otherwise swallow the click meant for the
              // pin beneath it.
              interactive: false,
            },
          );
        }
      }

      fitTo(shown.map((p) => [p.lat!, p.lng!] as [number, number]));
    })();
    return () => { cancelled = true; };
    // `density` too: it decides whether the labels are drawn at all, and the
    // labels are bound to the markers this effect creates.
  }, [data, hidden, bandOfProperty, stopsByProperty, density, ensure, fitTo]);

  if (failed) return <Text fontSize="xs" color="red.fg">Couldn&rsquo;t load the map.</Text>;

  if (stops.length === 0) {
    return (
      <Text fontSize="xs" color="fg.muted" py={4} textAlign="center">
        Nothing on this day has an address to map.
      </Text>
    );
  }

  /** Bands with nothing in them are dropped — a key listing states no visit is
   *  in is noise, and on a quiet day that would be most of them. */
  const legend = DAY_BANDS.filter((b) => (counts.get(b.id) ?? 0) > 0);

  return (
    <Box {...expandedOverlayProps(expanded)}>
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

      {/* THE KEY, AND THE CONTROL — each state is a toggle. "Where is the work
          I have left" is the question the day map is usually opened for, and
          it is answered by switching Done off. The count rides on the chip so
          the legend doubles as the day's breakdown. */}
      {legend.length > 1 && (
        <HStack gap={1.5} wrap="wrap" mb={2}>
          {legend.map((b) => {
            const off = hidden.has(b.id);
            return (
              <HStack
                key={b.id}
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
                aria-label={`${off ? "Show" : "Hide"} ${b.label}`}
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
                <Text fontSize="2xs" textDecoration={off ? "line-through" : undefined}>{b.label}</Text>
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
        <MapHost
          hostRef={hostRef}
          expanded={expanded}
          collapsedHeight={MAP_HEIGHT[density]}
          testId="day-job-map"
        />
        {/* SIZE, FOR THIS DAY ONLY — the same bargain a card offers: the tab
            sets a default and any one of them can disagree with it. Beside
            the expand button because both are about how much room the map
            gets, and hidden while full-page, where the question has already
            been answered. */}
        <MapControls>
          {onCycleDensity && !expanded && (
          <Button
            size="xs"
            variant="solid"
            colorPalette="gray"
            minW="26px"
            px={0}
            onClick={onCycleDensity}
            aria-label={`${SIZE_META[density].name} map — switch to ${SIZE_META[NEXT_SIZE[density]].name.toLowerCase()}`}
            title={`${SIZE_META[density].name} map — click for ${SIZE_META[NEXT_SIZE[density]].name.toLowerCase()}`}
            data-testid="day-map-size"
            data-size={density}
          >
            {(() => { const Glyph = SIZE_META[density].icon; return <Glyph size={13} />; })()}
          </Button>
          )}
          <MapExpandButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </MapControls>
      </Box>

      {/* EVERY ROW IN THE DAY IS ACCOUNTED FOR. A pin can stand for several
          visits and some rows can never be pinned at all, so without this the
          map silently shows fewer things than the header counts. */}
      <HStack mt={2} gap={3} wrap="wrap">
        <Text fontSize="2xs" color="fg.muted">
          {placed} {placed === 1 ? "address" : "addresses"} · {stops.length}{" "}
          {stops.length === 1 ? "visit" : "visits"}
        </Text>
        {unplaceable > 0 && (
          <Text fontSize="2xs" color="orange.fg">
            {unplaceable} couldn&rsquo;t be placed from {unplaceable === 1 ? "its address" : "their addresses"}
          </Text>
        )}
        {unmappableCount > 0 && (
          <Text fontSize="2xs" color="fg.muted">
            {unmappableCount} {unmappableCount === 1 ? "row has" : "rows have"} no address
          </Text>
        )}
        {resolving && <Text fontSize="2xs" color="purple.fg">Locating…</Text>}
      </HStack>
    </Box>
  );
}
