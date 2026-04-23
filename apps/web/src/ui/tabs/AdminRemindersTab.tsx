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
  const [selectedWorker, setSelectedWorker] = usePersistedState<string | null>("adminreminders_worker", null);
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

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workers.filter((w) => (w.displayName || w.email || "").toLowerCase().includes(searchLc))
    : workers;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

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
            placeholder={selectedWorker ? workerNameMap[selectedWorker] || "Loading…" : "Select a worker..."}
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
                {limited.map((w) => (
                  <Box
                    key={w.id}
                    px="3"
                    py="1.5"
                    fontSize="sm"
                    cursor="pointer"
                    bg={selectedWorker === w.id ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedWorker(w.id);
                      setDropOpen(false);
                      setSearchText("");
                    }}
                  >
                    <HStack gap={2}>
                      <Text flex="1">{w.displayName || w.email || w.id}</Text>
                      {selectedWorker === w.id && <Text color="blue.500" fontWeight="bold">✓</Text>}
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
      {selectedWorker && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          <Badge size="sm" colorPalette="blue" variant="solid">
            {workerNameMap[selectedWorker] || "Loading…"}
          </Badge>
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => { setSelectedWorker(null); setSearchText(""); }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}

      {selectedWorker ? (
        <RemindersTab myId={selectedWorker} me={me} showAll={false} forAdmin />
      ) : (
        <Box py={10} textAlign="center">
          <Text color="fg.muted" fontSize="sm">Select a worker above to view their planning items.</Text>
        </Box>
      )}
    </Box>
  );
}
