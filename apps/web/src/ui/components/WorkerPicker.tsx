"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, HStack, Input, Text } from "@chakra-ui/react";

export type WorkerPickerRow = {
  id: string;
  displayName: string | null;
  email: string | null;
  workerType?: string | null;
};

type Props = {
  workers: WorkerPickerRow[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
};

/**
 * Multi-select worker picker matching the "View as" picker on Admin → Work
 * → Home. Search-input opens a floating dropdown; each row toggles in and
 * out of the selection via a blue ✓. Selected names show as a comma-
 * separated list in the input's placeholder when the search field is empty.
 *
 * Selection does NOT close the dropdown so the operator can pick multiple
 * workers in one motion. Click outside, press Escape, or blur away to
 * close.
 */
export default function WorkerPicker({
  workers,
  selectedIds,
  onChange,
  placeholder = "Search workers…",
  autoFocus = false,
}: Props) {
  const [searchText, setSearchText] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of workers) {
      m[w.id] = w.displayName ?? w.email ?? w.id;
    }
    return m;
  }, [workers]);

  const filtered = useMemo(() => {
    if (!searchText.trim()) return workers;
    const q = searchText.toLowerCase();
    return workers.filter(
      (w) =>
        (w.displayName ?? "").toLowerCase().includes(q) ||
        (w.email ?? "").toLowerCase().includes(q),
    );
  }, [workers, searchText]);

  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > limited.length;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  }
  function cancelClose() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  const displayPlaceholder =
    selectedIds.length > 0
      ? selectedIds.map((id) => nameById[id] ?? "…").join(", ")
      : placeholder;

  return (
    <Box ref={wrapRef} position="relative" w="full">
      <Input
        ref={inputRef}
        size="sm"
        w="full"
        placeholder={displayPlaceholder}
        value={searchText}
        onChange={(e) => {
          setSearchText(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setSearchText("");
        }}
        onBlur={scheduleClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      {open && (
        <Box
          position="fixed"
          zIndex={9999}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          rounded="md"
          shadow="lg"
          w="280px"
          mt="1"
          ref={(el: HTMLDivElement | null) => {
            if (el && wrapRef.current) {
              const rect = wrapRef.current.getBoundingClientRect();
              el.style.top = `${rect.bottom + 4}px`;
              const left = Math.max(8, Math.min(rect.left, window.innerWidth - 288));
              el.style.left = `${left}px`;
              el.style.width = `${Math.max(280, rect.width)}px`;
            }
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <Box maxH="260px" overflowY="auto">
            {limited.length === 0 ? (
              <Text fontSize="sm" color="fg.muted" px="3" py="2">
                No workers found.
              </Text>
            ) : (
              limited.map((w) => {
                const selected = selectedIds.includes(w.id);
                return (
                  <Box
                    key={w.id}
                    px="3"
                    py="1.5"
                    fontSize="sm"
                    cursor="pointer"
                    bg={selected ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggle(w.id);
                    }}
                  >
                    <HStack gap={2}>
                      <Text flex="1">
                        {w.displayName ?? w.email ?? w.id}
                        {w.workerType && (
                          <Text as="span" color="fg.muted" fontSize="xs" ml={2}>
                            {w.workerType}
                          </Text>
                        )}
                      </Text>
                      {selected && (
                        <Text color="blue.500" fontWeight="bold">
                          ✓
                        </Text>
                      )}
                    </HStack>
                  </Box>
                );
              })
            )}
            {hasMore && (
              <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                …{filtered.length - limited.length} more — type to search
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
