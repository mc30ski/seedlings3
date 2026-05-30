"use client";

import { Badge, Box, Button, HStack, Input, Text, VStack } from "@chakra-ui/react";

/** Unified service type config: key + label + optional equipment mapping */
export type ServiceTypeConfig = { key: string; label: string; equipmentKind?: string };

/** Hardcoded fallback — used when no setting is configured */
export const DEFAULT_SERVICE_TYPES: ServiceTypeConfig[] = [
  { key: "MOW", label: "Mow", equipmentKind: "MOWER" },
  { key: "TRIM", label: "Trim", equipmentKind: "TRIMMER" },
  { key: "EDGE", label: "Edge", equipmentKind: "EDGER" },
  { key: "BLOW", label: "Blow", equipmentKind: "BLOWER" },
  { key: "HEDGE", label: "Hedge", equipmentKind: "HEDGER" },
  { key: "LEAF_CLEANUP", label: "Leaf Cleanup", equipmentKind: "BLOWER" },
  { key: "AERATION", label: "Aeration", equipmentKind: "AERATOR" },
  { key: "MULCH", label: "Mulch", equipmentKind: "MISC" },
  { key: "WEED", label: "Weed" },
  { key: "FERTILIZE", label: "Fertilize", equipmentKind: "SPREADER" },
  { key: "TREE_TRIM", label: "Tree Trim", equipmentKind: "CUTTER" },
  { key: "PLANT", label: "Plant" },
];

/** Legacy export — array of tag keys */
export const JOB_TAGS = DEFAULT_SERVICE_TYPES.map((t) => t.key);

/** Get label for a tag key, given an optional config */
export function jobTagLabel(tag: string, config?: ServiceTypeConfig[]): string {
  const list = config ?? DEFAULT_SERVICE_TYPES;
  const found = list.find((t) => t.key === tag);
  return found?.label ?? tag;
}

/** Read the job-tag bindings off a parsed pricing entry's value. Pricing
 *  entries used to carry a single `jobTag: string | null`; they now carry
 *  `jobTags: string[]`. This reader prefers the array shape and falls
 *  back to the legacy single-tag field so old DB rows keep working
 *  without a one-shot migration. */
export function pricingJobTags(parsed: any): string[] {
  if (Array.isArray(parsed?.jobTags)) {
    return parsed.jobTags.filter((t: any) => typeof t === "string" && t.length > 0);
  }
  if (typeof parsed?.jobTag === "string" && parsed.jobTag.length > 0) {
    return [parsed.jobTag];
  }
  return [];
}

/** Parse the SERVICE_TYPES setting value */
export function parseServiceTypesConfig(raw: string | null | undefined): ServiceTypeConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) {
      return parsed;
    }
  } catch {}
  return null;
}

// Legacy aliases
export type JobTagConfig = ServiceTypeConfig;
export function parseJobTagsConfig(raw: string | null | undefined): ServiceTypeConfig[] | null {
  return parseServiceTypesConfig(raw);
}

const PRESETS: { label: string; tags: string[] }[] = [
  { label: "Full Service", tags: ["MOW", "TRIM", "EDGE", "BLOW"] },
  { label: "Mow Only", tags: ["MOW"] },
];

type Props = {
  selected: string[];
  onChange: (tags: string[]) => void;
  customNote: string;
  onCustomNoteChange: (v: string) => void;
  /** Dynamic service type config from settings — uses hardcoded defaults if not provided */
  tagsConfig?: ServiceTypeConfig[] | null;
};

export default function JobTagPicker({ selected, onChange, customNote, onCustomNoteChange, tagsConfig }: Props) {
  const tags = tagsConfig ?? DEFAULT_SERVICE_TYPES;

  function toggle(tag: string) {
    if (selected.includes(tag)) {
      onChange(selected.filter((t) => t !== tag));
    } else {
      onChange([...selected, tag]);
    }
  }

  function applyPreset(presetTags: string[]) {
    onChange([...presetTags]);
  }

  return (
    <VStack align="stretch" gap={2}>
      {/* Presets */}
      <HStack gap={2}>
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="xs"
            variant="outline"
            colorPalette="blue"
            onClick={() => applyPreset(p.tags)}
          >
            {p.label}
          </Button>
        ))}
        {selected.length > 0 && (
          <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </HStack>

      {/* Tag chips */}
      <Box display="flex" gap="6px" flexWrap="wrap">
        {tags.map((t) => {
          const isSelected = selected.includes(t.key);
          return (
            <Badge
              key={t.key}
              size="sm"
              variant={isSelected ? "solid" : "outline"}
              colorPalette={isSelected ? "blue" : "gray"}
              cursor="pointer"
              px="2"
              py="0.5"
              borderRadius="full"
              onClick={() => toggle(t.key)}
              userSelect="none"
            >
              {t.label}
            </Badge>
          );
        })}
      </Box>

      {/* Custom job tag */}
      <Box>
        <Text fontSize="xs" color="fg.muted" mb={1}>Custom Job Tag (optional)</Text>
        <Input
          size="sm"
          placeholder="e.g., Dethatching, Stump Removal"
          value={customNote}
          onChange={(e) => onCustomNoteChange(e.target.value)}
        />
      </Box>
    </VStack>
  );
}
