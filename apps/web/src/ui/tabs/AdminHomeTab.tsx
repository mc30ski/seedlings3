"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, HStack, Input, Text } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import HomeTab from "@/src/ui/tabs/HomeTab";
import { type Me } from "@/src/lib/types";

type Worker = { id: string; displayName?: string | null; email?: string | null };

// Wraps HomeTab so admins can inspect what each worker (or the team) is seeing on
// their Home dashboard. Multi-select — empty = whole-team aggregate, one = per-worker
// impersonation (unchanged from the original behavior), more than one = subset team
// view (aggregate computed across just the selected workers).
export default function AdminHomeTab({ me }: { me?: Me | null }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("adminhome_workers", []);
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

  // Routing: 1 worker → existing impersonation view (no behavioral change).
  // 0 → whole-team aggregate. >1 → subset team view.
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
        // Exactly one worker → original per-worker view, unchanged behavior.
        <HomeTab
          key={`single-${selectedWorkers[0]}`}
          me={me}
          viewAsUserId={selectedWorkers[0]}
          viewAsDisplayName={workerNameMap[selectedWorkers[0]]}
          // Admin-as-worker view doesn't run worker workflows — no-op fallback.
          onLaunchWorkflow={() => {}}
        />
      ) : selectedWorkers.length > 1 ? (
        // Subset team view: aggregate computed across the selected workers only.
        <HomeTab
          key={`subset-${selectedWorkers.join(",")}`}
          me={me}
          subsetUserIds={selectedWorkers}
          onLaunchWorkflow={() => {}}
        />
      ) : (
        // No worker picked → whole-team aggregate.
        <HomeTab
          key="aggregate"
          me={me}
          aggregate
          onLaunchWorkflow={() => {}}
        />
      )}
    </Box>
  );
}
