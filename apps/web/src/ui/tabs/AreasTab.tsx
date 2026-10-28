"use client";

/**
 * AREAS — the places the business works, and who looks after each one.
 *
 * An area grant is an ordinary role grant that happens to carry a place: the
 * same role, confined to one branch of the tree. It is not a weaker role and
 * not a different one, which is why this screen shows the role name and the
 * area side by side rather than inventing a vocabulary ("regional admin")
 * that exists nowhere in the model.
 *
 * TWO RULES THE UI HAS TO CARRY, because both are surprising:
 *
 *   · An area is never REPARENTED (G14). Every area-scoped query matches on
 *     the materialized path, so moving a subtree would silently change what
 *     history says happened where. The way to move work is copy-and-retire,
 *     and the absence of a "move" control is deliberate.
 *   · A company-wide grant beats an area one. Somebody who holds a role
 *     everywhere does not become narrower by also being assigned to Durham.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Icon,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight, MapPin, Plus } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { openEventSearch } from "@/src/lib/bus";
// Loaded normally: it imports Leaflet lazily inside an effect, so the
// library itself is still kept off the server render and off the
// bundle of anyone who never opens the map.
import AreaPropertyMap from "@/src/ui/components/AreaPropertyMap";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";
import { usePersistedState } from "@/src/lib/usePersistedState";

type Area = {
  id: string;
  name: string;
  tier: string | null;
  parentId: string | null;
  path: string;
  lat: number | null;
  lng: number | null;
  retiredAt: string | null;
  depth: number;
  _count: { properties: number; occurrences: number; assignments: number };
};

type Assignment = {
  id: string;
  userId: string;
  isTemporary: boolean;
  note: string | null;
  suspendedAt: string | null;
  user: { id: string; displayName: string | null; email: string | null };
  area: { id: string; name: string; path: string; retiredAt: string | null };
  customRole: { id: string; name: string; suspendedAt: string | null };
};

type RoleOption = { id: string; name: string; isPerspective: boolean; suspendedAt: string | null };
type UserOption = { id: string; displayName: string | null; email: string | null };

/** Read AREA_TIER_NAMES out of the settings payload, tolerating anything. */
function parseTierNames(rows: Array<{ key: string; value: string }>): string[] {
  const raw = (Array.isArray(rows) ? rows : []).find((r) => r.key === "AREA_TIER_NAMES")?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // A malformed taxonomy must degrade to "no suggestions", never throw and
    // take the whole tree down with it.
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default function AreasTab({ scope }: { scope: Scope }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Set once the reader taps an area, so the detail knows to scroll into
   *  view on a phone — an automatic selection must not. */
  const pickedRef = useRef(false);
  const [showRetired, setShowRetired] = useState(false);
  const [tierNames, setTierNames] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, asg, r, u, settings] = await Promise.all([
        apiGet<Area[]>("/api/areas"),
        apiGet<Assignment[]>("/api/area-assignments"),
        // The picker needs the role catalogue; a caller without `roles.view`
        // still gets the tree, just no assignment control.
        apiGet<RoleOption[]>("/api/roles").catch(() => [] as RoleOption[]),
        // STAFF ONLY — an area grant on a login with no worker type is the
        // dormant grant the database refuses outright (G45), so offering a
        // customer here could only ever end in an error.
        apiGet<UserOption[]>("/api/users?approved=true&hasWorkerType=true").catch(() => [] as UserOption[]),
        // Tier names are a suggestion list. Failing to load them must not
        // block the tree — the field falls back to free text.
        apiGet<Array<{ key: string; value: string }>>("/api/settings").catch(
          () => [] as Array<{ key: string; value: string }>,
        ),
      ]);
      setAreas(a);
      setAssignments(asg);
      setRoles(r);
      setUsers(u);
      setTierNames(parseTierNames(settings));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load areas.", err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // COLLAPSED ids, not expanded ones. Default-open: a tree that arrives
  // folded hides the thing the screen is for, and the ids of areas that do
  // not exist yet cannot be in a default-expanded list — so new areas
  // appear, which is the behaviour you want from a fixture that grows.
  const [collapsed, setCollapsed] = usePersistedState<string[]>("areasTab_collapsed", []);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const toggleCollapsed = useCallback(
    (id: string) =>
      setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [setCollapsed],
  );

  /**
   * Rolled-up property counts, keyed by area id.
   *
   * Computed here rather than asked of the server: the whole tree is
   * already on the client with each node's own count and its materialized
   * path, and a subtree total is a prefix sum over that. An endpoint
   * returning it would be a second source for a number this page can derive
   * exactly.
   */
  const rollup = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of areas) {
      out[a.id] = areas
        .filter((x) => x.path.startsWith(a.path))
        .reduce((n, x) => n + x._count.properties, 0);
    }
    return out;
  }, [areas]);

  /** Which areas have at least one child that is currently listable. */
  const hasChildren = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const a of areas) {
      if (a.parentId && (showRetired || !a.retiredAt)) out[a.parentId] = true;
    }
    return out;
  }, [areas, showRetired]);

  /** The sole root — same test the detail pane and the lens picker use. */
  const isRootRow = useCallback(
    (a: Area) => a.parentId === null && areas.filter((x) => x.parentId === null).length === 1,
    [areas],
  );

  const visible = useMemo(() => {
    const shown = areas.filter((a) => showRetired || !a.retiredAt);
    // Hide anything BENEATH a collapsed node, at any depth — folding a
    // region has to take its districts' routes with it, not just the
    // districts. The path makes that a prefix test rather than a walk.
    const collapsedPaths = shown.filter((a) => collapsedSet.has(a.id)).map((a) => a.path);
    return shown.filter(
      (a) => !collapsedPaths.some((p) => a.path.startsWith(p) && a.path !== p),
    );
  }, [areas, showRetired, collapsedSet]);
  const selected = useMemo(
    () => areas.find((a) => a.id === selectedId) ?? null,
    [areas, selectedId],
  );

  return (
    <VStack align="stretch" gap={3}>
      {/* Above the loading gate on purpose: the breadcrumb drives the
          explainer, so a tab that mounts it only after its data arrives has
          an "i" icon that does nothing on first paint. */}
      <TabExplainer explainerId="seedlings:areasTab:guideOpen">
        <ExplainerText>
          An area is a place the business works. Give somebody a role{" "}
          <Em>in an area</Em> and they hold it there and nowhere else — the
          same role, confined to one branch of this tree and everything under
          it.
        </ExplainerText>
        <ExplainerText>
          <Em>Holding a role everywhere beats holding it somewhere.</Em> If
          somebody already has it company-wide, adding an area assignment
          changes nothing for them.
        </ExplainerText>
        <ExplainerText>
          <Em>Areas never move.</Em> There is no reparent control, on purpose:
          every record remembers where it happened by the area's position, so
          moving one would rewrite history. To reorganise, create the new area
          and retire the old one.
        </ExplainerText>
      </TabExplainer>

      {loading ? (
        <Box py={8} textAlign="center">
          <Spinner />
        </Box>
      ) : (
      <>
      <HStack gap={2} wrap="wrap">
        {scope.can("areas.manage") && (
          <NewAreaButton areas={areas} tierNames={tierNames} onCreated={load} />
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowRetired((v) => !v)}>
          {showRetired ? "Hide retired" : "Show retired"}
        </Button>
      </HStack>

      {visible.length === 0 ? (
        <Card.Root variant="outline">
          <Card.Body py="6" px="3">
            <VStack gap={1}>
              <MapPin size={20} />
              <Text fontSize="sm" fontWeight="semibold">
                No areas yet
              </Text>
              <Text fontSize="xs" color="fg.muted" textAlign="center">
                Until there is at least one area, every role is held
                company-wide. That is a valid way to run the business — add
                areas only when somebody should see one part of it and not
                another.
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      ) : (
        <HStack align="start" gap={4} wrap={{ base: "wrap", lg: "nowrap" }}>
          <VStack align="stretch" gap={1} minW={{ base: "full", lg: "72" }} maxW={{ lg: "72" }} w="full">
            {visible.map((a) => {
              const total = rollup[a.id] ?? a._count.properties;
              const own = a._count.properties;
              const branch = !!hasChildren[a.id];
              const isCollapsed = collapsedSet.has(a.id);
              return (
              <Box
                key={a.id}
                // INDENT IS MARGIN, NOT PADDING.
                //
                // It was `pl` inside the card, so every row's rectangle
                // started at the same x and only the text moved — which
                // reads as ragged text, not as a hierarchy. As margin the
                // CARD steps in, and the nesting is legible from the shape
                // of the column without reading a word of it.
                //
                // Depth comes from the materialized path, already computed
                // by the server — the tree is rendered without re-walking it.
                ml={`${a.depth * 20}px`}
                rounded="md"
                borderWidth="1px"
                borderColor={a.id === selectedId ? "blue.emphasized" : "border"}
                bg={a.id === selectedId ? "blue.faint" : "bg.panel"}
                opacity={a.retiredAt ? 0.6 : 1}
              >
                <HStack gap={0} align="stretch">
                  {/* The twisty is its OWN button, beside the row's button
                      rather than inside it — folding a branch and selecting
                      it are different intents, and nesting one button in
                      another is invalid markup that swallows the inner
                      click. A leaf gets a spacer of the same width so every
                      name at a given depth still starts at the same x. */}
                  {branch ? (
                    <Box
                      as="button"
                      aria-label={isCollapsed ? `Expand ${a.name}` : `Collapse ${a.name}`}
                      aria-expanded={!isCollapsed}
                      data-testid={`area-twisty-${a.id}`}
                      onClick={(e: any) => { e.stopPropagation(); toggleCollapsed(a.id); }}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      w="24px"
                      flexShrink={0}
                      color="fg.muted"
                      cursor="pointer"
                      _hover={{ color: "fg" }}
                      borderLeftRadius="md"
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </Box>
                  ) : (
                    <Box w="24px" flexShrink={0} />
                  )}

                  <Box
                    as="button"
                    textAlign="left"
                    flex="1"
                    minW={0}
                    pr={2}
                    py={1.5}
                    cursor="pointer"
                    onClick={() => { pickedRef.current = true; setSelectedId(a.id); }}
                  >
                    <HStack justify="space-between" gap={2}>
                      <HStack gap={1.5} minW={0}>
                        <Text fontSize="sm" fontWeight={a.depth === 0 ? "semibold" : "normal"} truncate>
                          {a.name}
                        </Text>
                        {a.tier && (
                          <Text fontSize="2xs" color="fg.muted" flexShrink={0}>
                            {a.tier}
                          </Text>
                        )}
                        {a.retiredAt && (
                          <Badge size="sm" variant="subtle" colorPalette="orange">
                            Retired
                          </Badge>
                        )}
                      </HStack>
                      {/* THE HEADLINE NUMBER IS THE ROLLUP — what is in
                          here at all — with the directly-tagged count in
                          parentheses after it. That order matters: scanning
                          the column for "where is the work" should land on
                          the total, and the own-count is the follow-up
                          question.
                          Only shown when the two differ. A leaf has nothing
                          below it, and a branch whose children are all
                          empty is telling the truth with one number; "(9
                          own)" after "9 properties" is noise either way.
                          THE SOLE ROOT NEVER SHOWS IT. It is the container,
                          not a place — it has no tier, no coordinates and
                          nobody in charge of it, so "owned by the root" is
                          not a thing that can be true. Its number is simply
                          everything. */}
                      <Text fontSize="2xs" color="fg.muted" flexShrink={0} whiteSpace="nowrap">
                        {total} propert{total === 1 ? "y" : "ies"}
                        {!isRootRow(a) && total !== own && ` (${own} own)`}
                      </Text>
                    </HStack>
                  </Box>
                </HStack>
              </Box>
              );
            })}
          </VStack>

          {selected && (
            <AreaDetail
              key={selected.id}
              scrollOnMount={pickedRef.current}
              area={selected}
              // A SOLE ROOT IS NOT A PLACE. Same test the lens picker uses
              // to leave it out: its path prefixes every area, so it is the
              // container, not a territory. Computed here because only this
              // level can see the whole tree.
              isSoleRoot={areas.filter((a) => a.parentId === null).length === 1 && selected.parentId === null}
              assignments={assignments.filter((x) => x.area.id === selected.id)}
              roles={roles}
              users={users}
              tierNames={tierNames}
              scope={scope}
              onChanged={load}
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
 * Tier picker — SUGGESTIONS, not a vocabulary.
 *
 * `Area.tier` is a free string and stays one: an operator who runs "Zones"
 * rather than "Districts" must not have to ask us to add it. What the
 * `AREA_TIER_NAMES` taxonomy buys is SPELLING — two people naming the same
 * level the same way, so the tree reads consistently.
 *
 * So the control is a Select over the configured names plus an "Other"
 * escape that reveals a text box, the same shape the Payment From picker
 * uses. Never a native <select>.
 */
const TIER_OTHER = "__other__";

function TierField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  // A saved tier that is not in the taxonomy is not an error — the operator
  // typed it before the list existed, or deliberately went off-list. Start
  // in free-text mode so it is visible and editable rather than silently
  // reset to blank by a Select that cannot represent it.
  const [other, setOther] = useState(() => !!value && !options.includes(value));
  const collection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "(none)", value: "" },
          ...options.map((t) => ({ label: t, value: t })),
          { label: "Other (specify…)", value: TIER_OTHER },
        ],
      }),
    [options],
  );
  if (other) {
    return (
      <HStack gap={2}>
        <Input
          size="sm"
          placeholder="Tier — e.g. County, Route"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setOther(false); onChange(""); }}
        >
          Use list
        </Button>
      </HStack>
    );
  }
  return (
    <Select.Root
      size="sm"
      collection={collection}
      value={[value]}
      onValueChange={(e) => {
        const v = e.value[0] ?? "";
        if (v === TIER_OTHER) { setOther(true); onChange(""); return; }
        onChange(v);
      }}
    >
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder="Tier (optional)" />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content>
            {collection.items.map((it) => (
              <Select.Item item={it} key={it.value}>
                {it.label}
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

function NewAreaButton({ areas, tierNames, onCreated }: { areas: Area[]; tierNames: string[]; onCreated: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tier, setTier] = useState("");
  // EVERY AREA SITS INSIDE ANOTHER ONE. "At the top level" is offered only
  // to bootstrap an empty tree — a second root would split the hierarchy in
  // two, and area scoping is a path-prefix match, so there would then be no
  // single prefix meaning "everywhere". The server refuses it too; this is
  // so the choice is never presented rather than refused after the fact.
  const root = areas.find((a) => a.parentId === null) ?? null;
  const [parentId, setParentId] = useState<string | null>(root?.id ?? null);
  const [busy, setBusy] = useState(false);

  const parentCollection = createListCollection({
    items: [
      ...(root ? [] : [{ label: "At the top level", value: "" }]),
      ...areas
        .filter((a) => !a.retiredAt)
        .map((a) => ({ label: `${"— ".repeat(a.depth)}${a.name}`, value: a.id })),
    ],
  });

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await apiPost("/api/areas", {
        name: name.trim(),
        tier: tier.trim() || null,
        parentId,
      });
      publishInlineMessage({ type: "SUCCESS", text: `Created ${name.trim()}.` });
      setOpen(false);
      setName("");
      setTier("");
      setParentId(null);
      await onCreated();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't create the area.", err) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus size={14} /> New area
      </Button>
    );
  }

  return (
    <Card.Root variant="outline" w="full">
      <Card.Body py="3" px="3">
        <VStack align="stretch" gap={2}>
          <Input size="sm" placeholder="Area name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <TierField value={tier} onChange={setTier} options={tierNames} />
          <Select.Root
            size="sm"
            collection={parentCollection}
            value={[parentId ?? ""]}
            onValueChange={(e) => setParentId(e.value[0] || null)}
          >
            <Select.HiddenSelect />
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder="At the top level" />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {parentCollection.items.map((i) => (
                    <Select.Item key={i.value} item={i}>
                      <Select.ItemText>{i.label}</Select.ItemText>
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
          </Select.Root>
          <Text fontSize="xs" color="fg.muted">
            Choose the parent carefully — an area cannot be moved afterwards.
          </Text>
          <HStack gap={2}>
            <Button size="xs" onClick={create} disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </HStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function AreaDetail({
  area,
  isSoleRoot,
  assignments,
  roles,
  users,
  tierNames,
  scope,
  onChanged,
  scrollOnMount,
}: {
  /** True when this panel opened because somebody tapped an area. */
  scrollOnMount?: boolean;
  area: Area;
  /** The one root of a single-rooted tree — "All areas" in the stock setup. */
  isSoleRoot: boolean;
  assignments: Assignment[];
  roles: RoleOption[];
  users: UserOption[];
  tierNames: string[];
  scope: Scope;
  onChanged: () => void | Promise<void>;
}) {
  const mayManage = scope.can("areas.manage");

  /**
   * Bring the panel into view on a phone — see RoleEditor, same reasoning.
   * The detail renders BELOW the whole tree there, so a tap changed
   * something off-screen. Only on a deliberate pick: an area is selected
   * automatically, and scrolling on that would jump past the tree every
   * time the tab is opened.
   */
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollOnMount) return;
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 992) return; // Chakra's `lg`, where tree and detail sit side by side
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollOnMount]);
  const [name, setName] = useState(area.name);
  const [tier, setTier] = useState(area.tier ?? "");
  // Held as STRINGS, not numbers. These are text boxes: an operator midway
  // through typing "-79." has a value that is not a number yet, and parsing
  // on every keystroke would either reject it or silently rewrite what they
  // typed. Parsed once, on save.
  const [lat, setLat] = useState(area.lat == null ? "" : String(area.lat));
  const [lng, setLng] = useState(area.lng == null ? "" : String(area.lng));
  const [userId, setUserId] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: "retire" | "unretire" } | { kind: "revoke"; id: string; who: string; role: string } | null
  >(null);

  const dirty =
    name !== area.name ||
    (!isSoleRoot && tier !== (area.tier ?? "")) ||
    (!isSoleRoot &&
      (lat !== (area.lat == null ? "" : String(area.lat)) ||
        lng !== (area.lng == null ? "" : String(area.lng))));

  // Both or neither — the same rule the server enforces, said here so the
  // operator finds out before they press Save rather than after.
  const halfAPoint = !isSoleRoot && (lat.trim() === "") !== (lng.trim() === "");

  const userCollection = createListCollection({
    items: users.map((u) => ({ label: u.displayName || u.email || u.id, value: u.id })),
  });
  const roleCollection = createListCollection({
    items: roles
      // A perspective is something you take on roles you already hold, not something
      // to assign; a suspended role would grant nothing and the server
      // refuses it.
      .filter((r) => !r.isPerspective && !r.suspendedAt)
      .map((r) => ({ label: r.name, value: r.id })),
  });

  async function rename() {
    try {
      await apiPatch(`/api/areas/${area.id}`, {
        name,
        // Both of these are omitted on a sole root, where neither control is
        // shown. A form that never offered the field must not write through
        // it — sending `tier: null` here would silently clear a value nobody
        // on this screen could see, which is a different act from the
        // operator clearing it.
        ...(isSoleRoot ? {} : { tier: tier.trim() || null }),
        // Sent whenever the fields are SHOWN, so clearing a box clears the
        // stored point — an absent key means "unchanged" to the server,
        // which is not what an emptied field means.
        ...(isSoleRoot
          ? {}
          : {
              lat: lat.trim() === "" ? null : lat.trim(),
              lng: lng.trim() === "" ? null : lng.trim(),
            }),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Area updated." });
      await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't update the area.", err) });
    }
  }

  async function assign() {
    if (!userId || !roleId) return;
    try {
      await apiPost("/api/area-assignments", { userId, areaId: area.id, customRoleId: roleId });
      publishInlineMessage({ type: "SUCCESS", text: "Assigned." });
      setUserId(null);
      setRoleId(null);
      await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't assign.", err) });
    }
  }

  return (
    <VStack align="stretch" gap={3} flex="1" minW={0}>
      {/* WHERE THE TREE ENDS AND THE DETAIL BEGINS — the same band the role
          editor uses, for the same reason: on a phone the two stack, and
          this panel opened on a bare name Input, so a tap added an
          unlabelled card to a column of cards. Solid rather than tinted, so
          a filled title bar never reads as another tappable row. */}
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
          <Icon as={MapPin} boxSize={4} flexShrink={0} />
          <Box minW={0}>
            <Text
              fontSize="2xs"
              textTransform="uppercase"
              letterSpacing="wide"
              lineHeight="1.2"
            >
              {mayManage ? "Editing area" : "Area details"}
            </Text>
            <Text fontSize="sm" fontWeight="semibold" truncate>
              {area.name}
            </Text>
          </Box>
        </HStack>
      </Box>
      <Card.Root variant="outline">
        <Card.Body py="3" px="3">
          <VStack align="stretch" gap={2}>
            <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} disabled={!mayManage} />
            {/* NO TIER ON A SOLE ROOT either, for the same reason as the
                coordinates below: it is the container, not a place. A tier
                is what distinguishes one level of territory from another —
                Region above District — and the node that holds every
                territory is not itself one of them. It rendered as a
                dropdown reading "(none)", which invites a choice that
                describes nothing. */}
            {!isSoleRoot &&
              (mayManage ? (
                <TierField value={tier} onChange={setTier} options={tierNames} />
              ) : (
                <Input size="sm" value={tier} placeholder="Tier (optional)" disabled />
              ))}
            {/* WHERE THIS TERRITORY IS, for the weather forecast.
                Optional: blank means the forecast falls back to the business
                address, which is what it did before areas existed.

                NOT OFFERED ON A SOLE ROOT, and the reason is mechanical
                rather than philosophical. The lens picker leaves a sole root
                out — its path prefixes everything, so choosing it filters
                nothing — which means it can never BE the lens, which means
                coordinates on it could never be read by anything. A field
                that cannot affect the app is worse than a missing one: it
                invites somebody to set it and then wonder why the forecast
                ignored them. Say what actually governs instead. */}
            {isSoleRoot ? (
              <Text fontSize="xs" color="fg.muted">
                Weather here uses the business address — this is the whole
                territory, not a place of its own.
              </Text>
            ) : (
            <HStack gap={2} align="start">
              <Input
                size="sm"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="Latitude"
                disabled={!mayManage}
                aria-label="Latitude"
                data-testid="area-lat"
              />
              <Input
                size="sm"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="Longitude"
                disabled={!mayManage}
                aria-label="Longitude"
                data-testid="area-lng"
              />
            </HStack>
            )}
            {!isSoleRoot && (
              <Text fontSize="xs" color={halfAPoint ? "red.fg" : "fg.muted"}>
                {halfAPoint
                  ? "Give both a latitude and a longitude, or clear both."
                  : "The centre of this area — its weather is forecast from here, and the map below marks it. Leave blank to use the business address."}
              </Text>
            )}
            <Text fontSize="xs" color="fg.muted">
              {area._count.properties} properties · {area._count.occurrences} visits ·{" "}
              {area._count.assignments} assignments
            </Text>
            {mayManage && (
              <HStack gap={2} wrap="wrap">
                <Button size="xs" onClick={rename} disabled={!dirty || halfAPoint}>
                  Save
                </Button>
                {/* NO RETIRE ON THE ROOT. It is the tree itself — every
                    path starts with it — so retiring it would close the
                    coordinate system every area-scoped query matches on
                    while leaving every row pointing into it. The server
                    refuses it as well; this is so the button is never
                    there to press. Renaming stays available: the label is
                    free to change because paths are built from ids. */}
                {!isSoleRoot && (
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette={area.retiredAt ? "green" : "red"}
                    onClick={() => setConfirm({ kind: area.retiredAt ? "unretire" : "retire" })}
                  >
                    {area.retiredAt ? "Un-retire" : "Retire"}
                  </Button>
                )}
              </HStack>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* GATED ON THE CAPABILITY THE ROUTE ACTUALLY USES. `GET /properties`
          is guarded on `clients.view`, which somebody holding `areas.manage`
          need not have — and the refusal would arrive as an empty card with
          no explanation, which is the failure G46 exists to catch. Ask, and
          do not make the call if the answer is no. */}
      {scope.can("clients.view") && (
        <AreaProperties areaId={area.id} areaName={area.name} />
      )}

      {/* NOBODY LOOKS AFTER THE ROOT. "This role at the root" and "this role
          company-wide" read as the same sentence and are not the same query:
          a company-wide grant applies NO filter, while a root-scoped one
          filters on `area.path startsWith <root>` — which cannot match a row
          whose areaId is null. Untagged records are allowed, so the two
          diverge the moment one exists, and the symptom is a page that
          renders perfectly with rows missing. The way to say "everywhere" is
          the ordinary role grant on the People tab. The server refuses the
          lookalike too; this is so it is never offered. */}
      {isSoleRoot ? (
        <Card.Root variant="outline">
          <Card.Body py="3" px="3">
            <Text fontSize="xs" color="fg.muted">
              Nobody is put in charge here — this is the whole territory. To give
              somebody access everywhere, grant them the role itself on the
              People tab rather than assigning them to an area.
            </Text>
          </Card.Body>
        </Card.Root>
      ) : (
      <Card.Root variant="outline">
        <Card.Header py="2" px="3" pb="0">
          <Text fontWeight="semibold" fontSize="sm">
            Who looks after {area.name}
          </Text>
        </Card.Header>
        <Card.Body py="2" px="3">
          <VStack align="stretch" gap={2}>
            {assignments.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                Nobody is assigned here.
              </Text>
            ) : (
              assignments.map((a) => (
                <HStack key={a.id} justify="space-between" gap={2} wrap="wrap">
                  <HStack gap={2} wrap="wrap" minW={0}>
                    <Text fontSize="sm">{a.user.displayName || a.user.email || a.userId}</Text>
                    <Badge size="sm" variant="subtle" colorPalette="purple">
                      {a.customRole.name}
                    </Badge>
                    {a.isTemporary && (
                      <Badge size="sm" variant="subtle" colorPalette="orange">
                        Temporary
                      </Badge>
                    )}
                    {a.customRole.suspendedAt && (
                      <Badge size="sm" variant="subtle" colorPalette="red">
                        Role suspended — grants nothing
                      </Badge>
                    )}
                  </HStack>
                  {mayManage && (
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() =>
                        setConfirm({
                          kind: "revoke",
                          id: a.id,
                          who: a.user.displayName || a.user.email || a.userId,
                          role: a.customRole.name,
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </HStack>
              ))
            )}

            {mayManage && !area.retiredAt && roleCollection.items.length > 0 && (
              <HStack gap={2} wrap="wrap" pt={1}>
                <Select.Root
                  size="sm"
                  width="48"
                  collection={userCollection}
                  value={userId ? [userId] : []}
                  onValueChange={(e) => setUserId(e.value[0] ?? null)}
                >
                  <Select.HiddenSelect />
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Person…" />
                    </Select.Trigger>
                    <Select.IndicatorGroup>
                      <Select.Indicator />
                    </Select.IndicatorGroup>
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content>
                        {userCollection.items.map((i) => (
                          <Select.Item key={i.value} item={i}>
                            <Select.ItemText>{i.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
                <Select.Root
                  size="sm"
                  width="44"
                  collection={roleCollection}
                  value={roleId ? [roleId] : []}
                  onValueChange={(e) => setRoleId(e.value[0] ?? null)}
                >
                  <Select.HiddenSelect />
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Role…" />
                    </Select.Trigger>
                    <Select.IndicatorGroup>
                      <Select.Indicator />
                    </Select.IndicatorGroup>
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content>
                        {roleCollection.items.map((i) => (
                          <Select.Item key={i.value} item={i}>
                            <Select.ItemText>{i.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
                <Button size="xs" onClick={assign} disabled={!userId || !roleId}>
                  Assign here
                </Button>
              </HStack>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "revoke"
            ? "Remove this assignment?"
            : confirm?.kind === "retire"
              ? `Retire ${area.name}?`
              : `Un-retire ${area.name}?`
        }
        message={
          confirm?.kind === "revoke"
            ? `${confirm.who} stops holding ${confirm.role} in ${area.name}. If they hold it company-wide as well, nothing changes for them.`
            : confirm?.kind === "retire"
              ? `Retire ${area.name}. Nobody new can be assigned to it and it drops out of the pickers. Existing work and history keep pointing at it, and this can be undone.`
              : `Bring ${area.name} back. It can be assigned to and picked again.`
        }
        confirmLabel={
          confirm?.kind === "revoke" ? "Remove" : confirm?.kind === "retire" ? "Retire" : "Un-retire"
        }
        confirmColorPalette={confirm?.kind === "unretire" ? "green" : "red"}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          try {
            if (c.kind === "revoke") await apiDelete(`/api/area-assignments/${c.id}`);
            else await apiPost(`/api/areas/${area.id}/${c.kind}`);
            await onChanged();
          } catch (err) {
            publishInlineMessage({ type: "ERROR", text: getErrorMessage("That didn't work.", err) });
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </VStack>
  );
}

/**
 * WHAT IS ACTUALLY IN THIS AREA.
 *
 * The tree gave counts and no way to see behind them — "8 properties" with
 * no answer to "which eight". This is that answer, and it is the screen the
 * operator asked for: pick an area, see what is associated with it.
 *
 * THE SUBTREE, not just the directly-tagged rows, so the list agrees with
 * the headline count beside the area's name. A route's properties belong to
 * its district in every other reckoning the app does; they should not
 * disappear here.
 */
function AreaProperties({ areaId, areaName }: { areaId: string; areaName: string }) {
  // The caller gates on `clients.view` — see the callsite. This component
  // assumes it has been asked.
  //
  // LIST OR MAP, remembered. Somebody who thinks about territory
  // geographically wants the map every time; somebody reconciling a list
  // wants the list. Persisted so neither has to re-pick on every area.
  const [view, setView] = usePersistedState<"list" | "map">("areasTab_propView", "list");
  // `displayName` ALONE DOES NOT IDENTIFY A PROPERTY. Ninety of the
  // ninety-three in production are called "Main House", so the list read as
  // one name repeated down the page with a city beside it. The client and
  // the street were in the response all along — `GET /properties` includes
  // `client` and every Property scalar — and the row simply dropped them.
  const [rows, setRows] = useState<Array<{
    id: string;
    displayName: string;
    street1: string | null;
    city: string | null;
    areaId: string | null;
    client?: { id: string; displayName: string | null } | null;
  }> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    (async () => {
      try {
        const res = await apiGet<any>(`/api/properties?areaId=${encodeURIComponent(areaId)}&limit=500`);
        const list = Array.isArray(res) ? res : (res?.items ?? res?.properties ?? []);
        if (!cancelled) setRows(list);
      } catch {
        // A failed list must not take the area editor down with it — the
        // tree above is still usable and the counts are still true.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [areaId]);

  return (
    <Card.Root variant="outline">
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" gap={2}>
          <Text fontWeight="semibold" fontSize="sm">
            Properties in {areaName}
            {rows ? <Text as="span" color="fg.muted" fontWeight="normal"> · {rows.length}</Text> : null}
          </Text>
          <HStack gap={1}>
            {(["list", "map"] as const).map((v) => (
              <Button
                key={v}
                size="xs"
                variant={view === v ? "solid" : "outline"}
                colorPalette={view === v ? "purple" : "gray"}
                onClick={() => setView(v)}
                data-testid={`area-prop-view-${v}`}
              >
                {v === "list" ? "List" : "Map"}
              </Button>
            ))}
          </HStack>
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        {view === "map" ? (
          <AreaPropertyMap areaId={areaId} />
        ) : failed ? (
          <Text fontSize="xs" color="red.fg">Couldn&rsquo;t load properties.</Text>
        ) : rows === null ? (
          <HStack gap={2}><Spinner size="xs" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
        ) : rows.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">
            No properties here yet. Set an area on a property from its own
            editor, or when you create it.
          </Text>
        ) : (
          <VStack align="stretch" gap={1}>
            {rows.map((r) => (
              <HStack key={r.id} justify="space-between" gap={2} py={0.5}>
                {/* LINKS BACK TO THE PROPERTY, via the same handoff every
                    other cross-tab link in the app uses: `openEventSearch`
                    switches to Properties, fills its search with the name
                    and hands over the id, which that tab narrows to a
                    single row. Listing a property without a way to reach
                    it just moves the search somewhere else. */}
                <Box
                  as="button"
                  textAlign="left"
                  minW={0}
                  cursor="pointer"
                  onClick={() =>
                    // SEARCH FOR SOMETHING FINDABLE. This handed over
                    // `displayName`, so Properties opened on a search for
                    // "Main House" and ninety matches. The street is the
                    // one field that is actually distinct; the id still
                    // narrows it to the single row.
                    openEventSearch(
                      "areasTabToPropertiesTabSearch",
                      r.street1 || r.displayName,
                      r.id,
                    )
                  }
                >
                  <Text fontSize="sm" color="blue.fg" truncate _hover={{ textDecoration: "underline" }}>
                    {r.client?.displayName ?? r.displayName}
                  </Text>
                  <Text fontSize="2xs" color="fg.muted" truncate>
                    {[r.street1, r.displayName].filter(Boolean).join(" · ")}
                  </Text>
                </Box>
                <HStack gap={2} flexShrink={0}>
                  {r.city && <Text fontSize="2xs" color="fg.muted">{r.city}</Text>}
                  {/* A row from a CHILD area is marked, so "8 properties"
                      does not read as eight in this one place. */}
                  {r.areaId !== areaId && (
                    <Badge size="sm" variant="subtle" colorPalette="purple">below</Badge>
                  )}
                </HStack>
              </HStack>
            ))}
          </VStack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
