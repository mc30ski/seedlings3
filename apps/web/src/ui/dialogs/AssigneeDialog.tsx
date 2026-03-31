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
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentAssignees: JobOccurrenceAssigneeWithUser[];
  hasPayment?: boolean;
  onChanged?: () => void;
};

export default function AssigneeDialog({
  open,
  onOpenChange,
  occurrenceId,
  currentAssignees,
  hasPayment,
  onChanged,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const [assignees, setAssignees] = useState<JobOccurrenceAssigneeWithUser[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string>("");
  const [assigneesChanged, setAssigneesChanged] = useState(false);
  const [showRecalcPrompt, setShowRecalcPrompt] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssignees(currentAssignees);
    setSelected([]);
    setAssigneesChanged(false);
    setShowRecalcPrompt(false);
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>(
          "/api/admin/users?role=WORKER&approved=true"
        );
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
    () =>
      availableWorkers.map((w) => ({
        label: w.displayName ?? w.email ?? w.id,
        value: w.id,
      })),
    [availableWorkers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  async function handleAdd() {
    if (selected.length === 0) return;
    setAddBusy(true);
    try {
      for (const userId of selected) {
        const result = await apiPost<{ added: boolean; reason?: string }>(
          `/api/admin/occurrences/${occurrenceId}/add-assignee`,
          { userId }
        );
        if (result.added) {
          const worker = workers.find((w) => w.id === userId);
          if (worker) {
            // Determine assignedById: first assignee = self-claimer, others assigned by claimer
            const isClaimer = assignees.length === 0 && selected[0] === userId;
            const claimerId = assignees.find((a) => a.assignedById === a.userId)?.userId ?? userId;
            setAssignees((prev) => [
              ...prev,
              {
                id: "",
                occurrenceId,
                userId,
                assignedById: isClaimer ? userId : claimerId,
                user: { id: userId, displayName: worker.displayName, email: worker.email },
              },
            ]);
          }
        }
      }
      setSelected([]);
      setAssigneesChanged(true);
      publishInlineMessage({
        type: "SUCCESS",
        text: selected.length === 1 ? "Worker assigned." : `${selected.length} workers assigned.`,
      });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to assign worker.", err),
      });
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(targetUserId: string) {
    setRemovingId(targetUserId);
    try {
      await apiDelete(`/api/admin/occurrences/${occurrenceId}/assignees/${targetUserId}`);
      setAssignees((prev) => prev.filter((a) => a.userId !== targetUserId));
      setAssigneesChanged(true);
      publishInlineMessage({ type: "SUCCESS", text: "Worker removed." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to remove worker.", err),
      });
    } finally {
      setRemovingId("");
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Assign Workers</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <div>
                  <Text fontWeight="medium" mb="2">Assigned workers</Text>
                  {assignees.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">No one assigned yet.</Text>
                  )}
                  <VStack align="stretch" gap={1}>
                    {assignees.map((a) => {
                      const isClaimer = a.assignedById === a.userId;
                      return (
                        <HStack
                          key={a.userId}
                          px={2}
                          py={1}
                          rounded="md"
                          borderWidth="1px"
                          borderColor={isClaimer ? "teal.200" : "gray.200"}
                          bg={isClaimer ? "teal.50" : undefined}
                          justify="space-between"
                        >
                          <VStack align="start" gap={0}>
                            <Text fontSize="sm" fontWeight={isClaimer ? "medium" : "normal"} color={isClaimer ? "teal.700" : undefined}>
                              {a.user.displayName ?? a.user.email ?? a.userId}
                            </Text>
                            {isClaimer && (
                              <Text fontSize="xs" color="teal.500">Claimer</Text>
                            )}
                          </VStack>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            loading={removingId === a.userId}
                            disabled={removingId !== ""}
                            onClick={() => handleRemove(a.userId)}
                          >
                            Remove
                          </Button>
                        </HStack>
                      );
                    })}
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
                      onClick={handleAdd}
                      loading={addBusy}
                      disabled={selected.length === 0 || removingId !== ""}
                    >
                      Add
                    </Button>
                  </HStack>
                </div>
              </VStack>
            </Dialog.Body>

            {hasPayment && assigneesChanged && !showRecalcPrompt && (
              <Box px="4" pb="2">
                <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md">
                  <Text fontSize="xs" color="orange.700">
                    This occurrence has already been paid. The payment splits may no longer match the current team.
                  </Text>
                </Box>
              </Box>
            )}

            {showRecalcPrompt && (
              <Box px="4" pb="2">
                <VStack align="stretch" gap={2}>
                  <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md">
                    <Text fontSize="sm" fontWeight="medium" color="orange.700" mb={1}>
                      Recalculate payment splits?
                    </Text>
                    <Text fontSize="xs" color="orange.600">
                      This will evenly split the payment amount across the current team. Warning: if financial records have already been acted on (e.g. cash paid out), the previous records may no longer be accurate.
                    </Text>
                  </Box>
                  <HStack justify="flex-end" gap={2}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setShowRecalcPrompt(false);
                        onOpenChange(false);
                      }}
                    >
                      Skip
                    </Button>
                    <Button
                      size="sm"
                      colorPalette="orange"
                      loading={recalcBusy}
                      onClick={async () => {
                        setRecalcBusy(true);
                        try {
                          await apiPost(`/api/admin/occurrences/${occurrenceId}/recalculate-splits`);
                          publishInlineMessage({ type: "SUCCESS", text: "Payment splits recalculated." });
                          onChanged?.();
                          setShowRecalcPrompt(false);
                          onOpenChange(false);
                        } catch (err) {
                          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Recalculate failed.", err) });
                        } finally {
                          setRecalcBusy(false);
                        }
                      }}
                    >
                      Recalculate
                    </Button>
                  </HStack>
                </VStack>
              </Box>
            )}

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  ref={cancelRef}
                  onClick={() => {
                    if (hasPayment && assigneesChanged && !showRecalcPrompt) {
                      setShowRecalcPrompt(true);
                    } else {
                      onOpenChange(false);
                    }
                  }}
                  disabled={addBusy || removingId !== "" || recalcBusy}
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
