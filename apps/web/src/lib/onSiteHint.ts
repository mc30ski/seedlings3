"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";

// Radius in miles inside which the "record location" default flips ON.
// Chosen wide enough to cover a client's driveway/street even with a rough
// GPS fix and narrow enough that a worker who's on their way (still 5-10 min
// out) gets the "start without location" default instead of a bogus stamp.
const NEAR_RADIUS_MILES = 1;

export type OnSiteHintMode =
  | "loading"
  | "near"
  | "far"
  | "unknown-site"
  | "unknown-user";

export type OnSiteHint = {
  mode: OnSiteHintMode;
  distanceMiles: number | null;
  /** User's live position when resolved. Null when geolocation failed / was denied. */
  userLat: number | null;
  userLng: number | null;
  /** Property's known GPS from prior occurrences. Null when the property has no history. */
  siteLat: number | null;
  siteLng: number | null;
  /** Short blue-info-banner message describing the current state. */
  message: string;
  /** True when the "record with location" button should be visually preferred. */
  defaultToWithLocation: boolean;
  /** True when the "record with location" button should be disabled. */
  withLocationDisabled: boolean;
};

/** Great-circle distance in miles between two lat/lng pairs. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613; // Earth radius, statute miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Resolves both the user's GPS and the occurrence's site coordinates the
 * moment the dialog opens (`open=true`), then decides:
 *   - user close to site → default "record with location"
 *   - user far / site unknown → default "record without location"
 *   - user location unavailable → "record with location" disabled entirely
 * Never blocks the dialog — while `mode === "loading"` the button labels
 * stay neutral, then swap once state resolves.
 */
export function useOnSiteHint(open: boolean, occurrenceId: string | null | undefined): OnSiteHint {
  const [state, setState] = useState<OnSiteHint>({
    mode: "loading",
    distanceMiles: null,
    userLat: null,
    userLng: null,
    siteLat: null,
    siteLng: null,
    message: "Checking your location…",
    defaultToWithLocation: true,
    withLocationDisabled: false,
  });
  // Guard against setState after unmount / after the dialog closes mid-flight.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open || !occurrenceId) {
      setState({
        mode: "loading",
        distanceMiles: null,
        userLat: null,
        userLng: null,
        siteLat: null,
        siteLng: null,
        message: "Checking your location…",
        defaultToWithLocation: true,
        withLocationDisabled: false,
      });
      return;
    }
    let cancelled = false;
    (async () => {
      const [userLoc, siteRes] = await Promise.all([
        getLocation().catch(() => null),
        apiGet<{ lat: number | null; lng: number | null }>(
          `/api/occurrences/${occurrenceId}/site-hint`
        ).catch(() => ({ lat: null, lng: null })),
      ]);
      if (cancelled || !openRef.current) return;

      const userLat = userLoc?.lat ?? null;
      const userLng = userLoc?.lng ?? null;
      const siteLat = siteRes?.lat ?? null;
      const siteLng = siteRes?.lng ?? null;

      if (userLat == null || userLng == null) {
        setState({
          mode: "unknown-user",
          distanceMiles: null,
          userLat: null,
          userLng: null,
          siteLat,
          siteLng,
          message:
            "We couldn't get your current location — either location access is disabled, or the signal here is too weak. Location won't be recorded.",
          defaultToWithLocation: false,
          withLocationDisabled: true,
        });
        return;
      }

      if (siteLat == null || siteLng == null) {
        // No history for this property — we can't compute proximity but
        // the user does have GPS, so still offer the option and lean
        // toward capturing it (this is likely the first visit).
        setState({
          mode: "unknown-site",
          distanceMiles: null,
          userLat,
          userLng,
          siteLat: null,
          siteLng: null,
          message:
            "No prior GPS on file for this property yet — we can't confirm you're on-site, but recording location will help pin future visits.",
          defaultToWithLocation: true,
          withLocationDisabled: false,
        });
        return;
      }

      const distance = haversineMiles(userLat, userLng, siteLat, siteLng);
      if (distance <= NEAR_RADIUS_MILES) {
        setState({
          mode: "near",
          distanceMiles: distance,
          userLat,
          userLng,
          siteLat,
          siteLng,
          message: `You appear to be at the job location (about ${distance.toFixed(distance < 0.1 ? 2 : 1)} mi away). Recording your location is recommended.`,
          defaultToWithLocation: true,
          withLocationDisabled: false,
        });
      } else {
        setState({
          mode: "far",
          distanceMiles: distance,
          userLat,
          userLng,
          siteLat,
          siteLng,
          message: `You appear to be about ${distance < 10 ? distance.toFixed(1) : Math.round(distance)} mi from the job location. Skipping location is recommended so an off-site GPS point isn't stamped on the job.`,
          defaultToWithLocation: false,
          withLocationDisabled: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, occurrenceId]);

  return state;
}
