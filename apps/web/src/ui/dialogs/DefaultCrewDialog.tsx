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
  createListCollection,
} from "@chakra-ui/react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/src/lib/api";
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
type GroupBrief = {
  id: string;
  name: string;
  archivedAt: string | null;
  claimer: { id: string; displayName?: string | null; email?: string | null };
  members: { userId: string }[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignees: TeamMember[];
  /** Currently-configured default group (if any). When set, the dialog
   *  opens in group mode with this group selected. */
  currentGroup?: { id: string; name: string } | null;
  onChanged?: () => void;
};

export default function DefaultCrewDialog({ open, onOpenChange, jobId, currentAssignees, currentGroup, onChanged }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [busyId, setBusyId] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [mode, setMode] = useState<"individuals" | "group">("individuals");
  const [groups, setGroups] = useState<GroupBrief[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [groupBusy, setGroupBusy] = useState(false);
  // Mirror of `currentGroup` that we can mutate locally when an action on
  // the server clears it (e.g. adding an individual auto-clears the
  // default group server-side). Without this the orange "default group X
  // is set" warning would stay visible until the dialog was reopened.
  const [activeGroup, setActiveGroup] = useState<{ id: string; name: string } | null>(null);
  const dlgErr = useDialogError();

  const groupCollection = useMemo(
    () => createListCollection({
      items: groups
        .filter((g) => !g.archivedAt)
        .map((g) => ({
          value: g.id,
          label: `${g.name} (${g.members.length + 1} member${g.members.length === 0 ? "" : "s"}, claimer: ${g.claimer.displayName ?? g.claimer.email})`,
        })),
    }),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    setMembers(currentAssignees);
    setActiveGroup(currentGroup ?? null);
    setMode(currentGroup ? "group" : "individuals");
    setSelectedGroupId(currentGroup?.id ?? "");
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/admin/users?role=WORKER&approved=true");
        setWorkers(Array.isArray(list) ? list : []);
      } catch { setWorkers([]); }
      try {
        const gs = await apiGet<GroupBrief[]>("/api/admin/groups");
        setGroups(Array.isArray(gs) ? gs : []);
      } catch { setGroups([]); }
    })();
  }, [open]);

  async function setDefaultGroup(groupId: string | null) {
    dlgErr.clear();
    setGroupBusy(true);
    try {
      await apiPut(`/api/admin/jobs/${jobId}/default-group`, { groupId });
      publishInlineMessage({
        type: "SUCCESS",
        text: groupId ? "Default group set." : "Default group cleared.",
      });
      // Local mirror — keeps the dialog in sync without waiting for the
      // parent to re-render with a refetched detail.
      if (groupId) {
        const g = groups.find((x) => x.id === groupId);
        setActiveGroup(g ? { id: g.id, name: g.name } : null);
        setSelectedGroupId(groupId);
        // Setting a group server-side clears any per-user defaults.
        setMembers([]);
      } else {
        setActiveGroup(null);
        setSelectedGroupId("");
      }
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to set default group.", err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleAdd(userIds: string[], role: string | null) {
    dlgErr.clear();
    setAddBusy(true);
    try {
      for (const userId of userIds) {
        await apiPost(`/api/admin/jobs/${jobId}/default-assignees/add`, { userId, role });
        const worker = workers.find((w) => w.id === userId);
        if (worker) {
          setMembers((prev) => [...prev, { userId, role, user: { id: userId, displayName: worker.displayName, email: worker.email } }]);
        }
      }
      // Server-side: adding an individual default clears the default group
      // (mutually exclusive). Mirror locally so the dialog shows the new
      // single-mode state right away.
      setActiveGroup(null);
      setSelectedGroupId("");
      publishInlineMessage({ type: "SUCCESS", text: userIds.length === 1 ? "Worker added to default team." : `${userIds.length} workers added.` });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add worker.", err));
    } finally { setAddBusy(false); }
  }

  async function handleRemove(userId: string) {
    dlgErr.clear();
    setBusyId(userId);
    try {
      await apiDelete(`/api/admin/jobs/${jobId}/default-assignees/${userId}`);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      publishInlineMessage({ type: "SUCCESS", text: "Worker removed from default team." });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to remove worker.", err));
    } finally { setBusyId(""); }
  }

  async function handleToggleRole(userId: string, currentRole: string | null) {
    const newRole = currentRole === "observer" ? null : "observer";
    dlgErr.clear();
    setBusyId(userId);
    try {
      await apiPatch(`/api/admin/jobs/${jobId}/default-assignees/${userId}/role`, { role: newRole });
      setMembers((prev) => prev.map((m) => m.userId === userId ? { ...m, role: newRole } : m));
      publishInlineMessage({ type: "SUCCESS", text: newRole === "observer" ? "Changed to observer." : "Changed to worker." });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to change role.", err));
    } finally { setBusyId(""); }
  }

  async function handleMakeClaimer(userId: string) {
    dlgErr.clear();
    setBusyId(userId);
    try {
      await apiPost(`/api/admin/jobs/${jobId}/default-assignees/${userId}/make-claimer`, {});
      // Move chosen user to the front, drop observer role if they had one,
      // and stamp assignedById = userId so TeamMemberList highlights them.
      setMembers((prev) => {
        const target = prev.find((m) => m.userId === userId);
        if (!target) return prev;
        const updated = { ...target, role: null, assignedById: userId };
        const rest = prev.filter((m) => m.userId !== userId).map((m) => ({ ...m, assignedById: m.role === "observer" ? m.assignedById ?? null : null }));
        return [updated, ...rest];
      });
      publishInlineMessage({ type: "SUCCESS", text: "Default claimer updated." });
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to set claimer.", err));
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
              <Dialog.Title>Default Team</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Box px={2} py={1.5} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                  <Text fontSize="2xs" color="yellow.700">
                    The default team is automatically assigned to each new occurrence. One-time team changes on individual occurrences won't affect these defaults.
                  </Text>
                </Box>
                <HStack gap={2}>
                  <Button
                    size="sm"
                    variant={mode === "individuals" ? "solid" : "outline"}
                    onClick={() => setMode("individuals")}
                  >
                    Individuals
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === "group" ? "solid" : "outline"}
                    colorPalette={mode === "group" ? "purple" : "gray"}
                    onClick={() => setMode("group")}
                  >
                    Group
                  </Button>
                </HStack>
                {mode === "group" ? (
                  <VStack align="stretch" gap={2}>
                    <Text fontSize="xs" color="fg.muted">
                      Pick a saved crew. Setting a group will clear any individual default assignees — the two modes are mutually exclusive.
                    </Text>
                    <Select.Root
                      collection={groupCollection}
                      value={selectedGroupId ? [selectedGroupId] : []}
                      onValueChange={(e) => setSelectedGroupId(e.value[0] ?? "")}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger w="full">
                          <Select.ValueText placeholder="— pick a group —" />
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
                    {activeGroup && (
                      <Box p={2} bg="purple.50" rounded="md" borderWidth="1px" borderColor="purple.200">
                        <HStack justify="space-between">
                          <Text fontSize="xs" color="purple.800">
                            Current: <Text as="span" fontWeight="semibold">{activeGroup.name}</Text>
                          </Text>
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="red"
                            loading={groupBusy}
                            onClick={() => setDefaultGroup(null)}
                          >
                            Remove group
                          </Button>
                        </HStack>
                      </Box>
                    )}
                    <HStack justify="flex-end">
                      <Button
                        size="sm"
                        colorPalette="purple"
                        loading={groupBusy}
                        disabled={!selectedGroupId || selectedGroupId === activeGroup?.id}
                        onClick={() => setDefaultGroup(selectedGroupId)}
                      >
                        {activeGroup ? "Save group" : "Set as default group"}
                      </Button>
                    </HStack>
                  </VStack>
                ) : (
                  <>
                    {activeGroup && (
                      <Box p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.200">
                        <HStack justify="space-between" gap={2} wrap="wrap">
                          <Text fontSize="xs" color="orange.800">
                            A default group <Text as="span" fontWeight="semibold">{activeGroup.name}</Text> is currently set. Adding individuals will clear it.
                          </Text>
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="red"
                            loading={groupBusy}
                            onClick={() => setDefaultGroup(null)}
                          >
                            Remove group
                          </Button>
                        </HStack>
                      </Box>
                    )}
                    <TeamMemberList
                      members={members}
                      workers={workers}
                      busyId={busyId}
                      addBusy={addBusy}
                      onAdd={handleAdd}
                      onRemove={handleRemove}
                      onToggleRole={handleToggleRole}
                      onMakeClaimer={handleMakeClaimer}
                      showRoleControls
                      showMakeClaimer
                      // Default-team context: no in-flight work depends on
                      // who's the claimer here, so allow removing them.
                      // The next person in sortOrder becomes the claimer.
                      allowRemoveClaimer
                      listTitle="Default team"
                      addTitle="Add to default team"
                      emptyText="No default team set. Occurrences will be unassigned (claimable)."
                    />
                  </>
                )}
              </VStack>
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
