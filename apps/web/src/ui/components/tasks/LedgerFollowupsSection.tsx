"use client";

// Inline section for the Tasks page — lists every open LedgerFollowup
// (Payment / BusinessExpense / Checkout flagged for follow-up). Each
// row has an inline Resolve button that hits the same endpoint the
// Ledger tab uses. Edit / re-open / delete still route through the
// Ledger tab via Goto Task.

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type LedgerFollowup = {
  id: string;
  entityType: "payment" | "businessExpense" | "checkout";
  entityId: string;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string | null; email: string | null } | null;
};

function entityLabel(type: LedgerFollowup["entityType"]): string {
  switch (type) {
    case "payment": return "Payment";
    case "businessExpense": return "Business expense";
    case "checkout": return "Checkout";
  }
}

function entityPalette(type: LedgerFollowup["entityType"]): string {
  switch (type) {
    case "payment": return "green";
    case "businessExpense": return "blue";
    case "checkout": return "purple";
  }
}

export default function LedgerFollowupsSection() {
  const [items, setItems] = useState<LedgerFollowup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ rows: LedgerFollowup[] }>("/api/super/ledger-followups");
      setItems(Array.isArray(r?.rows) ? r.rows : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load ledger follow-ups.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("seedlings3:ledger-followups-changed", onChanged);
    return () => window.removeEventListener("seedlings3:ledger-followups-changed", onChanged);
  }, [load]);

  async function resolve(row: LedgerFollowup) {
    setBusyId(row.id);
    try {
      await apiPost(`/api/super/ledger-followups/${row.id}/resolve`, {});
      window.dispatchEvent(new Event("seedlings3:ledger-followups-changed"));
      publishInlineMessage({ type: "SUCCESS", text: "Follow-up resolved." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Resolve failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && items.length === 0) {
    return (
      <HStack py={3} justify="center" color="fg.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading…</Text>
      </HStack>
    );
  }
  if (items.length === 0) return null;

  return (
    <VStack align="stretch" gap={2}>
      {items.map((f) => (
        <Box
          key={f.id}
          p={2}
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
        >
          <HStack justify="space-between" align="start" gap={2} wrap="wrap">
            <VStack align="start" gap={0.5} flex={1} minW={0}>
              <HStack gap={2}>
                <Badge size="xs" colorPalette={entityPalette(f.entityType)} variant="subtle">
                  {entityLabel(f.entityType)}
                </Badge>
                {f.note && (
                  <Text fontSize="sm" fontStyle="italic" color="fg.default">
                    "{f.note}"
                  </Text>
                )}
              </HStack>
              <Text fontSize="2xs" color="fg.muted">
                Flagged by {f.createdBy?.displayName ?? f.createdBy?.email ?? "—"} · {fmtDate(f.createdAt)}
              </Text>
            </VStack>
            <Button
              size="xs"
              colorPalette="green"
              disabled={busyId !== null}
              onClick={() => void resolve(f)}
            >
              <CheckCircle2 size={12} /> Resolve
            </Button>
          </HStack>
        </Box>
      ))}
    </VStack>
  );
}
