"use client";

/**
 * AREAS — the places the business works, and who looks after each one.
 *
 * A portfolio grant is an ordinary role grant that happens to carry a place: the
 * same role, confined to one branch of the tree. It is not a weaker role and
 * not a different one, which is why this screen shows the role name and the
 * portfolio side by side rather than inventing a vocabulary ("regional admin")
 * that exists nowhere in the model.
 *
 * TWO RULES THE UI HAS TO CARRY, because both are surprising:
 *
 *   · A portfolio is never REPARENTED (G14). Every portfolio-scoped query matches on
 *     the materialized path, so moving a subtree would silently change what
 *     history says happened where. The way to move work is copy-and-retire,
 *     and the absence of a "move" control is deliberate.
 *   · A company-wide grant beats a portfolio one. Somebody who holds a role
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
import { ChevronDown, ChevronRight, MapPin, Plus, Users } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/src/lib/api";
import { openEventSearch } from "@/src/lib/bus";
// Loaded normally: it imports Leaflet lazily inside an effect, so the
// library itself is still kept off the server render and off the
// bundle of anyone who never opens the map.
import PortfolioPropertyMap from "@/src/ui/components/PortfolioPropertyMap";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";
import { usePersistedState } from "@/src/lib/usePersistedState";

type Portfolio = {
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
  /** This portfolio AND everything beneath it, each thing counted once.
   *  Computed by the server — see below for why it cannot be derived here. */
  rollup: { properties: number; occurrences: number };
};

type Assignment = {
  id: string;
  userId: string;
  isTemporary: boolean;
  note: string | null;
  suspendedAt: string | null;
  user: { id: string; displayName: string | null; email: string | null };
  portfolio: { id: string; name: string; path: string; retiredAt: string | null };
  customRole: { id: string; name: string; suspendedAt: string | null };
};

type RoleOption = {
  id: string;
  name: string;
  isPerspective: boolean;
  suspendedAt: string | null;
  /** Inheritance resolved — what holding this role actually grants. */
  effective?: string[];
};
type UserOption = {
  id: string;
  displayName: string | null;
  email: string | null;
  /** Every grant they hold. A null `portfolioId` is company-wide, which is
   *  what makes a portfolio-scoped grant of the same powers a no-op. */
  roleGrants?: Array<{ roleId: string; portfolioId: string | null }>;
};

/** Read PORTFOLIO_TIER_NAMES out of the settings payload, tolerating anything. */
/** A tier the operator may pick, and the help text shown once they do. */
type TierOption = { name: string; description?: string };

/**
 * Read PORTFOLIO_TIER_NAMES, tolerating BOTH shapes it has had.
 *
 * It shipped as `["District", "Route"]` and is now
 * `[{ name, description }]`, so the description can be shown where the
 * choice is made. Both are accepted on purpose: the installer only
 * replaces a value it recognises as one it shipped, so an operator who
 * edited their vocabulary keeps the old shape indefinitely and must not
 * lose their suggestions for it.
 *
 * Anything else degrades to "no suggestions" rather than throwing and
 * taking the tree down with it.
 */
function parseTierNames(rows: Array<{ key: string; value: string }>): TierOption[] {
  const raw = (Array.isArray(rows) ? rows : []).find((r) => r.key === "PORTFOLIO_TIER_NAMES")?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x): TierOption | null => {
        if (typeof x === "string") return x ? { name: x } : null;
        if (x && typeof x === "object" && typeof x.name === "string" && x.name) {
          return { name: x.name, description: typeof x.description === "string" ? x.description : undefined };
        }
        return null;
      })
      .filter((x): x is TierOption => x !== null);
  } catch {
    return [];
  }
}

export default function PortfoliosTab({ scope }: { scope: Scope }) {
  const [portfolios, setAreas] = useState<Portfolio[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Set once the reader taps a portfolio, so the detail knows to scroll into
   *  view on a phone — an automatic selection must not. */
  const pickedRef = useRef(false);
  const [showRetired, setShowRetired] = useState(false);
  const [view, setView] = useState<"tree" | "leads">("tree");

  /**
   * "Chapel Hill → Carrboro", not "Carrboro".
   *
   * A bare leaf name does not identify a portfolio: two districts may each
   * have a route called North, and two towns can share a name outright.
   * The tree shows ancestry by indentation; a flat list has to say it.
   * The path is "/rootId/childId/…", so its ids ARE the chain — the root
   * is dropped because prefixing every row with "All properties" says
   * nothing.
   */
  const nameById = useMemo(
    () => new Map(portfolios.map((pf) => [pf.id, pf.name])),
    [portfolios],
  );
  const trailOf = useCallback(
    (path: string) =>
      path.split("/").filter(Boolean).slice(1).map((id) => nameById.get(id) ?? "?"),
    [nameById],
  );
  const [tierNames, setTierNames] = useState<TierOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, asg, r, u, settings] = await Promise.all([
        apiGet<Portfolio[]>("/api/portfolios"),
        apiGet<Assignment[]>("/api/portfolio-assignments"),
        // The picker needs the role catalogue; a caller without `roles.view`
        // still gets the tree, just no assignment control.
        apiGet<RoleOption[]>("/api/roles").catch(() => [] as RoleOption[]),
        // STAFF ONLY — a portfolio grant on a login with no worker type is the
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
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load portfolios.", err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // COLLAPSED ids, not expanded ones. Default-open: a tree that arrives
  // folded hides the thing the screen is for, and the ids of portfolios that do
  // not exist yet cannot be in a default-expanded list — so new portfolios
  // appear, which is the behaviour you want from a fixture that grows.
  const [collapsed, setCollapsed] = usePersistedState<string[]>("areasTab_collapsed", []);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const toggleCollapsed = useCallback(
    (id: string) =>
      setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [setCollapsed],
  );

  /**
   * Rolled-up property counts, keyed by portfolio id.
   *
   * FROM THE SERVER, NOT DERIVED HERE. This used to be a prefix sum over
   * descendants' own counts, justified on the grounds that the whole tree
   * was already on the client so an endpoint would be a second source for
   * a number this page could work out exactly. That reasoning held while a
   * property belonged to exactly one area. It fails under overlap: a
   * property in two sibling portfolios is counted by each of them and
   * twice by their parent, so the parent reports more properties than
   * exist — silently, and only once somebody actually uses the feature the
   * way it was built to be used.
   *
   * A distinct count cannot be recovered from per-node totals; it needs
   * the ids. So the server does it.
   */
  const rollup = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of portfolios) out[a.id] = a.rollup?.properties ?? a._count.properties;
    return out;
  }, [portfolios]);

  /** Which portfolios have at least one child that is currently listable. */
  const hasChildren = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const a of portfolios) {
      if (a.parentId && (showRetired || !a.retiredAt)) out[a.parentId] = true;
    }
    return out;
  }, [portfolios, showRetired]);

  /** The sole root — same test the detail pane and the lens picker use. */
  const isRootRow = useCallback(
    (a: Portfolio) => a.parentId === null && portfolios.filter((x) => x.parentId === null).length === 1,
    [portfolios],
  );

  const visible = useMemo(() => {
    const shown = portfolios.filter((a) => showRetired || !a.retiredAt);
    // Hide anything BENEATH a collapsed node, at any depth — folding a
    // region has to take its districts' routes with it, not just the
    // districts. The path makes that a prefix test rather than a walk.
    const collapsedPaths = shown.filter((a) => collapsedSet.has(a.id)).map((a) => a.path);
    return shown.filter(
      (a) => !collapsedPaths.some((p) => a.path.startsWith(p) && a.path !== p),
    );
  }, [portfolios, showRetired, collapsedSet]);
  const selected = useMemo(
    () => portfolios.find((a) => a.id === selectedId) ?? null,
    [portfolios, selectedId],
  );

  return (
    <VStack align="stretch" gap={3}>
      {/* Above the loading gate on purpose: the breadcrumb drives the
          explainer, so a tab that mounts it only after its data arrives has
          an "i" icon that does nothing on first paint. */}
      <TabExplainer explainerId="seedlings:areasTab:guideOpen">
        <ExplainerText>
          A portfolio is a place the business works. Give somebody a role{" "}
          <Em>in a portfolio</Em> and they hold it there and nowhere else — the
          same role, confined to one branch of this tree and everything under
          it.
        </ExplainerText>
        <ExplainerText>
          <Em>Holding a role everywhere beats holding it somewhere.</Em> If
          somebody already has it company-wide, adding a portfolio assignment
          changes nothing for them.
        </ExplainerText>
        <ExplainerText>
          <Em>Portfolios never move.</Em> There is no reparent control, on purpose:
          every record remembers where it happened by the portfolio's position, so
          moving one would rewrite history. To reorganise, create the new portfolio
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
        {scope.can("portfolios.manage") && (
          <NewAreaButton portfolios={portfolios} tierNames={tierNames} onCreated={load} />
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowRetired((v) => !v)}>
          {showRetired ? "Hide retired" : "Show retired"}
        </Button>
        {/* WHO LEADS WHAT, IN ONE PLACE.
            Every assignment was already loaded here and shown one node at
            a time, so "who leads Durham" was answerable and "who leads
            what" was not — you had to click every portfolio in turn and
            hold the answer in your head. That second question is the main
            reason to record an assignment at all, given a grant on
            somebody who already holds the role company-wide changes
            nothing about what they see. */}
        {assignments.length > 0 && (
          <Button
            size="sm"
            variant={view === "leads" ? "solid" : "outline"}
            colorPalette={view === "leads" ? "purple" : "gray"}
            onClick={() => setView((v) => (v === "leads" ? "tree" : "leads"))}
            data-testid="portfolios-leads-toggle"
          >
            <Users size={14} /> Who leads what
            <Text as="span" fontSize="2xs" opacity={0.75}>&nbsp;· {assignments.length}</Text>
          </Button>
        )}
      </HStack>

      {view === "leads" && (
        <Card.Root variant="outline">
          <Card.Body py="3" px="3">
            <VStack align="stretch" gap={3}>
              {portfolios
                .filter((pf) => showRetired || !pf.retiredAt)
                .map((pf) => ({ pf, rows: assignments.filter((a) => a.portfolio.id === pf.id) }))
                .filter(({ rows }) => rows.length > 0)
                .map(({ pf, rows }) => (
                  <Box key={pf.id}>
                    <HStack gap={2} mb={1} wrap="wrap">
                      <Text
                        as="button"
                        fontSize="sm"
                        color="blue.fg"
                        _hover={{ textDecoration: "underline" }}
                        onClick={() => { setView("tree"); setSelectedId(pf.id); }}
                      >
                        {trailOf(pf.path).map((part, i, all) => (
                          <Text as="span" key={part + i}>
                            {i > 0 && <Text as="span" opacity={0.55}>{" → "}</Text>}
                            <Text as="span" fontWeight={i === all.length - 1 ? "semibold" : "normal"}>
                              {part}
                            </Text>
                          </Text>
                        ))}
                      </Text>
                      {pf.tier && (
                        <Text fontSize="2xs" color="fg.muted">{pf.tier}</Text>
                      )}
                      {pf.retiredAt && (
                        <Badge size="sm" colorPalette="orange" variant="subtle">Retired</Badge>
                      )}
                    </HStack>
                    <VStack align="stretch" gap={0.5} pl={2}>
                      {rows.map((a) => (
                        <HStack key={a.id} gap={2} wrap="wrap">
                          <Text fontSize="sm">
                            {a.user.displayName || a.user.email || a.userId}
                          </Text>
                          <Badge size="sm" variant="subtle" colorPalette="purple">
                            {a.customRole.name}
                          </Badge>
                          {a.isTemporary && (
                            <Badge size="sm" variant="outline" colorPalette="orange">temporary</Badge>
                          )}
                          {a.suspendedAt && (
                            <Badge size="sm" variant="outline" colorPalette="red">suspended</Badge>
                          )}
                        </HStack>
                      ))}
                    </VStack>
                  </Box>
                ))}
              {/* NAMING THE GAPS IS THE POINT. A list of the portfolios that
                  HAVE a lead answers half the question; the other half is
                  which ones have nobody, and that is the half you act on. */}
              {(() => {
                const orphans = portfolios
                  .filter((pf) => showRetired || !pf.retiredAt)
                  .filter((pf) => pf.parentId !== null)
                  .filter((pf) => !assignments.some((a) => a.portfolio.id === pf.id));
                if (orphans.length === 0) return null;
                return (
                  <Box pt={1} borderTopWidth="1px" borderColor="border.default">
                    <Text fontSize="2xs" textTransform="uppercase" letterSpacing="wide" color="fg.muted" mb={1}>
                      Nobody assigned
                    </Text>
                    <HStack gap={1.5} wrap="wrap">
                      {orphans.map((pf) => (
                        <Badge
                          key={pf.id}
                          as="button"
                          size="sm"
                          variant="outline"
                          colorPalette="gray"
                          onClick={() => { setView("tree"); setSelectedId(pf.id); }}
                        >
                          {trailOf(pf.path).join(" → ")}
                        </Badge>
                      ))}
                    </HStack>
                  </Box>
                );
              })()}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {visible.length === 0 ? (
        <Card.Root variant="outline">
          <Card.Body py="6" px="3">
            <VStack gap={1}>
              <MapPin size={20} />
              <Text fontSize="sm" fontWeight="semibold">
                No portfolios yet
              </Text>
              <Text fontSize="xs" color="fg.muted" textAlign="center">
                Until there is at least one portfolio, every role is held
                company-wide. That is a valid way to run the business — add
                portfolios only when somebody should see one part of it and not
                another.
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      ) : (
        <HStack align="start" gap={4} wrap={{ base: "wrap", lg: "nowrap" }}>
          {/* WIDER SINCE THE TREE GOT DEEPER. 18rem was sized for a
              two-level tree; the real vocabulary is five
              (State → Market → District → Zone, plus the root), and every
              level spends width on indent before the name gets any. */}
          <VStack align="stretch" gap={1} minW={{ base: "full", lg: "80" }} maxW={{ lg: "80" }} w="full">
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
                //
                // 14px a level, and it STOPS STEPPING after six. Indent is
                // paid for out of the name's width, so an unbounded one
                // means a deep enough tree where no row can be read — the
                // nesting would be perfectly legible and the portfolios
                // anonymous. Six levels is one more than the vocabulary
                // has; past that the shape is carried by the twisties.
                ml={`${Math.min(a.depth, 6) * 14}px`}
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
                      data-testid={`portfolio-twisty-${a.id}`}
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
                    title={a.tier ? `${a.name} — ${a.tier}` : a.name}
                    onClick={() => { pickedRef.current = true; setSelectedId(a.id); }}
                  >
                    <HStack justify="space-between" gap={2} align="start">
                      <HStack gap={1.5} minW={0} wrap="wrap">
                        {/* WRAPS, NEVER TRUNCATES. A portfolio's name is
                            the only thing on the row that identifies it,
                            and "Chapel Hi…" and "Chapel Hil…" are the same
                            row to a reader. Two lines cost a few pixels of
                            height; a clipped name costs the answer. */}
                        <Text fontSize="sm" fontWeight={a.depth === 0 ? "semibold" : "normal"} lineHeight="short">
                          {a.name}
                        </Text>
                        {a.tier && (
                          <Text fontSize="2xs" color="fg.muted" flexShrink={0} lineHeight="short" pt="2px">
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
                      {/* THE NUMBER, NOT THE SENTENCE.
                          This read "22 properties (0 own)" — about 110px
                          that never yielded, on a row whose name was
                          already paying for the indent. At four levels
                          down the name had sixty pixels left and every
                          branch rendered as an ellipsis. The count is a
                          column to SCAN, so it only needs its digits; the
                          words live in the tooltip and in the detail panel
                          beside it, where there is room to say them. */}
                      <Text
                        fontSize="2xs"
                        color="fg.muted"
                        flexShrink={0}
                        whiteSpace="nowrap"
                        lineHeight="short"
                        pt="2px"
                        title={
                          `${total} propert${total === 1 ? "y" : "ies"}` +
                          (!isRootRow(a) && total !== own ? ` — ${own} tagged here, the rest below` : "")
                        }
                      >
                        {total}
                        {!isRootRow(a) && total !== own && (
                          <Text as="span" color="fg.subtle"> · {own} own</Text>
                        )}
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
              allPortfolios={portfolios}
              key={selected.id}
              scrollOnMount={pickedRef.current}
              portfolio={selected}
              // A SOLE ROOT IS NOT A PLACE. Same test the lens picker uses
              // to leave it out: its path prefixes every portfolio, so it is the
              // container, not a territory. Computed here because only this
              // level can see the whole tree.
              isSoleRoot={portfolios.filter((a) => a.parentId === null).length === 1 && selected.parentId === null}
              assignments={assignments.filter((x) => x.portfolio.id === selected.id)}
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
 * Tier picker — CHOOSE FROM THE LIST, and the list is editable.
 *
 * There was an "Other (specify…)" escape here, and it was right while the
 * taxonomy was six bare words nobody could extend without a developer. It
 * is wrong now: `PORTFOLIO_TIER_NAMES` is operator-editable on the Settings
 * tab AND each entry carries the sentence that defines it, so a tier typed
 * straight into this box is a level with no definition anywhere — which is
 * the exact confusion the descriptions were added to end. Somebody who
 * needs "Borough" adds it once, with its meaning, and everyone gets it.
 *
 * `Portfolio.tier` is still a free string in the schema and the API still
 * accepts anything; this is a UI decision about where a new level is born,
 * not a new constraint on the data.
 *
 * A saved tier that is NOT in the list is still shown and still selected —
 * it is real data, and blanking it on open would be a silent edit. It is
 * offered as an option marked as off-list so it reads as something to
 * resolve. Once it is changed it cannot be chosen again, which is the
 * point. Never a native <select>.
 */
function TierField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: TierOption[];
}) {
  const offList = !!value && !options.some((o) => o.name === value);
  const collection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "(none)", value: "", description: undefined },
          ...options.map((t) => ({ label: t.name, value: t.name, description: t.description })),
          ...(offList
            ? [{ label: value, value, description: "Not in the configured list — pick a listed tier, or add this one in Settings." }]
            : []),
        ] as Array<{ label: string; value: string; description?: string }>,
      }),
    [options, offList, value],
  );
  // The description of the tier currently chosen. This is the only place the
  // vocabulary is explained at the point of use — "Zone" and "Route" are
  // ordinary English words whose difference here is a real rule (a route has
  // an order; a zone has a boundary), and an operator picking blind will mix
  // them within a week.
  const chosen = collection.items.find((o) => o.value === value);
  return (
    <VStack align="stretch" gap={1}>
    <Select.Root
      size="sm"
      collection={collection}
      value={[value]}
      onValueChange={(e) => onChange(e.value[0] ?? "")}
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
                <VStack align="start" gap={0}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                  {it.description ? (
                    <Text fontSize="xs" color="fg.muted" lineHeight="short">
                      {it.description}
                    </Text>
                  ) : null}
                </VStack>
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
    {chosen?.description ? (
      <Text fontSize="xs" color="fg.muted" lineHeight="short">
        {chosen.description}
      </Text>
    ) : null}
    <Text fontSize="2xs" color="fg.subtle">
      Levels come from Settings → Catalogs → Portfolio tier names. Add one there, with its description, and it appears here.
    </Text>
    </VStack>
  );
}

function NewAreaButton({ portfolios, tierNames, onCreated }: { portfolios: Portfolio[]; tierNames: TierOption[]; onCreated: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tier, setTier] = useState("");
  // EVERY PORTFOLIO SITS INSIDE ANOTHER ONE. "At the top level" is offered only
  // to bootstrap an empty tree — a second root would split the hierarchy in
  // two, and portfolio scoping is a path-prefix match, so there would then be no
  // single prefix meaning "everywhere". The server refuses it too; this is
  // so the choice is never presented rather than refused after the fact.
  const root = portfolios.find((a) => a.parentId === null) ?? null;
  const [parentId, setParentId] = useState<string | null>(root?.id ?? null);
  const [busy, setBusy] = useState(false);

  const parentCollection = createListCollection({
    items: [
      ...(root ? [] : [{ label: "At the top level", value: "" }]),
      ...portfolios
        .filter((a) => !a.retiredAt)
        .map((a) => ({ label: `${"— ".repeat(a.depth)}${a.name}`, value: a.id })),
    ],
  });

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await apiPost("/api/portfolios", {
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
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't create the portfolio.", err) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus size={14} /> New portfolio
      </Button>
    );
  }

  return (
    <Card.Root variant="outline" w="full">
      <Card.Body py="3" px="3">
        <VStack align="stretch" gap={2}>
          <Input size="sm" placeholder="Portfolio name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
            Choose the parent carefully — a portfolio cannot be moved afterwards.
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
  portfolio,
  allPortfolios,
  isSoleRoot,
  assignments,
  roles,
  users,
  tierNames,
  scope,
  onChanged,
  scrollOnMount,
}: {
  /** True when this panel opened because somebody tapped a portfolio. */
  scrollOnMount?: boolean;
  portfolio: Portfolio;
  /** Every portfolio, so the property list can say which DESCENDANT a row
   *  arrived from rather than lumping them together as "below". */
  allPortfolios: Portfolio[];
  /** The one root of a single-rooted tree — "All portfolios" in the stock setup. */
  isSoleRoot: boolean;
  assignments: Assignment[];
  roles: RoleOption[];
  users: UserOption[];
  tierNames: TierOption[];
  scope: Scope;
  onChanged: () => void | Promise<void>;
}) {
  const mayManage = scope.can("portfolios.manage");

  /**
   * Bring the panel into view on a phone — see RoleEditor, same reasoning.
   * The detail renders BELOW the whole tree there, so a tap changed
   * something off-screen. Only on a deliberate pick: a portfolio is selected
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
  const [name, setName] = useState(portfolio.name);
  const [tier, setTier] = useState(portfolio.tier ?? "");
  // Held as STRINGS, not numbers. These are text boxes: an operator midway
  // through typing "-79." has a value that is not a number yet, and parsing
  // on every keystroke would either reject it or silently rewrite what they
  // typed. Parsed once, on save.
  const [lat, setLat] = useState(portfolio.lat == null ? "" : String(portfolio.lat));
  const [lng, setLng] = useState(portfolio.lng == null ? "" : String(portfolio.lng));
  const [userId, setUserId] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: "retire" | "unretire" } | { kind: "revoke"; id: string; who: string; role: string } | null
  >(null);

  /**
   * WHAT IS STILL IN HERE, said before you retire it.
   *
   * The server refuses a retire over live children, unfinished work or a
   * current lead — three things that would BREAK. Properties are not one
   * of them: a retired portfolio stays in reporting on purpose, so the
   * properties in it keep counting and nothing is wrong. That is exactly
   * why it needs saying. Nothing breaks, nothing is refused, and the
   * portfolio holding thirty addresses simply stops appearing in every
   * picker — so the next person to look for them has no name to search.
   *
   * Both numbers, because they answer different questions: what is tagged
   * HERE is what you would have to re-home, and what is in the SUBTREE is
   * what disappears from the pickers along with it.
   */
  const retireOwn = portfolio._count?.properties ?? 0;
  const retireSubtree = portfolio.rollup?.properties ?? retireOwn;
  const retireMessage = `Retire ${portfolio.name}. Nobody new can be assigned to it and it drops out of the pickers. Existing work and history keep pointing at it, and this can be undone.`;
  /** The count, in the yellow panel the dialog keeps for "why this matters". */
  const retireWarning = (() => {
    if (retireSubtree === 0) return undefined;
    // A CONTAINER READS DIFFERENTLY FROM A LEAF. "0 properties are tagged
    // here, 8 counting everything beneath it" is true and reads as a
    // glitch; a district whose properties all live in its zones is the
    // normal shape, not a zero.
    const count =
      retireOwn === 0
        ? `Nothing is tagged directly here, but ${retireSubtree} propert${retireSubtree === 1 ? "y" : "ies"} sit${retireSubtree === 1 ? "s" : ""} in the portfolios beneath it.`
        : retireSubtree > retireOwn
          ? `${retireOwn} propert${retireOwn === 1 ? "y is" : "ies are"} tagged here, ${retireSubtree} counting everything beneath it.`
          : `${retireOwn} propert${retireOwn === 1 ? "y is" : "ies are"} tagged here.`;
    return (
      `${count} They stay where they are and keep counting toward reports — ` +
      `retiring hides the portfolio from the pickers, not its history. Move them first if ` +
      `anyone will need to find them by portfolio.`
    );
  })();

  const dirty =
    name !== portfolio.name ||
    (!isSoleRoot && tier !== (portfolio.tier ?? "")) ||
    (!isSoleRoot &&
      (lat !== (portfolio.lat == null ? "" : String(portfolio.lat)) ||
        lng !== (portfolio.lng == null ? "" : String(portfolio.lng))));

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
      await apiPatch(`/api/portfolios/${portfolio.id}`, {
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
      publishInlineMessage({ type: "SUCCESS", text: "Portfolio updated." });
      await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't update the portfolio.", err) });
    }
  }

  async function assign() {
    if (!userId || !roleId) return;
    try {
      await apiPost("/api/portfolio-assignments", { userId, portfolioId: portfolio.id, customRoleId: roleId });
      publishInlineMessage({ type: "SUCCESS", text: "Assigned." });
      setUserId(null);
      setRoleId(null);
      await onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't assign.", err) });
    }
  }

  /**
   * WOULD THIS GRANT CHANGE ANYTHING?
   *
   * A portfolio assignment can only ever ADD places somebody can see —
   * `portfolioScope` returns no filter at all for a capability they
   * already hold company-wide. So assigning Admin-in-Durham to somebody
   * who is already Admin everywhere creates a row, lists it under "has
   * powers here", and alters nothing. In a business where most of the
   * people you would think to assign hold something global, that is the
   * common case, not the edge one.
   *
   * The test is on CAPABILITIES, not on the role: holding Super
   * company-wide covers an Admin grant even though the ids differ,
   * because `effective` has inheritance resolved.
   */
  const assignWouldDoNothing = useMemo(() => {
    if (!userId || !roleId) return null;
    const role = roles.find((r) => r.id === roleId);
    const person = users.find((u) => u.id === userId);
    const wants = role?.effective ?? [];
    if (!role || !person || wants.length === 0) return null;
    const globalIds = new Set(
      (person.roleGrants ?? []).filter((g) => !g.portfolioId).map((g) => g.roleId),
    );
    if (globalIds.size === 0) return null;
    const held = new Set<string>();
    for (const r of roles) if (globalIds.has(r.id)) for (const e of r.effective ?? []) held.add(e);
    const missing = wants.filter((e) => !held.has(e));
    if (missing.length > 0) return null;
    const names = roles.filter((r) => globalIds.has(r.id)).map((r) => r.name);
    return { role: role.name, via: names.join(", ") };
  }, [userId, roleId, roles, users]);

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
              {mayManage ? "Editing portfolio" : "Portfolio details"}
            </Text>
            {/* Wraps for the same reason the tree rows do — this is the
                heading that says WHICH portfolio is being edited, and a
                clipped one makes the whole panel ambiguous. */}
            <Text fontSize="sm" fontWeight="semibold" lineHeight="short">
              {portfolio.name}
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
                address, which is what it did before portfolios existed.

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
                data-testid="portfolio-lat"
              />
              <Input
                size="sm"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="Longitude"
                disabled={!mayManage}
                aria-label="Longitude"
                data-testid="portfolio-lng"
              />
            </HStack>
            )}
            {!isSoleRoot && (
              <Text fontSize="xs" color={halfAPoint ? "red.fg" : "fg.muted"}>
                {halfAPoint
                  ? "Give both a latitude and a longitude, or clear both."
                  : "The centre of this portfolio — its weather is forecast from here, and the map below marks it. Leave blank to use the business address."}
              </Text>
            )}
            <Text fontSize="xs" color="fg.muted">
              {portfolio._count.properties} properties · {portfolio._count.occurrences} visits ·{" "}
              {portfolio._count.assignments} assignments
            </Text>
            {mayManage && (
              <HStack gap={2} wrap="wrap">
                <Button size="xs" onClick={rename} disabled={!dirty || halfAPoint}>
                  Save
                </Button>
                {/* NO RETIRE ON THE ROOT. It is the tree itself — every
                    path starts with it — so retiring it would close the
                    coordinate system every portfolio-scoped query matches on
                    while leaving every row pointing into it. The server
                    refuses it as well; this is so the button is never
                    there to press. Renaming stays available: the label is
                    free to change because paths are built from ids. */}
                {!isSoleRoot && (
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette={portfolio.retiredAt ? "green" : "red"}
                    onClick={() => setConfirm({ kind: portfolio.retiredAt ? "unretire" : "retire" })}
                  >
                    {portfolio.retiredAt ? "Un-retire" : "Retire"}
                  </Button>
                )}
              </HStack>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* GATED ON THE CAPABILITY THE ROUTE ACTUALLY USES. `GET /properties`
          is guarded on `clients.view`, which somebody holding `portfolios.manage`
          need not have — and the refusal would arrive as an empty card with
          no explanation, which is the failure G46 exists to catch. Ask, and
          do not make the call if the answer is no. */}
      {scope.can("clients.view") && (
        <AreaProperties
          portfolioId={portfolio.id}
          portfolioName={portfolio.name}
          descendants={allPortfolios
            .filter((x) => x.id !== portfolio.id && x.path.startsWith(portfolio.path))
            // Deepest first, so a property in both a route and its district
            // is filed under the route — the most specific true answer.
            .sort((a, b) => b.path.length - a.path.length)
            .map((x) => ({ id: x.id, name: x.name }))}
          mayManage={mayManage}
          onChanged={onChanged}
        />
      )}

      {/* NOBODY LOOKS AFTER THE ROOT. "This role at the root" and "this role
          company-wide" read as the same sentence and are not the same query:
          a company-wide grant applies NO filter, while a root-scoped one
          filters on `portfolio.path startsWith <root>` — which cannot match a row
          whose portfolioId is null. Untagged records are allowed, so the two
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
              People tab rather than assigning them to a portfolio.
            </Text>
          </Card.Body>
        </Card.Root>
      ) : (
      <Card.Root variant="outline">
        <Card.Header py="2" px="3" pb="0">
          {/* NOT "who looks after". That reads as accountability, and the
              model records none: an assignment is consumed only by
              capability resolution — nothing routes a missed visit to
              these people, nothing marks work as theirs, nothing
              escalates. Saying "looks after" promised something the row
              does not deliver. */}
          <Text fontWeight="semibold" fontSize="sm">
            Who has powers in {portfolio.name}
          </Text>
        </Card.Header>
        <Card.Body py="2" px="3">
          <VStack align="stretch" gap={2}>
            {assignments.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                Nobody holds a role here.
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

            {mayManage && !portfolio.retiredAt && roleCollection.items.length > 0 && (
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
                <Button
                  size="xs"
                  onClick={assign}
                  disabled={!userId || !roleId}
                >
                  Assign here
                </Button>
              </HStack>
            )}
            {/* A NOTE, NOT A REFUSAL.
                This disabled the button, on the reasoning that a grant
                which filters nothing is a grant worth refusing. That read
                the assignment as only a permission. It is also the RECORD
                of who leads what — the one place the business says Jacob
                runs Chapel Hill — and that is worth writing down whether
                or not it changes a single query. Blocking it meant the
                owner could never be recorded as leading anything, because
                they hold everything.

                So: say plainly what it will and will not do, and let them
                decide. The banner on their screen says the same thing
                afterwards, so the fact does not live only here. */}
            {assignWouldDoNothing && (
              <Text fontSize="xs" color="orange.fg">
                Note: they already hold {assignWouldDoNothing.role}&rsquo;s
                permissions everywhere, through {assignWouldDoNothing.via}. A
                portfolio grant only ADDS places somebody can see, so this will
                not change what they see — it records that they lead this
                portfolio. To actually narrow their view, remove the
                company-wide role.
              </Text>
            )}
            {mayManage && !assignWouldDoNothing && (
              <Text fontSize="xs" color="fg.muted">
                A role granted here applies to this portfolio and everything
                beneath it. It adds to what the person already holds — it never
                takes anything away, and field work (claiming and finishing
                visits) is never restricted by portfolio, so cover still works.
              </Text>
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
              ? `Retire ${portfolio.name}?`
              : `Un-retire ${portfolio.name}?`
        }
        message={
          confirm?.kind === "revoke"
            ? `${confirm.who} stops holding ${confirm.role} in ${portfolio.name}. If they hold it company-wide as well, nothing changes for them.`
            : confirm?.kind === "retire"
              ? retireMessage
              : `Bring ${portfolio.name} back. It can be assigned to and picked again.`
        }
        confirmLabel={
          confirm?.kind === "revoke" ? "Remove" : confirm?.kind === "retire" ? "Retire" : "Un-retire"
        }
        warning={confirm?.kind === "retire" ? retireWarning : undefined}
        confirmColorPalette={confirm?.kind === "unretire" ? "green" : "red"}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          try {
            if (c.kind === "revoke") await apiDelete(`/api/portfolio-assignments/${c.id}`);
            else await apiPost(`/api/portfolios/${portfolio.id}/${c.kind}`);
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
 * WHAT IS ACTUALLY IN THIS PORTFOLIO.
 *
 * The tree gave counts and no way to see behind them — "8 properties" with
 * no answer to "which eight". This is that answer, and it is the screen the
 * operator asked for: pick a portfolio, see what is associated with it.
 *
 * THE SUBTREE, not just the directly-tagged rows, so the list agrees with
 * the headline count beside the portfolio's name. A route's properties belong to
 * its district in every other reckoning the app does; they should not
 * disappear here.
 */
function AreaProperties({
  portfolioId,
  portfolioName,
  descendants,
  mayManage,
  onChanged,
}: {
  portfolioId: string;
  portfolioName: string;
  /** Everything beneath this node, deepest first. */
  descendants: Array<{ id: string; name: string }>;
  /** `portfolios.manage` — the capability PUT /properties/:id/portfolios is
   *  guarded on. Read-only without it; the list is still worth seeing. */
  mayManage: boolean;
  /** Reload the tree, so the counts beside every ancestor follow a change. */
  onChanged: () => void | Promise<void>;
}) {
  // The caller gates on `clients.view` — see the callsite. This component
  // assumes it has been asked.
  //
  // LIST OR MAP, remembered. Somebody who thinks about territory
  // geographically wants the map every time; somebody reconciling a list
  // wants the list. Persisted so neither has to re-pick on every portfolio.
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
    client?: { id: string; displayName: string | null } | null;
    /** Every portfolio it is in — needed because the write is "these are
     *  the ones", so removing one means sending back the rest. */
    portfolios?: Array<{ portfolio: { id: string; name: string } }>;
  }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; label: string } | null>(null);
  /**
   * WHAT IT TAKES TO NAME A PROPERTY, which is more than an address.
   *
   * The picker showed "street, city" and listed "12 East St, Pittsboro"
   * twice — a church and a family at the same address — and "208 N
   * Buchanan Blvd, Durham" twice, which is ONE client with two properties
   * on the same lot. So neither the address nor the client is enough on
   * its own: it takes client + street + the property's own name, which is
   * unique across all of them and is exactly what the rows below already
   * show. A picker that identifies things differently from the list it
   * adds to is its own small trap.
   */
  const [candidates, setCandidates] = useState<Array<{
    id: string;
    client: string;
    street: string;
    name: string;
    city: string;
    /** Where it already is — so pulling a Durham property into Chapel
     *  Hill is a visible act rather than a surprise afterwards. Names to
     *  show, ids to send back with the write. */
    inPortfolios: string[];
    inPortfolioIds: string[];
    /** Everything above, flattened, for the filter box. */
    search: string;
  }> | null>(null);
  const [candidateFilter, setCandidateFilter] = useState("");

  /**
   * Write the WHOLE list back, every time.
   *
   * `PUT /properties/:id/portfolios` takes the complete set rather than an
   * add or a remove, so the client never has to decide which verb it is
   * performing and two tabs open on the same property cannot interleave
   * into a state neither asked for. The cost is that a removal has to send
   * the memberships it is keeping, which is why the rows carry them.
   */
  async function setMembership(propertyId: string, next: string[]) {
    setBusyId(propertyId);
    try {
      await apiPut(`/api/properties/${encodeURIComponent(propertyId)}/portfolios`, {
        portfolioIds: next,
      });
      setReloadKey((k) => k + 1);
      setCandidates(null);
      await onChanged();
    } catch (err: any) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not change the portfolio.", err),
      });
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    (async () => {
      try {
        const res = await apiGet<any>(`/api/properties?portfolioId=${encodeURIComponent(portfolioId)}&limit=500`);
        const list = Array.isArray(res) ? res : (res?.items ?? res?.properties ?? []);
        if (!cancelled) setRows(list);
      } catch {
        // A failed list must not take the portfolio editor down with it — the
        // tree above is still usable and the counts are still true.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [portfolioId, reloadKey]);

  /**
   * GROUPED BY WHERE EACH PROPERTY ACTUALLY SITS.
   *
   * This list shows the SUBTREE, so it agrees with the headline count —
   * which meant one flat run mixing three different relationships: things
   * in this portfolio, things in a route beneath it, and (via the "also
   * in" badges) things that are additionally somewhere else entirely.
   * Some rows had a Remove and some did not, with nothing saying why.
   *
   * Now: the ones this portfolio holds directly come first and are the
   * ones you can remove; everything else is filed under the descendant it
   * came from. A property in both a route and its district is filed under
   * the ROUTE, because `descendants` arrives deepest-first and the most
   * specific true answer is the useful one.
   */
  const groups = useMemo(() => {
    if (!rows) return null;
    const direct: typeof rows = [];
    const byDescendant = new Map<string, { name: string; rows: typeof rows }>();
    for (const r of rows) {
      const ids = new Set((r.portfolios ?? []).map((m) => m.portfolio.id));
      if (ids.has(portfolioId)) {
        direct.push(r);
        continue;
      }
      const via = descendants.find((d) => ids.has(d.id));
      if (!via) {
        // In none of them — it can only be here because the server's
        // subtree filter and this client's tree disagree, which means the
        // tree is stale. Show it rather than drop it.
        direct.push(r);
        continue;
      }
      const slot = byDescendant.get(via.id) ?? { name: via.name, rows: [] };
      slot.rows.push(r);
      byDescendant.set(via.id, slot);
    }
    const byClient = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      (a.client?.displayName ?? "").localeCompare(b.client?.displayName ?? "") ||
      (a.street1 ?? "").localeCompare(b.street1 ?? "");
    direct.sort(byClient);
    for (const g of byDescendant.values()) g.rows.sort(byClient);
    return [
      { id: portfolioId, heading: `In ${portfolioName}`, rows: direct },
      ...[...byDescendant.entries()]
        .map(([id, g]) => ({ id, heading: `In ${g.name}`, rows: g.rows }))
        .sort((a, b) => a.heading.localeCompare(b.heading)),
    ].filter((g) => g.rows.length > 0);
  }, [rows, portfolioId, portfolioName, descendants]);

  return (
    <Card.Root variant="outline">
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" gap={2}>
          <Text fontWeight="semibold" fontSize="sm">
            Properties in {portfolioName}
            {rows ? <Text as="span" color="fg.muted" fontWeight="normal"> · {rows.length}</Text> : null}
          </Text>
          <HStack gap={1}>
            {mayManage && view === "list" && (
              <Button
                size="xs"
                variant={adding ? "solid" : "outline"}
                colorPalette={adding ? "purple" : "gray"}
                onClick={async () => {
                  const next = !adding;
                  setAdding(next);
                  setCandidateFilter("");
                  if (!next) return;
                  // Everything NOT already in this portfolio. Fetched on
                  // open rather than with the list, because the common
                  // visit to this panel is a read and the candidate set is
                  // the whole book.
                  try {
                    const res = await apiGet<any>("/api/properties?limit=1000");
                    const all = Array.isArray(res) ? res : (res?.items ?? res?.properties ?? []);
                    const here = new Set((rows ?? []).map((r) => r.id));
                    setCandidates(
                      all
                        .filter((x: any) => !here.has(x.id))
                        .map((x: any) => {
                          const client = x.client?.displayName ?? "(no client)";
                          const street = x.street1 ?? "";
                          const name = x.displayName ?? "";
                          const city = x.city ?? "";
                          return {
                            id: x.id,
                            client,
                            street,
                            name,
                            city,
                            inPortfolios: (x.portfolios ?? [])
                              .map((m: any) => m?.portfolio?.name)
                              .filter(Boolean),
                            inPortfolioIds: (x.portfolios ?? [])
                              .map((m: any) => m?.portfolio?.id)
                              .filter(Boolean),
                            search: [client, street, name, city].filter(Boolean).join(" ").toLowerCase(),
                          };
                        })
                        // By client, then address: somebody looking for a
                        // property almost always knows whose it is.
                        .sort((a: any, b: any) =>
                          a.client.localeCompare(b.client) || a.street.localeCompare(b.street),
                        ),
                    );
                  } catch (err: any) {
                    publishInlineMessage({
                      type: "ERROR",
                      text: getErrorMessage("Couldn't load properties to add.", err),
                    });
                    setAdding(false);
                  }
                }}
                data-testid="portfolio-add-property"
              >
                <Plus size={12} /> Add
              </Button>
            )}
            {(["list", "map"] as const).map((v) => (
              <Button
                key={v}
                size="xs"
                variant={view === v ? "solid" : "outline"}
                colorPalette={view === v ? "purple" : "gray"}
                onClick={() => setView(v)}
                data-testid={`portfolio-prop-view-${v}`}
              >
                {v === "list" ? "List" : "Map"}
              </Button>
            ))}
          </HStack>
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        {view === "map" ? (
          <PortfolioPropertyMap portfolioId={portfolioId} />
        ) : failed ? (
          <Text fontSize="xs" color="red.fg">Couldn&rsquo;t load properties.</Text>
        ) : rows === null ? (
          <HStack gap={2}><Spinner size="xs" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
        ) : rows.length === 0 && !adding ? (
          <Text fontSize="xs" color="fg.muted">
            Nothing in {portfolioName} yet.
            {mayManage ? " Use Add to put properties in it." : ""}
          </Text>
        ) : (
          <VStack align="stretch" gap={1}>
            {adding && (
              <Box mb={2} p={2} borderWidth="1px" borderColor="border.emphasis" rounded="md" bg="bg.subtle">
                {candidates === null ? (
                  <HStack gap={2}><Spinner size="xs" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
                ) : candidates.length === 0 ? (
                  <Text fontSize="xs" color="fg.muted">Every property is already in this portfolio.</Text>
                ) : (
                  <VStack align="stretch" gap={2}>
                    {/* A FILTER, because the candidate set is the whole book.
                        Ninety-odd rows in a dropdown is a scroll, not a
                        choice, and the thing you are looking for is usually
                        a client's name you already know. */}
                    <Input
                      size="sm"
                      autoFocus
                      value={candidateFilter}
                      onChange={(e) => setCandidateFilter(e.target.value)}
                      placeholder={`Add to ${portfolioName} — search client, address or name…`}
                    />
                    <VStack
                      align="stretch"
                      gap={0}
                      maxH="16rem"
                      overflowY="auto"
                      borderWidth="1px"
                      borderColor="border.emphasis"
                      rounded="md"
                      bg="bg.panel"
                    >
                      {(() => {
                        const q = candidateFilter.trim().toLowerCase();
                        const shown = q
                          ? candidates.filter((c) => c.search.includes(q))
                          : candidates;
                        if (shown.length === 0) {
                          return (
                            <Text fontSize="xs" color="fg.muted" p={2}>
                              Nothing matches &ldquo;{candidateFilter.trim()}&rdquo;.
                            </Text>
                          );
                        }
                        return shown.map((c) => (
                          <Box
                            as="button"
                            key={c.id}
                            textAlign="left"
                            px={2}
                            py={1.5}
                            borderBottomWidth="1px"
                            borderColor="border.default"
                            _hover={{ bg: "gray.faint" }}
                            opacity={busyId === c.id ? 0.5 : 1}
                            cursor={busyId ? "wait" : "pointer"}
                            onClick={async () => {
                              if (busyId) return;
                              // Send what it already has PLUS this one. The
                              // write takes the whole set, and a re-read
                              // here would only be a second chance to go
                              // stale — the ids came back with the
                              // candidate a moment ago.
                              await setMembership(c.id, [
                                ...new Set([...c.inPortfolioIds, portfolioId]),
                              ]);
                              setAdding(false);
                            }}
                          >
                            {/* THE SAME THREE FIELDS THE ROWS BELOW SHOW.
                                Client on top, then street · property name ·
                                city. Two properties can share an address
                                (a church and a family at 12 East St) and
                                one client can have two on the same lot
                                (208 N Buchanan), so neither the address nor
                                the client identifies a row alone. */}
                            <Text fontSize="sm" truncate>{c.client}</Text>
                            <HStack gap={1.5} wrap="wrap">
                              <Text fontSize="2xs" color="fg.muted" truncate>
                                {[c.street, c.name, c.city].filter(Boolean).join(" · ")}
                              </Text>
                              {c.inPortfolios.map((n) => (
                                <Badge key={n} size="sm" variant="subtle" colorPalette="purple">
                                  {n}
                                </Badge>
                              ))}
                            </HStack>
                          </Box>
                        ));
                      })()}
                    </VStack>
                  </VStack>
                )}
              </Box>
            )}
            {(groups ?? []).map((g) => (
              <Box key={g.id}>
                {/* The heading is only worth drawing when there is more
                    than one group — with everything in this portfolio it
                    would label the obvious. */}
                {(groups ?? []).length > 1 && (
                  <Text
                    fontSize="2xs"
                    textTransform="uppercase"
                    letterSpacing="wide"
                    color="fg.muted"
                    mt={g.id === portfolioId ? 0 : 2}
                    mb={0.5}
                  >
                    {g.heading}
                    <Text as="span" color="fg.subtle"> · {g.rows.length}</Text>
                  </Text>
                )}
                <VStack align="stretch" gap={1}>
            {g.rows.map((r) => (
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
                    {[r.street1, r.displayName, r.city].filter(Boolean).join(" · ")}
                  </Text>
                </Box>
                <HStack gap={2} flexShrink={0}>
                  {/* WHERE ELSE IT SITS. A row can be here because it is in
                      THIS portfolio, or because it is in one below — the
                      list shows the subtree so it agrees with the headline
                      count. Naming the other portfolio matters now that a
                      property can be in several, and Remove only ever
                      detaches this node, never somebody else's.

                      LABELLED "also in", and the city moved out of this
                      column into the address line above. Portfolios tend
                      to be named after places, so a grey "Durham" sitting
                      beside a purple "Durham" read as the same fact
                      printed twice when they are a city and a portfolio.
                      Two adjacent labels that look identical and mean
                      different things is worse than either alone. */}
                  {(() => {
                    // Excluding the group's own portfolio too: a row filed
                    // under "In Carrboro" does not need a Carrboro badge.
                    const others = (r.portfolios ?? []).filter(
                      (m) => m.portfolio.id !== portfolioId && m.portfolio.id !== g.id,
                    );
                    if (others.length === 0) return null;
                    return (
                      <>
                        <Text fontSize="2xs" color="fg.subtle">also in</Text>
                        {others.map((m) => (
                          <Badge key={m.portfolio.id} size="sm" variant="subtle" colorPalette="purple">
                            {m.portfolio.name}
                          </Badge>
                        ))}
                      </>
                    );
                  })()}
                  {/* Only in the direct group, by construction — a row
                      filed under a descendant is not in THIS portfolio, so
                      there is nothing here to remove it from. Previously
                      that produced a list where some rows had the button
                      and some did not, with no visible reason. */}
                  {mayManage && g.id === portfolioId && (
                    <Button
                      size="2xs"
                      variant="outline"
                      colorPalette="red"
                      loading={busyId === r.id}
                      onClick={() =>
                        setConfirmRemove({
                          id: r.id,
                          label: [r.street1 || r.displayName, r.city].filter(Boolean).join(", "),
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </HStack>
              </HStack>
            ))}
                </VStack>
              </Box>
            ))}
          </VStack>
        )}
      </Card.Body>
      {/* MANDATORY, like every other mutation in this app. Taking a
          property out of a portfolio is a tap away from the row's own
          link, on a phone, and the consequence is not visible from here:
          its open visits stop counting toward this portfolio and anyone
          scoped to it loses sight of the work. */}
      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove from this portfolio?"
        message={
          confirmRemove
            ? `${confirmRemove.label} will no longer be in ${portfolioName}. Its open visits stop counting toward it; finished ones keep what they counted toward. Any other portfolio it is in is untouched.`
            : ""
        }
        confirmLabel="Remove"
        confirmColorPalette="red"
        onConfirm={async () => {
          const target = confirmRemove;
          setConfirmRemove(null);
          if (!target) return;
          const row = (rows ?? []).find((r) => r.id === target.id);
          const keep = (row?.portfolios ?? [])
            .map((m) => m.portfolio.id)
            .filter((id) => id !== portfolioId);
          await setMembership(target.id, keep);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </Card.Root>
  );
}
