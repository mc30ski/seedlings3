"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Card,
  HStack,
  Input,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { determineRoles, prettyStatus } from "@/src/lib/lib";
import {
  type TabPropsType,
  type WorkerPaymentItem,
  type PaymentListItem,
  PAYMENT_METHOD,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
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

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const res = await apiGet<{ items: WorkerPaymentItem[]; totalAmount: number }>(
        `/api/payments/mine${qs.toString() ? `?${qs}` : ""}`
      );
      setItems(res.items ?? []);
      setTotalAmount(res.totalAmount ?? 0);
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

      <Box mb={3} p={3} bg="green.50" rounded="md">
        <Text fontSize="lg" fontWeight="bold" color="green.700">
          Total: ${totalAmount.toFixed(2)}
        </Text>
      </Box>

      {loading && <LoadingCenter />}
      {!loading && items.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      <VStack align="stretch" gap={2}>
        {items.map((item) => {
          const prop = item.occurrence?.job?.property;
          const client = prop?.client;
          const jobName = item.occurrence?.name;
          return (
            <Card.Root key={item.splitId} variant="outline">
              <Card.Body py="3" px="4">
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                    </Text>
                    <HStack gap={2} wrap="wrap">
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
                      {jobName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", jobName, forAdmin)}
                        />
                      )}
                    </HStack>
                    {jobName && (
                      <Text fontSize="sm" color="fg.muted">{jobName}</Text>
                    )}
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
                  </VStack>
                  <VStack align="end" gap={0}>
                    <Text fontWeight="bold" color="green.700" fontSize="lg">
                      ${item.myAmount.toFixed(2)}
                    </Text>
                    {item.payment.amountPaid !== item.myAmount && (
                      <Text fontSize="xs" color="fg.muted">
                        of ${item.payment.amountPaid.toFixed(2)} total
                      </Text>
                    )}
                  </VStack>
                </HStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>
    </Box>
  );
}

// ─── Admin Payments ──────────────────────────────────────────────────

function AdminPayments({ forAdmin }: { forAdmin: boolean }) {
  const [items, setItems] = useState<PaymentListItem[]>([]);
  const [personTotals, setPersonTotals] = useState<Array<{ userId: string; displayName: string | null; total: number }>>([]);
  const [loading, setLoading] = useState(false);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [methodFilter, setMethodFilter] = useState<string[]>(["ALL"]);
  const [personFilter, setPersonFilter] = useState("");

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
      const res = await apiGet<{
        items: PaymentListItem[];
        personTotals: Array<{ userId: string; displayName: string | null; total: number }>;
      }>(`/api/admin/payments${qs.toString() ? `?${qs}` : ""}`);
      setItems(res.items ?? []);
      setPersonTotals(res.personTotals ?? []);
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
          const jobName = p.occurrence?.name;
          return (
            <Card.Root key={p.id} variant="outline">
              <Card.Body py="3" px="4">
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0}>
                    <Text fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                    </Text>
                    <HStack gap={2} wrap="wrap">
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
                      {jobName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", jobName, forAdmin)}
                        />
                      )}
                    </HStack>
                    {jobName && (
                      <Text fontSize="sm" color="fg.muted">{jobName}</Text>
                    )}
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
                  </VStack>
                  <Text fontWeight="bold" color="green.700" fontSize="lg">
                    ${p.amountPaid.toFixed(2)}
                  </Text>
                </HStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>
    </Box>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────

export default function PaymentsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail, forAdmin } = determineRoles(me, purpose);

  if (!isAvail) return <UnavailableNotice />;

  return forAdmin ? <AdminPayments forAdmin={forAdmin} /> : <WorkerPayments me={me} forAdmin={forAdmin} />;
}
