"use client";

// Manage the SERVICES on one visit — the add-on lines that are work, and so
// land in the crew's pool.
//
// THIS IS THE ONLY PLACE A SERVICE CAN BE REMOVED. The job card used to carry
// a bare red ✕ beside each add-on: one tap, one confirm, and a line came off
// the client's invoice from a collapsed card on a phone. Removing money from
// an invoice is not a thing you should be able to do in passing — you open the
// dialog, you see every line together, and you remove it there. The card lists
// them read-only.
//
// See docs/features/job-materials.md.

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
import { X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
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
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { InvoiceAlreadySentNote } from "@/src/ui/components/InvoiceAlreadySentNote";

export type ManagedAddon = {
  id: string;
  tag?: string | null;
  customLabel?: string | null;
  price: number;
  detail?: string | null;
};

type Props = {
  /** Occurrence whose services we're managing; null = dialog closed. */
  occurrenceId: string | null;
  onClose: () => void;
  /** Service-type config from settings (drives the tag chip list + labels). */
  serviceTypes: ServiceTypeConfig[];
  /** Admin view → uses /api/admin/occurrences/:id/addons; worker view →
   *  /api/occurrences/:id/addons (claimer-or-admin guard on the server). */
  forAdmin?: boolean;
  /** The services already on this visit. The caller has them loaded, so the
   *  dialog takes them rather than adding a round-trip; local state tracks
   *  add/remove from there. */
  addons?: ManagedAddon[] | null;
  /** Whether this user may take a line off the invoice. The server enforces
   *  it too (claimer-or-admin) — this only decides whether the affordance is
   *  shown, so nobody clicks into a 403. */
  canRemove?: boolean;
  /** Called with the newly-created add-on once the API responds. */
  onAdded?: (created: ManagedAddon) => void;
  /** Called after a removal, so the caller can refresh its own copy. */
  onRemoved?: (addonId: string) => void;
  /** What the client was last asked to pay, when a request is still
   *  outstanding. Adding a service changes what they owe, so the operator is
   *  warned to re-send. Null when nothing is in flight. */
  sentInvoiceAmount?: number | null;
  /** Impersonated worker's display name, when an admin is viewing-as. */
  viewAsName?: string | null;
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

export default function AddAddonDialog({
  occurrenceId, onClose, serviceTypes, forAdmin, onAdded, onRemoved,
  addons = null, canRemove = false,
  sentInvoiceAmount = null, viewAsName = null,
}: Props) {
  // Seeded from the prop and kept locally so the list reflects an add or a
  // removal immediately, without the caller having to round-trip first.
  const [list, setList] = useState<ManagedAddon[]>([]);
  const [removing, setRemoving] = useState<ManagedAddon | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [tag, setTag] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [price, setPrice] = useState("");
  // CLIENT-VISIBLE detail — same shape a material charge carries. A service
  // and a charge are entered identically; the only difference is that a
  // service is WORK, so it lands in the crew's POOL.
  const [detail, setDetail] = useState("");
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
    setDetail("");
    setList(addons ?? []);
    setRemoving(null);
    apiGet<PricingHintEntry[]>(pricingEndpoint)
      .then((list) => setHints(Array.isArray(list) ? list : []))
      .catch(() => setHints([]));
    // `addons` is deliberately not a dependency — reseeding on every parent
    // render would throw away a removal the parent hasn't caught up with yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occurrenceId, pricingEndpoint]);

  const hintEntry = useMemo(() => {
    if (!tag) return null;
    return hints.find((p) => pricingJobTags(p.parsedValue).includes(tag)) ?? null;
  }, [hints, tag]);

  const labelFor = (a: ManagedAddon) =>
    a.tag ? jobTagLabel(a.tag) : (a.customLabel || "Service");

  async function handleRemove(addon: ManagedAddon) {
    if (!occurrenceId) return;
    dlgErr.clear();
    setRemoveBusy(true);
    try {
      await apiDelete(
        `/api/${forAdmin ? "admin/" : ""}occurrences/${occurrenceId}/addons/${addon.id}`,
      );
      setList((prev) => prev.filter((a) => a.id !== addon.id));
      publishInlineMessage({ type: "SUCCESS", text: "Service removed." });
      onRemoved?.(addon.id);
      setRemoving(null);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to remove service.", err));
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  }

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
          detail: detail.trim() || undefined,
        },
      );
      publishInlineMessage({ type: "SUCCESS", text: "Service added." });
      setList((prev) => [...prev, created]);
      onAdded?.(created);
      // Deliberately NOT closing. This dialog is now the only way to see and
      // change the services on a visit, so the operator lands back on the
      // list and can see what they just added sitting with the rest.
      setTag("");
      setCustomLabel("");
      setPrice("");
      setDetail("");
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
              <Dialog.Title>Edit Services</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ImpersonationWarning viewAsName={viewAsName} />
              {sentInvoiceAmount != null && (
                <Box mb={3}>
                  <InvoiceAlreadySentNote sentAmount={sentInvoiceAmount} action="Adding a service" />
                </Box>
              )}
              <VStack align="stretch" gap={3}>
                {/* WHAT IS ALREADY ON THIS VISIT, and the only place it can
                    come off. Listed before the add form: the operator opened
                    this to change something, and half the time the thing they
                    want is already here. */}
                {list.length > 0 && (
                  <Box
                    p={2}
                    bg="green.50"
                    borderWidth="1px"
                    borderColor="green.200"
                    borderRadius="md"
                  >
                    <HStack justify="space-between" align="baseline" mb={1.5}>
                      <Text fontSize="xs" fontWeight="semibold" color="green.800">
                        On this visit
                      </Text>
                      <Text
                        fontSize="xs"
                        fontWeight="semibold"
                        color="green.800"
                        fontVariantNumeric="tabular-nums"
                      >
                        +${list.reduce((t, a) => t + (a.price ?? 0), 0).toFixed(2)}
                      </Text>
                    </HStack>
                    <VStack align="stretch" gap={1}>
                      {list.map((a) => (
                        <HStack key={a.id} justify="space-between" align="start" gap={2}>
                          <Box minW={0}>
                            <Text fontSize="sm">{labelFor(a)}</Text>
                            {a.detail?.trim() && (
                              <Text fontSize="xs" color="fg.muted">{a.detail}</Text>
                            )}
                          </Box>
                          <HStack gap={1} flexShrink={0}>
                            <Text
                              fontSize="sm"
                              fontVariantNumeric="tabular-nums"
                              whiteSpace="nowrap"
                            >
                              +${(a.price ?? 0).toFixed(2)}
                            </Text>
                            {canRemove && (
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="red"
                                px="1"
                                minW="auto"
                                title="Remove this service"
                                disabled={removeBusy}
                                onClick={() => setRemoving(a)}
                              >
                                <X size={13} />
                              </Button>
                            )}
                          </HStack>
                        </HStack>
                      ))}
                    </VStack>
                    {canRemove && (
                      <Text fontSize="2xs" color="fg.muted" mt={1.5}>
                        Removing a service takes it off the client&rsquo;s invoice and
                        out of the crew&rsquo;s pool.
                      </Text>
                    )}
                  </Box>
                )}

                {/* THE ONE DECISION THIS SCREEN ASKS FOR — worded identically
                    to the charges dialog, so the answer doesn't depend on
                    which one you happened to open. A service is WORK, so it
                    goes into the crew's pool; a charge does not.

                    IT SAYS "POOL", NEVER "THE CREW SPLITS IT". Those are not
                    the same claim. The pool is what the payout engine divides,
                    and margin and per-worker fees come off before anyone is
                    paid — how much of a $50 service reaches a worker depends
                    entirely on the margin and fee settings. Copy that promises
                    the crew the whole amount is a promise the engine does not
                    keep. */}
                <Box p={2} bg="blue.50" borderWidth="1px" borderLeftWidth="3px" borderColor="blue.200" borderRadius="md">
                  <Text fontSize="xs" color="blue.800">
                    A service is <Text as="span" fontWeight="semibold">work</Text>, so it goes
                    on the client&rsquo;s invoice <Text as="span" fontWeight="semibold">and into
                    the crew&rsquo;s pool</Text> &mdash; unlike a charge, which is billed on
                    top and leaves the pool alone.
                  </Text>
                    <Text fontSize="xs" color="blue.800" mt={1}>
                      How much of that pool reaches each person depends on your margin
                      and fee settings &mdash; a service raises the pool, it isn&rsquo;t
                      handed over dollar-for-dollar.
                    </Text>
                  <Text fontSize="xs" color="blue.800" mt={1}>
                    This is also the only place a service comes off a visit &mdash; the
                    job card lists them, it doesn&rsquo;t change them.
                  </Text>
                  <Box borderTopWidth="1px" borderColor="blue.200" mt={1.5} pt={1.5}>
                    <Text fontSize="xs" color="blue.800">
                      <Text as="span" fontWeight="semibold">Did you buy a thing?</Text>{" "}
                      Add Charge. Billed on top, pool unchanged.
                    </Text>
                    <Text fontSize="xs" color="blue.800">
                      <Text as="span" fontWeight="semibold">Did someone do work?</Text>{" "}
                      Add Service. Billed on top, <Text as="span" fontWeight="semibold">and it
                      raises the crew&rsquo;s pool</Text>.
                    </Text>
                  </Box>
                </Box>
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
                {/* Same shape as an invoice charge: a line name plus an
                    optional client-visible detail. A service and a material
                    line sit side by side on the invoice, so they are entered
                    the same way. See docs/features/job-materials.md. */}
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>
                    Detail for the client{" "}
                    <Text as="span" color="fg.muted" fontWeight="normal">(optional)</Text>
                  </Text>
                  <input
                    type="text"
                    value={detail}
                    onChange={(e) => setDetail(e.target.value)}
                    placeholder="e.g. 5 bushes at $25.00 each"
                    style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                  />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Shown under this line on their invoice. Leave blank to show just
                    the service and the amount.
                  </Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={onClose}>Done</Button>
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
      {/* Removing money from a client's invoice always confirms. */}
      <ConfirmDialog
        open={!!removing}
        title="Remove this service?"
        message={
          removing
            ? `${labelFor(removing)} (+$${(removing.price ?? 0).toFixed(2)}) comes off this job, and off what the client is billed.`
            : ""
        }
        confirmLabel="Remove"
        confirmColorPalette="red"
        onConfirm={() => { if (removing) void handleRemove(removing); }}
        onCancel={() => setRemoving(null)}
      />
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
