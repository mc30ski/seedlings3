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

type Assignee = {
  userId: string;
  assignedById?: string | null;
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
    } catch (err: any) {
      const code = err?.code ?? "";
      if (code === "CLAIMER_CANNOT_BE_REMOVED") {
        publishInlineMessage({ type: "WARNING", text: "Reassign the claimer role to someone else before removing this person." });
      } else {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove team member.", err) });
      }
    } finally {
      setRemovingId("");
    }
  }

  async function handleMakeClaimer(targetUserId: string) {
    if (!isAdmin) return;
    setRemovingId(targetUserId);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/reassign-claimer`, { userId: targetUserId });
      setAssignees((prev) => prev.map((a) => ({
        ...a,
        assignedById: a.userId === targetUserId ? targetUserId : (a.role === "observer" ? a.assignedById : targetUserId),
        role: a.userId === targetUserId && a.role === "observer" ? null : a.role,
      })));
      publishInlineMessage({ type: "SUCCESS", text: "Claimer reassigned." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reassign claimer.", err) });
    } finally {
      setRemovingId("");
    }
  }

  async function handleToggleRole(targetUserId: string, currentRole: string | null) {
    if (!isAdmin) return;
    const newRole = currentRole === "observer" ? null : "observer";
    setRemovingId(targetUserId);
    try {
      await apiPatch(`/api/admin/occurrences/${occurrenceId}/assignees/${targetUserId}/role`, { role: newRole ?? undefined });
      setAssignees((prev) => prev.map((a) => {
        if (a.userId !== targetUserId) return a;
        if (newRole === "observer") return { ...a, role: "observer", assignedById: null };
        const claimer = prev.find((x) => x.assignedById === x.userId && x.role !== "observer");
        return { ...a, role: null, assignedById: claimer?.userId ?? targetUserId };
      }));
      publishInlineMessage({ type: "SUCCESS", text: newRole === "observer" ? "Changed to observer." : "Changed to worker." });
      onChanged?.();
    } catch (err: any) {
      const code = err?.code ?? "";
      if (code === "CLAIMER_CANNOT_BE_OBSERVER") {
        publishInlineMessage({ type: "WARNING", text: "Reassign the claimer role before changing this person to observer." });
      } else {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to change role.", err) });
      }
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
                    {myAssignee && (() => {
                      const hasAnyAssignedById = assignees.some((x) => x.assignedById);
                      const isMeClaimer = hasAnyAssignedById
                        ? (myAssignee.assignedById === myAssignee.userId && myAssignee.role !== "observer")
                        : (myAssignee.role !== "observer" && assignees.filter((x) => x.role !== "observer")[0]?.userId === myAssignee.userId);
                      const isMeObs = myAssignee.role === "observer";
                      return (
                        <HStack
                          px={2}
                          py={1}
                          rounded="md"
                          bg="teal.50"
                          borderWidth="1px"
                          borderColor="teal.200"
                          justify="space-between"
                        >
                          <VStack align="start" gap={0.5}>
                            <Text fontSize="sm" fontWeight="medium" color="teal.700">
                              {myAssignee.user.displayName ?? myAssignee.user.email ?? myId}{" "}
                              <Box as="span" fontWeight="normal" color="teal.500">(you)</Box>
                            </Text>
                            <HStack gap={1}>
                              {isMeClaimer && <Badge size="sm" colorPalette="teal" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Claimer</Badge>}
                              {isMeObs && <Badge size="sm" colorPalette="blue" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Observer</Badge>}
                              {!isMeClaimer && !isMeObs && <Badge size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">Worker</Badge>}
                            </HStack>
                          </VStack>
                          {!isMeClaimer && (
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              loading={removingId === myId}
                              disabled={removingId !== ""}
                              onClick={() => handleRemove(myId)}
                            >
                              Leave
                            </Button>
                          )}
                        </HStack>
                      );
                    })()}
                    {removableAssignees.map((a) => {
                      const hasAnyAssignedById2 = assignees.some((x) => x.assignedById);
                      const isClaimer = hasAnyAssignedById2
                        ? (a.assignedById === a.userId && a.role !== "observer")
                        : (a.role !== "observer" && assignees.filter((x) => x.role !== "observer")[0]?.userId === a.userId);
                      const isObs = a.role === "observer";
                      const otherWorkers = assignees.filter((x) => x.userId !== a.userId && x.role !== "observer");
                      const canRemoveClaimer = isClaimer && otherWorkers.length === 0;
                      return (
                        <Box
                          key={a.userId}
                          px={2}
                          py={1.5}
                          rounded="md"
                          borderWidth="1px"
                          borderColor={isObs ? "blue.200" : isClaimer ? "teal.200" : "gray.200"}
                          bg={isObs ? "blue.50" : isClaimer ? "teal.50" : undefined}
                        >
                          <HStack justify="space-between" align="center">
                            <VStack align="start" gap={0.5}>
                              <Text fontSize="sm" fontWeight={isClaimer ? "medium" : "normal"} color={isObs ? "blue.700" : isClaimer ? "teal.700" : undefined}>
                                {a.user.displayName ?? a.user.email ?? a.userId}
                              </Text>
                              <HStack gap={1}>
                                {isClaimer && <Badge size="sm" colorPalette="teal" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Claimer</Badge>}
                                {isObs && <Badge size="sm" colorPalette="blue" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Observer</Badge>}
                                {!isClaimer && !isObs && <Badge size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">Worker</Badge>}
                              </HStack>
                            </VStack>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              loading={removingId === a.userId}
                              disabled={removingId !== "" || (isClaimer && !canRemoveClaimer)}
                              title={isClaimer && !canRemoveClaimer ? "Reassign claimer first" : undefined}
                              onClick={() => handleRemove(a.userId)}
                            >
                              Remove
                            </Button>
                          </HStack>
                          {isAdmin && (
                            <HStack gap={1} mt={1}>
                              {!isClaimer && (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  colorPalette="teal"
                                  disabled={removingId !== ""}
                                  onClick={() => handleMakeClaimer(a.userId)}
                                >
                                  Make Claimer
                                </Button>
                              )}
                              <Button
                                size="xs"
                                variant="outline"
                                colorPalette={isObs ? "teal" : "blue"}
                                disabled={removingId !== ""}
                                onClick={() => handleToggleRole(a.userId, a.role ?? null)}
                              >
                                {isObs ? "→ Worker" : "→ Observer"}
                              </Button>
                            </HStack>
                          )}
                        </Box>
                      );
                    })}
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
