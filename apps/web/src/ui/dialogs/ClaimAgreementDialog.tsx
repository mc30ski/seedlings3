"use client";

import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import type { Me, WorkerOccurrence } from "@/src/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgreed: () => void;
  me: Me | null;
  occurrence: WorkerOccurrence | null;
  commissionPercent: number;
  marginPercent: number;
  /** Set when the claim is being made on behalf of a group. The dialog will
   *  divide the payout by the active worker count (claimer + non-observer
   *  members) and show "your share" instead of the gross amount. */
  group?: { id: string; name: string; activeWorkerCount: number } | null;
};

export default function ClaimAgreementDialog({
  open,
  onOpenChange,
  onAgreed,
  me,
  occurrence,
  commissionPercent,
  marginPercent,
  group,
}: Props) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const isContractor = me?.workerType === "CONTRACTOR" || !me?.workerType;
  const isEmployee = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";

  const basePrice = occurrence?.price ?? 0;
  const addonsTotal = ((occurrence as any)?.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);
  const price = basePrice + addonsTotal;
  const expTotal = (occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
  const net = price - expTotal;
  const pct = isEmployee ? marginPercent : commissionPercent;
  const deduction = Math.round(net * pct) / 100;
  // Total payout pool after commission/margin — split by active worker count
  // when this is a group claim. Observers are excluded from the worker count
  // and from the split (they don't earn). Claimer always counts as a worker.
  const payoutPool = Math.max(0, net - deduction);
  const splitCount = group ? Math.max(1, group.activeWorkerCount) : 1;
  const perWorker = Math.round((payoutPool / splitCount) * 100) / 100;
  const label = isEmployee ? "Business Margin" : "Commission";

  async function handleSubmit() {
    setBusy(true);
    try {
      if (isContractor) {
        await apiPost("/api/contractor-agreement");
      }
      onAgreed();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed.", err) });
    } finally {
      setBusy(false);
      setChecked(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) { onOpenChange(false); setChecked(false); } }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Claim Job</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {/* Group banner — surfaced first so the share math below
                    reads as "shared with N workers" without surprising the
                    user mid-breakdown. */}
                {group && (
                  <Box p={2} bg="purple.50" borderWidth="1px" borderColor="purple.200" rounded="md">
                    <Text fontSize="sm" color="purple.800">
                      Claiming for <Text as="span" fontWeight="semibold">{group.name}</Text> ({group.activeWorkerCount} worker{group.activeWorkerCount === 1 ? "" : "s"}, observers don't share payout).
                      The payout is split evenly across active workers.
                    </Text>
                  </Box>
                )}

                {/* Payout breakdown */}
                {price > 0 && (
                  <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                    <Text fontSize="sm" fontWeight="medium" mb={2}>Payout Details</Text>
                    <VStack align="stretch" gap={1} fontSize="sm">
                      <HStack justify="space-between">
                        <Text color="fg.muted">Job Price</Text>
                        <Text fontWeight="medium">${basePrice.toFixed(2)}</Text>
                      </HStack>
                      {addonsTotal > 0 && (
                        <HStack justify="space-between">
                          <Text color="green.600">Add-ons</Text>
                          <Text color="green.600">+${addonsTotal.toFixed(2)}</Text>
                        </HStack>
                      )}
                      {expTotal > 0 && (
                        <HStack justify="space-between">
                          <Text color="orange.600">Expenses</Text>
                          <Text color="orange.600">−${expTotal.toFixed(2)}</Text>
                        </HStack>
                      )}
                      {pct > 0 && (
                        <HStack justify="space-between">
                          <Text color="orange.600">{label} ({pct}%)</Text>
                          <Text color="orange.600">−${deduction.toFixed(2)}</Text>
                        </HStack>
                      )}
                      <Box borderTopWidth="1px" borderColor="gray.300" pt={1} mt={1}>
                        <HStack justify="space-between">
                          <Text fontWeight="bold">
                            {group ? "Group Payout Pool" : "Your Payout"}
                          </Text>
                          <Badge colorPalette="green" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                            ${payoutPool.toFixed(2)}
                          </Badge>
                        </HStack>
                        {group && (
                          <HStack justify="space-between" mt={1}>
                            <Text fontWeight="bold" color="purple.800">
                              Each worker's share ({group.activeWorkerCount}-way split)
                            </Text>
                            <Badge colorPalette="purple" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                              ${perWorker.toFixed(2)}
                            </Badge>
                          </HStack>
                        )}
                      </Box>
                    </VStack>
                  </Box>
                )}

                <Text fontSize="xs" color="orange.500" fontStyle="italic">
                  Note: {group ? "Each worker's payout" : "This payout"} is an estimate based on current expenses. The final amount may change if expenses are added, updated, or removed before the job is completed.
                </Text>

                {/* Agreement terms */}
                {isContractor ? (
                  <Box>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      As an independent contractor, you acknowledge that you are responsible for your own
                      taxes, insurance, and compliance with all applicable laws. You are not an employee
                      and are not entitled to employee benefits. A {commissionPercent}% commission will be
                      deducted from your earnings on this job.
                    </Text>
                  </Box>
                ) : (
                  <Box>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      By claiming this job, you agree to complete the work as described. A {marginPercent}% business
                      margin will be applied to your earnings. Your payout is the piece rate shown above.
                    </Text>
                  </Box>
                )}

                <Checkbox.Root
                  checked={checked}
                  onCheckedChange={(e) => setChecked(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="sm">
                    {isContractor
                      ? "I accept the contractor terms and payout for this job"
                      : "I accept the payout terms for this job"}
                  </Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} loading={busy} disabled={!checked} colorPalette="yellow">
                  Claim Job
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
