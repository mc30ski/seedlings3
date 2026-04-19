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
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

type WorkerLite = { id: string; displayName?: string | null; email?: string | null };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentAssignees: JobOccurrenceAssigneeWithUser[];
  hasPayment?: boolean;
  onChanged?: () => void;
};

export default function AssigneeDialog({ open, onOpenChange, occurrenceId, currentAssignees, hasPayment, onChanged }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [busyId, setBusyId] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [assigneesChanged, setAssigneesChanged] = useState(false);
  const [showRecalcPrompt, setShowRecalcPrompt] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMembers(currentAssignees.map((a) => ({
      userId: a.userId,
      assignedById: a.assignedById,
      role: a.role,
      user: a.user,
    })));
    setAssigneesChanged(false);
    setShowRecalcPrompt(false);
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
        const result = await apiPost<{ added: boolean }>(`/api/admin/occurrences/${occurrenceId}/add-assignee`, { userId, role });
        if (result.added) {
          const worker = workers.find((w) => w.id === userId);
          if (worker) {
            const isClaimer = members.length === 0 && userIds[0] === userId;
            const claimerId = members.find((m) => m.assignedById === m.userId)?.userId ?? userId;
            setMembers((prev) => [...prev, {
              userId,
              assignedById: isClaimer ? userId : claimerId,
              role,
              user: { id: userId, displayName: worker.displayName, email: worker.email },
            }]);
          }
        }
      }
      setAssigneesChanged(true);
      publishInlineMessage({ type: "SUCCESS", text: userIds.length === 1 ? "Worker assigned." : `${userIds.length} workers assigned.` });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to assign worker.", err) });
    } finally { setAddBusy(false); }
  }

  async function handleRemove(userId: string) {
    setBusyId(userId);
    try {
      await apiDelete(`/api/admin/occurrences/${occurrenceId}/assignees/${userId}`);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      setAssigneesChanged(true);
      publishInlineMessage({ type: "SUCCESS", text: "Worker removed." });
      onChanged?.();
    } catch (err: any) {
      if (err?.code === "CLAIMER_CANNOT_BE_REMOVED") {
        publishInlineMessage({ type: "WARNING", text: "Reassign the claimer role to someone else before removing this person." });
      } else {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove worker.", err) });
      }
    } finally { setBusyId(""); }
  }

  async function handleMakeClaimer(userId: string) {
    setBusyId(userId);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/reassign-claimer`, { userId });
      setMembers((prev) => prev.map((m) => ({
        ...m,
        assignedById: m.userId === userId ? userId : (m.role === "observer" ? m.assignedById : userId),
        role: m.userId === userId && m.role === "observer" ? null : m.role,
      })));
      setAssigneesChanged(true);
      publishInlineMessage({ type: "SUCCESS", text: "Claimer reassigned." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reassign claimer.", err) });
    } finally { setBusyId(""); }
  }

  async function handleToggleRole(userId: string, currentRole: string | null) {
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
      setAssigneesChanged(true);
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
              <Dialog.Title>Assign Workers</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
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
                allowRemoveClaimer
                listTitle="Assigned workers"
                emptyText="No one assigned yet."
              />
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
                    <Text fontSize="sm" fontWeight="medium" color="orange.700" mb={1}>Recalculate payment splits?</Text>
                    <Text fontSize="xs" color="orange.600">
                      This will evenly split the payment amount across the current team. Warning: if financial records have already been acted on (e.g. cash paid out), the previous records may no longer be accurate.
                    </Text>
                  </Box>
                  <HStack justify="flex-end" gap={2}>
                    <Button size="sm" variant="ghost" onClick={() => { setShowRecalcPrompt(false); onOpenChange(false); }}>Skip</Button>
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
                        } finally { setRecalcBusy(false); }
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
                  disabled={addBusy || busyId !== "" || recalcBusy}
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
