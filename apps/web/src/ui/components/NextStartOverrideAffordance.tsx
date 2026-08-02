// One-time "shift the next repeating visit" affordance on an occurrence
// card. Rendered inline on the card whenever:
//   • Parent job is repeating (frequencyDays set).
//   • Current occurrence is client-confirmed.
//   • Payment has not yet been confirmed (once confirmed, the next
//     occurrence has been generated and the override window is closed).
//
// When set, shows a chip: `Next visit: Aug 7 (usually Aug 8)`. When not
// set, shows a small link: `Shift next visit date`. Clicking either
// opens a small editor dialog with:
//   • Date input (pre-filled with current override, or blank)
//   • Helper: "Usually the next visit lands on Fri, Aug 8"
//   • Save / Clear / Cancel
//
// Range rules mirror the server:
//   • Date must be strictly AFTER this visit's date (client-side check
//     disables Save; server enforces).
//   • Date > 7 days from the usual visit date OR colliding with an
//     existing same-day visit → server responds needsApprove=true;
//     UI opens a ConfirmDialog with typed APPROVE gate; on confirm,
//     retries with forceApprove=true.

"use client";
import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CalendarClock, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { bizAddDays, bizDateKey, fmtDate, fmtDateKey } from "@/src/lib/lib";

type Props = {
  occurrenceId: string;
  /** Source occurrence's startAt (ISO). Used to compute the usual
   *  next-visit date + enforce the "strictly after" rule. */
  sourceStartAt: string;
  /** Effective frequency in days — either the occurrence-level override
   *  or the parent job's. Falsy means "not repeating" and the
   *  affordance is hidden. */
  frequencyDays: number | null | undefined;
  /** Current stored override (YYYY-MM-DD), or null when none. */
  nextStartOverride: string | null;
  /** Called after a successful save so the parent can refresh state. */
  onUpdated: (newValue: string | null) => void;
};

export default function NextStartOverrideAffordance({
  occurrenceId,
  sourceStartAt,
  frequencyDays,
  nextStartOverride,
  onUpdated,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(nextStartOverride ?? "");
  const [saving, setSaving] = useState(false);

  // Approve-gated retry state — populated when the server responds
  // needsApprove; consumed by the ConfirmDialog below.
  const [approveReq, setApproveReq] = useState<
    | null
    | {
        date: string;
        reasons: string[];
        normalCadenceDate: string;
        collidingOccurrenceId: string | null;
      }
  >(null);

  // Cached derivations — usual cadence date, source ET-day key.
  const sourceKey = useMemo(() => bizDateKey(sourceStartAt), [sourceStartAt]);
  const usualKey = useMemo(
    () => (frequencyDays ? bizAddDays(sourceKey, frequencyDays) : ""),
    [sourceKey, frequencyDays],
  );

  if (!frequencyDays || frequencyDays <= 0) return null;

  const hasOverride = !!nextStartOverride;
  // When the operator taps the chip, seed the draft with the current
  // override — OR the usual cadence date if none. Both help them see
  // what "no change" would look like.
  function openEditor() {
    setDraft(nextStartOverride ?? usualKey);
    setEditing(true);
  }

  async function save(force: boolean) {
    if (!draft || !/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
      publishInlineMessage({ type: "ERROR", text: "Pick a valid date first." });
      return;
    }
    if (draft <= sourceKey) {
      publishInlineMessage({
        type: "ERROR",
        text: `The next visit date must be after this visit's date (${fmtDate(sourceStartAt)}).`,
      });
      return;
    }
    setSaving(true);
    try {
      const result: any = await apiPost(
        `/api/admin/occurrences/${occurrenceId}/next-start-override`,
        { date: draft, forceApprove: force },
      );
      if (result?.needsApprove) {
        // Kick over to the APPROVE flow. The dialog captures typed
        // confirmation, then re-issues save(true).
        setApproveReq({
          date: draft,
          reasons: Array.isArray(result.reasons) ? result.reasons : [],
          normalCadenceDate: result.normalCadenceDate ?? usualKey,
          collidingOccurrenceId: result.collidingOccurrenceId ?? null,
        });
        return;
      }
      publishInlineMessage({
        type: "SUCCESS",
        text: `Next visit will be scheduled for ${fmtDateKey(draft)}. This takes effect when payment for this visit is approved.`,
      });
      onUpdated(result?.nextStartOverride ?? draft);
      setEditing(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to save the override.", err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/next-start-override`, {
        date: null,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: "Cleared the one-time next-visit override.",
      });
      onUpdated(null);
      setEditing(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to clear the override.", err),
      });
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    !!draft &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft) &&
    draft > sourceKey &&
    draft !== (nextStartOverride ?? "");

  return (
    <>
      {/* Inline surface on the card. Either a chip (override set) or a
          small ghost link (no override). Compact enough to slot
          alongside the existing action row without dominating it. */}
      {hasOverride ? (
        <HStack
          gap={1}
          px={2}
          py={1}
          borderRadius="md"
          bg="purple.50"
          borderWidth="1px"
          borderColor="purple.200"
          cursor="pointer"
          onClick={openEditor}
          title={`Usually the next visit would be ${fmtDateKey(usualKey)}. This one is shifted.`}
        >
          <CalendarClock size={12} color="var(--chakra-colors-purple-700)" />
          <Text fontSize="xs" fontWeight="medium" color="purple.900">
            Next: {fmtDateKey(nextStartOverride!)}
          </Text>
          <Text fontSize="2xs" color="purple.700">
            (usually {fmtDateKey(usualKey)})
          </Text>
        </HStack>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          colorPalette="purple"
          onClick={openEditor}
        >
          <CalendarClock size={12} />
          <Text as="span" ml={1}>Shift next visit date</Text>
        </Button>
      )}

      {/* Editor dialog — date picker + Save / Clear / Cancel. */}
      <Dialog.Root open={editing} onOpenChange={(e) => !e.open && setEditing(false)}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Shift the next visit</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    This changes ONLY the next visit for this job. All later
                    visits stay on the normal cadence.
                  </Text>
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>
                      New date for the next visit
                    </Text>
                    <DateInput value={draft} onChange={setDraft} />
                    <Text fontSize="2xs" color="fg.muted" mt={1}>
                      Usually the next visit lands on{" "}
                      <Text as="span" fontWeight="semibold">{fmtDateKey(usualKey)}</Text>
                      {" — "}
                      {frequencyDays} days after this visit.
                    </Text>
                    {draft && draft <= sourceKey && (
                      <Text fontSize="2xs" color="red.600" mt={1}>
                        Must be after this visit's date ({fmtDate(sourceStartAt)}).
                      </Text>
                    )}
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="space-between" w="full">
                  {hasOverride ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      colorPalette="red"
                      loading={saving}
                      onClick={() => void clear()}
                    >
                      <X size={12} /> Clear override
                    </Button>
                  ) : (
                    <Box />
                  )}
                  <HStack gap={2}>
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button
                      colorPalette="purple"
                      disabled={!canSave}
                      loading={saving}
                      onClick={() => void save(false)}
                    >
                      Save
                    </Button>
                  </HStack>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* APPROVE-gated confirmation when the date is out of the "silent
          save" window (>7 days from usual OR collides with an existing
          same-day visit). Server rejected the silent path; UI collects
          typed APPROVE, then retries with forceApprove=true. */}
      {approveReq && (
        <ConfirmDialog
          open={!!approveReq}
          title="Confirm off-cycle next visit"
          message={`You're scheduling the next visit for ${fmtDateKey(approveReq.date)}.`}
          messageNode={
            <VStack align="stretch" gap={2}>
              <Text fontSize="sm">
                You're scheduling the next visit for{" "}
                <Text as="span" fontWeight="semibold">{fmtDateKey(approveReq.date)}</Text>.
              </Text>
              <VStack align="stretch" gap={1} pl={3}>
                {approveReq.reasons.map((r, i) => (
                  <Text key={i} fontSize="xs" color="orange.700">• {r}</Text>
                ))}
              </VStack>
            </VStack>
          }
          confirmLabel="Save with override"
          confirmColorPalette="orange"
          requiredInputValue="APPROVE"
          onConfirm={() => {
            const d = approveReq.date;
            setApproveReq(null);
            setDraft(d);
            void save(true);
          }}
          onCancel={() => setApproveReq(null)}
        />
      )}
    </>
  );
}
