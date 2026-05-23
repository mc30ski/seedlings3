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
  Switch,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Mail, MessageSquare, Search, X } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type RecipientUser = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  isApproved?: boolean;
  roles?: { role: string }[];
};

type Template = {
  id: string;
  name: string;
  title?: string | null;
  body: string;
  sortOrder: number;
};

type SendSummary = {
  totalRecipients: number;
  smsSent: number;
  emailSent: number;
  pushDelivered: number;
  failed: number;
};

type HistoryEntry = {
  id: string;
  createdAt: string;
  actor?: { id: string; displayName?: string | null; firstName?: string | null; lastName?: string | null } | null;
  metadata: any;
};

export default function AdminNotifyTab() {
  // ── Recipients & directory ─────────────────────────────────────
  const [users, setUsers] = useState<RecipientUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  // "all" = Everyone (default). Otherwise a list of selected user IDs.
  const [recipients, setRecipients] = useState<"all" | string[]>("all");
  const [search, setSearch] = useState("");

  // ── Compose ────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pushOnly, setPushOnly] = useState(false);
  // Additional delivery channel: post the message as a persistent banner on
  // each recipient's Worker Home tab. Stays visible until they individually
  // dismiss it. Independent of push — they can be sent together or alone.
  const [postBanner, setPostBanner] = useState(false);

  // ── Templates ──────────────────────────────────────────────────
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);

  // ── Preview / Send state ───────────────────────────────────────
  const [previewMode, setPreviewMode] = useState(false);
  const [sending, setSending] = useState(false);

  // ── History ────────────────────────────────────────────────────
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const HISTORY_INITIAL = 1;
  const HISTORY_PAGE = 5;

  // ── Loaders ────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const list = await apiGet<RecipientUser[]>("/api/admin/users?approved=true");
      setUsers(Array.isArray(list) ? list : []);
    } catch {
      setUsers([]);
    }
    setLoadingUsers(false);
  }
  async function loadTemplates() {
    try {
      const list = await apiGet<Template[]>("/api/admin/notification-templates");
      setTemplates(Array.isArray(list) ? list : []);
    } catch {
      setTemplates([]);
    }
  }
  async function loadHistory() {
    setLoadingHistory(true);
    try {
      const r = await apiGet<{ items: HistoryEntry[]; total: number }>(`/api/admin/notify/history?page=1&pageSize=${HISTORY_INITIAL}`);
      setHistory(Array.isArray(r?.items) ? r.items : []);
      setHistoryTotal(typeof r?.total === "number" ? r.total : 0);
    } catch {
      setHistory([]);
      setHistoryTotal(0);
    }
    setLoadingHistory(false);
  }

  async function loadMoreHistory() {
    setLoadingMore(true);
    try {
      // Server uses 1-indexed pages with a fixed pageSize. Since we already
      // loaded a different-sized first page (1 item), use offset-style by
      // requesting larger pages and slicing locally — simplest is to refetch
      // a single combined page sized to (current + HISTORY_PAGE).
      const want = history.length + HISTORY_PAGE;
      const r = await apiGet<{ items: HistoryEntry[]; total: number }>(`/api/admin/notify/history?page=1&pageSize=${want}`);
      setHistory(Array.isArray(r?.items) ? r.items : []);
      setHistoryTotal(typeof r?.total === "number" ? r.total : 0);
    } catch {
      // ignore
    }
    setLoadingMore(false);
  }

  useEffect(() => { void loadUsers(); void loadTemplates(); void loadHistory(); }, []);

  // ── Derived ───────────────────────────────────────────────────
  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const name = (u.displayName || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [users, search]);

  const selectedIds = useMemo(() => {
    if (recipients === "all") return users.map((u) => u.id);
    return recipients;
  }, [recipients, users]);

  // Channel projection — for the preview/cost summary. Conservative: assume
  // SMS goes to anyone with a phone, email goes to anyone with email; push
  // counts users currently in the directory (server returns actual delivered
  // count). This is an UPPER BOUND used for cost preview, not a guarantee.
  const channelProjection = useMemo(() => {
    const targets = users.filter((u) => selectedIds.includes(u.id));
    if (pushOnly) {
      return { recipients: targets.length, sms: 0, email: 0, push: targets.length };
    }
    let sms = 0, email = 0;
    for (const u of targets) {
      if (u.phone) sms++; else if (u.email) email++;
    }
    return { recipients: targets.length, sms, email, push: targets.length };
  }, [users, selectedIds, pushOnly]);

  // ── Actions ───────────────────────────────────────────────────
  function applyTemplate(id: string) {
    if (id === "") {
      // No template — leave the body alone.
      return;
    }
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title || "");
    setBody(t.body);
  }

  async function send() {
    if (!body.trim()) return;
    setSending(true);
    try {
      const payload = {
        userIds: recipients === "all" ? "all" : recipients,
        title: title.trim() || undefined,
        body: body.trim(),
        channels: pushOnly ? ["push"] : undefined,
      };
      const r = await apiPost<{ ok: boolean; summary: SendSummary }>("/api/admin/notify", payload);
      const s = r.summary;
      const parts = [
        `${s.totalRecipients} recipient${s.totalRecipients === 1 ? "" : "s"}`,
        s.smsSent > 0 ? `${s.smsSent} SMS` : null,
        s.emailSent > 0 ? `${s.emailSent} email${s.emailSent === 1 ? "" : "s"}` : null,
        s.pushDelivered > 0 ? `${s.pushDelivered} push` : null,
        s.failed > 0 ? `${s.failed} failed` : null,
      ].filter(Boolean).join(", ");

      // If the admin opted in to a home banner alongside the message, post
      // it as a second action. Failure here is reported separately so the
      // primary send still counts as "delivered" if the banner errors.
      let bannerNote = "";
      if (postBanner) {
        try {
          const everyone = recipients === "all";
          await apiPost<{ recipientCount: number }>("/api/admin/banners", {
            title: title.trim() || undefined,
            body: body.trim(),
            ...(everyone ? { everyone: true } : { userIds: recipients }),
          });
          bannerNote = " · banner posted";
        } catch (err) {
          bannerNote = " · banner failed";
          publishInlineMessage({
            type: "ERROR",
            text: getErrorMessage("Banner failed to post.", err),
          });
        }
      }

      publishInlineMessage({ type: "SUCCESS", text: `Sent — ${parts}${bannerNote}.` });
      setPreviewMode(false);
      setBody("");
      setTitle("");
      void loadHistory();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Send failed.", err) });
    } finally {
      setSending(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <Box w="full">
      <VStack align="stretch" gap={4}>
        {/* Compose / Preview Card */}
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <Text fontWeight="semibold">{previewMode ? "Preview & send" : "Compose notification"}</Text>
          </Card.Header>
          <Card.Body py="3" px="3">
            {previewMode ? (
              <PreviewView
                projection={channelProjection}
                title={title}
                body={body}
                pushOnly={pushOnly}
                onBack={() => setPreviewMode(false)}
                onSend={send}
                sending={sending}
              />
            ) : (
              <ComposeView
                users={users}
                loadingUsers={loadingUsers}
                filteredUsers={filteredUsers}
                recipients={recipients}
                setRecipients={setRecipients}
                search={search}
                setSearch={setSearch}
                templates={templates}
                onApplyTemplate={applyTemplate}
                onManageTemplates={() => setShowTemplateManager(true)}
                title={title}
                setTitle={setTitle}
                body={body}
                setBody={setBody}
                pushOnly={pushOnly}
                setPushOnly={setPushOnly}
                postBanner={postBanner}
                setPostBanner={setPostBanner}
                onPreview={() => setPreviewMode(true)}
              />
            )}
          </Card.Body>
        </Card.Root>

        {/* History */}
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <HStack justify="space-between">
              <Text fontWeight="semibold">Recent sends {historyTotal > 0 ? `(${history.length} of ${historyTotal})` : ""}</Text>
              <Button size="xs" variant="ghost" onClick={() => void loadHistory()}>Refresh</Button>
            </HStack>
          </Card.Header>
          <Card.Body py="2" px="3">
            <VStack align="stretch" gap={2}>
              <HistoryView entries={history} loading={loadingHistory} userMap={users} />
              {!loadingHistory && history.length < historyTotal && (
                <HStack justify="center">
                  <Button size="xs" variant="outline" loading={loadingMore} onClick={() => void loadMoreHistory()}>
                    Load {Math.min(HISTORY_PAGE, historyTotal - history.length)} more
                  </Button>
                </HStack>
              )}
            </VStack>
          </Card.Body>
        </Card.Root>
      </VStack>

      {showTemplateManager && (
        <TemplateManager
          templates={templates}
          onClose={() => setShowTemplateManager(false)}
          onChanged={loadTemplates}
        />
      )}
    </Box>
  );
}

// ── Compose subview ────────────────────────────────────────────────
function ComposeView(props: {
  users: RecipientUser[];
  loadingUsers: boolean;
  filteredUsers: RecipientUser[];
  recipients: "all" | string[];
  setRecipients: (v: "all" | string[]) => void;
  search: string;
  setSearch: (s: string) => void;
  templates: Template[];
  onApplyTemplate: (id: string) => void;
  onManageTemplates: () => void;
  title: string;
  setTitle: (s: string) => void;
  body: string;
  setBody: (s: string) => void;
  pushOnly: boolean;
  setPushOnly: (b: boolean) => void;
  postBanner: boolean;
  setPostBanner: (b: boolean) => void;
  onPreview: () => void;
}) {
  const { users, loadingUsers, filteredUsers, recipients, setRecipients, search, setSearch,
    templates, onApplyTemplate, onManageTemplates, title, setTitle, body, setBody, pushOnly, setPushOnly, postBanner, setPostBanner, onPreview } = props;

  const isAll = recipients === "all";
  const selectedSet = isAll ? new Set(users.map((u) => u.id)) : new Set(recipients);
  const totalSelected = isAll ? users.length : (recipients as string[]).length;

  const toggleUser = (id: string) => {
    if (isAll) {
      // First click off "all" → start with everyone selected MINUS clicked id.
      const start = users.map((u) => u.id).filter((x) => x !== id);
      setRecipients(start);
    } else {
      const next = (recipients as string[]).slice();
      const idx = next.indexOf(id);
      if (idx >= 0) next.splice(idx, 1); else next.push(id);
      setRecipients(next);
    }
  };

  return (
    <VStack align="stretch" gap={3}>
      {/* Recipients */}
      <Box>
        <Text fontSize="xs" color="fg.muted" mb={1}>Recipients</Text>
        <HStack gap={2} mb={2}>
          <Button
            size="xs"
            variant={isAll ? "solid" : "outline"}
            colorPalette={isAll ? "blue" : "gray"}
            onClick={() => setRecipients("all")}
          >
            Everyone ({users.length})
          </Button>
          <Button
            size="xs"
            variant={!isAll ? "solid" : "outline"}
            colorPalette={!isAll ? "blue" : "gray"}
            onClick={() => setRecipients([])}
          >
            Pick specific
          </Button>
          {!isAll && (
            <Text fontSize="xs" color="fg.muted">
              {(recipients as string[]).length} selected
            </Text>
          )}
        </HStack>

        {!isAll && (
          <Box borderWidth="1px" borderRadius="md" p={2} bg="bg.subtle">
            <HStack gap={2} mb={2}>
              <Box flex={1} display="flex" alignItems="center" borderWidth="1px" borderRadius="md" px={2} bg="white">
                <Search size={14} />
                <Input
                  variant="outline"
                  size="sm"
                  border="none"
                  pl={2}
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </Box>
              <Button size="xs" variant="ghost" onClick={() => setRecipients(users.map((u) => u.id))}>Select all</Button>
              <Button size="xs" variant="ghost" onClick={() => setRecipients([])}>Clear</Button>
            </HStack>
            {loadingUsers ? (
              <Spinner size="sm" />
            ) : (
              <VStack align="stretch" gap={1} maxH="220px" overflowY="auto">
                {filteredUsers.map((u) => {
                  const checked = selectedSet.has(u.id);
                  const isAdmin = (u.roles ?? []).some((r) => r.role === "ADMIN" || r.role === "SUPER");
                  return (
                    <HStack
                      key={u.id}
                      px={2} py={1.5}
                      borderRadius="md"
                      cursor="pointer"
                      bg={checked ? "blue.50" : undefined}
                      _hover={{ bg: checked ? "blue.100" : "gray.50" }}
                      onClick={() => toggleUser(u.id)}
                    >
                      <input type="checkbox" readOnly checked={checked} />
                      <Text fontSize="sm" flex={1}>{u.displayName || u.email || u.id}</Text>
                      {isAdmin && <Badge size="sm" colorPalette="purple">Admin</Badge>}
                      <Box color="fg.muted" display="flex" alignItems="center" title={u.phone ? "SMS-capable" : u.email ? "Email only" : "No contact method"}>
                        {u.phone ? <MessageSquare size={12} /> : u.email ? <Mail size={12} /> : null}
                      </Box>
                    </HStack>
                  );
                })}
                {filteredUsers.length === 0 && (
                  <Text fontSize="xs" color="fg.muted" textAlign="center" py={2}>No matches.</Text>
                )}
              </VStack>
            )}
          </Box>
        )}
        <Text fontSize="xs" color="fg.muted" mt={1}>
          {totalSelected === 0 ? "No recipients selected" : `${totalSelected} recipient${totalSelected === 1 ? "" : "s"}`}
        </Text>
      </Box>

      {/* Template picker */}
      <Box>
        <HStack justify="space-between" mb={1}>
          <Text fontSize="xs" color="fg.muted">Template (optional)</Text>
          <Button size="xs" variant="ghost" onClick={onManageTemplates}>Manage templates</Button>
        </HStack>
        <TemplateSelect templates={templates} onApply={onApplyTemplate} />
      </Box>

      {/* Title */}
      <Box>
        <Text fontSize="xs" color="fg.muted" mb={1}>Title (optional)</Text>
        <Input
          size="sm"
          placeholder="Seedlings — message from admin"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Box>

      {/* Body */}
      <Box>
        <HStack justify="space-between" mb={1}>
          <Text fontSize="xs" color="fg.muted">Message *</Text>
          <Text fontSize="xs" color={body.length > 160 ? "yellow.700" : "fg.muted"}>{body.length} chars</Text>
        </HStack>
        <Textarea
          size="sm"
          placeholder="What do you want to tell the team?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
        />
        {body.length > 160 && (
          <Text fontSize="xs" color="yellow.700" mt={1}>
            Over 160 characters — Twilio will split into multiple SMS segments (each costs separately).
          </Text>
        )}
      </Box>

      {/* Push-only toggle */}
      <HStack justify="space-between" align="center">
        <Box>
          <Text fontSize="sm" fontWeight="semibold">Push-only</Text>
          <Text fontSize="xs" color="fg.muted">Skip SMS + email. Free, but only reaches users with notifications enabled.</Text>
        </Box>
        <Switch.Root checked={pushOnly} onCheckedChange={(d: any) => setPushOnly(!!d.checked)} colorPalette="blue">
          <Switch.HiddenInput />
          <Switch.Control />
        </Switch.Root>
      </HStack>

      {/* Home-banner toggle — posts a sticky message on the Worker Home tab
          for each recipient. They individually dismiss it. */}
      <HStack justify="space-between" align="center">
        <Box>
          <Text fontSize="sm" fontWeight="semibold">Also post home banner</Text>
          <Text fontSize="xs" color="fg.muted">Sticky message at the top of each recipient&apos;s Worker Home tab until they dismiss it.</Text>
        </Box>
        <Switch.Root checked={postBanner} onCheckedChange={(d: any) => setPostBanner(!!d.checked)} colorPalette="blue">
          <Switch.HiddenInput />
          <Switch.Control />
        </Switch.Root>
      </HStack>

      {/* Submit */}
      <HStack justify="flex-end">
        <Button
          size="sm"
          colorPalette="blue"
          disabled={!body.trim() || totalSelected === 0}
          onClick={onPreview}
        >
          Preview & send →
        </Button>
      </HStack>
    </VStack>
  );
}

// ── Template select (Chakra v3 Select.Root) ──────────────────────
function TemplateSelect({ templates, onApply }: { templates: Template[]; onApply: (id: string) => void }) {
  const items = useMemo(
    () => templates.map((t) => ({ label: t.name, value: t.id })),
    [templates],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  return (
    <Select.Root
      collection={collection}
      value={[]}
      onValueChange={(e) => {
        const v = e.value?.[0];
        if (v) onApply(v);
      }}
      size="sm"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
    >
      <Select.Control>
        <Select.Trigger w="full">
          <Select.ValueText placeholder={items.length === 0 ? "No templates yet" : "Select to fill from a template"} />
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content>
          {items.map((it) => (
            <Select.Item key={it.value} item={it.value}>
              <Select.ItemText>{it.label}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  );
}

// ── Preview subview ───────────────────────────────────────────────
function PreviewView(props: {
  projection: { recipients: number; sms: number; email: number; push: number };
  title: string;
  body: string;
  pushOnly: boolean;
  onBack: () => void;
  onSend: () => void;
  sending: boolean;
}) {
  const { projection, title, body, pushOnly, onBack, onSend, sending } = props;
  return (
    <VStack align="stretch" gap={3}>
      <Box p={3} borderWidth="1px" borderRadius="md" bg="blue.50" borderColor="blue.200">
        <Text fontSize="sm" fontWeight="semibold">Sending to {projection.recipients} recipient{projection.recipients === 1 ? "" : "s"}</Text>
        <VStack align="start" gap={0.5} mt={1} fontSize="xs" color="blue.900">
          {!pushOnly && projection.sms > 0 && <Text>• {projection.sms} SMS</Text>}
          {!pushOnly && projection.email > 0 && <Text>• {projection.email} email{projection.email === 1 ? "" : "s"}</Text>}
          {projection.push > 0 && <Text>• up to {projection.push} push</Text>}
          {pushOnly && <Text fontStyle="italic">Push-only — SMS and email skipped.</Text>}
        </VStack>
      </Box>

      <Box p={3} borderWidth="1px" borderRadius="md">
        <Text fontSize="xs" color="fg.muted" mb={1}>Title</Text>
        <Text fontSize="sm" fontWeight="semibold" mb={2}>{title || "Seedlings — message from admin"}</Text>
        <Text fontSize="xs" color="fg.muted" mb={1}>Message</Text>
        <Text fontSize="sm" whiteSpace="pre-wrap">{body}</Text>
        <Text fontSize="xs" color="fg.muted" mt={2}>
          A "— [your name]" footer will be appended automatically.
        </Text>
      </Box>

      <HStack justify="space-between">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={sending}>← Back</Button>
        <Button size="sm" colorPalette="green" loading={sending} onClick={onSend}>Send</Button>
      </HStack>
    </VStack>
  );
}

// ── History subview ───────────────────────────────────────────────
function HistoryView(props: { entries: HistoryEntry[]; loading: boolean; userMap: RecipientUser[] }) {
  const { entries, loading, userMap } = props;
  if (loading) return <Spinner size="sm" />;
  if (entries.length === 0) return <Text fontSize="xs" color="fg.muted">No notifications sent yet.</Text>;
  const nameById = (id: string) => userMap.find((u) => u.id === id)?.displayName || id.slice(-6);
  return (
    <VStack align="stretch" gap={2}>
      {entries.map((e) => {
        const m = e.metadata || {};
        const recipientIds = (m.recipientUserIds || []) as string[];
        const summary = m.summary || {};
        const senderName = e.actor?.displayName
          || [e.actor?.firstName, e.actor?.lastName].filter(Boolean).join(" ").trim()
          || "Admin";
        return (
          <Box key={e.id} p={2} borderWidth="1px" borderRadius="md" fontSize="xs">
            <HStack justify="space-between" mb={1} flexWrap="wrap">
              <Text fontWeight="semibold">{m.title || "Untitled"}</Text>
              <Text color="fg.muted">{new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Text>
            </HStack>
            <Text whiteSpace="pre-wrap" mb={1}>{m.body || ""}</Text>
            <HStack flexWrap="wrap" gap={1.5} color="fg.muted">
              <Text>Sent by {senderName}</Text>
              <Text>·</Text>
              <Text>{recipientIds.length} recipient{recipientIds.length === 1 ? "" : "s"}</Text>
              {summary.smsSent > 0 && <><Text>·</Text><Text>{summary.smsSent} SMS</Text></>}
              {summary.emailSent > 0 && <><Text>·</Text><Text>{summary.emailSent} email</Text></>}
              {summary.pushDelivered > 0 && <><Text>·</Text><Text>{summary.pushDelivered} push</Text></>}
              {summary.failed > 0 && <><Text>·</Text><Text color="red.600">{summary.failed} failed</Text></>}
            </HStack>
            {recipientIds.length > 0 && recipientIds.length <= 6 && (
              <Text mt={1} color="fg.muted">→ {recipientIds.map(nameById).join(", ")}</Text>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}

// ── Template manager modal ────────────────────────────────────────
function TemplateManager(props: { templates: Template[]; onClose: () => void; onChanged: () => Promise<void> | void }) {
  const { templates, onClose, onChanged } = props;
  const [editing, setEditing] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);

  function startNew() {
    setEditing({ id: "", name: "", title: "", body: "", sortOrder: 100 });
    setName("");
    setTitle("");
    setBody("");
  }

  function startEdit(t: Template) {
    setEditing(t);
    setName(t.name);
    setTitle(t.title || "");
    setBody(t.body);
  }

  async function save() {
    if (!editing) return;
    if (!name.trim() || !body.trim()) return;
    setSaving(true);
    try {
      if (editing.id) {
        await apiPatch(`/api/admin/notification-templates/${editing.id}`, { name: name.trim(), title: title.trim() || null, body: body.trim() });
      } else {
        await apiPost("/api/admin/notification-templates", { name: name.trim(), title: title.trim() || null, body: body.trim() });
      }
      await onChanged();
      setEditing(null);
      publishInlineMessage({ type: "SUCCESS", text: "Template saved." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiDelete(`/api/admin/notification-templates/${id}`);
      await onChanged();
      publishInlineMessage({ type: "SUCCESS", text: "Template deleted." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  return (
    <>
    <Box position="fixed" inset={0} bg="rgba(0,0,0,0.4)" zIndex={1000} display="flex" alignItems="center" justifyContent="center" p={4}>
      <Box bg="white" borderRadius="md" p={4} maxW="600px" w="full" maxH="90vh" overflowY="auto" boxShadow="lg">
        <HStack justify="space-between" mb={3}>
          <Text fontWeight="semibold">Manage templates</Text>
          <Button size="xs" variant="ghost" onClick={onClose}><X size={14} /></Button>
        </HStack>
        {editing ? (
          <VStack align="stretch" gap={2}>
            <Text fontSize="xs" color="fg.muted">{editing.id ? "Edit template" : "New template"}</Text>
            <Box>
              <Text fontSize="xs" color="fg.muted" mb={1}>Name *</Text>
              <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cancelled — weather" />
            </Box>
            <Box>
              <Text fontSize="xs" color="fg.muted" mb={1}>Title (optional)</Text>
              <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Push notification title" />
            </Box>
            <Box>
              <Text fontSize="xs" color="fg.muted" mb={1}>Body *</Text>
              <Textarea size="sm" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
            </Box>
            <HStack justify="flex-end" gap={2}>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" colorPalette="blue" loading={saving} disabled={!name.trim() || !body.trim()} onClick={save}>Save</Button>
            </HStack>
          </VStack>
        ) : (
          <VStack align="stretch" gap={2}>
            <HStack justify="flex-end">
              <Button size="xs" colorPalette="blue" onClick={startNew}>+ New template</Button>
            </HStack>
            {templates.length === 0 ? (
              <Text fontSize="xs" color="fg.muted" textAlign="center" py={3}>No templates yet.</Text>
            ) : (
              templates.map((t) => (
                <Box key={t.id} p={2} borderWidth="1px" borderRadius="md">
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={0.5} flex={1} minW={0}>
                      <Text fontSize="sm" fontWeight="semibold">{t.name}</Text>
                      {t.title && <Text fontSize="xs" color="fg.muted">Title: {t.title}</Text>}
                      <Text fontSize="xs" whiteSpace="pre-wrap">{t.body}</Text>
                    </VStack>
                    <VStack gap={1}>
                      <Button size="xs" variant="ghost" onClick={() => startEdit(t)}>Edit</Button>
                      <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmDelete(t)}>Delete</Button>
                    </VStack>
                  </HStack>
                </Box>
              ))
            )}
          </VStack>
        )}
      </Box>
    </Box>
    <ConfirmDialog
      open={!!confirmDelete}
      title="Delete template?"
      message={confirmDelete ? `Delete "${confirmDelete.name}"? This cannot be undone.` : ""}
      confirmLabel="Delete"
      confirmColorPalette="red"
      onConfirm={async () => {
        const t = confirmDelete;
        setConfirmDelete(null);
        if (t) await remove(t.id);
      }}
      onCancel={() => setConfirmDelete(null)}
    />
    </>
  );
}
