"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { CreditCard, Download, Filter, List, Maximize2, RefreshCw, User, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { apiGet, apiPatch, apiDelete } from "@/src/lib/api";
import { determineRoles, prettyStatus, clientLabel, fmtDate } from "@/src/lib/lib";
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
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import StatusButton from "@/src/ui/components/StatusButton";
import { TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";

const methodFilterItems = [
  { label: "All Methods", value: "ALL" },
  ...PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m })),
];
const methodFilterCollection = createListCollection({ items: methodFilterItems });

function defaultDateFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const typeFilterItems = [
  { label: "All", value: "ALL" },
  { label: "Jobs", value: "JOBS" },
  { label: "Equipment", value: "EQUIPMENT" },
];
const typeFilterCollection = createListCollection({ items: typeFilterItems });

// ─── Worker Payments ─────────────────────────────────────────────────

function WorkerPayments({ me, forAdmin }: { me: TabPropsType["me"]; forAdmin: boolean }) {
  const [items, setItems] = useState<WorkerPaymentItem[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);

  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(todayStr);
  const [typeFilter, setTypeFilter] = usePersistedState<string[]>("pay_w_type", ["ALL"]);
  const [compact, setCompact] = usePersistedState("pay_w_compact", false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

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
      // Employees/trainees don't pay equipment rental charges
      const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
      setEquipCharges(isEmp ? [] : (charges ?? []));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dateFrom, dateTo]);

  const showJobs = typeFilter[0] === "ALL" || typeFilter[0] === "JOBS";
  const showEquip = typeFilter[0] === "ALL" || typeFilter[0] === "EQUIPMENT";

  const filteredItems = useMemo(() => {
    if (!q.trim()) return items;
    const qlc = q.trim().toLowerCase();
    return items.filter((p) => {
      const prop = p.occurrence?.job?.property;
      const arr = [
        prop?.displayName || "",
        prop?.client?.displayName || "",
        p.payment?.method || "",
        p.payment?.note || "",
        p.payment?.collectedBy?.displayName || "",
      ];
      return arr.some((v) => v.toLowerCase().includes(qlc));
    });
  }, [items, q]);

  const filteredCharges = useMemo(() => {
    if (!q.trim()) return equipCharges;
    const qlc = q.trim().toLowerCase();
    return equipCharges.filter((c) => {
      const arr = [c.equipment?.shortDesc || "", c.equipment?.brand || "", c.equipment?.model || ""];
      return arr.some((v) => v.toLowerCase().includes(qlc));
    });
  }, [equipCharges, q]);

  return (
    <Box w="full">
      <HStack mb={2} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="worker-payments-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={typeFilterCollection}
          value={typeFilter}
          onValueChange={(e) => setTypeFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {typeFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {typeFilter[0] !== "ALL" && (
        <Button
          variant="outline"
          size="xs"
          colorPalette="red"
          onClick={() => setTypeFilter(["ALL"])}
        >
          Clear
        </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => { setCompact((p) => !p); setExpandedCards(new Set()); }}
        >
          {compact ? <Maximize2 size={14} /> : <List size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw size={14} />
        </Button>
      </HStack>
      <HStack mb={2} gap={2} align="center">
        <DateInput value={dateFrom} onChange={(val) => setDateFrom(val)} />
        <Text fontSize="sm">–</Text>
        <DateInput value={dateTo} onChange={(val) => setDateTo(val)} />
      </HStack>
      {typeFilter[0] !== "ALL" && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          <Badge size="sm" colorPalette="purple" variant="solid">
            {typeFilterItems.find((i) => i.value === typeFilter[0])?.label}
          </Badge>
        </HStack>
      )}

      {(() => {
        const totalExpenses = showJobs ? items.reduce(
          (s, it) => s + (it.occurrence?.expenses ?? []).reduce((es, e) => es + e.cost, 0),
          0
        ) : 0;
        const totalFees = showJobs ? items.reduce(
          (s, it) => s + (it.payment.platformFeeAmount ?? 0),
          0
        ) : 0;
        const totalMargins = showJobs ? items.reduce(
          (s, it) => s + (it.payment.businessMarginAmount ?? 0),
          0
        ) : 0;
        const totalEquipCost = showEquip ? equipCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0) : 0;
        const visibleTotal = showJobs ? totalAmount : 0;
        const totalDeductions = totalExpenses + totalEquipCost + totalFees + totalMargins;
        const net = visibleTotal - totalDeductions;
        return (
          <Box mb={3} p={3} bg="green.50" rounded="md">
            {showJobs && (
              <Text fontSize="lg" fontWeight="bold" color="green.700">
                Total: ${visibleTotal.toFixed(2)}
              </Text>
            )}
            {totalExpenses > 0 && (
              <Text fontSize="sm" color="orange.600">
                Expenses: −${totalExpenses.toFixed(2)}
              </Text>
            )}
            {totalFees > 0 && (
              <Text fontSize="sm" color="orange.600">
                Commission: −${totalFees.toFixed(2)}
              </Text>
            )}
            {totalMargins > 0 && (
              <Text fontSize="sm" color="orange.600">
                Business Margin: −${totalMargins.toFixed(2)}
              </Text>
            )}
            {totalEquipCost > 0 && (
              <Text fontSize="sm" color="orange.600">
                Equipment: −${totalEquipCost.toFixed(2)}
              </Text>
            )}
            {totalDeductions > 0 && showJobs && (
              <Text fontSize="lg" fontWeight="bold" color="green.700">
                Net: ${net.toFixed(2)}
              </Text>
            )}
            {!showJobs && totalEquipCost > 0 && (
              <Text fontSize="lg" fontWeight="bold" color="orange.600">
                Equipment Total: −${totalEquipCost.toFixed(2)}
              </Text>
            )}
          </Box>
        );
      })()}

      {loading && items.length === 0 && equipCharges.length === 0 && <LoadingCenter />}
      <Box position="relative">
        {loading && (items.length > 0 || equipCharges.length > 0) && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      {showJobs && filteredItems.length === 0 && filteredCharges.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      {showJobs && filteredItems.length > 0 && (
        <Text fontSize="sm" fontWeight="semibold" mb={1}>Job Payments</Text>
      )}
      {showJobs && <VStack align="stretch" gap={2}>
        {filteredItems.map((item) => {
          const prop = item.occurrence?.job?.property;
          const client = prop?.client;
          const cardId = `jp-${item.splitId}`;
          const isCardCompact = compact && !expandedCards.has(cardId);
          const toggleCard = compact ? () => setExpandedCards((prev) => {
            const next = new Set(prev);
            next.has(cardId) ? next.delete(cardId) : next.add(cardId);
            return next;
          }) : undefined;
          return (
            <Card.Root
              key={item.splitId}
              variant="outline"
              css={compact ? { cursor: "pointer" } : undefined}
              onClick={(e: any) => {
                if (!toggleCard) return;
                if ((e.target as HTMLElement)?.closest?.("a, button")) return;
                toggleCard();
              }}
            >
              <Card.Body py="3" px="4">
                {isCardCompact ? (
                  <HStack justify="space-between" align="center">
                    <Text fontSize="md" fontWeight="semibold" truncate>
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && <> — {clientLabel(client.displayName)}</>}
                    </Text>
                    <HStack gap={2} flexShrink={0}>
                      <Badge size="sm" colorPalette="gray">{prettyStatus(item.payment.method)}</Badge>
                      <Text fontWeight="bold" color="green.700" fontSize="lg">
                        ${item.myAmount.toFixed(2)}
                      </Text>
                    </HStack>
                  </HStack>
                ) : (
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {clientLabel(client.displayName)}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin, prop.id)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin, client.id)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin, item.occurrence?.job?.id)}
                        />
                      )}
                    </HStack>
                    {item.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(item.occurrence.startAt)}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {prettyStatus(item.payment.method)}
                      {item.payment.note ? ` — ${item.payment.note}` : ""}
                    </Text>
                    {item.payment.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        Paid on {fmtDate(item.payment.createdAt)}
                      </Text>
                    )}
                    {item.payment.splits.length > 1 && (
                      <VStack align="start" gap={0} mt={0.5}>
                        {item.payment.splits.map((sp) => (
                          <Text key={sp.userId} fontSize="xs" color="fg.muted">
                            {sp.user?.displayName ?? sp.user?.email ?? sp.userId}: ${sp.amount.toFixed(2)}
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
                          <Text fontSize="xs" color="orange.600">
                            −${expTotal.toFixed(2)} expenses
                          </Text>
                        )}
                        {item.payment.platformFeeAmount != null && item.payment.platformFeeAmount > 0 && (
                          <Text fontSize="xs" color="orange.600">
                            −${item.payment.platformFeeAmount.toFixed(2)} commission ({item.payment.platformFeePercent}%)
                          </Text>
                        )}
                        {item.payment.businessMarginAmount != null && item.payment.businessMarginAmount > 0 && (
                          <Text fontSize="xs" color="orange.600">
                            −${item.payment.businessMarginAmount.toFixed(2)} margin ({item.payment.businessMarginPercent}%)
                          </Text>
                        )}
                        {(expTotal > 0 || (item.payment.platformFeeAmount ?? 0) > 0 || (item.payment.businessMarginAmount ?? 0) > 0) && (
                          <Text fontWeight="bold" color="green.700" fontSize="sm">
                            Net: ${(net - (item.payment.platformFeeAmount ?? 0) - (item.payment.businessMarginAmount ?? 0)).toFixed(2)}
                          </Text>
                        )}
                      </VStack>
                    );
                  })()}
                </HStack>
                )}
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>}

      {showEquip && filteredCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {filteredCharges.map((c) => {
              const cardId = `ec-${c.id}`;
              const isCardCompact = compact && !expandedCards.has(cardId);
              const toggleCard = compact ? () => setExpandedCards((prev) => {
                const next = new Set(prev);
                next.has(cardId) ? next.delete(cardId) : next.add(cardId);
                return next;
              }) : undefined;
              return (
              <Card.Root
                key={c.id}
                variant="outline"
                css={compact ? { cursor: "pointer" } : undefined}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const tag = (e.target as HTMLElement)?.closest?.("a, button");
                  if (tag) return;
                  toggleCard();
                }}
              >
                <Card.Body py="3" px="4">
                  {isCardCompact ? (
                    <HStack justify="space-between" align="center">
                      <Text fontSize="md" fontWeight="semibold" truncate>
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontWeight="bold" color="orange.600" fontSize="lg" flexShrink={0}>
                        −${(c.rentalCost ?? 0).toFixed(2)}
                      </Text>
                    </HStack>
                  ) : (
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
                          Returned {fmtDate(c.releasedAt)}
                        </Text>
                      )}
                    </VStack>
                    <Text fontWeight="bold" color="orange.600" fontSize="lg">
                      −${(c.rentalCost ?? 0).toFixed(2)}
                    </Text>
                  </HStack>
                  )}
                </Card.Body>
              </Card.Root>
              );
            })}
          </VStack>
        </>
      )}
      </Box>
    </Box>
  );
}

// ─── Admin Payments ──────────────────────────────────────────────────

const editMethodItems = PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m }));
const editMethodCollection = createListCollection({ items: editMethodItems });

function AdminPayments({ forAdmin }: { forAdmin: boolean }) {
  const [items, setItems] = useState<PaymentListItem[]>([]);
  const [personTotals, setPersonTotals] = useState<Array<{ userId: string; displayName: string | null; total: number }>>([]);
  const [totalPlatformFees, setTotalPlatformFees] = useState(0);
  const [totalBusinessMargin, setTotalBusinessMargin] = useState(0);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);

  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(todayStr);
  const [methodFilter, setMethodFilter] = usePersistedState<string[]>("pay_a_method", ["ALL"]);
  const [personFilter, setPersonFilter] = usePersistedState<string[]>("pay_a_persons", []);
  const [personDropOpen, setPersonDropOpen] = useState(false);
  const [personSearch, setPersonSearch] = useState("");
  const personDropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!personDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (personDropRef.current && !personDropRef.current.contains(e.target as Node)) {
        setPersonDropOpen(false);
        setPersonSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [personDropOpen]);
  const [typeFilter, setTypeFilter] = usePersistedState<string[]>("pay_a_type", ["ALL"]);
  const [compact, setCompact] = usePersistedState("pay_a_compact", false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

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

  // Fetch all workers for the person search
  const [allWorkers, setAllWorkers] = useState<Array<{ id: string; displayName?: string | null; email?: string | null }>>([]);
  useEffect(() => {
    apiGet<any[]>("/api/workers")
      .then((list) => setAllWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  const personItems = useMemo(() => {
    return allWorkers.map((w) => ({
      label: w.displayName || w.email || w.id,
      value: w.id,
    }));
  }, [allWorkers]);
  const personNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of allWorkers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [allWorkers]);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      if (methodFilter[0] && methodFilter[0] !== "ALL") qs.set("method", methodFilter[0]);
      const eqs = new URLSearchParams();
      if (dateFrom) eqs.set("from", dateFrom);
      if (dateTo) eqs.set("to", dateTo);
      const [res, charges] = await Promise.all([
        apiGet<{
          items: PaymentListItem[];
          personTotals: Array<{ userId: string; displayName: string | null; total: number }>;
          totalPlatformFees: number;
          totalBusinessMargin: number;
        }>(`/api/admin/payments${qs.toString() ? `?${qs}` : ""}`),
        apiGet<EquipmentCharge[]>(
          `/api/admin/payments/equipment-charges${eqs.toString() ? `?${eqs}` : ""}`
        ),
      ]);
      setItems(res.items ?? []);
      setPersonTotals(res.personTotals ?? []);
      setTotalPlatformFees(res.totalPlatformFees ?? 0);
      setTotalBusinessMargin(res.totalBusinessMargin ?? 0);
      setEquipCharges(charges ?? []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dateFrom, dateTo, methodFilter]);

  const grandTotal = useMemo(
    () => items.reduce((s, p) => s + p.amountPaid, 0),
    [items]
  );

  const totalExpenses = useMemo(
    () => items.reduce((s, p) => s + (p.occurrence?.expenses ?? []).reduce((es, e) => es + e.cost, 0), 0),
    [items]
  );

  const filteredItems = useMemo(() => {
    let rows = items;
    // Person filter (multi-select)
    if (personFilter.length > 0) {
      const ids = new Set(personFilter);
      rows = rows.filter((p) => p.splits.some((sp) => ids.has(sp.userId)));
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((p) => {
        const prop = p.occurrence?.job?.property;
        const arr = [
          prop?.displayName || "",
          prop?.client?.displayName || "",
          p.method || "",
          p.note || "",
          ...p.splits.map((sp) => sp.user?.displayName || sp.user?.email || ""),
        ];
        return arr.some((v) => v.toLowerCase().includes(qlc));
      });
    }
    return rows;
  }, [items, q, personFilter]);

  const filteredCharges = useMemo(() => {
    let rows = equipCharges;
    if (personFilter.length > 0) {
      const ids = new Set(personFilter);
      rows = rows.filter((c) => ids.has(c.userId));
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((c) => {
        const arr = [c.equipment?.shortDesc || "", c.equipment?.brand || "", c.equipment?.model || ""];
        return arr.some((v) => v.toLowerCase().includes(qlc));
      });
    }
    return rows;
  }, [equipCharges, q, personFilter]);

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
      <HStack mb={2} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="admin-payments-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={typeFilterCollection}
          value={typeFilter}
          onValueChange={(e) => setTypeFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {typeFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={methodFilterCollection}
          value={methodFilter}
          onValueChange={(e) => setMethodFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
              <CreditCard size={14} />
              <Select.Indicator display="none" />
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
        <Box ref={personDropRef} position="relative" css={{ flex: "0 0 auto" }}>
          <Input
            size="sm"
            w="200px"
            placeholder={personFilter.length > 0
              ? personFilter.map((id) => personNameMap[id] || "Loading…").join(", ")
              : "All Workers"}
            value={personSearch}
            onChange={(e) => {
              setPersonSearch(e.target.value);
              if (!personDropOpen) setPersonDropOpen(true);
            }}
            onFocus={() => {
              setPersonDropOpen(true);
              setPersonSearch("");
            }}
          />
          {personDropOpen && (() => {
            const searchLc = personSearch.toLowerCase();
            const filtered = personSearch
              ? personItems.filter((it) => it.label.toLowerCase().includes(searchLc))
              : personItems;
            const limited = filtered.slice(0, 10);
            const hasMore = filtered.length > 10;
            return (
              <Box
                position="fixed"
                zIndex={9999}
                bg="white"
                borderWidth="1px"
                borderColor="gray.200"
                rounded="md"
                shadow="lg"
                w="240px"
                mt="1"
                ref={(el: HTMLDivElement | null) => {
                  if (el && personDropRef.current) {
                    const rect = personDropRef.current.getBoundingClientRect();
                    el.style.top = `${rect.bottom + 4}px`;
                    el.style.left = `${rect.left}px`;
                  }
                }}
              >
                <Box maxH="250px" overflowY="auto">
                  {limited.map((it) => (
                    <Box
                      key={it.value}
                      px="3"
                      py="1.5"
                      fontSize="sm"
                      cursor="pointer"
                      bg={personFilter.includes(it.value) ? "teal.50" : undefined}
                      _hover={{ bg: "gray.100" }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setPersonFilter((prev) =>
                          prev.includes(it.value)
                            ? prev.filter((id) => id !== it.value)
                            : [...prev, it.value]
                        );
                      }}
                    >
                      <HStack gap={2}>
                        <Text flex="1">{it.label}</Text>
                        {personFilter.includes(it.value) && <Text color="teal.500" fontWeight="bold">✓</Text>}
                      </HStack>
                    </Box>
                  ))}
                  {hasMore && !personSearch && (
                    <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                      …{filtered.length - 10} more — type to search
                    </Text>
                  )}
                  {filtered.length === 0 && (
                    <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
                  )}
                </Box>
              </Box>
            );
          })()}
        </Box>
        {!(typeFilter[0] === "ALL" && methodFilter[0] === "ALL" && personFilter.length === 0) && (
        <Button
          variant="outline"
          size="xs"
          colorPalette="red"
          onClick={() => {
            setTypeFilter(["ALL"]);
            setMethodFilter(["ALL"]);
            setPersonFilter([]);
            setPersonSearch("");
          }}
        >
          Clear
        </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => { setCompact((p) => !p); setExpandedCards(new Set()); }}
        >
          {compact ? <Maximize2 size={14} /> : <List size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          title="Export payment data (CSV)"
          onClick={() => {
            const rows: string[] = [];
            rows.push("Worker,Type,Job,Date,Amount,Expenses,Commission,Margin,Payout,Method");
            for (const p of filteredItems) {
              const prop = p.occurrence?.job?.property;
              const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
              const splitTotal = p.splits.reduce((s, sp) => s + sp.amount, 0);
              const fee = p.platformFeeAmount ?? 0;
              const bMargin = (p as any).businessMarginAmount ?? 0;
              const feeableSplitTotal = p.splits.filter((sp: any) => sp.user?.workerType !== "EMPLOYEE" && sp.user?.workerType !== "TRAINEE").reduce((s, sp) => s + sp.amount, 0);
              const empSplitTotal = p.splits.filter((sp: any) => sp.user?.workerType === "EMPLOYEE" || sp.user?.workerType === "TRAINEE").reduce((s, sp) => s + sp.amount, 0);
              for (const sp of p.splits) {
                const ratio = splitTotal > 0 ? sp.amount / splitTotal : 0;
                const expShare = expTotal * ratio;
                const isEmp = (sp.user as any)?.workerType === "EMPLOYEE" || (sp.user as any)?.workerType === "TRAINEE";
                const feeShare = !isEmp && feeableSplitTotal > 0 ? fee * (sp.amount / feeableSplitTotal) : 0;
                const marginShare = isEmp && empSplitTotal > 0 ? bMargin * (sp.amount / empSplitTotal) : 0;
                const payout = sp.amount - expShare - feeShare - marginShare;
                const name = (sp.user?.displayName ?? sp.user?.email ?? sp.userId).replace(/,/g, "");
                const wType = (sp.user as any)?.workerType ?? "UNCLASSIFIED";
                const jobName = `${prop?.displayName ?? ""} - ${prop?.client?.displayName ?? ""}`.replace(/,/g, "");
                const date = p.createdAt ? fmtDate(p.createdAt) : "";
                rows.push(`${name},${wType},${jobName},${date},${sp.amount.toFixed(2)},${expShare.toFixed(2)},${feeShare.toFixed(2)},${marginShare.toFixed(2)},${payout.toFixed(2)},${prettyStatus(p.method)}`);
              }
            }
            const blob = new Blob([rows.join("\n")], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `payments-${dateFrom || "all"}-to-${dateTo || "all"}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={14} />
        </Button>
      </HStack>
      <HStack mb={2} gap={2} align="center">
        <DateInput value={dateFrom} onChange={(val) => setDateFrom(val)} />
        <Text fontSize="sm">–</Text>
        <DateInput value={dateTo} onChange={(val) => setDateTo(val)} />
      </HStack>
      {(typeFilter[0] !== "ALL" || methodFilter[0] !== "ALL" || personFilter.length > 0) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {typeFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {typeFilterItems.find((i) => i.value === typeFilter[0])?.label}
            </Badge>
          )}
          {methodFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {methodFilterItems.find((i) => i.value === methodFilter[0])?.label}
            </Badge>
          )}
          {personFilter.map((id) => (
            <Badge key={id} size="sm" colorPalette="teal" variant="solid">
              {personNameMap[id] || "Loading…"}
            </Badge>
          ))}
        </HStack>
      )}

      {(() => {
        const showJobs = typeFilter[0] === "ALL" || typeFilter[0] === "JOBS";
        const showEquip = typeFilter[0] === "ALL" || typeFilter[0] === "EQUIPMENT";
        const visibleExpenses = showJobs ? totalExpenses : 0;
        const totalEquipCost = showEquip ? equipCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0) : 0;
        const visibleTotal = showJobs ? grandTotal : 0;
        const totalDeductions = visibleExpenses + totalEquipCost;
        const net = visibleTotal - totalDeductions;
        return (
      <Box mb={3} p={3} bg="green.50" rounded="md">
        {showJobs && (
        <Text fontSize="lg" fontWeight="bold" color="green.700">
          Total: ${visibleTotal.toFixed(2)}
        </Text>
        )}
        {visibleExpenses > 0 && (
          <Text fontSize="sm" color="orange.600">
            Expenses: −${visibleExpenses.toFixed(2)}
          </Text>
        )}
              {totalEquipCost > 0 && (
                <Text fontSize="sm" color="orange.600">
                  Equipment: −${totalEquipCost.toFixed(2)}
                </Text>
              )}
              {totalDeductions > 0 && showJobs && (
                <Text fontSize="lg" fontWeight="bold" color="green.700">
                  Net: ${net.toFixed(2)}
                </Text>
              )}
              {!showJobs && totalEquipCost > 0 && (
                <Text fontSize="lg" fontWeight="bold" color="orange.600">
                  Equipment Total: −${totalEquipCost.toFixed(2)}
                </Text>
              )}
        {showJobs && (totalPlatformFees > 0 || totalBusinessMargin > 0) && (
          <VStack align="start" gap={0} mt={1}>
            {totalPlatformFees > 0 && (
              <Text fontSize="sm" fontWeight="medium" color="blue.600">
                Contractor Commission: ${totalPlatformFees.toFixed(2)}
              </Text>
            )}
            {totalBusinessMargin > 0 && (
              <Text fontSize="sm" fontWeight="medium" color="blue.600">
                Employee Business Margin: ${totalBusinessMargin.toFixed(2)}
              </Text>
            )}
            <Text fontSize="sm" fontWeight="bold" color="blue.700">
              Total Revenue: ${(totalPlatformFees + totalBusinessMargin).toFixed(2)}
            </Text>
          </VStack>
        )}
        {showJobs && personTotals.length > 0 && (
          <VStack align="start" gap={0} mt={1}>
            <Text fontSize="xs" color="fg.muted" fontWeight="medium">Per-person (net of expenses & fees):</Text>
            {personTotals.map((p) => (
              <Text key={p.userId} fontSize="sm" color="green.600">
                {p.displayName ?? p.userId}: ${p.total.toFixed(2)}
              </Text>
            ))}
          </VStack>
        )}
      </Box>
        );
      })()}

      {loading && items.length === 0 && equipCharges.length === 0 && <LoadingCenter />}
      <Box position="relative">
        {loading && (items.length > 0 || equipCharges.length > 0) && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      {(typeFilter[0] === "ALL" || typeFilter[0] === "JOBS") && filteredItems.length === 0 && filteredCharges.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      {(typeFilter[0] === "ALL" || typeFilter[0] === "JOBS") && <VStack align="stretch" gap={2}>
        {filteredItems.map((p) => {
          const prop = p.occurrence?.job?.property;
          const client = prop?.client;
          const cardId = `ap-${p.id}`;
          const isCardCompact = compact && !expandedCards.has(cardId);
          const toggleCard = compact ? () => setExpandedCards((prev) => {
            const next = new Set(prev);
            next.has(cardId) ? next.delete(cardId) : next.add(cardId);
            return next;
          }) : undefined;
          return (
            <Card.Root
              key={p.id}
              variant="outline"
              css={compact ? { cursor: "pointer" } : undefined}
              onClick={(e: any) => {
                if (!toggleCard) return;
                if ((e.target as HTMLElement)?.closest?.("a, button")) return;
                toggleCard();
              }}
            >
              <Card.Body py="3" px="4">
                {isCardCompact ? (
                  <HStack justify="space-between" align="center">
                    <Text fontSize="md" fontWeight="semibold" truncate>
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && <> — {clientLabel(client.displayName)}</>}
                    </Text>
                    <HStack gap={2} flexShrink={0}>
                      <Badge size="sm" colorPalette="gray">{prettyStatus(p.method)}</Badge>
                      <Text fontWeight="bold" color="green.700" fontSize="lg">
                        ${p.amountPaid.toFixed(2)}
                      </Text>
                    </HStack>
                  </HStack>
                ) : (
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {clientLabel(client.displayName)}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin, prop.id)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin, client.id)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin, p.occurrence?.job?.id)}
                        />
                      )}
                    </HStack>
                    {p.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(p.occurrence.startAt)}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {prettyStatus(p.method)}
                      {p.note ? ` — ${p.note}` : ""}
                    </Text>
                    {p.collectedBy && (
                      <Text fontSize="xs" color="fg.muted">
                        Collected by {p.collectedBy.displayName ?? (p.collectedBy as any).email ?? "unknown"}
                      </Text>
                    )}
                    {p.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(p.createdAt)}
                      </Text>
                    )}
                    {p.splits && p.splits.length > 0 && (() => {
                      const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      const fee = p.platformFeeAmount ?? 0;
                      const margin = (p as any).businessMarginAmount ?? 0;
                      const splitTotal = p.splits.reduce((s, sp) => s + sp.amount, 0);
                      const feeableSplitTotal = p.splits
                        .filter((sp: any) => sp.user?.workerType !== "EMPLOYEE" && sp.user?.workerType !== "TRAINEE")
                        .reduce((s, sp) => s + sp.amount, 0);
                      const employeeSplitTotal = p.splits
                        .filter((sp: any) => sp.user?.workerType === "EMPLOYEE" || sp.user?.workerType === "TRAINEE")
                        .reduce((s, sp) => s + sp.amount, 0);
                      return (
                        <VStack align="start" gap={1} mt={0.5}>
                          {p.splits.map((sp) => {
                            const ratio = splitTotal > 0 ? sp.amount / splitTotal : 0;
                            const expShare = expTotal * ratio;
                            const isFeeable = (sp.user as any)?.workerType !== "EMPLOYEE" && (sp.user as any)?.workerType !== "TRAINEE";
                            const isEmployee = (sp.user as any)?.workerType === "EMPLOYEE" || (sp.user as any)?.workerType === "TRAINEE";
                            const feeShare = isFeeable && feeableSplitTotal > 0 ? fee * (sp.amount / feeableSplitTotal) : 0;
                            const marginShare = isEmployee && employeeSplitTotal > 0 ? margin * (sp.amount / employeeSplitTotal) : 0;
                            const personNet = sp.amount - expShare - feeShare - marginShare;
                            const hasDeductions = expShare > 0 || feeShare > 0 || marginShare > 0;
                            return (
                              <Box key={sp.userId} fontSize="xs">
                                <Text fontWeight="medium" color="fg.muted">
                                  {sp.user?.displayName ?? sp.user?.email ?? sp.userId}: ${sp.amount.toFixed(2)}
                                </Text>
                                {hasDeductions && (
                                  <Box pl={2}>
                                    {expShare > 0 && (
                                      <Text color="orange.600">−${expShare.toFixed(2)} expenses</Text>
                                    )}
                                    {feeShare > 0 && (
                                      <Text color="orange.600">−${feeShare.toFixed(2)} commission</Text>
                                    )}
                                    {marginShare > 0 && (
                                      <Text color="orange.600">−${marginShare.toFixed(2)} margin</Text>
                                    )}
                                    <Text fontWeight="medium" color="green.600">
                                      Net: ${personNet.toFixed(2)}
                                    </Text>
                                  </Box>
                                )}
                              </Box>
                            );
                          })}
                        </VStack>
                      );
                    })()}
                    {(() => {
                      const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      return expTotal > 0 ? (
                        <VStack align="start" gap={0} mt={0.5}>
                          {(p.occurrence?.expenses ?? []).map((exp) => (
                            <HStack key={exp.id} gap={1} w="full">
                              <Text fontSize="xs" color="orange.600" flex="1">
                                Expense: ${exp.cost.toFixed(2)} — {exp.description}
                              </Text>
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
                          <Text fontSize="xs" color="orange.600">
                            −${expTotal.toFixed(2)} expenses
                          </Text>
                        )}
                        {p.platformFeeAmount != null && p.platformFeeAmount > 0 && (
                          <Text fontSize="xs" color="orange.600">
                            −${p.platformFeeAmount.toFixed(2)} fee ({p.platformFeePercent}%)
                          </Text>
                        )}
                        {(expTotal > 0 || (p.platformFeeAmount ?? 0) > 0) && (
                          <Text fontWeight="bold" color="green.700" fontSize="sm">
                            Net: ${(net - (p.platformFeeAmount ?? 0)).toFixed(2)}
                          </Text>
                        )}
                      </VStack>
                    );
                  })()}
                </HStack>
                )}
              </Card.Body>
              {!isCardCompact && (
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
              )}
            </Card.Root>
          );
        })}
      </VStack>}

      {(typeFilter[0] === "ALL" || typeFilter[0] === "EQUIPMENT") && filteredCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {filteredCharges.map((c) => {
              const cardId = `aec-${c.id}`;
              const isCardCompact = compact && !expandedCards.has(cardId);
              const isEmpCharge = (c.user as any).workerType === "EMPLOYEE" || (c.user as any).workerType === "TRAINEE";
              const toggleCard = compact ? () => setExpandedCards((prev) => {
                const next = new Set(prev);
                next.has(cardId) ? next.delete(cardId) : next.add(cardId);
                return next;
              }) : undefined;
              return (
              <Card.Root
                key={c.id}
                variant="outline"
                css={compact ? { cursor: "pointer" } : undefined}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const tag = (e.target as HTMLElement)?.closest?.("a, button");
                  if (tag) return;
                  toggleCard();
                }}
              >
                <Card.Body py="3" px="4">
                  {isCardCompact ? (
                    <HStack justify="space-between" align="center">
                      <Text fontSize="md" fontWeight="semibold" truncate>
                        {c.equipment.shortDesc}
                      </Text>
                      <HStack gap={1} flexShrink={0}>
                        <Text fontSize="xs" color="fg.muted">{c.user.displayName ?? c.user.email ?? c.user.id}</Text>
                        {isEmpCharge ? (
                          <Badge colorPalette="green" variant="subtle" fontSize="xs">No charge</Badge>
                        ) : (
                          <Text fontWeight="bold" color="orange.600" fontSize="lg">
                            −${(c.rentalCost ?? 0).toFixed(2)}
                          </Text>
                        )}
                      </HStack>
                    </HStack>
                  ) : (
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {c.equipment.brand ? `${c.equipment.brand} ` : ""}
                        {c.equipment.model ?? ""}
                      </Text>
                      <HStack gap={1} fontSize="xs">
                        <Text color="fg.muted">
                          {c.user.displayName ?? c.user.email ?? c.user.id}
                        </Text>
                        <Badge size="xs" colorPalette={(c.user as any).workerType === "EMPLOYEE" || (c.user as any).workerType === "TRAINEE" ? "blue" : "orange"} variant="subtle">
                          {(c.user as any).workerType === "EMPLOYEE" ? "W-2" : (c.user as any).workerType === "TRAINEE" ? "Trainee" : (c.user as any).workerType === "CONTRACTOR" ? "1099" : "Unclassified"}
                        </Badge>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {c.rentalDays} day{c.rentalDays !== 1 ? "s" : ""}
                        {c.equipment.dailyRate ? ` @ $${c.equipment.dailyRate.toFixed(2)}/day` : ""}
                      </Text>
                      {c.releasedAt && (
                        <Text fontSize="xs" color="fg.muted">
                          Returned {fmtDate(c.releasedAt)}
                        </Text>
                      )}
                    </VStack>
                    {(c.user as any).workerType === "EMPLOYEE" || (c.user as any).workerType === "TRAINEE" ? (
                      <Badge colorPalette="green" variant="subtle" fontSize="sm" flexShrink={0}>
                        No charge
                      </Badge>
                    ) : (
                      <Text fontWeight="bold" color="orange.600" fontSize="lg" flexShrink={0}>
                        −${(c.rentalCost ?? 0).toFixed(2)}
                      </Text>
                    )}
                  </HStack>
                  )}
                </Card.Body>
              </Card.Root>
              );
            })}
          </VStack>
        </>
      )}
      </Box>

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
                              {sp.user?.displayName ?? sp.user?.email ?? sp.userId}
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
