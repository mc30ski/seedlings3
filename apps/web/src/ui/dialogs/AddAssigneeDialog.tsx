"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Portal,
} from "@chakra-ui/react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import TeamMemberList, { type TeamMember } from "@/src/ui/components/TeamMemberList";

type WorkerLite = { id: string; displayName?: string | null; email?: string | null };

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

export default function AddAssigneeDialog({ open, onOpenChange, occurrenceId, myId, currentAssignees, onChanged, isAdmin }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [busyId, setBusyId] = useState("");
  const [addBusy, setAddBusy] = useState(false);

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
    })();
  }, [open]);

  async function handleAdd(userIds: string[], role: string | null) {
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
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add team member.", err) });
    } finally { setAddBusy(false); }
  }

  async function handleRemove(userId: string) {
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
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove team member.", err) });
      }
    } finally { setBusyId(""); }
  }

  async function handleLeave() {
    await handleRemove(myId);
  }

  async function handleMakeClaimer(userId: string) {
    if (!isAdmin) return;
    setBusyId(userId);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/reassign-claimer`, { userId });
      setMembers((prev) => prev.map((m) => ({
        ...m,
        assignedById: m.userId === userId ? userId : (m.role === "observer" ? m.assignedById : userId),
        role: m.userId === userId && m.role === "observer" ? null : m.role,
      })));
      publishInlineMessage({ type: "SUCCESS", text: "Claimer reassigned." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reassign claimer.", err) });
    } finally { setBusyId(""); }
  }

  async function handleToggleRole(userId: string, currentRole: string | null) {
    if (!isAdmin) return;
    const newRole = currentRole === "observer" ? null : "observer";
    setBusyId(userId);
    try {
      await apiPatch(`/api/admin/occurrences/${occurrenceId}/assignees/${userId}/role`, { role: newRole ?? undefined });
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
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to change role.", err) });
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
              <TeamMemberList
                members={members}
                workers={workers}
                busyId={busyId}
                addBusy={addBusy}
                onAdd={handleAdd}
                onRemove={handleRemove}
                onToggleRole={isAdmin ? handleToggleRole : undefined}
                onMakeClaimer={isAdmin ? handleMakeClaimer : undefined}
                showRoleControls={!!isAdmin}
                showMakeClaimer={!!isAdmin}
                allowRemoveClaimer={!!isAdmin}
                myId={myId}
                onLeave={handleLeave}
              />
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
