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
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Pencil, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import InvoiceLinePreview from "@/src/ui/dialogs/InvoiceLinePreview";
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

/**
 * The service fields, used by BOTH the add form and the per-row edit form.
 *
 * Extracted for the same reason ChargeFields exists in the charges dialog:
 * one component means the two forms can never drift into offering different
 * fields. Before this, a service could only be added — correcting one meant
 * deleting the line and re-adding it, which is not the same operation (it
 * re-bills the client in the audit trail and throws away the note).
 */
function AddonFields({
  tag, setTag,
  customLabel, setCustomLabel,
  price, setPrice,
  detail, setDetail,
  serviceTypes, jobTagLabel, hintEntry, onOpenGuide,
}: {
  tag: string; setTag: (v: string) => void;
  customLabel: string; setCustomLabel: (v: string) => void;
  price: string; setPrice: (v: string) => void;
  detail: string; setDetail: (v: string) => void;
  serviceTypes: { key: string; label: string }[];
  jobTagLabel: (t: string) => string;
  hintEntry: PricingHintEntry | null;
  onOpenGuide: () => void;
}) {
  const chosenName = tag ? jobTagLabel(tag) : customLabel;

  return (
    <VStack align="stretch" gap={3}>
      {/* ONE BORDERED SECTION, HEADED — the same treatment the charges dialog
          gives its invoice fields. Services had a flat list of inputs with a
          single note under the last one, so nothing said which of them the
          client actually reads.

          There is no matching "internal" section here because a service has no
          internal field: unlike a charge, it carries no what-we-paid figure.
          The footnote says so outright rather than leaving the absence to be
          inferred from a missing box. */}
      <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" overflow="hidden">
        <Box px={2.5} py={1} bg="blue.subtle" borderBottomWidth="1px" borderColor="border.muted">
          <Text fontSize="2xs" fontWeight="bold" letterSpacing="0.04em" textTransform="uppercase" color="blue.fg">
            On the client&rsquo;s invoice
          </Text>
        </Box>
        <VStack align="stretch" gap={2.5} p={2.5}>
          <Box>
            <Text fontSize="xs" fontWeight="medium" mb={1}>
              Service type <Text as="span" color="red.solid">*</Text>
            </Text>
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
              {/* Chakra Input, not a raw styled <input>. The charges dialog is
                  Chakra throughout; matching it is the point of this pass. */}
              <Input
                size="sm"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="e.g., Remove fallen branch"
              />
            </Box>
          )}
          <Box>
            <Text fontSize="xs" fontWeight="medium" mb={1}>
              Amount <Text as="span" color="red.solid">*</Text>
            </Text>
            <CurrencyInput value={price} onChange={setPrice} size="sm" />
            <HStack gap={2} mt={1.5} wrap="wrap">
              {hintEntry?.parsedValue && (
                <Badge
                  size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="2"
                  cursor="pointer" title="Tap to use as the price"
                  onClick={() => setPrice(String(hintEntry.parsedValue!.amount))}
                >
                  Ref: ${hintEntry.parsedValue.amount.toFixed(2)} / {hintEntry.parsedValue.unit} · {hintEntry.parsedValue.label}
                </Badge>
              )}
              <Badge
                size="sm" colorPalette="blue" variant="outline" borderRadius="full" px="2"
                cursor="pointer" onClick={onOpenGuide}
              >
                View pricing guide ↗
              </Badge>
            </HStack>
            {/* The reference chip is a PRICING AID, not a second amount. It is
                inside the invoice box only because it sits under the field it
                fills in; say plainly that it goes nowhere near the client. */}
            <Text fontSize="2xs" color="fg.muted" mt={1}>
              The pricing reference is a lookup for you &mdash; only the amount above
              reaches the invoice.
            </Text>
          </Box>
          <Box>
            <Text fontSize="xs" fontWeight="medium" mb={1}>
              Detail{" "}
              <Text as="span" color="fg.muted" fontWeight="normal">(optional)</Text>
            </Text>
            <Input
              size="sm"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="e.g. 5 bushes at $25.00 each"
            />
          </Box>
          <Text fontSize="2xs" color="fg.muted">
            The client sees the service name, the detail, and the amount &mdash; and
            nothing else on this form. A service has no internal-only figure the way
            a charge does.
          </Text>
          <InvoiceLinePreview
            name={chosenName}
            amount={price}
            detail={detail}
            emptyLabel="this service"
          />
        </VStack>
      </Box>
    </VStack>
  );
}

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
  /** The id of the line being corrected, expanded INLINE in the list — the
   *  same shape the charges dialog uses. An earlier pass reused the add form
   *  for editing; that put the edit fields far from the row being edited and
   *  left the two dialogs behaving differently for the same job. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTag, setEditTag] = useState("");
  const [editCustomLabel, setEditCustomLabel] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editDetail, setEditDetail] = useState("");
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

  /** The same reference chip for the row being edited, keyed on ITS tag —
   *  the add form's tag is unrelated while an edit is open. */
  const editHintEntry = useMemo(() => {
    if (!editTag) return null;
    return hints.find((p) => pricingJobTags(p.parsedValue).includes(editTag)) ?? null;
  }, [hints, editTag]);

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

  function beginEdit(a: ManagedAddon) {
    dlgErr.clear();
    setEditingId(a.id);
    setEditTag(a.tag ?? "");
    setEditCustomLabel(a.customLabel ?? "");
    setEditPrice(String(a.price ?? ""));
    setEditDetail(a.detail ?? "");
  }

  async function handleSaveEdit() {
    if (!occurrenceId || !editingId) return;
    if (!editPrice || Number(editPrice) <= 0) return;
    if (!editTag && !editCustomLabel.trim()) return;
    dlgErr.clear();
    setBusy(true);
    try {
      const saved = await apiPatch<ManagedAddon>(
        `/api/${forAdmin ? "admin/" : ""}occurrences/${occurrenceId}/addons/${editingId}`,
        {
          tag: editTag || null,
          customLabel: editCustomLabel.trim() || null,
          price: Number(editPrice),
          // Sent even when empty — an empty string CLEARS the note, which is
          // the only way to take one back off a line.
          detail: editDetail.trim(),
        },
      );
      publishInlineMessage({ type: "SUCCESS", text: "Service updated." });
      setList((prev) => prev.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)));
      onAdded?.(saved as any);
      setEditingId(null);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to update service.", err));
    } finally {
      setBusy(false);
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
                        editingId === a.id ? (
                          // INLINE, in the row being corrected — the same shape
                          // the charges dialog uses, so the two behave alike.
                          <VStack
                            key={a.id}
                            align="stretch"
                            gap={2}
                            borderWidth="1px"
                            borderColor="border"
                            borderRadius="md"
                            bg="bg"
                            p={2}
                          >
                            <AddonFields
                              tag={editTag} setTag={setEditTag}
                              customLabel={editCustomLabel} setCustomLabel={setEditCustomLabel}
                              price={editPrice} setPrice={setEditPrice}
                              detail={editDetail} setDetail={setEditDetail}
                              serviceTypes={serviceTypes}
                              jobTagLabel={jobTagLabel}
                              hintEntry={editHintEntry}
                              onOpenGuide={() => setGuideOpen(true)}
                            />
                            <HStack gap={2} justify="flex-end">
                              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                colorPalette="teal"
                                loading={busy}
                                disabled={
                                  !editPrice || Number(editPrice) <= 0
                                  || (!editTag && !editCustomLabel.trim())
                                }
                                onClick={handleSaveEdit}
                              >
                                Save
                              </Button>
                            </HStack>
                          </VStack>
                        ) : (
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
                                px="1"
                                minW="auto"
                                title="Edit this service"
                                disabled={removeBusy || busy}
                                onClick={() => beginEdit(a)}
                              >
                                <Pencil size={13} />
                              </Button>
                            )}
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
                        )
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
                {/* Same component the per-row edit form renders, so the two
                    can never offer different fields — the charges dialog's
                    rule, applied here. */}
                <AddonFields
                  tag={tag} setTag={setTag}
                  customLabel={customLabel} setCustomLabel={setCustomLabel}
                  price={price} setPrice={setPrice}
                  detail={detail} setDetail={setDetail}
                  serviceTypes={serviceTypes}
                  jobTagLabel={jobTagLabel}
                  hintEntry={hintEntry}
                  onOpenGuide={() => setGuideOpen(true)}
                />
                <HStack gap={2} align="center">
                  {/* Say WHY the button is dead rather than leaving a greyed
                      control with no explanation — the charges dialog does
                      this and it is the better half of the pair. */}
                  <Text fontSize="2xs" color="fg.muted" flex="1">
                    {!tag && !customLabel.trim() && !price
                      ? "Pick a service type and enter a price."
                      : !tag && !customLabel.trim()
                        ? "Pick a service type, or name a custom one."
                        : !price || Number(price) <= 0
                          ? "Enter a price."
                          : ""}
                  </Text>
                  <Button
                    size="sm"
                    colorPalette="teal"
                    loading={busy}
                    disabled={!price || Number(price) <= 0 || (!tag && !customLabel.trim())}
                    onClick={handleAdd}
                  >
                    Add to invoice
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            {/* Done only. The Add button now sits WITH the form it submits,
                as it does in the charges dialog — an Add in the footer reads
                as "finish the dialog", which is what Done means. */}
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="outline" onClick={onClose}>Done</Button>
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
