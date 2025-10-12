import { HStack, Box, Input, IconButton } from "@chakra-ui/react";
import { X } from "lucide-react";

type SearchWithClearProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputId?: string;
};

export default function SearchWithClear({
  value,
  onChange,
  placeholder = "Search…",
  inputId = "equipment-search",
}: SearchWithClearProps) {
  return (
    <HStack gap="2" w="full" flexWrap="nowrap">
      <Box position="relative" flex="1" minW={0}>
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          pr="9" /* space for the clear button */
        />

        {value && (
          <IconButton
            aria-label="Clear search"
            size="xs"
            variant="ghost"
            type="button"
            onClick={() => onChange("")}
            position="absolute"
            right="1.5"
            top="50%"
            transform="translateY(-50%)"
          >
            <X size={14} />
          </IconButton>
        )}
      </Box>
    </HStack>
  );
}
