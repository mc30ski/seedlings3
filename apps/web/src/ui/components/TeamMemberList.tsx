"use client";

import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  HStack,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";

export type TeamMember = {
  userId: string;
  assignedById?: string | null;
  role?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null };
};

type WorkerOption = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

export type TeamMemberListProps = {
  members: TeamMember[];
  workers: WorkerOption[];
  busyId: string;
  addBusy: boolean;

  // Callbacks
  onAdd: (userIds: string[], role: string | null) => void;
  onRemove: (userId: string) => void;
  onToggleRole?: (userId: string, currentRole: string | null) => void;
  onMakeClaimer?: (userId: string) => void;

  // Config
  showRoleControls?: boolean;
  showMakeClaimer?: boolean;
  /** When true, admins can remove the claimer (makes job claimable). Shows a confirmation. */
  allowRemoveClaimer?: boolean;

  // Optional: highlight "you" card
  myId?: string;
  onLeave?: () => void;

  // Labels
  listTitle?: string;
  addTitle?: string;
  emptyText?: string;
};

function getClaimerUserId(members: TeamMember[]): string | null {
  const nonObservers = members.filter((m) => m.role !== "observer");
  if (nonObservers.length === 0) return null;
  // If assignedById data exists, claimer is the one who assigned themselves
  const hasAssignedById = members.some((m) => m.assignedById);
  if (hasAssignedById) {
    const claimer = nonObservers.find((m) => m.assignedById === m.userId);
    return claimer?.userId ?? nonObservers[0].userId;
  }
  // Otherwise first non-observer is the claimer
  return nonObservers[0].userId;
}

export default function TeamMemberList({
  members,
  workers,
  busyId,
  addBusy,
  onAdd,
  onRemove,
  onToggleRole,
  onMakeClaimer,
  showRoleControls = true,
  showMakeClaimer = false,
  allowRemoveClaimer = false,
  myId,
  onLeave,
  listTitle = "Current team",
  addTitle = "Add to team",
  emptyText = "No one assigned yet.",
}: TeamMemberListProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [addAsObserver, setAddAsObserver] = useState(false);
  const [confirmRemoveClaimer, setConfirmRemoveClaimer] = useState<string | null>(null);

  const assignedIds = useMemo(() => members.map((m) => m.userId), [members]);
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

  const claimerId = getClaimerUserId(members);
  const hasWorkers = members.some((m) => m.role !== "observer");

  function handleAdd() {
    if (selected.length === 0) return;
    onAdd(selected, addAsObserver ? "observer" : null);
    setSelected([]);
  }

  // Separate "me" card from others
  const meAssignee = myId ? members.find((m) => m.userId === myId) : null;
  const otherMembers = myId ? members.filter((m) => m.userId !== myId) : members;

  function renderMemberCard(m: TeamMember, isMe: boolean) {
    const isObs = m.role === "observer";
    const isClaimer = !isObs && claimerId === m.userId;

    return (
      <Box
        key={m.userId}
        px={2}
        py={1.5}
        rounded="md"
        borderWidth="1px"
        borderColor={isObs ? "blue.200" : isClaimer ? "teal.200" : "gray.200"}
        bg={isObs ? "blue.50" : isClaimer ? "teal.50" : undefined}
      >
        <HStack justify="space-between" align="center">
          <VStack align="start" gap={0.5}>
            <Text
              fontSize="sm"
              fontWeight={isClaimer ? "medium" : "normal"}
              color={isObs ? "blue.700" : isClaimer ? "teal.700" : undefined}
            >
              {m.user?.displayName ?? m.user?.email ?? m.userId}
              {isMe && <Box as="span" fontWeight="normal" color="teal.500"> (you)</Box>}
            </Text>
            <HStack gap={1}>
              {isClaimer && <Badge size="sm" colorPalette="teal" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Claimer</Badge>}
              {isObs && <Badge size="sm" colorPalette="blue" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Observer</Badge>}
              {!isClaimer && !isObs && <Badge size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">Worker</Badge>}
            </HStack>
          </VStack>
          {isMe && !isClaimer && onLeave ? (
            <Button size="xs" variant="ghost" colorPalette="red" loading={busyId === m.userId} disabled={busyId !== ""} onClick={onLeave}>
              Leave
            </Button>
          ) : !isMe ? (
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              loading={busyId === m.userId}
              disabled={busyId !== "" || (isClaimer && !allowRemoveClaimer)}
              title={isClaimer && !allowRemoveClaimer ? "Make someone else the claimer first" : undefined}
              onClick={() => {
                if (isClaimer && allowRemoveClaimer) {
                  setConfirmRemoveClaimer(m.userId);
                } else {
                  onRemove(m.userId);
                }
              }}
            >
              Remove
            </Button>
          ) : null}
        </HStack>
        {showRoleControls && !isMe && (
          <HStack gap={1} mt={1}>
            {showMakeClaimer && !isClaimer && !isObs && onMakeClaimer && (
              <Button size="xs" variant="outline" colorPalette="teal" disabled={busyId !== ""} onClick={() => onMakeClaimer(m.userId)}>
                Make Claimer
              </Button>
            )}
            {!isClaimer && onToggleRole && (
              <Button
                size="xs"
                variant="outline"
                colorPalette={isObs ? "teal" : "blue"}
                disabled={busyId !== ""}
                onClick={() => onToggleRole(m.userId, m.role ?? null)}
              >
                {isObs ? "→ Worker" : "→ Observer"}
              </Button>
            )}
          </HStack>
        )}
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4}>
      {/* Member list */}
      <div>
        <Text fontWeight="medium" mb="2">{listTitle}</Text>
        {members.length === 0 && (
          <Text fontSize="sm" color="fg.muted">{emptyText}</Text>
        )}
        <VStack align="stretch" gap={1}>
          {meAssignee && renderMemberCard(meAssignee, true)}
          {otherMembers.map((m) => renderMemberCard(m, false))}
        </VStack>
      </div>

      {/* Add controls */}
      <div>
        <Text fontWeight="medium" mb="2">{addTitle}</Text>
        <HStack gap={2} mb={2}>
          <Button
            size="sm"
            variant={!addAsObserver ? "solid" : "outline"}
            colorPalette={!addAsObserver ? "teal" : "gray"}
            onClick={() => setAddAsObserver(false)}
          >
            {!hasWorkers ? "Worker (Claimer)" : "Worker"}
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
                      workers.length === 0 ? "Loading…"
                        : availableWorkers.length === 0 ? "All workers assigned"
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

      {/* Confirm remove claimer dialog */}
      {confirmRemoveClaimer && (
        <Box
          position="fixed"
          inset="0"
          zIndex={10000}
          bg="blackAlpha.600"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onClick={() => setConfirmRemoveClaimer(null)}
        >
          <Box
            bg="white"
            rounded="xl"
            p={5}
            mx={4}
            maxW="sm"
            w="full"
            shadow="lg"
            onClick={(e) => e.stopPropagation()}
          >
            <Text fontWeight="semibold" mb={2}>Remove Claimer?</Text>
            <Text fontSize="sm" color="fg.muted" mb={4}>
              Removing the claimer will make this job unassigned and claimable by any worker. Are you sure?
            </Text>
            <HStack justify="flex-end" gap={2}>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveClaimer(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                colorPalette="red"
                onClick={() => {
                  onRemove(confirmRemoveClaimer);
                  setConfirmRemoveClaimer(null);
                }}
              >
                Remove
              </Button>
            </HStack>
          </Box>
        </Box>
      )}
    </VStack>
  );
}
