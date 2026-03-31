"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiPut } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type DefaultAssignee = {
  id: string;
  userId: string;
  user?: { id: string; displayName?: string | null; email?: string | null };
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignees: DefaultAssignee[];
  onChanged?: () => void;
};

export default function DefaultCrewDialog({
  open,
  onOpenChange,
  jobId,
  currentAssignees,
  onChanged,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [assignees, setAssignees] = useState<DefaultAssignee[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssignees(currentAssignees);
    setSelected([]);
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/admin/users?role=WORKER&approved=true");
        setWorkers(Array.isArray(list) ? list : []);
      } catch {
        setWorkers([]);
      }
    })();
  }, [open]);

  const assignedIds = useMemo(() => assignees.map((a) => a.userId), [assignees]);

  const availableWorkers = useMemo(
    () => workers.filter((w) => !assignedIds.includes(w.id)),
    [workers, assignedIds]
  );

  const workerItems = useMemo(
    () => availableWorkers.map((w) => ({ label: w.displayName ?? w.email ?? w.id, value: w.id })),
    [availableWorkers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  function addSelected() {
    for (const uid of selected) {
      const w = workers.find((w) => w.id === uid);
      if (w && !assignedIds.includes(uid)) {
        setAssignees((prev) => [...prev, { id: "", userId: uid, user: { id: uid, displayName: w.displayName, email: w.email } }]);
      }
    }
    setSelected([]);
  }

  function remove(userId: string) {
    setAssignees((prev) => prev.filter((a) => a.userId !== userId));
  }

  async function handleSave() {
    setBusy(true);
    try {
      await apiPut(`/api/admin/jobs/${jobId}/default-assignees`, {
        userIds: assignees.map((a) => a.userId),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Default crew updated." });
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to update default crew.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)} initialFocusEl={() => cancelRef.current}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Default Crew</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Text fontSize="xs" color="fg.muted">
                  When a new occurrence is created for this job and no specific team is selected, these workers will be automatically assigned.
                </Text>

                <div>
                  <Text fontWeight="medium" mb="2">Current default crew</Text>
                  {assignees.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">No default crew set. Occurrences will be unassigned (claimable).</Text>
                  )}
                  <VStack align="stretch" gap={1}>
                    {assignees.map((a) => (
                      <HStack key={a.userId} px={2} py={1} rounded="md" borderWidth="1px" justify="space-between">
                        <Text fontSize="sm">{a.user?.displayName ?? a.user?.email ?? a.userId}</Text>
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => remove(a.userId)}>
                          Remove
                        </Button>
                      </HStack>
                    ))}
                  </VStack>
                </div>

                <div>
                  <Text fontWeight="medium" mb="2">Add workers</Text>
                  <HStack gap={2} align="flex-end">
                    <Box flex="1">
                      <Select.Root
                        collection={workerCollection}
                        value={selected}
                        onValueChange={(e) => setSelected(e.value)}
                        multiple
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText
                              placeholder={
                                availableWorkers.length === 0
                                  ? "All workers assigned"
                                  : "Select workers"
                              }
                            />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {workerItems.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" onClick={addSelected} disabled={selected.length === 0}>
                      Add
                    </Button>
                  </HStack>
                </div>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={busy}>
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
