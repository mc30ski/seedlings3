"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

// ─────────────────────────────────────────────────────────────────────────────
// Vanity URLs — Super-only editor.
//
// Configurable branded shortcuts served on seedlings.pro (currently
// hardcoded in the API host allowlist; moves to a Setting when Phase 2
// of the promo multi-domain work lands).
//
// Two kinds per row:
//   LANDING  — headline + body + CTA (renders a marketing page in-app)
//   REDIRECT — 302s to a configured destination URL
//
// One row can be flagged isDefault=true; that page renders when a
// visitor hits an unknown slug. The tab groups the default at the top
// so operator sees the fallback state at a glance.
// ─────────────────────────────────────────────────────────────────────────────

type VanityKind = "LANDING" | "REDIRECT";

type VanityPage = {
  id: string;
  slug: string;
  kind: VanityKind;
  isDefault: boolean;
  title: string;
  headline: string;
  body: string;
  ctaText: string | null;
  ctaUrl: string | null;
  imageR2Key: string | null;
  redirectUrl: string | null;
  enabled: boolean;
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
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;

// Domain used in the live URL preview. Hardcoded to the primary
// marketing domain — matches the API host allowlist.
const VANITY_PREVIEW_DOMAIN = "seedlings.pro";

export default function VanityUrlsTab() {
  const [pages, setPages] = useState<VanityPage[] | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);

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
            Branded shortcuts on <b>{VANITY_PREVIEW_DOMAIN}</b>. Each URL is
            either a landing page or a redirect. Mark one as default so any
            unknown slug shows something branded instead of a 404.
          </Text>
        </VStack>
        <Button
          size="sm"
          colorPalette="teal"
          onClick={() => openEditor("new")}
        >
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

      {pages.map((p) => (
        <Card.Root
          key={p.id}
          variant="outline"
          borderColor={p.isDefault ? "teal.300" : "gray.200"}
        >
          <Card.Body>
            <HStack justify="space-between" align="start" gap={3}>
              <VStack align="start" gap={1} flex="1" minW="0">
                <HStack gap={2} wrap="wrap">
                  <Text fontFamily="mono" fontSize="sm" fontWeight="semibold">
                    {VANITY_PREVIEW_DOMAIN}/{p.slug}
                  </Text>
                  <Badge
                    size="sm"
                    colorPalette={p.kind === "LANDING" ? "blue" : "purple"}
                    variant="subtle"
                  >
                    {p.kind === "LANDING" ? "Landing" : "Redirect"}
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
                {p.kind === "LANDING" ? (
                  <>
                    {p.headline && (
                      <Text fontSize="sm" color="fg.default" truncate>
                        {p.headline}
                      </Text>
                    )}
                    {p.body && (
                      <Text fontSize="xs" color="fg.muted" truncate>
                        {p.body.slice(0, 120)}
                        {p.body.length > 120 ? "…" : ""}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text fontSize="xs" color="fg.muted" truncate>
                    → {p.redirectUrl || "(no destination set)"}
                  </Text>
                )}
                <Text fontSize="xs" color="fg.muted">
                  {p.viewCount} views
                </Text>
              </VStack>
              <Button size="xs" variant="outline" onClick={() => openEditor(p.id)}>
                Edit
              </Button>
            </HStack>
          </Card.Body>
        </Card.Root>
      ))}

      {editingId !== null && (
        <VanityEditor
          existing={editingPage}
          isNew={editingId === "new"}
          onCancel={closeEditor}
          onSaved={onSaved}
          allPages={pages}
        />
      )}
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
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [kind, setKind] = useState<VanityKind>(existing?.kind ?? "LANDING");
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [headline, setHeadline] = useState(existing?.headline ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [ctaText, setCtaText] = useState(existing?.ctaText ?? "");
  const [ctaUrl, setCtaUrl] = useState(existing?.ctaUrl ?? "");
  const [redirectUrl, setRedirectUrl] = useState(existing?.redirectUrl ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Live slug validation — surface issues before Save. Same rules as
  // the API's Zod schema, mirrored client-side for immediate feedback.
  const slugError = useMemo(() => {
    if (!slug.trim()) return "Slug is required.";
    const lower = slug.toLowerCase();
    if (!SLUG_PATTERN.test(lower)) {
      return "Lowercase letters, digits, and single hyphens only (1–40 chars, no leading/trailing hyphen, no double hyphens).";
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
    if (kind === "REDIRECT" && !redirectUrl.trim()) return "Redirect URLs need a destination.";
    return null;
  }, [kind, headline, redirectUrl]);

  const canSave = !slugError && !kindError;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    try {
      const payload = {
        slug: slug.toLowerCase(),
        kind,
        isDefault,
        title,
        headline,
        body,
        ctaText: ctaText.trim() || null,
        ctaUrl: ctaUrl.trim() || null,
        redirectUrl: kind === "REDIRECT" ? redirectUrl.trim() : null,
        enabled,
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

  async function handleDelete() {
    if (!existing) return;
    setBusy(true);
    try {
      await apiDelete(`/api/super/vanity/${existing.id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Vanity URL deleted." });
      onSaved();
    } catch (e: any) {
      publishInlineMessage({
        type: "ERROR",
        text: `Delete failed: ${e?.message ?? "unknown"}`,
      });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const kindCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "Landing page", value: "LANDING" },
          { label: "Redirect", value: "REDIRECT" },
        ],
      }),
    [],
  );

  const previewUrl = `https://${VANITY_PREVIEW_DOMAIN}/${slug || "…"}`;

  return (
    <Dialog.Root open={true} onOpenChange={(e) => !e.open && onCancel()} size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {isNew ? "New vanity URL" : `Edit ${existing?.slug ?? ""}`}
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

                {/* Kind picker */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Kind
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
                        <Select.ValueText />
                      </Select.Trigger>
                    </Select.Control>
                    <Portal>
                      <Select.Positioner>
                        <Select.Content>
                          {kindCollection.items.map((item) => (
                            <Select.Item key={item.value} item={item}>
                              {item.label}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Portal>
                  </Select.Root>
                </Box>

                {/* Landing fields */}
                {kind === "LANDING" && (
                  <>
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
                    <HStack gap={3} align="start">
                      <Box flex="1">
                        <Text fontSize="sm" fontWeight="medium" mb={1}>
                          Button label (optional)
                        </Text>
                        <Input
                          size="sm"
                          placeholder="Get a free estimate"
                          value={ctaText}
                          onChange={(e) => setCtaText(e.target.value)}
                        />
                      </Box>
                      <Box flex="2">
                        <Text fontSize="sm" fontWeight="medium" mb={1}>
                          Button link (optional)
                        </Text>
                        <Input
                          size="sm"
                          placeholder="https://…"
                          value={ctaUrl}
                          onChange={(e) => setCtaUrl(e.target.value)}
                        />
                      </Box>
                    </HStack>
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

                {kindError && (
                  <Text fontSize="xs" color="red.600">
                    {kindError}
                  </Text>
                )}

                {/* Toggles */}
                <VStack align="stretch" gap={2}>
                  <HStack gap={2}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    <Text fontSize="sm">Enabled (hide without deleting when off)</Text>
                  </HStack>
                  {kind === "LANDING" && (
                    <HStack gap={2}>
                      <input
                        type="checkbox"
                        checked={isDefault}
                        onChange={(e) => setIsDefault(e.target.checked)}
                      />
                      <Text fontSize="sm">
                        Use as default (shown when a visitor hits an unknown slug)
                      </Text>
                    </HStack>
                  )}
                </VStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="full">
                <Box>
                  {!isNew && existing && !existing.isDefault && (
                    <Button
                      variant="outline"
                      colorPalette="red"
                      size="sm"
                      onClick={() => setConfirmDelete(true)}
                      disabled={busy}
                    >
                      Delete
                    </Button>
                  )}
                </Box>
                <HStack gap={2}>
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
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${existing?.slug ?? ""}?`}
        confirmLabel="Delete"
        confirmColorPalette="red"
        message=""
        messageNode={
          <Text fontSize="sm">
            This removes the vanity URL immediately. Anyone with a link to{" "}
            <b>seedlings.pro/{existing?.slug}</b> will land on the default page
            (or 404 if no default is configured). Cannot be undone.
          </Text>
        }
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </Dialog.Root>
  );
}
