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
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import TeamMemberList, { type TeamMember } from "@/src/ui/components/TeamMemberList";

type WorkerLite = { id: string; displayName?: string | null; email?: string | null };
type GroupBrief = { id: string; name: string; claimer: { id: string; displayName?: string | null; email?: string | null }; members: { userId: string }[] };

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
  /** Group currently attached to the occurrence (if any). */
  assignedGroup?: { id: string; name: string } | null;
  onChanged?: () => void;
  isAdmin?: boolean;
  /** When true, the current user is the claimer and can reassign roles */
  isClaimer?: boolean;
};

export default function AddAssigneeDialog({ open, onOpenChange, occurrenceId, myId, currentAssignees, assignedGroup, onChanged, isAdmin, isClaimer }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [busyId, setBusyId] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  // Group attach UI (admin only). Either-or: an occurrence can have a group
  // attached OR individuals, never both. When `assignedGroup` is set, the
  // dialog hides the individual-add controls and surfaces a "Detach group"
  // button instead.
  const [groups, setGroups] = useState<GroupBrief[]>([]);
  const [pickGroupId, setPickGroupId] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const dlgErr = useDialogError();

  const groupCollection = useMemo(
    () =>
      createListCollection({
        items: groups.map((g) => ({
          label: `${g.name} (${g.members.length + 1})`,
          value: g.id,
        })),
      }),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    setMembers(currentAssignees.map((a) => ({
      userId: a.userId,
      assignedById: a.assignedById,
      role: a.role,
      user: a.user,
    })));
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/workers");
        setWorkers(Array.isArray(list) ? list : []);
      } catch { setWorkers([]); }
      if (isAdmin) {
        try {
          const gs = await apiGet<GroupBrief[]>("/api/admin/groups");
          setGroups(Array.isArray(gs) ? gs : []);
        } catch { setGroups([]); }
      }
    })();
  }, [open]);

  async function attachGroup() {
    if (!pickGroupId) return;
    dlgErr.clear();
    setGroupBusy(true);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/attach-group`, { groupId: pickGroupId });
      publishInlineMessage({ type: "SUCCESS", text: "Group attached." });
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Could not attach group.", err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function detachGroup() {
    dlgErr.clear();
    setGroupBusy(true);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/detach-group`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Group detached." });
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Could not detach group.", err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleAdd(userIds: string[], role: string | null) {
    dlgErr.clear();
    setAddBusy(true);
    try {
      for (const userId of userIds) {
        const endpoint = isAdmin
          ? `/api/admin/occurrences/${occurrenceId}/add-assignee`
          : `/api/occurrences/${occurrenceId}/add-assignee`;
        await apiPost(endpoint, { userId, role });
        const worker = workers.find((w) => w.id === userId);
        if (worker) {
          setMembers((prev) => [...prev, {
            userId,
            role,
            user: { id: userId, displayName: worker.displayName, email: worker.email },
          }]);
        }
      }
      publishInlineMessage({ type: "SUCCESS", text: userIds.length === 1 ? "Team member added." : `${userIds.length} team members added.` });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add team member.", err));
    } finally { setAddBusy(false); }
  }

  async function handleRemove(userId: string) {
    dlgErr.clear();
    setBusyId(userId);
    try {
      const endpoint = isAdmin
        ? `/api/admin/occurrences/${occurrenceId}/assignees/${userId}`
        : `/api/occurrences/${occurrenceId}/assignees/${userId}`;
      await apiDelete(endpoint);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      publishInlineMessage({ type: "SUCCESS", text: "Team member removed." });
      onChanged?.();
    } catch (err: any) {
      if (err?.code === "CLAIMER_CANNOT_BE_REMOVED") {
        publishInlineMessage({ type: "WARNING", text: "Reassign the claimer role to someone else before removing this person." });
      } else {
        dlgErr.setError(getErrorMessage("Failed to remove team member.", err));
      }
    } finally { setBusyId(""); }
  }

  async function handleLeave() {
    await handleRemove(myId);
  }

  async function handleMakeClaimer(userId: string) {
    if (!isAdmin && !isClaimer) return;
    dlgErr.clear();
    setBusyId(userId);
    try {
      const endpoint = isAdmin
        ? `/api/admin/occurrences/${occurrenceId}/reassign-claimer`
        : `/api/occurrences/${occurrenceId}/reassign-claimer`;
      await apiPost(endpoint, { userId });
      setMembers((prev) => prev.map((m) => ({
        ...m,
        assignedById: m.userId === userId ? userId : (m.role === "observer" ? m.assignedById : userId),
        role: m.userId === userId && m.role === "observer" ? null : m.role,
      })));
      publishInlineMessage({ type: "SUCCESS", text: "Claimer reassigned." });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to reassign claimer.", err));
    } finally { setBusyId(""); }
  }

  async function handleToggleRole(userId: string, currentRole: string | null) {
    if (!isAdmin && !isClaimer) return;
    const newRole = currentRole === "observer" ? null : "observer";
    dlgErr.clear();
    setBusyId(userId);
    try {
      const endpoint = isAdmin
        ? `/api/admin/occurrences/${occurrenceId}/assignees/${userId}/role`
        : `/api/occurrences/${occurrenceId}/assignees/${userId}/role`;
      await apiPatch(endpoint, { role: newRole ?? undefined });
      setMembers((prev) => prev.map((m) => {
        if (m.userId !== userId) return m;
        if (newRole === "observer") return { ...m, role: "observer", assignedById: null };
        const claimer = prev.find((x) => x.assignedById === x.userId && x.role !== "observer");
        return { ...m, role: null, assignedById: claimer?.userId ?? userId };
      }));
      publishInlineMessage({ type: "SUCCESS", text: newRole === "observer" ? "Changed to observer." : "Changed to worker." });
      onChanged?.();
    } catch (err: any) {
      if (err?.code === "CLAIMER_CANNOT_BE_OBSERVER") {
        publishInlineMessage({ type: "WARNING", text: "Reassign the claimer role before changing this person to observer." });
      } else {
        dlgErr.setError(getErrorMessage("Failed to change role.", err));
      }
    } finally { setBusyId(""); }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)} initialFocusEl={() => cancelRef.current}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Manage Team</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {isAdmin && assignedGroup && (
                <Box mb={3} p={2} bg="purple.50" borderWidth="1px" borderColor="purple.200" rounded="md">
                  <HStack justify="space-between" gap={2} wrap="wrap">
                    <VStack align="start" gap={0}>
                      <Text fontSize="xs" fontWeight="semibold" color="purple.800">
                        Group attached: {assignedGroup.name}
                      </Text>
                      <Text fontSize="xs" color="purple.700">
                        Detach the group to add individuals. The group itself stays intact — only this occurrence's link is removed.
                      </Text>
                    </VStack>
                    <Button size="xs" variant="outline" colorPalette="purple" onClick={() => void detachGroup()} loading={groupBusy}>
                      Detach group
                    </Button>
                  </HStack>
                </Box>
              )}
              {isAdmin && !assignedGroup && members.length === 0 && groups.length > 0 && (
                <Box mb={3} p={2} bg="purple.50" borderWidth="1px" borderColor="purple.200" rounded="md">
                  <Text fontSize="xs" fontWeight="semibold" color="purple.800" mb={1}>
                    Or assign a group
                  </Text>
                  <HStack gap={2} wrap="wrap" align="stretch">
                    <Box flex={1} minW="180px">
                      <Select.Root
                        collection={groupCollection}
                        value={pickGroupId ? [pickGroupId] : []}
                        onValueChange={(e) => setPickGroupId(e.value[0] ?? "")}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder="Pick a group…" />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {groupCollection.items.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" colorPalette="purple" onClick={() => void attachGroup()} disabled={!pickGroupId} loading={groupBusy}>
                      Attach
                    </Button>
                  </HStack>
                  <Text fontSize="xs" color="purple.700" mt={1}>
                    Materializes the full group as assignees. Either group OR individuals — not both.
                  </Text>
                </Box>
              )}
              {!assignedGroup && (
                <TeamMemberList
                  members={members}
                  workers={workers}
                  busyId={busyId}
                  addBusy={addBusy}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onToggleRole={(isAdmin || isClaimer) ? handleToggleRole : undefined}
                  onMakeClaimer={(isAdmin || isClaimer) ? handleMakeClaimer : undefined}
                  showRoleControls={!!(isAdmin || isClaimer)}
                  showMakeClaimer={!!(isAdmin || isClaimer)}
                  allowRemoveClaimer={!!isAdmin}
                  myId={myId}
                  onLeave={handleLeave}
                />
              )}
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button ref={cancelRef} onClick={() => onOpenChange(false)} disabled={addBusy || busyId !== ""}>Done</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
