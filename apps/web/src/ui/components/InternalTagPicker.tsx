"use client";

import { Badge, Box, HStack, Text } from "@chakra-ui/react";

export const INTERNAL_TAGS = [
  { id: "LATE_PAYER", label: "Late Payer", color: "red" },
  { id: "ARGUMENTATIVE", label: "Argumentative", color: "red" },
  { id: "DIFFICULT_ACCESS", label: "Difficult Access", color: "orange" },
  { id: "CASH_ONLY", label: "Cash Only", color: "yellow" },
  { id: "HIGH_MAINTENANCE", label: "High Maintenance", color: "orange" },
] as const;

export type AdminTag = (typeof INTERNAL_TAGS)[number]["id"];

const TAG_MAP = Object.fromEntries(INTERNAL_TAGS.map((t) => [t.id, t]));

export function internalTagLabel(tag: string): string {
  return TAG_MAP[tag]?.label ?? tag;
}

export function internalTagColor(tag: string): string {
  return TAG_MAP[tag]?.color ?? "gray";
}

export function parseInternalTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

type Props = {
  selected: string[];
  onChange: (tags: string[]) => void;
};

export default function InternalTagPicker({ selected, onChange }: Props) {
  function toggle(tag: string) {
    if (selected.includes(tag)) {
      onChange(selected.filter((t) => t !== tag));
    } else {
      onChange([...selected, tag]);
    }
  }

  return (
    <Box>
      <Text fontSize="xs" color="fg.muted" mb={1}>Internal tags (never shown to clients)</Text>
      <HStack gap="6px" flexWrap="wrap">
        {INTERNAL_TAGS.map((tag) => {
          const isSelected = selected.includes(tag.id);
          return (
            <Badge
              key={tag.id}
              size="sm"
              variant={isSelected ? "solid" : "outline"}
              colorPalette={isSelected ? tag.color : "gray"}
              cursor="pointer"
              px="2"
              py="0.5"
              borderRadius="full"
              onClick={() => toggle(tag.id)}
              userSelect="none"
            >
              {tag.label}
            </Badge>
          );
        })}
      </HStack>
    </Box>
  );
}
