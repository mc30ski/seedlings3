"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import { jobTagLabel as _jobTagLabel, pricingJobTags, type ServiceTypeConfig } from "@/src/ui/components/JobTagPicker";
import PricingGuideDialog from "@/src/ui/dialogs/PricingGuideDialog";

type Props = {
  /** Occurrence we're adding an add-on to; null = dialog closed. */
  occurrenceId: string | null;
  onClose: () => void;
  /** Service-type config from settings (drives the tag chip list + labels). */
  serviceTypes: ServiceTypeConfig[];
  /** Admin view → uses /api/admin/occurrences/:id/addons; worker view →
   *  /api/occurrences/:id/addons (claimer-or-admin guard on the server). */
  forAdmin?: boolean;
  /** Called with the newly-created add-on once the API responds. */
  onAdded?: (created: { id: string; tag?: string | null; customLabel?: string | null; price: number }) => void;
};

type PricingHintEntry = {
  key: string;
  parsedValue: {
    label: string;
    amount: number;
    unit: string;
    jobTags?: string[] | null;
    jobTag?: string | null;
  } | null;
};

export default function AddAddonDialog({ occurrenceId, onClose, serviceTypes, forAdmin, onAdded }: Props) {
  const [tag, setTag] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const dlgErr = useDialogError();

  // Pricing hints: loaded once when the dialog opens. Matching by jobTag
  // surfaces a single inline-reference chip; the View Pricing Guide chip
  // opens the full guide overlay (pre-filtered to the current tag's label).
  const [hints, setHints] = useState<PricingHintEntry[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);

  const jobTagLabel = (t: string) => _jobTagLabel(t, serviceTypes);
  const pricingEndpoint = forAdmin ? "/api/admin/pricing" : "/api/pricing";

  useEffect(() => {
    if (!occurrenceId) return;
    setTag("");
    setCustomLabel("");
    setPrice("");
    apiGet<PricingHintEntry[]>(pricingEndpoint)
      .then((list) => setHints(Array.isArray(list) ? list : []))
      .catch(() => setHints([]));
  }, [occurrenceId, pricingEndpoint]);

  const hintEntry = useMemo(() => {
    if (!tag) return null;
    return hints.find((p) => pricingJobTags(p.parsedValue).includes(tag)) ?? null;
  }, [hints, tag]);

  async function handleAdd() {
    if (!occurrenceId) return;
    dlgErr.clear();
    setBusy(true);
    try {
      const created = await apiPost<{ id: string; tag?: string | null; customLabel?: string | null; price: number }>(
        `/api/${forAdmin ? "admin/" : ""}occurrences/${occurrenceId}/addons`,
        {
          tag: tag || undefined,
          customLabel: customLabel.trim() || undefined,
          price: Number(price),
        },
      );
      publishInlineMessage({ type: "SUCCESS", text: "Service added." });
      onAdded?.(created);
      onClose();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add service.", err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={!!occurrenceId} onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Add Service</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Service type</Text>
                  <Box display="flex" gap="4px" flexWrap="wrap">
                    {serviceTypes.map((t) => (
                      <Badge
                        key={t.key}
                        size="sm"
                        colorPalette={tag === t.key ? "teal" : "gray"}
                        variant={tag === t.key ? "solid" : "outline"}
                        cursor="pointer"
                        px="2"
                        borderRadius="full"
                        onClick={() => { setTag(tag === t.key ? "" : t.key); setCustomLabel(""); }}
                      >
                        {t.label}
                      </Badge>
                    ))}
                  </Box>
                </Box>
                {!tag && (
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Or custom service</Text>
                    <input
                      type="text"
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                      placeholder="e.g., Remove fallen branch"
                      style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                    />
                  </Box>
                )}
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Price *</Text>
                  <CurrencyInput value={price} onChange={setPrice} size="sm" />
                  <HStack gap={2} mt={1.5} wrap="wrap">
                    {hintEntry?.parsedValue && (
                      <Badge
                        size="sm"
                        colorPalette="gray"
                        variant="subtle"
                        borderRadius="full"
                        px="2"
                        cursor="pointer"
                        title="Tap to use as the price"
                        onClick={() => setPrice(String(hintEntry.parsedValue!.amount))}
                      >
                        Ref: ${hintEntry.parsedValue.amount.toFixed(2)} / {hintEntry.parsedValue.unit} · {hintEntry.parsedValue.label}
                      </Badge>
                    )}
                    <Badge
                      size="sm"
                      colorPalette="blue"
                      variant="outline"
                      borderRadius="full"
                      px="2"
                      cursor="pointer"
                      onClick={() => setGuideOpen(true)}
                    >
                      View pricing guide ↗
                    </Badge>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  colorPalette="teal"
                  loading={busy}
                  disabled={!price || Number(price) <= 0 || (!tag && !customLabel.trim())}
                  onClick={handleAdd}
                >
                  Add
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
      <PricingGuideDialog
        open={guideOpen}
        onOpenChange={setGuideOpen}
        endpoint={pricingEndpoint}
        initialSearch={tag ? jobTagLabel(tag) : ""}
        onPick={(amount) => setPrice(String(amount))}
      />
    </Dialog.Root>
  );
}
