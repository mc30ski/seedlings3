"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import TeamMemberList, { type TeamMember } from "@/src/ui/components/TeamMemberList";

type WorkerLite = { id: string; displayName?: string | null; email?: string | null };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignees: TeamMember[];
  onChanged?: () => void;
};

export default function DefaultCrewDialog({ open, onOpenChange, jobId, currentAssignees, onChanged }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [busyId, setBusyId] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMembers(currentAssignees);
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/admin/users?role=WORKER&approved=true");
        setWorkers(Array.isArray(list) ? list : []);
      } catch { setWorkers([]); }
    })();
  }, [open]);

  async function handleAdd(userIds: string[], role: string | null) {
    setAddBusy(true);
    try {
      for (const userId of userIds) {
        await apiPost(`/api/admin/jobs/${jobId}/default-assignees/add`, { userId, role });
        const worker = workers.find((w) => w.id === userId);
        if (worker) {
          setMembers((prev) => [...prev, { userId, role, user: { id: userId, displayName: worker.displayName, email: worker.email } }]);
        }
      }
      publishInlineMessage({ type: "SUCCESS", text: userIds.length === 1 ? "Worker added to default crew." : `${userIds.length} workers added.` });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add worker.", err) });
    } finally { setAddBusy(false); }
  }

  async function handleRemove(userId: string) {
    setBusyId(userId);
    try {
      await apiDelete(`/api/admin/jobs/${jobId}/default-assignees/${userId}`);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      publishInlineMessage({ type: "SUCCESS", text: "Worker removed from default crew." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove worker.", err) });
    } finally { setBusyId(""); }
  }

  async function handleToggleRole(userId: string, currentRole: string | null) {
    const newRole = currentRole === "observer" ? null : "observer";
    setBusyId(userId);
    try {
      await apiPatch(`/api/admin/jobs/${jobId}/default-assignees/${userId}/role`, { role: newRole });
      setMembers((prev) => prev.map((m) => m.userId === userId ? { ...m, role: newRole } : m));
      publishInlineMessage({ type: "SUCCESS", text: newRole === "observer" ? "Changed to observer." : "Changed to worker." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to change role.", err) });
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
              <Dialog.Title>Default Crew</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Box px={2} py={1.5} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                  <Text fontSize="2xs" color="yellow.700">
                    The default crew is automatically assigned to each new occurrence. One-time team changes on individual occurrences won't affect these defaults.
                  </Text>
                </Box>
                <TeamMemberList
                  members={members}
                  workers={workers}
                  busyId={busyId}
                  addBusy={addBusy}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onToggleRole={handleToggleRole}
                  showRoleControls
                  showMakeClaimer={false}
                  listTitle="Default crew"
                  addTitle="Add to default crew"
                  emptyText="No default crew set. Occurrences will be unassigned (claimable)."
                />
              </VStack>
            </Dialog.Body>
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
