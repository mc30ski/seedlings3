"use client";

import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import { Calendar, CheckCircle2, ChevronDown, ChevronUp, SkipForward, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDateWeekday } from "@/src/lib/lib";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type ChangeRequest = {
  id: string;
  kind: "RESCHEDULE" | "SKIP";
  status: "PENDING" | "APPROVED" | "DENIED" | "CANCELED";
  proposedStartAt?: string | null;
  comment?: string | null;
  createdAt: string;
  occurrence: {
    id: string;
    startAt?: string | null;
    status: string;
    kind: string;
    jobType?: string | null;
    job: { property: { id: string; displayName: string; client?: { id: string; displayName: string } | null } } | null;
  };
  requestedBy: { id: string; displayName?: string | null; email?: string | null };
};

export default function ChangeRequestsPanel() {
  const [items, setItems] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denyDialog, setDenyDialog] = useState<{ id: string; note: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await apiGet<ChangeRequest[]>("/api/admin/change-requests?status=PENDING");
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error("Load change requests failed:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60000); // refresh every minute
    return () => clearInterval(t);
  }, []);

  async function approve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/admin/change-requests/${id}/approve`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Request approved & applied." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Approve failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  async function deny(id: string, note: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/admin/change-requests/${id}/deny`, { note });
      publishInlineMessage({ type: "INFO", text: "Request denied." });
      setDenyDialog(null);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Deny failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && items.length === 0) return null;
  if (items.length === 0) return null;

  return (
    <Card.Root variant="outline" borderColor="orange.300" mb={3}>
      <Card.Body p={3}>
        <HStack justify="space-between" cursor="pointer" onClick={() => setExpanded((v) => !v)}>
          <HStack gap={2}>
            <Text fontWeight="semibold" fontSize="sm" color="orange.800">Client Change Requests</Text>
            <Badge colorPalette="orange" variant="solid" borderRadius="full" px="2" fontSize="xs">{items.length}</Badge>
          </HStack>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </HStack>
        {expanded && (
          <VStack align="stretch" gap={2} mt={3}>
            {items.map((cr) => {
              const propName = cr.occurrence.job?.property?.displayName ?? "Unknown";
              const clientName = cr.occurrence.job?.property?.client?.displayName ?? "";
              const requesterName = cr.requestedBy.displayName ?? cr.requestedBy.email ?? "Client";
              return (
                <Box key={cr.id} p={2} bg="orange.50" borderWidth="1px" borderColor="orange.200" rounded="md">
                  <HStack justify="space-between" align="start" wrap="wrap" gap={2}>
                    <Box flex="1" minW={0}>
                      <HStack gap={1} mb={0.5}>
                        {cr.kind === "RESCHEDULE" ? <Calendar size={14} color="var(--chakra-colors-orange-700)" /> : <SkipForward size={14} color="var(--chakra-colors-orange-700)" />}
                        <Text fontSize="sm" fontWeight="semibold" color="orange.900">
                          {cr.kind === "RESCHEDULE" ? "Reschedule" : "Skip"} — {propName}
                          {clientName && <Text as="span" color="fg.muted" fontWeight="normal"> ({clientName})</Text>}
                        </Text>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        Currently: {cr.occurrence.startAt ? fmtDateWeekday(cr.occurrence.startAt) : "—"}
                      </Text>
                      {cr.kind === "RESCHEDULE" && cr.proposedStartAt && (
                        <Text fontSize="xs" color="orange.800">
                          Proposed: <b>{fmtDateWeekday(cr.proposedStartAt)}</b>
                        </Text>
                      )}
                      {cr.comment && (
                        <Text fontSize="xs" mt={1} fontStyle="italic" color="fg.muted">"{cr.comment}"</Text>
                      )}
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Requested by {requesterName} · {new Date(cr.createdAt).toLocaleDateString()}
                      </Text>
                    </Box>
                    <HStack gap={1} flexShrink={0}>
                      <Button
                        size="xs"
                        colorPalette="green"
                        loading={busyId === cr.id}
                        disabled={busyId !== null && busyId !== cr.id}
                        onClick={() => void approve(cr.id)}
                      >
                        <CheckCircle2 size={12} /> Approve
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette="red"
                        disabled={busyId !== null}
                        onClick={() => setDenyDialog({ id: cr.id, note: "" })}
                      >
                        <X size={12} /> Deny
                      </Button>
                    </HStack>
                  </HStack>

                  {denyDialog?.id === cr.id && (
                    <Box mt={2} p={2} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md">
                      <Text fontSize="xs" mb={1}>Optional note for the client:</Text>
                      <Textarea
                        size="sm"
                        rows={2}
                        value={denyDialog.note}
                        onChange={(e) => setDenyDialog({ ...denyDialog, note: e.target.value })}
                        placeholder="e.g., We can't accommodate that date — would Friday work?"
                      />
                      <HStack gap={1} mt={2} justify="flex-end">
                        <Button size="xs" variant="ghost" onClick={() => setDenyDialog(null)}>Cancel</Button>
                        <Button size="xs" colorPalette="red" loading={busyId === cr.id} onClick={() => void deny(cr.id, denyDialog.note)}>
                          Confirm Deny
                        </Button>
                      </HStack>
                    </Box>
                  )}
                </Box>
              );
            })}
          </VStack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
