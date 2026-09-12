"use client";

import { Box, HStack, Text } from "@chakra-ui/react";
import { Search } from "lucide-react";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";

// ─────────────────────────────────────────────────────────────────────────────
// The address search, given enough weight that people reach for it first.
//
// It used to be one more field in a stack of identical fields — same label
// size, same border, sitting directly above Street / City / State / Zip. There
// was nothing to say it was different in kind from the boxes under it, so it
// read as "Address", the operator typed the street into it, and then typed the
// street again into Street. The search is the fast path and it looked like the
// slow one.
//
// So it gets a panel of its own: tinted ground, its own border, a search icon
// and a larger input than the fields below it. Prominence is the whole job.
//
// It is NOT a requirement, and the caption says so in as many words. Plenty of
// real addresses are not in Mapbox — new builds, rural routes, anything the
// operator only has half of — and a search that looks mandatory would strand
// someone who simply cannot make it match.
// ─────────────────────────────────────────────────────────────────────────────

export default function AddressSearchField({
  value,
  onChange,
  onSelect,
  label = "Find an address",
  disabled,
}: {
  /** The SEARCH BOX's own text, not the stored address. Keep it in its own
   *  piece of state — mirroring it back from the fields makes selecting a
   *  suggestion fight with typing in Street. */
  value: string;
  onChange: (value: string) => void;
  /** Fires only on picking a suggestion, never on freeform typing — so a
   *  half-typed query cannot wipe fields the operator already filled in. */
  onSelect: (placeName: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Box
      borderWidth="1px"
      borderColor="blue.300"
      bg="blue.50"
      borderRadius="lg"
      px={3}
      py={2.5}
      mb={1}
    >
      <HStack gap={1.5} mb={1.5}>
        <Box color="blue.fg" display="inline-flex"><Search size={14} /></Box>
        <Text fontSize="sm" fontWeight="semibold" color="blue.fg">{label}</Text>
      </HStack>
      <AddressAutocomplete
        value={value}
        onChange={onChange}
        onSelect={onSelect}
        placeholder="Start typing an address…"
        size="md"
        disabled={disabled}
        showValidation
      />
      <Text fontSize="xs" color="fg.muted" mt={1.5}>
        Pick a suggestion and the fields below fill in themselves. Not finding
        it? You can type them in yourself.
      </Text>
    </Box>
  );
}
