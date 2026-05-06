"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, HStack, Input, Text } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import RemindersTab from "@/src/ui/tabs/RemindersTab";
import { type Me } from "@/src/lib/types";

type Worker = { id: string; displayName?: string | null; email?: string | null };

export default function AdminRemindersTab({ me }: { me?: Me | null }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  // Multi-select. Empty = team view (all workers). One = per-worker view (unchanged
  // from the original behavior). More than one = team-styled view filtered to those
  // workers only.
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("adminreminders_workers", []);
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearchText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [workers]);

  const workerItems = useMemo(
    () => workers.map((w) => ({
      label: w.displayName || w.email || w.id,
      value: w.id,
    })),
    [workers]
  );

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workerItems.filter((it) => it.label.toLowerCase().includes(searchLc))
    : workerItems;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

  // Routing decision: exactly one worker → existing per-worker view, identical to
  // the prior behavior. Zero or many → new team-styled view.
  const isPerWorker = selectedWorkers.length === 1;

  return (
    <Box w="full">
      <HStack mb={2} gap={2} align="center" wrap="nowrap">
        <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap" flexShrink={0}>
          View as:
        </Text>
        <Box ref={dropRef} position="relative" flex="1">
          <Input
            size="sm"
            w="full"
            placeholder={selectedWorkers.length > 0
              ? selectedWorkers.map((id) => workerNameMap[id] || "Loading…").join(", ")
              : "All Workers"
            }
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (!dropOpen) setDropOpen(true);
            }}
            onFocus={() => {
              setDropOpen(true);
              setSearchText("");
            }}
          />
          {dropOpen && (
            <Box
              position="fixed"
              zIndex={9999}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              rounded="md"
              shadow="lg"
              w="240px"
              mt="1"
              ref={(el: HTMLDivElement | null) => {
                if (el && dropRef.current) {
                  const rect = dropRef.current.getBoundingClientRect();
                  el.style.top = `${rect.bottom + 4}px`;
                  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
                  el.style.left = `${left}px`;
                }
              }}
            >
              <Box maxH="250px" overflowY="auto">
                {limited.map((it) => (
                  <Box
                    key={it.value}
                    px="3"
                    py="1.5"
                    fontSize="sm"
                    cursor="pointer"
                    bg={selectedWorkers.includes(it.value) ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedWorkers((prev) =>
                        prev.includes(it.value)
                          ? prev.filter((id) => id !== it.value)
                          : [...prev, it.value]
                      );
                    }}
                  >
                    <HStack gap={2}>
                      <Text flex="1">{it.label}</Text>
                      {selectedWorkers.includes(it.value) && <Text color="blue.500" fontWeight="bold">✓</Text>}
                    </HStack>
                  </Box>
                ))}
                {hasMore && !searchText && (
                  <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                    …{filtered.length - 10} more — type to search
                  </Text>
                )}
                {filtered.length === 0 && (
                  <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
                )}
              </Box>
            </Box>
          )}
        </Box>
      </HStack>
      {selectedWorkers.length > 0 && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          {selectedWorkers.map((id) => (
            <Badge key={id} size="sm" colorPalette="blue" variant="solid">
              {workerNameMap[id] || "Loading…"}
            </Badge>
          ))}
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => { setSelectedWorkers([]); setSearchText(""); }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}

      {isPerWorker ? (
        // Exactly one worker selected — render the original per-worker view unchanged.
        <RemindersTab
          key={`single-${selectedWorkers[0]}`}
          myId={selectedWorkers[0]}
          me={me}
          showAll={false}
          forAdmin
        />
      ) : (
        // Team view: 0 selected → all workers, multiple selected → just those.
        <RemindersTab
          key={`team-${selectedWorkers.join(",")}`}
          me={me}
          showAll
          forAdmin
          teamView
          visibleUserIds={selectedWorkers}
        />
      )}
    </Box>
  );
}
