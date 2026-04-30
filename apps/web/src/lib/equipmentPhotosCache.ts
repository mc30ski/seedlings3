export type CachedEquipmentPhoto = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};

type Entry = { photos: CachedEquipmentPhoto[]; ts: number };

// Keyed by `${equipmentId}:${admin ? "a" : "w"}` since admin and worker endpoints may differ.
const cache = new Map<string, Entry>();
// R2 presigned URLs default to ~1h. Keep the cache under that to avoid serving expired URLs.
const TTL_MS = 30 * 60 * 1000;

function key(equipmentId: string, admin: boolean) {
  return `${equipmentId}:${admin ? "a" : "w"}`;
}

export function getCachedEquipmentPhotos(equipmentId: string, admin = false): CachedEquipmentPhoto[] | null {
  const entry = cache.get(key(equipmentId, admin));
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key(equipmentId, admin));
    return null;
  }
  return entry.photos;
}

export function setCachedEquipmentPhotos(equipmentId: string, photos: CachedEquipmentPhoto[], admin = false) {
  cache.set(key(equipmentId, admin), { photos, ts: Date.now() });
}

export function invalidateEquipmentPhotos(equipmentId: string) {
  cache.delete(key(equipmentId, true));
  cache.delete(key(equipmentId, false));
}
