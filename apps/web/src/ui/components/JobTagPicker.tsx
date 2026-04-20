"use client";

import { Badge, Box, Button, HStack, Input, Text, VStack } from "@chakra-ui/react";

export const JOB_TAGS = [
  "MOW",
  "TRIM",
  "EDGE",
  "BLOW",
  "HEDGE",
  "LEAF_CLEANUP",
  "AERATION",
  "MULCH",
  "WEED",
  "FERTILIZE",
  "TREE_TRIM",
  "PLANT",
] as const;

export type JobTag = (typeof JOB_TAGS)[number];

const TAG_LABELS: Record<string, string> = {
  MOW: "Mow",
  TRIM: "Trim",
  EDGE: "Edge",
  BLOW: "Blow",
  HEDGE: "Hedge",
  LEAF_CLEANUP: "Leaf Cleanup",
  AERATION: "Aeration",
  MULCH: "Mulch",
  WEED: "Weed",
  FERTILIZE: "Fertilize",
  TREE_TRIM: "Tree Trim",
  PLANT: "Plant",
};

export function jobTagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

const PRESETS: { label: string; tags: JobTag[] }[] = [
  { label: "Full Service", tags: ["MOW", "TRIM", "EDGE", "BLOW"] },
  { label: "Mow Only", tags: ["MOW"] },
];

type Props = {
  selected: string[];
  onChange: (tags: string[]) => void;
  customNote: string;
  onCustomNoteChange: (v: string) => void;
};

export default function JobTagPicker({ selected, onChange, customNote, onCustomNoteChange }: Props) {
  function toggle(tag: string) {
    if (selected.includes(tag)) {
      onChange(selected.filter((t) => t !== tag));
    } else {
      onChange([...selected, tag]);
    }
  }

  function applyPreset(tags: JobTag[]) {
    onChange([...tags]);
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
        {JOB_TAGS.map((tag) => {
          const isSelected = selected.includes(tag);
          return (
            <Badge
              key={tag}
              size="sm"
              variant={isSelected ? "solid" : "outline"}
              colorPalette={isSelected ? "blue" : "gray"}
              cursor="pointer"
              px="2"
              py="0.5"
              borderRadius="full"
              onClick={() => toggle(tag)}
              userSelect="none"
            >
              {TAG_LABELS[tag]}
            </Badge>
          );
        })}
      </Box>

      {/* Custom note */}
      <Box>
        <Text fontSize="xs" color="fg.muted" mb={1}>Custom note (optional)</Text>
        <Input
          size="sm"
          placeholder="e.g., Backyard only, skip front beds"
          value={customNote}
          onChange={(e) => onCustomNoteChange(e.target.value)}
        />
      </Box>
    </VStack>
  );
}
