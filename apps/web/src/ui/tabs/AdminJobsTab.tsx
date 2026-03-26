"use client";

import { useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, HStack, Select, Text, createListCollection } from "@chakra-ui/react";
import { X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import JobsTab from "@/src/ui/tabs/JobsTab";

type Worker = { id: string; displayName?: string | null; email?: string | null; workerType?: string | null };

export default function AdminJobsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("adminjobs_workers", []);

  useEffect(() => {
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  const workerItems = useMemo(
    () =>
      workers.map((w) => ({
        label: w.displayName || w.email || w.id,
        value: w.id,
      })),
    [workers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [workers]);

  // Pass selected IDs or undefined (all) to JobsTab
  const viewAsUserIds = selectedWorkers.length > 0 ? selectedWorkers : undefined;
  // When viewing as a single worker, simulate their worker type for UI behavior
  const viewAsWorkerType = selectedWorkers.length === 1
    ? (workers.find((w) => w.id === selectedWorkers[0])?.workerType ?? null)
    : undefined;

  const header = (
    <HStack mb={3} gap={2} align="center" wrap="wrap">
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        View as:
      </Text>
      <Select.Root
        collection={workerCollection}
        value={selectedWorkers}
        onValueChange={(e) => setSelectedWorkers(e.value)}
        size="sm"
        multiple
        positioning={{ strategy: "fixed", hideWhenDetached: true }}
        css={{ width: "auto", flex: "0 0 auto" }}
      >
        <Select.Control>
          <Select.Trigger minW="140px">
            <Select.ValueText placeholder="All Workers" />
          </Select.Trigger>
        </Select.Control>
        <Select.Positioner>
          <Select.Content>
            {workerItems.map((it) => (
              <Select.Item key={it.value} item={it.value}>
                <Select.ItemText>{it.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Select.Root>
      {selectedWorkers.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => setSelectedWorkers([])}
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
