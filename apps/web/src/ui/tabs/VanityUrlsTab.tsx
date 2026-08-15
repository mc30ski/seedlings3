"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Select,
  Spinner,
  Stack,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  ExternalLink,
  ImagePlus,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { useBranding } from "@/src/lib/useBranding";

// ─────────────────────────────────────────────────────────────────────────────
// Vanity URLs — Super-only editor.
//
// Configurable branded shortcuts served on seedlings.pro (currently
// hardcoded in the API host allowlist; moves to a Setting when Phase 2
// of the promo multi-domain work lands).
//
// Three types per row:
//   LANDING  — headline + body + buttons (renders a marketing page in-app)
//   REDIRECT — 302s to a configured destination URL
//   ALIAS    — mirrors another LANDING page's content under this row's slug
//
// One LANDING row can be flagged isDefault=true; that page renders when a
// visitor hits an unknown slug. The default flag is togglable per-row from
// the tab so operator doesn't have to open the editor to switch it.
//
// Row order is operator-defined (sortOrder) — up/down arrows on each row
// nudge it; the sort is persisted for use by future navigation features.
// ─────────────────────────────────────────────────────────────────────────────

type VanityKind = "LANDING" | "REDIRECT" | "ALIAS";
type VanityButtonKind = "URL" | "PHONE" | "EMAIL";
type VanityButtonSource = "literal" | "business_phone" | "business_email";

type VanityButton = {
  kind: VanityButtonKind;
  label: string;
  // Ignored when source != "literal" — the API swaps in the live
  // Settings value at render time so operator edits flow through.
  target: string;
  source: VanityButtonSource;
};

type VanityPage = {
  id: string;
  slug: string;
  kind: VanityKind;
  isDefault: boolean;
  title: string;
  headline: string;
  body: string;
  // Legacy single-button fields — kept for reading rows created before
  // the buttons column existed. Editor migrates them on next save.
  ctaText: string | null;
  ctaUrl: string | null;
  buttons: VanityButton[] | null;
  imageR2Key: string | null;
  imageUrl: string | null;
  redirectUrl: string | null;
  aliasTargetId: string | null;
  enabled: boolean;
  showInStartupAnimation: boolean;
  sortOrder: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
};

// Local copy of the API's reserved-slug list — surfaced in the editor
// as an inline validation error so operator gets the message BEFORE
// hitting Save. API also blocks these (defense in depth).
const RESERVED_SLUGS = new Set<string>([
  "sign-in",
  "opt-out",
  "pay",
  "promotion",
  "api",
  "mo",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "vanity",
  "admin",
  "super",
]);
// Mirror of the API-side pattern in services/vanityPages.ts — lowercase
// letters, digits, hyphens, and underscores. Leading/trailing hyphen or
// underscore rejected (awkward URLs).
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

// Domain used in the live URL preview. Hardcoded to the primary
// marketing domain — matches the API host allowlist.
const VANITY_PREVIEW_DOMAIN = "seedlings.pro";

// Backfill helper — legacy rows written before the buttons column
// existed have ctaText/ctaUrl populated. When the operator opens such
// a row in the editor, seed the buttons state from those fields so
// they migrate on save.
function normalizeButtons(p: VanityPage | null): VanityButton[] {
  if (!p) return [];
  if (Array.isArray(p.buttons) && p.buttons.length > 0) {
    // Default source to "literal" for rows saved before the source
    // column existed — they're by definition custom values.
    return p.buttons.map((b: any) => ({
      kind: b.kind,
      label: b.label ?? "",
      target: b.target ?? "",
      source: (b.source as VanityButtonSource) ?? "literal",
    }));
  }
  if (p.ctaText && p.ctaUrl) {
    return [{ kind: "URL", label: p.ctaText, target: p.ctaUrl, source: "literal" }];
  }
  return [];
}

export default function VanityUrlsTab() {
  const [pages, setPages] = useState<VanityPage[] | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  // Row-level expand state — Set of vanity page IDs whose body is
  // fully shown. Rows default to truncated at 120 chars.
  const [expandedBodyIds, setExpandedBodyIds] = useState<Set<string>>(new Set());
  const toggleBodyExpanded = useCallback((id: string) => {
    setExpandedBodyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Delete confirmation state — a single dialog reused for the currently
  // targeted row. `deleteBlocked` carries the "aliased by" info when the
  // server refuses; that swaps the dialog copy to explain why.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<{
    slug: string;
    dependents: { id: string; slug: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await apiGet<VanityPage[]>("/api/super/vanity");
      setPages(list);
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Couldn't load vanity URLs: ${e?.message ?? "unknown"}`,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (id: string | "new") => setEditingId(id);
  const closeEditor = () => setEditingId(null);

  const onSaved = async () => {
    setEditingId(null);
    await load();
  };

  const editingPage = useMemo(() => {
    if (editingId === null || editingId === "new") return null;
    return pages?.find((p) => p.id === editingId) ?? null;
  }, [editingId, pages]);

  // Per-row default toggle — sends the flag to the server, then reloads
  // so the local list mirrors the freshly-persisted single-default
  // invariant. Only LANDING rows can be default (server enforces the
  // same rule; button is disabled here as a courtesy).
  const setAsDefault = useCallback(
    async (id: string) => {
      try {
        await apiPatch(`/api/super/vanity/${id}/default`, {});
        await load();
      } catch (e: any) {
        publishInlineMessage({
          type: "ERROR",
          text: `Couldn't set default: ${e?.message ?? "unknown"}`,
        });
      }
    },
    [load],
  );

  // Move a row up / down one slot, or send to the top / bottom.
  // Sends the FULL ordered id list to the server (partial payloads
  // are rejected) so the persisted order stays consistent even if
  // new rows landed since the last load.
  const moveRow = useCallback(
    async (id: string, direction: "up" | "down" | "top" | "bottom") => {
      if (!pages) return;
      const idx = pages.findIndex((p) => p.id === id);
      if (idx < 0) return;
      let targetIdx: number;
      if (direction === "up") targetIdx = idx - 1;
      else if (direction === "down") targetIdx = idx + 1;
      else if (direction === "top") targetIdx = 0;
      else targetIdx = pages.length - 1;
      if (targetIdx === idx) return;
      if (targetIdx < 0 || targetIdx >= pages.length) return;
      const next = pages.slice();
      const [row] = next.splice(idx, 1);
      next.splice(targetIdx, 0, row);
      // Optimistic re-render so the shuffle feels immediate; server
      // returns success and we reload for authoritative sortOrders.
      setPages(next);
      try {
        await apiPatch("/api/super/vanity/reorder", {
          orderedIds: next.map((r) => r.id),
        });
        await load();
      } catch (e: any) {
        publishInlineMessage({
          type: "ERROR",
          text: `Reorder failed: ${e?.message ?? "unknown"}`,
        });
        await load();
      }
    },
    [pages, load],
  );

  // Per-row startup-animation toggle — flips the flag and reloads so
  // the star/sparkle indicator reflects the fresh state. Silent success
  // (the toggled icon is enough visual feedback); errors surface as an
  // inline message.
  const toggleStartupAnimation = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await apiPatch(`/api/super/vanity/${id}/startup-animation`, { enabled });
        await load();
      } catch (e: any) {
        publishInlineMessage({
          type: "ERROR",
          text: `Couldn't toggle animation: ${e?.message ?? "unknown"}`,
        });
      }
    },
    [load],
  );

  // Delete flow: click × → confirm dialog → server call. On success,
  // reload. On ALIASED_BY_OTHERS, swap into the "can't delete" dialog
  // listing the dependent slugs.
  const requestDelete = (id: string) => {
    setDeleteBlocked(null);
    setPendingDeleteId(id);
  };
  const cancelDelete = () => {
    setPendingDeleteId(null);
    setDeleteBlocked(null);
  };
  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteId || !pages) return;
    const row = pages.find((p) => p.id === pendingDeleteId);
    if (!row) return;
    try {
      await apiDelete(`/api/super/vanity/${pendingDeleteId}`);
      publishInlineMessage({ type: "SUCCESS", text: `Deleted "${row.slug}".` });
      setPendingDeleteId(null);
      await load();
    } catch (e: any) {
      // apiDelete throws with a structured error carrying the server
      // response body when available. The block-because-aliased case
      // gets special dialog copy; other errors surface as inline msg.
      const dependents = (e as any)?.body?.dependents;
      const code = (e as any)?.body?.error;
      if (code === "aliased_by_others" && Array.isArray(dependents)) {
        setDeleteBlocked({ slug: row.slug, dependents });
        return;
      }
      publishInlineMessage({
        type: "ERROR",
        text: `Delete failed: ${e?.message ?? "unknown"}`,
      });
      setPendingDeleteId(null);
    }
  }, [pendingDeleteId, pages, load]);

  if (pages === null) {
    return (
      <Box p={6} textAlign="center">
        <Spinner size="lg" />
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4} px={2} py={2}>
      <HStack justify="space-between">
        <VStack align="start" gap={0}>
          <Text fontSize="lg" fontWeight="semibold">
            Vanity URLs
          </Text>
          <Text fontSize="sm" color="fg.muted">
            Branded shortcuts on <b>{VANITY_PREVIEW_DOMAIN}</b>. Landing page, redirect, or alias of another entry. Star one as default so any unknown slug shows something branded instead of a 404.
          </Text>
        </VStack>
        <Button size="sm" colorPalette="teal" onClick={() => openEditor("new")}>
          + Add vanity URL
        </Button>
      </HStack>

      {pages.length === 0 && (
        <Card.Root variant="outline">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted">
              No vanity URLs configured yet. Click <b>Add vanity URL</b> to
              create your first one.
            </Text>
          </Card.Body>
        </Card.Root>
      )}

      {pages.map((p, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === pages.length - 1;
        const aliasTargetSlug =
          p.kind === "ALIAS"
            ? pages.find((o) => o.id === p.aliasTargetId)?.slug ?? null
            : null;
        return (
          <Card.Root
            key={p.id}
            variant="outline"
            borderColor={p.isDefault ? "teal.300" : "gray.200"}
          >
            <Card.Body>
              {/* Mobile: stacks column (reorder → content → actions,
                  each on its own row). Desktop: horizontal row like
                  before. */}
              <Stack
                direction={{ base: "column", md: "row" }}
                justify="space-between"
                align="start"
                gap={3}
              >
                {/* Left rail: reorder controls in a 2×2 grid so they
                    don't stretch the row vertically. Left column is
                    "up-direction" (top / up one), right column is
                    "down-direction" (bottom / down one). */}
                <Box
                  flexShrink={0}
                  display="grid"
                  gridTemplateColumns="repeat(2, 1fr)"
                  gap={0.5}
                >
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label="Send to top"
                    disabled={isFirst}
                    onClick={() => void moveRow(p.id, "top")}
                    title="Send to top"
                  >
                    <ChevronsUp size={14} />
                  </IconButton>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label="Send to bottom"
                    disabled={isLast}
                    onClick={() => void moveRow(p.id, "bottom")}
                    title="Send to bottom"
                  >
                    <ChevronsDown size={14} />
                  </IconButton>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={isFirst}
                    onClick={() => void moveRow(p.id, "up")}
                    title="Move up"
                  >
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={isLast}
                    onClick={() => void moveRow(p.id, "down")}
                    title="Move down"
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                </Box>

                <VStack align="start" gap={1} flex="1" minW="0" w={{ base: "100%", md: "auto" }}>
                  <HStack gap={2} wrap="wrap">
                    <Text fontFamily="mono" fontSize="sm" fontWeight="semibold">
                      {VANITY_PREVIEW_DOMAIN}/{p.slug}
                    </Text>
                    <Badge
                      size="sm"
                      colorPalette={
                        p.kind === "LANDING"
                          ? "blue"
                          : p.kind === "REDIRECT"
                            ? "purple"
                            : "orange"
                      }
                      variant="subtle"
                    >
                      {p.kind === "LANDING"
                        ? "Landing"
                        : p.kind === "REDIRECT"
                          ? "Redirect"
                          : "Alias"}
                    </Badge>
                    {p.isDefault && (
                      <Badge size="sm" colorPalette="teal" variant="solid">
                        Default
                      </Badge>
                    )}
                    {!p.enabled && (
                      <Badge size="sm" colorPalette="gray" variant="subtle">
                        Disabled
                      </Badge>
                    )}
                  </HStack>
                  {p.kind === "LANDING" && (
                    <>
                      {p.headline && (
                        <Text fontSize="sm" color="fg.default" truncate>
                          {p.headline}
                        </Text>
                      )}
                      {p.body && (() => {
                        const isExpanded = expandedBodyIds.has(p.id);
                        const isLong = p.body.length > 120;
                        return (
                          <Box w="100%">
                            <Text
                              fontSize="xs"
                              color="fg.muted"
                              whiteSpace={isExpanded ? "pre-wrap" : "normal"}
                              wordBreak="break-word"
                            >
                              {isExpanded || !isLong ? p.body : `${p.body.slice(0, 120)}…`}
                            </Text>
                            {isLong && (
                              <Button
                                variant="plain"
                                size="xs"
                                px={0}
                                minH="auto"
                                h="auto"
                                color="teal.700"
                                textDecoration="underline"
                                fontSize="xs"
                                fontWeight="normal"
                                mt={1}
                                onClick={() => toggleBodyExpanded(p.id)}
                              >
                                {isExpanded ? "Show less" : "Show more"}
                              </Button>
                            )}
                          </Box>
                        );
                      })()}
                    </>
                  )}
                  {p.kind === "REDIRECT" && (
                    <Text fontSize="xs" color="fg.muted" truncate>
                      → {p.redirectUrl || "(no destination set)"}
                    </Text>
                  )}
                  {p.kind === "ALIAS" && (
                    <Text fontSize="xs" color="fg.muted" truncate>
                      {aliasTargetSlug
                        ? <>mirrors <b>{VANITY_PREVIEW_DOMAIN}/{aliasTargetSlug}</b></>
                        : "(alias target missing — edit to fix)"}
                    </Text>
                  )}
                  <Text fontSize="xs" color="fg.muted">
                    {p.viewCount} views
                  </Text>
                </VStack>
                <HStack gap={1} flexShrink={0}>
                  <IconButton
                    size="xs"
                    variant={p.isDefault ? "solid" : "outline"}
                    colorPalette={p.isDefault ? "teal" : "gray"}
                    aria-label={p.isDefault ? "Default page" : "Set as default"}
                    disabled={p.kind !== "LANDING" || p.isDefault}
                    onClick={() => void setAsDefault(p.id)}
                    title={
                      p.kind !== "LANDING"
                        ? "Only landing pages can be default"
                        : p.isDefault
                          ? "This is the default page"
                          : "Set as default (shown for unknown slugs)"
                    }
                  >
                    <Star size={12} fill={p.isDefault ? "currentColor" : "none"} />
                  </IconButton>
                  <IconButton
                    size="xs"
                    variant={p.showInStartupAnimation ? "solid" : "outline"}
                    colorPalette={p.showInStartupAnimation ? "purple" : "gray"}
                    aria-label={
                      p.showInStartupAnimation
                        ? "In startup animation — click to remove"
                        : "Add to startup animation"
                    }
                    onClick={() => void toggleStartupAnimation(p.id, !p.showInStartupAnimation)}
                    title={
                      p.showInStartupAnimation
                        ? "In the app startup animation — click to remove"
                        : "Include in the app startup animation"
                    }
                  >
                    <Sparkles size={12} />
                  </IconButton>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      // In dev, open on the current localhost origin so we
                      // exercise the LOCAL server; only prod points at the
                      // real seedlings.pro domain.
                      const host = window.location.hostname;
                      const isDev = host === "localhost" || host === "127.0.0.1";
                      const target = isDev
                        ? `${window.location.origin}/${p.slug}`
                        : `https://${VANITY_PREVIEW_DOMAIN}/${p.slug}`;
                      window.open(target, "_blank", "noopener,noreferrer");
                    }}
                    title="Open in a new tab"
                  >
                    <ExternalLink size={12} />
                    Open
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => openEditor(p.id)}>
                    Edit
                  </Button>
                  <IconButton
                    size="xs"
                    variant="outline"
                    colorPalette="red"
                    aria-label="Delete vanity URL"
                    onClick={() => requestDelete(p.id)}
                    title="Delete this vanity URL"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </HStack>
              </Stack>
            </Card.Body>
          </Card.Root>
        );
      })}

      {editingId !== null && (
        <VanityEditor
          existing={editingPage}
          isNew={editingId === "new"}
          onCancel={closeEditor}
          onSaved={onSaved}
          allPages={pages}
        />
      )}

      {/* Delete confirm (normal path). Extra warning stacks on top
          when the target row is the current default — the site loses
          its fallback page until another row is starred. */}
      {(() => {
        const target = pages.find((p) => p.id === pendingDeleteId);
        const targetSlug = target?.slug ?? "";
        return (
          <ConfirmDialog
            open={pendingDeleteId !== null && !deleteBlocked}
            title={`Delete "${targetSlug}"?`}
            confirmLabel="Delete"
            confirmColorPalette="red"
            message=""
            messageNode={
              <VStack align="stretch" gap={3}>
                {target?.isDefault && (
                  <Box
                    borderWidth="1px"
                    borderColor="orange.300"
                    bg="orange.50"
                    borderRadius="md"
                    p={3}
                  >
                    <Text fontSize="sm" color="orange.900">
                      <b>"{targetSlug}" is currently the default page.</b>{" "}
                      After deletion, no fallback exists — visitors who hit an
                      unknown vanity slug will get a 404 until you star another
                      landing page as default.
                    </Text>
                  </Box>
                )}
                <Text fontSize="sm">
                  This removes the vanity URL immediately. Anyone with a link to{" "}
                  <b>
                    {VANITY_PREVIEW_DOMAIN}/{targetSlug}
                  </b>{" "}
                  will land on the default page (or 404 if no default is configured).
                  Cannot be undone.
                </Text>
              </VStack>
            }
            onConfirm={() => void confirmDelete()}
            onCancel={cancelDelete}
          />
        );
      })()}

      {/* Delete blocked (aliased-by-others) — informational, no confirm */}
      <Dialog.Root
        open={!!deleteBlocked}
        onOpenChange={(e) => !e.open && cancelDelete()}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Can&apos;t delete &quot;{deleteBlocked?.slug}&quot;</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm">
                    This page is used as the content source by{" "}
                    <b>{deleteBlocked?.dependents.length}</b>{" "}
                    other vanity URL
                    {deleteBlocked?.dependents.length === 1 ? "" : "s"}:
                  </Text>
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3} bg="gray.50">
                    <VStack align="start" gap={1}>
                      {deleteBlocked?.dependents.map((d) => (
                        <Text key={d.id} fontFamily="mono" fontSize="sm">
                          {VANITY_PREVIEW_DOMAIN}/{d.slug}
                        </Text>
                      ))}
                    </VStack>
                  </Box>
                  <Text fontSize="sm" color="fg.muted">
                    Delete or repoint those aliases first, then delete this page.
                  </Text>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={cancelDelete}>
                  OK
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </VStack>
  );
}

// ── Editor dialog ────────────────────────────────────────────────────

function VanityEditor({
  existing,
  isNew,
  onCancel,
  onSaved,
  allPages,
}: {
  existing: VanityPage | null;
  isNew: boolean;
  onCancel: () => void;
  onSaved: () => void;
  allPages: VanityPage[];
}) {
  // Pull business phone / email from Settings so the button editor can
  // one-click populate a call/email button target with the configured
  // default. Empty string when the setting isn't set — the "Use
  // default" button is hidden in that case.
  const { businessPhone, businessEmail } = useBranding();
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [kind, setKind] = useState<VanityKind>(existing?.kind ?? "LANDING");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [headline, setHeadline] = useState(existing?.headline ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [buttons, setButtons] = useState<VanityButton[]>(normalizeButtons(existing));
  const [redirectUrl, setRedirectUrl] = useState(existing?.redirectUrl ?? "");
  const [aliasTargetId, setAliasTargetId] = useState<string>(existing?.aliasTargetId ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // Local mirror of the hero image so upload/remove can reflect
  // immediately in the editor without waiting on a full parent reload.
  const [imageUrl, setImageUrl] = useState<string | null>(existing?.imageUrl ?? null);
  const [imageBusy, setImageBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refreshImage(id: string) {
    try {
      const fresh = await apiGet<VanityPage>(`/api/super/vanity/${id}`);
      setImageUrl(fresh?.imageUrl ?? null);
    } catch {
      // Silent — the upload succeeded; only the local preview lags.
    }
  }

  async function handleUpload(file: File) {
    if (!existing) return;
    setImageBusy(true);
    const contentType = file.type || "image/jpeg";
    // Three stages, each with its own try/catch so the toast message
    // pinpoints exactly which step failed. Without this, every failure
    // just said "Load failed" and there was no way to tell CORS from
    // presign from confirm.
    let uploadUrl = "";
    let key = "";
    try {
      const presigned = await apiPost<{ uploadUrl: string; key: string }>(
        `/api/super/vanity/${existing.id}/image-upload-url`,
        { contentType },
      );
      uploadUrl = presigned.uploadUrl;
      key = presigned.key;
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Presign failed: ${e?.message ?? String(e)}`,
      });
      setImageBusy(false);
      return;
    }
    if (!uploadUrl) {
      publishInlineMessage({
        type: "ERROR",
        text: "Presign returned empty upload URL.",
      });
      setImageBusy(false);
      return;
    }
    let uploadHost = "";
    let uploadBucket = "";
    try {
      const u = new URL(uploadUrl);
      uploadHost = u.host;
      // With forcePathStyle, R2 URLs look like
      //   https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
      // The first path segment IS the bucket name — surfacing it in
      // the toast so operator knows exactly which bucket's CORS to
      // check when the PUT is rejected.
      uploadBucket = u.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      uploadHost = "(invalid URL)";
    }
    try {
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: file,
      });
      if (!put.ok) {
        publishInlineMessage({
          type: "ERROR",
          text: `Storage PUT rejected: ${put.status} ${put.statusText} (bucket: ${uploadBucket || "?"})`,
        });
        setImageBusy(false);
        return;
      }
    } catch (e: any) {
      // Log full details to console so we can inspect the presigned
      // URL, network error stack, and any Response object attached to
      // the error. The toast only carries the summary.
      // eslint-disable-next-line no-console
      console.error("[vanity upload] PUT failed", {
        error: e,
        message: e?.message,
        name: e?.name,
        stack: e?.stack,
        uploadUrl,
        contentType,
        fileType: file.type,
        fileSize: file.size,
        origin: window.location.origin,
      });
      publishInlineMessage({
        type: "ERROR",
        text: `Storage PUT network error (bucket: ${uploadBucket || "?"}, host: ${uploadHost}): ${e?.message ?? String(e)}. Full details in browser console.`,
      });
      setImageBusy(false);
      return;
    }
    try {
      await apiPost(`/api/super/vanity/${existing.id}/confirm-image`, { key });
      await refreshImage(existing.id);
      publishInlineMessage({ type: "SUCCESS", text: "Image uploaded." });
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Confirm failed: ${e?.message ?? String(e)}`,
      });
    } finally {
      setImageBusy(false);
    }
  }

  async function handleRemoveImage() {
    if (!existing) return;
    setImageBusy(true);
    try {
      await apiDelete(`/api/super/vanity/${existing.id}/image`);
      setImageUrl(null);
      publishInlineMessage({ type: "SUCCESS", text: "Image removed." });
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Remove failed: ${e?.message ?? "unknown"}`,
      });
    } finally {
      setImageBusy(false);
    }
  }
  const [busy, setBusy] = useState(false);

  // Live slug validation — surface issues before Save. Same rules as
  // the API's Zod schema, mirrored client-side for immediate feedback.
  const slugError = useMemo(() => {
    if (!slug.trim()) return "Slug is required.";
    const lower = slug.toLowerCase();
    if (!SLUG_PATTERN.test(lower)) {
      return "Lowercase letters, digits, hyphens, or underscores (1–40 chars, no leading/trailing hyphen or underscore).";
    }
    if (RESERVED_SLUGS.has(lower)) {
      return `"${lower}" is a reserved path.`;
    }
    // Duplicate check against sibling rows (skip self on edit).
    const collision = allPages.find(
      (p) => p.slug === lower && p.id !== existing?.id,
    );
    if (collision) return `Slug "${lower}" is already used by another vanity URL.`;
    return null;
  }, [slug, allPages, existing?.id]);

  const kindError = useMemo(() => {
    if (kind === "LANDING" && !headline.trim()) return "Landing pages need a headline.";
    if (kind === "REDIRECT" && !redirectUrl.trim()) return "Redirects need a destination.";
    if (kind === "ALIAS" && !aliasTargetId) return "Aliases need a target vanity URL to mirror.";
    return null;
  }, [kind, headline, redirectUrl, aliasTargetId]);

  const buttonsError = useMemo(() => {
    if (kind !== "LANDING") return null;
    for (const b of buttons) {
      if (!b.label.trim()) return "Button label required.";
      // Settings-bound buttons don't validate target — the API swaps
      // it in at render time and drops the button if the setting is
      // empty. Still worth warning if BOTH the setting AND the source
      // are empty, but the picker only offers settings-bound options
      // when a value exists.
      if (b.source !== "literal") continue;
      if (!b.target.trim()) {
        if (b.kind === "PHONE") return "Phone number required.";
        if (b.kind === "EMAIL") return "Email address required.";
        return "Web address required.";
      }
      if (b.kind === "URL") {
        try {
          new URL(b.target);
        } catch {
          return "Web address must be a valid https:// URL.";
        }
      }
      if (b.kind === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.target)) {
        return "Email address is not valid.";
      }
      if (b.kind === "PHONE" && !/\d/.test(b.target)) {
        return "Phone number must contain digits.";
      }
    }
    return null;
  }, [kind, buttons]);

  const canSave = !slugError && !kindError && !buttonsError;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    try {
      const payload = {
        slug: slug.toLowerCase(),
        kind,
        // isDefault is now set from the tab, not the editor — send the
        // existing value verbatim so no accidental change happens here.
        isDefault: existing?.isDefault ?? false,
        title,
        headline,
        body,
        // Legacy single-button fields cleared on any save — the buttons
        // array is now the canonical source. Row that had legacy fields
        // migrated via `normalizeButtons` at open time.
        ctaText: null,
        ctaUrl: null,
        buttons: kind === "LANDING" ? buttons : [],
        redirectUrl: kind === "REDIRECT" ? redirectUrl.trim() : null,
        aliasTargetId: kind === "ALIAS" ? aliasTargetId : null,
        enabled,
        // Preserve the existing value on save — this flag is toggled
        // per-row from the tab (Sparkles icon), not from this form.
        showInStartupAnimation: existing?.showInStartupAnimation ?? false,
      };
      if (isNew) {
        await apiPost("/api/super/vanity", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Vanity URL created." });
      } else {
        await apiPatch(`/api/super/vanity/${existing!.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Vanity URL updated." });
      }
      onSaved();
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Save failed: ${e?.message ?? "unknown"}`,
      });
    } finally {
      setBusy(false);
    }
  }

  const kindCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "Landing page", value: "LANDING" },
          { label: "Redirect", value: "REDIRECT" },
          { label: "Alias (mirror another page)", value: "ALIAS" },
        ],
      }),
    [],
  );

  // Alias target options — every LANDING row except the one currently
  // being edited (can't alias yourself). Rebuilds when the row list or
  // the editing id changes.
  const aliasTargetCollection = useMemo(() => {
    const targets = allPages
      .filter((p) => p.kind === "LANDING" && p.id !== existing?.id)
      .map((p) => ({ label: `${VANITY_PREVIEW_DOMAIN}/${p.slug}`, value: p.id }));
    return createListCollection({ items: targets });
  }, [allPages, existing?.id]);

  const buttonKindCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "Web URL", value: "URL" },
          { label: "Phone (tap to call)", value: "PHONE" },
          { label: "Email (opens mail app)", value: "EMAIL" },
        ],
      }),
    [],
  );

  const previewUrl = `https://${VANITY_PREVIEW_DOMAIN}/${slug || "…"}`;

  const addButton = () => {
    if (buttons.length >= 6) return;
    setButtons((prev) => [...prev, { kind: "URL", label: "", target: "", source: "literal" }]);
  };
  const removeButton = (idx: number) => {
    setButtons((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateButton = (idx: number, patch: Partial<VanityButton>) => {
    setButtons((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };

  const buttonKindPlaceholder = (k: VanityButtonKind) => {
    if (k === "PHONE") return "919-555-1234";
    if (k === "EMAIL") return "hello@seedlings.team";
    return "https://…";
  };

  return (
    <Dialog.Root open={true} onOpenChange={(e) => !e.open && onCancel()} size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {isNew ? "New vanity URL" : `Edit "${existing?.slug ?? ""}"`}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                {/* Slug + live preview */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Slug (the URL suffix)
                  </Text>
                  <Input
                    size="sm"
                    placeholder="perties"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    autoFocus
                  />
                  {slugError ? (
                    <Text fontSize="xs" color="red.600" mt={1}>
                      {slugError}
                    </Text>
                  ) : (
                    <Text fontSize="xs" color="fg.muted" mt={1} fontFamily="mono">
                      {previewUrl}
                    </Text>
                  )}
                </Box>

                {/* Type picker */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Type
                  </Text>
                  <Select.Root
                    collection={kindCollection}
                    value={[kind]}
                    onValueChange={(e) => {
                      const v = e.value?.[0] ?? "LANDING";
                      setKind(v as VanityKind);
                    }}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Choose type…" />
                        <Select.Indicator />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {kindCollection.items.map((item) => (
                          <Select.Item key={item.value} item={item}>
                            <Select.ItemText>{item.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>

                {/* Landing fields */}
                {kind === "LANDING" && (
                  <>
                    {/* Hero image — rendered at the top of the public
                        landing page. Optional. Upload flow uses a
                        presigned R2 URL (same pattern as promotion
                        landing images). New rows can't upload until
                        the row exists — we surface a hint. */}
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Hero image (optional)
                      </Text>
                      {imageUrl ? (
                        <Box
                          borderWidth="1px"
                          borderColor="gray.200"
                          borderRadius="md"
                          overflow="hidden"
                          bg="gray.50"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imageUrl}
                            alt="Hero preview"
                            style={{
                              width: "100%",
                              maxHeight: "220px",
                              objectFit: "cover",
                              display: "block",
                            }}
                          />
                          <HStack gap={2} p={2} borderTopWidth="1px" borderColor="gray.200">
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={imageBusy || isNew}
                              onClick={() => fileInputRef.current?.click()}
                            >
                              <Upload size={12} /> Replace
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="red"
                              disabled={imageBusy || isNew}
                              onClick={() => void handleRemoveImage()}
                            >
                              <X size={12} /> Remove
                            </Button>
                          </HStack>
                        </Box>
                      ) : (
                        <Box
                          borderWidth="1px"
                          borderColor="gray.200"
                          borderRadius="md"
                          bg="gray.50"
                          p={4}
                          textAlign="center"
                        >
                          <VStack gap={2}>
                            <Box color="fg.muted">
                              <ImagePlus size={28} />
                            </Box>
                            <Button
                              size="sm"
                              variant="outline"
                              colorPalette="teal"
                              loading={imageBusy}
                              disabled={imageBusy || isNew}
                              onClick={() => fileInputRef.current?.click()}
                            >
                              <Upload size={14} /> Choose image
                            </Button>
                            {isNew && (
                              <Text fontSize="xs" color="fg.muted">
                                Save this vanity URL first, then upload an image.
                              </Text>
                            )}
                          </VStack>
                        </Box>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleUpload(f);
                          // Reset so choosing the same file twice fires
                          // the onChange event again.
                          e.target.value = "";
                        }}
                      />
                    </Box>
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Page title (browser tab)
                      </Text>
                      <Input
                        size="sm"
                        placeholder="Properties in trusted hands"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </Box>
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Headline <Text as="span" color="red.500">*</Text>
                      </Text>
                      <Input
                        size="sm"
                        placeholder="Properties in trusted hands"
                        value={headline}
                        onChange={(e) => setHeadline(e.target.value)}
                      />
                    </Box>
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Body
                      </Text>
                      <Textarea
                        size="sm"
                        rows={6}
                        placeholder="Tell your story here. Supports line breaks."
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                      />
                    </Box>

                    {/* Buttons list — dynamic add/remove, up to 6. Each
                        button has a kind (URL / Phone / Email), a label,
                        and a target that gets tel:/mailto: prefixed at
                        render time based on kind. */}
                    <Box>
                      <HStack justify="space-between" mb={2}>
                        <Text fontSize="sm" fontWeight="medium">
                          Buttons ({buttons.length}/6)
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={addButton}
                          disabled={buttons.length >= 6}
                        >
                          <Plus size={12} /> Add button
                        </Button>
                      </HStack>
                      {buttons.length === 0 && (
                        <Text fontSize="xs" color="fg.muted">
                          No buttons yet. Click <b>Add button</b> to include a
                          call, email, or web link on the page.
                        </Text>
                      )}
                      <VStack align="stretch" gap={3}>
                        {buttons.map((b, idx) => (
                          <Box
                            key={idx}
                            borderWidth="1px"
                            borderColor="gray.200"
                            borderRadius="md"
                            p={3}
                          >
                            <HStack gap={2} align="start">
                              <VStack align="stretch" gap={2} flex="1" minW="0">
                                <HStack gap={2} align="start" wrap="wrap">
                                  <Box minW="180px">
                                    <Text fontSize="xs" color="fg.muted" mb={1}>
                                      Type
                                    </Text>
                                    <Select.Root
                                      collection={buttonKindCollection}
                                      value={[b.kind]}
                                      onValueChange={(e) => {
                                        const nextKind = (e.value?.[0] ?? "URL") as VanityButtonKind;
                                        // Reset source to literal if the new kind can't
                                        // hold the old source (e.g. switching a phone
                                        // button bound to business_phone → email).
                                        const keepSource =
                                          (nextKind === "PHONE" && b.source === "business_phone") ||
                                          (nextKind === "EMAIL" && b.source === "business_email") ||
                                          b.source === "literal";
                                        updateButton(idx, {
                                          kind: nextKind,
                                          source: keepSource ? b.source : "literal",
                                        });
                                      }}
                                      size="sm"
                                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                                    >
                                      <Select.Control>
                                        <Select.Trigger>
                                          <Select.ValueText />
                                          <Select.Indicator />
                                        </Select.Trigger>
                                      </Select.Control>
                                      <Select.Positioner>
                                        <Select.Content>
                                          {buttonKindCollection.items.map((it) => (
                                            <Select.Item key={it.value} item={it}>
                                              <Select.ItemText>{it.label}</Select.ItemText>
                                            </Select.Item>
                                          ))}
                                        </Select.Content>
                                      </Select.Positioner>
                                    </Select.Root>
                                  </Box>
                                  <Box flex="1" minW="140px">
                                    <Text fontSize="xs" color="fg.muted" mb={1}>
                                      Button label
                                    </Text>
                                    <Input
                                      size="sm"
                                      placeholder={
                                        b.kind === "PHONE"
                                          ? "Call us"
                                          : b.kind === "EMAIL"
                                            ? "Email us"
                                            : "Get a free estimate"
                                      }
                                      value={b.label}
                                      onChange={(e) => updateButton(idx, { label: e.target.value })}
                                    />
                                  </Box>
                                </HStack>
                                <Box>
                                  {/* Source picker: literal (typed value) OR
                                      "use the setting" (live-bound so
                                      Settings edits flow through). Only
                                      shown for phone/email kinds where a
                                      matching business Setting exists. */}
                                  {(b.kind === "PHONE" || b.kind === "EMAIL") &&
                                    ((b.kind === "PHONE" && businessPhone) ||
                                      (b.kind === "EMAIL" && businessEmail)) && (
                                      <Box mb={2}>
                                        <VStack align="start" gap={1}>
                                          <HStack gap={2}>
                                            <input
                                              type="radio"
                                              id={`src-lit-${idx}`}
                                              checked={b.source === "literal"}
                                              onChange={() => updateButton(idx, { source: "literal" })}
                                            />
                                            <label htmlFor={`src-lit-${idx}`}>
                                              <Text fontSize="xs">Custom {b.kind === "PHONE" ? "phone" : "email"}</Text>
                                            </label>
                                          </HStack>
                                          <HStack gap={2}>
                                            <input
                                              type="radio"
                                              id={`src-biz-${idx}`}
                                              checked={
                                                b.source ===
                                                (b.kind === "PHONE" ? "business_phone" : "business_email")
                                              }
                                              onChange={() =>
                                                updateButton(idx, {
                                                  source:
                                                    b.kind === "PHONE"
                                                      ? "business_phone"
                                                      : "business_email",
                                                })
                                              }
                                            />
                                            <label htmlFor={`src-biz-${idx}`}>
                                              <Text fontSize="xs">
                                                Business {b.kind === "PHONE" ? "phone" : "email"}{" "}
                                                <Text as="span" color="fg.muted" fontFamily="mono">
                                                  ({b.kind === "PHONE" ? businessPhone : businessEmail})
                                                </Text>
                                              </Text>
                                            </label>
                                          </HStack>
                                        </VStack>
                                        <Text fontSize="2xs" color="fg.muted" mt={1}>
                                          Business option stays in sync with the value in Settings.
                                        </Text>
                                      </Box>
                                    )}
                                  <Text fontSize="xs" color="fg.muted" mb={1}>
                                    {b.kind === "PHONE"
                                      ? "Phone number"
                                      : b.kind === "EMAIL"
                                        ? "Email address"
                                        : "Web address"}
                                  </Text>
                                  <Input
                                    size="sm"
                                    placeholder={buttonKindPlaceholder(b.kind)}
                                    value={
                                      b.source === "literal"
                                        ? b.target
                                        : b.source === "business_phone"
                                          ? businessPhone
                                          : b.source === "business_email"
                                            ? businessEmail
                                            : ""
                                    }
                                    onChange={(e) => updateButton(idx, { target: e.target.value })}
                                    disabled={b.source !== "literal"}
                                  />
                                </Box>
                              </VStack>
                              <IconButton
                                size="xs"
                                variant="ghost"
                                colorPalette="red"
                                aria-label="Remove button"
                                onClick={() => removeButton(idx)}
                              >
                                <X size={14} />
                              </IconButton>
                            </HStack>
                          </Box>
                        ))}
                      </VStack>
                    </Box>
                  </>
                )}

                {/* Redirect field */}
                {kind === "REDIRECT" && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Destination URL <Text as="span" color="red.500">*</Text>
                    </Text>
                    <Input
                      size="sm"
                      placeholder="https://calendly.com/…"
                      value={redirectUrl}
                      onChange={(e) => setRedirectUrl(e.target.value)}
                    />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Visitors to <b>{previewUrl}</b> will be sent here immediately (307 redirect).
                    </Text>
                  </Box>
                )}

                {/* Alias picker */}
                {kind === "ALIAS" && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Mirror this vanity URL <Text as="span" color="red.500">*</Text>
                    </Text>
                    {aliasTargetCollection.items.length === 0 ? (
                      <Text fontSize="xs" color="fg.muted">
                        You need at least one other landing page to alias.
                        Create a Landing type entry first.
                      </Text>
                    ) : (
                      <Select.Root
                        collection={aliasTargetCollection}
                        value={aliasTargetId ? [aliasTargetId] : []}
                        onValueChange={(e) => setAliasTargetId(e.value?.[0] ?? "")}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder="Pick a landing page…" />
                            <Select.Indicator />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {aliasTargetCollection.items.map((it) => (
                              <Select.Item key={it.value} item={it}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    )}
                    {(() => {
                      const target = allPages.find((p) => p.id === aliasTargetId);
                      const targetUrl = target
                        ? `${VANITY_PREVIEW_DOMAIN}/${target.slug}`
                        : null;
                      return (
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          {targetUrl ? (
                            <>
                              This entry shows the same page as{" "}
                              <b>{targetUrl}</b>, but the visitor&apos;s
                              browser stays on <b>{VANITY_PREVIEW_DOMAIN}/{slug || "…"}</b>.
                              Good for exposing one landing page under
                              multiple branded shortcuts without duplicating
                              its copy.
                            </>
                          ) : (
                            <>
                              Pick a landing page above. This entry will show
                              that page&apos;s content while keeping the URL
                              at <b>{VANITY_PREVIEW_DOMAIN}/{slug || "…"}</b>.
                            </>
                          )}
                        </Text>
                      );
                    })()}
                  </Box>
                )}

                {kindError && (
                  <Text fontSize="xs" color="red.600">
                    {kindError}
                  </Text>
                )}
                {buttonsError && (
                  <Text fontSize="xs" color="red.600">
                    {buttonsError}
                  </Text>
                )}

                {/* Enabled toggle — default and startup-animation
                    flags are set per-row from the tab, not here. */}
                <HStack gap={2}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  <Text fontSize="sm">Enabled</Text>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2} w="full">
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  colorPalette="teal"
                  onClick={() => void handleSave()}
                  loading={busy}
                  disabled={!canSave}
                >
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
