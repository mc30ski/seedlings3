"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED MAP MACHINERY — everything two maps of ours must agree about.
//
// There are two maps in the app: the portfolio's properties
// (PortfolioPropertyMap) and a day's visits (DayJobMap). They draw different
// things, but the way a Leaflet map is BUILT here is not a per-map decision —
// it is five bugs we already paid for:
//
//   1. Leaflet touches `window` at import time, so it must be imported inside
//      an effect or the server render breaks.
//   2. A tile is a 256px <img> inside zero-width absolute panes, so a global
//      `max-width: 100%` resolves it to ZERO. Tiles load, report loaded, and
//      occupy no pixels. That is what "the map shows nothing" was.
//   3. Leaflet caches the container size. Grow the box without telling it and
//      you get markers on a blank background, because no tiles were ever
//      requested for the new area. It must be OBSERVED, not timed — a
//      setTimeout guess can land before layout and never be corrected.
//   4. A full-page map keeps the zoom it was given at 420px unless the view is
//      re-fitted on resize, leaving every pin in a clump in the middle.
//   5. The map must be torn down with the component or Leaflet keeps the
//      container.
//
// Copying that list into a second file is how one of the five comes back. It
// lives here once, and a new map gets all five by using the hook.
//
// WHAT IS *NOT* HERE: what to draw. Each map owns its own pins, colours and
// legend, because those answer different questions.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Box, Button, HStack } from "@chakra-ui/react";
import { Maximize2, Minimize2 } from "lucide-react";

/**
 * TILES MUST NOT BE CONSTRAINED BY THE IMAGE RESET — see (2) above.
 *
 * Leaflet ships `.leaflet-container img { max-width: none }` for exactly this
 * reason and it was losing to our own reset, so the rule is asserted on the
 * host where it cannot be outranked. Scoped to the host, so no other image in
 * the app is affected.
 */
export const MAP_HOST_CSS = { "& img": { maxWidth: "none", maxHeight: "none" } };

/**
 * A theme token, resolved to a concrete value.
 *
 * Leaflet sets `fill` and `stroke` as SVG ATTRIBUTES, and `var(--…)` does not
 * resolve in an attribute — only in a CSS property. So the token is read off
 * the document and the colour handed over.
 *
 * NO HEX FALLBACK, deliberately. A literal here would be the same colour in
 * all fourteen themes, which is the thing being avoided; if a token is ever
 * missing, `undefined` lets Leaflet fall back to its own default rather than
 * freezing one theme's palette into the code.
 */
export function mapToken(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

/** A Chakra palette name to the concrete colour Leaflet needs. */
export function paletteSolid(palette: string): string | undefined {
  return mapToken(`--chakra-colors-${palette}-solid`);
}

/** Popups take an HTML string, so anything from the database is escaped. */
export function escapeMapHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export type LeafletHandles = { L: any; map: any; layer: any };

/**
 * A Leaflet map on the given host, built once and torn down with the caller.
 *
 * `ensure()` is async and lazy rather than an effect, because the host is not
 * always mounted on the caller's first render (a map behind a failed fetch, or
 * behind a toggle, has no box yet). The caller awaits it at the top of its own
 * draw effect — the same place the map used to be built inline — so there is
 * no window where a draw runs against a map that does not exist.
 *
 * `fitTo` remembers its points so a resize can re-fit to the same set, which
 * is what keeps (4) fixed.
 */
export function useLeafletMap(hostRef: RefObject<HTMLDivElement | null>) {
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  /** The points the current view was fitted to, so a resize can re-fit to
   *  them instead of leaving a full-page map zoomed for a 420px strip. */
  const frameRef = useRef<Array<[number, number]>>([]);

  const ensure = useCallback(async (): Promise<LeafletHandles | null> => {
    if (!hostRef.current) return null;
    const L = leafletRef.current ?? (await import("leaflet")).default;
    leafletRef.current = L;
    // Re-check after the await: the component can unmount while the chunk
    // loads, and building a map on a detached node leaks it.
    if (!hostRef.current) return null;
    if (!mapRef.current) {
      mapRef.current = L.map(hostRef.current, { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    return { L, map: mapRef.current, layer: layerRef.current };
  }, [hostRef]);

  /**
   * Frame the view on these points.
   *
   * An empty set sits on the state rather than [0,0] — the null island off
   * the coast of Africa, which is where the default would put you.
   */
  const fitTo = useCallback((points: Array<[number, number]>) => {
    frameRef.current = points;
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 15 });
    } else {
      map.setView([35.78, -78.9], 8);
    }
  }, []);

  // (3) + (4): the size change is OBSERVED, and the view re-fitted with it.
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
  }, [hostRef]);

  // (5)
  useEffect(() => () => {
    try { mapRef.current?.remove(); } catch { /* already gone */ }
    mapRef.current = null;
  }, []);

  return { ensure, fitTo };
}

/**
 * Escape leaves full-page.
 *
 * A map covering the window with its own close button somewhere in the corner
 * is a trap on a laptop.
 */
export function useEscapeToCollapse(expanded: boolean, collapse: () => void) {
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") collapse(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, collapse]);
}

/**
 * FULL PAGE IS A FIXED OVERLAY, not a taller box.
 *
 * Growing in place would leave the map below the tab chrome and whatever else
 * is on the page, scrolled halfway down — which is the position the expand is
 * trying to escape.
 */
export function expandedOverlayProps(expanded: boolean) {
  return expanded
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
    : {};
}

/**
 * The strip the map's own controls sit in, over its top-right corner.
 *
 * ONE ROW, NOT EACH BUTTON PLACED BY HAND. The size control was positioned
 * at `right: 46px` to clear an expand button 38px wide sitting 8px in — two
 * numbers that had to be added up correctly by whoever read them, and were
 * not: 46 is exactly where the expand button starts, so the two buttons came
 * out flush and, both being solid grey, read as one wide blob. A flex row
 * with a gap cannot make that mistake, and a third control added later
 * spaces itself.
 *
 * Top-right, away from Leaflet's own zoom control at the top-left.
 */
export function MapControls({ children }: { children: React.ReactNode }) {
  return (
    <HStack position="absolute" top={2} right={2} zIndex={500} gap={1.5}>
      {children}
    </HStack>
  );
}

/** The expand / shrink control. Placed by `MapControls`, not by itself. */
export function MapExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Button
      size="xs"
      variant="solid"
      colorPalette="gray"
      onClick={onToggle}
      aria-label={expanded ? "Shrink the map" : "Expand the map to the whole page"}
      title={expanded ? "Shrink (Esc)" : "Expand"}
    >
      {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
    </Button>
  );
}

/**
 * The map's own box.
 *
 * AN EXPLICIT HEIGHT, MEASURED FROM THE VIEWPORT. This was a flex child at
 * `flex: 1` with the map absolutely positioned inside, and it came out TWO
 * PIXELS TALL — measured, not guessed. Percentage and flex heights resolve
 * against a parent chain that has to have committed to a height first, and one
 * link in that chain had not, so the whole thing collapsed to its content.
 * `100vh` minus the chrome is arithmetic the browser can always do.
 */
export function MapHost({
  hostRef,
  expanded,
  collapsedHeight = "420px",
  expandedChrome = 118,
  testId,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  expanded: boolean;
  /** A plain value, or a Chakra responsive object — a map wants a different
   *  height on a phone than on a desktop. */
  collapsedHeight?: string | Record<string, string>;
  /** Pixels of our own chrome above and below the map when full-page. */
  expandedChrome?: number;
  testId: string;
}) {
  return (
    <Box
      ref={hostRef}
      h={expanded ? `calc(100vh - ${expandedChrome}px)` : collapsedHeight}
      w="full"
      css={MAP_HOST_CSS}
      rounded="md"
      borderWidth="1px"
      borderColor="border"
      overflow="hidden"
      data-testid={testId}
    />
  );
}
