// ─────────────────────────────────────────────────────────────────────────────
// Where the business is, in coordinates.
//
// EXTRACTED so more than one surface can ask. It was a closure inside the
// worker routes plugin, which was fine while /weather was the only caller —
// the wall display needs the same answer, and a second copy of the geocoding
// heuristics would be a second thing to fix when an address parses oddly.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";

let cachedBizLoc: { key: string; lat: number; lng: number } | null = null;

export async function businessLatLng(): Promise<{ lat: number; lng: number } | null> {
  const [addrSetting, keySetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "BUSINESS_ADDRESS" } }),
    prisma.setting.findUnique({ where: { key: "WEATHER_API_KEY" } }),
  ]);
  const address = (addrSetting?.value ?? "").trim();
  const apiKey = keySetting?.value || process.env.OPENWEATHER_API_KEY;
  if (!address || !apiKey) return null;
  // Keyed on the address itself, so editing the setting invalidates this
  // without needing a cache-busting step anywhere.
  if (cachedBizLoc?.key === address) return { lat: cachedBizLoc.lat, lng: cachedBizLoc.lng };

  const urls: string[] = [];
  const zip = address.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
  if (zip) urls.push(`https://api.openweathermap.org/geo/1.0/zip?zip=${zip},US&appid=${apiKey}`);
  // "225 Stony Branch Trl., Chapel Hill, NC. 27516" -> "Chapel Hill,NC,US"
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const stateIdx = parts.findIndex((p) => /^[A-Za-z]{2}\b\.?/.test(p) && p.length <= 12);
  if (stateIdx > 0) {
    const city = parts[stateIdx - 1];
    const st = parts[stateIdx].slice(0, 2).toUpperCase();
    if (city) urls.push(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)},${st},US&limit=1&appid=${apiKey}`);
  }

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = await res.json();
      // /zip returns an object, /direct returns an array.
      const hit = Array.isArray(body) ? body[0] : body;
      const lat = Number(hit?.lat);
      const lng = Number(hit?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        cachedBizLoc = { key: address, lat, lng };
        return { lat, lng };
      }
    } catch {
      // try the next strategy
    }
  }
  return null;
}
