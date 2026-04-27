/**
 * Maps job service tags to suggested equipment kinds.
 * The mapping is stored as a Setting (EQUIPMENT_SUGGESTIONS_MAP) and passed in at runtime.
 */

const KIND_LABELS: Record<string, string> = {
  MOWER: "Mower",
  TRIMMER: "Trimmer",
  EDGER: "Edger",
  BLOWER: "Blower",
  HEDGER: "Hedger",
  AERATOR: "Aerator",
  SPREADER: "Spreader",
  CUTTER: "Chainsaw",
  WASHER: "Pressure Washer",
  MISC: "Misc",
};

export function equipmentKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Given a tag-to-equipment map (from settings) and the occurrence's job tags,
 * returns deduplicated equipment suggestions with labels.
 */
export function suggestedEquipment(
  tagToEquipment: Record<string, string>,
  jobTags: string[],
): { tag: string; equipmentKind: string; label: string }[] {
  const seen = new Set<string>();
  const results: { tag: string; equipmentKind: string; label: string }[] = [];
  for (const tag of jobTags) {
    const kind = tagToEquipment[tag];
    if (kind && !seen.has(kind)) {
      seen.add(kind);
      results.push({ tag, equipmentKind: kind, label: equipmentKindLabel(kind) });
    }
  }
  return results;
}
