/**
 * Equipment suggestion logic.
 * Reads from the unified SERVICE_TYPES config and EQUIPMENT_KINDS config.
 */

import type { ServiceTypeConfig } from "@/src/ui/components/JobTagPicker";
import { prettyStatus } from "@/src/lib/lib";

/** A single equipment kind definition */
export type EquipmentKindConfig = { key: string; label: string };

/** Parse the EQUIPMENT_KINDS setting value */
export function parseEquipmentKindsConfig(raw: string | null | undefined): EquipmentKindConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) return parsed;
  } catch {}
  return null;
}

/** Get label for an equipment kind, using config if available, fallback to prettyStatus */
export function equipmentKindLabel(kind: string, kindsConfig?: EquipmentKindConfig[]): string {
  if (kindsConfig) {
    const found = kindsConfig.find((k) => k.key === kind);
    if (found) return found.label;
  }
  return prettyStatus(kind);
}

/**
 * Given the SERVICE_TYPES config, EQUIPMENT_KINDS config, and an occurrence's job tags,
 * returns deduplicated equipment suggestions with labels.
 */
export function suggestedEquipment(
  serviceTypes: ServiceTypeConfig[],
  jobTags: string[],
  kindsConfig?: EquipmentKindConfig[],
): { tag: string; equipmentKind: string; label: string }[] {
  const seen = new Set<string>();
  const results: { tag: string; equipmentKind: string; label: string }[] = [];
  for (const tag of jobTags) {
    const config = serviceTypes.find((st) => st.key === tag);
    const kind = config?.equipmentKind;
    if (kind && !seen.has(kind)) {
      seen.add(kind);
      results.push({ tag, equipmentKind: kind, label: equipmentKindLabel(kind, kindsConfig) });
    }
  }
  return results;
}
