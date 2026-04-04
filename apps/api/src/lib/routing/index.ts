export type { RoutingProvider, Coordinates, GeocodedAddress, OptimizedRoute, RouteStop } from "./types";
import type { RoutingProvider } from "./types";
import { MapboxProvider } from "./mapbox";

const providers: Record<string, () => RoutingProvider> = {
  mapbox: () => new MapboxProvider(),
};

export function getRoutingProvider(name?: string): RoutingProvider {
  const key = name || "mapbox";
  const factory = providers[key];
  if (!factory) throw new Error(`Unknown routing provider: ${key}. Available: ${Object.keys(providers).join(", ")}`);
  return factory();
}

export const AVAILABLE_PROVIDERS = Object.keys(providers);
