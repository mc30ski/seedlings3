/**
 * Routing provider abstraction.
 * Add new providers by implementing RoutingProvider and registering in index.ts
 */

export type Coordinates = {
  lng: number;
  lat: number;
};

export type GeocodedAddress = {
  address: string;
  coordinates: Coordinates;
};

export type RouteStop = {
  /** Original index in the input array */
  inputIndex: number;
  /** Coordinates of this stop */
  coordinates: Coordinates;
  /** Driving duration in seconds from previous stop */
  durationFromPrev: number;
  /** Driving distance in meters from previous stop */
  distanceFromPrev: number;
};

export type OptimizedRoute = {
  /** Stops in optimized order */
  stops: RouteStop[];
  /** Total driving duration in seconds */
  totalDuration: number;
  /** Total driving distance in meters */
  totalDistance: number;
  /** Provider that produced this result */
  provider: string;
};

export interface RoutingProvider {
  readonly name: string;

  /** Convert a street address to coordinates */
  geocode(address: string): Promise<GeocodedAddress | null>;

  /** Geocode multiple addresses */
  geocodeMany(addresses: string[]): Promise<(GeocodedAddress | null)[]>;

  /**
   * Given a list of coordinates, return the optimal visiting order.
   * If startCoords is provided, the route starts (and optionally ends) there.
   */
  optimizeRoute(
    coordinates: Coordinates[],
    options?: {
      startCoords?: Coordinates;
      roundTrip?: boolean;
    },
  ): Promise<OptimizedRoute>;
}
