"use client";

// Awaiting-client-payment worklist for the Super → Money → Payments tab.
//
// A "Request Payment" sends the client a pay link but creates no payment
// record — so a request the client never acts on can be silently forgotten.
// This section lists every sent-but-unpaid request, oldest first, flags the
// stale ones, and flags requests whose pay link has expired (the client can
// no longer pay even if they want to). Renders nothing when the list is empty.

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import PaymentCommsButtons from "@/src/ui/components/PaymentCommsButtons";

type OutstandingRow = {
  occurrenceId: string;
  jobId: string | null;
  startAt: string | null;
  requestedAt: string;
  daysSinceRequested: number;
  stale: boolean;
  linkExpiresAt: string | null;
  linkExpired: boolean;
  amount: number;
  property: string | null;
  client: string | null;
  claimer: { id: string; displayName: string | null; email: string | null } | null;
};

function agoLabel(days: number): string {
  if (days <= 0) return "Requested today";
  if (days === 1) return "Requested 1 day ago";
  return `Requested ${days} days ago`;
}

export default function OutstandingRequestsSection() {
  const [rows, setRows] = useState<OutstandingRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<OutstandingRow[]>("/api/admin/payment-requests/outstanding");
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load outstanding requests.", err) });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openJob(row: OutstandingRow) {
    window.dispatchEvent(
      new CustomEvent("open:jobsTabToServicesTabSearch", {
        detail: {
          q: "",
          forAdmin: true,
          entityId: `${row.jobId ?? ""}:${row.occurrenceId}`,
        },
      }),
    );
  }

  if (rows.length === 0 && !loading) return null;

  const staleCount = rows.filter((r) => r.stale).length;

  return (
    <Card.Root
      variant="outline"
      borderColor="purple.300"
      borderLeftWidth="4px"
      borderLeftColor="purple.500"
      mb={3}
      position="relative"
    >
      {loading && rows.length > 0 && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" borderRadius="md" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <Card.Body p={3}>
        <HStack mb={1} justify="space-between">
          <HStack gap={2}>
            <Text fontSize="sm" fontWeight="semibold">Awaiting payment</Text>
            <Badge size="sm" colorPalette="purple" variant="solid" px="2" borderRadius="full">
              {rows.length}
            </Badge>
            {staleCount > 0 && (
              <Badge size="sm" colorPalette="orange" variant="solid" px="2" borderRadius="full">
                {staleCount} stale
              </Badge>
            )}
          </HStack>
          <Button size="xs" variant="ghost" onClick={() => void load()} loading={loading}>
            <RefreshCw size={12} />
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.muted" mb={2}>
          Payment requests sent to a client but not yet paid. They enter the approval queue once the client pays.
        </Text>
        <VStack align="stretch" gap={2}>
          {rows.map((r) => (
            <Box
              key={r.occurrenceId}
              borderWidth="1px"
              borderColor={r.stale ? "orange.300" : "gray.200"}
              bg={r.stale ? "orange.50" : undefined}
              borderRadius="md"
              p={2}
            >
              <HStack justify="space-between" align="start" gap={2}>
                <VStack align="start" gap={1} minW={0} flex={1}>
                  <Text fontSize="sm" fontWeight="medium">
                    {r.property ?? "Job"}
                    {r.client ? ` — ${r.client}` : ""}
                  </Text>
                  <HStack gap={1.5} flexWrap="wrap">
                    <Badge size="sm" colorPalette={r.stale ? "orange" : "gray"}>
                      {agoLabel(r.daysSinceRequested)}
                    </Badge>
                    {r.linkExpired && (
                      <Badge size="sm" colorPalette="red">Pay link expired</Badge>
                    )}
                    <Text fontSize="xs" color="fg.muted">${r.amount.toFixed(2)}</Text>
                  </HStack>
                  {r.claimer && (
                    <Text fontSize="xs" color="fg.muted">
                      Claimer: {r.claimer.displayName ?? r.claimer.email ?? r.claimer.id.slice(-6)}
                    </Text>
                  )}
                </VStack>
              </HStack>
              <HStack gap={2} mt={2} flexWrap="wrap">
                <PaymentCommsButtons
                  occurrenceId={r.occurrenceId}
                  requestSentAt={r.requestedAt}
                  variant="outline"
                  onRequestCanceled={() => void load()}
                />
                <Button size="xs" variant="ghost" onClick={() => openJob(r)} title="Open the job">
                  <ExternalLink size={12} /> Open job
                </Button>
              </HStack>
            </Box>
          ))}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
