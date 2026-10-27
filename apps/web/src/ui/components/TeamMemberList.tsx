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
import { isPaid, type WorkerType } from "@repo/money";
import { assigneeIsClaimer } from "@/src/ui/tabs/JobsTab.utils";

export type TeamMember = {
  userId: string;
  assignedById?: string | null;
  role?: string | null;
  user: {
    id: string;
    displayName?: string | null;
    email?: string | null;
    /** Undefined when the caller did not load it — see `paidSeatState`. */
    workerType?: WorkerType | null;
  };
};

type WorkerOption = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  workerType?: WorkerType | null;
};

/**
 * May this person hold a PAID seat — i.e. be a worker rather than an observer?
 *
 * A non-observer assignee is someone the money system will try to pay, so
 * they have to be on payroll. An UNPAID helper or anyone whose worker type is
 * not set yet can only observe. The server enforces this in
 * `enforceAssigneeInvariants` (G33) and refuses the promotion outright; this
 * is so the UI never offers a control that the API would reject.
 *
 * THREE states, not two. `undefined` means the caller did not load the worker
 * type, and that must read as "unknown", never as "not on payroll" — guessing
 * the restrictive way would grey out the control for a whole team because
 * somebody forgot to pass a field.
 */
type PaidSeatState = "eligible" | "observer-only" | "unknown";
function paidSeatState(wt: WorkerType | null | undefined): PaidSeatState {
  if (wt === undefined) return "unknown";
  return isPaid(wt) ? "eligible" : "observer-only";
}
const OBSERVER_ONLY_WHY =
  "Not on payroll — can only be added as an observer. Set a worker type to " +
  "assign them to paid work.";

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
  /** When true, holders of `schedule.manage` can remove the claimer (makes job claimable). Shows a confirmation. */
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

  const hasAssignedById = members.some((m) => m.assignedById);
  if (hasAssignedById) {
    // NO FALLBACK. The caller passed the signal, so trust it: when nobody
    // self-assigned there IS no claimer, and this says so.
    //
    // It used to return `?? nonObservers[0]`, which badged whoever happened
    // to sort first as "Claimer". On a visit with workers and no claimer the
    // dialog therefore told the operator they were the claimer, while the
    // card beside it named someone else and `updateOccurrenceStatus` would
    // refuse Start with NOT_CLAIMER for anyone without `schedule.manage`.
    // The guess concealed the one state worth surfacing.
    return nonObservers.find((m) => assigneeIsClaimer(m))?.userId ?? null;
  }
  // No row carries `assignedById` at all — this caller did not load the
  // signal, so nothing can be concluded either way. Keep the long-standing
  // first-worker guess rather than claiming those teams are unclaimed.
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
    () =>
      availableWorkers.map((w) => ({
        label:
          paidSeatState(w.workerType) === "observer-only"
            ? `${w.displayName ?? w.email ?? w.id} — observer only`
            : (w.displayName ?? w.email ?? w.id),
        value: w.id,
      })),
    [availableWorkers]
  );
  /** Any selected person who cannot hold a paid seat forces the whole add to
   *  be an observer add — the API would refuse the paid one anyway, and a
   *  partial success on a multi-select is worse than one clear rule. */
  const selectionObserverOnly = useMemo(
    () =>
      selected.some(
        (id) =>
          paidSeatState(availableWorkers.find((w) => w.id === id)?.workerType) ===
          "observer-only",
      ),
    [selected, availableWorkers]
  );
  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  const claimerId = getClaimerUserId(members);
  const hasWorkers = members.some((m) => m.role !== "observer");

  function handleAdd() {
    if (selected.length === 0) return;
    // `selectionObserverOnly` wins over the toggle. The toggle is only
    // disabled visually; relying on that alone would let a stale `true` in
    // `addAsObserver` send a paid add the API then refuses.
    onAdd(selected, addAsObserver || selectionObserverOnly ? "observer" : null);
    setSelected([]);
  }

  // Separate "me" card from others
  const meAssignee = myId ? members.find((m) => m.userId === myId) : null;
  const otherMembers = myId ? members.filter((m) => m.userId !== myId) : members;

  function renderMemberCard(m: TeamMember, isMe: boolean) {
    const isObs = m.role === "observer";
    const isClaimerRow = !isObs && claimerId === m.userId;
    const seat = paidSeatState(m.user?.workerType);
    const observerOnly = seat === "observer-only";

    return (
      <Box
        key={m.userId}
        px={2}
        py={1.5}
        rounded="md"
        borderWidth="1px"
        borderColor={isObs ? "blue.emphasized" : isClaimerRow ? "teal.emphasized" : "gray.emphasized"}
        bg={isObs ? "blue.faint" : isClaimerRow ? "teal.faint" : undefined}
      >
        <HStack justify="space-between" align="center">
          <VStack align="start" gap={0.5}>
            <Text
              fontSize="sm"
              fontWeight={isClaimerRow ? "medium" : "normal"}
              color={isObs ? "blue.fg" : isClaimerRow ? "teal.fg" : undefined}
            >
              {m.user?.displayName ?? m.user?.email ?? m.userId}
              {isMe && <Box as="span" fontWeight="normal" color="teal.fg"> (you)</Box>}
            </Text>
            <HStack gap={1}>
              {isClaimerRow && <Badge size="sm" colorPalette="teal" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Claimer</Badge>}
              {isObs && <Badge size="sm" colorPalette="blue" variant="solid" fontSize="2xs" px="1.5" borderRadius="full">Observer</Badge>}
              {!isClaimerRow && !isObs && <Badge size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">Worker</Badge>}
              {isObs && observerOnly && (
                <Badge size="sm" colorPalette="purple" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full">
                  Not on payroll
                </Badge>
              )}
            </HStack>
          </VStack>
          {isMe && !isClaimerRow && onLeave ? (
            <Button size="xs" variant="ghost" colorPalette="red" loading={busyId === m.userId} disabled={busyId !== ""} onClick={onLeave}>
              Leave
            </Button>
          ) : !isMe ? (
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              loading={busyId === m.userId}
              disabled={busyId !== "" || (isClaimerRow && !allowRemoveClaimer)}
              title={isClaimerRow && !allowRemoveClaimer ? "Make someone else the claimer first" : undefined}
              onClick={() => {
                if (isClaimerRow && allowRemoveClaimer) {
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
            {showMakeClaimer && !isClaimerRow && !isObs && !observerOnly && onMakeClaimer && (
              <Button size="xs" variant="outline" colorPalette="teal" disabled={busyId !== ""} onClick={() => onMakeClaimer(m.userId)}>
                Make Claimer
              </Button>
            )}
            {!isClaimerRow && onToggleRole && (
              <Button
                size="xs"
                variant="outline"
                colorPalette={isObs ? "teal" : "blue"}
                // Promoting to worker is refused by the API for someone off
                // payroll, so the button is disabled rather than offered and
                // then rejected. Demoting TO observer stays available.
                disabled={busyId !== "" || (isObs && observerOnly)}
                title={isObs && observerOnly ? OBSERVER_ONLY_WHY : undefined}
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
            variant={!addAsObserver && !selectionObserverOnly ? "solid" : "outline"}
            colorPalette={!addAsObserver && !selectionObserverOnly ? "teal" : "gray"}
            disabled={selectionObserverOnly}
            title={selectionObserverOnly ? OBSERVER_ONLY_WHY : undefined}
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
          {selectionObserverOnly
            ? OBSERVER_ONLY_WHY
            : addAsObserver
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
            bg="bg.panel"
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
