"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
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
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
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
  role?: string | null;
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
  const [addBusy, setAddBusy] = useState(false);
  const [addAsObserver, setAddAsObserver] = useState(false);
  const [busyId, setBusyId] = useState<string>("");

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

  async function handleAdd() {
    if (selected.length === 0) return;
    setAddBusy(true);
    const role = addAsObserver ? "observer" : null;
    try {
      for (const userId of selected) {
        await apiPost(`/api/admin/jobs/${jobId}/default-assignees/add`, { userId, role });
        const worker = workers.find((w) => w.id === userId);
        if (worker) {
          setAssignees((prev) => [
            ...prev,
            { id: "", userId, role, user: { id: userId, displayName: worker.displayName, email: worker.email } },
          ]);
        }
      }
      setSelected([]);
      publishInlineMessage({
        type: "SUCCESS",
        text: selected.length === 1 ? "Worker added to default crew." : `${selected.length} workers added.`,
      });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add worker.", err) });
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(targetUserId: string) {
    setBusyId(targetUserId);
    try {
      await apiDelete(`/api/admin/jobs/${jobId}/default-assignees/${targetUserId}`);
      setAssignees((prev) => prev.filter((a) => a.userId !== targetUserId));
      publishInlineMessage({ type: "SUCCESS", text: "Worker removed from default crew." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove worker.", err) });
    } finally {
      setBusyId("");
    }
  }

  async function handleToggleRole(targetUserId: string, currentRole: string | null) {
    const newRole = currentRole === "observer" ? null : "observer";
    setBusyId(targetUserId);
    try {
      await apiPatch(`/api/admin/jobs/${jobId}/default-assignees/${targetUserId}/role`, { role: newRole });
      setAssignees((prev) => prev.map((a) =>
        a.userId === targetUserId ? { ...a, role: newRole } : a
      ));
      publishInlineMessage({ type: "SUCCESS", text: newRole === "observer" ? "Changed to observer." : "Changed to worker." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to change role.", err) });
    } finally {
      setBusyId("");
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
                <Box px={2} py={1.5} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                  <Text fontSize="2xs" color="yellow.700">
                    The default crew is automatically assigned to each new occurrence. One-time team changes on individual occurrences won't affect these defaults.
                  </Text>
                </Box>

                <div>
                  <Text fontWeight="medium" mb="2">Default crew</Text>
                  {assignees.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">No default crew set. Occurrences will be unassigned (claimable).</Text>
                  )}
                  <VStack align="stretch" gap={1}>
                    {assignees.map((a) => {
                      const isObs = a.role === "observer";
                      return (
                        <Box
                          key={a.userId}
                          px={2}
                          py={1.5}
                          rounded="md"
                          borderWidth="1px"
                          borderColor={isObs ? "blue.200" : "gray.200"}
                          bg={isObs ? "blue.50" : undefined}
                        >
                          <HStack justify="space-between" align="center">
                            <VStack align="start" gap={0.5}>
                              <Text fontSize="sm" color={isObs ? "blue.700" : undefined}>
                                {a.user?.displayName ?? a.user?.email ?? a.userId}
                              </Text>
                              <HStack gap={1}>
                                {isObs ? (
                                  <Badge size="sm" colorPalette="blue" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Observer</Badge>
                                ) : (
                                  <Badge size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">Worker</Badge>
                                )}
                              </HStack>
                            </VStack>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              loading={busyId === a.userId}
                              disabled={busyId !== ""}
                              onClick={() => handleRemove(a.userId)}
                            >
                              Remove
                            </Button>
                          </HStack>
                          <HStack gap={1} mt={1}>
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette={isObs ? "teal" : "blue"}
                              disabled={busyId !== ""}
                              onClick={() => handleToggleRole(a.userId, a.role ?? null)}
                            >
                              {isObs ? "→ Worker" : "→ Observer"}
                            </Button>
                          </HStack>
                        </Box>
                      );
                    })}
                  </VStack>
                </div>

                <div>
                  <Text fontWeight="medium" mb="2">Add to default crew</Text>

                  <HStack gap={2} mb={2}>
                    <Button
                      size="sm"
                      variant={!addAsObserver ? "solid" : "outline"}
                      colorPalette={!addAsObserver ? "teal" : "gray"}
                      onClick={() => setAddAsObserver(false)}
                    >
                      Worker
                    </Button>
                    <Button
                      size="sm"
                      variant={addAsObserver ? "solid" : "outline"}
                      colorPalette={addAsObserver ? "blue" : "gray"}
                      onClick={() => setAddAsObserver(true)}
                    >
                      Observer
                    </Button>
                  </HStack>
                  <Text fontSize="xs" color="fg.muted" mb={2}>
                    {addAsObserver
                      ? "Observers can see the job and set reminders, but cannot start, complete, or manage it."
                      : "Workers can take actions on the job — start, complete, manage expenses, etc."}
                  </Text>

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
                                workers.length === 0
                                  ? "Loading…"
                                  : availableWorkers.length === 0
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
                    <Button
                      size="sm"
                      colorPalette={addAsObserver ? "blue" : "teal"}
                      onClick={handleAdd}
                      loading={addBusy}
                      disabled={selected.length === 0 || busyId !== ""}
                    >
                      {addAsObserver ? "Add as Observer" : "Add as Worker"}
                    </Button>
                  </HStack>
                </div>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={addBusy || busyId !== ""}
                >
                  Done
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
