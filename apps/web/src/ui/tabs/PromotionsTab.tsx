"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Table,
  Tabs,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Eye } from "lucide-react";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/src/lib/api";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { fmtDate, fmtDateTime, bizInstantFromEtParts, type EtDateKey } from "@/src/lib/lib";

// ─────────────────────────────────────────────────────────────────────────────
// Promotions tab — Super-only surface.
// Three top-level views:
//   Campaigns — list + detail with editor, lifecycle actions, delivery log,
//                Send Now, Send-to-self test
//   Contacts  — per-contact opt-out toggle (with APPROVE-gated re-opt-in),
//                per-contact opt history
//   Audit     — full state-transition log across all campaigns
// ─────────────────────────────────────────────────────────────────────────────

type PromotionStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "CLOSED";
type DispatchChannel = "email" | "sms";
type DisplaySurface = "invoice_page";
type TriggerKind = "on_invoice_sent" | "manual_send";

type PromoContent = {
  sms?: { body: string; ctaText?: string };
  email?: { subject: string; body: string; ctaText?: string };
  invoice_page?: { headline?: string; body: string; ctaText?: string };
};

type LinkKind = "EXTERNAL" | "LANDING_PAGE";

type Promotion = {
  id: string;
  title: string;
  description: string;
  linkKind: LinkKind;
  link: string | null;
  landingPageId: string | null;
  landingPage?: { id: string; slug: string } | null;
  audienceSpec: { kind: "all" };
  dispatchChannels: DispatchChannel[];
  displaySurfaces: DisplaySurface[];
  triggerKind: TriggerKind | null;
  triggerConfig: Record<string, unknown>;
  cooldownDays: number;
  startAt: string | null;
  endAt: string | null;
  status: PromotionStatus;
  content: PromoContent;
  // Short URL slug — kebab-case, appears in wrapper URLs as
  // <baseDomain>/mo/<shortSlug>/<code>. Null means the campaign uses
  // the legacy long-form wrapper. Locked once startedAt is set.
  shortSlug: string | null;
  // Per-campaign domain override. Full origin ("https://seedlings.pro").
  // Must be a member of the server's ALLOWED_DOMAINS. Null falls
  // through to PAYMENT_REQUEST_BASE_URL (the primary).
  baseDomain: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  closedAt: string | null;
  createdBy?: { displayName: string | null; email: string | null } | null;
  updatedBy?: { displayName: string | null; email: string | null } | null;
  deliveredCount?: number;
  skippedCount?: number;
  /** Deliveries with deliveredAt set — the URL actually reached someone.
   *  Drives both slug locks. Distinct from deliveredCount, which counts
   *  un-skipped rows and so includes ones still queued. */
  shippedCount?: number;
};

type LandingPageItemPhoto = {
  id: string;
  url: string | null;
  contentType: string | null;
};

type LandingPageItem = {
  id: string;
  title: string;
  description: string;
  ordinal: number;
  /** All photos in display order. Replaced the single imageUrl/imageR2Key
   *  trio — items hold many photos now. */
  photos: LandingPageItemPhoto[];
};

type LandingPage = {
  id: string;
  slug: string;
  headline: string | null;
  intro: string | null;
  viewCount: number;
  /** Server-computed: true once a delivery has actually shipped this URL.
   *  Authoritative — the same predicate gates the PATCH, so the input's
   *  enabled state and the server's guard can never disagree. */
  slugLocked: boolean;
  shippedDeliveryCount: number;
  items: LandingPageItem[];
};

type ContactRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  client: { id: string; displayName: string };
  promoEmailOptedOut: boolean;
  promoSmsOptedOut: boolean;
};

export default function PromotionsTab() {
  const [view, setView] = useState<"campaigns" | "contacts">("campaigns");
  return (
    <VStack align="stretch" gap={4} px={2} py={2}>
      <Tabs.Root value={view} onValueChange={(e) => setView(e.value as any)} size="sm">
        <Tabs.List>
          <Tabs.Trigger value="campaigns">Campaigns</Tabs.Trigger>
          <Tabs.Trigger value="contacts">Contacts</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="campaigns">
          <CampaignsView />
        </Tabs.Content>
        <Tabs.Content value="contacts">
          <ContactsView />
        </Tabs.Content>
      </Tabs.Root>
      {/* Cross-cutting audit lives in Engagement → History (mirrors every
          other auditable event in the app). Per-campaign state timeline
          lives in each campaign's detail panel above. Per-contact opt
          history lives on the Contacts tab's "View" button. Rotate-
          HMAC-secret lives in Settings → Promotions (auto-managed
          value with a dedicated action button, sits next to the footer
          templates). */}
    </VStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns view — list + detail
// ─────────────────────────────────────────────────────────────────────────────

function CampaignsView() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [creating, setCreating] = useState(false);
  // Standalone landing-page editor — opens independently of the main
  // PromotionEditor so it works even while the promotion is ACTIVE
  // (landing-page content is safe to edit mid-campaign; the slug locks
  // only once a delivery has actually shipped the URL).
  const [editingLanding, setEditingLanding] = useState<{
    promoId: string;
    pageId: string;
    status: PromotionStatus;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiGet<Promotion[]>("/api/super/promotions");
      setPromos(rows);
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: `Failed to load promotions: ${err?.message ?? err}` });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const active = promos.filter((p) => p.status !== "CLOSED");
  const closed = promos.filter((p) => p.status === "CLOSED");
  const selected = promos.find((p) => p.id === selectedId) ?? null;

  return (
    <VStack align="stretch" gap={4} mt={3}>
      <HStack justify="space-between">
        <Text fontSize="sm" color="fg.muted">
          {active.length} active/draft · {closed.length} closed
        </Text>
        <Button size="sm" colorPalette="green" onClick={() => setCreating(true)}>
          + New promotion
        </Button>
      </HStack>
      {loading ? (
        <HStack><Spinner size="sm" /><Text fontSize="sm">Loading…</Text></HStack>
      ) : (
        <>
          <PromotionsList
            promos={active}
            heading="Active & drafts"
            onSelect={setSelectedId}
            selectedId={selectedId}
          />
          <Box>
            <Button size="xs" variant="ghost" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? "▼" : "▶"} Closed ({closed.length})
            </Button>
            {showClosed && (
              <PromotionsList
                promos={closed}
                heading=""
                onSelect={setSelectedId}
                selectedId={selectedId}
              />
            )}
          </Box>
        </>
      )}
      {selected && (
        <PromotionDetail
          promotion={selected}
          onEdit={() => setEditing(selected)}
          onEditLanding={() => {
            if (selected.landingPageId) {
              setEditingLanding({
                promoId: selected.id,
                pageId: selected.landingPageId,
                status: selected.status,
              });
            }
          }}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      )}
      {editingLanding && (
        <StandaloneLandingPageDialog
          promoId={editingLanding.promoId}
          pageId={editingLanding.pageId}
          status={editingLanding.status}
          onClose={() => { setEditingLanding(null); void load(); }}
        />
      )}
      {(editing || creating) && (
        <PromotionEditor
          initial={editing}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); void load(); }}
        />
      )}
    </VStack>
  );
}

function PromotionsList({
  promos, heading, onSelect, selectedId,
}: {
  promos: Promotion[];
  heading: string;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  if (promos.length === 0) {
    return heading ? (
      <Box>
        <Text fontSize="sm" fontWeight="semibold" mb={1}>{heading}</Text>
        <Text fontSize="xs" color="fg.muted" fontStyle="italic">No promotions yet.</Text>
      </Box>
    ) : null;
  }
  return (
    <Box>
      {heading && <Text fontSize="sm" fontWeight="semibold" mb={2}>{heading}</Text>}
      <VStack align="stretch" gap={1}>
        {promos.map((p) => (
          <Box
            key={p.id}
            p={3}
            borderWidth="1px"
            borderColor={selectedId === p.id ? "blue.400" : "gray.200"}
            bg={selectedId === p.id ? "blue.50" : "white"}
            rounded="md"
            cursor="pointer"
            onClick={() => onSelect(p.id)}
          >
            <HStack justify="space-between" wrap="wrap">
              <HStack>
                <Text fontSize="sm" fontWeight="semibold">{p.title}</Text>
                <StatusBadge status={p.status} />
              </HStack>
              <HStack fontSize="xs" color="fg.muted" gap={3}>
                {p.dispatchChannels.map((c) => <Badge key={c} size="xs" variant="outline">{c}</Badge>)}
                {p.displaySurfaces.map((c) => <Badge key={c} size="xs" variant="outline" colorPalette="purple">{c}</Badge>)}
                <Text>{p.deliveredCount ?? 0} sent · {p.skippedCount ?? 0} skipped</Text>
              </HStack>
            </HStack>
            {p.description && (
              <Text fontSize="xs" color="fg.muted" mt={1} lineClamp={1}>{p.description}</Text>
            )}
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

function StatusBadge({ status }: { status: PromotionStatus }) {
  const palette = status === "ACTIVE" ? "green" : status === "PAUSED" ? "yellow" : status === "CLOSED" ? "gray" : "blue";
  const label = status === "CLOSED" ? "Closed" : status.toLowerCase().replace(/^\w/, (m) => m.toUpperCase());
  return <Badge size="xs" colorPalette={palette}>{label}</Badge>;
}

// ─── Promotion detail (below the list) ─────────────────────────────────────

function PromotionDetail({
  promotion, onEdit, onEditLanding, onClose, onChanged,
}: {
  promotion: Promotion;
  onEdit: () => void;
  onEditLanding: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [deliveries, setDeliveries] = useState<any[] | null>(null);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<null | "start" | "pause" | "resume" | "retire" | "sendNow">(null);
  const [testChannel, setTestChannel] = useState<"email" | "sms" | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState(false);
  const [previewingLanding, setPreviewingLanding] = useState(false);

  useEffect(() => {
    void (async () => {
      const [d, a] = await Promise.all([
        apiGet<any[]>(`/api/super/promotions/${promotion.id}/deliveries`),
        apiGet<any[]>(`/api/super/promotions/${promotion.id}/audit`),
      ]);
      setDeliveries(d);
      setAudit(a);
    })();
  }, [promotion.id]);

  async function act(action: string) {
    setBusy(true);
    try {
      await apiPost(`/api/super/promotions/${promotion.id}/${action}`, {});
      publishInlineMessage({ type: "SUCCESS", text: `Promotion ${action} succeeded.` });
      onChanged();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function sendTest(channel: "email" | "sms") {
    setBusy(true);
    try {
      const res = await apiPost<{
        ok: boolean;
        target: string | null;
        mode?: "SERVER" | "CLAIMER";
        subject?: string;
        body?: string;
        error?: string;
      }>(`/api/super/promotions/${promotion.id}/test-send`, { channel });
      if (!res.ok) {
        if (res.error === "no_target_on_file") {
          publishInlineMessage({
            type: "ERROR",
            text: `No ${channel} on your profile — add one under Profile first.`,
          });
        } else {
          // Surface the actual provider error (Twilio / Resend) instead
          // of the misleading generic "check your X on file."
          const reason = res.error ? ` — ${res.error}` : "";
          publishInlineMessage({
            type: "ERROR",
            text: `Test ${channel} failed to send to ${res.target}${reason}`,
          });
        }
        return;
      }
      // SERVER mode → provider already shipped it, just confirm.
      if (res.mode === "SERVER" || !res.body) {
        publishInlineMessage({ type: "SUCCESS", text: `Test ${channel} sent to ${res.target}.` });
        return;
      }
      // CLAIMER mode → hand off to the Super's device via `sms:` /
      // `mailto:` intent, same pattern the invoice claimer path uses.
      const target = res.target ?? "";
      if (channel === "sms") {
        // `sms:` accepts raw phones; browsers on iOS/Android open the
        // native messaging app with body pre-filled. Desktop behavior
        // is best-effort (Chrome may open nothing).
        const href = `sms:${target}?body=${encodeURIComponent(res.body)}`;
        window.location.href = href;
      } else {
        const href = `mailto:${encodeURIComponent(target)}?subject=${encodeURIComponent(res.subject ?? "")}&body=${encodeURIComponent(res.body)}`;
        window.location.href = href;
      }
      publishInlineMessage({
        type: "INFO",
        text: `Opened ${channel} on your device — tap Send to deliver the test to yourself.`,
      });
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setBusy(false);
      setTestChannel(null);
    }
  }

  const editable = promotion.status === "DRAFT" || promotion.status === "PAUSED";
  const closed = promotion.status === "CLOSED";

  return (
    <Card.Root mt={2}>
      <Card.Body>
        <HStack justify="space-between" wrap="wrap" mb={3}>
          <HStack>
            <Text fontSize="md" fontWeight="bold">{promotion.title}</Text>
            <StatusBadge status={promotion.status} />
          </HStack>
          <Button size="xs" variant="ghost" onClick={onClose}>Close ✕</Button>
        </HStack>

        <Text fontSize="sm" color="fg.muted" mb={3}>{promotion.description}</Text>

        <HStack gap={2} wrap="wrap" mb={3}>
          {editable && <Button size="xs" onClick={onEdit} disabled={busy}>Edit</Button>}
          {promotion.status === "DRAFT" && (
            <Button size="xs" colorPalette="green" onClick={() => setConfirming("start")} disabled={busy}>
              Start
            </Button>
          )}
          {promotion.status === "PAUSED" && (
            <>
              <Button size="xs" colorPalette="green" onClick={() => setConfirming("resume")} disabled={busy}>
                Resume
              </Button>
              <Button size="xs" onClick={onEdit} disabled={busy}>Edit</Button>
            </>
          )}
          {promotion.status === "ACTIVE" && (
            <>
              <Button size="xs" colorPalette="yellow" onClick={() => setConfirming("pause")} disabled={busy}>
                Pause
              </Button>
              {promotion.triggerKind === "manual_send" && (
                <Button size="xs" colorPalette="blue" onClick={() => setConfirming("sendNow")} disabled={busy}>
                  Send Now
                </Button>
              )}
            </>
          )}
          {!closed && (
            <Button size="xs" colorPalette="red" variant="outline" onClick={() => setConfirming("retire")} disabled={busy}>
              Retire
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => void act("duplicate")} disabled={busy}>
            Duplicate
          </Button>
          {(promotion.dispatchChannels.includes("email")) && (
            <Button size="xs" variant="outline" colorPalette="teal" onClick={() => setTestChannel("email")} disabled={busy}>
              Send email test to me
            </Button>
          )}
          {(promotion.dispatchChannels.includes("sms")) && (
            <Button size="xs" variant="outline" colorPalette="teal" onClick={() => setTestChannel("sms")} disabled={busy}>
              Send SMS test to me
            </Button>
          )}
          {/* Landing-page shortcuts — visible only for LANDING_PAGE promos.
              View opens the public URL in a new tab; Edit opens the
              promotion editor which embeds the landing-page section. */}
          {promotion.linkKind === "LANDING_PAGE" && promotion.landingPage?.slug && (
            promotion.status === "ACTIVE" ? (
              <Button
                size="xs"
                variant="outline"
                colorPalette="purple"
                as="a"
                {...({
                  href: `/promotion/${promotion.landingPage.slug}`,
                  target: "_blank",
                  rel: "noopener noreferrer",
                } as any)}
              >
                View landing page ↗
              </Button>
            ) : (
              /* Not live — a plain link would render the withheld shell
                 ("not available yet"), which is what a client should see
                 but useless to the operator building the page. Mint a
                 short-lived preview token instead and open that. */
              <Button
                size="xs"
                variant="outline"
                colorPalette="purple"
                loading={previewingLanding}
                onClick={async () => {
                  setPreviewingLanding(true);
                  try {
                    const r = await apiPost<{ url: string; ttlMinutes: number }>(
                      `/api/super/promotions/${promotion.id}/landing/preview-url`,
                      {},
                    );
                    window.open(r.url, "_blank", "noopener,noreferrer");
                  } catch (err: any) {
                    publishInlineMessage({
                      type: "ERROR",
                      text: err?.message ?? "Couldn't build a preview link.",
                    });
                  } finally {
                    setPreviewingLanding(false);
                  }
                }}
              >
                Preview landing page ↗
              </Button>
            )
          )}
          {/* Edit landing page is available EVEN WHILE ACTIVE — landing-page
              content isn't per-delivery snapshotted (clients always see the
              current state when they click the CTA), so editing mid-campaign
              is safe. The slug stays locked once ACTIVE inside the editor
              so shipped URLs don't 404. Only hidden once CLOSED. */}
          {promotion.linkKind === "LANDING_PAGE" && !closed && promotion.landingPageId && (
            <Button size="xs" variant="outline" colorPalette="purple" onClick={onEditLanding} disabled={busy}>
              Edit landing page
            </Button>
          )}
          {/* Preview how this promo lands on a client's invoice. Only
              meaningful when the promo actually targets that surface and
              has content for it — the same pair the dispatcher requires
              (Invariant B in promotions-build-gate). Mirrors the button
              inside the editor so the check is reachable without opening
              Edit, which is the state an operator is usually in when
              they want to eyeball it. */}
          {(promotion.displaySurfaces ?? []).includes("invoice_page")
            && promotion.content?.invoice_page && (
            <Button size="xs" variant="outline" colorPalette="blue" onClick={() => setPreviewInvoice(true)}>
              <Eye size={12} />
              <Text ml={1}>Preview invoice</Text>
            </Button>
          )}
        </HStack>
        {previewInvoice && promotion.content?.invoice_page && (
          <InvoicePreviewDialog
            content={promotion.content.invoice_page}
            promoId={promotion.linkKind === "LANDING_PAGE" ? promotion.id : null}
            onClose={() => setPreviewInvoice(false)}
          />
        )}

        {/* Config summary */}
        <VStack align="stretch" gap={1} fontSize="xs" mb={4} p={2} bg="gray.50" rounded="md">
          <HStack gap={2} align="baseline" wrap="wrap">
            <Text fontWeight="semibold">Link:</Text>
            {promotion.linkKind === "LANDING_PAGE" && promotion.landingPage?.slug ? (
              <>
                <Text color="fg.muted">
                  Custom landing page →{" "}
                  <Text
                    as="a"
                    color="blue.600"
                    textDecoration="underline"
                    {...({
                      href: `/promotion/${promotion.landingPage.slug}`,
                      target: "_blank",
                      rel: "noopener noreferrer",
                    } as any)}
                  >
                    /promotion/{promotion.landingPage.slug}
                  </Text>
                </Text>
              </>
            ) : promotion.link ? (
              <Text
                as="a"
                color="blue.600"
                textDecoration="underline"
                {...({
                  href: promotion.link,
                  target: "_blank",
                  rel: "noopener noreferrer",
                } as any)}
              >
                {promotion.link}
              </Text>
            ) : (
              <Text color="fg.muted">(none)</Text>
            )}
          </HStack>
          <HStack gap={2}><Text fontWeight="semibold">Trigger:</Text><Text color="fg.muted">{promotion.triggerKind ?? "(display-only)"}</Text></HStack>
          <HStack gap={2}><Text fontWeight="semibold">Dispatch:</Text><Text color="fg.muted">{promotion.dispatchChannels.join(", ") || "(none)"}</Text></HStack>
          <HStack gap={2}><Text fontWeight="semibold">Display:</Text><Text color="fg.muted">{promotion.displaySurfaces.join(", ") || "(none)"}</Text></HStack>
          <HStack gap={2}><Text fontWeight="semibold">Cooldown:</Text><Text color="fg.muted">{promotion.cooldownDays} day(s)</Text></HStack>
          <HStack gap={2}><Text fontWeight="semibold">Window:</Text><Text color="fg.muted">
            {promotion.startAt ? fmtDate(promotion.startAt) : "(no start)"} → {promotion.endAt ? fmtDate(promotion.endAt) : "on-going"}
          </Text></HStack>
        </VStack>

        {/* Audit timeline */}
        <Text fontSize="sm" fontWeight="semibold" mt={3} mb={1}>State history</Text>
        <VStack align="stretch" gap={1} fontSize="xs" maxH="180px" overflowY="auto">
          {audit === null ? (
            <Spinner size="xs" />
          ) : audit.length === 0 ? (
            <Text color="fg.muted" fontStyle="italic">No events yet.</Text>
          ) : (
            audit.map((a) => (
              <HStack key={a.id} gap={2}>
                <Text color="fg.muted" minW="140px">{fmtDateTime(a.createdAt)}</Text>
                <Text>{a.verb.replace(/^PROMOTION_/, "").toLowerCase()}</Text>
                <Text color="fg.muted">by {a.actor?.displayName ?? "unknown"}</Text>
              </HStack>
            ))
          )}
        </VStack>

        {/* Delivery log */}
        <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Deliveries ({deliveries?.length ?? "…"})</Text>
        <Box maxH="240px" overflowY="auto" borderWidth="1px" borderColor="gray.200" rounded="md">
          <Table.Root size="sm" variant="line">
            <Table.Header position="sticky" top={0} bg="gray.50" zIndex={1}>
              <Table.Row>
                <Table.ColumnHeader fontSize="2xs">When</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Client</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Contact</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Channel</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Result</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" textAlign="right">Clicks</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {deliveries?.map((d) => (
                <Table.Row key={d.id}>
                  <Table.Cell fontSize="xs">{fmtDateTime(d.createdAt)}</Table.Cell>
                  <Table.Cell fontSize="xs">
                    {/* SetNull FK: after a Client is deleted, the join
                        returns null. Render an italicized "(deleted)"
                        so audit-preserved historical rows read as
                        intentional, not broken data. */}
                    {d.client
                      ? d.client.displayName
                      : <Text as="span" fontStyle="italic" color="fg.muted">(deleted client)</Text>}
                  </Table.Cell>
                  <Table.Cell fontSize="xs">
                    {d.contact
                      ? `${d.contact.firstName} ${d.contact.lastName}`
                      : <Text as="span" fontStyle="italic" color="fg.muted">(deleted contact)</Text>}
                  </Table.Cell>
                  <Table.Cell fontSize="xs">{d.channel}</Table.Cell>
                  <Table.Cell fontSize="xs">
                    {d.deliveredAt
                      ? <Badge size="xs" colorPalette="green">delivered</Badge>
                      : <Badge size="xs" colorPalette="gray" title={d.skippedReason ?? ""}>{d.skippedReason ?? "pending"}</Badge>}
                  </Table.Cell>
                  <Table.Cell fontSize="xs" textAlign="right">
                    {d.clickCount > 0
                      ? <Badge size="xs" colorPalette="blue">{d.clickCount}</Badge>
                      : <Text as="span" color="fg.muted">—</Text>}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </Card.Body>

      <ConfirmDialog
        open={!!confirming}
        title={confirming ? {
          start: "Start promotion?",
          pause: "Pause promotion?",
          resume: "Resume promotion?",
          retire: "Retire promotion?",
          sendNow: "Send now — blast to audience?",
        }[confirming] : ""}
        message={confirming === "retire"
          ? "Retiring is permanent. The promotion moves to Closed and can no longer be edited. You can Duplicate it to reuse the content."
          : confirming === "sendNow"
            ? "This will send the promo to every active client's primary contact via all selected dispatch channels. Deliveries are logged; recipients opted out will be skipped."
            : "Are you sure?"}
        confirmLabel={confirming ? {
          start: "Start",
          pause: "Pause",
          resume: "Resume",
          retire: "Retire",
          sendNow: "Send now",
        }[confirming] : ""}
        confirmColorPalette={confirming === "retire" ? "red" : confirming === "sendNow" ? "blue" : "green"}
        onConfirm={() => {
          if (confirming === "sendNow") void act("send-now");
          else if (confirming) void act(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={!!testChannel}
        title="Send a test to yourself?"
        message={testChannel === "email"
          ? "Sends this promotion's email content to your own email address on file. Prefixed [TEST]."
          : "Sends this promotion's SMS content to your own phone on file. Prefixed [TEST]."}
        confirmLabel="Send test"
        confirmColorPalette="teal"
        onConfirm={() => testChannel && void sendTest(testChannel)}
        onCancel={() => setTestChannel(null)}
      />
    </Card.Root>
  );
}

// ─── Editor (dialog) ────────────────────────────────────────────────────

const TRIGGER_KINDS: TriggerKind[] = ["on_invoice_sent", "manual_send"];
const triggerCollection = createListCollection({
  items: [
    { value: "on_invoice_sent", label: "Piggyback on invoice sends" },
    { value: "manual_send", label: "Manual (Send Now button)" },
  ],
});

function PromotionEditor({
  initial, onCancel, onSaved,
}: {
  initial: Promotion | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [linkKind, setLinkKind] = useState<LinkKind>(initial?.linkKind ?? "EXTERNAL");
  const [link, setLink] = useState(initial?.link ?? "");
  const [dispatchChannels, setDispatchChannels] = useState<DispatchChannel[]>(initial?.dispatchChannels ?? []);
  const [displaySurfaces, setDisplaySurfaces] = useState<DisplaySurface[]>(initial?.displaySurfaces ?? []);
  const [triggerKind, setTriggerKind] = useState<TriggerKind | null>(initial?.triggerKind ?? null);
  const [cooldownDays, setCooldownDays] = useState(initial?.cooldownDays ?? 7);
  const [startAt, setStartAt] = useState(initial?.startAt ? initial.startAt.slice(0, 10) : "");
  const [endAt, setEndAt] = useState(initial?.endAt ? initial.endAt.slice(0, 10) : "");
  const [content, setContent] = useState<PromoContent>(initial?.content ?? {});
  const [shortSlug, setShortSlug] = useState(initial?.shortSlug ?? "");
  const [baseDomain, setBaseDomain] = useState<string>(initial?.baseDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [savedPromoId, setSavedPromoId] = useState<string | null>(initial?.id ?? null);
  // Pending landing-page meta edits (headline / intro / slug). The nested
  // editor registers a flush here while its fields are dirty so this
  // dialog's Save persists them too — see LandingPageEditor.registerSave.
  // Short link code mirrors the landing page address until the operator
  // types their own. Seeded as "already touched" for a promo that has a
  // short code on file, so reopening an existing campaign never silently
  // rewrites a code that may already be in the wild.
  const [shortSlugTouched, setShortSlugTouched] = useState(!!initial?.shortSlug);
  const [landingSlug, setLandingSlug] = useState("");
  const onLandingSlugChange = useCallback((v: string) => setLandingSlug(v), []);
  const landingFlushRef = useRef<(() => Promise<void>) | null>(null);
  const [landingDirty, setLandingDirty] = useState(false);
  const registerLandingSave = useCallback((fn: (() => Promise<void>) | null) => {
    landingFlushRef.current = fn;
    setLandingDirty(!!fn);
  }, []);
  const promoIsDraft = !initial || initial.status === "DRAFT";
  // Slug is locked once the promotion has ever been started — changing
  // it would 404 every already-sent short URL. Matches the server-side
  // check in routes/promotions.ts.
  // Short-URL slug locks on first SHIPPED delivery, matching the landing
  // page slug and the server guard in routes/promotions.ts. Not on
  // startedAt: activating a campaign puts no URL in anyone's hands.
  const slugLocked = (initial?.shippedCount ?? 0) > 0;

  // Allowed domains for the per-campaign domain picker. Fetched lazily
  // when the editor opens so the dropdown is populated from the same
  // ALLOWED_DOMAINS setting the click handler validates against.
  const [allowedDomains, setAllowedDomains] = useState<{ origins: string[]; primaryHostname: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<{ origins: string[]; primaryHostname: string }>("/api/super/promotions/allowed-domains")
      .then((r) => { if (!cancelled) setAllowedDomains(r); })
      .catch(() => { if (!cancelled) setAllowedDomains({ origins: [], primaryHostname: "" }); });
    return () => { cancelled = true; };
  }, []);

  // Live URL preview — updates as operator types the slug. Uses the
  // per-campaign domain when set, else the primary. Placeholder "abcd"
  // stands in for the real per-recipient shortCode.
  const previewBase = (baseDomain.trim() || `https://${allowedDomains?.primaryHostname ?? "seedlings.pro"}`).replace(/\/$/, "");
  const previewSlug = shortSlug.trim().toLowerCase();
  const previewPersonalUrl = previewSlug
    ? `${previewBase}/mo/${previewSlug}/abcd`
    : null;
  const previewAnonymousUrl = previewSlug
    ? `${previewBase}/mo/${previewSlug}`
    : null;
  // Mirror. Skipped once the operator has typed their own code, once the
  // code locks (real links are out there), and for EXTERNAL promos, which
  // have no landing page to mirror.
  useEffect(() => {
    if (shortSlugTouched || slugLocked) return;
    if (linkKind !== "LANDING_PAGE" || !landingSlug) return;
    setShortSlug(landingSlug);
  }, [landingSlug, shortSlugTouched, slugLocked, linkKind]);

  // Client-side slug validation mirrors the server-side rule so operators
  // see errors before hitting Save. Same regex, same 64-char cap as the
  // landing-page slug (see PROMO_SHORT_SLUG_PATTERN).
  const slugValidationError = previewSlug && !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/.test(previewSlug)
    ? "Lowercase letters, digits, and single hyphens only (1–64 chars, no leading/trailing hyphen, no double hyphens)."
    : null;
  // Advisory, NOT a block. Every character here rides along in each text
  // message, and crossing a segment boundary bills as two — but that's a
  // judgement call for the operator, not something to forbid.
  const slugLengthWarning = previewSlug.length > 40
    ? `${previewSlug.length} characters — long for a text message. Every character counts toward the SMS segment, and going over bills as two.`
    : null;

  function toggleChannel(c: DispatchChannel) {
    setDispatchChannels((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
    // Seed empty content shell when a channel gets enabled so the panel renders.
    setContent((prev) => {
      if (prev[c]) return prev;
      if (c === "sms") return { ...prev, sms: { body: "", ctaText: "" } };
      if (c === "email") return { ...prev, email: { subject: "", body: "", ctaText: "" } };
      return prev;
    });
  }
  function toggleSurface(s: DisplaySurface) {
    setDisplaySurfaces((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setContent((prev) => {
      if (prev[s]) return prev;
      if (s === "invoice_page") return { ...prev, invoice_page: { body: "", ctaText: "" } };
      return prev;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        linkKind,
        // link is only relevant for EXTERNAL. LANDING_PAGE promotions
        // resolve their URL server-side from the linked landing page's
        // slug, so we send null and let the server clear it.
        link: linkKind === "EXTERNAL" ? (link.trim() || null) : null,
        audienceSpec: { kind: "all" },
        dispatchChannels,
        displaySurfaces,
        triggerKind: dispatchChannels.length > 0 ? triggerKind : null,
        triggerConfig: {},
        cooldownDays,
        // ET-anchored — end-of-day ET on endAt matches the spec's
        // "endOfDay ET" semantics per docs/DATE_HANDLING.md.
        startAt: startAt ? bizInstantFromEtParts(startAt as EtDateKey, "00:00") : null,
        endAt: endAt ? bizInstantFromEtParts(endAt as EtDateKey, "23:59") : null,
        content,
        // Short URL fields. Empty → null (fall back to legacy long URLs
        // for shortSlug; fall back to primary domain for baseDomain).
        shortSlug: shortSlug.trim() ? shortSlug.trim().toLowerCase() : null,
        baseDomain: baseDomain.trim() || null,
      };
      let id = savedPromoId;
      if (initial) {
        await apiPatch(`/api/super/promotions/${initial.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Promotion updated." });
      } else {
        const created = await apiPost<{ id: string }>("/api/super/promotions", payload);
        id = created.id;
        setSavedPromoId(id);
        publishInlineMessage({ type: "SUCCESS", text: "Promotion created." });
      }
      // If they chose LANDING_PAGE and no page exists yet, ensure one
      // gets created so they can edit its items immediately.
      if (linkKind === "LANDING_PAGE" && id && !initial?.landingPageId) {
        await apiPost(`/api/super/promotions/${id}/landing`, {}).catch(() => {});
      }
      // Flush unsaved landing-page headline / intro / slug. Those fields
      // live in a nested editor with its own Save button, and an operator
      // who edits the slug and then clicks THIS dialog's Save would
      // otherwise lose the change silently — permanently, since the slug
      // locks the moment the promotion leaves DRAFT. Deliberately NOT
      // swallowed: a rejected slug (duplicate, or already locked) has to
      // surface, or we're back to silently discarding the edit.
      if (landingFlushRef.current) {
        await landingFlushRef.current();
      }
      onSaved();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="2xl" mx={4}>
            <Dialog.Header>
              <Dialog.Title>{initial ? "Edit promotion" : "New promotion"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body maxH="70vh" overflowY="auto">
              <VStack align="stretch" gap={4}>
                <Box>
                  <Text fontSize="xs" fontWeight="semibold" mb={1}>Title</Text>
                  <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="semibold" mb={1}>Internal note</Text>
                  <Textarea size="sm" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="semibold" mb={1}>Link goes to</Text>
                  <HStack gap={4}>
                    <Checkbox.Root
                      checked={linkKind === "EXTERNAL"}
                      onCheckedChange={() => setLinkKind("EXTERNAL")}
                    >
                      <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>External URL</Checkbox.Label>
                    </Checkbox.Root>
                    <Checkbox.Root
                      checked={linkKind === "LANDING_PAGE"}
                      onCheckedChange={() => setLinkKind("LANDING_PAGE")}
                    >
                      <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Custom landing page</Checkbox.Label>
                    </Checkbox.Root>
                  </HStack>
                </Box>

                {linkKind === "EXTERNAL" && (
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>External URL</Text>
                    <Input size="sm" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
                  </Box>
                )}

                {linkKind === "LANDING_PAGE" && savedPromoId && initial?.landingPageId && (
                  <LandingPageEditor
                    pageId={initial.landingPageId}
                    promoId={savedPromoId}
                    promotionStatus={initial.status}
                    registerSave={registerLandingSave}
                    onSlugChange={onLandingSlugChange}
                  />
                )}
                {linkKind === "LANDING_PAGE" && !initial?.landingPageId && (
                  <Box p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md" fontSize="xs" color="blue.900">
                    Save this promotion first — the landing page editor will
                    appear next time you open it. The landing page's public URL
                    will be generated from the title (you can customize it).
                  </Box>
                )}

                {/* Short URL (optional) — branded per-recipient URL for
                    outbound messages. Leaving both fields blank keeps the
                    campaign on the legacy long-form wrapper URL. */}
                <Box borderTopWidth="1px" borderColor="gray.200" pt={4}>
                  <Text fontSize="xs" fontWeight="semibold" mb={1}>Short link (optional)</Text>
                  <Text fontSize="2xs" color="fg.muted" mb={2}>
                    A short branded <b>tracker</b> link like <b>{previewBase}/mo/&lt;code&gt;/abcd</b> to
                    put in outbound texts and emails. It hosts nothing: opening it records the
                    click{linkKind === "LANDING_PAGE" ? " and forwards to the landing page above" : " and forwards to the External URL above"}.
                    The <b>abcd</b> tail identifies which recipient clicked. Leave blank to use the
                    older long-form tracker URL.
                    {slugLocked && (
                      <> The code is <b>locked</b> because {initial?.shippedCount} {(initial?.shippedCount ?? 0) === 1 ? "delivery has" : "deliveries have"} already gone out with it — changing it would 404 those links.</>
                    )}
                  </Text>
                  <VStack align="stretch" gap={3}>
                    <Box>
                      <Text fontSize="2xs" fontWeight="semibold" mb={1}>Short link code</Text>
                      <Input
                        size="sm"
                        placeholder="fall-offer-2026"
                        value={shortSlug}
                        onChange={(e) => { setShortSlug(e.target.value); setShortSlugTouched(true); }}
                        disabled={slugLocked}
                        fontFamily="mono"
                      />
                      {slugValidationError && (
                        <Text fontSize="2xs" color="red.600" mt={1}>{slugValidationError}</Text>
                      )}
                      {/* Advisory, never a block — the operator decides. */}
                      {!slugValidationError && slugLengthWarning && (
                        <Text fontSize="2xs" color="orange.700" mt={1}>{slugLengthWarning}</Text>
                      )}
                      {!shortSlugTouched && !slugLocked && linkKind === "LANDING_PAGE" && landingSlug && (
                        <Text fontSize="2xs" color="fg.muted" mt={1}>
                          Matches the landing page address. Change it only if you want a
                          shorter link for texts.
                        </Text>
                      )}
                    </Box>
                    {allowedDomains && allowedDomains.origins.length > 1 && (() => {
                      // Build the Chakra collection each render — cheap
                      // (max ~5 items) and keeps the dependency on the
                      // async-loaded allowedDomains simple.
                      const domainCollection = createListCollection({
                        items: [
                          { label: `Default (${allowedDomains.primaryHostname})`, value: "" },
                          ...allowedDomains.origins.map((o) => ({ label: o, value: o })),
                        ],
                      });
                      return (
                        <Box>
                          <Text fontSize="2xs" fontWeight="semibold" mb={1}>Domain</Text>
                          <Select.Root
                            collection={domainCollection}
                            size="sm"
                            value={[baseDomain]}
                            onValueChange={(e) => setBaseDomain(e.value?.[0] ?? "")}
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
                                {domainCollection.items.map((it) => (
                                  <Select.Item key={it.value} item={it}>
                                    <Select.ItemText>{it.label}</Select.ItemText>
                                  </Select.Item>
                                ))}
                              </Select.Content>
                            </Select.Positioner>
                          </Select.Root>
                        </Box>
                      );
                    })()}
                    {previewSlug && !slugValidationError && (
                      <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                        <Text fontSize="2xs" color="fg.muted" mb={1}>Preview short links (both forward to the destination above)</Text>
                        <Text fontSize="xs" fontFamily="mono" wordBreak="break-all">
                          <b>Per-recipient</b> (sent in messages, tracks who clicked):
                          <br />{previewPersonalUrl}
                        </Text>
                        <Text fontSize="xs" fontFamily="mono" wordBreak="break-all" mt={2}>
                          <b>Anonymous</b> (share on lawn signs / social — same destination, no per-person tracking):
                          <br />{previewAnonymousUrl}
                        </Text>
                      </Box>
                    )}
                  </VStack>
                </Box>

                <HStack gap={4} align="start" wrap="wrap">
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Dispatch channels</Text>
                    <HStack gap={3}>
                      <Checkbox.Root checked={dispatchChannels.includes("email")} onCheckedChange={() => toggleChannel("email")}>
                        <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Email</Checkbox.Label>
                      </Checkbox.Root>
                      <Checkbox.Root checked={dispatchChannels.includes("sms")} onCheckedChange={() => toggleChannel("sms")}>
                        <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>SMS</Checkbox.Label>
                      </Checkbox.Root>
                    </HStack>
                  </Box>
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Display surfaces</Text>
                    <HStack gap={3}>
                      <Checkbox.Root checked={displaySurfaces.includes("invoice_page")} onCheckedChange={() => toggleSurface("invoice_page")}>
                        <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Invoice page</Checkbox.Label>
                      </Checkbox.Root>
                    </HStack>
                  </Box>
                </HStack>

                {dispatchChannels.length > 0 && (
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Trigger</Text>
                    <Select.Root
                      collection={triggerCollection}
                      size="sm"
                      value={triggerKind ? [triggerKind] : []}
                      onValueChange={(e) => setTriggerKind((e.value[0] as TriggerKind) ?? null)}
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger><Select.ValueText placeholder="Choose trigger…" /></Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {triggerCollection.items.map((it) => (
                            <Select.Item key={it.value} item={it}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </Box>
                )}

                <HStack gap={3} wrap="wrap">
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Start (ET)</Text>
                    <Input type="date" size="sm" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
                  </Box>
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>End (ET) — blank = on-going</Text>
                    <Input type="date" size="sm" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
                  </Box>
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Cooldown days</Text>
                    <Input type="number" size="sm" width="80px" value={cooldownDays} min={0} max={365}
                      onChange={(e) => setCooldownDays(Number(e.target.value) || 0)} />
                  </Box>
                </HStack>

                {dispatchChannels.includes("sms") && (
                  <ChannelPanelSms
                    content={content.sms ?? { body: "", ctaText: "" }}
                    link={link}
                    onChange={(v) => setContent((p) => ({ ...p, sms: v }))}
                  />
                )}
                {dispatchChannels.includes("email") && (
                  <ChannelPanelEmail
                    content={content.email ?? { subject: "", body: "", ctaText: "" }}
                    link={link}
                    onChange={(v) => setContent((p) => ({ ...p, email: v }))}
                  />
                )}
                {displaySurfaces.includes("invoice_page") && (
                  <ChannelPanelInvoicePage
                    content={content.invoice_page ?? { body: "", ctaText: "" }}
                    link={link}
                    promoId={linkKind === "LANDING_PAGE" ? savedPromoId : null}
                    onChange={(v) => setContent((p) => ({ ...p, invoice_page: v }))}
                  />
                )}

                <Box p={2} bg="gray.50" rounded="md" fontSize="xs" color="fg.muted">
                  <Text fontWeight="semibold" mb={1}>Offer / discount (coming soon)</Text>
                  <Text>Discount mechanics will be added in a future update — the field exists in the model but is disabled today.</Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} justify="space-between" w="full">
                {/* Tell the operator the nested landing-page fields are
                    included. Without this the dialog has two Save buttons
                    and no indication that the outer one now covers both. */}
                <Text fontSize="2xs" color="fg.muted">
                  {landingDirty ? "Includes your unsaved landing page changes." : ""}
                </Text>
                <HStack gap={2}>
                  <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                  <Button colorPalette="blue" onClick={save} loading={busy} disabled={!title.trim()}>
                    Save
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Channel content panels (with previews) ─────────────────────────────

function ChannelPanelSms({
  content, link, onChange,
}: {
  content: { body: string; ctaText?: string };
  link: string;
  onChange: (v: { body: string; ctaText?: string }) => void;
}) {
  const body = content.body ?? "";
  const cta = content.ctaText ?? "";
  const optOutStub = "Stop promos: https://…";
  const previewLines: string[] = [body];
  if (cta && link) previewLines.push(`${cta} ${link}`);
  else if (link) previewLines.push(link);
  previewLines.push(optOutStub);
  const preview = previewLines.filter(Boolean).join("\n");
  const info = smsInfo(preview);
  return (
    <Card.Root variant="outline">
      <Card.Body>
        <Text fontSize="sm" fontWeight="semibold" mb={2}>SMS content</Text>
        <VStack align="stretch" gap={2}>
          <Textarea size="sm" rows={3} placeholder="Body of the SMS…" value={body}
            onChange={(e) => onChange({ ...content, body: e.target.value })} />
          <Input size="sm" placeholder="Call-to-action label (e.g. Book now, Learn more)" value={cta}
            onChange={(e) => onChange({ ...content, ctaText: e.target.value })} />
          <Box p={2} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
            <Text fontSize="2xs" color="fg.muted" mb={1}>Preview (with placeholder opt-out URL)</Text>
            <Text fontSize="xs" whiteSpace="pre-wrap" fontFamily="mono">{preview}</Text>
            <Text fontSize="2xs" color={info.segments > 1 ? "orange.700" : "fg.muted"} mt={1}>
              {info.chars} chars · {info.segments} segment{info.segments === 1 ? "" : "s"}
              {info.encoding === "ucs2" ? " · UCS-2 (emoji / non-Latin)" : ""}
            </Text>
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function ChannelPanelEmail({
  content, link, onChange,
}: {
  content: { subject: string; body: string; ctaText?: string };
  link: string;
  onChange: (v: { subject: string; body: string; ctaText?: string }) => void;
}) {
  return (
    <Card.Root variant="outline">
      <Card.Body>
        <Text fontSize="sm" fontWeight="semibold" mb={2}>Email content</Text>
        <VStack align="stretch" gap={2}>
          <Input size="sm" placeholder="Subject" value={content.subject}
            onChange={(e) => onChange({ ...content, subject: e.target.value })} />
          <Textarea size="sm" rows={5} placeholder="Body (Markdown supported)" value={content.body}
            onChange={(e) => onChange({ ...content, body: e.target.value })} />
          <Input size="sm" placeholder="Call-to-action button label (e.g. Book now, Learn more)" value={content.ctaText ?? ""}
            onChange={(e) => onChange({ ...content, ctaText: e.target.value })} />
          <Box p={2} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
            <Text fontSize="2xs" color="fg.muted" mb={1}>Preview</Text>
            <Text fontSize="xs" fontWeight="bold">{content.subject || "(subject)"}</Text>
            <Text fontSize="xs" whiteSpace="pre-wrap" mt={1}>{content.body || "(body)"}</Text>
            {content.ctaText && link && (
              <Button size="xs" colorPalette="blue" mt={2}
                as="a" {...({ href: link, target: "_blank", rel: "noopener noreferrer" } as any)}>
                {content.ctaText}
              </Button>
            )}
            <Text fontSize="2xs" color="fg.muted" mt={2} fontStyle="italic">
              CAN-SPAM footer with business address + unsubscribe link is auto-appended at send time.
            </Text>
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

/** Full-invoice preview — renders the promo card in its real position on
 *  the client-facing /pay/[token] page. Deliberately mirrors that page's
 *  structure and styling (see apps/web/pages/pay/[token].tsx): Invoice
 *  total card → Offers → Payment. Sample invoice data is obviously fake
 *  so nobody mistakes it for a real client's figures; the ONLY real
 *  content is the promo card itself.
 *
 *  Kept as a static mirror rather than importing from the pay page: that
 *  page is a Next route that fetches by token and renders a full page
 *  shell, so it can't be mounted standalone. If the pay page's promo
 *  treatment changes, update the Offers block here to match. */
function InvoicePreviewDialog({
  content, promoId, onClose,
}: {
  content: { headline?: string; body: string; ctaText?: string };
  /** When set, the dialog loads the promo's landing page to show the same
   *  cover photo the real invoice will use (first photo of the first
   *  item). Omitted for promos with no landing page. */
  promoId?: string | null;
  onClose: () => void;
}) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!promoId) return;
    let cancelled = false;
    apiGet<{ items: { photos: { url: string | null }[] }[] }>(
      `/api/super/promotions/${promoId}/landing`,
    )
      .then((page) => {
        if (cancelled) return;
        // Same selection the server makes in loadInvoicePagePromos:
        // first photo of the first item, both already in display order.
        const first = page.items.flatMap((i) => i.photos).find((ph) => ph.url);
        setCoverUrl(first?.url ?? null);
      })
      // No landing page (external-link promo) or no photos — the real
      // invoice renders text-only in that case too, so match it silently.
      .catch(() => { if (!cancelled) setCoverUrl(null); });
    return () => { cancelled = true; };
  }, [promoId]);

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center" size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Invoice preview</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="xs" color="fg.muted" mb={3}>
                How this promotion appears on the invoice your client opens.
                The invoice details below are sample data &mdash; only the
                offer is your real content.
              </Text>

              {/* Mirrors the pay page's own page shell width + section gap. */}
              <Box borderWidth="1px" borderColor="gray.200" rounded="lg" p={4} bg="white">
                <VStack gap={5} align="stretch">
                  {/* ── Invoice total (sample) ── */}
                  <Box>
                    <Text fontSize="md" fontWeight="bold" mb={2} letterSpacing="tight">Invoice</Text>
                    <Box
                      p={4}
                      bg="gray.100"
                      borderWidth="1px"
                      borderColor="gray.300"
                      borderLeftWidth="4px"
                      borderLeftColor="gray.500"
                      rounded="lg"
                    >
                      <VStack gap={1} align="stretch">
                        <Text fontSize="md" fontWeight="semibold">123 Sample Street</Text>
                        <Text fontSize="sm" color="fg.muted">Sample service date</Text>
                        <HStack mt={2} align="baseline" justify="space-between">
                          <Text fontSize="sm" color="fg.muted">Total due</Text>
                          <Text fontSize="2xl" fontWeight="bold" color="teal.700">$85.00</Text>
                        </HStack>
                      </VStack>
                    </Box>
                  </Box>

                  {/* ── Offers — the real promo card ── */}
                  <Box>
                    <Text fontSize="md" fontWeight="bold" mb={2} letterSpacing="tight">Offers</Text>
                    <Box
                      p={4}
                      bg="blue.50"
                      borderWidth="1px"
                      borderColor="blue.200"
                      borderLeftWidth="4px"
                      borderLeftColor="blue.500"
                      rounded="lg"
                    >
                      <HStack align="start" gap={3}>
                        {coverUrl && (
                          <Box w="80px" h="80px" flexShrink={0} rounded="md" overflow="hidden" bg="blackAlpha.100">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={coverUrl}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                            />
                          </Box>
                        )}
                        <Box flex="1" minW={0}>
                          {content.headline && (
                            <Text fontSize="sm" fontWeight="bold" color="blue.900" mb={2}>
                              {content.headline}
                            </Text>
                          )}
                          <Text fontSize="sm" color="fg.default" whiteSpace="pre-wrap">
                            {content.body || "(no body text yet)"}
                          </Text>
                        </Box>
                      </HStack>
                      {/* CTA always renders. On the real page the URL is a
                          click-wrapper built server-side from the promo id
                          (see loadInvoicePagePromos), NOT promotion.link —
                          so a landing-page promo, which has link: null,
                          still shows this button. Gating the preview on
                          `link` hid it for exactly those promos. Inert
                          here: it's a preview, there's nothing to click. */}
                      <Button size="sm" colorPalette="blue" mt={3}>
                        {content.ctaText || "Learn more \u2192"}
                      </Button>
                    </Box>
                  </Box>

                  {/* ── Payment (sample, dimmed — context only) ── */}
                  <Box opacity={0.55}>
                    <Text fontSize="md" fontWeight="bold" mb={2} letterSpacing="tight">Payment</Text>
                    <Box p={3} borderWidth="1px" borderColor="gray.200" rounded="md">
                      <Text fontSize="sm" color="fg.muted">
                        Payment method picker and Pay button appear here.
                      </Text>
                    </Box>
                  </Box>
                </VStack>
              </Box>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ChannelPanelInvoicePage({
  content, link, promoId, onChange,
}: {
  content: { headline?: string; body: string; ctaText?: string };
  link: string;
  /** Passed to the preview so it can load the same cover photo the real
   *  invoice shows. Null for external-link promos. */
  promoId?: string | null;
  onChange: (v: { headline?: string; body: string; ctaText?: string }) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <Card.Root variant="outline">
      <Card.Body>
        <HStack justify="space-between" align="center" mb={2}>
          <Text fontSize="sm" fontWeight="semibold">Invoice page content</Text>
          {/* Full-invoice preview. The inline block below shows the promo
              card on its own, which answers "does my copy look right" but
              not "where does this land on the page the client actually
              opens". This button shows it in position — between the
              invoice total and the Payment section. */}
          <Button size="xs" variant="outline" onClick={() => setPreviewOpen(true)}>
            <Eye size={12} />
            <Text ml={1}>Preview invoice</Text>
          </Button>
        </HStack>
        {previewOpen && (
          <InvoicePreviewDialog
            content={content}
            promoId={promoId}
            onClose={() => setPreviewOpen(false)}
          />
        )}
        <VStack align="stretch" gap={2}>
          <Input size="sm" placeholder="Headline (optional, appears in bold)" value={content.headline ?? ""}
            onChange={(e) => onChange({ ...content, headline: e.target.value })} />
          <Textarea size="sm" rows={4} placeholder="Body (Markdown supported)" value={content.body}
            onChange={(e) => onChange({ ...content, body: e.target.value })} />
          <Input size="sm" placeholder="Call-to-action button label (e.g. Book now, Learn more)" value={content.ctaText ?? ""}
            onChange={(e) => onChange({ ...content, ctaText: e.target.value })} />
          <Box p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderLeftWidth="4px" borderLeftColor="blue.500" rounded="md">
            <Text fontSize="2xs" color="fg.muted" mb={1}>Preview (as shown on /pay/[token])</Text>
            {content.headline && <Text fontSize="md" fontWeight="bold" color="blue.900" mb={1}>{content.headline}</Text>}
            <Text fontSize="sm" whiteSpace="pre-wrap">{content.body || "(body)"}</Text>
            {content.ctaText && link && (
              <Button size="sm" colorPalette="blue" mt={2}
                as="a" {...({ href: link, target: "_blank", rel: "noopener noreferrer" } as any)}>
                {content.ctaText}
              </Button>
            )}
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

// SMS char / segment info — mirrors services/promotions.ts smsSegmentInfo.
function smsInfo(fullText: string): { encoding: "gsm7" | "ucs2"; chars: number; segments: number } {
  const GSM7_BASE = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const GSM7_EXT = "\f^{}\\[~]|€";
  let gsm = true;
  for (const ch of fullText) {
    if (!GSM7_BASE.includes(ch) && !GSM7_EXT.includes(ch)) { gsm = false; break; }
  }
  const chars = [...fullText].length;
  const perSegment = gsm ? 160 : 70;
  const perMulti = gsm ? 153 : 67;
  const segments = chars <= perSegment ? 1 : Math.ceil(chars / perMulti);
  return { encoding: gsm ? "gsm7" : "ucs2", chars, segments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts view — per-contact opt-out toggle
// ─────────────────────────────────────────────────────────────────────────────

function ContactsView() {
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [historyContactId, setHistoryContactId] = useState<string | null>(null);
  const [optDialog, setOptDialog] = useState<null | {
    contactId: string;
    contactName: string;
    channel: "email" | "sms";
    optedOut: boolean; // desired new state
  }>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<ContactRow[]>("/api/super/promotions/contacts");
      setRows(list);
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) =>
      r.client.displayName.toLowerCase().includes(q) ||
      `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
      (r.email ?? "").toLowerCase().includes(q) ||
      (r.phone ?? "").includes(q),
    );
  }, [rows, filter]);

  return (
    <VStack align="stretch" gap={3} mt={3}>
      <Input size="sm" placeholder="Filter by client, contact, email, or phone…"
        value={filter} onChange={(e) => setFilter(e.target.value)} />
      {loading ? (
        <HStack><Spinner size="sm" /><Text fontSize="sm">Loading…</Text></HStack>
      ) : (
        <Box borderWidth="1px" borderColor="gray.200" rounded="md" overflow="hidden">
          <Table.Root size="sm" variant="line" striped>
            <Table.Header position="sticky" top={0} bg="gray.50" zIndex={1}>
              <Table.Row>
                <Table.ColumnHeader fontSize="2xs">Client</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Contact</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">Email opt-out</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">SMS opt-out</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs">History</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filtered.map((r) => (
                <Table.Row key={r.id}>
                  <Table.Cell fontSize="xs">{r.client.displayName}</Table.Cell>
                  <Table.Cell fontSize="xs">
                    {r.firstName} {r.lastName}
                    {r.email && <Text fontSize="2xs" color="fg.muted">{r.email}</Text>}
                    {r.phone && <Text fontSize="2xs" color="fg.muted">{r.phone}</Text>}
                  </Table.Cell>
                  <Table.Cell>
                    {r.email ? (
                      <Button size="xs" variant={r.promoEmailOptedOut ? "solid" : "outline"}
                        colorPalette={r.promoEmailOptedOut ? "red" : "gray"}
                        onClick={() => setOptDialog({
                          contactId: r.id,
                          contactName: `${r.firstName} ${r.lastName}`,
                          channel: "email",
                          optedOut: !r.promoEmailOptedOut,
                        })}>
                        {r.promoEmailOptedOut ? "Opted OUT" : "Opted in"}
                      </Button>
                    ) : <Text fontSize="2xs" color="fg.muted">no email</Text>}
                  </Table.Cell>
                  <Table.Cell>
                    {r.phone ? (
                      <Button size="xs" variant={r.promoSmsOptedOut ? "solid" : "outline"}
                        colorPalette={r.promoSmsOptedOut ? "red" : "gray"}
                        onClick={() => setOptDialog({
                          contactId: r.id,
                          contactName: `${r.firstName} ${r.lastName}`,
                          channel: "sms",
                          optedOut: !r.promoSmsOptedOut,
                        })}>
                        {r.promoSmsOptedOut ? "Opted OUT" : "Opted in"}
                      </Button>
                    ) : <Text fontSize="2xs" color="fg.muted">no phone</Text>}
                  </Table.Cell>
                  <Table.Cell>
                    <Button size="xs" variant="ghost" onClick={() => setHistoryContactId(r.id)}>
                      View
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
      {optDialog && (
        <OptToggleDialog
          contactId={optDialog.contactId}
          contactName={optDialog.contactName}
          channel={optDialog.channel}
          optedOut={optDialog.optedOut}
          onDone={() => { setOptDialog(null); void load(); }}
          onCancel={() => setOptDialog(null)}
        />
      )}
      {historyContactId && (
        <OptHistoryDialog contactId={historyContactId} onClose={() => setHistoryContactId(null)} />
      )}
    </VStack>
  );
}

function OptToggleDialog({
  contactId, contactName, channel, optedOut, onDone, onCancel,
}: {
  contactId: string;
  contactName: string;
  channel: "email" | "sms";
  optedOut: boolean; // desired
  onDone: () => void;
  onCancel: () => void;
}) {
  // Two forks:
  //   • optedOut=true  → normal confirm (opt them out)
  //   • optedOut=false → APPROVE-gated + required reason (re-opt-in)
  const [reason, setReason] = useState("");
  const [approveText, setApproveText] = useState("");
  const [busy, setBusy] = useState(false);
  const isReOptIn = !optedOut;

  async function submit() {
    setBusy(true);
    try {
      await apiPost(`/api/super/promotions/contacts/${contactId}/opt`, {
        channel,
        optedOut,
        approve: isReOptIn ? approveText : undefined,
        reason: isReOptIn ? reason : undefined,
      });
      publishInlineMessage({ type: "SUCCESS", text: `Contact ${optedOut ? "opted out" : "re-enrolled"}.` });
      onDone();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="md" mx={4}>
            <Dialog.Header>
              <Dialog.Title>
                {optedOut ? "Opt out" : "Re-enable promotional messages"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm" mb={3}>
                {optedOut
                  ? `Stop sending promotional ${channel === "email" ? "emails" : "texts"} to ${contactName}?`
                  : `About to turn ${channel === "email" ? "email" : "SMS"} promotions BACK ON for ${contactName}.`}
              </Text>
              {isReOptIn && (
                <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.200" rounded="md" mb={3}>
                  <Text fontSize="xs" fontWeight="semibold" color="orange.900" mb={1}>Important</Text>
                  <Text fontSize="xs" color="orange.900">
                    You must have explicit consent from the client to re-enable promotional messages. Re-enabling without documented consent is a CAN-SPAM violation and can hurt sender reputation.
                  </Text>
                </Box>
              )}
              {isReOptIn && (
                <>
                  <Box mb={3}>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Reason (required)</Text>
                    <Textarea size="sm" rows={2}
                      placeholder="e.g. Client called and requested to be re-enrolled"
                      value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Box>
                  <Box mb={3}>
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>Type APPROVE to confirm</Text>
                    <Input size="sm" value={approveText}
                      onChange={(e) => setApproveText(e.target.value)}
                      placeholder="APPROVE" autoCapitalize="characters" autoCorrect="off" />
                  </Box>
                </>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} justify="flex-end" w="full">
                <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette={optedOut ? "red" : "green"}
                  loading={busy}
                  disabled={isReOptIn && (approveText.trim().toUpperCase() !== "APPROVE" || reason.trim().length < 3)}
                  onClick={submit}
                >
                  {optedOut ? "Opt out" : "Re-enable"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function OptHistoryDialog({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    void apiGet<any[]>(`/api/super/promotions/contacts/${contactId}/history`).then(setRows);
  }, [contactId]);
  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="lg" mx={4}>
            <Dialog.Header>
              <Dialog.Title>Opt history</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {rows === null ? (
                <Spinner size="sm" />
              ) : rows.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" fontStyle="italic">No changes yet.</Text>
              ) : (
                <VStack align="stretch" gap={1} fontSize="xs">
                  {rows.map((r) => (
                    <Box key={r.id} p={2} borderWidth="1px" borderColor="gray.200" rounded="md">
                      <HStack justify="space-between">
                        <Text fontWeight="semibold">
                          {r.verb === "PROMO_OPTED_OUT" ? "Opted out" : "Opted in"} — {r.metadata?.channel}
                        </Text>
                        <Text color="fg.muted">{fmtDateTime(r.createdAt)}</Text>
                      </HStack>
                      <Text color="fg.muted">source: {r.metadata?.source}</Text>
                      {r.metadata?.reason && <Text color="fg.muted">reason: {r.metadata.reason}</Text>}
                      {r.actor && <Text color="fg.muted">by: {r.actor.displayName}</Text>}
                    </Box>
                  ))}
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing-page editor. Used in TWO places:
//   1. Embedded inside PromotionEditor when linkKind=LANDING_PAGE (DRAFT/PAUSED)
//   2. In StandaloneLandingPageDialog for editing while ACTIVE
//
// Editing rules — split by field:
//   • Slug editable until the FIRST delivery actually ships (server
//     computes `slugLocked`; status is irrelevant). Activating a campaign
//     doesn't put the URL in anyone's hands by itself, so locking on
//     ACTIVE stranded operators who spotted a typo right after starting.
//   • Headline / intro / item CRUD / image upload permitted through
//     ACTIVE (landing-page content is not per-delivery snapshotted, so
//     mid-campaign edits are safe — clients always see the current
//     state when they click).
//   • Everything read-only once CLOSED.
//   • Image upload flow: presigned PUT → direct browser upload to R2 →
//     confirm the R2 key with the API. Same shape as property photos.
// ─────────────────────────────────────────────────────────────────────────────

function LandingPageEditor({
  pageId, promoId, promotionStatus, registerSave, onSlugChange,
}: {
  pageId: string;
  promoId: string;
  promotionStatus: PromotionStatus;
  /** Reports the current landing-page address up so the enclosing editor
   *  can mirror it into the Short link code. The two URLs are different
   *  things but almost always want the same name, and making the operator
   *  type it twice is what made them read as unrelated settings. */
  onSlugChange?: (slug: string) => void;
  /** Lets the enclosing PromotionEditor flush unsaved headline/intro/slug
   *  edits when ITS Save button is pressed. Without this, the nested
   *  "Save headline / intro / slug" button is the only thing that
   *  persists those fields — and an operator who edits the slug and then
   *  clicks the dialog's prominent Save loses the change silently. That
   *  is unrecoverable once the promotion leaves DRAFT, because the slug
   *  locks. Optional: the standalone dialog has no outer Save. */
  registerSave?: (fn: (() => Promise<void>) | null) => void;
}) {
  // Split the edit gates: slug locks tight; content stays editable
  // longer.
  const contentEditable = promotionStatus !== "CLOSED";
  const [page, setPage] = useState<LandingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMeta, setSavingMeta] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [headline, setHeadline] = useState("");
  const [intro, setIntro] = useState("");
  const [slug, setSlug] = useState("");
  // Optimistic upload tiles, keyed by item id. Each carries an object URL
  // of the local file so the operator sees the actual photo immediately.
  const [pendingUploads, setPendingUploads] = useState<
    Record<string, { id: string; previewUrl: string }[]>
  >({});
  // In-flight counts live in a ref, not state: the "am I the last upload?"
  // decision has to read a value that's current synchronously, and batched
  // state updates would let two finishers both think they were last.
  const inFlightRef = useRef<Record<string, number>>({});
  const uploadSeqRef = useRef(0);
  // Successes in the current batch, so the completion message can say
  // "3 photos added" once instead of firing a toast per file.
  const uploadOkRef = useRef<Record<string, number>>({});
  const [origSlug, setOrigSlug] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await apiGet<LandingPage>(`/api/super/promotions/${promoId}/landing`);
      setPage(p);
      setHeadline(p.headline ?? "");
      setIntro(p.intro ?? "");
      setSlug(p.slug);
      setOrigSlug(p.slug);
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setLoading(false);
    }
  }, [promoId]);

  useEffect(() => { void load(); }, [load]);

  async function saveMeta() {
    setSavingMeta(true);
    try {
      const payload: { headline?: string; intro?: string; slug?: string } = {
        headline: headline.trim(),
        intro: intro.trim(),
      };
      if (slug !== origSlug) payload.slug = slug.trim();
      await apiPatch(`/api/super/promotions/landing/${pageId}`, payload);
      publishInlineMessage({ type: "SUCCESS", text: "Landing page saved." });
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setSavingMeta(false);
    }
  }

  // Expose a flush to the parent dialog. Registered on every render where
  // the dirty-state changes so the captured closure always sees current
  // headline/intro/slug values. Deregisters on unmount so the parent never
  // calls into a dead component.
  useEffect(() => {
    onSlugChange?.(slug);
    // onSlugChange is a stable useCallback in the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Slug lock comes from the server payload, never from status. A closed
  // promotion is read-only anyway (contentEditable), so combine the two.
  const slugEditable = contentEditable && page != null && !page.slugLocked;
  const metaDirty =
    headline !== (page?.headline ?? "") ||
    intro !== (page?.intro ?? "") ||
    slug !== origSlug;
  useEffect(() => {
    if (!registerSave) return;
    registerSave(metaDirty ? saveMeta : null);
    return () => registerSave(null);
    // saveMeta is redefined each render; metaDirty + the field values are
    // the real inputs. Re-registering on those keeps the closure fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSave, metaDirty, headline, intro, slug]);

  async function deletePhoto(photoId: string) {
    try {
      await apiDelete(`/api/super/promotions/landing/photos/${photoId}`);
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    }
  }

  // Swap a photo one position earlier. Simple arrow-based reordering
  // rather than drag-and-drop: the strip is small, this works on a phone,
  // and the only ordering that really matters is which photo is first
  // (it's the cover / link preview).
  async function movePhotoUp(item: LandingPageItem, photoId: string) {
    const ids = item.photos.map((p) => p.id);
    const i = ids.indexOf(photoId);
    if (i <= 0) return;
    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    try {
      await apiPost(`/api/super/promotions/landing/items/${item.id}/photos/reorder`, {
        photoIds: ids,
      });
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    }
  }

  async function addItem() {
    if (!newTitle.trim()) return;
    setAddingItem(true);
    try {
      await apiPost(`/api/super/promotions/landing/${pageId}/items`, {
        title: newTitle.trim(),
        description: newDesc.trim(),
      });
      setNewTitle("");
      setNewDesc("");
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    } finally {
      setAddingItem(false);
    }
  }

  async function saveItem(itemId: string, title: string, description: string) {
    try {
      await apiPatch(`/api/super/promotions/landing/items/${itemId}`, { title, description });
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    }
  }

  async function deleteItem(itemId: string) {
    try {
      await apiDelete(`/api/super/promotions/landing/items/${itemId}`);
      await load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
    }
  }

  async function moveItem(itemId: string, direction: "up" | "down") {
    if (!page) return;
    const idx = page.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= page.items.length) return;
    const next = [...page.items];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    setPage({ ...page, items: next });
    try {
      await apiPost(`/api/super/promotions/landing/${pageId}/items/reorder`, {
        itemIds: next.map((i) => i.id),
      });
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
      await load();
    }
  }

  /**
   * Upload one photo, with visible progress.
   *
   * An upload is three round-trips (presign, PUT to R2, confirm) and used
   * to show nothing at all until the final reload landed — on a phone
   * over cell data that reads as "the button didn't work", and invites a
   * second tap. Now a tile appears instantly showing the actual file via
   * an object URL, with a spinner over it, and is swapped for the real
   * photo once the reload completes.
   *
   * Reload is deferred until the LAST in-flight upload for this item
   * finishes — a multi-select of six photos used to fire six full page
   * reloads, each one fighting the others' renders.
   */
  async function uploadImage(itemId: string, file: File) {
    const tempId = `pending-${uploadSeqRef.current++}`;
    const previewUrl = URL.createObjectURL(file);
    inFlightRef.current[itemId] = (inFlightRef.current[itemId] ?? 0) + 1;
    setPendingUploads((prev) => ({
      ...prev,
      [itemId]: [...(prev[itemId] ?? []), { id: tempId, previewUrl }],
    }));
    try {
      const contentType = file.type || "image/jpeg";
      const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
        `/api/super/promotions/landing/${pageId}/items/${itemId}/upload-url`,
        { contentType },
      );
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: file,
      });
      if (!put.ok) throw new Error(`R2 upload failed (${put.status})`);
      await apiPost(`/api/super/promotions/landing/items/${itemId}/confirm-image`, {
        key,
        contentType,
      });
      uploadOkRef.current[itemId] = (uploadOkRef.current[itemId] ?? 0) + 1;
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? String(err) });
      // Drop just this tile — the other uploads in the batch carry on.
      URL.revokeObjectURL(previewUrl);
      setPendingUploads((prev) => ({
        ...prev,
        [itemId]: (prev[itemId] ?? []).filter((u) => u.id !== tempId),
      }));
    } finally {
      const remaining = (inFlightRef.current[itemId] ?? 1) - 1;
      inFlightRef.current[itemId] = remaining;
      if (remaining <= 0) {
        // Last one home: fetch the real photos, THEN clear the pending
        // tiles. Clearing first would blink the strip empty in between.
        await load();
        setPendingUploads((prev) => {
          (prev[itemId] ?? []).forEach((u) => URL.revokeObjectURL(u.previewUrl));
          return { ...prev, [itemId]: [] };
        });
        const ok = uploadOkRef.current[itemId] ?? 0;
        uploadOkRef.current[itemId] = 0;
        if (ok > 0) {
          publishInlineMessage({
            type: "SUCCESS",
            text: `${ok} photo${ok === 1 ? "" : "s"} added.`,
          });
        }
      }
    }
  }

  if (loading) {
    return <HStack><Spinner size="sm" /><Text fontSize="xs">Loading landing page…</Text></HStack>;
  }
  if (!page) {
    return (
      <Box p={3} bg="red.50" borderWidth="1px" borderColor="red.200" rounded="md" fontSize="xs" color="red.900">
        Could not load landing page.
      </Box>
    );
  }

  return (
    <Card.Root variant="outline">
      <Card.Body>
        <Text fontSize="sm" fontWeight="semibold" mb={2}>Custom landing page</Text>
        <Text fontSize="2xs" color="fg.muted" mb={3}>
          The page clients actually land on:{" "}
          <Text as="span" fontFamily="mono">/promotion/{page.slug}</Text> · Views: {page.viewCount}
        </Text>
        <VStack align="stretch" gap={2}>
          <Box>
            <Text fontSize="2xs" fontWeight="semibold" mb={1}>
              Landing page address{" "}
              {slugEditable ? "" : page?.slugLocked
                ? `(locked — ${page.shippedDeliveryCount} ${page.shippedDeliveryCount === 1 ? "delivery" : "deliveries"} already sent with this URL)`
                : "(locked)"}
            </Text>
            {/* The /promotion/ prefix renders inline rather than living only
                in the "Public URL" line above. Two slug-shaped fields in one
                dialog (this and the Short link code) previously read as the
                same setting — showing each one's URL shape at the point of
                entry is what distinguishes them. */}
            <HStack gap={0} align="stretch">
              <Box
                px={2}
                display="flex"
                alignItems="center"
                fontSize="xs"
                fontFamily="mono"
                color="fg.muted"
                bg="gray.100"
                borderWidth="1px"
                borderRightWidth={0}
                borderColor="gray.200"
                borderLeftRadius="md"
                flexShrink={0}
              >
                /promotion/
              </Box>
              <Input
                size="sm"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={!slugEditable}
                fontFamily="mono"
                borderLeftRadius={0}
              />
            </HStack>
          </Box>
          <Box>
            <Text fontSize="2xs" fontWeight="semibold" mb={1}>Headline (optional)</Text>
            <Input size="sm" value={headline} onChange={(e) => setHeadline(e.target.value)} disabled={!contentEditable} />
          </Box>
          <Box>
            <Text fontSize="2xs" fontWeight="semibold" mb={1}>Intro paragraph (Markdown OK)</Text>
            <Textarea size="sm" rows={2} value={intro} onChange={(e) => setIntro(e.target.value)} disabled={!contentEditable} />
          </Box>
          {contentEditable && (
            <HStack>
              <Button size="xs" onClick={() => void saveMeta()} loading={savingMeta}>
                Save {slugEditable ? "address / headline / intro" : "headline / intro"}
              </Button>
            </HStack>
          )}
        </VStack>

        <Text fontSize="xs" fontWeight="semibold" mt={4} mb={2}>Items ({page.items.length})</Text>
        <VStack align="stretch" gap={2}>
          {page.items.map((item, idx) => (
            <LandingItemRow
              key={item.id}
              item={item}
              editable={contentEditable}
              onSave={(t, d) => void saveItem(item.id, t, d)}
              onDelete={() => void deleteItem(item.id)}
              onUpload={(f) => void uploadImage(item.id, f)}
              pendingUploads={pendingUploads[item.id] ?? []}
              onDeletePhoto={(photoId) => void deletePhoto(photoId)}
              onMovePhotoUp={(photoId) => void movePhotoUp(item, photoId)}
              onMoveUp={idx > 0 ? () => void moveItem(item.id, "up") : undefined}
              onMoveDown={idx < page.items.length - 1 ? () => void moveItem(item.id, "down") : undefined}
            />
          ))}
          {contentEditable && (
            <Card.Root variant="outline" p={3}>
              <Text fontSize="xs" fontWeight="semibold" mb={1}>+ Add item</Text>
              <VStack align="stretch" gap={2}>
                <Input size="sm" placeholder="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                <Textarea size="sm" rows={2} placeholder="Description (Markdown)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                <HStack>
                  <Button size="xs" colorPalette="blue" onClick={() => void addItem()} loading={addingItem} disabled={!newTitle.trim()}>
                    Add item
                  </Button>
                </HStack>
              </VStack>
            </Card.Root>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function LandingItemRow({
  item, editable, onSave, onDelete, onUpload, pendingUploads, onDeletePhoto, onMovePhotoUp, onMoveUp, onMoveDown,
}: {
  item: LandingPageItem;
  editable: boolean;
  /** Photos mid-upload — rendered as spinner-overlaid tiles after the
   *  saved ones so the strip reflects the final order as it fills in. */
  pendingUploads: { id: string; previewUrl: string }[];
  onSave: (title: string, description: string) => void;
  onDelete: () => void;
  onUpload: (file: File) => void;
  onDeletePhoto: (photoId: string) => void;
  onMovePhotoUp: (photoId: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [dirty, setDirty] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setTitle(item.title); setDescription(item.description); setDirty(false); }, [item.id, item.title, item.description]);

  return (
    <Card.Root variant="outline" p={3}>
      <HStack align="start" gap={3}>
        {/* Photo strip — existing photos, then an "Add" tile. Wraps, so
            an item with many photos grows downward instead of squeezing
            the text column. */}
        <Box flexShrink={0} w="160px">
          <HStack gap={1} wrap="wrap">
            {item.photos.map((ph, idx) => (
              <Box
                key={ph.id}
                position="relative"
                w="48px"
                h="48px"
                bg="gray.100"
                rounded="md"
                overflow="hidden"
                role="group"
              >
                {ph.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ph.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                )}
                {/* First photo is what link previews use — label it so the
                    operator knows reordering has a consequence. */}
                {idx === 0 && (
                  <Box position="absolute" bottom="0" left="0" right="0" bg="blackAlpha.600" px={1}>
                    <Text fontSize="3xs" color="white" textAlign="center" lineHeight="1.4">Cover</Text>
                  </Box>
                )}
                {editable && (
                  <Box
                    position="absolute"
                    top="0"
                    right="0"
                    bg="blackAlpha.700"
                    color="white"
                    px={1}
                    cursor="pointer"
                    onClick={() => onDeletePhoto(ph.id)}
                    title="Remove this photo"
                  >
                    <Text fontSize="2xs" lineHeight="1.4">×</Text>
                  </Box>
                )}
                {editable && idx > 0 && (
                  <Box
                    position="absolute"
                    top="0"
                    left="0"
                    bg="blackAlpha.700"
                    color="white"
                    px={1}
                    cursor="pointer"
                    onClick={() => onMovePhotoUp(ph.id)}
                    title="Move earlier"
                  >
                    <Text fontSize="2xs" lineHeight="1.4">‹</Text>
                  </Box>
                )}
              </Box>
            ))}
            {pendingUploads.map((u) => (
              <Box
                key={u.id}
                position="relative"
                w="48px"
                h="48px"
                bg="gray.100"
                rounded="md"
                overflow="hidden"
              >
                {/* The real file, shown immediately from an object URL —
                    dimmed so it reads as not-yet-saved. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u.previewUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.45 }}
                />
                <Box
                  position="absolute"
                  inset="0"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                >
                  <Spinner size="sm" color="blue.600" />
                </Box>
              </Box>
            ))}
            {editable && (
              <Box
                w="48px"
                h="48px"
                bg="yellow.50"
                borderWidth="1px"
                borderStyle="dashed"
                borderColor="yellow.400"
                rounded="md"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                color="yellow.700"
                onClick={() => fileInputRef.current?.click()}
                title="Add a photo"
              >
                <Text fontSize="lg" lineHeight="1">+</Text>
              </Box>
            )}
            {!editable && item.photos.length === 0 && pendingUploads.length === 0 && (
              <Text fontSize="2xs" color="fg.muted">No photos</Text>
            )}
          </HStack>
          {pendingUploads.length > 0 && (
            <Text fontSize="2xs" color="blue.600" mt={1}>
              Uploading {pendingUploads.length} photo{pendingUploads.length === 1 ? "" : "s"}…
            </Text>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              // Multi-select: upload every file the operator picked.
              const files = Array.from(e.target.files ?? []);
              files.forEach((f) => onUpload(f));
              e.target.value = "";
            }}
          />
        </Box>
        <Box flex="1">
          <VStack align="stretch" gap={2}>
            <Input size="sm" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} disabled={!editable} />
            <Textarea size="sm" rows={2} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} disabled={!editable} />
            {editable && (
              <HStack gap={1} wrap="wrap">
                {dirty && (
                  <Button size="xs" colorPalette="blue" onClick={() => { onSave(title.trim(), description.trim()); setDirty(false); }}>
                    Save
                  </Button>
                )}
                {/* "Add", never "Replace" — uploads append now. */}
                <Button size="xs" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                  {item.photos.length > 0 ? "Add photos" : "Upload photos"}
                </Button>
                {onMoveUp && <Button size="xs" variant="ghost" onClick={onMoveUp}>↑</Button>}
                {onMoveDown && <Button size="xs" variant="ghost" onClick={onMoveDown}>↓</Button>}
                <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmDel(true)}>Remove</Button>
              </HStack>
            )}
          </VStack>
        </Box>
      </HStack>
      <ConfirmDialog
        open={confirmDel}
        title="Remove this item?"
        message="The item and its uploaded image will be deleted permanently."
        confirmLabel="Remove"
        confirmColorPalette="red"
        onConfirm={() => { onDelete(); setConfirmDel(false); }}
        onCancel={() => setConfirmDel(false)}
      />
    </Card.Root>
  );
}

// Standalone landing-page editor dialog — opens independently of the
// full PromotionEditor. Available in any state except CLOSED, so
// operators can edit landing-page content (items, headline, intro)
// while the promotion is ACTIVE. The slug stays locked once out of
// DRAFT so shipped URLs don't break.
function StandaloneLandingPageDialog({
  promoId, pageId, status, onClose,
}: {
  promoId: string;
  pageId: string;
  status: PromotionStatus;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="2xl" mx={4}>
            <Dialog.Header>
              <Dialog.Title>Edit landing page</Dialog.Title>
              {status === "ACTIVE" && (
                <Text fontSize="xs" color="fg.muted" mt={1}>
                  Editing while active — changes go live immediately for anyone
                  who clicks the promo link. The URL slug stays editable until
                  the first delivery ships, then locks for good.
                </Text>
              )}
            </Dialog.Header>
            <Dialog.Body maxH="70vh" overflowY="auto">
              <LandingPageEditor
                pageId={pageId}
                promoId={promoId}
                promotionStatus={status}
              />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

