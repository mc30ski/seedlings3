"use client";

import { useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";

function addDays(isoDate: string | null | undefined, days: number): string {
  if (!isoDate) return "";
  // Parse as local date to avoid timezone shifts
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

type ClosedOccurrence = {
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;
  assignees?: { userId: string; displayName?: string | null }[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  frequencyDays: number;
  closedOccurrence: ClosedOccurrence;
  /** For admin: `/api/admin/jobs/${jobId}/occurrences`; for worker: `/api/occurrences/create-next` */
  createEndpoint: string;
  /** Extra body fields for the create call (e.g. { jobId } for worker endpoint) */
  createBody?: Record<string, unknown>;
  onCreated?: (nextStartDate: string) => void;
  onSkipped?: () => void;
};

export default function ScheduleNextDialog({
  open,
  onOpenChange,
  jobId,
  frequencyDays,
  closedOccurrence,
  createEndpoint,
  createBody,
  onCreated,
  onSkipped,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  const nextStartAt = addDays(closedOccurrence.startAt, frequencyDays);
  const nextEndAt = closedOccurrence.endAt
    ? addDays(closedOccurrence.endAt, frequencyDays)
    : nextStartAt;

  function handleClose() {
    setShowForm(false);
    setShowSkipConfirm(false);
    onOpenChange(false);
  }

  function handleSkipRequest() {
    setShowSkipConfirm(true);
  }

  function handleSkipConfirm() {
    handleClose();
    onSkipped?.();
  }

  if (showForm) {
    return (
      <OccurrenceDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            // User closed the occurrence form — go back to prompt with skip confirmation
            setShowForm(false);
            setShowSkipConfirm(true);
            return;
          }
          onOpenChange(o);
        }}
        mode="CREATE"
        jobId={jobId}
        title="Schedule Next Occurrence"
        submitLabel="Schedule"
        createEndpoint={createEndpoint}
        createBody={createBody}
        defaultStartAt={nextStartAt ? nextStartAt + "T00:00:00" : null}
        defaultEndAt={nextEndAt ? nextEndAt + "T00:00:00" : null}
        defaultNotes={closedOccurrence.notes}
        defaultPrice={closedOccurrence.price}
        defaultEstimatedMinutes={closedOccurrence.estimatedMinutes}
        defaultAssignees={closedOccurrence.assignees}
        onSaved={() => {
          handleClose();
          onCreated?.(nextStartAt);
        }}
      />
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) handleSkipRequest();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Schedule Next Occurrence?</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {!showSkipConfirm ? (
                <VStack align="stretch" gap={3}>
                  <Text>
                    This job recurs every <strong>{frequencyDays} day{frequencyDays !== 1 ? "s" : ""}</strong>.
                    Would you like to schedule the next occurrence?
                  </Text>
                  {nextStartAt && (
                    <Text fontSize="sm" color="fg.muted">
                      Next date: {new Date(nextStartAt + "T00:00:00").toLocaleDateString()}
                    </Text>
                  )}
                </VStack>
              ) : (
                <Text>
                  Are you sure you want to skip? The next occurrence won't be automatically scheduled.
                </Text>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              {!showSkipConfirm ? (
                <HStack justify="flex-end" w="full" gap={2}>
                  <Button variant="ghost" onClick={handleSkipRequest}>
                    Skip
                  </Button>
                  <Button onClick={() => setShowForm(true)}>
                    Schedule
                  </Button>
                </HStack>
              ) : (
                <HStack justify="flex-end" w="full" gap={2}>
                  <Button variant="ghost" onClick={() => setShowSkipConfirm(false)}>
                    Go Back
                  </Button>
                  <Button colorPalette="red" onClick={handleSkipConfirm}>
                    Yes, Skip
                  </Button>
                </HStack>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
