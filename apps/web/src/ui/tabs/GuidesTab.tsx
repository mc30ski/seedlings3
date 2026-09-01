"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GuidesTab — the education catalog, reader, editor and review queue.
//
// Canonical spec: docs/features/education.md
//
// Blended additive-scope tab (see reference-tab-blend-pattern):
//   worker  → catalog + reader
//   admin   → + author drafts, submit for approval, own images
//   super   → + approve/reject/rollback/archive/purge, all media, video
//
// `showSuperExtras` is `effScope.isSuper && hasSuperRole` and must NEVER
// fall back to `forAdmin ||`, or a Super viewing the Admin tab leaks
// approval controls into a surface that is meant to be an admin's view.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
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
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
import GuideMarkdown from "@/src/ui/components/GuideMarkdown";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { determineRoles } from "@/src/lib/roles";
import type { Me } from "@/src/lib/types";
import {
  fetchGuides,
  fetchGuideCategories,
  fetchGuide,
  fetchMediaLimits,
  createGuide,
  saveDraft,
  submitForApproval,
  approveVersion,
  rejectVersion,
  unpublishGuide,
  setGuideArchived,
  purgeGuide,
  discardDraft,
  fetchInboundLinks,
  statusLabel,
  type GuideCategory,
  type GuideDetail,
  type GuideListItem,
  type MediaLimits,
} from "@/src/lib/guides";
import GuideMediaLibrary from "@/src/ui/components/GuideMediaLibrary";
import GuideApprovalsSection from "@/src/ui/components/GuideApprovalsSection";

export default function GuidesTab({
  me,
  purpose = "WORKER",
  scope,
}: {
  me: Me | null;
  purpose?: "WORKER" | "ADMIN" | "SUPER";
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
}) {
  const { isSuper: hasSuperRole } = determineRoles(me, purpose);
  const effScope = scope ?? {
    isWorker: true,
    isAdmin: purpose !== "WORKER",
    isSuper: purpose === "SUPER",
  };
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper && hasSuperRole;

  const [items, setItems] = useState<GuideListItem[] | null>(null);
  const [cats, setCats] = useState<GuideCategory[]>([]);
  const [limits, setLimits] = useState<MediaLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [categoryKey, setCategoryKey] = usePersistedState<string>("guidesTab_category", "");
  const [openId, setOpenId] = useState<string | null>(null);
  const [approvalsApi, setApprovalsApi] = useState<{
    refresh: () => void;
    loading: boolean;
    count: number;
  } | null>(null);
  const approvalCount = approvalsApi?.count ?? 0;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchGuides({ q: q.trim() || undefined, categoryKey: categoryKey || undefined });
      // The Worker tab must show the WORKER catalog even when the person
      // looking at it is a Super. Role shells are client-side, so without
      // activating "view as" the API answers with the caller's real
      // privileges and hands back drafts too — which then rendered on the
      // Worker tab, badgeless, indistinguishable from published material.
      //
      // This is presentation, not access control: a Super is entitled to
      // every row here. The server remains the only thing standing
      // between a real worker and an unapproved guide.
      setItems(showAdminExtras ? rows : rows.filter((r) => r.isPublished));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load guides.", err) });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [q, categoryKey, showAdminExtras]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Approving from the review queue changes a guide's badge from "Pending
  // approval" to published. Without this the catalog underneath the queue
  // keeps showing the old state until the tab is re-entered.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("seedlings:guides-changed", onChanged);
    return () => window.removeEventListener("seedlings:guides-changed", onChanged);
  }, [load]);

  useEffect(() => {
    void fetchGuideCategories().then(setCats).catch(() => setCats([]));
    if (showAdminExtras) void fetchMediaLimits().then(setLimits).catch(() => setLimits(null));
  }, [showAdminExtras]);

  const catLabel = useCallback(
    (key: string) => cats.find((c) => c.key === key)?.label ?? key,
    [cats],
  );

  const categoryCollection = useMemo(
    () =>
      createListCollection({
        items: [{ label: "All categories", value: "" }, ...cats.map((c) => ({ label: c.label, value: c.key }))],
      }),
    [cats],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, GuideListItem[]>();
    for (const g of items ?? []) {
      const arr = map.get(g.categoryKey) ?? [];
      arr.push(g);
      map.set(g.categoryKey, arr);
    }
    return [...map.entries()];
  }, [items]);

  if (openId) {
    return (
      <GuideDetailView
        // Keyed by target so a cross-reference click remounts the view
        // with fresh state — otherwise the previous guide's draft body and
        // edit mode would bleed into the one just navigated to.
        key={openId}
        idOrSlug={openId}
        onOpenGuide={(slug) => setOpenId(slug)}
        onBack={() => {
          setOpenId(null);
          void load();
        }}
        showAdminExtras={showAdminExtras}
        showSuperExtras={showSuperExtras}
        limits={limits}
        catLabel={catLabel}
      />
    );
  }

  return (
    <Box w="full">
      <HStack mb={3} gap={2} align="center" wrap="wrap">
        <HStack gap={1} flex="1" minW="200px">
          <Search size={14} color="var(--chakra-colors-gray-500)" />
          <Input
            size="sm"
            placeholder="Search guides…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </HStack>
        <Box flexShrink={0}>
          <Select.Root
            collection={categoryCollection}
            value={[categoryKey]}
            onValueChange={(e) => setCategoryKey(e.value?.[0] ?? "")}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
          >
            <Select.Control>
              <Select.Trigger w="auto" minW="170px" px="2">
                <Select.ValueText placeholder="All categories" />
                <Select.Indicator />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content minW="var(--reference-width)">
                {categoryCollection.items.map((item) => (
                  <Select.Item key={item.value} item={item.value}>
                    <Select.ItemText>{item.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
        </Box>
        {showAdminExtras && (
          <NewGuideButton cats={cats} onCreated={(id) => setOpenId(id)} />
        )}
      </HStack>

      {/* Review queue. Only a Super can approve, and approving is the only
          way material becomes readable by a worker — so this is a
          blocked-on-you queue and pulses like the others. The glow matches
          the section's OWN palette (attention = orange), not the blue of
          its alerts-dropdown entry — pulses track the section they belong
          to.

          It mirrors the Tasks-page section rather than replacing it: a
          Super working inside Guides should not have to leave the tab to
          clear the queue.

          Kept MOUNTED and hidden at zero rather than unmounted, so its
          own count keeps driving this section. Unmounting would remove
          the thing that reports the count, and the queue could never
          reappear after being emptied without a tab reload. */}
      {showSuperExtras && (
        <Box mb={approvalCount > 0 ? 3 : 0} display={approvalCount > 0 ? "block" : "none"}>
          <Dashboard
            storageKey="seedlings:guidesTab:approvalsOpen"
            title={
              approvalCount === 1
                ? "1 guide awaiting approval"
                : `${approvalCount} guides awaiting approval`
            }
            icon={AlertTriangle}
            variant="attention"
            count={approvalCount}
            forceGlow="orange"
            onRefresh={approvalsApi?.refresh}
            refreshing={!!approvalsApi?.loading}
          >
            <GuideApprovalsSection
              onReady={setApprovalsApi}
              onOpenGuide={(slug) => setOpenId(slug)}
              /* Orange — this section uses the attention variant. */
              palette="orange"
            />
          </Dashboard>
        </Box>
      )}

      {showAdminExtras && <GuideMediaLibrary showSuperExtras={showSuperExtras} limits={limits} />}

      {loading && !items ? (
        <Box textAlign="center" py={8}>
          <Spinner />
        </Box>
      ) : (items ?? []).length === 0 ? (
        <Card.Root variant="outline">
          <Card.Body p={6} textAlign="center">
            <Text fontSize="sm" fontWeight="medium">
              {q || categoryKey ? "No guides match" : "No guides yet"}
            </Text>
            <Text fontSize="xs" color="fg.muted" mt={1}>
              {q || categoryKey
                ? "Try a different search or category."
                : showAdminExtras
                  ? "Create the first one — it becomes readable once a Super approves it."
                  : "Training material will appear here once it's published."}
            </Text>
          </Card.Body>
        </Card.Root>
      ) : (
        <VStack align="stretch" gap={3}>
          {grouped.map(([key, rows]) => (
            <Box key={key}>
              <Text
                fontSize="xs"
                fontWeight="semibold"
                color="fg.muted"
                textTransform="uppercase"
                letterSpacing="wide"
                mb={1.5}
              >
                {catLabel(key)}
              </Text>
              <VStack align="stretch" gap={2}>
                {rows.map((g) => (
                  <Card.Root
                    key={g.id}
                    variant="outline"
                    cursor="pointer"
                    _hover={{ borderColor: "blue.300" }}
                    onClick={() => setOpenId(g.slug)}
                  >
                    <Card.Body p={3}>
                      <HStack justify="space-between" align="start" gap={2}>
                        <VStack align="start" gap={0.5} minW={0}>
                          <HStack gap={2} wrap="wrap">
                            <Text fontSize="sm" fontWeight="semibold">
                              {g.title}
                            </Text>
                            {/* Authors see WHY a guide isn't readable yet.
                                Gated on SCOPE, not on whether the payload
                                happens to carry the fields: role shells are
                                a client-side view, so a Super browsing the
                                Worker tab without activating "view as"
                                still calls the API with Super privileges
                                and gets author fields back. Reasoning from
                                the payload put "Draft" and "Pending
                                approval" badges on the Worker tab. */}
                            {showAdminExtras && !g.isPublished && (
                              <Badge size="sm" colorPalette="gray" variant="subtle">
                                Not published
                              </Badge>
                            )}
                            {showAdminExtras && g.pendingVersionId && (
                              <Badge size="sm" colorPalette="orange" variant="solid">
                                Pending approval
                              </Badge>
                            )}
                            {showAdminExtras && g.rejectedVersionId && !g.pendingVersionId && (
                              <Badge size="sm" colorPalette="red" variant="solid">
                                Sent back
                              </Badge>
                            )}
                            {showAdminExtras &&
                              g.draftVersionId &&
                              !g.pendingVersionId &&
                              !g.rejectedVersionId && (
                              <Badge size="sm" colorPalette="blue" variant="subtle">
                                Draft
                              </Badge>
                            )}
                          </HStack>
                          {g.summary && (
                            <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                              {g.summary}
                            </Text>
                          )}
                          {g.tags.length > 0 && (
                            <HStack gap={1} wrap="wrap" mt={1}>
                              {g.tags.map((t) => (
                                <Badge key={t} size="sm" colorPalette="gray" variant="subtle">
                                  {t}
                                </Badge>
                              ))}
                            </HStack>
                          )}
                        </VStack>
                      </HStack>
                    </Card.Body>
                  </Card.Root>
                ))}
              </VStack>
            </Box>
          ))}
        </VStack>
      )}
    </Box>
  );
}

// ── New guide ────────────────────────────────────────────────────────────────

function NewGuideButton({
  cats,
  onCreated,
}: {
  cats: GuideCategory[];
  onCreated: (idOrSlug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  // Takes the title as an ARGUMENT rather than reading the `title` state.
  //
  // The dialog hands the typed value to onConfirm, which called setTitle()
  // and then create() in the same tick. React state updates are async, so
  // create() still saw the previous render's `title` — an empty string on the
  // first use — and posted `title: ""`. The API rejected it with "Title is
  // required", which read as a broken form: the field visibly had text in it.
  async function create(rawTitle: string) {
    const trimmed = rawTitle.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const g = await createGuide({
        title: trimmed,
        categoryKey: cats[0]?.key ?? "lawn-care",
      });
      setOpen(false);
      setTitle("");
      onCreated(g.slug);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't create the guide.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" colorPalette="blue" flexShrink={0} onClick={() => setOpen(true)}>
        <Plus size={14} /> New guide
      </Button>
      <ConfirmDialog
        open={open}
        title="New guide"
        message="Give it a title. You can set the category, summary and body next — it stays invisible to workers until a Super approves it."
        inputLabel="Title"
        inputPlaceholder="How to fertilize Bermuda grass"
        inputDefaultValue={title}
        confirmLabel={busy ? "Creating…" : "Create draft"}
        confirmColorPalette="blue"
        onConfirm={(value?: string) => {
          const typed = value ?? "";
          // Kept so the field repopulates if the dialog reopens after a
          // failure; the create path deliberately does not read it.
          setTitle(typed);
          void create(typed);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

// ── Reader / editor ──────────────────────────────────────────────────────────

function GuideDetailView({
  idOrSlug,
  onBack,
  onOpenGuide,
  showAdminExtras,
  showSuperExtras,
  limits,
  catLabel,
}: {
  idOrSlug: string;
  onBack: () => void;
  onOpenGuide: (slug: string) => void;
  showAdminExtras: boolean;
  showSuperExtras: boolean;
  limits: MediaLimits | null;
  catLabel: (key: string) => string;
}) {
  const [guide, setGuide] = useState<GuideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  /** Guides whose body links to this one. A link that stops resolving
   *  degrades to plain text rather than breaking a page, so this is a
   *  warning on the confirm, never a block. */
  const [inbound, setInbound] = useState<Array<{ id: string; title: string; slug: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Every non-destructive state change goes through one confirm dialog.
   *  Mobile-first: these buttons sit a thumb-width apart on a phone, and
   *  "Approve & publish" is one accidental tap from putting unreviewed
   *  copy in front of every worker. Reject and purge get their own
   *  dialogs below because they need an input. */
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    warning?: string;
    confirmLabel: string;
    confirmColorPalette?: string;
    run: () => Promise<unknown>;
    done: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const g = await fetchGuide(idOrSlug);
      setGuide(g);
      if (showAdminExtras) {
        // Best-effort: a failed lookup must not stop the guide rendering.
        setInbound(await fetchInboundLinks(g.slug).catch(() => []));
      }
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load the guide.", err) });
    } finally {
      setLoading(false);
    }
  }, [idOrSlug, showAdminExtras]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Warning text when other guides cross-reference this one. */
  const inboundWarning = () =>
    inbound.length === 0
      ? undefined
      : `${inbound.length} other guide${inbound.length === 1 ? "" : "s"} link${inbound.length === 1 ? "s" : ""} to this one (${inbound
          .slice(0, 3)
          .map((g) => g.title)
          .join(", ")}${inbound.length > 3 ? ", …" : ""}). Those links will render as plain text.`;

  const versions = guide?.versions ?? [];
  const draft = versions.find((v) => v.status === "DRAFT" || v.status === "REJECTED") ?? null;
  const pending = versions.find((v) => v.status === "PENDING_APPROVAL") ?? null;
  // Discarding the only version leaves nothing behind, so it takes the guide
  // with it — the button and its confirmation both have to say so.
  const isOnlyVersion = versions.length === 1;
  const live = guide?.currentVersion ?? null;

  function beginEdit() {
    // Seed the editor with the most recent content that actually exists,
    // so "edit" always means "change what's there" and never "start from
    // blank".
    //
    // The pending version has to be in this chain. A guide submitted for
    // approval but never published has NO draft and NO live version, so
    // the previous `draft ?? live` opened an empty textarea on a guide
    // full of content — and saving over it would have destroyed the work.
    //
    // Empty strings fall through rather than winning, because `??` treats
    // "" as a real value: a version row with empty markdown (a bare draft
    // that was never written) would otherwise blank the editor just the
    // same.
    const source =
      [draft, pending, live].find((v) => v?.contentMarkdown?.trim()) ?? null;
    setBody(source?.contentMarkdown ?? "");
    setNote(draft?.changeNote && draft.changeNote !== "Initial draft" ? draft.changeNote : "");
    setEditing(true);
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      publishInlineMessage({ type: "SUCCESS", text: ok });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("That didn't work.", err) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Box textAlign="center" py={8}>
        <Spinner />
      </Box>
    );
  }
  if (!guide) return null;

  return (
    <Box w="full">
      <HStack mb={3} gap={2} wrap="wrap">
        <Button size="sm" variant="outline" onClick={onBack}>
          ← Catalog
        </Button>
        <Text fontSize="sm" color="fg.muted">
          {catLabel(guide.categoryKey)}
        </Text>
      </HStack>

      {/* Author-only status strip. Gated on scope for the same reason as
          the catalog badges — a Super in the Worker shell has a Super
          payload, so "a worker's payload has no versions" was never a
          safe thing to reason from. */}
      {showAdminExtras && (pending || draft || !guide.isPublished) && (
        <Card.Root variant="outline" mb={3} borderColor="orange.300" bg="orange.50">
          <Card.Body p={3}>
            <VStack align="stretch" gap={1}>
              {pending && (
                <Text fontSize="xs" color="orange.900">
                  <strong>v{pending.versionNumber} is awaiting approval.</strong>{" "}
                  {guide.isPublished
                    ? "Workers keep reading the published version until a Super approves it."
                    : "Workers can't see this guide until a Super approves it."}
                </Text>
              )}
              {draft?.status === "REJECTED" && draft.rejectionNote && (
                <Text fontSize="xs" color="orange.900">
                  <strong>Sent back:</strong> {draft.rejectionNote}
                </Text>
              )}
              {!pending && draft && (
                <Text fontSize="xs" color="orange.900">
                  You have an unsubmitted draft (v{draft.versionNumber}).
                </Text>
              )}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      <Card.Root variant="outline">
        <Card.Body p={4}>
          <Text fontSize="lg" fontWeight="bold" mb={1}>
            {guide.title}
          </Text>
          {guide.summary && (
            <Text fontSize="sm" color="fg.muted" mb={3}>
              {guide.summary}
            </Text>
          )}

          {editing ? (
            <VStack align="stretch" gap={2}>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                fontFamily="mono"
                fontSize="sm"
                placeholder={"# Heading\n\nText, **bold**, lists…\n\n![alt](guide-asset:<id>)\n\n:::video guide-asset:<id>"}
              />
              <Input
                size="sm"
                placeholder="What changed? (the approver reads this instead of diffing)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Box borderWidth="1px" borderColor="gray.200" rounded="md" p={3} bg="white">
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" mb={2}>
                  Preview
                </Text>
                {/* Same renderer the worker gets, so the preview is not an
                    approximation of the published page — it IS it. */}
                <GuideMarkdown
                  allowedEmbedDomains={limits?.allowedEmbedDomains ?? []}
                  onOpenGuide={onOpenGuide}
                  // Editing surface — the author needs to see a link that
                  // does not resolve while they can still fix it.
                  showUnpublishedLinkState
                >
                  {body}
                </GuideMarkdown>
              </Box>
              <HStack gap={2} wrap="wrap">
                <Button
                  size="sm"
                  colorPalette="blue"
                  loading={busy}
                  onClick={() =>
                    void act(async () => {
                      await saveDraft(guide.id, { contentMarkdown: body, changeNote: note });
                      setEditing(false);
                    }, "Draft saved.")
                  }
                >
                  Save draft
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </HStack>
            </VStack>
          ) : (
            <GuideMarkdown
              allowedEmbedDomains={limits?.allowedEmbedDomains ?? []}
              onOpenGuide={onOpenGuide}
              // Authors only. On a worker's read this stays false — a
              // "(not published)" marker would reveal that a hidden guide
              // sits behind the link.
              showUnpublishedLinkState={showAdminExtras}
            >
              {live?.contentMarkdown ??
                draft?.contentMarkdown ??
                pending?.contentMarkdown ??
                "_Nothing written yet._"}
            </GuideMarkdown>
          )}
        </Card.Body>
      </Card.Root>

      {/* ONE wrapping row for every action on this guide. These were three
          stacked blocks (author / review / lifecycle), which rendered as
          three separate rows of one-or-two buttons each and read as
          unrelated groups. They are all "things you can do to this
          guide" — order runs authoring → review → lifecycle, and wrap
          handles narrow screens. */}
      {!editing && (showAdminExtras || showSuperExtras) && (
        <HStack mt={3} gap={2} wrap="wrap">
          {showAdminExtras && (
            <Button size="sm" variant="outline" onClick={beginEdit}>
            {draft ? "Continue draft" : "Edit"}
            </Button>
          )}
          {showAdminExtras && draft && !pending && (
            <Button
            size="sm"
            colorPalette="orange"
            loading={busy}
            onClick={() =>
            setConfirmAction({
            title: "Submit this for approval?",
            message:
            "A Super reviews it before anyone can read it. You can keep editing until they do.",
            confirmLabel: "Submit",
            confirmColorPalette: "orange",
            run: () => submitForApproval(draft.id),
            done: "Submitted for approval.",
            })
            }
            >
            Submit for approval
            </Button>
          )}
          {/* Discard sits next to Continue draft because it's the other half
              of the same decision: keep working on this, or throw it away.
              Only for an UNSUBMITTED draft — once it's pending, it's in a
              Super's queue and gets withdrawn by rejection, not deletion. */}
          {showAdminExtras && draft && !pending && (
            <Button
            size="sm"
            variant="outline"
            colorPalette="red"
            loading={busy}
            onClick={() =>
            setConfirmAction({
            // The copy has to change with the consequence: discarding the
            // only version takes the whole guide, and that's not obvious
            // from a button labelled "Discard draft".
            title: isOnlyVersion ? "Delete this guide?" : "Discard this draft?",
            message: isOnlyVersion
            ? "This draft is the only version, so the guide goes with it. Nothing has been published, so no one else has seen it. This can't be undone."
            : "Your unsaved changes in this draft are thrown away. The published version stays exactly as it is.",
            confirmLabel: isOnlyVersion ? "Delete guide" : "Discard draft",
            confirmColorPalette: "red",
            run: async () => {
            const res = await discardDraft(draft.id);
            if (res.guideDeleted) onBack();
            },
            done: isOnlyVersion ? "Guide deleted." : "Draft discarded.",
            })
            }
            >
            {isOnlyVersion ? "Delete guide" : "Discard draft"}
            </Button>
          )}
          {showSuperExtras && pending && (
            <>
              <Button
              size="sm"
              colorPalette="green"
              loading={busy}
              onClick={() =>
              setConfirmAction({
              title: "Approve and publish?",
              message: `Every worker can read "${guide.title}" immediately.`,
              warning: guide.isPublished
              ? "This replaces the version workers are reading right now."
              : undefined,
              confirmLabel: "Approve & publish",
              confirmColorPalette: "green",
              run: () => approveVersion(pending.id),
              done: "Approved and published.",
              })
              }
              >
              Approve &amp; publish
              </Button>
              <Button size="sm" variant="outline" colorPalette="red" onClick={() => setRejectFor(pending.id)}>
              Send back
              </Button>
            </>
          )}
          {showSuperExtras && guide.isPublished && (
            <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
            setConfirmAction({
            title: "Unpublish this guide?",
            message:
            "Workers lose access to it immediately. Nothing is deleted — approving a version publishes it again.",
            warning: inboundWarning(),
            confirmLabel: "Unpublish",
            confirmColorPalette: "red",
            run: () => unpublishGuide(guide.id),
            done: "Unpublished.",
            })
            }
            >
            Unpublish
            </Button>
          )}
          {showSuperExtras && (
            <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
            setConfirmAction(
            guide.archivedAt
            ? {
            title: "Restore this guide?",
            message:
            "It returns to the catalog for authors. It stays unpublished until a version is approved.",
            confirmLabel: "Restore",
            run: () => setGuideArchived(guide.id, false),
            done: "Restored.",
            }
            : {
            title: "Archive this guide?",
            message:
            "It leaves the catalog and any pending version drops out of the review queue. You can restore it.",
            warning: [
            guide.isPublished
            ? "Workers are reading this right now and will lose access."
            : null,
            inboundWarning(),
            ]
            .filter(Boolean)
            .join(" ") || undefined,
            confirmLabel: "Archive",
            confirmColorPalette: "red",
            run: () => setGuideArchived(guide.id, true),
            done: "Archived.",
            },
            )
            }
            >
            {guide.archivedAt ? "Restore" : "Archive"}
            </Button>
          )}
          {showSuperExtras && guide.archivedAt && (
            <Button size="sm" variant="outline" colorPalette="red" onClick={() => setPurgeOpen(true)}>
            Delete permanently
            </Button>
          )}
        </HStack>
      )}

      {/* Version history is REFERENCE, not a queue. The Dashboard section
          pattern is for proactive work — things waiting on you, which
          pulse and sit at the top of a tab. Dressing a passive changelog
          in it made history look like an outstanding task. Plain
          disclosure instead, matching how the rest of the app reveals
          secondary detail. */}
      {showAdminExtras && versions.length > 0 && (
        <Box mt={4}>
          <HStack
            gap={1.5}
            cursor="pointer"
            onClick={() => setHistoryOpen((v) => !v)}
            _hover={{ color: "fg" }}
            color="fg.muted"
            userSelect="none"
            py={1}
            px={1}
          >
            {historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Text fontSize="xs" fontWeight="medium">
              Version history ({versions.length})
            </Text>
          </HStack>
          {historyOpen && (
            <Box mt={1} px={1}>
              <VStack align="stretch" gap={1}>
                {versions.map((v) => (
                  <HStack key={v.id} gap={2} p={2} borderWidth="1px" borderColor="gray.200" rounded="md" wrap="wrap">
                    <Badge size="sm" colorPalette={v.status === "PUBLISHED" ? "green" : "gray"} variant="subtle">
                      v{v.versionNumber} · {statusLabel(v.status)}
                    </Badge>
                    <Text fontSize="xs" color="fg.muted" flex="1" minW="120px">
                      {v.changeNote || "—"}
                    </Text>
                    <Text fontSize="2xs" color="fg.muted">
                      {v.createdBy?.displayName ?? "—"}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            </Box>
          )}
        </Box>
      )}

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        warning={confirmAction?.warning}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        confirmColorPalette={confirmAction?.confirmColorPalette}
        onConfirm={() => {
          const a = confirmAction;
          setConfirmAction(null);
          if (a) void act(a.run, a.done);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={!!rejectFor}
        title="Send this back?"
        message="The author sees your note and can revise. Nothing workers can read changes."
        inputLabel="Why"
        inputPlaceholder="Bermuda section is out of date for our region…"
        confirmLabel="Send back"
        confirmColorPalette="red"
        onConfirm={(value?: string) => {
          const id = rejectFor;
          setRejectFor(null);
          if (id && (value ?? "").trim()) void act(() => rejectVersion(id, value!), "Sent back to the author.");
        }}
        onCancel={() => setRejectFor(null)}
      />

      {/* Typed confirmation — same gate as "Approve as Worker". There is no
          undo and no archive to fall back on after this. */}
      <ConfirmDialog
        open={purgeOpen}
        title="Permanently delete this guide?"
        message={`This destroys "${guide.title}" and all ${versions.length} version(s) for good. Media stays in the library. Type the title to confirm.`}
        warning="This cannot be undone. The audit log keeps a snapshot; nothing else survives."
        inputLabel="Type the guide title"
        inputPlaceholder={guide.title}
        requiredInputValue={guide.title}
        confirmLabel="Delete permanently"
        confirmColorPalette="red"
        onConfirm={() => {
          setPurgeOpen(false);
          void act(async () => {
            await purgeGuide(guide.id);
            onBack();
          }, "Guide permanently deleted.");
        }}
        onCancel={() => setPurgeOpen(false)}
      />
    </Box>
  );
}
