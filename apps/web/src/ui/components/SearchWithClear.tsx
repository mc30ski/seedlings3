import React, { forwardRef } from "react";
import { HStack, Box, Input, IconButton } from "@chakra-ui/react";
import { X } from "lucide-react";

type SearchWithClearProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputId?: string;
};

const SearchWithClear = forwardRef<HTMLInputElement, SearchWithClearProps>(
  (
    { value, onChange, placeholder = "Search…", inputId = "equipment-search" },
    ref
  ) => {
    return (
      <HStack gap="2" w="full" flexWrap="nowrap">
        <Box position="relative" flex="1" minW={0}>
          <Input
            id={inputId}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            pr="9"
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
);

export default SearchWithClear;
