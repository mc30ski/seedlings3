"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, HStack, Select, Text, createListCollection } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import JobsTab from "@/src/ui/tabs/JobsTab";

type Worker = { id: string; displayName?: string | null; email?: string | null };

export default function AdminJobsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorker, setSelectedWorker] = useState<string[]>([]);

  useEffect(() => {
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  const workerItems = useMemo(
    () => [
      { label: "All Workers", value: "" },
      ...workers.map((w) => ({
        label: w.displayName || w.email || w.id,
        value: w.id,
      })),
    ],
    [workers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  const viewAsUserId = selectedWorker[0] || undefined;

  const header = (
    <HStack mb={3} gap={2} align="center">
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        View as:
      </Text>
      <Select.Root
        collection={workerCollection}
        value={selectedWorker}
        onValueChange={(e) => setSelectedWorker(e.value)}
        size="sm"
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
    </HStack>
  );

  return (
    <JobsTab
      me={me}
      purpose={purpose}
      viewAsUserId={viewAsUserId}
      headerSlot={header}
    />
  );
}
