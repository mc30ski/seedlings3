import type { RoutingProvider, Coordinates, GeocodedAddress, OptimizedRoute, RouteStop } from "./types";

const BASE_URL = "https://api.mapbox.com";

export class MapboxProvider implements RoutingProvider {
  readonly name = "mapbox";
  private token: string;

  constructor(token?: string) {
    this.token = token || process.env.MAPBOX_ACCESS_TOKEN || "";
    if (!this.token) throw new Error("MAPBOX_ACCESS_TOKEN is not set");
  }

  async geocode(address: string): Promise<GeocodedAddress | null> {
    const encoded = encodeURIComponent(address);
    const url = `${BASE_URL}/geocoding/v5/mapbox.places/${encoded}.json?access_token=${this.token}&limit=1&country=us`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const feature = data.features?.[0];
    if (!feature) return null;

    const [lng, lat] = feature.center;
    return { address, coordinates: { lng, lat } };
  }

  async geocodeMany(addresses: string[]): Promise<(GeocodedAddress | null)[]> {
    // Mapbox doesn't have a batch geocoding endpoint on free tier,
    // so we geocode in parallel with a concurrency limit
    const results: (GeocodedAddress | null)[] = [];
    const batchSize = 5;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map((a) => this.geocode(a)));
      results.push(...batchResults);
    }
    return results;
  }

  async optimizeRoute(
    coordinates: Coordinates[],
    options?: { startCoords?: Coordinates; roundTrip?: boolean },
  ): Promise<OptimizedRoute> {
    if (coordinates.length === 0) {
      return { stops: [], totalDuration: 0, totalDistance: 0, provider: this.name };
    }

    // Build the coordinate list for the Optimization API
    // If startCoords is provided, prepend it as the first waypoint
    const allCoords: Coordinates[] = [];
    const hasStart = !!options?.startCoords;
    if (hasStart) allCoords.push(options!.startCoords!);
    allCoords.push(...coordinates);

    // Mapbox Optimization API accepts up to 12 waypoints
    if (allCoords.length > 12) {
      // Fall back to simple optimization for the first 12
      allCoords.length = 12;
    }

    const coordsStr = allCoords.map((c) => `${c.lng},${c.lat}`).join(";");
    const roundTrip = options?.roundTrip ?? true;
    const source = hasStart ? "first" : "any";
    const destination = roundTrip && hasStart ? "last" : "any";

    const url = `${BASE_URL}/optimized-trips/v1/mapbox/driving/${coordsStr}` +
      `?access_token=${this.token}` +
      `&geometries=geojson` +
      `&overview=full` +
      `&roundtrip=${roundTrip}` +
      `&source=${source}` +
      (roundTrip && hasStart ? `&destination=${destination}` : "") +
      `&steps=false`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mapbox Optimization API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (data.code !== "Ok" || !data.trips?.length) {
      throw new Error(`Mapbox optimization failed: ${data.code} — ${data.message || "no trips returned"}`);
    }

    const trip = data.trips[0];
    const waypoints = data.waypoints as { waypoint_index: number; trips_index: number }[];

    // Build the optimized stops in trip order
    // waypoints[i].waypoint_index gives the position in the trip for input index i
    const indexedWaypoints = waypoints.map((wp, inputIdx) => ({
      inputIdx,
      tripOrder: wp.waypoint_index,
    }));
    indexedWaypoints.sort((a, b) => a.tripOrder - b.tripOrder);

    const legs = trip.legs as { duration: number; distance: number }[];
    const stops: RouteStop[] = [];

    for (let i = 0; i < indexedWaypoints.length; i++) {
      const iw = indexedWaypoints[i];
      const coordIdx = iw.inputIdx;
      const coord = allCoords[coordIdx];

      // Adjust inputIndex: if we prepended startCoords, subtract 1
      const adjustedIndex = hasStart ? coordIdx - 1 : coordIdx;

      // Skip the start point from the output (it's the home base, not a job)
      if (hasStart && coordIdx === 0) continue;

      const leg = i > 0 ? legs[i - 1] : undefined;
      stops.push({
        inputIndex: adjustedIndex,
        coordinates: coord,
        durationFromPrev: leg?.duration ?? 0,
        distanceFromPrev: leg?.distance ?? 0,
      });
    }

    return {
      stops,
      totalDuration: trip.duration,
      totalDistance: trip.distance,
      provider: this.name,
    };
  }
}
