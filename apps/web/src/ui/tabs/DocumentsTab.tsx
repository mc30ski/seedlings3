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

  // Endpoint base reflects the audience, not the caller's role: the Admin
  // tab always uses `/api/admin/documents` so Super-only docs are filtered
  // server-side even when the caller happens to be Super. The Super tab uses
  // `/api/super/documents` for the full view + writes.
  const apiBase = isSuper ? "/api/super/documents" : "/api/admin/documents";

  // Deep-link target: `?docId=<id>` filters to a single doc; `?typeKey=<key>`
  // filters to a type group. Applied once on mount and stripped from the URL
  // so a subsequent reload doesn't keep re-applying.
  const [highlightDocId, setHighlightDocId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const docId = url.searchParams.get("docId");
    const typeKey = url.searchParams.get("typeKey");
    if (docId) setHighlightDocId(docId);
    if (typeKey) setTypeFilter([typeKey]);
    if (docId || typeKey) {
      url.searchParams.delete("docId");
      url.searchParams.delete("typeKey");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

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

  async function openVersion(docId: string, versionId: string, mode: "view" | "download") {
    try {
      const { url } = await apiGet<{ url: string }>(
        `${apiBase}/${docId}/versions/${versionId}/url?mode=${mode}`,
      );
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to open.", err) });
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
          placeholder="Search title, description, type…"
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
      {highlightDocId && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          <Badge
            size="sm"
            colorPalette="teal"
            variant="subtle"
            cursor="pointer"
            px="2"
            onClick={() => setHighlightDocId(null)}
            title="Show all documents"
          >
            Linked to one document <X size={11} style={{ marginLeft: 4 }} />
          </Badge>
        </HStack>
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
                    <VStack align="start" gap={0.5} flex="1" minW={0}>
                      <HStack gap={1.5} wrap="wrap" align="center">
                        <FileText size={13} />
                        <Text fontSize="sm" fontWeight="semibold" lineClamp={2}>{d.title}</Text>
                        {d.adminHidden && (
                          <Badge size="xs" colorPalette="purple" variant="subtle" px="1.5" title="Hidden from Admins">
                            <EyeOff size={9} />
                          </Badge>
                        )}
                        {d.archivedAt && (
                          <Badge size="xs" colorPalette="gray" variant="solid" px="1.5">Archived</Badge>
                        )}
                      </HStack>
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
                        <Text>{versionCount} ver · upd {fmtDateShort(d.updatedAt)}</Text>
                      </HStack>
                      {/* Per-doc description shown for multi-instance docs
                          only — singleton docs use the type-level description
                          rendered on the (non-existent for singletons) wrapper
                          or, when standalone, omitted entirely. */}
                      {d.description && !singleton && (
                        <Text fontSize="xs" color="fg.muted" lineClamp={2}>{d.description}</Text>
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
                            onClick={() => openVersion(d.id, d.currentVersion!.id, "view")}
                            title="Open in browser"
                          >
                            <Eye size={13} />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            px="1.5"
                            minW="0"
                            onClick={() => openVersion(d.id, d.currentVersion!.id, "download")}
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

                  {isExpanded && (
                    <Box pl={4} borderLeftWidth="2px" borderColor="gray.200">
                      {!detail ? (
                        <HStack py={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
                      ) : (
                        <VStack align="stretch" gap={2}>
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
                                    <Button size="xs" variant="ghost" onClick={() => openVersion(d.id, v.id, "view")}>
                                      <Eye size={11} />
                                    </Button>
                                    <Button size="xs" variant="ghost" onClick={() => openVersion(d.id, v.id, "download")}>
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
                    <VStack align="start" gap={0.5} flex="1" minW={0}>
                      <HStack
                        gap={1.5}
                        wrap="wrap"
                        align="center"
                        cursor="pointer"
                        onClick={toggleCollapsed}
                      >
                        <FileText size={13} />
                        <Text fontSize="sm" fontWeight="semibold">{opts.headerLabel}</Text>
                      </HStack>
                      <HStack gap={1.5} wrap="wrap" fontSize="xs" color="fg.muted" align="center">
                        <Badge size="xs" colorPalette="gray" variant="subtle" px="1.5">
                          {docs.length} {docs.length === 1 ? "document" : "documents"}
                        </Badge>
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
                      {opts.headerDescription && (
                        <Text fontSize="xs" color="fg.muted" lineClamp={2}>{opts.headerDescription}</Text>
                      )}
                    </VStack>
                    <HStack gap={0.5} flexShrink={0}>
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
    </Box>
  );
}
