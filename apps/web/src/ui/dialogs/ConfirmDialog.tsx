"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, HStack, VStack, Portal, Text, Box } from "@chakra-ui/react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { apiGet } from "@/src/lib/api";
import { jobTagLabel } from "@/src/ui/components/JobTagPicker";
import PricingGuideDialog from "@/src/ui/dialogs/PricingGuideDialog";

type Props = {
  open: boolean;
  title: string;
  message: string;
  /** Optional JSX body — replaces the plain `message` Text when set. Use
   *  when the dialog needs a richer summary (callout boxes, side-by-side
   *  stats, etc.) than plain text can convey. */
  messageNode?: React.ReactNode;
  confirmLabel?: string;
  confirmColorPalette?: string;
  onConfirm: ((inputValue: string, amountValue?: string) => void) | (() => void);
  onCancel: () => void;
  /** If provided, shows a text input with this placeholder */
  inputPlaceholder?: string;
  /** Label for the text input */
  inputLabel?: string;
  /** If true, the input is not required to confirm */
  inputOptional?: boolean;
  /** Default value for the input */
  inputDefaultValue?: string;
  /** If provided, shows an additional currency input. The amount value is passed as the 2nd arg to onConfirm. Always optional. */
  amountLabel?: string;
  amountPlaceholder?: string;
  amountDefaultValue?: string;
  /** When provided alongside an amount field, fetches pricing entries and
   *  shows a reference panel: each entry matching one of these tags
   *  is listed, summed, and a "Use as amount" button fills the input. */
  pricingReferenceTags?: string[];
  /** Pricing endpoint to fetch from. Defaults to the worker route. */
  pricingEndpoint?: string;
  /** Custom label for the cancel button */
  cancelLabel?: string;
  /** Action to perform on cancel (instead of just closing) */
  onCancelAction?: () => void;
  /** Yellow warning shown below the message. Use for "why this matters"
   *  hints — e.g. why one of the offered actions is the recommended path. */
  warning?: string;
  /** In tri-action mode (onCancelAction set), render the secondary
   *  (cancel-action) button ABOVE the primary confirm button. Use when the
   *  cancel-action is actually the recommended next step. */
  secondaryActionFirst?: boolean;
  /** When true, clicking the secondary action button only fires
   *  `onCancelAction` — `onCancel` is NOT called. Use for nested-modal
   *  flows where the secondary opens a sub-dialog and the parent must
   *  stay in state so it can reappear after the sub-dialog closes. */
  keepOpenOnCancelAction?: boolean;
};

type PricingHint = {
  key: string;
  parsedValue: { label: string; amount: number; unit: string; jobTag?: string | null } | null;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  messageNode,
  confirmLabel = "Confirm",
  confirmColorPalette = "green",
  onConfirm,
  onCancel,
  inputPlaceholder,
  inputLabel,
  inputOptional,
  inputDefaultValue,
  amountLabel,
  amountPlaceholder,
  amountDefaultValue,
  pricingReferenceTags,
  pricingEndpoint = "/api/pricing",
  cancelLabel,
  onCancelAction,
  warning,
  secondaryActionFirst,
  keepOpenOnCancelAction,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [amountValue, setAmountValue] = useState("");
  const [pricingHints, setPricingHints] = useState<PricingHint[]>([]);
  const [pricingGuideOpen, setPricingGuideOpen] = useState(false);

  // Reset inputs when dialog opens/closes
  useEffect(() => {
    if (open) {
      setInputValue(inputDefaultValue ?? "");
      setAmountValue(amountDefaultValue ?? "");
    }
  }, [open, inputDefaultValue, amountDefaultValue]);

  // Pricing reference panel — fetched once on open when tags are provided
  // alongside an amount input. The list is sorted server-side so we keep
  // its order intact (matches the Pricing tab).
  useEffect(() => {
    if (!open) return;
    if (!amountLabel || !pricingReferenceTags || pricingReferenceTags.length === 0) {
      setPricingHints([]);
      return;
    }
    apiGet<PricingHint[]>(pricingEndpoint)
      .then((list) => setPricingHints(Array.isArray(list) ? list : []))
      .catch(() => setPricingHints([]));
  }, [open, amountLabel, pricingReferenceTags, pricingEndpoint]);

  const referenceMatches = useMemo(() => {
    if (!pricingReferenceTags || pricingReferenceTags.length === 0) return [];
    const tagSet = new Set(pricingReferenceTags);
    return pricingHints
      .filter((p) => p.parsedValue?.jobTag && tagSet.has(p.parsedValue.jobTag))
      .map((p) => p.parsedValue!);
  }, [pricingHints, pricingReferenceTags]);
  const referenceTotal = referenceMatches.reduce((s, r) => s + r.amount, 0);

  const hasInput = !!inputPlaceholder;
  const hasAmount = !!amountLabel;
  const canConfirm = !hasInput || inputOptional || inputValue.trim().length > 0;

  function handleConfirm() {
    if (!canConfirm) return;
    if (hasInput || hasAmount) {
      (onConfirm as (v: string, a?: string) => void)(inputValue.trim(), hasAmount ? amountValue : undefined);
    } else {
      (onConfirm as () => void)();
    }
  }

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onCancel();
      }}
      initialFocusEl={() => cancelRef.current}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {messageNode ? messageNode : (message && <Text>{message}</Text>)}
              {warning && (
                <Box
                  mt={3}
                  p={3}
                  bg="blue.50"
                  borderWidth="1px"
                  borderColor="blue.300"
                  borderLeftWidth="4px"
                  borderLeftColor="blue.500"
                  rounded="md"
                >
                  <Text fontSize="sm" color="blue.900">{warning}</Text>
                </Box>
              )}
              {hasInput && (
                <Box mt={3}>
                  {inputLabel && (
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      {inputLabel}
                    </Text>
                  )}
                  <textarea
                    placeholder={inputPlaceholder}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      fontSize: "0.875rem",
                      padding: "0.5rem",
                      borderRadius: "0.375rem",
                      border: "1px solid var(--chakra-colors-border)",
                      background: "var(--chakra-colors-bg)",
                      color: "var(--chakra-colors-fg)",
                      outline: "none",
                      resize: "vertical",
                    }}
                  />
                </Box>
              )}
              {hasAmount && (
                <Box mt={3}>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    {amountLabel}
                  </Text>
                  <CurrencyInput
                    value={amountValue}
                    onChange={setAmountValue}
                    size="sm"
                    placeholder={amountPlaceholder ?? "0.00"}
                  />
                  {/* Pricing reference panel + "View pricing guide" badge
                      only render when the caller passes pricingReferenceTags.
                      Without that prop the amount field is for something
                      that has nothing to do with job pricing (e.g.
                      "Actual amount collected" on payment adjustment), and
                      offering a pricing guide there is misleading. */}
                  {pricingReferenceTags && pricingReferenceTags.length > 0 && (
                    <Box mt={2}>
                      {referenceMatches.length > 0 && (
                        <Box p={2} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200" mb={2}>
                          <Text fontSize="xs" fontWeight="semibold" mb={1} color="fg.muted">
                            Reference (based on tags)
                          </Text>
                          <VStack align="stretch" gap={0.5}>
                            {referenceMatches.map((r, i) => (
                              <HStack key={i} justify="space-between" fontSize="xs">
                                <Text color="fg.muted">
                                  {r.label}{r.jobTag ? ` (${jobTagLabel(r.jobTag)})` : ""}
                                </Text>
                                <Text fontWeight="medium">${r.amount.toFixed(2)}</Text>
                              </HStack>
                            ))}
                            <HStack justify="space-between" fontSize="xs" pt={1} borderTopWidth="1px" borderColor="gray.300" mt={1}>
                              <Text fontWeight="bold">Suggested total</Text>
                              <Text fontWeight="bold">${referenceTotal.toFixed(2)}</Text>
                            </HStack>
                          </VStack>
                          <Button
                            size="xs"
                            colorPalette="blue"
                            variant="outline"
                            mt={2}
                            onClick={() => setAmountValue(referenceTotal.toFixed(2))}
                          >
                            Use as amount
                          </Button>
                        </Box>
                      )}
                      <Badge
                        size="sm"
                        colorPalette="blue"
                        variant="outline"
                        borderRadius="full"
                        px="2"
                        cursor="pointer"
                        onClick={() => setPricingGuideOpen(true)}
                      >
                        View pricing guide ↗
                      </Badge>
                    </Box>
                  )}
                </Box>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {onCancelAction ? (
                <VStack w="full" gap={2}>
                  {secondaryActionFirst && (
                    <Button
                      w="full"
                      variant="outline"
                      colorPalette="gray"
                      onClick={() => { onCancelAction(); if (!keepOpenOnCancelAction) onCancel(); }}
                    >
                      {cancelLabel}
                    </Button>
                  )}
                  <Button
                    w="full"
                    variant="solid"
                    colorPalette={confirmColorPalette}
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                  >
                    {confirmLabel}
                  </Button>
                  {!secondaryActionFirst && (
                    <Button
                      w="full"
                      variant="outline"
                      colorPalette="gray"
                      onClick={() => { onCancelAction(); if (!keepOpenOnCancelAction) onCancel(); }}
                    >
                      {cancelLabel}
                    </Button>
                  )}
                  <Button
                    ref={cancelRef}
                    w="full"
                    variant="ghost"
                    colorPalette="red"
                    size="sm"
                    onClick={onCancel}
                  >
                    Cancel
                  </Button>
                </VStack>
              ) : (
                <HStack justify="flex-end" w="full" gap={2} wrap="wrap">
                  <Button ref={cancelRef} variant="ghost" colorPalette="red" onClick={onCancel}>
                    {cancelLabel ?? "Cancel"}
                  </Button>
                  <Button
                    colorPalette={confirmColorPalette}
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                  >
                    {confirmLabel}
                  </Button>
                </HStack>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
      {/* Pricing guide overlay — layered above the confirm dialog. */}
      <PricingGuideDialog
        open={pricingGuideOpen}
        onOpenChange={setPricingGuideOpen}
        endpoint={pricingEndpoint}
        onPick={(amount) => setAmountValue(amount.toFixed(2))}
      />
    </Dialog.Root>
  );
}
