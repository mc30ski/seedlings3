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
  Check,
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
import {
  DEFAULT_TIMELINE_CATEGORIES,
  categoryLabel,
  parseTimelineCategoriesConfig,
  type TimelineCategoryConfig,
} from "@/src/ui/components/TimelineCategoryPicker";

type EventRow = {
  kind: "event";
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  rrule: string | null;
  anchorDate: string;
  lastCompletedAt: string | null;
  archivedAt: string | null;
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

// Combined "kind/category" filter — one of:
//   "all"        → everything (events + doc expirations)
//   "docs"       → doc expirations only
//   "<CAT_KEY>"  → events whose category matches
// Built dynamically once categories load (see filterItems below).

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
  if (d < 0) return `overdue ${-d} ${-d === 1 ? "day" : "days"}`;
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
  // kindFilter values: "all" | "docs" | "<CATEGORY_KEY>"
  const [kindFilter, setKindFilter] = useState<string[]>(["all"]);
  const [urgencyFilter, setUrgencyFilter] = useState<string[]>(["all"]);
  const [showArchived, setShowArchived] = useState(false);
  const [categories, setCategories] = useState<TimelineCategoryConfig[]>(DEFAULT_TIMELINE_CATEGORIES);

  // Load the configurable category taxonomy from settings.
  useEffect(() => {
    (async () => {
      try {
        const settings = await apiGet<{ key: string; value: string }[]>("/api/admin/settings");
        const tc = (Array.isArray(settings) ? settings : []).find((s) => s.key === "TIMELINE_CATEGORIES");
        const parsed = parseTimelineCategoriesConfig(tc?.value);
        if (parsed) setCategories(parsed);
      } catch {}
    })();
  }, []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "archive"; ev: EventRow }
    | { kind: "delete"; ev: EventRow }
    | { kind: "complete"; ev: EventRow }
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
      // Server merges + sorts. `showArchived` round-trips because archived
      // rows aren't in the same dataset; other filters are client-side.
      const params = new URLSearchParams();
      params.set("includeDocs", "1");
      if (showArchived) params.set("archived", "1");
      const list = await apiGet<UpcomingRow[]>(`${apiBase}/upcoming?${params}`);
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load.", err) });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [showArchived]);

  const filtered = useMemo(() => {
    let out = rows;
    if (highlightEventId) {
      out = out.filter((r) => r.kind === "event" && r.id === highlightEventId);
    }
    if (kindFilter[0] === "docs") {
      out = out.filter((r) => r.kind === "document_expiration");
    } else if (kindFilter[0] && kindFilter[0] !== "all") {
      // Category key — filter to events with that category. Doc-expirations
      // don't carry a category so they're hidden.
      out = out.filter((r) => r.kind === "event" && r.category === kindFilter[0]);
    }
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
  }, [rows, q, kindFilter, urgencyFilter, highlightEventId]);

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
    // Important: do NOT preset a status filter on Documents. The Timeline
    // surfaces docs across every status (expired, expiring, future), and
    // the receiving tab fetches with whichever status is set. If we forced
    // "expiring" here, clicking an already-expired doc would 404 client-side
    // because the API wouldn't return it.
    try {
      sessionStorage.removeItem("pendingDocumentsStatusFilter");
      localStorage.setItem("seedlings_deeplink_document", docId);
      localStorage.setItem("seedlings_deeplink_document_ts", String(Date.now()));
    } catch {}
    if (isSuper) {
      window.dispatchEvent(new CustomEvent("navigate:superTab", { detail: { tab: "documents" } }));
    } else {
      window.dispatchEvent(new CustomEvent("navigate:adminTab", { detail: { tab: "documents" } }));
    }
    // DocumentsTab listens for this event and applies the highlight once it's
    // mounted. The 250ms delay gives the tab time to render and register.
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
  async function markComplete(id: string, title: string) {
    try {
      await apiPost(`${apiBase}/${id}/complete`);
      publishInlineMessage({ type: "SUCCESS", text: `Marked "${title}" complete.` });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to mark complete.", err) });
    }
  }
  async function unarchive(id: string) {
    try {
      await apiPost(`${apiBase}/${id}/unarchive`);
      publishInlineMessage({ type: "SUCCESS", text: "Restored from archive." });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to restore.", err) });
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

  const urgencyCollection = useMemo(() => createListCollection({ items: URGENCY_ITEMS }), []);
  // Combined kind filter: All / Documents / each category. Built once
  // categories load so admin-defined order is preserved.
  const kindItems = useMemo(
    () => [
      { label: "All", value: "all" },
      { label: "Documents", value: "docs" },
      ...categories.map((c) => ({ label: c.label, value: c.key })),
    ],
    [categories],
  );
  const kindCollection = useMemo(() => createListCollection({ items: kindItems }), [kindItems]);

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
          placeholder="Search activities…"
        />
        <Select.Root
          collection={kindCollection}
          value={kindFilter}
          onValueChange={(e) => setKindFilter(e.value)}
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
                background: kindFilter[0] !== "all" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)",
                border: kindFilter[0] !== "all" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid var(--chakra-colors-orange-300)",
                borderRadius: "6px",
              }}
              title={kindItems.find((i) => i.value === kindFilter[0])?.label}
            >
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {kindItems.map((it) => (
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
        <Button
          size="sm"
          variant={showArchived ? "solid" : "outline"}
          px="2"
          minW="0"
          flexShrink={0}
          onClick={() => setShowArchived((v) => !v)}
          title={showArchived ? "Showing archived — click to hide" : "Show archived only"}
          css={showArchived ? {
            background: "var(--chakra-colors-gray-200)",
            color: "var(--chakra-colors-gray-700)",
            border: "1px solid var(--chakra-colors-gray-400)",
            "&:hover": { background: "var(--chakra-colors-gray-300)" },
          } : undefined}
        >
          <Archive size={14} />
        </Button>
        {isSuper && (
          <Button
            size="sm"
            colorPalette="teal"
            px="2"
            minW="0"
            flexShrink={0}
            onClick={() => { setEditingEvent(null); setDialogOpen(true); }}
            title="Add activity"
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {(kindFilter[0] !== "all" || urgencyFilter[0] !== "all" || showArchived || q.trim() || highlightEventId) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          {kindFilter[0] !== "all" && (
            <Badge
              size="sm"
              colorPalette="orange"
              variant="subtle"
              cursor="pointer"
              px="2"
              onClick={() => setKindFilter(["all"])}
              title="Clear filter"
            >
              {kindItems.find((i) => i.value === kindFilter[0])?.label}
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          {showArchived && (
            <Badge
              size="sm"
              colorPalette="gray"
              variant="solid"
              cursor="pointer"
              px="2"
              onClick={() => setShowArchived(false)}
              title="Hide archived"
            >
              Archived only
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
              title="Show all activities"
            >
              Linked to one activity
              <X size={11} style={{ marginLeft: 4 }} />
            </Badge>
          )}
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => {
              setKindFilter(["all"]);
              setUrgencyFilter(["all"]);
              setShowArchived(false);
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
                    <VStack align="stretch" gap={1}>
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
                          {!isDoc && r.category && (
                            <Badge size="xs" colorPalette="purple" variant="subtle" px="1.5">
                              {categoryLabel(r.category, categories)}
                            </Badge>
                          )}
                          {!isDoc && r.rrule && (
                            <Badge size="xs" colorPalette="gray" variant="subtle" px="1.5">
                              <Repeat size={9} style={{ marginRight: 3 }} />{rruleLabel(r.rrule)}
                            </Badge>
                          )}
                          {isDoc && (
                            <Badge size="xs" colorPalette="blue" variant="subtle" px="1.5">Document</Badge>
                          )}
                        </HStack>
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
                              title="Copy link to this activity"
                            >
                              <Link2 size={13} />
                            </Button>
                            {isSuper && !r.archivedAt && (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  colorPalette="teal"
                                  px="1.5"
                                  minW="0"
                                  onClick={() => setConfirmAction({ kind: "complete", ev: r })}
                                  title="Mark this occurrence complete (advances to the next)"
                                >
                                  <Check size={13} />
                                </Button>
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
                            {isSuper && r.archivedAt && (
                              <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="teal"
                                px="1.5"
                                minW="0"
                                onClick={() => unarchive(r.id)}
                                title="Restore from archive"
                              >
                                <ArchiveRestore size={13} />
                              </Button>
                            )}
                          </>
                        )}
                      </HStack>
                    </HStack>
                    {/* Description + last-completed live OUTSIDE the top
                        HStack so they span the full card width on narrow
                        screens instead of being squeezed alongside the
                        right-aligned action buttons. */}
                    {!isDoc && r.description && (
                      <Text fontSize="xs" color="fg.muted" lineClamp={2}>{r.description}</Text>
                    )}
                    {!isDoc && r.lastCompletedAt && (
                      <Text fontSize="xs" color="fg.subtle">
                        Last completed {fmtDate(r.lastCompletedAt)}
                      </Text>
                    )}
                    </VStack>
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
              confirmAction?.kind === "archive" ? "Archive activity?"
                : confirmAction?.kind === "delete" ? "Delete activity?"
                : confirmAction?.kind === "complete" ? "Mark complete?"
                : ""
            }
            message={
              confirmAction?.kind === "archive"
                ? `Archive "${confirmAction.ev.title}"? You can restore it from the archived view.`
                : confirmAction?.kind === "delete"
                ? `Permanently delete "${confirmAction.ev.title}"? This cannot be undone.`
                : confirmAction?.kind === "complete"
                ? (confirmAction.ev.rrule
                  ? `Mark "${confirmAction.ev.title}" complete? It will roll forward to its next occurrence.`
                  : `Mark "${confirmAction.ev.title}" complete? This is a one-time activity and will be archived.`)
                : ""
            }
            confirmLabel={
              confirmAction?.kind === "delete" ? "Delete"
                : confirmAction?.kind === "complete" ? "Mark complete"
                : "Archive"
            }
            confirmColorPalette={
              confirmAction?.kind === "delete" ? "red"
                : confirmAction?.kind === "complete" ? "teal"
                : "orange"
            }
            onConfirm={() => {
              if (!confirmAction) return;
              if (confirmAction.kind === "archive") archive(confirmAction.ev.id);
              else if (confirmAction.kind === "delete") hardDelete(confirmAction.ev.id);
              else if (confirmAction.kind === "complete") markComplete(confirmAction.ev.id, confirmAction.ev.title);
              setConfirmAction(null);
            }}
            onCancel={() => setConfirmAction(null)}
          />
        </>
      )}
    </Box>
  );
}
