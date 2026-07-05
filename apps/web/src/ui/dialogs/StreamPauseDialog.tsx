"use client";

// Dialog for the three occurrence-level stream operations: pause,
// update-pause (extend), and resume. Same component handles all three
// so the field layout stays consistent (reason + reminder date live in
// one place regardless of which action the operator picked).
//
// The parent decides which mode to open and passes callbacks + current
// values (for update) or a default new-start-date (for resume).

import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";

export type StreamPauseDialogMode = "pause" | "update" | "resume";

type Props =
  | {
      open: boolean;
      mode: "pause";
      /** Name/label to show in the title (e.g. "hedge visit on 2026-08-10"). */
      occurrenceLabel: string;
      onCancel: () => void;
      onConfirm: (input: {
        reason: string | null;
        reminderAt: string | null; // YYYY-MM-DD or null
      }) => void | Promise<void>;
      busy?: boolean;
    }
  | {
      open: boolean;
      mode: "update";
      occurrenceLabel: string;
      currentReason: string | null;
      currentReminderAt: string | null; // YYYY-MM-DD or null
      onCancel: () => void;
      onConfirm: (input: {
        reason: string | null;
        reminderAt: string | null;
      }) => void | Promise<void>;
      busy?: boolean;
    }
  | {
      open: boolean;
      mode: "resume";
      occurrenceLabel: string;
      defaultNewStartAt: string; // YYYY-MM-DD, prefilled by parent
      onCancel: () => void;
      onConfirm: (input: { newStartAt: string }) => void | Promise<void>;
      busy?: boolean;
    };

export default function StreamPauseDialog(props: Props) {
  const initialReason =
    props.mode === "update" ? props.currentReason ?? "" : "";
  const initialReminder =
    props.mode === "update" ? props.currentReminderAt ?? "" : "";
  const initialStart =
    props.mode === "resume" ? props.defaultNewStartAt : "";

  const [reason, setReason] = useState(initialReason);
  const [reminderAt, setReminderAt] = useState(initialReminder);
  const [newStartAt, setNewStartAt] = useState(initialStart);

  const title =
    props.mode === "pause"
      ? "Pause this repeating service?"
      : props.mode === "update"
        ? "Extend the pause"
        : "Resume this repeating service?";

  const description =
    props.mode === "pause"
      ? `This pauses just the ${props.occurrenceLabel} repeating on this Job. Other repeating services on the same Job (e.g. mowing while you pause hedging) keep running. The Client and Job stay Active.`
      : props.mode === "update"
        ? "Update the reason and/or reminder date without changing anything else."
        : `Choose a fresh date for the ${props.occurrenceLabel} to restart. Its repeating schedule will resume from that visit forward.`;

  const canConfirm =
    props.mode === "resume" ? !!newStartAt : true;

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(e) => { if (!e.open && !props.busy) props.onCancel(); }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">{description}</Text>

                {(props.mode === "pause" || props.mode === "update") && (
                  <>
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>
                        Reason (optional)
                      </Text>
                      <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. hedging trimmed early, resume in fall"
                        rows={3}
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>
                        Reminder date (optional)
                      </Text>
                      <Input
                        type="date"
                        value={reminderAt}
                        onChange={(e) => setReminderAt(e.target.value)}
                      />
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Shows up as an alert on the Tasks page when the date arrives.
                      </Text>
                    </Box>
                  </>
                )}

                {props.mode === "resume" && (
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>
                      New start date
                    </Text>
                    <Input
                      type="date"
                      value={newStartAt}
                      onChange={(e) => setNewStartAt(e.target.value)}
                    />
                    <Text fontSize="2xs" color="fg.muted" mt={1}>
                      Default is roughly one cadence from today, but you can pick any date.
                    </Text>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2}>
                <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
                  Cancel
                </Button>
                <Button
                  colorPalette={
                    props.mode === "resume" ? "green" : "purple"
                  }
                  onClick={async () => {
                    if (props.mode === "resume") {
                      await props.onConfirm({ newStartAt });
                    } else {
                      await props.onConfirm({
                        reason: reason.trim() || null,
                        reminderAt: reminderAt || null,
                      });
                    }
                  }}
                  loading={props.busy}
                  disabled={!canConfirm}
                >
                  {props.mode === "pause"
                    ? "Pause repeating"
                    : props.mode === "update"
                      ? "Save changes"
                      : "Resume repeating"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
