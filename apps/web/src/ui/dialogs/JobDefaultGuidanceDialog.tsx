"use client";

import { useEffect, useState } from "react";
import { Box, Button, Dialog, Portal, Text, Textarea, VStack } from "@chakra-ui/react";
import { apiPatch, apiPut } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import JobPropertyPhotosPicker from "@/src/ui/components/JobPropertyPhotosPicker";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  propertyId: string;
  /** Current job-level default guidance description. */
  guidanceNote: string | null;
  onSaved?: () => void;
};

/**
 * Edits a job service's DEFAULT guidance — the description + property photos
 * that seed every new occurrence of the job. The per-occurrence equivalent is
 * the "Manage Guidance" dialog (OccurrenceInstructions). The photo picker
 * itself surfaces the "no property photos" message when the property has none.
 */
export default function JobDefaultGuidanceDialog({ open, onOpenChange, jobId, propertyId, guidanceNote, onSaved }: Props) {
  const [note, setNote] = useState(guidanceNote ?? "");
  const [photoIds, setPhotoIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const dlgErr = useDialogError();

  useEffect(() => {
    if (open) {
      setNote(guidanceNote ?? "");
      setPhotoIds(null);
    }
  }, [open, guidanceNote]);

  async function save() {
    dlgErr.clear();
    setSaving(true);
    try {
      await apiPatch(`/api/admin/jobs/${jobId}`, { guidanceNote: note.trim() || null });
      if (photoIds !== null) {
        await apiPut(`/api/admin/jobs/${jobId}/property-photos`, { propertyPhotoIds: photoIds });
      }
      publishInlineMessage({ type: "SUCCESS", text: "Default guidance updated." });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Save failed.", err));
    }
    setSaving(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg" maxH="80vh" overflowY="auto">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Default Guidance</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="xs" color="fg.muted">
                  This default guidance seeds every new occurrence of this job. Each occurrence
                  can then adjust or remove it individually.
                </Text>
                <Box>
                  <Text fontSize="xs" fontWeight="semibold" color="blue.700" mb={1}>Overall description</Text>
                  <Textarea
                    size="sm"
                    rows={3}
                    placeholder="Optional — describe the work overall (separate from the photos)."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Box>
                <JobPropertyPhotosPicker jobId={jobId} propertyId={propertyId} onSelectionChange={setPhotoIds} />
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button colorPalette="blue" loading={saving} onClick={() => void save()}>Save</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
