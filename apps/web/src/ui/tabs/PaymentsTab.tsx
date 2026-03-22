"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { apiGet, apiPatch, apiDelete } from "@/src/lib/api";
import { determineRoles, prettyStatus } from "@/src/lib/lib";
import {
  type TabPropsType,
  type WorkerPaymentItem,
  type PaymentListItem,
  type EquipmentCharge,
  PAYMENT_METHOD,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import StatusButton from "@/src/ui/components/StatusButton";
import { TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";

const methodFilterItems = [
  { label: "All Methods", value: "ALL" },
  ...PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m })),
];
const methodFilterCollection = createListCollection({ items: methodFilterItems });

// ─── Worker Payments ─────────────────────────────────────────────────

function WorkerPayments({ me, forAdmin }: { me: TabPropsType["me"]; forAdmin: boolean }) {
  const [items, setItems] = useState<WorkerPaymentItem[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const [res, charges] = await Promise.all([
        apiGet<{ items: WorkerPaymentItem[]; totalAmount: number }>(
          `/api/payments/mine${qs.toString() ? `?${qs}` : ""}`
        ),
        apiGet<EquipmentCharge[]>(
          `/api/payments/equipment-charges${qs.toString() ? `?${qs}` : ""}`
        ),
      ]);
      setItems(res.items ?? []);
      setTotalAmount(res.totalAmount ?? 0);
      setEquipCharges(charges ?? []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dateFrom, dateTo]);

  return (
    <Box w="full">
      <HStack mb={3} gap={2} align="center">
        <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">From:</Text>
        <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} maxW="160px" />
        <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">To:</Text>
        <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} maxW="160px" />
      </HStack>

      {(() => {
        const totalExpenses = items.reduce(
          (s, it) => s + (it.occurrence?.expenses ?? []).reduce((es, e) => es + e.cost, 0),
          0
        );
        const totalEquipCost = equipCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0);
        const totalDeductions = totalExpenses + totalEquipCost;
        const net = totalAmount - totalDeductions;
        return (
          <Box mb={3} p={3} bg="green.50" rounded="md">
            <Text fontSize="lg" fontWeight="bold" color="green.700">
              Total: ${totalAmount.toFixed(2)}
            </Text>
            {totalExpenses > 0 && (
              <Text fontSize="sm" color="orange.600">
                Expenses: −${totalExpenses.toFixed(2)}
              </Text>
            )}
            {totalEquipCost > 0 && (
              <Text fontSize="sm" color="orange.600">
                Equipment: −${totalEquipCost.toFixed(2)}
              </Text>
            )}
            {totalDeductions > 0 && (
              <Text fontSize="lg" fontWeight="bold" color="green.700">
                Net: ${net.toFixed(2)}
              </Text>
            )}
          </Box>
        );
      })()}

      {loading && <LoadingCenter />}
      {!loading && items.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      {items.length > 0 && (
        <Text fontSize="sm" fontWeight="semibold" mb={1}>Job Payments</Text>
      )}
      <VStack align="stretch" gap={2}>
        {items.map((item) => {
          const prop = item.occurrence?.job?.property;
          const client = prop?.client;
          return (
            <Card.Root key={item.splitId} variant="outline">
              <Card.Body py="3" px="4">
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {client.displayName}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin)}
                        />
                      )}
                    </HStack>
                    {item.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {new Date(item.occurrence.startAt).toLocaleDateString()}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {prettyStatus(item.payment.method)}
                      {item.payment.note ? ` — ${item.payment.note}` : ""}
                    </Text>
                    {item.payment.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        Paid on {new Date(item.payment.createdAt).toLocaleDateString()}
                      </Text>
                    )}
                    {item.payment.splits.length > 1 && (
                      <VStack align="start" gap={0} mt={0.5}>
                        {item.payment.splits.map((sp) => (
                          <Text key={sp.userId} fontSize="xs" color="fg.muted">
                            {sp.user?.displayName ?? sp.userId}: ${sp.amount.toFixed(2)}
                          </Text>
                        ))}
                      </VStack>
                    )}
                    {(() => {
                      const expTotal = (item.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      return expTotal > 0 ? (
                        <VStack align="start" gap={0} mt={0.5}>
                          {(item.occurrence?.expenses ?? []).map((exp) => (
                            <Text key={exp.id} fontSize="xs" color="orange.600">
                              Expense: ${exp.cost.toFixed(2)} — {exp.description}
                            </Text>
                          ))}
                        </VStack>
                      ) : null;
                    })()}
                  </VStack>
                  {(() => {
                    const expTotal = (item.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                    const net = item.myAmount - expTotal;
                    return (
                      <VStack align="end" gap={0}>
                        <Text fontWeight="bold" color="green.700" fontSize="lg">
                          ${item.myAmount.toFixed(2)}
                        </Text>
                        {item.payment.amountPaid !== item.myAmount && (
                          <Text fontSize="xs" color="fg.muted">
                            of ${item.payment.amountPaid.toFixed(2)} total
                          </Text>
                        )}
                        {expTotal > 0 && (
                          <>
                            <Text fontSize="xs" color="orange.600">
                              −${expTotal.toFixed(2)} expenses
                            </Text>
                            <Text fontWeight="bold" color="green.700" fontSize="sm">
                              Net: ${net.toFixed(2)}
                            </Text>
                          </>
                        )}
                      </VStack>
                    );
                  })()}
                </HStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>

      {equipCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {equipCharges.map((c) => (
              <Card.Root key={c.id} variant="outline">
                <Card.Body py="3" px="4">
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {c.equipment.brand ? `${c.equipment.brand} ` : ""}
                        {c.equipment.model ?? ""}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {c.rentalDays} day{c.rentalDays !== 1 ? "s" : ""}
                        {c.equipment.dailyRate ? ` @ $${c.equipment.dailyRate.toFixed(2)}/day` : ""}
                      </Text>
                      {c.releasedAt && (
                        <Text fontSize="xs" color="fg.muted">
                          Returned {new Date(c.releasedAt).toLocaleDateString()}
                        </Text>
                      )}
                    </VStack>
                    <Text fontWeight="bold" color="orange.600" fontSize="lg">
                      −${(c.rentalCost ?? 0).toFixed(2)}
                    </Text>
                  </HStack>
                </Card.Body>
              </Card.Root>
            ))}
          </VStack>
        </>
      )}
    </Box>
  );
}

// ─── Admin Payments ──────────────────────────────────────────────────

const editMethodItems = PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m }));
const editMethodCollection = createListCollection({ items: editMethodItems });

function AdminPayments({ forAdmin }: { forAdmin: boolean }) {
  const [items, setItems] = useState<PaymentListItem[]>([]);
  const [personTotals, setPersonTotals] = useState<Array<{ userId: string; displayName: string | null; total: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [methodFilter, setMethodFilter] = useState<string[]>(["ALL"]);
  const [personFilter, setPersonFilter] = useState("");

  // Edit state
  const [editPayment, setEditPayment] = useState<PaymentListItem | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState<string[]>([]);
  const [editNote, setEditNote] = useState("");
  const [editSplits, setEditSplits] = useState<Record<string, string>>({});
  const [editBusy, setEditBusy] = useState(false);
  const [editConfirm, setEditConfirm] = useState(false);

  // Delete state
  const [deletePayment, setDeletePayment] = useState<PaymentListItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Delete expense state
  const [deleteExpenseId, setDeleteExpenseId] = useState<string | null>(null);
  const [deleteExpenseBusy, setDeleteExpenseBusy] = useState(false);

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Build person collection from personTotals
  const personItems = useMemo(() => {
    const list = [{ label: "All People", value: "" }];
    personTotals.forEach((p) => {
      list.push({ label: p.displayName ?? p.userId, value: p.userId });
    });
    return list;
  }, [personTotals]);
  const personCollection = useMemo(
    () => createListCollection({ items: personItems }),
    [personItems]
  );

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      if (methodFilter[0] && methodFilter[0] !== "ALL") qs.set("method", methodFilter[0]);
      if (personFilter) qs.set("userId", personFilter);
      const eqs = new URLSearchParams();
      if (dateFrom) eqs.set("from", dateFrom);
      if (dateTo) eqs.set("to", dateTo);
      if (personFilter) eqs.set("userId", personFilter);
      const [res, charges] = await Promise.all([
        apiGet<{
          items: PaymentListItem[];
          personTotals: Array<{ userId: string; displayName: string | null; total: number }>;
        }>(`/api/admin/payments${qs.toString() ? `?${qs}` : ""}`),
        apiGet<EquipmentCharge[]>(
          `/api/admin/payments/equipment-charges${eqs.toString() ? `?${eqs}` : ""}`
        ),
      ]);
      setItems(res.items ?? []);
      setPersonTotals(res.personTotals ?? []);
      setEquipCharges(charges ?? []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dateFrom, dateTo, methodFilter, personFilter]);

  const grandTotal = useMemo(
    () => items.reduce((s, p) => s + p.amountPaid, 0),
    [items]
  );

  const totalExpenses = useMemo(
    () => items.reduce((s, p) => s + (p.occurrence?.expenses ?? []).reduce((es, e) => es + e.cost, 0), 0),
    [items]
  );

  function openEdit(p: PaymentListItem) {
    setEditPayment(p);
    setEditAmount(p.amountPaid.toFixed(2));
    setEditMethod([p.method]);
    setEditNote(p.note ?? "");
    const map: Record<string, string> = {};
    p.splits.forEach((sp) => { map[sp.userId] = sp.amount.toFixed(2); });
    setEditSplits(map);
    setEditConfirm(false);
  }

  async function handleEditSave() {
    if (!editPayment) return;
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid amount." });
      return;
    }
    if (!editConfirm) {
      setEditConfirm(true);
      return;
    }
    setEditBusy(true);
    try {
      const splits = editPayment.splits.map((sp) => ({
        userId: sp.userId,
        amount: parseFloat(editSplits[sp.userId] || "0"),
      }));
      await apiPatch(`/api/admin/payments/${editPayment.id}`, {
        amountPaid: amt,
        method: editMethod[0],
        note: editNote.trim() || null,
        splits,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Payment updated." });
      setEditPayment(null);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update payment failed.", err) });
    } finally {
      setEditBusy(false);
    }
  }

  async function handleDelete() {
    if (!deletePayment) return;
    setDeleteBusy(true);
    try {
      await apiDelete(`/api/admin/payments/${deletePayment.id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Payment deleted. Occurrence reverted to pending payment." });
      setDeletePayment(null);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete payment failed.", err) });
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <Box w="full">
      <HStack mb={3} gap={2} align="center" wrap="wrap">
        <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">From:</Text>
        <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} maxW="160px" />
        <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">To:</Text>
        <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} maxW="160px" />
        <Select.Root
          collection={methodFilterCollection}
          value={methodFilter}
          onValueChange={(e) => setMethodFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Method" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {methodFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={personCollection}
          value={[personFilter]}
          onValueChange={(e) => setPersonFilter(e.value[0] ?? "")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Person" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {personItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
      </HStack>

      <Box mb={3} p={3} bg="green.50" rounded="md">
        <Text fontSize="lg" fontWeight="bold" color="green.700">
          Total: ${grandTotal.toFixed(2)}
        </Text>
        {totalExpenses > 0 && (
          <Text fontSize="sm" color="orange.600">
            Expenses: −${totalExpenses.toFixed(2)}
          </Text>
        )}
        {(() => {
          const totalEquipCost = equipCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0);
          const totalDeductions = totalExpenses + totalEquipCost;
          return (
            <>
              {totalEquipCost > 0 && (
                <Text fontSize="sm" color="orange.600">
                  Equipment: −${totalEquipCost.toFixed(2)}
                </Text>
              )}
              {totalDeductions > 0 && (
                <Text fontSize="lg" fontWeight="bold" color="green.700">
                  Net: ${(grandTotal - totalDeductions).toFixed(2)}
                </Text>
              )}
            </>
          );
        })()}
        {personTotals.length > 1 && (
          <VStack align="start" gap={0} mt={1}>
            {personTotals.map((p) => (
              <Text key={p.userId} fontSize="sm" color="green.600">
                {p.displayName ?? p.userId}: ${p.total.toFixed(2)}
              </Text>
            ))}
          </VStack>
        )}
      </Box>

      {loading && <LoadingCenter />}
      {!loading && items.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      <VStack align="stretch" gap={2}>
        {items.map((p) => {
          const prop = p.occurrence?.job?.property;
          const client = prop?.client;
          return (
            <Card.Root key={p.id} variant="outline">
              <Card.Body py="3" px="4">
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {client.displayName}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin)}
                        />
                      )}
                    </HStack>
                    {p.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {new Date(p.occurrence.startAt).toLocaleDateString()}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {prettyStatus(p.method)}
                      {p.note ? ` — ${p.note}` : ""}
                    </Text>
                    {p.collectedBy && (
                      <Text fontSize="xs" color="fg.muted">
                        Collected by {p.collectedBy.displayName ?? "unknown"}
                      </Text>
                    )}
                    {p.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </Text>
                    )}
                    {p.splits && p.splits.length > 0 && (
                      <VStack align="start" gap={0} mt={0.5}>
                        {p.splits.map((sp) => (
                          <Text key={sp.userId} fontSize="xs" color="fg.muted">
                            {sp.user?.displayName ?? sp.userId}: ${sp.amount.toFixed(2)}
                          </Text>
                        ))}
                      </VStack>
                    )}
                    {(() => {
                      const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      return expTotal > 0 ? (
                        <VStack align="start" gap={0} mt={0.5}>
                          {(p.occurrence?.expenses ?? []).map((exp) => (
                            <HStack key={exp.id} gap={1} w="full">
                              <Text fontSize="xs" color="orange.600" flex="1">
                                Expense: ${exp.cost.toFixed(2)} — {exp.description}
                              </Text>
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="red"
                                onClick={() => setDeleteExpenseId(exp.id)}
                              >
                                ✕
                              </Button>
                            </HStack>
                          ))}
                        </VStack>
                      ) : null;
                    })()}
                  </VStack>
                  {(() => {
                    const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                    const net = p.amountPaid - expTotal;
                    return (
                      <VStack align="end" gap={0}>
                        <Text fontWeight="bold" color="green.700" fontSize="lg">
                          ${p.amountPaid.toFixed(2)}
                        </Text>
                        {expTotal > 0 && (
                          <>
                            <Text fontSize="xs" color="orange.600">
                              −${expTotal.toFixed(2)} expenses
                            </Text>
                            <Text fontWeight="bold" color="green.700" fontSize="sm">
                              Net: ${net.toFixed(2)}
                            </Text>
                          </>
                        )}
                      </VStack>
                    );
                  })()}
                </HStack>
              </Card.Body>
              <Card.Footer>
                <HStack gap={2} wrap="wrap">
                  <StatusButton
                    id="payment-edit"
                    itemId={p.id}
                    label="Edit"
                    onClick={async () => openEdit(p)}
                    variant="outline"
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                  <StatusButton
                    id="payment-delete"
                    itemId={p.id}
                    label="Delete"
                    onClick={async () => setDeletePayment(p)}
                    variant="outline"
                    colorPalette="red"
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                </HStack>
              </Card.Footer>
            </Card.Root>
          );
        })}
      </VStack>

      {equipCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {equipCharges.map((c) => (
              <Card.Root key={c.id} variant="outline">
                <Card.Body py="3" px="4">
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {c.equipment.brand ? `${c.equipment.brand} ` : ""}
                        {c.equipment.model ?? ""}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {c.user.displayName ?? c.user.email ?? c.user.id}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {c.rentalDays} day{c.rentalDays !== 1 ? "s" : ""}
                        {c.equipment.dailyRate ? ` @ $${c.equipment.dailyRate.toFixed(2)}/day` : ""}
                      </Text>
                      {c.releasedAt && (
                        <Text fontSize="xs" color="fg.muted">
                          Returned {new Date(c.releasedAt).toLocaleDateString()}
                        </Text>
                      )}
                    </VStack>
                    <Text fontWeight="bold" color="orange.600" fontSize="lg">
                      −${(c.rentalCost ?? 0).toFixed(2)}
                    </Text>
                  </HStack>
                </Card.Body>
              </Card.Root>
            ))}
          </VStack>
        </>
      )}

      {/* ── Edit Payment Dialog ── */}
      <Dialog.Root open={!!editPayment} onOpenChange={(e) => { if (!e.open) setEditPayment(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Edit Payment</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <div>
                    <Text mb="1">Amount Paid *</Text>
                    <CurrencyInput
                      value={editAmount}
                      onChange={(v) => {
                        setEditAmount(v);
                        setEditConfirm(false);
                        // Auto-recalculate even splits
                        const total = parseFloat(v);
                        if (!isNaN(total) && total > 0 && editPayment?.splits.length) {
                          const even = (total / editPayment.splits.length).toFixed(2);
                          const map: Record<string, string> = {};
                          editPayment.splits.forEach((sp) => { map[sp.userId] = even; });
                          setEditSplits(map);
                        }
                      }}
                      size="sm"
                    />
                  </div>
                  <div>
                    <Text mb="1">Payment Method *</Text>
                    <Select.Root
                      collection={editMethodCollection}
                      value={editMethod}
                      onValueChange={(e) => { setEditMethod(e.value); setEditConfirm(false); }}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Method" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {editMethodItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                  <div>
                    <Text mb="1">Note</Text>
                    <Input
                      value={editNote}
                      onChange={(e) => { setEditNote(e.target.value); setEditConfirm(false); }}
                      placeholder="e.g. check #1234"
                      size="sm"
                    />
                  </div>
                  {editPayment && editPayment.splits.length > 1 && (
                    <div>
                      <Text mb="1">Per-Person Split</Text>
                      <VStack align="stretch" gap={2}>
                        {editPayment.splits.map((sp) => (
                          <HStack key={sp.userId} gap={2}>
                            <Text fontSize="sm" flex="1" minW={0} truncate>
                              {sp.user?.displayName ?? sp.userId}
                            </Text>
                            <CurrencyInput
                              value={editSplits[sp.userId] || ""}
                              onChange={(v) => { setEditSplits((prev) => ({ ...prev, [sp.userId]: v })); setEditConfirm(false); }}
                              size="sm"
                            />
                          </HStack>
                        ))}
                      </VStack>
                    </div>
                  )}
                </VStack>
              </Dialog.Body>

              {editConfirm && (
                <VStack align="stretch" px="4" pb="2" gap={1}>
                  <Text fontSize="sm" color="orange.600" fontWeight="medium">
                    Are you sure you want to update this payment? This will change the recorded payment amounts.
                  </Text>
                </VStack>
              )}

              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setEditPayment(null)} disabled={editBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette={editConfirm ? "orange" : undefined}
                    onClick={handleEditSave}
                    loading={editBusy}
                    disabled={!editAmount || !editMethod[0]}
                  >
                    {editConfirm ? "Yes, Save Changes" : "Save"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* ── Delete Payment Confirmation ── */}
      <Dialog.Root open={!!deletePayment} onOpenChange={(e) => { if (!e.open) setDeletePayment(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Delete Payment</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>
                  Are you sure you want to delete this ${deletePayment?.amountPaid.toFixed(2)} payment?
                  The occurrence will be reverted to pending payment status.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setDeletePayment(null)} disabled={deleteBusy}>
                    Cancel
                  </Button>
                  <Button colorPalette="red" onClick={handleDelete} loading={deleteBusy}>
                    Delete Payment
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* ── Delete Expense Confirmation ── */}
      <Dialog.Root open={!!deleteExpenseId} onOpenChange={(e) => { if (!e.open) setDeleteExpenseId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Delete Expense</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>
                  This job is closed. Are you sure you want to delete this expense?
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setDeleteExpenseId(null)} disabled={deleteExpenseBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="red"
                    loading={deleteExpenseBusy}
                    onClick={async () => {
                      if (!deleteExpenseId) return;
                      setDeleteExpenseBusy(true);
                      try {
                        await apiDelete(`/api/admin/expenses/${deleteExpenseId}`);
                        publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
                        setDeleteExpenseId(null);
                        void load();
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete expense.", err) });
                      } finally {
                        setDeleteExpenseBusy(false);
                      }
                    }}
                  >
                    Delete Expense
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────

export default function PaymentsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail, forAdmin } = determineRoles(me, purpose);

  if (!isAvail) return <UnavailableNotice />;

  return forAdmin ? <AdminPayments forAdmin={forAdmin} /> : <WorkerPayments me={me} forAdmin={forAdmin} />;
}
