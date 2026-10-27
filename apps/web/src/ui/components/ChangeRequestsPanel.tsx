"use client";

import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import { Calendar, CheckCircle2, ChevronDown, ChevronUp, SkipForward, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import type { Scope } from "@/src/lib/scope";
import { fmtDate, fmtDateWeekday } from "@/src/lib/dates";
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

type Props = {
  // When true, render only the list of items — skip the outer Card +
  // header row + own collapse toggle. Used by surfaces that provide
  // their own chrome around the list (e.g. TasksPage wraps this in
  // CollapsibleSectionCard so every section there reads the same).
  // Default false preserves the existing ServicesTab behavior.
  bare?: boolean;

  /**
   * Reports refresh / busy / count to whatever frames this. Both hosts
   * now pass `bare` and supply a Dashboard frame, so this component is
   * content-only.
   */
  onReady?: (api: { refresh: () => void; loading: boolean; count: number }) => void;

  /**
   * The caller's capabilities, so Approve / Deny can ask for the one their
   * own endpoint is guarded on.
   *
   * WHY THE COMPONENT ASKS RATHER THAN ITS HOST. This renders in TWO
   * places — ServicesTab and TasksPage — and until now neither the buttons
   * nor this file mentioned `schedule.manage`, so whether they appeared
   * depended entirely on which gate happened to surround the mount point.
   * That is not a hole, because `POST /change-requests/:id/approve` fails
   * closed on the server; it is a drift surface. Mount this panel in a
   * third place with a looser gate and the buttons come along, 403 on
   * click, and the person is told nothing useful.
   */
  scope?: Scope;
};

export default function ChangeRequestsPanel({ bare = false, onReady, scope }: Props = {}) {
  const [items, setItems] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(bare);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denyDialog, setDenyDialog] = useState<{ id: string; note: string } | null>(null);
  // Named for the capability, never for a role. Both endpoints behind these
  // controls — approve and deny — are guarded on `schedule.manage`.
  // Undefined scope means an older caller that has not been threaded yet;
  // it keeps the previous behaviour rather than hiding a control somebody
  // has today.
  const canDecide = scope ? scope.can("schedule.manage") : true;

  async function load() {
    setLoading(true);
    try {
      const list = await apiGet<ChangeRequest[]>("/api/change-requests?status=PENDING");
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error("Load change requests failed:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    onReady?.({ refresh: () => void load(), loading, count: items.length });
  }, [onReady, load, loading, items]);

  useEffect(() => {
    void load();
  }, []);

  async function approve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/change-requests/${id}/approve`, {});
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
      await apiPost(`/api/change-requests/${id}/deny`, { note });
      publishInlineMessage({ type: "INFO", text: "Request denied." });
      setDenyDialog(null);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Deny failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  // Nothing until the first load resolves — avoids flashing the panel
  // in and out on mount. After that, empty gets a message rather than a
  // blank body: in `bare` mode the host (ServicesTab) draws the frame
  // regardless, so returning null leaves an expanded section showing
  // nothing at all.
  if (loading && items.length === 0) return null;
  if (items.length === 0) {
    const empty = (
      <Text fontSize="sm" color="fg.muted" py={1}>
        No change requests — nothing is waiting on a reschedule decision.
      </Text>
    );
    return bare ? empty : null;
  }

  // List body is identical in both modes — only the outer chrome
  // differs. Extract it once so the two return branches don't drift.
  const listBody = (
    <VStack align="stretch" gap={2} mt={bare ? 0 : 3}>
            {items.map((cr) => {
              const propName = cr.occurrence.job?.property?.displayName ?? "Unknown";
              const clientName = cr.occurrence.job?.property?.client?.displayName ?? "";
              const requesterName = cr.requestedBy.displayName ?? cr.requestedBy.email ?? "Client";
              return (
                <Box key={cr.id} p={2} bg="orange.faint" borderWidth="1px" borderColor="orange.emphasized" rounded="md">
                  <HStack justify="space-between" align="start" wrap="wrap" gap={2}>
                    <Box flex="1" minW={0}>
                      <HStack gap={1} mb={0.5}>
                        {cr.kind === "RESCHEDULE" ? <Calendar size={14} color="var(--chakra-colors-orange-700)" /> : <SkipForward size={14} color="var(--chakra-colors-orange-700)" />}
                        <Text fontSize="sm" fontWeight="semibold" color="orange.fg">
                          {cr.kind === "RESCHEDULE" ? "Reschedule" : "Skip"} — {propName}
                          {clientName && <Text as="span" color="fg.muted" fontWeight="normal"> ({clientName})</Text>}
                        </Text>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        Currently: {cr.occurrence.startAt ? fmtDateWeekday(cr.occurrence.startAt) : "—"}
                      </Text>
                      {cr.kind === "RESCHEDULE" && cr.proposedStartAt && (
                        <Text fontSize="xs" color="orange.fg">
                          Proposed: <b>{fmtDateWeekday(cr.proposedStartAt)}</b>
                        </Text>
                      )}
                      {cr.comment && (
                        <Text fontSize="xs" mt={1} fontStyle="italic" color="fg.muted">"{cr.comment}"</Text>
                      )}
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Requested by {requesterName} · {fmtDate(cr.createdAt)}
                      </Text>
                    </Box>
                    {canDecide && (
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
                    )}
                  </HStack>

                  {canDecide && denyDialog?.id === cr.id && (
                    <Box mt={2} p={2} bg="bg.panel" borderWidth="1px" borderColor="gray.emphasized" rounded="md">
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
  );

  // Always content-only. The framed branch that used to live here (its
  // own orange card, chevron and count badge) was a fourth hand-rolled
  // copy of the section pattern; ServicesTab and TasksPage both supply a
  // real frame now, so `bare` is the only shape.
  return listBody;

}
