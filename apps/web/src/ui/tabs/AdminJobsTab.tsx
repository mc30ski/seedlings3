"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, HStack, Input, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import JobsTab from "@/src/ui/tabs/JobsTab";

type Worker = { id: string; displayName?: string | null; email?: string | null; workerType?: string | null };

export default function AdminJobsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("adminjobs_workers", []);
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
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

  // Pass selected IDs or undefined (all) to JobsTab
  const viewAsUserIds = selectedWorkers.length > 0 ? selectedWorkers : undefined;
  const viewAsWorkerType = selectedWorkers.length === 1
    ? (workers.find((w) => w.id === selectedWorkers[0])?.workerType ?? null)
    : undefined;

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workerItems.filter((it) => it.label.toLowerCase().includes(searchLc))
    : workerItems;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

  const header = (
    <HStack mb={3} gap={2} align="center" wrap="wrap">
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        View as:
      </Text>
      <Box ref={dropRef} position="relative">
        <Input
          size="sm"
          w="200px"
          placeholder={selectedWorkers.length > 0
            ? selectedWorkers.map((id) => workerNameMap[id] || id).join(", ")
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
                el.style.left = `${rect.left}px`;
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
      {selectedWorkers.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => { setSelectedWorkers([]); setSearchText(""); }}
        >
          <X size={14} />
        </Button>
      )}
      {selectedWorkers.length > 0 && (
        <HStack gap={1} wrap="wrap">
          {selectedWorkers.map((id) => (
            <Badge key={id} size="sm" colorPalette="blue" variant="solid">
              {workerNameMap[id] || id}
            </Badge>
          ))}
        </HStack>
      )}
    </HStack>
  );

  return (
    <JobsTab
      me={me}
      purpose={purpose}
      viewAsUserIds={viewAsUserIds}
      viewAsWorkerType={viewAsWorkerType}
      headerSlot={header}
    />
  );
}
