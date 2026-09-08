"use client";

// What the client would see if a payment were requested right now.
//
// NOT A RECORD. Nothing here is stamped, sent, or stored — the numbers move
// the moment a charge, a service, or the price changes. That has to be said on
// the surface, because an itemized invoice on a screen reads as a document,
// and an operator who takes it for one will quote from it.
//
// ADMIN / SUPER ONLY, gated on the SELECTED role rather than the underlying
// one — see the isAdmin/isSuper asymmetry at the top of JobsTab.
//
// The lines come from the server's `buildInvoice`, the same function the pay
// page renders. Rebuilding them here is how a preview starts showing a number
// the client never gets. See docs/features/job-materials.md.

import { useEffect, useState } from "react";
import { Badge, Box, Button, Dialog, HStack, Portal, Text, VStack } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { fmtDateLong } from "@/src/lib/dates";
import { getErrorMessage } from "@/src/ui/components/InlineMessage";

type InvoiceLine = { label: string; detail: string | null; amount: number };

type Preview = {
  occurrenceId: string;
  amountDue: number;
  lines: InvoiceLine[];
  propertyLabel: string;
  propertyAddress: string | null;
  serviceDate: string | null;
  alreadySent: boolean;
  settled: boolean;
  /** Recorded but not yet approved — nothing has landed. */
  paymentPending: boolean;
  /** Confirmed with nothing collected. */
  writtenOff: boolean;
  paidAmount: number | null;
  /** What the crew actually splits out of this invoice. Operator-only — never
   *  in the client's payload. Comes from the shared helper the payout engine
   *  agrees with, so the warning below quotes a real number. */
  crewPool: number;
};

const dollar = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InvoicePreviewDialog({
  occurrenceId,
  onClose,
}: {
  /** Occurrence to preview; null closes the dialog. */
  occurrenceId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!occurrenceId) return;
    setData(null);
    setError(null);
    setLoading(true);
    apiGet<Preview>(`/api/admin/occurrences/${occurrenceId}/invoice-preview`)
      .then(setData)
      .catch((err) => setError(getErrorMessage("Couldn't build the preview.", err)))
      .finally(() => setLoading(false));
  }, [occurrenceId]);

  return (
    <Dialog.Root open={!!occurrenceId} onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <HStack gap={2} align="center">
                <Dialog.Title>Invoice preview</Dialog.Title>
                <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full">
                  Not sent
                </Badge>
              </HStack>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {/* Said BEFORE the numbers, not after. Someone who reads only
                    the first line still learns this isn't a document. */}
                <Box p={2} bg="blue.50" borderWidth="1px" borderLeftWidth="3px" borderColor="blue.200" borderRadius="md">
                  <Text fontSize="xs" color="blue.800">
                    This is what the client would see if you requested payment{" "}
                    <Text as="span" fontWeight="semibold">right now</Text>. It isn&rsquo;t a
                    record of anything and nothing has been sent — it changes as soon as
                    the price, a service, or a charge changes.
                  </Text>
                </Box>

                {loading && <Text fontSize="xs" color="fg.muted">Building the preview…</Text>}
                {error && (
                  <Box p={2} bg="red.subtle" borderWidth="1px" borderLeftWidth="3px" borderColor="red.solid" borderRadius="md">
                    <Text fontSize="xs" color="red.fg">{error}</Text>
                  </Box>
                )}

                {data && (() => {
                  // What the client is billed on top of the crew's pool. Named
                  // once so the heading, the row and the footer can never
                  // disagree about whether there is any.
                  const notShared = Math.max(
                    0,
                    Math.round((data.amountDue - data.crewPool) * 100) / 100,
                  );
                  return (
                  <>
                    {/* THREE DIFFERENT FACTS, and they were one banner.
                        `settled` was true whenever a Payment row existed, so a
                        payment still waiting on approval announced "already
                        paid" — and a confirmed $0 write-off rendered
                        "already paid ($0.00)", which is not a sentence about
                        money. */}
                    {data.settled && !data.writtenOff && (
                      <Box p={2} bg="green.subtle" borderWidth="1px" borderLeftWidth="3px" borderColor="green.solid" borderRadius="md">
                        <Text fontSize="xs" color="green.fg">
                          This job is already paid
                          {data.paidAmount != null ? ` (${dollar(data.paidAmount)})` : ""}.
                          What you see below is the current invoice, not the one they paid.
                        </Text>
                      </Box>
                    )}
                    {data.writtenOff && (
                      <Box p={2} bg="gray.subtle" borderWidth="1px" borderLeftWidth="3px" borderColor="fg.muted" borderRadius="md">
                        <Text fontSize="xs" color="fg.muted">
                          This job was closed with nothing collected. The invoice below is
                          what it would bill, not what anyone owes.
                        </Text>
                      </Box>
                    )}
                    {data.paymentPending && (
                      <Box p={2} bg="blue.subtle" borderWidth="1px" borderLeftWidth="3px" borderColor="blue.solid" borderRadius="md">
                        <Text fontSize="xs" color="blue.fg">
                          A payment is recorded but not yet approved. Nothing has landed —
                          this preview is still live, and changing the job still changes
                          what the client owes.
                        </Text>
                      </Box>
                    )}
                    {!data.settled && !data.paymentPending && data.alreadySent && (
                      <Box p={2} bg="orange.subtle" borderWidth="1px" borderLeftWidth="3px" borderColor="orange.solid" borderRadius="md">
                        <Text fontSize="xs" color="orange.fg">
                          A request already went out for this job. If anything below has
                          changed since, the client is looking at a different number —
                          re-send the invoice from the job card.
                        </Text>
                      </Box>
                    )}

                    {/* Laid out like the real pay page, so what an operator
                        checks here is what the client actually reads. */}
                    <Box
                      p={3}
                      borderWidth="1px"
                      borderColor="border"
                      borderLeftWidth="4px"
                      borderLeftColor="fg.muted"
                      borderRadius="lg"
                      bg="bg"
                    >
                      <VStack gap={1} align="stretch">
                        <Text fontSize="md" fontWeight="semibold" lineClamp={2}>
                          {data.propertyLabel}
                        </Text>
                        {data.propertyAddress && data.propertyAddress !== data.propertyLabel && (
                          <Text fontSize="xs" color="fg.muted">{data.propertyAddress}</Text>
                        )}
                        {data.serviceDate && (
                          <Text fontSize="sm" color="fg.muted">{fmtDateLong(data.serviceDate)}</Text>
                        )}

                        {data.lines.length > 0 ? (
                          <VStack gap={1.5} align="stretch" mt={3}>
                            {data.lines.map((l, i) => (
                              <HStack key={i} align="start" justify="space-between" gap={3}>
                                <Box minW={0}>
                                  <Text fontSize="sm">{l.label}</Text>
                                  {l.detail && (
                                    <Text fontSize="xs" color="fg.muted">{l.detail}</Text>
                                  )}
                                </Box>
                                <Text fontSize="sm" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
                                  {dollar(l.amount)}
                                </Text>
                              </HStack>
                            ))}
                          </VStack>
                        ) : (
                          <Text fontSize="xs" color="fg.muted" mt={3}>
                            Nothing to bill yet — this job has no price, services or
                            charges on it.
                          </Text>
                        )}

                        <HStack
                          mt={2}
                          align="baseline"
                          justify="space-between"
                          borderTopWidth={data.lines.length > 0 ? "1px" : 0}
                          borderColor="border.muted"
                          pt={data.lines.length > 0 ? 2 : 0}
                        >
                          <Text fontSize="sm" color="fg.muted">Total due</Text>
                          <Text
                            fontSize="2xl"
                            fontWeight="bold"
                            color="teal.fg"
                            fontVariantNumeric="tabular-nums"
                          >
                            {dollar(data.amountDue)}
                          </Text>
                        </HStack>
                      </VStack>
                    </Box>

                    {/* THE DISTINCTION THE WHOLE MODEL RESTS ON, stated with
                        this job's real numbers rather than as a rule.
                        "Services are shared, charges aren't" is easy to nod
                        along to and still misread a $350 total as $350 of
                        work. The split figure comes from the server's shared
                        crewPool helper — the one the payout engine agrees
                        with — so it is what the crew will actually be paid.

                        IT READS THIS JOB, NOT THE RULE IN GENERAL. On a job
                        with no charges every dollar IS shared, and heading
                        that "Not all of this is shared with the crew" above a
                        "Not shared $0.00" row states something false about
                        the invoice on screen. A warning that cries wolf on
                        the plain case is worse than no warning: it teaches
                        the operator to skip the box on the job where the
                        split actually matters. */}
                    <Box
                      p={2.5}
                      bg={notShared > 0 ? "yellow.subtle" : "bg.subtle"}
                      borderWidth="1px"
                      borderColor={notShared > 0 ? "yellow.solid" : "border"}
                      borderLeftWidth="3px"
                      borderRadius="md"
                    >
                      <Text fontSize="xs" fontWeight="semibold" mb={1.5}>
                        {notShared > 0
                          ? "Not all of this is shared with the crew"
                          : "All of this is shared with the crew"}
                      </Text>
                      <VStack align="stretch" gap={1} fontSize="xs">
                        <HStack justify="space-between" gap={3}>
                          <Text>
                            <Text as="span" fontWeight="semibold">Shared</Text> — labor
                            and any services added to the job
                          </Text>
                          <Text fontVariantNumeric="tabular-nums" whiteSpace="nowrap" fontWeight="semibold">
                            {dollar(data.crewPool)}
                          </Text>
                        </HStack>
                        {/* Only when there is something in it. A $0.00 row is
                            not information, it is a claim. */}
                        {notShared > 0 && (
                          <HStack justify="space-between" gap={3}>
                            <Text color="fg.muted">
                              <Text as="span" fontWeight="semibold">Not shared</Text> —
                              charges billed on top (materials, supplies)
                            </Text>
                            <Text fontVariantNumeric="tabular-nums" whiteSpace="nowrap" color="fg.muted">
                              {dollar(notShared)}
                            </Text>
                          </HStack>
                        )}
                      </VStack>
                      <Text fontSize="2xs" color="fg.muted" mt={1.5}>
                        {notShared > 0 ? (
                          <>
                            The crew splits the shared figure between them, then fees and
                            margin come off each person&rsquo;s share. Charges go to the
                            business to cover what was bought &mdash; they never come out
                            of anyone&rsquo;s pay.
                          </>
                        ) : (
                          <>
                            Nothing on this invoice is billed on top, so the whole total
                            is the crew&rsquo;s pool. They split it between them, then
                            fees and margin come off each person&rsquo;s share.
                          </>
                        )}
                      </Text>
                    </Box>
                  </>
                  );
                })()}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="outline" onClick={onClose}>Close</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
