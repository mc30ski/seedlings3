"use client";

/**
 * ROLES — what exists, what each one grants, and who holds it.
 *
 * This is the screen the whole capability model was waiting on. Until now
 * roles could only be created by running `install-starter-roles.ts`, so an
 * operator could not define one, and "there are no roles, only capabilities"
 * was true in the database and unreachable from the app.
 *
 * FOUR THINGS, ONE SCREEN, because they answer one question between them:
 *   · the list         — what roles exist
 *   · the editor       — what a role grants, and what it inherits
 *   · Capabilities     — every role against every capability, at a glance
 *   · People           — who holds what, the same table read the other way
 *
 * The matrix is GENERATED from the same two sources the server uses: the
 * entitlement vocabulary from `GET /entitlements`, and each role's resolved
 * `effective` set from `GET /roles`. Nothing here is hand-maintained, which
 * is the mistake `PRIV_DEFAULTS` made — a second table of what a role means,
 * which drifted from the first.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Card, Checkbox, HStack, Icon, Input, Portal, Select, Spinner, Table, Text, Textarea, VStack, createListCollection } from "@chakra-ui/react";
import { Check, CheckCircle2, ChevronDown, ChevronUp, KeyRound, Plus, Shield, Users as UsersIcon, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/src/lib/api";
import { PERSPECTIVE_ICONS, PERSPECTIVE_ICONS_COMMON, PERSPECTIVE_ICONS_MORE } from "@repo/permissions";
import { PerspectiveGlyph, preloadAllIcons } from "@/src/lib/perspectiveIcons";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";
import { payClassLabel } from "@/src/lib/paymentMath";
import { isCustomerOnly } from "@/src/lib/people";
import { CAPABILITIES_CHANGED_EVENT } from "@/src/lib/impersonation";

type EntitlementGroup = {
  group: string;
  entitlements: Array<{ id: string; copy: string }>;
};

type RoleRow = {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  suspendedAt: string | null;
  inheritsFromId: string | null;
  isPerspective: boolean;
  perspectiveIcon?: string | null;
  perspectiveOrder: number | null;
  /** Only what this role itself grants — what the editor writes. */
  own: string[];
  /** What holding it actually gives, inheritance resolved. */
  effective: string[];
  holders?: number;
};

type Holder = {
  scope: "global" | "portfolio";
  userId: string;
  displayName: string | null;
  email: string | null;
  portfolioName?: string | null;
  isTemporary?: boolean;
  suspendedAt: string | null;
};

export default function RolesTab({ scope }: { scope: Scope }) {
  const mayDefine = scope.can("roles.define");
  /** `GET /users` returns `roleGrants`/`capabilities` only to `people.manage`. */
  const maySeeHolders = scope.can("people.manage");

  const [groups, setGroups] = useState<EntitlementGroup[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Set once the reader taps a role, so the editor knows to scroll into
   *  view on a phone — the automatic first selection must not. */
  const pickedRef = useRef(false);
  const [view, setView] = useState<"editor" | "matrix" | "people">("editor");
  const [titles, setTitles] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ents, rows, settings] = await Promise.all([
        apiGet<{ groups: EntitlementGroup[]; all: string[] }>("/api/entitlements"),
        apiGet<RoleRow[]>("/api/roles"),
        // Name suggestions only. Failing to load them must not block the
        // editor — the field is free text either way.
        apiGet<Array<{ key: string; value: string }>>("/api/settings").catch(
          () => [] as Array<{ key: string; value: string }>,
        ),
      ]);
      setGroups(ents.groups);
      setRoles(rows);
      setTitles(parseManagerTitles(settings));
      setSelectedId((cur) => cur ?? rows[0]?.id ?? null);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load roles.", err) });
    } finally {
      setLoading(false);
    }
  }, []);

  // THE ONE SCREEN WHERE A STALE ANSWER LOOKS LIKE A BUG. Every checkbox
  // here is locked or unlocked by what YOU hold, and `/api/me` is a
  // snapshot taken at page load — so a grant that landed since (a
  // migration, another admin, your own grant on the Users tab) leaves the
  // builder saying "you don't hold this" about something you do. One
  // request on open, not a poll.
  useEffect(() => {
    try { window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT)); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => roles.find((r) => r.id === selectedId) ?? null,
    [roles, selectedId],
  );

  return (
    <VStack align="stretch" gap={3}>
      {/* Above the loading gate on purpose: the breadcrumb drives the
          explainer, so a tab that mounts it only after its data arrives has
          an "i" icon that does nothing on first paint. */}
      <TabExplainer explainerId="seedlings:rolesTab:guideOpen">
        <ExplainerText>
          A role is a <Em>name</Em>, a set of things it lets someone do, and
          optionally a parent it inherits from. Nothing in the app is hardcoded
          to a particular role — rename or replace any of them and the app
          follows, because every screen and every button asks for a capability,
          never for a role.
        </ExplainerText>
        <ExplainerText>
          <Em>Inheritance saves repetition and nothing else.</Em> A role that
          inherits another grants everything that one grants, plus its own. The
          chain is resolved the same way on the server, so what you see in the
          matrix is exactly what a request will be allowed to do.
        </ExplainerText>
        <ExplainerText>
          You can only grant what you hold yourself. A capability you do not
          have is shown but cannot be ticked — giving away more than you have
          is the one thing this screen will not do.
        </ExplainerText>
      </TabExplainer>

      {loading ? (
        <Box py={8} textAlign="center">
          <Spinner />
        </Box>
      ) : (
      <>
      {/* WRAPS, because four labelled buttons do not fit a phone.
          At 390px the row ran to 528px and took the WHOLE PAGE sideways
          with it — the header scrolled off too, so the app looked broken
          rather than the row looking long. A horizontally scrolling tab
          strip was the other option and was rejected: an off-screen tab
          nobody knows to scroll for is a tab that does not exist. */}
      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant={view === "editor" ? "solid" : "outline"}
          onClick={() => setView("editor")}
        >
          <Shield size={14} /> Roles
        </Button>
        <Button
          size="sm"
          variant={view === "matrix" ? "solid" : "outline"}
          onClick={() => setView("matrix")}
        >
          <KeyRound size={14} /> Capabilities
        </Button>
        {maySeeHolders && (
          <Button
            size="sm"
            variant={view === "people" ? "solid" : "outline"}
            onClick={() => setView("people")}
          >
            <UsersIcon size={14} /> People
          </Button>
        )}
      </HStack>

      {view === "matrix" ? (
        <EntitlementMatrix groups={groups} roles={roles} />
      ) : view === "people" && maySeeHolders ? (
        <PeopleRoles
          groups={groups}
          roles={roles}
          onOpenRole={(roleId) => { setSelectedId(roleId); setView("editor"); }}
        />
      ) : (
        <HStack align="start" gap={4} wrap={{ base: "wrap", lg: "nowrap" }}>
          <RoleList
            roles={roles}
            titles={titles}
            selectedId={selectedId}
            onSelect={(id) => { pickedRef.current = true; setSelectedId(id); }}
            mayDefine={mayDefine}
            onReordered={load}
            onCreated={async (id) => {
              await load();
              setSelectedId(id);
            }}
          />
          {selected && (
            <RoleEditor
              key={selected.id}
              scrollOnMount={pickedRef.current}
              role={selected}
              roles={roles}
              groups={groups}
              scope={scope}
              mayDefine={mayDefine}
              onChanged={load}
              onDeleted={async () => {
                setSelectedId(null);
                await load();
              }}
            />
          )}
        </HStack>
      )}
      </>
      )}
    </VStack>
  );
}

/**
 * Role-name suggestions from the `MANAGER_TITLES` taxonomy.
 *
 * SUGGESTIONS, deliberately — a role name is free text, because the point of
 * custom roles is that we cannot know yours in advance. So this is chips
 * under the field, not a Select: picking one fills the box, ignoring them
 * costs nothing, and a name that is on nobody's list is still a first-class
 * answer. Hidden once the field has content, so it never competes with what
 * the operator is typing.
 */
function RoleNameSuggestions({
  titles,
  value,
  onPick,
}: {
  titles: string[];
  value: string;
  onPick: (t: string) => void;
}) {
  if (value.trim() || titles.length === 0) return null;
  return (
    <HStack gap={1} wrap="wrap">
      {titles.map((t) => (
        <Button key={t} size="xs" variant="outline" onClick={() => onPick(t)}>
          {t}
        </Button>
      ))}
    </HStack>
  );
}

/** Read MANAGER_TITLES out of the settings payload, tolerating anything. */
function parseManagerTitles(rows: Array<{ key: string; value: string }>): string[] {
  const raw = (Array.isArray(rows) ? rows : []).find((r) => r.key === "MANAGER_TITLES")?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function RoleList({
  roles,
  titles,
  selectedId,
  onSelect,
  mayDefine,
  onCreated,
  onReordered,
}: {
  roles: RoleRow[];
  titles: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  mayDefine: boolean;
  onCreated: (id: string) => void;
  onReordered: () => void | Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [copyFromId, setCopyFromId] = useState<string | null>(null);
  const [roleKey, setRoleKey] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * TWO GROUPS, AND THE SPLIT IS `isPerspective` — NOT "has an order".
   *
   * This list used to be one flat run of whatever `GET /roles` returned,
   * which is `ORDER BY perspectiveOrder ASC, name ASC`. Postgres sorts
   * NULLs LAST, so a role flagged as a perspective but never placed fell
   * into the alphabetical tail among the non-perspectives — while the
   * "Viewing as" menu sorts `?? 0` and put the same role at the very TOP,
   * above the whole ladder. Dev had Coordinator in both places at once.
   * Grouping on the flag puts it where it belongs and shows that it is
   * unplaced, instead of hiding the contradiction in two sort orders.
   *
   * Perspectives are sorted the way the MENU sorts them, so this list is
   * a preview of that menu rather than a second opinion about it.
   */
  const [pending, setPending] = useState<string[] | null>(null);
  const perspectives = useMemo(() => {
    const live = roles.filter((r) => r.isPerspective);
    if (pending) {
      const by = new Map(live.map((r) => [r.id, r]));
      const out = pending.map((id) => by.get(id)).filter(Boolean) as RoleRow[];
      if (out.length === live.length) return out;
    }
    return [...live].sort((a, b) => (a.perspectiveOrder ?? 0) - (b.perspectiveOrder ?? 0));
  }, [roles, pending]);
  const others = useMemo(
    () => roles.filter((r) => !r.isPerspective).sort((a, b) => a.name.localeCompare(b.name)),
    [roles],
  );

  /**
   * A move saves itself, DEBOUNCED, and does not refetch on success.
   *
   * The first cut awaited the save and then reloaded the whole list on
   * every arrow press. Moving a perspective from the bottom to the top
   * meant a round trip and a full re-render between each step, and the
   * list jumped under the finger — unusable for exactly the thing the
   * control exists to do.
   *
   * Two changes fix it. The local order is authoritative while you click,
   * so the arrows respond at the speed of the DOM. And a SUCCESSFUL save
   * reloads nothing: the endpoint rewrites the whole list as a dense 1..n
   * from the array we just sent, so on success the server agrees with what
   * is already on screen and refetching could only redraw the same thing.
   * A failure is the one case that reloads, because then the screen is
   * the thing that is wrong.
   *
   * Debounced rather than per-press so a run of six clicks is one write
   * and one audit entry describing the move that was actually made,
   * instead of six describing the journey.
   */
  const pendingRef = useRef<string[] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const ids = pendingRef.current;
    if (!ids) return;
    try {
      await apiPut("/api/roles/perspectives/order", { roleIds: ids });
    } catch (err: any) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not save the order.", err),
      });
      pendingRef.current = null;
      setPending(null);
      await onReordered();
    }
  }, [onReordered]);

  // Don't lose the last move to a navigation. The timer is short, but
  // "clicked an arrow then immediately tapped another tab" is the normal
  // way to finish, and without this that move is silently dropped.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void flush();
      }
    };
  }, [flush]);

  function move(index: number, direction: "up" | "down") {
    const to = direction === "up" ? index - 1 : index + 1;
    if (to < 0 || to >= perspectives.length) return;
    const next = [...perspectives];
    [next[index], next[to]] = [next[to], next[index]];
    const ids = next.map((r) => r.id);
    setPending(ids);
    pendingRef.current = ids;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, 700);
  }

  const copyCollection = createListCollection({
    items: [
      { label: "Start empty", value: "" },
      ...roles.map((r) => ({ label: `Copy from ${r.name}`, value: r.id })),
    ],
  });

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      // COPY, NOT LINK. `entitlements` is a snapshot of the source role's
      // own set; `inheritsFromId` stays null. The two are easy to confuse
      // and behave completely differently afterwards, which is why the
      // warning sits next to the control rather than in a help panel.
      const source = copyFromId ? roles.find((r) => r.id === copyFromId) : null;
      const created = await apiPost<{ id: string }>("/api/roles", {
        name: name.trim(),
        entitlements: source?.own ?? [],
        key: roleKey.trim() || null,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: source
          ? `Created ${name.trim()} with a copy of ${source.name}'s own permissions.`
          : `Created ${name.trim()}.`,
      });
      setCreating(false);
      setName("");
      setRoleKey("");
      setCopyFromId(null);
      onCreated(created.id);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't create the role.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack align="stretch" gap={2} minW={{ base: "full", lg: "72" }} maxW={{ lg: "72" }} w="full">
      {mayDefine &&
        (creating ? (
          <Card.Root variant="outline">
            <Card.Body py="3" px="3">
              <VStack align="stretch" gap={2}>
                <Input
                  size="sm"
                  // Distinct from the editor's "Role name" field below. Both
                  // are on screen at once while creating, and two inputs
                  // with one placeholder is ambiguous to a reader as well
                  // as to a test.
                  placeholder="Name the new role"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <RoleNameSuggestions titles={titles} value={name} onPick={setName} />
                {/* THE KEY, and why a UI needs to offer one at all.
                    `install-starter-roles.ts` upserts on `key`, and
                    `CustomRole.name` is unique. A role made here with no
                    key, wearing a name the installer also uses, is not
                    found by key — so the installer tries to CREATE it,
                    hits the name constraint and fails. The installer is
                    the documented way back into a locked-out database, so
                    "re-running it crashes" is not a small thing.
                    Normally leave this empty. Fill it only to hand a
                    hand-made role to the installer to maintain. */}
                <Input
                  size="sm"
                  value={roleKey}
                  onChange={(e) => setRoleKey(e.target.value)}
                  placeholder="Key (optional) — e.g. seedlings.portfolio-lead"
                />
                <Text fontSize="xs" color="fg.muted">
                  Leave empty for an ordinary role. Set it only to match a role the
                  setup script installs, so re-running the script maintains this one
                  instead of failing on the duplicate name. Lowercase words joined by
                  dots or dashes; it can never be changed afterwards.
                </Text>
                <Select.Root
                  size="sm"
                  collection={copyCollection}
                  value={[copyFromId ?? ""]}
                  onValueChange={(e) => setCopyFromId(e.value[0] || null)}
                >
                  <Select.HiddenSelect />
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Start empty" />
                    </Select.Trigger>
                    <Select.IndicatorGroup>
                      <Select.Indicator />
                    </Select.IndicatorGroup>
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content>
                        {copyCollection.items.map((i) => (
                          <Select.Item key={i.value} item={i}>
                            <Select.ItemText>{i.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
                {copyFromId && (
                  <Box
                    p={2}
                    bg="orange.faint"
                    borderWidth="1px"
                    borderColor="orange.emphasized"
                    rounded="md"
                  >
                    <Text fontSize="xs" color="orange.fg">
                      This takes a <Em>copy</Em> of that role's own permissions,
                      made once, right now. It is not a link: later changes to{" "}
                      {roles.find((r) => r.id === copyFromId)?.name} will not
                      reach this role. If you want them to stay together, leave
                      this empty and set an <Em>inherits from</Em> instead.
                    </Text>
                  </Box>
                )}
                <HStack gap={2}>
                  <Button size="xs" onClick={create} disabled={!name.trim() || busy}>
                    {busy ? "Creating…" : "Create"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setCreating(false);
                      setName("");
                      setCopyFromId(null);
                    }}
                  >
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus size={14} /> New role
          </Button>
        ))}

      {([
        ["Perspectives", perspectives, true] as const,
        ["Other roles", others, false] as const,
      ]).map(([heading, group, ordered]) =>
        group.length === 0 ? null : (
        <Box key={heading}>
          <Text
            fontSize="2xs"
            textTransform="uppercase"
            letterSpacing="wide"
            color="fg.muted"
            mb={1}
            mt={heading === "Other roles" ? 2 : 0}
          >
            {heading}
            {ordered && mayDefine ? " · the \u201cViewing as\u201d order" : ""}
          </Text>
          <VStack align="stretch" gap={2}>
      {group.map((r, i) => (
        /* THE ARROWS SIT OUTSIDE THE ROW, not inside it. The row is
           `as="button"`, and a button inside a button is invalid HTML —
           the browser closes the outer one, so the second arrow lands
           outside the card and the row stops being tappable where you
           expect. An HStack with the card as one child and the arrows as
           another keeps both hit targets honest, which matters most on a
           phone where they are 4mm apart. */
        <HStack key={r.id} gap={1} align="stretch">
        <Box
          flex="1"
          minW={0}
          as="button"
          textAlign="left"
          p={2.5}
          rounded="md"
          borderWidth="1px"
          borderColor={r.id === selectedId ? "blue.emphasized" : "border"}
          bg={r.id === selectedId ? "blue.faint" : "bg.panel"}
          onClick={() => onSelect(r.id)}
        >
          <HStack justify="space-between" gap={2}>
            <VStack align="start" gap={0.5} minW={0}>
              <HStack gap={1.5} wrap="wrap">
                <Text fontWeight="semibold" fontSize="sm">
                  {r.name}
                </Text>
                {r.suspendedAt && (
                  <Badge size="sm" colorPalette="orange" variant="subtle">
                    Suspended
                  </Badge>
                )}
                {r.isPerspective && (
                  <Badge size="sm" colorPalette="purple" variant="subtle">
                    Perspective
                  </Badge>
                )}
              </HStack>
              <Text fontSize="xs" color="fg.muted">
                {r.effective.length} permission{r.effective.length === 1 ? "" : "s"}
                {r.inheritsFromId
                  ? ` · inherits ${roles.find((x) => x.id === r.inheritsFromId)?.name ?? "another role"}`
                  : ""}
              </Text>
            </VStack>
            {typeof r.holders === "number" && r.holders > 0 && (
              <HStack gap={1} color="fg.muted" flexShrink={0}>
                <UsersIcon size={12} />
                <Text fontSize="xs">{r.holders}</Text>
              </HStack>
            )}
          </HStack>
        </Box>
        {ordered && mayDefine && (
          <VStack gap={0.5} justify="center" flexShrink={0}>
            <Button
              size="2xs"
              variant="outline"
              px={1}
              aria-label={`Move ${r.name} up`}
              disabled={i === 0}
              onClick={() => void move(i, "up")}
            >
              <ChevronUp size={12} />
            </Button>
            <Button
              size="2xs"
              variant="outline"
              px={1}
              aria-label={`Move ${r.name} down`}
              disabled={i === group.length - 1}
              onClick={() => void move(i, "down")}
            >
              <ChevronDown size={12} />
            </Button>
          </VStack>
        )}
        </HStack>
      ))}
          </VStack>
        </Box>
        ),
      )}
    </VStack>
  );
}

function RoleEditor({
  role,
  roles,
  groups,
  scope,
  mayDefine,
  onChanged,
  onDeleted,
  scrollOnMount,
}: {
  /** True when this editor opened because somebody tapped a role. */
  scrollOnMount?: boolean;
  role: RoleRow;
  roles: RoleRow[];
  groups: EntitlementGroup[];
  scope: Scope;
  mayDefine: boolean;
  onChanged: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const [own, setOwn] = useState<Set<string>>(new Set(role.own));
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [saving, setSaving] = useState(false);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [confirm, setConfirm] = useState<"suspend" | "unsuspend" | "delete" | null>(null);
  /**
   * INHERITANCE IS EDITED, NOT APPLIED. Picking a parent used to PATCH the
   * role the instant the dropdown closed, while name, description and every
   * entitlement waited for Save — so the one structural change on the page
   * was the one with no undo and no confirmation. Changing Super's parent
   * from Admin to Bookkeeper took effect immediately and cost the person
   * doing it `roles.view`, which is what loads this screen.
   */
  const [inheritsFromId, setInheritsFromId] = useState<string | null>(
    role.inheritsFromId ?? null,
  );
  /** Capabilities this save would take away from the person doing it. */
  const [confirmSave, setConfirmSave] = useState(false);
  const [showAllIcons, setShowAllIcons] = useState(false);
  /** The entitlement's own words, from `GET /entitlements`. Falls back to
   *  the id so an unknown one is still named rather than blank. */
  const copyFor = useCallback(
    (id: string) =>
      groups.flatMap((g) => g.entitlements).find((e) => e.id === id)?.copy ?? id,
    [groups],
  );
  // Same rule as inheritance: edited here, applied on Save. These two wrote
  // straight through as well, so the page had three fields that committed
  // on touch and three that waited — with no way to tell which was which.
  const [isPerspective, setIsPerspective] = useState<boolean>(role.isPerspective);
  const [perspectiveIcon, setPerspectiveIconState] = useState<string | null>(
    role.perspectiveIcon ?? null,
  );

  /**
   * The common icons, plus whichever one is already chosen.
   *
   * Without that second half a role wearing an icon from the "more" tier
   * would open with nothing highlighted — which reads as "no icon set" and
   * invites picking a different one by accident. The chosen icon is always
   * on screen, wherever in the catalogue it came from.
   */
  const shownIcons = useMemo(() => {
    if (showAllIcons) return [...PERSPECTIVE_ICONS] as string[];
    const common = [...PERSPECTIVE_ICONS_COMMON] as string[];
    return perspectiveIcon && !common.includes(perspectiveIcon)
      ? [...common, perspectiveIcon]
      : common;
  }, [showAllIcons, perspectiveIcon]);

  const parent = inheritsFromId
    ? roles.find((r) => r.id === inheritsFromId) ?? null
    : null;
  /** What the parent already gives. Shown ticked and locked: unticking it
   *  here would do nothing, because inheritance is resolved on the server. */
  const inherited = useMemo(
    () => new Set(parent?.effective ?? []),
    [parent],
  );

  const dirty =
    name !== role.name ||
    description !== (role.description ?? "") ||
    inheritsFromId !== (role.inheritsFromId ?? null) ||
    isPerspective !== role.isPerspective ||
    perspectiveIcon !== (role.perspectiveIcon ?? null) ||
    own.size !== role.own.length ||
    role.own.some((e) => !own.has(e));

  /**
   * What this role would stop granting, of the things the EDITOR still has.
   *
   * `scope.can` is the only thing this screen knows about the person using
   * it, and that is enough: if the save drops a capability they currently
   * hold, they are at risk of losing it. It can over-warn — they might hold
   * it through a second role as well — and over-warning before a change
   * that can lock you out of this very screen is the right way round.
   */
  const wouldLose = useMemo(() => {
    const after = new Set<string>([...own, ...(parent?.effective ?? [])]);
    return (role.effective ?? [])
      .filter((e) => !after.has(e))
      .filter((e) => scope.can(e as never));
  }, [own, parent, role.effective, scope]);

  /**
   * Bring the editor into view on a phone.
   *
   * The editor renders BELOW the entire role list there, so tapping a role
   * changed something off-screen: the page did not move and the tap looked
   * like it had done nothing. Desktop is side-by-side and needs no scroll,
   * hence the width check. `key={selected.id}` on this component means a
   * remount per selection, so a mount effect fires on every pick.
   */
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only when the reader PICKED one. The first role is selected
    // automatically on load, so scrolling on every mount would jump a
    // phone past the list to the editor each time the tab is opened.
    if (!scrollOnMount) return;
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 992) return; // Chakra's `lg`, where the two sit side by side
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollOnMount]);

  const inheritCollection = createListCollection({
    items: [
      { label: "Inherits nothing", value: "" },
      ...roles
        // A role cannot inherit itself, and the server refuses a cycle —
        // but offering the option and then failing is a worse way to say so.
        .filter((r) => r.id !== role.id)
        .map((r) => ({ label: `Inherits ${r.name}`, value: r.id })),
    ],
  });

  /**
   * WHAT THIS SAVE ACTUALLY DOES, computed before anybody commits to it.
   *
   * `own` is absolute — the editor sends the whole set — so the change is
   * the difference from what the role held when it loaded. Everyone holding
   * the role gains or loses these the moment Save lands.
   */
  const addedEnts = useMemo(
    () => [...own].filter((e) => !(role.own ?? []).includes(e)).sort(),
    [own, role.own],
  );
  const removedEnts = useMemo(
    () => (role.own ?? []).filter((e) => !own.has(e)).sort(),
    [own, role.own],
  );
  const detailChanges = useMemo(() => {
    const out: string[] = [];
    if (name !== role.name) out.push(`renamed to "${name}"`);
    if (description !== (role.description ?? "")) out.push("description changed");
    if (inheritsFromId !== (role.inheritsFromId ?? null)) {
      const to = roles.find((r) => r.id === inheritsFromId)?.name ?? "nothing";
      out.push(`now inherits ${to}`);
    }
    if (isPerspective !== role.isPerspective) {
      out.push(isPerspective ? "offered as a perspective" : "no longer a perspective");
    }
    if (perspectiveIcon !== (role.perspectiveIcon ?? null)) out.push("icon changed");
    return out;
  }, [name, description, inheritsFromId, isPerspective, perspectiveIcon, role, roles]);

  /**
   * ASK BEFORE EVERY SAVE, not only the one that costs the editor.
   *
   * Save used to apply the moment it was clicked, naming nothing. A role
   * list and its editor stack on a phone, so it is possible to be editing
   * one role while reading another — and a save then rewrites the wrong
   * role's entire grant, silently, for everybody holding it. That happened:
   * the baseline role picked up sixteen capabilities it should never have,
   * including the company P&L and everyone's payroll, and nothing on screen
   * said so. The dialog names the role and lists what moves.
   *
   * The self-loss warning stays as its own, louder step — losing your own
   * access is a different kind of mistake from changing somebody else's.
   */
  function requestSave() {
    if (saving) return;
    // ONE DIALOG. The self-loss warning used to be its own, and it took
    // precedence — so a save that both cost the editor something AND
    // rewrote the role showed the warning and hid the diff, which is the
    // half that says what is actually happening. Now the diff always
    // shows, and losing your own access is a red block inside it.
    if (addedEnts.length || removedEnts.length || detailChanges.length) {
      setConfirmSave(true);
      return;
    }
    void save();
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      if (
        name !== role.name ||
        description !== (role.description ?? "") ||
        inheritsFromId !== (role.inheritsFromId ?? null) ||
        isPerspective !== role.isPerspective ||
        perspectiveIcon !== (role.perspectiveIcon ?? null)
      ) {
        await apiPatch(`/api/roles/${role.id}`, {
          name,
          description: description || null,
          inheritsFromId,
          isPerspective,
          perspectiveIcon,
          // Clearing the flag clears the order with it: an ordering for
          // something that is not in the list is a value nothing reads and
          // everything has to remember to ignore.
          ...(isPerspective ? {} : { perspectiveOrder: null }),
        });
      }
      // ABSOLUTE, never a delta. A role is the full list of what it grants,
      // so the editor sends the whole set — a partial update is how two
      // people editing one role silently drop each other's changes.
      await apiPut(`/api/roles/${role.id}/entitlements`, { entitlements: [...own] });
      publishInlineMessage({ type: "SUCCESS", text: `Saved ${name}.` });
      await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't save the role.", err) });
    } finally {
      setSaving(false);
    }
  }




  async function loadHolders() {
    try {
      setHolders(await apiGet<Holder[]>(`/api/roles/${role.id}/holders`));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load holders.", err) });
    }
  }

  async function act(what: "suspend" | "unsuspend" | "delete") {
    try {
      if (what === "delete") await apiDelete(`/api/roles/${role.id}`);
      else await apiPost(`/api/roles/${role.id}/${what}`);
      publishInlineMessage({ type: "SUCCESS", text: `${role.name} ${what}${what === "delete" ? "d" : "ed"}.` });
      if (what === "delete") await onDeleted();
      else await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(`Couldn't ${what} the role.`, err) });
    }
  }

  return (
    <VStack align="stretch" gap={3} flex="1" minW={0}>
      {/* WHERE THE LIST ENDS AND THE EDITOR BEGINS.
          On a phone these two stack, and the editor opened on a bare name
          Input — so a tap on a role added an unlabelled card to a pile of
          identical cards and the page read as one continuous list.

          SOLID, not tinted. The first version used the same `blue.faint`
          as the selected row, on the theory that a shared colour ties
          "this one" to "this is what you are editing". It did the
          opposite: the row, this header and the company-wide holder badge
          were then three different things wearing one colour, and nothing
          said which was a control and which was a title. The hue still
          links them; the WEIGHT is what separates a filled title bar from
          a tinted, tappable row. */}
      <Box
        ref={headerRef}
        // THEMED, NOT BLUE. `blue.solid` is a fixed hue with a light/dark
        // pair — it renders the same blue in all 14 themes, so this bar sat
        // bright blue inside Funkadelic's magenta chrome and Espresso's
        // browns. A filled title bar is CHROME, not status, so it takes the
        // theme's own accent. `fg.onAccent` is the ink tuned per theme to
        // sit on it (near-black on Dark's pale blue, white on Spring's
        // green) — `blue.contrast` is white always, which fails on the
        // light-accent themes.
        bg="accent.solid"
        color="fg.onAccent"
        rounded="lg"
        px="3"
        py="2"
      >
        <HStack gap={2} align="center" minW={0}>
          <Icon as={Shield} boxSize={4} flexShrink={0} />
          <Box minW={0}>
            <Text
              fontSize="2xs"
              textTransform="uppercase"
              letterSpacing="wide"
              lineHeight="1.2"
              // No opacity dimming. White on this blue is 5.1:1, but at 85%
              // it falls to ~3.9:1 — under AA for text this small. The size,
              // the caps and the tracking already mark it as an eyebrow.
            >
              {mayDefine ? "Editing role" : "Role details"}
            </Text>
            <Text fontSize="sm" fontWeight="semibold" truncate>
              {role.name}
            </Text>
          </Box>
        </HStack>
      </Box>
      <Card.Root variant="outline">
        <Card.Body py="3" px="3">
          <VStack align="stretch" gap={3}>
            <Input
              size="sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!mayDefine}
              placeholder="Role name"
            />
            {/* GROWS TO ITS CONTENT. At a fixed `rows={2}` any description
                longer than two lines was sliced through the middle of the
                third — District Lead's reads "…for the" and then a row of
                half-height letters. A textarea scrolls, so nothing was
                lost, but a clipped glyph reads as a broken box rather than
                as more text, and this field is the one place the person
                granting a role finds out what it is for. */}
            <Textarea
              size="sm"
              rows={2}
              autoresize
              maxH="40"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!mayDefine}
              placeholder="What is this role for? The person granting it reads this."
            />
            <Select.Root
              size="sm"
              collection={inheritCollection}
              value={[inheritsFromId ?? ""]}
              disabled={!mayDefine}
              onValueChange={(e) => setInheritsFromId(e.value[0] || null)}
            >
              <Select.HiddenSelect />
              <Select.Control>
                <Select.Trigger>
                  <Select.ValueText placeholder="Inherits nothing" />
                </Select.Trigger>
                <Select.IndicatorGroup>
                  <Select.Indicator />
                </Select.IndicatorGroup>
              </Select.Control>
              <Portal>
                <Select.Positioner>
                  <Select.Content>
                    {inheritCollection.items.map((i) => (
                      <Select.Item key={i.value} item={i}>
                        <Select.ItemText>{i.label}</Select.ItemText>
                        <Select.ItemIndicator />
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Portal>
            </Select.Root>
            {parent && (
              <Text fontSize="xs" color="fg.muted">
                Everything {parent.name} grants is included automatically —
                those are ticked and locked below. Untick them on {parent.name}{" "}
                if you want them gone from both.
              </Text>
            )}

            {/* PERSPECTIVES. The editor displayed this state — a badge in
                the list, and perspectives are left out of the matrix —
                with no way to set it, so a role could only become one by
                running the install script. */}
            <Box borderTopWidth="1px" borderColor="border" pt={3}>
              <Checkbox.Root
                size="sm"
                checked={isPerspective}
                disabled={!mayDefine}
                onCheckedChange={(d) => setIsPerspective(!!d.checked)}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>
                  <Text fontSize="sm">Offer this role as a perspective</Text>
                </Checkbox.Label>
              </Checkbox.Root>
              <Text fontSize="xs" color="fg.muted" mt={1}>
                A perspective lets somebody look at the app as though they held only
                this role — to see what their people see. It is offered{" "}
                <Em>only to those who already hold it, or a role that
                inherits it</Em>, so taking one can never grant anything: it
                can only ever take access away.
              </Text>
              {/* ORDER IS SET ON ITS OWN TAB, not here.
                  This was a bare number input per role: you typed a
                  position for one role with no sight of the others, so two
                  roles could both be 3, or the sequence could run 1, 2, 7.
                  The Perspective order tab writes every position from one
                  visible list (`PUT /roles/perspectives/order`), which
                  cannot collide — and it is the only place that shows you
                  what the order actually is. Two controls on one field is
                  two places to keep in step. */}
              {isPerspective && (
                <Text fontSize="xs" color="fg.subtle" mt={2}>
                  Placed on the <Em>Perspective order</Em> tab, with the others.
                </Text>
              )}
              {/* THE ICON, chosen here because this is where a role becomes
                  a perspective. The dropdown drew icons before the roles
                  refactor and lost them when the four hardcoded shells
                  became operator-defined roles — the icon lived in the
                  hardcoded list, so it went with it. Now it lives on the
                  role, which is the thing it describes. */}
              {isPerspective && (
                <Box mt={3}>
                  <Text fontSize="xs" color="fg.muted" mb={1.5}>
                    Icon in the picker
                  </Text>
                  {/* Capped and scrollable ONLY when expanded. The two
                      hundred icons behind "Show more" are dozens of rows on
                      a phone, which would push Save and everything under it
                      off the screen — the collapsed twenty are two rows and
                      need no box. The cap does NOT grow with the catalogue:
                      a taller box just moves the same problem. `title` names
                      each glyph, since nothing is labelled. */}
                  <HStack
                    gap={1}
                    wrap="wrap"
                    maxH={showAllIcons ? "11rem" : undefined}
                    overflowY={showAllIcons ? "auto" : undefined}
                    borderWidth={showAllIcons ? "1px" : undefined}
                    borderColor={showAllIcons ? "border.emphasis" : undefined}
                    rounded={showAllIcons ? "md" : undefined}
                    p={showAllIcons ? 1.5 : undefined}
                  >
                    {shownIcons.map((key) => {
                      const chosen = perspectiveIcon === key;
                      return (
                        <Box
                          as="button"
                          key={key}
                          aria-label={key}
                          title={key}
                          onClick={
                            mayDefine
                              ? () => setPerspectiveIconState(chosen ? null : key)
                              : undefined
                          }
                          p={1.5}
                          rounded="md"
                          borderWidth="1px"
                          borderColor={chosen ? "accent.solid" : "border.emphasis"}
                          bg={chosen ? "accent.muted" : "bg.panel"}
                          // NOT `accent.solid` — the gate is right, a solid is a
                          // fill and its ink is `fg.onAccent`, which belongs on
                          // accent.solid, not on accent.muted. There is no
                          // `accent.fg`, so the chosen glyph takes the theme's
                          // full ink; the accent border and fill already carry
                          // the selection, and `fg.default` is legible on
                          // `accent.muted` in every theme because both are
                          // tuned to the same ground.
                          color={chosen ? "fg.default" : "fg.muted"}
                          cursor={mayDefine ? "pointer" : "not-allowed"}
                          _hover={mayDefine ? { bg: chosen ? "accent.muted" : "gray.faint" } : undefined}
                          display="inline-flex"
                        >
                          <PerspectiveGlyph iconKey={key} boxSize={4} />
                        </Box>
                      );
                    })}
                  </HStack>
                  <HStack gap={2} mt={1}>
                    <Text fontSize="xs" color="fg.subtle">
                      Click the chosen one again to clear it.
                    </Text>
                    <Button
                      size="xs"
                      variant="ghost"
                      px={1}
                      onClick={() => {
                        if (!showAllIcons) preloadAllIcons();
                        setShowAllIcons((v) => !v);
                      }}
                    >
                      {showAllIcons ? "Show fewer" : `Show ${PERSPECTIVE_ICONS_MORE.length} more`}
                    </Button>
                  </HStack>
                </Box>
              )}
            </Box>
          </VStack>
        </Card.Body>
      </Card.Root>

      {groups.map((g) => (
        <Card.Root key={g.group} variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <Text fontWeight="semibold" fontSize="sm">
              {g.group}
            </Text>
          </Card.Header>
          <Card.Body py="2" px="3">
            <VStack align="stretch" gap={1.5}>
              {g.entitlements.map((e) => {
                const fromParent = inherited.has(e.id);
                // YOU CANNOT GRANT WHAT YOU DO NOT HOLD (G6). The server
                // refuses it; showing it as unavailable here means the
                // operator learns the rule instead of hitting a refusal.
                const callerHolds = scope.can(e.id as never);
                const locked = !mayDefine || fromParent || !callerHolds;
                return (
                  <HStack key={e.id} align="start" gap={2}>
                    <Checkbox.Root
                      size="sm"
                      checked={fromParent || own.has(e.id)}
                      disabled={locked}
                      onCheckedChange={(d) => {
                        setOwn((prev) => {
                          const next = new Set(prev);
                          if (d.checked) next.add(e.id);
                          else next.delete(e.id);
                          return next;
                        });
                      }}
                      mt={0.5}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                    </Checkbox.Root>
                    <VStack align="start" gap={0} minW={0}>
                      <Text fontSize="sm">{e.copy}</Text>
                      <HStack gap={2}>
                        <Text fontSize="2xs" color="fg.muted" fontFamily="mono">
                          {e.id}
                        </Text>
                        {fromParent && (
                          <Text fontSize="2xs" color="blue.fg">
                            from {parent?.name}
                          </Text>
                        )}
                        {!callerHolds && !fromParent && (
                          <Text fontSize="2xs" color="orange.fg">
                            you don't hold this
                          </Text>
                        )}
                      </HStack>
                    </VStack>
                  </HStack>
                );
              })}
            </VStack>
          </Card.Body>
        </Card.Root>
      ))}

      {mayDefine && (
        <HStack gap={2} wrap="wrap">
          <Button size="sm" onClick={requestSave} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadHolders()}>
            <UsersIcon size={14} /> Who holds this
          </Button>
          {role.suspendedAt ? (
            <Button size="sm" variant="outline" onClick={() => setConfirm("unsuspend")}>
              Un-suspend
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirm("suspend")}>
              Suspend
            </Button>
          )}
          {/* Deleting is possible only from suspended, so there is always a
              reversible step before an irreversible one. */}
          {/* No `!role.isSystem` here any more. That flag means "the install
              script made it", and hiding Delete behind it also hid it for
              Field Clearance and the two "May …" roles. A starter role is
              deletable like any other; `scripts/grant-role.ts` is the way
              back if the one carrying `people.grant-roles` goes. */}
          {role.suspendedAt && (
            <Button size="sm" variant="outline" colorPalette="red" onClick={() => setConfirm("delete")}>
              Delete
            </Button>
          )}
        </HStack>
      )}

      {holders && (
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="0">
            <Text fontWeight="semibold" fontSize="sm">
              Who holds {role.name}
            </Text>
          </Card.Header>
          <Card.Body py="2" px="3">
            {holders.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                Nobody holds this role.
              </Text>
            ) : (
              <VStack align="stretch" gap={1}>
                {holders.map((h, i) => (
                  <HStack key={`${h.userId}-${i}`} gap={2} wrap="wrap">
                    <Text fontSize="sm">{h.displayName || h.email || h.userId}</Text>
                    {/* A territorial grant is not a company-wide one, and a
                        reader who cannot tell them apart will misread a
                        boundary as absolute. */}
                    {/* "Everywhere" answered the wrong question — everywhere
                        WHAT? It means the grant is not tied to a portfolio, which
                        is only obvious once you have seen the other variant.
                        Named for the thing it is, with the explanation on
                        hover for the reader who has not. */}
                    <Badge
                      size="sm"
                      variant="subtle"
                      colorPalette={h.scope === "global" ? "blue" : "purple"}
                      title={
                        h.scope === "global"
                          ? "Held across the whole business — not limited to any portfolio"
                          : `Held only in ${h.portfolioName ?? "this portfolio"}, and in the portfolios beneath it`
                      }
                    >
                      {h.scope === "global" ? "Company-wide" : `${h.portfolioName ?? "a portfolio"} only`}
                    </Badge>
                    {h.suspendedAt && (
                      <Badge size="sm" variant="subtle" colorPalette="orange">
                        Suspended
                      </Badge>
                    )}
                  </HStack>
                ))}
              </VStack>
            )}
          </Card.Body>
        </Card.Root>
      )}

      {/* TYPE THE ROLE NAME to suspend or delete. Both act on everyone
          holding the role at once, not on one row: suspending cuts their
          access immediately, and deleting cascades every grant away with no
          way back except scripts/grant-role.ts. A single click is too cheap
          for that. Un-suspend restores, so it needs no second approval. */}
      {/* THE EDIT THAT LOCKS YOU OUT. Changing a role you hold can remove a
          capability from YOU, and if that capability is `roles.view` the
          screen you would undo it on is the screen you just closed. There
          is no in-app break-glass by design — recovery is re-running
          install-starter-roles against the database — so the last moment
          anyone can catch it is here. */}
      {/* WHAT MOVES, IN THE ROLE'S OWN WORDS.
          A NODE, not a string: `message` renders in one Text, so newlines
          collapse and sixteen capabilities arrive as a single run-on
          paragraph — which is exactly the wall of words nobody reads
          before clicking Save. The ids are exact and the copy is the role
          builder's own, so the line read here is the line that was ticked. */}
      <ConfirmDialog
        open={confirmSave}
        title={`Save changes to ${role.name}?`}
        message=""
        messageNode={
          <VStack align="stretch" gap={2}>
            <Text fontSize="sm">
              {typeof role.holders === "number" && role.holders > 0
                ? `${role.holders} ${role.holders === 1 ? "person holds" : "people hold"} ${role.name}, and anything that inherits it. This takes effect immediately.`
                : `Nobody holds ${role.name} yet, so this changes what it will grant when somebody does.`}
            </Text>
            {detailChanges.length > 0 && (
              <Text fontSize="sm" color="fg.muted">Also: {detailChanges.join(", ")}.</Text>
            )}
            {wouldLose.length > 0 && (
              <Box borderWidth="1px" borderColor="red.emphasized" bg="red.faint" rounded="md" p={2}>
                <Text fontSize="sm" color="red.fg">
                  This takes {wouldLose.length === 1 ? "a capability" : `${wouldLose.length} capabilities`} away from
                  your own account: {wouldLose.join(", ")}. If this role is how you hold
                  {wouldLose.length === 1 ? " it" : " them"}, you lose
                  {wouldLose.length === 1 ? " it" : " them"} the moment you save — including the
                  ability to come back to this screen and undo it.
                </Text>
              </Box>
            )}
            {(addedEnts.length > 0 || removedEnts.length > 0) && (
              <Box maxH="56" overflowY="auto" borderWidth="1px" borderColor="border" rounded="md" p={2}>
                {removedEnts.length > 0 && (
                  <>
                    <Text fontSize="2xs" fontWeight="semibold" color="red.fg" textTransform="uppercase" letterSpacing="wide">
                      Removing {removedEnts.length}
                    </Text>
                    <VStack align="stretch" gap={0.5} mb={removedEnts.length && addedEnts.length ? 2 : 0}>
                      {removedEnts.map((e) => (
                        <HStack key={e} gap={1.5} align="start">
                          <Text fontSize="sm" color="red.fg" lineHeight="1.3">&minus;</Text>
                          <Box minW={0}>
                            <Text fontSize="sm" lineHeight="1.3">{copyFor(e)}</Text>
                            <Text fontSize="2xs" color="fg.muted" fontFamily="mono">{e}</Text>
                          </Box>
                        </HStack>
                      ))}
                    </VStack>
                  </>
                )}
                {addedEnts.length > 0 && (
                  <>
                    <Text fontSize="2xs" fontWeight="semibold" color="green.fg" textTransform="uppercase" letterSpacing="wide">
                      Adding {addedEnts.length}
                    </Text>
                    <VStack align="stretch" gap={0.5}>
                      {addedEnts.map((e) => (
                        <HStack key={e} gap={1.5} align="start">
                          <Text fontSize="sm" color="green.fg" lineHeight="1.3">+</Text>
                          <Box minW={0}>
                            <Text fontSize="sm" lineHeight="1.3">{copyFor(e)}</Text>
                            <Text fontSize="2xs" color="fg.muted" fontFamily="mono">{e}</Text>
                          </Box>
                        </HStack>
                      ))}
                    </VStack>
                  </>
                )}
              </Box>
            )}
          </VStack>
        }
        confirmLabel={wouldLose.length ? "Save anyway" : "Save"}
        confirmColorPalette={wouldLose.length || removedEnts.length ? "red" : "blue"}
        onConfirm={() => { setConfirmSave(false); void save(); }}
        onCancel={() => setConfirmSave(false)}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "delete"
            ? `Delete ${role.name}?`
            : confirm === "suspend"
              ? `Suspend ${role.name}?`
              : `Un-suspend ${role.name}?`
        }
        message={
          confirm === "delete"
            ? `Permanently delete ${role.name}. This cannot be undone. Anyone still holding it loses everything it granted.`
            : confirm === "suspend"
              ? `Switch ${role.name} off for everyone at once. Nobody holding it keeps what it grants, and any screen that needed it disappears for them. The grants themselves are kept, so un-suspending restores everyone.`
              : `Switch ${role.name} back on. Everyone who still holds it gets what it grants again.`
        }
        confirmLabel={confirm === "delete" ? "Delete role" : confirm === "suspend" ? "Suspend" : "Un-suspend"}
        confirmColorPalette={confirm === "unsuspend" ? "green" : "red"}
        {...(confirm === "unsuspend" ? {} : { requiredInputValue: role.name })}
        inputLabel={confirm === "unsuspend" ? undefined : `Type ${role.name} to confirm`}
        onConfirm={async () => {
          const what = confirm;
          setConfirm(null);
          if (what) await act(what);
        }}
        onCancel={() => setConfirm(null)}
      />
    </VStack>
  );
}

/**
 * Every role against every capability.
 *
 * Generated — the columns come from `GET /roles` and the rows from
 * `GET /entitlements`, which are the same two things the server resolves a
 * request against. There is deliberately no hand-written copy of "what an
 * admin can do" anywhere in this file.
 *
 * It shows EFFECTIVE sets, inheritance resolved, because that is what a
 * request is judged by. A tick that came from a parent is shown differently
 * from one the role writes itself, so "where do I change this?" has an
 * answer without opening the editor.
 */
type DirectoryUser = {
  id: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
  isApproved?: boolean;
  /** Only present when the caller holds `people.manage` — see GET /users. */
  roleGrants?: Array<{
    roleId: string;
    key: string | null;
    name: string;
    portfolioId: string | null;
    portfolioName: string | null;
    isTemporary: boolean;
  }>;
  capabilities?: string[];
  /** An ACTIVE ClientContact for this Clerk id — a customer's login. */
  isClientContact?: boolean;
};

/**
 * WHO HOLDS WHAT — the matrix read the other way round.
 *
 * The matrix answers "what does this role grant". This answers "what can
 * this person actually do", which is the question asked when somebody says a
 * button is missing. Both are generated from the same two server sources the
 * matrix uses, so neither can drift into a second opinion.
 *
 * It needs `people.manage`: `GET /users` strips `roleGrants` and
 * `capabilities` from the response for anyone below that, so the view has
 * nothing to show and the sub-tab is not offered. The gate names the
 * capability of the endpoint it calls, not a role.
 */
function PeopleRoles({
  groups,
  roles,
  onOpenRole,
}: {
  groups: EntitlementGroup[];
  roles: RoleRow[];
  onOpenRole: (roleId: string) => void;
}) {
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  // CUSTOMERS ARE HIDDEN BY DEFAULT, and that is not cosmetic. A client
  // contact's login is an ordinary User row with no worker type, so on this
  // screen it is indistinguishable from a staff account nobody finished
  // setting up. In production twenty of twenty-seven logins are customers:
  // shown by default they bury the handful of real gaps under rows that are
  // working exactly as intended.
  const [showCustomers, setShowCustomers] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = await apiGet<DirectoryUser[]>("/api/users");
        if (live) setUsers(rows);
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load people.", err) });
        if (live) setUsers([]);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);

  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const copyOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const e of g.entitlements) m.set(e.id, e.copy);
    return m;
  }, [groups]);

  const all = useMemo(
    () => [...(users ?? [])].sort((a, b) =>
      (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? "")),
    [users],
  );
  // One definition, shared with UsersTab — see lib/people.ts. A customer who
  // ALSO works for you has a worker type and is staff here too, badge and all.
  const customerOnly = all.filter(isCustomerOnly);
  const sorted = showCustomers ? all : all.filter((u) => !isCustomerOnly(u));

  if (loading) {
    return <Box py={8} textAlign="center"><Spinner /></Box>;
  }

  // Only STAFF can be "missing" a role. A customer holding none is the
  // system working: their portal is gated on being a client contact, which
  // never consults roles.
  const roleless = all.filter((u) => !isCustomerOnly(u) && (u.roleGrants ?? []).length === 0);

  return (
    <VStack align="stretch" gap={3}>
      <HStack gap={3} wrap="wrap">
        <Text fontSize="sm" color="fg.muted">
          {sorted.length} {sorted.length === 1 ? "person" : "people"}
        </Text>
        {roleless.length > 0 && (
          <Badge colorPalette="orange" variant="subtle">
            {roleless.length} staff hold no role
          </Badge>
        )}
        {customerOnly.length > 0 && (
          <Checkbox.Root
            size="sm"
            checked={showCustomers}
            onCheckedChange={(e) => setShowCustomers(!!e.checked)}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>
              <Text fontSize="xs" color="fg.muted">
                Show {customerOnly.length} customer {customerOnly.length === 1 ? "login" : "logins"}
              </Text>
            </Checkbox.Label>
          </Checkbox.Root>
        )}
      </HStack>

      {/* AN PORTFOLIO GRANT IS NOT A SMALLER COMPANY-WIDE GRANT, and the count
          must not imply it is. `GET /users` resolves `capabilities` from
          company-wide grants only, because what a portfolio grant permits
          depends on the portfolio of the RECORD being acted on and there is no
          record here. Portfolio roles are listed, badged with their portfolio, and
          left out of the number. */}
      <Text fontSize="xs" color="fg.muted">
        Capability counts cover company-wide grants. A role granted in one portfolio is
        shown with that portfolio and is not counted, because what it allows depends on
        where the work is.
      </Text>

      <Box overflowX="auto">
        <Table.Root size="sm" stickyHeader>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader minW="48">Person</Table.ColumnHeader>
              <Table.ColumnHeader whiteSpace="nowrap">Pay class</Table.ColumnHeader>
              <Table.ColumnHeader minW="56">Roles</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right" whiteSpace="nowrap">Capabilities</Table.ColumnHeader>
              <Table.ColumnHeader />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sorted.map((u) => {
              const grants = u.roleGrants ?? [];
              const customerOnlyRow = isCustomerOnly(u);
              const isOpen = expanded === u.id;
              return (
                <Fragment key={u.id}>
                  <Table.Row
                    cursor="pointer"
                    onClick={() => setExpanded(isOpen ? null : u.id)}
                  >
                    <Table.Cell>
                      <HStack gap={1.5} wrap="wrap">
                        <Text fontSize="sm">{u.displayName ?? u.email ?? u.id}</Text>
                        {u.isClientContact && (
                          <Badge
                            size="sm"
                            variant="subtle"
                            colorPalette="cyan"
                            title="This login belongs to a customer — an active client contact"
                          >
                            Customer
                          </Badge>
                        )}
                      </HStack>
                      {u.email && u.displayName && (
                        <Text fontSize="2xs" color="fg.muted">{u.email}</Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {/* The same label the rest of the app uses, so a pay
                          class reads identically here and on a visit card.
                          An untyped CUSTOMER is not a gap — it is what a
                          customer looks like — so it is not flagged. */}
                      <Text
                        fontSize="xs"
                        color={u.workerType ? "fg.muted" : customerOnlyRow ? "fg.muted" : "orange.fg"}
                      >
                        {u.workerType
                          ? payClassLabel(u.workerType as Parameters<typeof payClassLabel>[0])
                          : customerOnlyRow ? "Customer login" : "No worker type"}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      {grants.length === 0 ? (
                        customerOnlyRow ? (
                          <Text fontSize="xs" color="fg.muted">—</Text>
                        ) : (
                          <Badge colorPalette="orange" variant="subtle" size="sm">No roles</Badge>
                        )
                      ) : (
                        <HStack gap={1} wrap="wrap">
                          {grants.map((g) => (
                            <Badge
                              key={`${g.roleId}:${g.portfolioId ?? "all"}`}
                              size="sm"
                              variant={g.portfolioId ? "outline" : "subtle"}
                              colorPalette={g.portfolioId ? "purple" : "teal"}
                              title={g.portfolioId
                                ? `Granted in ${g.portfolioName} only${g.isTemporary ? " (temporary)" : ""}`
                                : "Granted company-wide"}
                            >
                              {g.name}{g.portfolioId ? ` · ${g.portfolioName}` : ""}
                              {g.isTemporary ? " ·  temp" : ""}
                            </Badge>
                          ))}
                        </HStack>
                      )}
                    </Table.Cell>
                    <Table.Cell textAlign="right">
                      <Text fontSize="sm" fontVariantNumeric="tabular-nums">
                        {(u.capabilities ?? []).length}
                      </Text>
                    </Table.Cell>
                    <Table.Cell textAlign="right">
                      <Icon as={isOpen ? ChevronUp : ChevronDown} boxSize={4} color="fg.muted" />
                    </Table.Cell>
                  </Table.Row>

                  {isOpen && (
                    <Table.Row>
                      <Table.Cell colSpan={5} bg="bg.muted">
                        {grants.length === 0 ? (
                          customerOnlyRow ? (
                            <Text fontSize="sm" color="fg.muted">
                              A customer&rsquo;s login. It needs no role: the client portal is
                              gated on being an active contact, which never looks at roles, and
                              the staff app is closed to anyone with no worker type. If this
                              person also works for you, set a worker type FIRST and then grant
                              a role — a grant made the other way round lies dormant until the
                              worker type appears, and the database refuses it.
                            </Text>
                          ) : (
                            <Text fontSize="sm" color="fg.muted">
                              No role, so no capability — every screen past sign-in is empty
                              for this account. Grant a role from the Roles view, after
                              setting a worker type.
                            </Text>
                          )
                        ) : (
                          <VStack align="stretch" gap={3}>
                            {grants.map((g) => {
                              const role = roleById.get(g.roleId);
                              const own = new Set(role?.own ?? []);
                              const effective = role?.effective ?? [];
                              return (
                                <Box key={`${g.roleId}:${g.portfolioId ?? "all"}`}>
                                  <HStack gap={2} mb={1} wrap="wrap">
                                    <Button
                                      size="xs"
                                      variant="outline"
                                      onClick={() => onOpenRole(g.roleId)}
                                    >
                                      <Shield size={12} /> {g.name}
                                    </Button>
                                    {g.portfolioId && (
                                      <Text fontSize="xs" color="purple.fg">
                                        in {g.portfolioName} only
                                      </Text>
                                    )}
                                    <Text fontSize="xs" color="fg.muted">
                                      {effective.length} {effective.length === 1 ? "capability" : "capabilities"}
                                    </Text>
                                  </HStack>
                                  {effective.length === 0 ? (
                                    <Text fontSize="xs" color="fg.muted">Grants nothing.</Text>
                                  ) : (
                                    <HStack gap={1} wrap="wrap">
                                      {effective.map((id) => (
                                        <Badge
                                          key={id}
                                          size="sm"
                                          variant="subtle"
                                          colorPalette={own.has(id) ? "green" : "blue"}
                                          title={`${id} — ${own.has(id) ? "granted by this role" : "inherited"}`}
                                        >
                                          {copyOf.get(id) ?? id}
                                        </Badge>
                                      ))}
                                    </HStack>
                                  )}
                                </Box>
                              );
                            })}
                            <Text fontSize="2xs" color="fg.muted">
                              Green is granted by the role itself, blue is inherited from the
                              role it builds on.
                            </Text>
                          </VStack>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Fragment>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}

function EntitlementMatrix({ groups, roles }: { groups: EntitlementGroup[]; roles: RoleRow[] }) {
  // EVERY ROLE, including the ladder.
  //
  // This filtered on `!r.isPerspective`, which asks a different question
  // entirely — "is this offered as a lens you can view the app through" —
  // and the four starter rungs plus any operator role marked as a
  // perspective all answer yes. So the one table in the app whose job is
  // "which role grants what" was hiding Trainee, Worker, Admin and Super,
  // and showing only the add-ons and the two off-ladder examples. The
  // ladder is the most useful thing here, not the least: the cells already
  // separate a role's OWN grant (green) from an inherited one (blue), and
  // inheritance is what the chain is made of.
  //
  // Ordered rungs-first by `perspectiveOrder` so the table reads up the
  // chain, then everything else by name.
  const shown = [...roles].sort((a, b) => {
    const ao = a.perspectiveOrder ?? Number.POSITIVE_INFINITY;
    const bo = b.perspectiveOrder ?? Number.POSITIVE_INFINITY;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
  });
  return (
    <Box overflowX="auto">
      <Table.Root size="sm" stickyHeader>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader minW="64">Capability</Table.ColumnHeader>
            {shown.map((r) => (
              <Table.ColumnHeader key={r.id} textAlign="center" whiteSpace="nowrap">
                {r.name}
              </Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {groups.map((g) => (
            <Fragment key={g.group}>
              <Table.Row>
                <Table.Cell colSpan={shown.length + 1} bg="bg.muted">
                  <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                    {g.group}
                  </Text>
                </Table.Cell>
              </Table.Row>
              {g.entitlements.map((e) => (
                <Table.Row key={e.id}>
                  <Table.Cell>
                    <Text fontSize="sm">{e.copy}</Text>
                    <Text fontSize="2xs" color="fg.muted" fontFamily="mono">
                      {e.id}
                    </Text>
                  </Table.Cell>
                  {shown.map((r) => {
                    const has = r.effective.includes(e.id);
                    const ownIt = r.own.includes(e.id);
                    return (
                      <Table.Cell key={r.id} textAlign="center">
                        {/* GREEN YES, RED NO — and the yes still says which
                            KIND of yes. Colour alone used to carry that
                            (green granted here, blue inherited), so turning
                            every tick green would have thrown the
                            distinction away. It moves to the GLYPH instead:
                            a ringed tick is granted by this role, a bare
                            tick is inherited. The "no" was `fg.subtle` at
                            12px, which is why the grid read as mostly
                            blank. */}
                        {has ? (
                          <Box
                            as="span"
                            color="green.fg"
                            title={ownIt ? "Granted by this role" : "Inherited from the role it builds on"}
                            display="inline-flex"
                          >
                            {ownIt ? <CheckCircle2 size={16} /> : <Check size={16} />}
                          </Box>
                        ) : (
                          <Box
                            as="span"
                            color="red.fg"
                            title="Not granted"
                            display="inline-flex"
                          >
                            <X size={15} />
                          </Box>
                        )}
                      </Table.Cell>
                    );
                  })}
                </Table.Row>
              ))}
            </Fragment>
          ))}
        </Table.Body>
      </Table.Root>
      <HStack gap={4} mt={2} wrap="wrap">
        <HStack gap={1}>
          <Box as="span" color="green.fg" display="inline-flex">
            <CheckCircle2 size={14} />
          </Box>
          <Text fontSize="xs" color="fg.muted">
            granted by this role
          </Text>
        </HStack>
        <HStack gap={1}>
          <Box as="span" color="green.fg" display="inline-flex">
            <Check size={14} />
          </Box>
          <Text fontSize="xs" color="fg.muted">
            inherited
          </Text>
        </HStack>
        <HStack gap={1}>
          <Box as="span" color="red.fg" display="inline-flex">
            <X size={14} />
          </Box>
          <Text fontSize="xs" color="fg.muted">
            not granted
          </Text>
        </HStack>
      </HStack>
    </Box>
  );
}
