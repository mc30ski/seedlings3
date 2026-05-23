"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DEFAULT_DOCUMENT_TYPES,
  documentTypeDescription,
  documentTypeLabel,
  isSingletonType,
  parseDocumentTypesConfig,
  type DocumentTypeConfig,
} from "@/src/ui/components/DocumentTypePicker";
import UploadDocumentDialog from "@/src/ui/dialogs/UploadDocumentDialog";
import UploadDocumentVersionDialog from "@/src/ui/dialogs/UploadDocumentVersionDialog";
import EditDocumentMetadataDialog from "@/src/ui/dialogs/EditDocumentMetadataDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import MarkdownViewerDialog from "@/src/ui/dialogs/MarkdownViewerDialog";

type CompanyDocumentVersion = {
  id: string;
  documentId: string;
  contentType: string;
  originalFilename: string;
  sizeBytes: number;
  uploadedById: string;
  uploadedAt: string;
  uploadedBy?: { id: string; displayName: string | null; email: string | null } | null;
};

type CompanyDocument = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  expiresAt: string | null;
  adminHidden: boolean;
  currentVersionId: string | null;
  currentVersion: CompanyDocumentVersion | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: { id: string; displayName: string | null; email: string | null } | null;
  expirationStatus: "active" | "expiring" | "expired";
  _count?: { versions: number };
};

type CompanyDocumentDetail = CompanyDocument & {
  versions: CompanyDocumentVersion[];
};

type Props = {
  /** Admin sees read-only without admin-hidden docs; Super gets full controls. */
  isSuper?: boolean;
};

const STATUS_ITEMS = [
  { label: "All active", value: "all" },
  { label: "Active", value: "active" },
  { label: "Expiring (≤30 days)", value: "expiring" },
  { label: "Expired", value: "expired" },
  { label: "Archived", value: "archived" },
];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

function expBadgeColor(status: CompanyDocument["expirationStatus"]): string {
  if (status === "expired") return "red";
  if (status === "expiring") return "yellow";
  return "green";
}

export default function DocumentsTab({ isSuper = false }: Props) {
  const [items, setItems] = useState<CompanyDocument[]>([]);
  const [details, setDetails] = useState<Record<string, CompanyDocumentDetail>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [types, setTypes] = useState<DocumentTypeConfig[]>(DEFAULT_DOCUMENT_TYPES);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>(["ALL"]);
  const [statusFilter, setStatusFilter] = useState<string[]>(["all"]);

  // Dialog state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadInitialType, setUploadInitialType] = useState<string | null>(null);
  const [versionUploadDocId, setVersionUploadDocId] = useState<string | null>(null);
  const [editingDoc, setEditingDoc] = useState<CompanyDocument | null>(null);
  // Multi-instance groups can be collapsed to show just the header (so the
  // collection reads like a single document). Singleton groups already show
  // one doc, so collapse doesn't apply to them.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "archive"; doc: CompanyDocument }
    | { kind: "unarchive"; doc: CompanyDocument }
    | { kind: "hardDelete"; doc: CompanyDocument }
    | { kind: "deleteVersion"; doc: CompanyDocument; versionId: string; filename: string }
    | null
  >(null);

  // In-app markdown viewer state. Text documents (.md / text/*) render here
  // instead of opening the raw file in a new browser tab.
  const [mdViewer, setMdViewer] = useState<{
    open: boolean;
    title: string;
    text: string | null;
    loading: boolean;
    error: string | null;
    downloadUrl: string | null;
  }>({ open: false, title: "", text: null, loading: false, error: null, downloadUrl: null });

  // Endpoint base reflects the audience, not the caller's role: the Admin
  // tab always uses `/api/admin/documents` so Super-only docs are filtered
  // server-side even when the caller happens to be Super. The Super tab uses
  // `/api/super/documents` for the full view + writes.
  const apiBase = isSuper ? "/api/super/documents" : "/api/admin/documents";

  // Deep-link target: `?docId=<id>` filters to a single doc; `?typeKey=<key>`
  // filters to a type group. Applied once on mount and stripped from the URL
  // so a subsequent reload doesn't keep re-applying.
  const [highlightDocId, setHighlightDocId] = useState<string | null>(null);
  // Distinguishes a deep-link to a collection (`?typeKey=…`) from the user
  // just picking that type from the filter dropdown — the chip varies.
  const [highlightTypeKey, setHighlightTypeKey] = useState<string | null>(null);
  // Deep links are routed via pages/index.tsx: that file stashes the URL
  // params, navigates to the right Documents tab, then dispatches this event
  // once we signal readiness. We don't read router.query here because the
  // params have already been consumed/stripped by the time we mount on a
  // cold link click.
  useEffect(() => {
    (window as any).__documentsTabReady = true;
    function onApply(e: Event) {
      const { docId, typeKey } = (e as CustomEvent<{ docId?: string | null; typeKey?: string | null }>).detail || {};
      if (docId) setHighlightDocId(docId);
      if (typeKey) {
        setTypeFilter([typeKey]);
        setHighlightTypeKey(typeKey);
      }
    }
    window.addEventListener("documentsTab:applyDeepLink", onApply as EventListener);
    return () => {
      window.removeEventListener("documentsTab:applyDeepLink", onApply as EventListener);
      (window as any).__documentsTabReady = false;
    };
  }, []);

  // If the user changes the type filter manually, the deep-link highlight no
  // longer reflects what's on screen — drop the special "linked to collection"
  // chip so it doesn't lie.
  useEffect(() => {
    if (highlightTypeKey && typeFilter[0] !== highlightTypeKey) {
      setHighlightTypeKey(null);
    }
  }, [typeFilter, highlightTypeKey]);

  // Pre-applied status filter from title-bar pill navigation.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "pendingDocumentsStatusFilter";
    const v = sessionStorage.getItem(key);
    if (v) {
      setStatusFilter([v]);
      sessionStorage.removeItem(key);
    }
  }, []);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter[0] && typeFilter[0] !== "ALL") params.set("type", typeFilter[0]);
      if (statusFilter[0] && statusFilter[0] !== "all") params.set("status", statusFilter[0]);
      if (q.trim()) params.set("q", q.trim());
      const list = await apiGet<CompanyDocument[]>(`${apiBase}?${params}`);
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load.", err) });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadTypes() {
    try {
      const settings = await apiGet<{ key: string; value: string }[]>("/api/admin/settings");
      const dt = (Array.isArray(settings) ? settings : []).find((s) => s.key === "DOCUMENT_TYPES");
      const parsed = parseDocumentTypesConfig(dt?.value);
      if (parsed) setTypes(parsed);
    } catch {}
  }

  useEffect(() => {
    void loadTypes();
  }, []);

  // Default: multi-instance collections start collapsed so the list reads as
  // a tidy index. Tracked separately so user-driven toggles (after this seed)
  // are preserved. Runs once when types are first known.
  const [collapseSeeded, setCollapseSeeded] = useState(false);
  useEffect(() => {
    if (collapseSeeded) return;
    if (!types || types.length === 0) return;
    const seed = new Set<string>();
    for (const t of types) {
      if (!t.singleton) seed.add(t.key);
    }
    setCollapsedTypes(seed);
    setCollapseSeeded(true);
  }, [types, collapseSeeded]);

  // Deep-linked collection should be visible — pull it out of the collapsed
  // set when a deep link targets it.
  useEffect(() => {
    if (!highlightTypeKey) return;
    setCollapsedTypes((prev) => {
      if (!prev.has(highlightTypeKey)) return prev;
      const next = new Set(prev);
      next.delete(highlightTypeKey);
      return next;
    });
  }, [highlightTypeKey]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter]);

  async function loadDetail(id: string) {
    try {
      const detail = await apiGet<CompanyDocumentDetail>(`${apiBase}/${id}`);
      setDetails((prev) => ({ ...prev, [id]: detail }));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load detail.", err) });
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!details[id]) void loadDetail(id);
      }
      return next;
    });
  }

  // True for text documents we render in-app (markdown / plain text). Detected
  // by content type OR extension — markdown uploads land with varied types.
  function isTextDoc(v: CompanyDocumentVersion | null | undefined): boolean {
    if (!v) return false;
    const ct = (v.contentType || "").toLowerCase();
    const name = (v.originalFilename || "").toLowerCase();
    return (
      ct === "text/markdown" ||
      ct === "text/plain" ||
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      name.endsWith(".txt")
    );
  }

  async function openVersion(
    docId: string,
    version: CompanyDocumentVersion,
    mode: "view" | "download",
    docTitle: string,
  ) {
    // Text docs in "view" mode render in the in-app markdown viewer. Download
    // mode (and all non-text docs) keep the open-in-new-tab behavior.
    if (mode === "view" && isTextDoc(version)) {
      setMdViewer({ open: true, title: docTitle, text: null, loading: true, error: null, downloadUrl: null });
      try {
        const [{ text }, urlRes] = await Promise.all([
          apiGet<{ text: string }>(`${apiBase}/${docId}/versions/${version.id}/text`),
          apiGet<{ url: string }>(`${apiBase}/${docId}/versions/${version.id}/url?mode=download`)
            .catch(() => ({ url: "" })),
        ]);
        setMdViewer({
          open: true,
          title: docTitle,
          text,
          loading: false,
          error: null,
          downloadUrl: urlRes.url || null,
        });
      } catch (err) {
        setMdViewer({
          open: true,
          title: docTitle,
          text: null,
          loading: false,
          error: getErrorMessage("Failed to load document.", err),
          downloadUrl: null,
        });
      }
      return;
    }
    try {
      const { url } = await apiGet<{ url: string }>(
        `${apiBase}/${docId}/versions/${version.id}/url?mode=${mode}`,
      );
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to open.", err) });
    }
  }

  /**
   * Trigger downloads of every current-version file for the listed docs.
   * The presigned URLs already include Content-Disposition: attachment, so
   * each anchor click forces a save. We stagger them slightly so browsers
   * accept the burst (Chrome/Firefox prompt once, then allow batches).
   */
  async function downloadAll(docs: CompanyDocument[], collectionLabel: string) {
    const eligible = docs.filter((d) => d.currentVersion);
    if (eligible.length === 0) {
      publishInlineMessage({ type: "ERROR", text: "Nothing to download — no versions uploaded yet." });
      return;
    }
    publishInlineMessage({ type: "SUCCESS", text: `Downloading ${eligible.length} ${collectionLabel} document${eligible.length === 1 ? "" : "s"}…` });
    for (const d of eligible) {
      try {
        const { url } = await apiGet<{ url: string }>(
          `${apiBase}/${d.id}/versions/${d.currentVersion!.id}/url?mode=download`,
        );
        const a = document.createElement("a");
        a.href = url;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage(`Failed to download "${d.title}".`, err) });
      }
      // Brief gap so the browser processes each download before the next.
      await new Promise((r) => setTimeout(r, 250));
    }
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
      await apiDelete(`${apiBase}/${id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Permanently deleted." });
      setDetails((prev) => {
        const { [id]: _, ...rest } = prev;
        return rest;
      });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  async function restoreVersion(docId: string, versionId: string) {
    try {
      await apiPost(`${apiBase}/${docId}/versions/${versionId}/restore`);
      publishInlineMessage({ type: "SUCCESS", text: "Version restored." });
      await loadDetail(docId);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Restore failed.", err) });
    }
  }

  async function deleteVersion(docId: string, versionId: string) {
    try {
      await apiDelete(`${apiBase}/${docId}/versions/${versionId}`);
      publishInlineMessage({ type: "SUCCESS", text: "Version deleted." });
      await loadDetail(docId);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  // Build a shareable deep-link URL. We encode the audience (super/admin) in
  // the tab slug so the recipient lands in the right context — and the server
  // enforces permission either way.
  function buildShareUrl(params: { docId?: string; typeKey?: string }): string {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.origin);
    const tabSlug = isSuper ? "super-system-documents" : "admin-system-documents";
    url.searchParams.set("tab", tabSlug);
    if (params.docId) url.searchParams.set("docId", params.docId);
    if (params.typeKey) url.searchParams.set("typeKey", params.typeKey);
    return url.toString();
  }

  async function copyShareLink(params: { docId?: string; typeKey?: string; label: string }) {
    const url = buildShareUrl({ docId: params.docId, typeKey: params.typeKey });
    try {
      await navigator.clipboard.writeText(url);
      publishInlineMessage({ type: "SUCCESS", text: `Link to "${params.label}" copied.` });
    } catch {
      publishInlineMessage({ type: "ERROR", text: `Copy failed. Link: ${url}` });
    }
  }

  // ---- UI helpers ----

  const typeItems = useMemo(
    () => [{ label: "All types", value: "ALL" }, ...types.map((t) => ({ label: t.label, value: t.key }))],
    [types],
  );
  const typeCollection = useMemo(() => createListCollection({ items: typeItems }), [typeItems]);
  const statusCollection = useMemo(() => createListCollection({ items: STATUS_ITEMS }), []);

  const filtered = useMemo(() => {
    let rows = items;
    if (highlightDocId) {
      rows = rows.filter((i) => i.id === highlightDocId);
    }
    if (!q.trim()) return rows;
    const qlc = q.trim().toLowerCase();
    return rows.filter((i) =>
      [i.title, i.description ?? "", documentTypeLabel(i.type, types)].some((s) =>
        s.toLowerCase().includes(qlc),
      ),
    );
  }, [items, q, types, highlightDocId]);

  // Auto-expand and detect-not-found for deep links.
  useEffect(() => {
    if (!highlightDocId) return;
    if (loading) return;
    const found = items.find((i) => i.id === highlightDocId);
    if (found) {
      setExpanded((prev) => prev.has(highlightDocId) ? prev : new Set(prev).add(highlightDocId));
      if (!details[highlightDocId]) void loadDetail(highlightDocId);
    } else {
      publishInlineMessage({
        type: "ERROR",
        text: "That document isn't available — it may have been removed or you don't have permission to view it.",
      });
      setHighlightDocId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightDocId, loading, items.length]);

  const takenSingletonKeys = useMemo(() => {
    const taken = new Set<string>();
    for (const i of items) {
      if (i.archivedAt) continue;
      if (isSingletonType(i.type, types)) taken.add(i.type);
    }
    return taken;
  }, [items, types]);

  return (
    <Box w="full">
      <HStack gap={2} mb={2}>
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
          inputId="documents-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={typeCollection}
          value={typeFilter}
          onValueChange={(e) => setTypeFilter(e.value)}
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
                background: typeFilter[0] !== "ALL" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)",
                border: typeFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid var(--chakra-colors-orange-300)",
                borderRadius: "6px",
              }}
              title={typeItems.find((i) => i.value === typeFilter[0])?.label}
            >
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {typeItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={statusCollection}
          value={statusFilter}
          onValueChange={(e) => setStatusFilter(e.value)}
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
                background: statusFilter[0] !== "all" ? "var(--chakra-colors-teal-200)" : "var(--chakra-colors-teal-100)",
                border: statusFilter[0] !== "all" ? "1px solid var(--chakra-colors-teal-400)" : "1px solid var(--chakra-colors-teal-300)",
                borderRadius: "6px",
              }}
              title={STATUS_ITEMS.find((i) => i.value === statusFilter[0])?.label}
            >
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {STATUS_ITEMS.map((it) => (
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
            onClick={() => { setUploadInitialType(null); setUploadOpen(true); }}
            title="Add document"
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {(highlightDocId || highlightTypeKey) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          <Badge
            size="sm"
            colorPalette="teal"
            variant="subtle"
            cursor="pointer"
            px="2"
            onClick={() => {
              setHighlightDocId(null);
              if (highlightTypeKey) {
                setHighlightTypeKey(null);
                setTypeFilter(["ALL"]);
              }
            }}
            title="Show all documents"
          >
            {highlightDocId
              ? "Linked to one document"
              : `Linked to one document collection (${
                  items.filter((i) => i.type === highlightTypeKey && !i.archivedAt).length
                })`}
            <X size={11} style={{ marginLeft: 4 }} />
          </Badge>
        </HStack>
      )}

      <Box position="relative">
        {loading && items.length > 0 && (
          <>
            <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
            <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
          </>
        )}
      {loading && items.length === 0 ? (
        <HStack justify="center" py={6}><Spinner /></HStack>
      ) : filtered.length === 0 ? (
        <Box py={4} color="fg.muted" fontSize="sm">No documents.</Box>
      ) : (() => {
        // Group docs by type. Iterate over the configured taxonomy first to
        // preserve admin-defined order; collect any orphan types (docs whose
        // type was removed from the taxonomy) into a trailing "Other" group.
        const byType: Record<string, CompanyDocument[]> = {};
        for (const d of filtered) {
          (byType[d.type] ??= []).push(d);
        }
        const orderedTypes = types.filter((t) => byType[t.key]?.length);
        const orphanKeys = Object.keys(byType).filter(
          (k) => !types.some((t) => t.key === k),
        );

        const renderDocCard = (d: CompanyDocument, nestedInGroup: boolean) => {
          const isExpanded = expanded.has(d.id);
          const detail = details[d.id];
          const expColor = expBadgeColor(d.expirationStatus);
          const typeLabel = documentTypeLabel(d.type, types);
          const singleton = isSingletonType(d.type, types);
          const versionCount = d._count?.versions ?? 0;
          return (
            <Card.Root key={d.id} variant="outline">
              <Card.Body p={2}>
                <VStack align="stretch" gap={1}>
                  <HStack justify="space-between" align="start" gap={1}>
                    <VStack align="start" gap={0.5} flex="1" minW={0} w="full">
                      <HStack gap={1.5} wrap="wrap" align="center" w="full" minW={0}>
                        {/* Inner HStack keeps the icon and title locked
                            together — on narrow screens the icon was wrapping
                            onto its own row when the outer HStack wrapped
                            after every child. */}
                        <HStack gap={1.5} wrap="nowrap" align="center" minW={0} flex="1">
                          <Box flexShrink={0} display="inline-flex"><FileText size={13} /></Box>
                          <Text fontSize="sm" fontWeight="semibold" lineClamp={2} minW={0}>{d.title}</Text>
                        </HStack>
                        {d.adminHidden && (
                          <Badge size="xs" colorPalette="red" variant="subtle" px="1.5" title="Hidden from Admins">
                            <EyeOff size={9} />
                          </Badge>
                        )}
                        {d.archivedAt && (
                          <Badge size="xs" colorPalette="gray" variant="solid" px="1.5">Archived</Badge>
                        )}
                      </HStack>
                      {(!nestedInGroup || d.expiresAt) && (
                        <HStack gap={1.5} wrap="wrap" fontSize="xs" color="fg.muted" align="center">
                          {!nestedInGroup && (
                            <Badge size="xs" colorPalette="blue" variant="subtle" px="1.5">
                              {typeLabel}
                            </Badge>
                          )}
                          {d.expiresAt && (
                            <Badge size="xs" colorPalette={expColor} variant="subtle" px="1.5">
                              Exp {fmtDateShort(d.expiresAt)}
                            </Badge>
                          )}
                        </HStack>
                      )}
                    </VStack>
                    <HStack gap={0.5} flexShrink={0}>
                      {d.currentVersion && (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            px="1.5"
                            minW="0"
                            onClick={() => openVersion(d.id, d.currentVersion!, "view", d.title)}
                            title={isTextDoc(d.currentVersion) ? "View document" : "Open in browser"}
                          >
                            <Eye size={13} />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            px="1.5"
                            minW="0"
                            onClick={() => openVersion(d.id, d.currentVersion!, "download", d.title)}
                            title="Download"
                          >
                            <Download size={13} />
                          </Button>
                        </>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        px="1.5"
                        minW="0"
                        onClick={() => copyShareLink({ docId: d.id, label: d.title })}
                        title="Copy link to this document"
                      >
                        <Link2 size={13} />
                      </Button>
                      <Button size="xs" variant="ghost" px="1.5" minW="0" onClick={() => toggleExpanded(d.id)}>
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </Button>
                    </HStack>
                  </HStack>

                  {/* Description spans the full card width, outside the
                      top HStack, so it isn't squeezed by the action button
                      column on narrow screens. Singletons inherit the
                      type-level description; multi-instance docs use their
                      own per-doc description. */}
                  {singleton && documentTypeDescription(d.type, types) && (
                    <Text fontSize="xs" color="fg.muted" lineClamp={2}>{documentTypeDescription(d.type, types)}</Text>
                  )}
                  {d.description && !singleton && (
                    <Text fontSize="xs" color="fg.muted" lineClamp={2}>{d.description}</Text>
                  )}

                  {isExpanded && (
                    <Box pl={4} borderLeftWidth="2px" borderColor="gray.200">
                      {!detail ? (
                        <HStack py={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
                      ) : (
                        <VStack align="stretch" gap={2}>
                          <Text fontSize="xs" color="fg.muted">
                            {versionCount} {versionCount === 1 ? "version" : "versions"} · updated {fmtDateShort(d.updatedAt)}
                          </Text>
                          {isSuper && !d.archivedAt && (
                            <HStack gap={2} wrap="wrap">
                              <Button size="xs" variant="outline" colorPalette="teal" onClick={() => setVersionUploadDocId(d.id)}>
                                <Upload size={12} /> Upload new version
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => setEditingDoc(d)}>
                                <Pencil size={12} /> Edit
                              </Button>
                              <Button size="xs" variant="outline" colorPalette="orange" onClick={() => setConfirmAction({ kind: "archive", doc: d })}>
                                <Archive size={12} /> Archive
                              </Button>
                            </HStack>
                          )}
                          {isSuper && d.archivedAt && (
                            <HStack gap={2} wrap="wrap">
                              <Button size="xs" variant="outline" colorPalette="teal" onClick={() => setConfirmAction({ kind: "unarchive", doc: d })}>
                                <ArchiveRestore size={12} /> Restore from archive
                              </Button>
                              <Button size="xs" variant="outline" colorPalette="red" onClick={() => setConfirmAction({ kind: "hardDelete", doc: d })}>
                                <Trash2 size={12} /> Delete forever
                              </Button>
                            </HStack>
                          )}

                          <Text fontSize="xs" fontWeight="medium" color="fg.muted">Versions</Text>
                          {detail.versions.length === 0 ? (
                            <Text fontSize="xs" color="fg.muted">No versions uploaded yet.</Text>
                          ) : (
                            <VStack align="stretch" gap={1}>
                              {detail.versions.map((v) => {
                                const isCurrent = v.id === d.currentVersionId;
                                return (
                                  <HStack key={v.id} gap={2} py={1} borderBottomWidth="1px" borderColor="gray.100">
                                    <Text fontSize="xs" flex="1" minW={0} truncate>
                                      {isCurrent && <Badge size="xs" colorPalette="green" variant="solid" mr={1}>Current</Badge>}
                                      {v.originalFilename} · {fmtSize(v.sizeBytes)} · {fmtDateShort(v.uploadedAt)}
                                      {v.uploadedBy?.displayName ? ` · ${v.uploadedBy.displayName}` : ""}
                                    </Text>
                                    <Button size="xs" variant="ghost" onClick={() => openVersion(d.id, v, "view", d.title)}>
                                      <Eye size={11} />
                                    </Button>
                                    <Button size="xs" variant="ghost" onClick={() => openVersion(d.id, v, "download", d.title)}>
                                      <Download size={11} />
                                    </Button>
                                    {isSuper && !isCurrent && (
                                      <Button size="xs" variant="ghost" colorPalette="teal" onClick={() => restoreVersion(d.id, v.id)} title="Make this the current version">
                                        <RotateCcw size={11} />
                                      </Button>
                                    )}
                                    {isSuper && !isCurrent && (
                                      <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmAction({ kind: "deleteVersion", doc: d, versionId: v.id, filename: v.originalFilename })}>
                                        <Trash2 size={11} />
                                      </Button>
                                    )}
                                  </HStack>
                                );
                              })}
                            </VStack>
                          )}
                        </VStack>
                      )}
                    </Box>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
          );
        };

        const renderGroup = (
          typeKey: string,
          docs: CompanyDocument[],
          opts: { headerLabel: string; headerDescription: string | null; singleton: boolean },
        ) => {
          // Singleton groups: render the single doc card directly — no wrapping
          // collection card needed since there's exactly one item per type.
          if (opts.singleton) {
            return (
              <Box key={typeKey}>
                {docs.map((d) => renderDocCard(d, true))}
              </Box>
            );
          }

          // Multi-instance groups: render a "collection card" that visually
          // matches a doc card. When expanded, member doc cards nest inside.
          const collapsed = collapsedTypes.has(typeKey);
          const toggleCollapsed = () =>
            setCollapsedTypes((prev) => {
              const next = new Set(prev);
              if (next.has(typeKey)) next.delete(typeKey);
              else next.add(typeKey);
              return next;
            });

          // Roll up expiration status so a collapsed collection conveys risk.
          const collectionExpStatus: "expired" | "expiring" | "active" =
            docs.some((d) => d.expirationStatus === "expired") ? "expired"
              : docs.some((d) => d.expirationStatus === "expiring") ? "expiring"
              : "active";
          const expiredCount = docs.filter((d) => d.expirationStatus === "expired").length;
          const expiringCount = docs.filter((d) => d.expirationStatus === "expiring").length;

          return (
            <Card.Root key={typeKey} variant="outline">
              <Card.Body p={2}>
                <VStack align="stretch" gap={1}>
                  <HStack justify="space-between" align="start" gap={1}>
                    <VStack align="start" gap={0.5} flex="1" minW={0} w="full">
                      <HStack
                        gap={1.5}
                        wrap="nowrap"
                        align="center"
                        cursor="pointer"
                        minW={0}
                        onClick={toggleCollapsed}
                      >
                        <Box flexShrink={0} display="inline-flex"><FileText size={13} /></Box>
                        <Text fontSize="sm" fontWeight="semibold" lineClamp={2} minW={0}>{opts.headerLabel}</Text>
                      </HStack>
                      <Badge size="sm" colorPalette="teal" variant="solid" px="2" borderRadius="full">
                        {docs.length} {docs.length === 1 ? "document" : "documents"}
                      </Badge>
                      {(expiredCount > 0 || (expiringCount > 0 && collectionExpStatus !== "expired")) && (
                        <HStack gap={1.5} wrap="wrap" fontSize="xs" color="fg.muted" align="center">
                          {expiredCount > 0 && (
                            <Badge size="xs" colorPalette="red" variant="subtle" px="1.5">
                              {expiredCount} expired
                            </Badge>
                          )}
                          {expiringCount > 0 && collectionExpStatus !== "expired" && (
                            <Badge size="xs" colorPalette="yellow" variant="subtle" px="1.5">
                              {expiringCount} expiring
                            </Badge>
                          )}
                        </HStack>
                      )}
                      {opts.headerDescription && (
                        <Text fontSize="xs" color="fg.muted" lineClamp={2}>{opts.headerDescription}</Text>
                      )}
                    </VStack>
                    <HStack gap={0.5} flexShrink={0}>
                      {docs.some((d) => d.currentVersion) && (
                        <Button
                          size="xs"
                          variant="ghost"
                          px="1.5"
                          minW="0"
                          onClick={() => downloadAll(docs, opts.headerLabel)}
                          title="Download all documents in this collection"
                        >
                          <Download size={13} />
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        px="1.5"
                        minW="0"
                        onClick={() => copyShareLink({ typeKey, label: opts.headerLabel })}
                        title="Copy link to this collection"
                      >
                        <Link2 size={13} />
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        px="1.5"
                        minW="0"
                        onClick={toggleCollapsed}
                        title={collapsed ? "Expand collection" : "Collapse collection"}
                      >
                        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      </Button>
                    </HStack>
                  </HStack>

                  {!collapsed && (
                    <Box pl={3} borderLeftWidth="2px" borderColor="gray.200" mt={1}>
                      <VStack align="stretch" gap={2}>
                        {docs.map((d) => renderDocCard(d, true))}
                        {isSuper && (
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="teal"
                            alignSelf="start"
                            onClick={() => { setUploadInitialType(typeKey); setUploadOpen(true); }}
                          >
                            <Plus size={11} /> Add {opts.headerLabel}
                          </Button>
                        )}
                      </VStack>
                    </Box>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
          );
        };

        return (
          <VStack align="stretch" gap={4}>
            {orderedTypes.map((t) =>
              renderGroup(t.key, byType[t.key], {
                headerLabel: t.label,
                headerDescription: t.description ?? documentTypeDescription(t.key, types),
                singleton: !!t.singleton,
              }),
            )}
            {orphanKeys.map((k) =>
              renderGroup(k, byType[k], {
                headerLabel: documentTypeLabel(k, types),
                headerDescription: null,
                singleton: false,
              }),
            )}
          </VStack>
        );
      })()}
      </Box>

      {isSuper && (
        <>
          <UploadDocumentDialog
            open={uploadOpen}
            onOpenChange={setUploadOpen}
            types={types}
            takenSingletonKeys={takenSingletonKeys}
            apiBase={apiBase}
            initialType={uploadInitialType}
            onCreated={() => { void load(); }}
          />
          <UploadDocumentVersionDialog
            open={!!versionUploadDocId}
            onOpenChange={(o) => { if (!o) setVersionUploadDocId(null); }}
            documentId={versionUploadDocId}
            apiBase={apiBase}
            defaultExpiresAt={items.find((i) => i.id === versionUploadDocId)?.expiresAt ?? null}
            onUploaded={() => {
              const id = versionUploadDocId;
              setVersionUploadDocId(null);
              if (id) void loadDetail(id);
              void load();
            }}
          />
          <EditDocumentMetadataDialog
            open={!!editingDoc}
            onOpenChange={(o) => { if (!o) setEditingDoc(null); }}
            doc={editingDoc}
            apiBase={apiBase}
            isSingletonType={editingDoc ? isSingletonType(editingDoc.type, types) : false}
            onSaved={() => { setEditingDoc(null); void load(); }}
          />
          <ConfirmDialog
            open={!!confirmAction}
            title={
              confirmAction?.kind === "archive" ? "Archive document?"
                : confirmAction?.kind === "unarchive" ? "Restore document?"
                : confirmAction?.kind === "hardDelete" ? "Permanently delete?"
                : confirmAction?.kind === "deleteVersion" ? "Delete this version?"
                : ""
            }
            message={
              confirmAction?.kind === "archive"
                ? `Archive "${confirmAction.doc.title}"? You can restore it later.`
                : confirmAction?.kind === "unarchive"
                ? `Restore "${confirmAction.doc.title}" from archive?`
                : confirmAction?.kind === "hardDelete"
                ? `This will permanently delete "${confirmAction.doc.title}" and all its versions from R2. This cannot be undone.`
                : confirmAction?.kind === "deleteVersion"
                ? `Delete version "${confirmAction.filename}"? The file will be purged from storage.`
                : ""
            }
            confirmLabel={
              confirmAction?.kind === "hardDelete" ? "Delete forever"
                : confirmAction?.kind === "deleteVersion" ? "Delete"
                : confirmAction?.kind === "archive" ? "Archive"
                : "Restore"
            }
            confirmColorPalette={
              confirmAction?.kind === "hardDelete" || confirmAction?.kind === "deleteVersion" ? "red" : "teal"
            }
            onConfirm={() => {
              if (!confirmAction) return;
              if (confirmAction.kind === "archive") archive(confirmAction.doc.id);
              else if (confirmAction.kind === "unarchive") unarchive(confirmAction.doc.id);
              else if (confirmAction.kind === "hardDelete") hardDelete(confirmAction.doc.id);
              else if (confirmAction.kind === "deleteVersion") deleteVersion(confirmAction.doc.id, confirmAction.versionId);
              setConfirmAction(null);
            }}
            onCancel={() => setConfirmAction(null)}
          />
        </>
      )}

      {/* In-app markdown/text viewer — available to admin and super. */}
      <MarkdownViewerDialog
        open={mdViewer.open}
        onClose={() => setMdViewer((s) => ({ ...s, open: false }))}
        title={mdViewer.title}
        text={mdViewer.text}
        loading={mdViewer.loading}
        error={mdViewer.error}
        downloadUrl={mdViewer.downloadUrl}
      />
    </Box>
  );
}
