"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ExternalLink,
  EyeOff,
  Filter,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import TimelineEventDialog from "@/src/ui/dialogs/TimelineEventDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { rruleLabel } from "@/src/ui/components/RRuleEditor";

type EventRow = {
  kind: "event";
  id: string;
  title: string;
  description: string | null;
  rrule: string | null;
  anchorDate: string;
  adminHidden: boolean;
  nextDate: string;
};
type DocRow = {
  kind: "document_expiration";
  documentId: string;
  title: string;
  type: string;
  adminHidden: boolean;
  nextDate: string;
};
type UpcomingRow = EventRow | DocRow;

type Props = { isSuper?: boolean };

const SHOW_ITEMS = [
  { label: "All", value: "all" },
  { label: "Events only", value: "events" },
  { label: "Doc expirations only", value: "docs" },
];

const URGENCY_ITEMS = [
  { label: "All upcoming", value: "all" },
  { label: "Urgent (past or ≤7 days)", value: "urgent" },
  { label: "Soon (≤30 days)", value: "soon" },
  { label: "Beyond 30 days", value: "future" },
];

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(); } catch { return "—"; }
}
function diffDays(iso: string, from: Date = new Date()): number {
  return Math.round((new Date(iso).getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
function relativeLabel(iso: string): string {
  const d = diffDays(iso);
  if (d < 0) return `${-d} ${-d === 1 ? "day" : "days"} ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 30) return `in ${d} days`;
  if (d < 60) return "in about 1 month";
  const months = Math.round(d / 30);
  if (months < 12) return `in about ${months} months`;
  const years = Math.round(d / 365);
  return years === 1 ? "in about 1 year" : `in about ${years} years`;
}
function urgencyOf(iso: string): "past" | "urgent" | "soon" | "future" {
  const d = diffDays(iso);
  if (d < 0) return "past";
  if (d <= 7) return "urgent";
  if (d <= 30) return "soon";
  return "future";
}
function urgencyColor(u: "past" | "urgent" | "soon" | "future"): string {
  if (u === "past") return "red";
  if (u === "urgent") return "red";
  if (u === "soon") return "yellow";
  return "green";
}

export default function TimelineTab({ isSuper = false }: Props) {
  const apiBase = isSuper ? "/api/super/timeline" : "/api/admin/timeline";

  const [rows, setRows] = useState<UpcomingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [showFilter, setShowFilter] = useState<string[]>(["all"]);
  const [urgencyFilter, setUrgencyFilter] = useState<string[]>(["all"]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "archive"; ev: EventRow }
    | { kind: "delete"; ev: EventRow }
    | null
  >(null);
  const [highlightEventId, setHighlightEventId] = useState<string | null>(null);

  // Deep-link listener — mirrors the DocumentsTab pattern. pages/index.tsx
  // stashes ?eventId then dispatches when this tab is mounted+ready.
  useEffect(() => {
    (window as any).__timelineTabReady = true;
    function onApply(e: Event) {
      const { eventId } = (e as CustomEvent<{ eventId?: string | null }>).detail || {};
      if (eventId) setHighlightEventId(eventId);
    }
    window.addEventListener("timelineTab:applyDeepLink", onApply as EventListener);
    return () => {
      window.removeEventListener("timelineTab:applyDeepLink", onApply as EventListener);
      (window as any).__timelineTabReady = false;
    };
  }, []);

  async function load() {
    setLoading(true);
    try {
      // Server merges + sorts. Filters are applied client-side so toggling
      // doesn't round-trip.
      const list = await apiGet<UpcomingRow[]>(`${apiBase}/upcoming?includeDocs=1`);
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load.", err) });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    let out = rows;
    if (highlightEventId) {
      out = out.filter((r) => r.kind === "event" && r.id === highlightEventId);
    }
    if (showFilter[0] === "events") out = out.filter((r) => r.kind === "event");
    else if (showFilter[0] === "docs") out = out.filter((r) => r.kind === "document_expiration");
    if (urgencyFilter[0] !== "all") {
      // Cumulative semantics: each filter widens the window inclusively.
      //   urgent → past + ≤7 days
      //   soon   → past + ≤30 days (includes urgent)
      //   future → past + ≤30 days + beyond (== all upcoming-ish, kept
      //            distinct from "all" only so users can hide things that
      //            haven't been flagged at all — i.e., excludes nothing)
      out = out.filter((r) => {
        const u = urgencyOf(r.nextDate);
        if (urgencyFilter[0] === "urgent") return u === "past" || u === "urgent";
        if (urgencyFilter[0] === "soon") return u === "past" || u === "urgent" || u === "soon";
        if (urgencyFilter[0] === "future") return u === "future";
        return true;
      });
    }
    if (q.trim()) {
      const qlc = q.trim().toLowerCase();
      out = out.filter((r) =>
        [r.title, r.kind === "event" ? r.description ?? "" : ""].some((s) =>
          s.toLowerCase().includes(qlc),
        ),
      );
    }
    return out;
  }, [rows, q, showFilter, urgencyFilter, highlightEventId]);

  // Apply a pre-set urgency filter from the title-bar pill navigation.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = sessionStorage.getItem("pendingTimelineUrgencyFilter");
    if (v) {
      setUrgencyFilter([v]);
      sessionStorage.removeItem("pendingTimelineUrgencyFilter");
    }
  }, []);

  function copyShareLink(eventId: string, title: string) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.origin);
    url.searchParams.set("tab", isSuper ? "super-system-timeline" : "admin-system-timeline");
    url.searchParams.set("eventId", eventId);
    navigator.clipboard.writeText(url.toString()).then(
      () => publishInlineMessage({ type: "SUCCESS", text: `Link to "${title}" copied.` }),
      () => publishInlineMessage({ type: "ERROR", text: `Copy failed. Link: ${url.toString()}` }),
    );
  }

  function navigateToDoc(docId: string) {
    try {
      sessionStorage.setItem("pendingDocumentsStatusFilter", "expiring");
      // Use the existing Documents deep-link mechanism (localStorage stash +
      // event dispatch from pages/index.tsx).
      localStorage.setItem("seedlings_deeplink_document", docId);
      localStorage.setItem("seedlings_deeplink_document_ts", String(Date.now()));
    } catch {}
    if (isSuper) {
      window.dispatchEvent(new CustomEvent("navigate:superTab", { detail: { tab: "documents" } }));
    } else {
      window.dispatchEvent(new CustomEvent("navigate:adminTab", { detail: { tab: "documents" } }));
    }
    // After navigation, pages/index.tsx's consume-effect reads localStorage
    // and dispatches the documentsTab:applyDeepLink event.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("documentsTab:applyDeepLink", {
        detail: { docId },
      }));
    }, 250);
  }

  async function archive(id: string) {
    try {
      await apiPost(`${apiBase}/${id}/archive`);
      publishInlineMessage({ type: "SUCCESS", text: "Archived." });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to archive.", err) });
    }
  }
  async function hardDelete(id: string) {
    try {
      await apiPost(`${apiBase}/${id}/archive`).catch(() => {}); // ensure archived first
      await apiDelete(`${apiBase}/${id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Deleted." });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  const showCollection = useMemo(() => createListCollection({ items: SHOW_ITEMS }), []);
  const urgencyCollection = useMemo(() => createListCollection({ items: URGENCY_ITEMS }), []);

  return (
    <Box w="full">
      <HStack mb={2} gap={2}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          loading={loading}
          px="2"
          flexShrink={0}
          css={{ background: "var(--chakra-colors-gray-100)" }}
        >
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          value={q}
          onChange={(v) => setQ(v)}
          inputId="timeline-search"
          placeholder="Search events…"
        />
        <Select.Root
          collection={showCollection}
          value={showFilter}
          onValueChange={(e) => setShowFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger
              w="auto"
              minW="0"
              px="2"
              css={{
                background: showFilter[0] !== "all" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)",
                border: showFilter[0] !== "all" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid var(--chakra-colors-orange-300)",
                borderRadius: "6px",
              }}
              title={SHOW_ITEMS.find((i) => i.value === showFilter[0])?.label}
            >
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {SHOW_ITEMS.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={urgencyCollection}
          value={urgencyFilter}
          onValueChange={(e) => setUrgencyFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger
              w="auto"
              minW="0"
              px="2"
              css={{
                background: urgencyFilter[0] !== "all" ? "var(--chakra-colors-teal-200)" : "var(--chakra-colors-teal-100)",
                border: urgencyFilter[0] !== "all" ? "1px solid var(--chakra-colors-teal-400)" : "1px solid var(--chakra-colors-teal-300)",
                borderRadius: "6px",
              }}
              title={URGENCY_ITEMS.find((i) => i.value === urgencyFilter[0])?.label}
            >
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {URGENCY_ITEMS.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {isSuper && (
          <Button
            size="sm"
            colorPalette="teal"
            px="2"
            minW="0"
            flexShrink={0}
            onClick={() => { setEditingEvent(null); setDialogOpen(true); }}
            title="Add event"
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {(showFilter[0] !== "all" || urgencyFilter[0] !== "all" || q.trim() || highlightEventId) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          {showFilter[0] !== "all" && (
            <Badge
              size="sm"
              colorPalette="orange"
              variant="subtle"
              cursor="pointer"
              px="2"
              onClick={() => setShowFilter(["all"])}
              title="Clear show filter"
            >
              {SHOW_ITEMS.find((i) => i.value === showFilter[0])?.label}
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          {urgencyFilter[0] !== "all" && (
            <Badge
              size="sm"
              colorPalette="teal"
              variant="subtle"
              cursor="pointer"
              px="2"
              onClick={() => setUrgencyFilter(["all"])}
              title="Clear urgency filter"
            >
              {URGENCY_ITEMS.find((i) => i.value === urgencyFilter[0])?.label}
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          {q.trim() && (
            <Badge
              size="sm"
              colorPalette="gray"
              variant="subtle"
              cursor="pointer"
              px="2"
              onClick={() => setQ("")}
              title="Clear search"
            >
              "{q.trim()}"
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          {highlightEventId && (
            <Badge
              size="sm"
              colorPalette="teal"
              variant="subtle"
              cursor="pointer"
              px="2"
              onClick={() => setHighlightEventId(null)}
              title="Show all events"
            >
              Linked to one event
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => {
              setShowFilter(["all"]);
              setUrgencyFilter(["all"]);
              setQ("");
              setHighlightEventId(null);
            }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}

      <Box position="relative">
        {loading && rows.length > 0 && (
          <>
            <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
            <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
          </>
        )}
        {loading && rows.length === 0 ? (
          <HStack justify="center" py={6}><Spinner /></HStack>
        ) : filtered.length === 0 ? (
          <Box py={4} color="fg.muted" fontSize="sm">No upcoming items.</Box>
        ) : (
          <VStack align="stretch" gap={2}>
            {filtered.map((r) => {
              const u = urgencyOf(r.nextDate);
              const color = urgencyColor(u);
              const isDoc = r.kind === "document_expiration";
              return (
                <Card.Root key={(isDoc ? "d_" : "e_") + (isDoc ? r.documentId : r.id)} variant="outline">
                  <Card.Body p={2}>
                    <HStack justify="space-between" align="start" gap={1}>
                      <VStack align="start" gap={0.5} flex="1" minW={0} w="full">
                        <HStack gap={1.5} wrap="nowrap" align="center" minW={0}>
                          <Box flexShrink={0} display="inline-flex">
                            {isDoc ? <ExternalLink size={13} /> : <CalendarClock size={13} />}
                          </Box>
                          <Text fontSize="sm" fontWeight="semibold" lineClamp={2} minW={0}>
                            {r.title}
                          </Text>
                          {r.adminHidden && (
                            <Badge size="xs" colorPalette="red" variant="subtle" px="1.5" title="Hidden from Admins">
                              <EyeOff size={9} />
                            </Badge>
                          )}
                        </HStack>
                        <HStack gap={1.5} wrap="wrap" fontSize="xs" color="fg.muted" align="center">
                          <Badge size="sm" colorPalette={color} variant="subtle" px="2" borderRadius="full">
                            {fmtDate(r.nextDate)} · {relativeLabel(r.nextDate)}
                          </Badge>
                          {!isDoc && r.rrule && (
                            <Badge size="xs" colorPalette="purple" variant="subtle" px="1.5">
                              <Repeat size={9} style={{ marginRight: 3 }} />{rruleLabel(r.rrule)}
                            </Badge>
                          )}
                          {isDoc && (
                            <Badge size="xs" colorPalette="blue" variant="subtle" px="1.5">Document</Badge>
                          )}
                        </HStack>
                        {!isDoc && r.description && (
                          <Text fontSize="xs" color="fg.muted" lineClamp={2}>{r.description}</Text>
                        )}
                      </VStack>
                      <HStack gap={0.5} flexShrink={0}>
                        {isDoc ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            px="1.5"
                            minW="0"
                            onClick={() => navigateToDoc(r.documentId)}
                            title="Open in Documents tab"
                          >
                            <ExternalLink size={13} />
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="xs"
                              variant="ghost"
                              px="1.5"
                              minW="0"
                              onClick={() => copyShareLink(r.id, r.title)}
                              title="Copy link to this event"
                            >
                              <Link2 size={13} />
                            </Button>
                            {isSuper && (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  px="1.5"
                                  minW="0"
                                  onClick={() => { setEditingEvent(r); setDialogOpen(true); }}
                                  title="Edit"
                                >
                                  <Pencil size={13} />
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  px="1.5"
                                  minW="0"
                                  onClick={() => setConfirmAction({ kind: "archive", ev: r })}
                                  title="Archive"
                                >
                                  <Archive size={13} />
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </HStack>
                    </HStack>
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
        )}
      </Box>

      {isSuper && (
        <>
          <TimelineEventDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            event={editingEvent}
            onSaved={() => { setEditingEvent(null); void load(); }}
          />
          <ConfirmDialog
            open={!!confirmAction}
            title={
              confirmAction?.kind === "archive" ? "Archive event?"
                : confirmAction?.kind === "delete" ? "Delete event?"
                : ""
            }
            message={
              confirmAction?.kind === "archive"
                ? `Archive "${confirmAction.ev.title}"? You can restore it from the archived view.`
                : confirmAction?.kind === "delete"
                ? `Permanently delete "${confirmAction.ev.title}"? This cannot be undone.`
                : ""
            }
            confirmLabel={confirmAction?.kind === "delete" ? "Delete" : "Archive"}
            confirmColorPalette={confirmAction?.kind === "delete" ? "red" : "orange"}
            onConfirm={() => {
              if (!confirmAction) return;
              if (confirmAction.kind === "archive") archive(confirmAction.ev.id);
              else if (confirmAction.kind === "delete") hardDelete(confirmAction.ev.id);
              setConfirmAction(null);
            }}
            onCancel={() => setConfirmAction(null)}
          />
        </>
      )}
    </Box>
  );
}
