"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY POINTS — the fast read, then the slow fill.
//
// WHY THE POINTS ARRIVE IN DRIBS. Geocoding is the slow part: the free US
// Census geocoder takes about three and a half SECONDS per address (measured,
// not assumed), and production has dozens of properties with no point yet. One
// request that geocoded them all would take roughly a minute and exceed the
// serverless budget, returning nothing. So a map opens on whatever is already
// known and asks for small batches until `pending` reaches zero, dropping pins
// in as they land.
//
// EVERY POINT IS PERSISTED AS IT IS FOUND, which is why this needs no cron and
// no backfill script: the cost is paid once per property, ever, and closing the
// page halfway loses nothing. It is also why the progress counter matters —
// without it a slowly-filling map looks broken rather than busy.
//
// SHARED BY BOTH MAPS. The portfolio map asks by portfolio, the day map asks by
// the property ids already on its screen; everything after that question is the
// same, including the three bugs recorded inside the fill loop below.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "@/src/lib/api";

export type PropertyPoint = {
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

export type PointsResponse = {
  /** The portfolio's own configured point — what its weather is anchored on.
   *  Null for any query that is not about one portfolio. */
  portfolioCentre: { id: string; name: string; lat: number; lng: number } | null;
  points: PropertyPoint[];
  total: number;
  placed: number;
  pending: number;
  unplaceable: number;
};

export type PointsQuery = {
  /** Ask by portfolio (the Portfolios panel), or… */
  portfolioId?: string;
  /** …ask by the exact properties already on screen (the day map).
   *  An EMPTY array means none, and the server honours that — a day with no
   *  properties draws an empty map rather than the whole book. */
  propertyIds?: string[];
  /** "ALL" (the default) includes archived. */
  status?: "ACTIVE" | "ALL";
};

/** The query as one string, used both to build the request and to decide
 *  whether this is a NEW question (refetch, restart the fill) or the same one. */
function keyOf(q: PointsQuery): string {
  // Ids are sorted so that the same set in a different order is the same
  // question — otherwise a re-render that reshuffles a day's rows would
  // refetch and restart the geocode loop.
  const ids = q.propertyIds ? [...q.propertyIds].sort().join(",") : "";
  return `${q.portfolioId ?? ""}|${q.status ?? "ALL"}|${ids}`;
}

/**
 * Read the points for a query, then fill in whatever has never been geocoded.
 *
 * Returns the response as it stands, which is the whole point: the caller
 * draws immediately and redraws as batches land.
 */
export function usePropertyPoints(query: PointsQuery) {
  const key = keyOf(query);
  // Rebuilt only when the KEY changes, so the effects below can depend on the
  // query object without re-running on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const q = useMemo(() => query, [key]);

  const [data, setData] = useState<PointsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Stops the batch loop when the component goes away mid-flight — each batch
  // is seconds long, so this is a real window, not a formality.
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
        const params = new URLSearchParams();
        if (q.portfolioId) params.set("portfolioId", q.portfolioId);
        if (q.propertyIds) params.set("propertyIds", q.propertyIds.join(","));
        params.set("status", q.status ?? "ALL");
        const res = await apiGet<PointsResponse>(`/api/properties/points?${params.toString()}`);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [q]);

  // One fill loop per question, ever. A ref rather than an effect dependency:
  // the loop writes `data` on every batch, so any dep derived from `data`
  // either re-triggers it or — as happened first — never changes at all. The
  // original condition was `data?.pending === 0`, which is `false` both while
  // `data` is null AND once points are pending, so the dependency never
  // flipped and the loop never started: the map filled to whatever was already
  // geocoded and quietly stopped.
  const loopFor = useRef<string | null>(null);

  // 2. The slow fill, in small batches, until nothing is pending.
  useEffect(() => {
    if (!data || data.pending === 0) return;
    if (loopFor.current === key) return;
    loopFor.current = key;
    (async () => {
      setResolving(true);
      try {
        while (liveRef.current) {
          const res = await apiPost<{ resolved: Array<{ id: string; lat: number; lng: number }>; remaining: number }>(
            "/api/properties/points/resolve",
            {
              portfolioId: q.portfolioId,
              propertyIds: q.propertyIds,
              status: q.status ?? "ALL",
              limit: 5,
            },
          );
          // NOT GATED ON AN EFFECT-SCOPED `cancelled` FLAG. It was, and the
          // batch's results were being thrown away: `setResolving(true)`
          // changed this effect's dependencies, React ran the cleanup, the
          // flag flipped, and the already-fetched points hit `break` before
          // the fold below. They were persisted on the server and lost in the
          // browser, so the map sat at its opening count while the network log
          // showed batches succeeding.
          //
          // `liveRef` is the right test: it asks "is the component still
          // mounted", which is the only reason to discard an answer we have
          // already paid three seconds an address for.
          if (!liveRef.current) break;
          // Fold the new points into what is already drawn rather than
          // refetching the list — a refetch would redraw every pin and fight
          // the user's pan/zoom.
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
        // A failed batch stops the fill; the points already found stay on the
        // map and reopening tries again.
      } finally {
        if (liveRef.current) setResolving(false);
      }
    })();
    // `!!data` only: the loop needs to start once, when the first read lands.
    // Depending on `data` itself would re-run this on every batch it folds in,
    // and depending on `resolving` would re-run it the moment it sets its own
    // flag. The ref above is what keeps it to one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, q, !!data]);

  return {
    data,
    failed,
    resolving,
    total: data?.total ?? 0,
    placed: data?.placed ?? 0,
    pending: data?.pending ?? 0,
    unplaceable: data?.unplaceable ?? 0,
  };
}
