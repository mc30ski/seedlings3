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

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type Assignee = {
  userId: string;
  role?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null };
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  myId: string;
  currentAssignees: Assignee[];
  onChanged?: () => void;
  isAdmin?: boolean;
};

export default function AddAssigneeDialog({
  open,
  onOpenChange,
  occurrenceId,
  myId,
  currentAssignees,
  onChanged,
  isAdmin,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Local copy of assignees — updates immediately on add/remove
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setAssignees(currentAssignees);
    setSelected([]);
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/workers");
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

  const [addAsObserver, setAddAsObserver] = useState(false);

  async function handleAdd() {
    if (selected.length === 0) return;
    setAddBusy(true);
    const role = addAsObserver ? "observer" : null;
    try {
      for (const userId of selected) {
        const endpoint = isAdmin
          ? `/api/admin/occurrences/${occurrenceId}/add-assignee`
          : `/api/occurrences/${occurrenceId}/add-assignee`;
        await apiPost(endpoint, { userId, role });
        const worker = workers.find((w) => w.id === userId);
        if (worker) {
          setAssignees((prev) => [
            ...prev,
            { userId, role, user: { id: userId, displayName: worker.displayName, email: worker.email } },
          ]);
        }
      }
      setSelected([]);
      publishInlineMessage({
        type: "SUCCESS",
        text: selected.length === 1 ? "Team member added." : `${selected.length} team members added.`,
      });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to add team member.", err),
      });
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(targetUserId: string) {
    setRemovingId(targetUserId);
    try {
      const endpoint = isAdmin
        ? `/api/admin/occurrences/${occurrenceId}/assignees/${targetUserId}`
        : `/api/occurrences/${occurrenceId}/assignees/${targetUserId}`;
      await apiDelete(endpoint);
      setAssignees((prev) => prev.filter((a) => a.userId !== targetUserId));
      publishInlineMessage({ type: "SUCCESS", text: "Team member removed." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to remove team member.", err),
      });
    } finally {
      setRemovingId("");
    }
  }

  // Others = everyone except me (can't remove yourself here — use Unclaim)
  const removableAssignees = assignees.filter((a) => a.userId !== myId);
  const myAssignee = assignees.find((a) => a.userId === myId);

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
              <Dialog.Title>Manage Team</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>

                {/* Current team */}
                <div>
                  <Text fontWeight="medium" mb="2">Current team</Text>
                  {assignees.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">No one assigned yet.</Text>
                  )}
                  <VStack align="stretch" gap={1}>
                    {myAssignee && (
                      <HStack
                        px={2}
                        py={1}
                        rounded="md"
                        bg="teal.50"
                        borderWidth="1px"
                        borderColor="teal.200"
                        justify="space-between"
                      >
                        <Text fontSize="sm" fontWeight="medium" color="teal.700">
                          {myAssignee.user.displayName ?? myAssignee.user.email ?? myId}{" "}
                          <Box as="span" fontWeight="normal" color="teal.500">(you){myAssignee.role === "observer" ? " · Observer" : ""}</Box>
                        </Text>
                      </HStack>
                    )}
                    {removableAssignees.map((a) => (
                      <HStack
                        key={a.userId}
                        px={2}
                        py={1}
                        rounded="md"
                        borderWidth="1px"
                        borderColor="gray.200"
                        justify="space-between"
                      >
                        <Text fontSize="sm">
                          {a.user.displayName ?? a.user.email ?? a.userId}
                          {a.role === "observer" && <Box as="span" color="blue.500" fontSize="xs"> · Observer</Box>}
                        </Text>
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
                    ))}
                  </VStack>
                </div>

                {/* Add more */}
                <div>
                  <Text fontWeight="medium" mb="2">Add to team</Text>

                  {/* Role selection */}
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

                  {/* Worker select + Add */}
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
                      disabled={selected.length === 0 || removingId !== ""}
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
                  disabled={addBusy || removingId !== ""}
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
