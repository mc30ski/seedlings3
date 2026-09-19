"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spacer,
  Text,
  VStack,
  Select,
  Icon,
  Spinner,
  createListCollection,
} from "@chakra-ui/react";
import { Filter, LayoutList, Link2, Mail, MessageCircle, PauseCircle, Plus, RefreshCw, Star, Tag, Wrench, X } from "lucide-react";
import { prettyStatus, clientLabel } from "@/src/lib/labels";
import { determineRoles } from "@/src/lib/roles";
import { clientStatusColor } from "@/src/lib/statusColors";
import {
  type TabPropsType,
  type Client,
  type Contact,
  CLIENT_KIND,
  CLIENT_STATUS,
} from "@/src/lib/types";
import { doAction, doDelete } from "@/src/lib/services";
import { openEventSearch, onEventSearchRun } from "@/src/lib/bus";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import ClientDialog from "@/src/ui/dialogs/ClientDialog";
import ViewAsClientButton from "@/src/ui/components/ViewAsClientButton";
import ContactDialog from "@/src/ui/dialogs/ContactDialog";
import UnlinkedClientAccountsSection from "@/src/ui/components/UnlinkedClientAccountsSection";
import ClientContactLinkActions from "@/src/ui/components/ClientContactLinkActions";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import TruncatedText from "@/src/ui/components/TruncatedText";
import { apiGet, apiDelete, apiPost } from "@/src/lib/api";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import { parseAdminTags, adminTagLabel, adminTagColor, ADMIN_TAGS } from "@/src/ui/components/AdminTagPicker";
import { MailLink, CallLink, MapLink } from "@/src/ui/helpers/Link";
import { FiStar, FiMapPin, FiUsers } from "react-icons/fi";
import { Dashboard } from "@/src/ui/components/Dashboard";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...CLIENT_KIND] as const;

// Constant representing the status states for this entity.

type ClientsTabProps = TabPropsType & {
  /** Additive scope — capabilities ADD as you climb the ladder.
   *  scope.isWorker → worker-only affordances (currently none unique
   *  to Clients; kept for parity with the Inventory/Vehicles pattern).
   *  scope.isAdmin  → adds admin list endpoint + CRUD + tags + banner.
   *  scope.isSuper  → adds "View as this client" + hard-delete.
   *  Falls back to a scope derived from the legacy `purpose` prop when
   *  not passed, so mounts still on the old shape keep working. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

export default function ClientsTab({ me, purpose = "WORKER", scope }: ClientsTabProps) {
  // See PaymentsTab — same content-only + host-frames-it contract.
  const [unlinkedApi, setUnlinkedApi] = useState<{ refresh: () => void; loading: boolean; count: number } | null>(null);

  const { isSuper: hasSuperRole, isAvail, isAdmin, forAdmin } = determineRoles(me, purpose);

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from `purpose` for any callsite still on the old shape.
  const effScope = scope ?? {
    isWorker: purpose === "WORKER",
    isAdmin: purpose === "ADMIN" || purpose === "SUPER",
    isSuper: purpose === "SUPER",
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop — not by the underlying role. A user with admin+super
  // roles viewing the *Admin* tab must NOT see Super buttons (that's
  // what the Super top-tab is for). Super scope inherits Admin
  // capabilities so a super sees admin controls too.
  const showWorkerExtras = effScope.isWorker;
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper && hasSuperRole;

  const pfx = showAdminExtras ? "aclients" : "wclients";
  const isTrainee = !forAdmin && me?.workerType === "TRAINEE";
  const [traineeClientIds, setTraineeClientIds] = useState<Set<string> | null>(null);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** Which detail panel is open per client card — at most one at a time, so
   *  a card never grows two long lists at once. Replaces the two Accordions
   *  that each reserved a full-width row on every card, open or not. */
  const [openPanel, setOpenPanel] = useState<Record<string, "contacts" | "properties" | null>>({});

  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);
  const [vipOnly, setVipOnly] = useState(false);
  // "Paused services only" — narrows the list to clients with at least
  // one PAUSED Job. Not persisted (transient operator gesture — after a
  // pause action, they toggle this on to audit, then toggle it back off).
  const [pausedOnly, setPausedOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>("ALL");

  const [items, setItems] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactEditing, setContactEditing] = useState<Contact | null>(null);
  const [contactClientId, setContactClientId] = useState("");
  const [toDeleteContact, setToDeleteContact] = useState<ToDeleteProps | null>(
    null
  );

  const inputRef = useRef<HTMLInputElement>(null);

  // Helper variable to disable other buttons while actions are in flight.
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Used to create the dropdown menus.
  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: s === "ALL" ? "All Kinds" : prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  // Two client statuses exist, so this dropdown is really "which half am I
  // looking at". "ALL" is the default and now EXCLUDES archived, which makes
  // a separate "Active" entry a synonym for it — dropped rather than shipped
  // as two options that do the same thing.
  const statusItems = useMemo(
    () => [
      { label: "Active", value: "ALL" },
      { label: "Archived", value: "ARCHIVED" },
    ],
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  // Main function to load all the items from the API.
  async function load(displayLoading: boolean = true) {
    setLoading(displayLoading);
    try {
      const base = showAdminExtras ? "/api/admin/clients" : "/api/clients";
      const list: Client[] = await apiGet(base);
      setItems(
        list
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .filter((i) => showAdminExtras || i.status === "ACTIVE")
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load clients.", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Loads all the items for the first time.
  useEffect(() => {
    void load();
  }, [showAdminExtras]);

  // For trainees: fetch their assigned client IDs
  useEffect(() => {
    if (!isTrainee) { setTraineeClientIds(null); return; }
    apiGet<any[]>("/api/occurrences")
      .then((occs) => {
        const myId = me?.id;
        const ids = new Set<string>();
        for (const occ of occs) {
          if ((occ.assignees ?? []).some((a: any) => a.userId === myId)) {
            if (occ.job?.property?.client?.id) ids.add(occ.job.property.client.id);
          }
        }
        setTraineeClientIds(ids);
      })
      .catch(() => setTraineeClientIds(new Set()));
  }, [isTrainee, me?.id]);

  useEffect(() => {
    // EVERY disposer is kept and run on unmount. These were fire-and-forget:
    // the return values were dropped, so each mount added listeners that the
    // next unmount never removed. They hold this render's setQ / setHighlightId
    // in closure, so after a remount a single cross-tab jump runs the handler
    // once per historical mount, the dead ones writing into unmounted state.
    const offs = [
      onEventSearchRun("propertyTabToClientTabSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("propertyTabToClientTabContactSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("jobsTabToClientsTabSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("paymentsTabToClientsTabSearch", setQ, inputRef, setHighlightId),
    ];
    return () => { for (const off of offs) off(); };
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    // If navigated here by ID, show only that entity
    if (highlightId) {
      const exact = items.find((r) => r.id === highlightId);
      if (exact) return [exact];
    }

    // Trainees: wait for filter data before showing anything
    if (isTrainee && !traineeClientIds) return [];

    let rows = items;

    // Trainees only see clients they are assigned to
    if (isTrainee && traineeClientIds) {
      rows = rows.filter((r) => traineeClientIds.has(r.id));
    }

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.type === kind[0]);
    }

    // Filter based on entity status.
    //
    // ARCHIVED IS HIDDEN UNLESS ASKED FOR. An archived client is a closed
    // relationship — it belongs in the list you go looking for, not the one
    // you scan every day. Same shape as the Services tab's "Archived only",
    // except here the status dropdown IS that control, because ACTIVE and
    // ARCHIVED are the only two client statuses there are.
    const sf = statusFilter[0];
    if (sf === "ALL") {
      rows = rows.filter((i) => i.status !== "ARCHIVED");
    } else {
      rows = rows.filter((i) => i.status === sf);
    }

    // Filter based on free text.
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const haystack: string[] = [r.displayName || "", r.notesInternal || ""];

        // Add contact fields into the search haystack
        for (const ct of r.contacts ?? []) {
          haystack.push(
            ct.firstName || "",
            ct.lastName || "",
            `${ct.firstName || ""} ${ct.lastName || ""}`,
            ct.email || "",
            ct.phone || "",
            ct.role || ""
          );
        }

        return haystack.some((value) => value.toLowerCase().includes(qlc));
      });
    }

    if (vipOnly) {
      rows = rows.filter((r) => (r as any).isVip);
    }

    if (pausedOnly) {
      rows = rows.filter((r) => (r.pausedJobsCount ?? 0) > 0);
    }

    if (tagFilter !== "ALL") {
      rows = rows.filter((r) => parseAdminTags((r as any).adminTags).includes(tagFilter));
    }

    return rows;
  }, [items, q, kind, statusFilter, vipOnly, pausedOnly, tagFilter, highlightId, isTrainee, traineeClientIds]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(c: Client) {
    setEditing(c);
    setDialogOpen(true);
  }

  function openContactCreate(clientId: string) {
    setContactClientId(clientId);
    setContactEditing(null);
    setContactDialogOpen(true);
  }

  async function openContactEdit(clientId: string, c: Contact) {
    setContactClientId(clientId);
    setContactEditing(c);
    setContactDialogOpen(true);
  }

  async function takeAction(c: Client, action: string) {
    return await doAction(
      c,
      "Client",
      "clients",
      action,
      "displayName",
      async () => await load(false)
    );
  }

  // Archive/unarchive cascade confirmation — separate from the pause
  // path because the operator needs to see how many Properties + Jobs
  // will be affected before pulling the trigger. Preview counts come
  // from the server so the number matches what the cascade will
  // actually touch (idempotent per row, so it's a truthful "will
  // change" count).
  const [archiveClientConfirm, setArchiveClientConfirm] = useState<
    | { client: Client; propertiesToArchive: number; jobsToArchive: number }
    | null
  >(null);
  const [unarchiveClientConfirm, setUnarchiveClientConfirm] = useState<
    | { client: Client; propertiesToUnarchive: number; jobsToUnarchive: number }
    | null
  >(null);

  async function openArchiveClientConfirm(c: Client) {
    try {
      const preview = await apiGet<{ propertiesToArchive: number; jobsToArchive: number }>(
        `/api/admin/clients/${c.id}/archive-preview`,
      );
      setArchiveClientConfirm({ client: c, ...preview });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not load archive preview.", err),
      });
    }
  }

  async function openUnarchiveClientConfirm(c: Client) {
    try {
      const preview = await apiGet<{ propertiesToUnarchive: number; jobsToUnarchive: number }>(
        `/api/admin/clients/${c.id}/unarchive-preview`,
      );
      setUnarchiveClientConfirm({ client: c, ...preview });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not load unarchive preview.", err),
      });
    }
  }

  async function takeActionContact(c: Contact, action: string) {
    return await doAction(
      c,
      "Contact",
      "contacts",
      action,
      "email",
      async () => await load(false)
    );
  }

  async function deleteAction(id: string, displayName: string) {
    return await doDelete(
      id,
      "Client",
      "clients",
      displayName,
      async () => await load(false)
    );
  }

  async function deleteContact(clientId: string, contactId: string) {
    try {
      await apiDelete(`/api/admin/clients/${clientId}/contacts/${contactId}`);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Contact deleted.",
      });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete contact failed", err),
      });
    }
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading && items.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
      <Box mb={3}>
      <TabExplainer storageKey={`seedlings:clientsTab:guideOpen:${showSuperExtras ? "super" : showAdminExtras ? "admin" : "worker"}`} title="What Clients holds">
        {showSuperExtras ? (
          <>
            <ExplainerText>
              Everyone you work for, their contacts and their properties. Create and edit clients,
              archive one that has left, and <Em>pause services</Em> for a client going quiet
              without losing their history — each of those previews what it will affect first.
            </ExplainerText>
            <ExplainerText>
              Yours alone: <Em>view as a client contact</Em>, which renders the client portal
              exactly as that person sees it. It is read-only, and the fastest way to answer
              &ldquo;what does my client actually see&rdquo;.
            </ExplainerText>
          </>
        ) : showAdminExtras ? (
          <>
            <ExplainerText>
              Everyone you work for, their contacts and their properties. You can create and edit
              clients, add contacts, archive a client that has left, and <Em>pause services</Em>{" "}
              for one going quiet without losing their history.
            </ExplainerText>
            <ExplainerText>
              Archiving and pausing both <Em>show you what they will affect</Em> before you commit —
              scheduled visits, open jobs — so neither is a blind action.
            </ExplainerText>
          </>
        ) : (
          <>
            <ExplainerText>
              Who you are working for, so you know whose property you are on and who to expect.{" "}
              <Em>Read-only</Em> — clients are created and edited by an admin.
            </ExplainerText>
            <ExplainerText>
              Internal admin notes and tags are not shown here. If a client detail is wrong or you
              learn something worth recording, tell an admin.
            </ExplainerText>
          </>
        )}
      </TabExplainer>
      </Box>
      {forAdmin && (
        <Box mb={3}>
          <Dashboard
            storageKey="seedlings:clientsTab:unlinkedAccountsOpen"
            title="Unlinked client accounts"
            icon={Link2}
            variant="attention"
            count={unlinkedApi?.count ?? 0}
            forceGlow={(unlinkedApi?.count ?? 0) > 0 ? "orange" : undefined}
            onRefresh={unlinkedApi?.refresh}
            refreshing={!!unlinkedApi?.loading}
          >
            <UnlinkedClientAccountsSection onReady={setUnlinkedApi} />
          </Dashboard>
        </Box>
      )}
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-subtle)" }}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={(v) => { setQ(v); setHighlightId(null); }}
          inputId="properties-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-muted)" : "var(--chakra-colors-blue-subtle)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-strong)" : "1px solid var(--chakra-colors-blue-emphasized)", borderRadius: "6px" }}>
              <LayoutList size={14} />
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
          collection={statusCollection}
          value={statusFilter}
          onValueChange={(e) => setStatusFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-muted)" : "var(--chakra-colors-purple-subtle)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-strong)" : "1px solid var(--chakra-colors-purple-emphasized)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {forAdmin && (
          <Select.Root
            collection={createListCollection({ items: [{ label: "All Tags", value: "ALL" }, ...ADMIN_TAGS.map((t) => ({ label: t.label, value: t.id }))] })}
            value={[tagFilter]}
            onValueChange={(e) => setTagFilter(e.value[0] ?? "ALL")}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
            css={{ width: "auto", flex: "0 0 auto" }}
          >
            <Select.Control>
              <Select.Trigger w="auto" minW="0" px="2" css={{ background: tagFilter !== "ALL" ? "var(--chakra-colors-red-muted)" : "var(--chakra-colors-red-subtle)", border: tagFilter !== "ALL" ? "1px solid var(--chakra-colors-red-strong)" : "1px solid var(--chakra-colors-red-emphasized)", borderRadius: "6px" }}>
                <Tag size={14} />
                <Select.Indicator display="none" />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {[{ label: "All Tags", value: "ALL" }, ...ADMIN_TAGS.map((t) => ({ label: t.label, value: t.id }))].map((it) => (
                  <Select.Item key={it.value} item={it.value}>
                    <Select.ItemText>{it.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
        )}
        <Button
          size="sm"
          variant={vipOnly ? "solid" : "outline"}
          px="2"
          onClick={() => setVipOnly(!vipOnly)}
          css={vipOnly ? {
            background: "var(--chakra-colors-yellow-subtle)",
            color: "var(--chakra-colors-yellow-fg)",
            border: "1px solid var(--chakra-colors-yellow-strong)",
            "&:hover": { background: "var(--chakra-colors-yellow-muted)" },
          } : undefined}
        >
          <Star size={14} fill={vipOnly ? "var(--chakra-colors-yellow-500)" : "none"} color={vipOnly ? "var(--chakra-colors-yellow-500)" : undefined} />
        </Button>
        {forAdmin && (
          <Button
            size="sm"
            variant={pausedOnly ? "solid" : "outline"}
            px="2"
            onClick={() => setPausedOnly(!pausedOnly)}
            title={pausedOnly ? "Showing only clients with paused services" : "Show only clients with paused services"}
            css={pausedOnly ? {
              background: "var(--chakra-colors-yellow-subtle)",
              color: "var(--chakra-colors-yellow-fg)",
              border: "1px solid var(--chakra-colors-yellow-strong)",
              "&:hover": { background: "var(--chakra-colors-yellow-muted)" },
            } : undefined}
          >
            <PauseCircle size={14} />
          </Button>
        )}
        {forAdmin && (
          <Button
            variant="solid"
            size="sm"
            px="2"
            minW="0"
            bg="black"
            color="white"
            onClick={openCreate}
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      <HStack mb={2} gap={2} px={1} wrap="wrap">
        {(() => {
          const active = items.filter((c) => c.status === "ACTIVE").length;
          const archived = items.filter((c) => c.status === "ARCHIVED").length;
          return (
            <>
              <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">{active} Active</Badge>
              {/* Archived are hidden from the default list, so this count is
                  the only thing that says they exist. Clicking it is how you
                  get to them — a dead number next to a filter that hides
                  them would just be a puzzle. */}
              {forAdmin && archived > 0 && (
                <Badge
                  colorPalette="red"
                  variant="subtle"
                  fontSize="xs"
                  px="2"
                  borderRadius="full"
                  cursor="pointer"
                  _hover={{ opacity: 0.8 }}
                  title="Show archived clients"
                  onClick={() => setStatusFilter(["ARCHIVED"])}
                >
                  {archived} Archived &rarr;
                </Badge>
              )}
            </>
          );
        })()}
      </HStack>
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || vipOnly || pausedOnly) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="subtle">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
          {vipOnly && (
            <Badge size="sm" colorPalette="yellow" variant="subtle">
              VIP
            </Badge>
          )}
          {pausedOnly && (
            <Badge size="sm" colorPalette="yellow" variant="subtle">
              Paused services only
            </Badge>
          )}
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && !vipOnly && !pausedOnly && !q && !highlightId) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setStatusFilter(["ALL"]);
                setVipOnly(false);
                setPausedOnly(false);
                setQ("");
                setHighlightId(null);
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Box position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)" zIndex="2">
            <Spinner size="lg" />
          </Box>
        </>)}
      <VStack align="stretch" gap={3}>
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No clients or contacts match current filters.
          </Box>
        )}
        {filtered.map((c: Client) => {
          // One body, not Header + two Bodies + Footer. The card used to
          // stack a title row, a badge row, a notes block and a tags block
          // as four separate Card sections, each with its own padding, so a
          // client with nothing unusual about them still occupied four bands
          // of vertical space. Matches the InventoryTab shape now: a single
          // tight body, title and meta on two lines, and colour carried by
          // the border instead of by a row of badges.
          const activeContacts = (c.contacts ?? []).filter(
              (ct: any) => (ct.status ?? "ACTIVE") === "ACTIVE",
            );
            // NO way to reach this client — not "some contact is missing a
            // phone". See the long note this replaced: `.some` fired
            // whenever any one contact lacked comm info, which duplicated
            // the per-contact badge and cried wolf on clients who were
            // perfectly reachable via a different contact.
            const noneReachable =
              activeContacts.length === 0 ||
              activeContacts.every(
                (ct: any) => !ct.email && !ct.phone && !ct.normalizedPhone,
              );
            const isVip = !!(c as any).isVip;
            const isArchived = c.status === "ARCHIVED";
            const tags = forAdmin ? parseAdminTags((c as any).adminTags) : [];
            const paused = c.pausedJobsCount ?? 0;

            // Border does the work a badge row used to. Unreachable is the
            // only one that needs chasing, so it outranks VIP.
            const borderColor = isArchived
              ? "gray.emphasized"
              : noneReachable
                ? "red.emphasized"
                : isVip
                  ? "yellow.emphasized"
                  : "gray.emphasized";

          return (
          <Card.Root
            key={c.id}
            variant="outline"
            borderColor={borderColor}
            opacity={isArchived ? 0.75 : 1}
          >
            <Card.Body py="2" px="3">
              <VStack align="start" gap={0.5} w="full" minW={0}>
                <HStack gap={1.5} minW={0} w="full">
                  {isVip && (
                    <Text title={(c as any).vipReason || "VIP Client"} cursor="help" flexShrink={0}>
                      \u2b50
                    </Text>
                  )}
                  <Text fontSize="sm" fontWeight="semibold" minW={0} truncate>
                    {clientLabel(c.displayName)}
                  </Text>
                  {/* Status badge ONLY when archived. Every client in the
                      default list is active, so an "Active" badge on all of
                      them is a column of noise that says nothing. */}
                  {isArchived && (
                    <StatusBadge
                      status={c.status}
                      palette={clientStatusColor(c.status)}
                      variant="subtle"
                    />
                  )}
                  {noneReachable && (
                    <Badge size="xs" colorPalette="red" variant="subtle" flexShrink={0}>
                      Unreachable
                    </Badge>
                  )}
                </HStack>
                {/* Meta line — the type badge became text here, which reads
                    faster and costs no height of its own. */}
                <Text fontSize="xs" color="fg.muted">
                  {prettyStatus(c.type)}
                  {" \u00b7 "}
                  {activeContacts.length} contact{activeContacts.length === 1 ? "" : "s"}
                  {paused > 0 ? ` \u00b7 ${paused} service${paused === 1 ? "" : "s"} paused` : ""}
                </Text>
                {tags.length > 0 && (
                  <HStack gap="4px" wrap="wrap" pt={0.5}>
                    {tags.map((tag: string) => (
                      <Badge
                        key={tag}
                        size="xs"
                        variant="solid"
                        colorPalette={adminTagColor(tag)}
                        px="2"
                        borderRadius="full"
                      >
                        \u26a0 {adminTagLabel(tag)}
                      </Badge>
                    ))}
                  </HStack>
                )}
                {c.notesInternal && (
                  <Box pt={0.5} w="full" minW={0}>
                    <TruncatedText>{c.notesInternal}</TruncatedText>
                  </Box>
                )}
              </VStack>
            </Card.Body>
            <Card.Footer py="1.5" px="3" pt="1.5">
              <HStack gap={1.5} wrap="wrap" w="full">
                {forAdmin && (
                  <>
                    <StatusButton
                      id={"client-edit"}
                      itemId={c.id}
                      label={"Edit"}
                      onClick={async () => {
                        await openEdit(c);
                      }}
                      variant={"outline"}
                      disabled={loading}
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                      size="xs"
                    />
                    {/* Super-only "View as this client" — sits next to
                        Edit in the action row so operators debugging a
                        client-facing issue can reach it quickly. Three
                        gates:
                          1. `isSuper` — actor has the SUPER role.
                          2. `purpose === "SUPER"` — ClientsTab is
                             mounted under the Super shell (never the
                             admin variant).
                          3. At least one contact on this client has a
                             clerkUserId. Rendering the button when no
                             contact can be impersonated would only lead
                             to an inline error toast on click — better
                             to hide it entirely.
                        The `clerkUserId` field is already included in
                        the admin clients list response (see
                        services/clients.ts), so this check adds no
                        extra request. */}
                    {showSuperExtras && c.contacts?.some((ct) => !!ct.clerkUserId) && (
                      <ViewAsClientButton clientId={c.id} clientName={c.displayName} />
                    )}
                    {/* NO client-level pause. There is no such thing as a
                        paused client — ClientStatus is ACTIVE | ARCHIVED —
                        and the bulk "Pause services" / "Resume services"
                        pair that used to sit here was only ever a loop that
                        paused each Job in turn. It read as a client-level
                        switch while actually being a one-shot batch against
                        whatever Jobs existed at that moment (a Job added the
                        next day scheduled normally), and the
                        `Job.clientBulkPausedAt` bookkeeping it needed to
                        un-do itself was a second way to pause a Job that
                        had to stay in step with the first.

                        Pausing is a per-service decision, so it lives on
                        the service. This button is the way to get there.  */}
                    {showAdminExtras && c.status === "ACTIVE" && (
                      <Button
                        // xs to match the StatusButtons beside it. This was
                        // written before those dropped from sm to xs and was
                        // the only oversized control left in the row.
                        size="xs"
                        variant="outline"
                        px="2"
                        colorPalette={(c.pausedJobsCount ?? 0) > 0 ? "yellow" : undefined}
                        onClick={() =>
                          openEventSearch(
                            "clientsTabToServicesTabSearch",
                            c.displayName,
                            true,
                            c.id,
                          )
                        }
                        title={
                          (c.pausedJobsCount ?? 0) > 0
                            ? `Open this client's job services — ${c.pausedJobsCount} currently paused`
                            : "Open this client's job services to pause or resume them"
                        }
                      >
                        <Wrench size={12} />
                        Job services
                        {(c.pausedJobsCount ?? 0) > 0 && (
                          <>
                            {" · "}
                            <PauseCircle size={12} />
                            {c.pausedJobsCount}
                          </>
                        )}
                      </Button>
                    )}
                  </>
                )}
                {/* Contacts and Properties used to be two separate
                    full-width Accordion.Roots, so every card carried two
                    more rows whether or not anyone opened them — the real
                    bulk of this card, and the thing that made it feel long.
                    They are inline toggles in the action row now; the
                    content only takes space once it is asked for. */}
                <Button
                  size="xs"
                  variant={openPanel[c.id] === "contacts" ? "subtle" : "ghost"}
                  colorPalette="gray"
                  px="2"
                  onClick={() =>
                    setOpenPanel((prev) => ({
                      ...prev,
                      [c.id]: prev[c.id] === "contacts" ? null : "contacts",
                    }))
                  }
                >
                  <Icon as={FiUsers} boxSize="3" />
                  Contacts ({c.contacts?.length ?? 0})
                </Button>
                <Button
                  size="xs"
                  variant={openPanel[c.id] === "properties" ? "subtle" : "ghost"}
                  colorPalette="gray"
                  px="2"
                  onClick={() =>
                    setOpenPanel((prev) => ({
                      ...prev,
                      [c.id]: prev[c.id] === "properties" ? null : "properties",
                    }))
                  }
                >
                  <Icon as={FiMapPin} boxSize="3" />
                  Properties ({(c as any)?.properties?.length ?? 0})
                </Button>
                {/* Terminal actions, pushed to the far end of the row.
                    Archive ends the relationship and cascades to every
                    property and job under the client; it should not sit
                    shoulder to shoulder with Edit and a navigation link.
                    The Spacer eats the slack, so it lands right-aligned on
                    a wide row and simply last once the row wraps. */}
                <Spacer />
                {forAdmin && (
                  <>
                    {/* Archive now applies directly from ACTIVE (previous
                        two-step ACTIVE → PAUSED → ARCHIVED flow retired
                        with the PAUSED status). Friction is preserved by
                        the cascade-counts confirm dialog from Step 1. */}
                    {c.status === "ACTIVE" && (
                      <StatusButton
                        id={"client-archive"}
                        itemId={c.id}
                        label={"Archive"}
                        onClick={async () => await openArchiveClientConfirm(c)}
                        variant={"subtle"}
                        // Light red, not grey. Archiving a client cascades to
                        // every property and job under them — it is the end of
                        // the relationship, not a filing action, and grey read
                        // as neutral housekeeping. Safe to share red with
                        // Delete because the two are never on the same card:
                        // Archive shows for ACTIVE, Delete only for ARCHIVED.
                        colorPalette={"red"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                        size="xs"
                      />
                    )}
                    {c.status === "ARCHIVED" && (
                      <>
                        <StatusButton
                          id={"client-unarchive"}
                          itemId={c.id}
                          label={"Unarchive"}
                          onClick={async () => await openUnarchiveClientConfirm(c)}
                          variant={"outline"}
                          disabled={loading}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                          size="xs"
                        />
                        <StatusButton
                          id={"client-delete"}
                          itemId={c.id}
                          label={"Delete"}
                          onClick={async () => {
                            const contacts = (c as any)?.contacts ?? [];
                            const contactCount = contacts.length;

                            // Properties still block; only check when we'd
                            // otherwise be ready to delete.
                            let hasProperties = false;
                            try {
                              const props = await apiGet<any[]>(
                                `/api/admin/properties?clientId=${c.id}&limit=500`
                              );
                              hasProperties = Array.isArray(props) && props.length > 0;
                            } catch { /* proceed; server will guard */ }

                            const superRequired = !showSuperExtras;
                            const blocked = hasProperties || superRequired;

                            void setToDelete({
                              id: c.id,
                              title: "Delete client?",
                              summary: c.displayName,
                              disabled: blocked,
                              actionLabel: contactCount > 0 && !blocked
                                ? `Delete client + ${contactCount} ${contactCount === 1 ? "contact" : "contacts"}`
                                : "Delete",
                              details: hasProperties ? (
                                <Text color="red.fg">
                                  This client has associated properties. Delete all properties before deleting the client.
                                </Text>
                              ) : superRequired ? (
                                <Text color="red.fg">
                                  You must be a Super Admin to delete.
                                </Text>
                              ) : contactCount > 0 ? (
                                <Box
                                  p="3"
                                  bg="red.faint"
                                  borderWidth="1px"
                                  borderColor="red.emphasized"
                                  borderLeftWidth="4px"
                                  borderLeftColor="red.500"
                                  rounded="md"
                                >
                                  <Text color="red.fg" fontWeight="semibold" fontSize="sm" mb="1">
                                    Cascading delete
                                  </Text>
                                  <Text color="red.fg" fontSize="sm" mb="2">
                                    This will <b>also permanently delete</b> the{" "}
                                    {contactCount === 1
                                      ? "following contact"
                                      : `following ${contactCount} contacts`}{" "}
                                    attached to this client:
                                  </Text>
                                  <VStack align="start" gap="0.5" pl="2">
                                    {contacts.map((ct: any) => (
                                      <Text key={ct.id} fontSize="sm" color="red.fg">
                                        • {ct.firstName} {ct.lastName}
                                        {ct.isPrimary ? " (primary)" : ""}
                                        {ct.email ? ` — ${ct.email}` : ct.phone ? ` — ${ct.phone}` : ""}
                                      </Text>
                                    ))}
                                  </VStack>
                                  <Text color="red.fg" fontSize="xs" mt="2">
                                    Contacts cannot be recovered. Any Clerk accounts linked to these contacts will be orphaned.
                                  </Text>
                                </Box>
                              ) : undefined,
                              extra: c.displayName,
                            });
                          }}
                          variant={"outline"}
                          disabled={loading}
                          colorPalette={"red"}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                          size="xs"
                        />
                      </>
                    )}
                  </>
                )}
                {openPanel[c.id] === "contacts" && (
                  <Box w="full" pt={1}>
                        <VStack mt={2}>
                          {(c as any)?.contacts?.length === 0 && (
                            <Text fontSize="xs" color="fg.muted">
                              No contacts added.
                            </Text>
                          )}
                          {(c as any)?.contacts
                            ?.toSorted(
                              (a: any, b: any) =>
                                +(b.isPrimary ?? false) -
                                +(a.isPrimary ?? false)
                            )
                            // Tab-aware gate: inactive contacts are an
                            // admin-only concern (worker UI keeps the
                            // contacts list to active rows only). Use
                            // forAdmin instead of raw isAdmin so this
                            // matches the rest of the file — an admin
                            // browsing the Worker Clients tab still
                            // sees the clean worker view.
                            .filter(
                              (ct: any) => forAdmin || ct.status === "ACTIVE"
                            )
                            .map((ct: any) => {
                              return forAdmin || ct.status === "ACTIVE" ? (
                                <VStack
                                  key={ct.id}
                                  align="start"
                                  w="100%"
                                  borderWidth="1px"
                                  borderRadius="md"
                                  gap={0}
                                  p={3}
                                >
                                  <HStack w="100%" wrap="wrap">
                                    <Text fontWeight="medium">
                                      {ct.firstName}{ct.nickname ? ` "${ct.nickname}"` : ""}{ct.lastName ? ` ${ct.lastName}` : ""}
                                    </Text>
                                    {ct.isPrimary && (
                                      <Icon as={FiStar} boxSize="4" />
                                    )}
                                    <StatusBadge
                                      status={ct.status}
                                      palette={clientStatusColor(ct.status)}
                                      variant="subtle"
                                    />
                                    {!ct.lastName && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No last name</Badge>
                                    )}
                                    {!ct.email && !ct.phone && !ct.normalizedPhone && (
                                      <Badge size="xs" colorPalette="red" variant="subtle">No contact info</Badge>
                                    )}
                                    {ct.email && !ct.phone && !ct.normalizedPhone && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No phone</Badge>
                                    )}
                                    {!ct.email && (ct.phone || ct.normalizedPhone) && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No email</Badge>
                                    )}
                                    <Spacer />
                                    <StatusBadge
                                      status={ct.role}
                                      palette="gray"
                                      variant="outline"
                                    />
                                  </HStack>
                                  {ct.email && (
                                    <Text fontSize="xs" color="fg.muted">
                                      <MailLink
                                        to={ct.email}
                                        subject=""
                                        body=""
                                      />
                                    </Text>
                                  )}
                                  {(ct.normalizedPhone || ct.phone) && (
                                    <HStack gap={2} fontSize="xs" color="fg.muted">
                                      <CallLink
                                        to={ct.normalizedPhone ?? ct.phone ?? ""}
                                      />
                                      <Button
                                        size="xs"
                                        variant="ghost"
                                        colorPalette="green"
                                        px="1"
                                        minW="0"
                                        onClick={() => window.open(`sms:${ct.normalizedPhone ?? ct.phone}`, "_self")}
                                        title={`Text ${ct.normalizedPhone ?? ct.phone}`}
                                      >
                                        <MessageCircle size={12} />
                                      </Button>
                                    </HStack>
                                  )}
                                  {forAdmin && (
                                    <HStack gap={2} mt={3}>
                                      <StatusButton
                                        id={"contact-edit"}
                                        itemId={ct.id}
                                        label={"Edit"}
                                        onClick={async () => {
                                          await openContactEdit(c.id, ct);
                                        }}
                                        variant={"outline"}
                                        disabled={loading}
                                        busyId={statusButtonBusyId}
                                        setBusyId={setStatusButtonBusyId}
                                        size="xs"
                                      />
                                      {/* Contact "Pause" / "Unpause" removed in Step 3.
                                          Contact-level PAUSED silently blocked
                                          payment-request delivery — a footgun.
                                          To stop hearing from a contact,
                                          archive them; to remove a stale one,
                                          delete them. */}
                                      {ct.status === "ACTIVE" && (
                                        <StatusButton
                                          id={"contact-archive-from-active"}
                                          itemId={ct.id}
                                          label={"Archive"}
                                          onClick={async () =>
                                            await takeActionContact(
                                              ct,
                                              "archive"
                                            )
                                          }
                                          variant={"subtle"}
                                          disabled={loading}
                                          busyId={statusButtonBusyId}
                                          setBusyId={setStatusButtonBusyId}
                                          size="xs"
                                        />
                                      )}
                                      {/* PAUSED-only Archive branch removed in Step 5 —
                                          Contact.PAUSED no longer exists and Archive is
                                          now offered directly from the ACTIVE branch. */}
                                      {ct.status === "ARCHIVED" && (
                                        <>
                                          <StatusButton
                                            id={"contact-unarchive"}
                                            itemId={ct.id}
                                            label={"Unarchive"}
                                            onClick={async () =>
                                              await takeActionContact(
                                                ct,
                                                "unarchive"
                                              )
                                            }
                                            variant={"outline"}
                                            disabled={loading}
                                            busyId={statusButtonBusyId}
                                            setBusyId={setStatusButtonBusyId}
                                            size="xs"
                                          />
                                          <StatusButton
                                            id={"contact-delete"}
                                            itemId={ct.id}
                                            label={"Delete"}
                                            onClick={async () => {
                                              void setToDeleteContact({
                                                id: c.id,
                                                child: ct.id,
                                                title:
                                                  "Delete contact from client?",
                                                summary: `${ct.firstName} ${ct.lastName}`,
                                                disabled: me?.roles?.includes(
                                                  "SUPER"
                                                )
                                                  ? false
                                                  : true,
                                                details: (
                                                  <Text color="red.fg">
                                                    You must be a Super Admin to
                                                    delete.
                                                  </Text>
                                                ),
                                              });
                                            }}
                                            variant={"outline"}
                                            disabled={loading}
                                            colorPalette={"red"}
                                            busyId={statusButtonBusyId}
                                            setBusyId={setStatusButtonBusyId}
                                            size="xs"
                                          />
                                        </>
                                      )}
                                      <ClientContactLinkActions
                                        contact={ct}
                                        onChanged={() => void load()}
                                      />
                                    </HStack>
                                  )}
                                </VStack>
                              ) : undefined;
                            })}
                          {forAdmin && (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => openContactCreate(c.id)}
                              disabled={loading}
                            >
                              <Plus size={14} />
                              Add Contact
                            </Button>
                          )}
                        </VStack>
                  </Box>
                )}
                {openPanel[c.id] === "properties" && (
                  <Box w="full" pt={1}>
                        <VStack mt={2}>
                          {(c as any)?.properties?.length === 0 && (
                            <Text fontSize="xs" color="fg.muted">
                              No properties added.
                            </Text>
                          )}
                          {(c as any)?.properties.map((p: any) => {
                            const address = [
                              p.street1,
                              p.street2,
                              p.city,
                              p.state,
                              p.postalCode,
                              p.country,
                            ]
                              .filter(Boolean)
                              .join(", ");

                            return forAdmin || p.status === "ACTIVE" ? (
                              <VStack
                                key={p.id}
                                opacity={p.status === "ACTIVE" ? 1.0 : 0.5}
                                align="start"
                                w="100%"
                                borderWidth="1px"
                                borderRadius="md"
                                gap={0}
                                p={3}
                              >
                                <HStack w="100%">
                                  <Text
                                    fontWeight="medium"
                                    color="blue.fg"
                                    cursor="pointer"
                                    _hover={{ textDecoration: "underline" }}
                                    onClick={() => openEventSearch(
                                      "clientTabToPropertiesTabSearch",
                                      p.displayName,
                                      forAdmin,
                                      p.id,
                                    )}
                                  >
                                    {p.displayName}
                                  </Text>
                                  <Spacer />
                                  <StatusBadge
                                    status={p.kind}
                                    palette="gray"
                                    variant="outline"
                                  />
                                </HStack>
                                <MapLink address={address} />
                              </VStack>
                            ) : null;
                          })}
                        </VStack>
                  </Box>
                )}
              </HStack>
            </Card.Footer>
          </Card.Root>
          );
        })}
      </VStack>
      </Box>

      {forAdmin && (
        <ClientDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {forAdmin && (
        <ContactDialog
          open={contactDialogOpen}
          onOpenChange={setContactDialogOpen}
          mode={contactEditing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={contactEditing ?? undefined}
          onSaved={() => void load()}
          clientId={contactClientId}
        />
      )}
      {forAdmin && (
        <DeleteDialog
          toDelete={toDelete}
          cancel={() => void setToDelete(null)}
          complete={async () => {
            if (!toDelete) return;
            await deleteAction(toDelete.id, toDelete.extra ?? "");
            setToDelete(null);
          }}
        />
      )}
      {forAdmin && (
        <DeleteDialog
          toDelete={toDeleteContact}
          cancel={() => void setToDeleteContact(null)}
          complete={async () => {
            await deleteContact(
              toDeleteContact?.id ?? "",
              toDeleteContact?.child ?? ""
            );
            setToDeleteContact(null);
          }}
        />
      )}
      {/* Archive-cascade confirmation. Counts come from the server so
          they match what the cascade will actually touch. Idempotent
          per-row cascade means "already archived" children aren't
          double-counted. */}
      {archiveClientConfirm && (
        <ConfirmDialog
          open
          title="Archive this client?"
          message={
            (() => {
              const { client, propertiesToArchive, jobsToArchive } = archiveClientConfirm;
              const parts: string[] = [];
              if (propertiesToArchive > 0) {
                parts.push(`${propertiesToArchive} propert${propertiesToArchive === 1 ? "y" : "ies"}`);
              }
              if (jobsToArchive > 0) {
                parts.push(`${jobsToArchive} job${jobsToArchive === 1 ? "" : "s"}`);
              }
              const cascade = parts.length > 0 ? ` This will also archive ${parts.join(" and ")}.` : "";
              return `Archive ${client.displayName}?${cascade} Historical data (payments, invoices, exports) stays accessible.`;
            })()
          }
          confirmLabel="Archive"
          confirmColorPalette="red"
          onConfirm={async () => {
            const c = archiveClientConfirm.client;
            setArchiveClientConfirm(null);
            await takeAction(c, "archive");
          }}
          onCancel={() => setArchiveClientConfirm(null)}
        />
      )}
      {unarchiveClientConfirm && (
        <ConfirmDialog
          open
          title="Unarchive this client?"
          message={
            (() => {
              const { client, propertiesToUnarchive, jobsToUnarchive } = unarchiveClientConfirm;
              const parts: string[] = [];
              if (propertiesToUnarchive > 0) {
                parts.push(`${propertiesToUnarchive} propert${propertiesToUnarchive === 1 ? "y" : "ies"}`);
              }
              if (jobsToUnarchive > 0) {
                parts.push(`${jobsToUnarchive} job${jobsToUnarchive === 1 ? "" : "s"}`);
              }
              const cascade = parts.length > 0
                ? ` This will also unarchive ${parts.join(" and ")}. Jobs return to Accepted status.`
                : "";
              return `Restore ${client.displayName} to active?${cascade}`;
            })()
          }
          confirmLabel="Unarchive"
          confirmColorPalette="green"
          onConfirm={async () => {
            const c = unarchiveClientConfirm.client;
            setUnarchiveClientConfirm(null);
            await takeAction(c, "unarchive");
          }}
          onCancel={() => setUnarchiveClientConfirm(null)}
        />
      )}
    </Box>
  );
}
