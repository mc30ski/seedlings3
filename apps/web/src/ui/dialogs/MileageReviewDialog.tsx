"use client";

// Mileage Review dialog — mirrors the WorkdaysTab ReviewDialog
// pattern: opens per worker × date (or per single entry when called
// from the Vehicles tab), shows each session as a card with editable
// times / odometers / notes and its own Approve / Unapprove control.
//
// Persistence:
//   • Time / odometer / notes edits POST via PATCH /super/mileage/:id
//   • Approve / Unapprove hit their own endpoints
//   • Dialog stays open across mutations so the operator can review
//     multiple sessions in one flow; the caller reloads its own data
//     via onSaved() every time something changes.

import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CheckCircle2, RotateCcw, Trash2 } from "lucide-react";
import { apiPatch, apiPost } from "@/src/lib/api";
import { bizToLocalInputValue, bizParseLocalInputValue } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

export type MileageReviewEntry = {
  id: string;
  vehicleId: string;
  vehicleName?: string;
  startedAt: string;
  endedAt: string | null;
  startOdometer: number;
  endOdometer: number | null;
  miles: number | null;
  notes: string | null;
  approvedAt: string | null;
};

export default function MileageReviewDialog({
  driverLabel,
  entryDate,
  entries,
  onClose,
  onChanged,
}: {
  /** Human-readable driver label. Shown in the header. */
  driverLabel: string;
  /** ET calendar date this batch covers. Shown in the header. */
  entryDate: string;
  /** Sessions to render. When more than one, each is its own editable
   *  card. VehiclesTab passes a single-element array for per-entry
   *  review. */
  entries: MileageReviewEntry[];
  onClose: () => void;
  /** Called after any successful save / approve / unapprove so the
   *  caller can reload its own data. Dialog stays open. */
  onChanged: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>
                Review mileage — {driverLabel} · {entryDate}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {entries.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted">No mileage sessions for this date.</Text>
                ) : (
                  entries.map((e) => (
                    <EntryCard key={e.id} entry={e} onChanged={onChanged} />
                  ))
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose}>Close</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EntryCard({
  entry,
  onChanged,
}: {
  entry: MileageReviewEntry;
  onChanged: () => void;
}) {
  const [startedAt, setStartedAt] = useState(bizToLocalInputValue(entry.startedAt));
  const [endedAt, setEndedAt] = useState(
    entry.endedAt ? bizToLocalInputValue(entry.endedAt) : "",
  );
  const [startOdometer, setStartOdometer] = useState(String(entry.startOdometer));
  const [endOdometer, setEndOdometer] = useState(
    entry.endOdometer != null ? String(entry.endOdometer) : "",
  );
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [busy, setBusy] = useState(false);

  const dirty = useMemo(() => {
    if (bizToLocalInputValue(entry.startedAt) !== startedAt) return true;
    if ((entry.endedAt ? bizToLocalInputValue(entry.endedAt) : "") !== endedAt) return true;
    if (String(entry.startOdometer) !== startOdometer) return true;
    if ((entry.endOdometer != null ? String(entry.endOdometer) : "") !== endOdometer) return true;
    if ((entry.notes ?? "") !== notes) return true;
    return false;
  }, [entry, startedAt, endedAt, startOdometer, endOdometer, notes]);

  const startNum = Number(startOdometer);
  const endNum = endOdometer === "" ? null : Number(endOdometer);
  const odometerValid =
    /^\d+$/.test(startOdometer.trim()) &&
    (endOdometer === "" || (/^\d+$/.test(endOdometer.trim()) && endNum! >= startNum));
  const liveMiles =
    odometerValid && endNum != null ? endNum - startNum : entry.miles;

  const isOpen = entry.endedAt == null && !endedAt;
  const isApproved = !!entry.approvedAt;

  async function save() {
    if (!dirty || !odometerValid) return;
    setBusy(true);
    try {
      await apiPatch(`/api/super/mileage/${entry.id}`, {
        startedAt: bizParseLocalInputValue(startedAt) || null,
        endedAt: endedAt ? bizParseLocalInputValue(endedAt) : null,
        startOdometer: startNum,
        endOdometer: endNum,
        notes: notes.trim() || null,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Entry updated." });
      onChanged();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Save failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      await apiPost(`/api/super/mileage/${entry.id}/approve`);
      publishInlineMessage({ type: "SUCCESS", text: "Entry approved." });
      onChanged();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function unapprove() {
    setBusy(true);
    try {
      await apiPost(`/api/super/mileage/${entry.id}/unapprove`);
      publishInlineMessage({ type: "SUCCESS", text: "Approval removed." });
      onChanged();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unapprove failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    // Destructive — confirm before hard-deleting the row. The server
    // refuses to reject already-approved entries, so this button is
    // hidden for those (unapprove first).
    if (!window.confirm(
      `Reject and delete this ${entry.vehicleName ?? "mileage"} session? This can't be undone.`,
    )) return;
    setBusy(true);
    try {
      await apiPost(`/api/super/mileage/${entry.id}/reject`);
      publishInlineMessage({ type: "SUCCESS", text: "Entry rejected." });
      onChanged();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Reject failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      borderWidth="1px"
      borderColor={
        isApproved ? "green.200" : isOpen ? "teal.200" : "orange.200"
      }
      bg={isApproved ? "green.50" : isOpen ? "teal.50" : "orange.50"}
      borderRadius="md"
      p={3}
    >
      <VStack align="stretch" gap={2}>
        <HStack justify="space-between" wrap="wrap" gap={2}>
          <Text fontSize="sm" fontWeight="semibold">
            {entry.vehicleName ?? "Vehicle"}
          </Text>
          <Badge
            colorPalette={isApproved ? "green" : isOpen ? "teal" : "orange"}
            fontSize="2xs"
          >
            {isApproved ? "Approved" : isOpen ? "Open" : "Pending"}
          </Badge>
        </HStack>
        <HStack gap={2} wrap="wrap">
          <Field label="Started">
            <Input
              type="datetime-local"
              size="sm"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
            />
          </Field>
          <Field label="Ended">
            <Input
              type="datetime-local"
              size="sm"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              placeholder="(open)"
            />
          </Field>
        </HStack>
        <HStack gap={2} wrap="wrap">
          <Field label="Start odometer">
            <Input
              size="sm"
              inputMode="numeric"
              value={startOdometer}
              onChange={(e) => setStartOdometer(e.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="End odometer">
            <Input
              size="sm"
              inputMode="numeric"
              value={endOdometer}
              onChange={(e) => setEndOdometer(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="(open)"
            />
          </Field>
          <Field label="Miles">
            <Input
              size="sm"
              value={liveMiles != null ? String(liveMiles) : "—"}
              readOnly
              bg="gray.100"
            />
          </Field>
        </HStack>
        <Field label="Note">
          <Input
            size="sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Using vehicle to service lawns"
          />
        </Field>
        <HStack gap={2} justify="flex-end" mt={1} wrap="wrap">
          {/* Reject — hard-delete the row. Only shown for un-approved
              entries (open OR pending); already-approved rows must be
              Unapproved first so we don't silently erase an approval
              record. Confirms before delete. Ghost-red so it's
              recoverable-looking but not accidentally-tap prominent. */}
          {!isApproved && (
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              onClick={reject}
              loading={busy}
              title="Reject and delete this session — for wrong-vehicle rows, tester noise, etc."
            >
              <Trash2 size={12} /> <Text ml={1}>Reject</Text>
            </Button>
          )}
          {/* Unapprove — only shown for already-approved entries.
              Mirrors the workday ReviewDialog's ghost-red button in
              the same slot. */}
          {isApproved && (
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              onClick={unapprove}
              loading={busy}
            >
              <RotateCcw size={12} /> <Text ml={1}>Unapprove</Text>
            </Button>
          )}
          {dirty && (
            <Button
              size="xs"
              variant="outline"
              colorPalette="blue"
              onClick={save}
              loading={busy}
              disabled={!odometerValid}
            >
              Save changes
            </Button>
          )}
          {/* Primary action — Approve for pending, Re-approve for
              already-approved rows (same behavior workday hours has
              in ReviewDialog). Disabled while the entry is still
              open or has unsaved edits. */}
          {!isOpen && (
            <Button
              size="xs"
              colorPalette="green"
              onClick={approve}
              loading={busy}
              disabled={dirty}
              title={dirty ? "Save changes before approving" : undefined}
            >
              <CheckCircle2 size={12} />
              <Text ml={1}>{isApproved ? "Re-approve" : "Approve"}</Text>
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box flex="1" minW="120px">
      <Text fontSize="2xs" color="fg.muted" mb={0.5}>{label}</Text>
      {children}
    </Box>
  );
}
