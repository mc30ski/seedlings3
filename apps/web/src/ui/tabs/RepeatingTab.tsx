"use client";

// ─────────────────────────────────────────────────────────────────────────────
// WORK → REPEATING — every repeating service in the book, in one place.
//
// WHY A TAB AND NOT A VIEW INSIDE SERVICES. Services is a card per service
// per customer; its unit is the job. This is a flat list of live repeating
// occurrences across the whole book — a different unit on a different axis,
// and the screen you open twice a year to put the season away. Services also
// renders occurrence rows from a PER-JOB detail fetch, so the columns here
// were never in a payload it already had; folding this into a tab that is
// already 3,800 lines would have bought nothing.
//
// IT IS A LENS, NOT A SECOND KIND OF PAUSE. Every write goes through the
// shared controller in `StreamPauseControls` — the same dialog, the same
// mandatory reason, the same per-occurrence endpoint the card button in
// Services and Work → Jobs calls. Nothing on this screen records that a
// selection happened. See `services/repeatingStreams.ts` for the removed
// client-level cascade this is deliberately not.
//
// "SELECT ROWS, THEN ACT" IS THE WHOLE SAFETY ARGUMENT. The operator's own
// words for what went wrong last time: the client-level button "sorta hid
// what was happening as it cascaded actions". So a selection here is always
// visible — ticked boxes, a count in the footer, and the confirm lists every
// row by name before anything is written.
//
// WHO SEES IT. `schedule.view-all` ("see every visit, not only the ones you
// are on") opens the tab, which is the capability `GET /repeating-streams`
// is guarded on. Acting needs `schedule.manage`, checked below — the live
// book has a role holding the read without the write, so the read-only
// rendering is a real state and not a theoretical one.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  HStack,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { ArrowDown, ArrowUp, BellRing, CalendarClock, ExternalLink, PauseCircle, Repeat } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import type { Scope } from "@/src/lib/scope";
import { fmtDate } from "@/src/lib/dates";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import {
  ALL_PAUSE_REASONS,
  StreamPauseActions,
  StreamPauseFilter,
  passesPauseFilter,
  useStreamPauseControls,
  useStreamPauseSelection,
  type StreamSelectionRow,
} from "@/src/ui/components/StreamPauseControls";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import type { PauseReason } from "@/src/lib/pauseReasons";

/** One row, exactly as `GET /repeating-streams` returns it. */
type Row = {
  id: string;
  jobId: string;
  clientId: string | null;
  clientName: string;
  propertyName: string;
  /** NULL when nothing names the stream, which is nearly every row — see
   *  the note on the server's own type. Declared nullable HERE too: this
   *  local shape is a hand-copy of the API's, so TypeScript cannot tell when
   *  the two drift. It said `string` while the server had already started
   *  returning null, `.toLowerCase()` threw inside the filter, and the whole
   *  table rendered empty with no error on screen. The e2e spec caught it;
   *  the compiler could not. */
  service: string | null;
  frequencyDays: number | null;
  status: string;
  startAt: string | null;
  canPause: boolean;
  canResume: boolean;
  blockedReason: string | null;
  streamPauseReasonCode: string | null;
  streamPauseReasonLabel: string | null;
  streamPauseReason: string | null;
  streamPausedAt: string | null;
  streamResumeReminderAt: string | null;
  reminderDue: boolean;
  suggestedResumeAt: string | null;
};

/** Columns at desk width; one stacked block on a phone.
 *
 *  ONE ROW IMPLEMENTATION, responsive by grid rather than two layouts behind
 *  a breakpoint. A table for desks and a card list for phones is two copies
 *  of every cell, and two copies of one decision is the drift that put a
 *  teal band on a grey card in this very feature's neighbourhood.
 *
 *  EVERY TRACK IS CONTENT-INDEPENDENT, and that is the whole point of this
 *  constant. Each row is its own grid, so a track whose width depends on what
 *  is IN it resolves per row and the columns stop lining up — which is what
 *  shipped: the last track was `auto`, so a held row carrying "Resume
 *  repeating" and "Edit pause" grew it and squeezed everything to its left,
 *  while an awaiting-payment row with no buttons did not. Each line put its
 *  columns somewhere slightly different and the table could not be read at a
 *  glance.
 *
 *  So: fixed px for the columns whose content varies most in width, and
 *  `minmax(0, …fr)` for the rest. The `0` floor is load-bearing — a bare
 *  `1.5fr` still carries `min-width: auto`, so one long unbroken property
 *  name would widen that track on its row alone and bring the same drift
 *  straight back. */
const COLS = {
  base: "auto minmax(0, 1fr)",
  md:
    "32px " + // tick
    "minmax(0, 1.5fr) " + // customer + property
    "minmax(0, 1fr) " + // service + cadence
    "104px " + // next visit — a date has a known width
    "188px " + // state badge, and why it is blocked
    "minmax(0, 1.4fr) " + // reason + note + check-back
    "176px", // actions
};

/**
 * The order the work is in, for sorting by State.
 *
 * Alphabetical would put "Awaiting payment" first and "Timer paused" last,
 * which is an accident of the alphabet. This is the order an operator works
 * the list in: what is still running, what they have already held, then the
 * three that cannot be held until something else is resolved.
 */
const STATE_ORDER = [
  "SCHEDULED",
  "STREAM_PAUSED",
  "PENDING_PAYMENT",
  "IN_PROGRESS",
  "PAUSED",
] as const;

type SortKey = "customer" | "service" | "next" | "state" | "reason" | "checkBack";

/**
 * The sortable columns, in render order.
 *
 * ONE LIST, read by both affordances. The headers are only drawn at desk
 * width, so a phone would otherwise have no way to sort at all — and a
 * second hand-written list for the phone picker is two statements of one
 * decision, which is how a column ends up sortable in one place and not the
 * other. `defaultDir` is per column because the useful first click differs:
 * dates and names read best ascending, a check-back date you are chasing
 * reads best oldest-first, and nobody opens State wanting it backwards.
 */
const SORTABLE: Array<{ key: SortKey; label: string; defaultDir: "asc" | "desc" }> = [
  { key: "customer", label: "Customer", defaultDir: "asc" },
  { key: "service", label: "Service", defaultDir: "asc" },
  { key: "next", label: "Next visit", defaultDir: "asc" },
  { key: "state", label: "State", defaultDir: "asc" },
  { key: "reason", label: "Reason", defaultDir: "asc" },
];

/**
 * A cell that names itself on a phone, where there is no column header.
 *
 * `gridColumn` IS THE WHOLE REASON THIS SHIPPED BROKEN. The row is one grid
 * at both sizes, and the phone template has two tracks while the row has
 * seven children — so auto-placement dealt them alternately into column 1
 * and column 2, putting half the cells in the track sized for a checkbox.
 * A `minmax(0, …)` track will happily shrink to nothing, so the text wrapped
 * one character per line and each row grew to the height of a page.
 *
 * Pinning every cell to column 2 is what makes a single markup work at both
 * sizes: on a phone they stack down the second track beside the tick, and at
 * desk width `auto` hands them back to the header's column order.
 */
function Cell({
  label,
  children,
  /** Hidden on a phone when it has nothing to say — a row of labels reading
   *  "REASON —" is noise on the narrow surface, where vertical space is the
   *  scarce thing. The cell still renders at desk width, because dropping it
   *  there would shift every later column one place left. */
  emptyOnMobile = false,
}: {
  label: string;
  children: React.ReactNode;
  emptyOnMobile?: boolean;
}) {
  return (
    <Box
      minW={0}
      gridColumn={{ base: "2", md: "auto" }}
      display={{ base: emptyOnMobile ? "none" : "flex", md: "block" }}
      gap={2}
      alignItems="baseline"
    >
      {/* Inline with the value on a phone, above it never — stacking the
          label would double every row's height for no added meaning. */}
      <Text
        fontSize="2xs"
        color="fg.muted"
        textTransform="uppercase"
        letterSpacing="0.04em"
        hideFrom="md"
        flex="0 0 auto"
        w="72px"
      >
        {label}
      </Text>
      <Box minW={0} flex="1">{children}</Box>
    </Box>
  );
}

function statusMeta(row: Row): { label: string; palette: string } {
  if (row.status === "STREAM_PAUSED") return { label: "Held", palette: "purple" };
  if (row.status === "SCHEDULED") return { label: "Scheduled", palette: "blue" };
  if (row.status === "PENDING_PAYMENT") return { label: "Awaiting payment", palette: "orange" };
  if (row.status === "IN_PROGRESS") return { label: "On site", palette: "green" };
  if (row.status === "PAUSED") return { label: "Timer paused", palette: "yellow" };
  return { label: row.status, palette: "gray" };
}

export default function RepeatingTab({
  scope,
  onOpenService,
}: {
  scope: Scope;
  /**
   * Jump to this occurrence's card in Services, expanded and highlighted.
   * The table links OUT rather than growing its own editor — a second place
   * to change a cadence or a price is a second place for them to disagree.
   *
   * TAKES THE JOB ID, which this table already has on every row. The first
   * version passed only the occurrence and reused the stream-pause-reminders
   * link, which resolves the job by looking the occurrence up in the
   * due-reminders list — so it worked only for a held row whose check-back
   * had already arrived, and every other row (scheduled, awaiting payment,
   * held until spring) landed on "No jobs match current filters".
   */
  onOpenService: (jobId: string, id: string) => void;
}) {
  // `schedule.manage` — the capability `POST /repeating-streams/pause` and
  // every per-row write are guarded on. Named here, on the control's own
  // screen, rather than inferred from where the tab happens to be mounted.
  const canManage = scope.can("schedule.manage");

  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [pausedOnly, setPausedOnly] = useState(false);
  const [reasonCode, setReasonCode] = useState<string>(ALL_PAUSE_REASONS);
  const [dueOnly, setDueOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState("");
  /**
   * ONE SORT STATE, two affordances.
   *
   * The clickable headers and the phone picker both read and write exactly
   * this. They are two renderings of one decision rather than two decisions —
   * the shape that put a teal timing band on a grey card, and a map icon
   * whose glyph and colour disagreed, earlier in this same feature's history.
   *
   * Not persisted, same as the day map's mode: a sort is how you are reading
   * the list this minute, and finding yesterday's ordering after a hard
   * refresh reads as the app having lost your place.
   */
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  /** Click a header: same column flips direction, a new column starts at its
   *  own useful default rather than inheriting the last one's. */
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) =>
        prevKey === key
          ? prevDir === "asc" ? "desc" : "asc"
          : SORTABLE.find((c) => c.key === key)?.defaultDir ?? "asc",
      );
      return key;
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<Row[]>("/api/repeating-streams");
      setRows(Array.isArray(res) ? res : []);
      setFailed(false);
    } catch (err) {
      setFailed(true);
      setRows([]);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load repeating job occurrences.", err),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    // Every pause write in the app fires this, including the ones made from
    // Services and Work → Jobs — so this table is never the stale one.
    const onChanged = () => void load();
    window.addEventListener("seedlings:stream-pauses-changed", onChanged);
    return () => window.removeEventListener("seedlings:stream-pauses-changed", onChanged);
  }, [load]);

  const streamControls = useStreamPauseControls({ onChanged: () => load() });
  const selection = useStreamPauseSelection({
    onChanged: async () => {
      // A write moves rows between the filters this table is showing, so the
      // selection it was made from is no longer meaningful.
      setSelected(new Set());
      await load();
    },
  });

  /**
   * The reason options, derived from the ROWS rather than the taxonomy.
   *
   * `/api/pause-reasons` requires `schedule.manage`, which the read-only
   * reader does not hold — asking would 403 and cache an empty list, leaving
   * them a filter with nothing in it. The rows already carry the label the
   * server resolved, and offering only reasons that are actually present is
   * the better list anyway: no filtering down to an empty table.
   */
  const reasons: PauseReason[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows ?? []) {
      if (r.streamPauseReasonCode && !seen.has(r.streamPauseReasonCode)) {
        seen.set(r.streamPauseReasonCode, r.streamPauseReasonLabel ?? r.streamPauseReasonCode);
      }
    }
    return [...seen].map(([code, label]) => ({ code, label }));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const kept = (rows ?? []).filter((r) => {
      if (!passesPauseFilter(r, pausedOnly, reasonCode)) return false;
      if (dueOnly && !r.reminderDue) return false;
      if (!needle) return true;
      return (
        r.clientName.toLowerCase().includes(needle) ||
        r.propertyName.toLowerCase().includes(needle) ||
        (r.service ?? "").toLowerCase().includes(needle)
      );
    });

    /**
     * NULLS LAST IN BOTH DIRECTIONS, and that is a deliberate rule rather
     * than a fallout of the comparator.
     *
     * A row with no check-back date, or no name of its own, carries no
     * information about where it belongs in that order. Letting it fall out
     * of the comparison naturally would float every one of them to the top
     * the moment you reversed the sort — and on this table "no check-back
     * date" is the commonest value in the column, so reversing would bury
     * the dates under the blanks instead of showing the furthest-out ones.
     */
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: string | number | null, b: string | number | null): number => {
      const aEmpty = a === null || a === "";
      const bEmpty = b === null || b === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    };

    const key = (r: Row): string | number | null => {
      switch (sortKey) {
        case "customer":
          // Property second, so one customer's properties stay together.
          return `${r.clientName}\u0000${r.propertyName}`;
        case "service":
          // Nothing names most of these, so fall through to the cadence —
          // the thing the cell actually shows when the name is missing.
          return r.service ?? (r.frequencyDays !== null ? `￿${String(r.frequencyDays).padStart(6, "0")}` : null);
        case "next":
          return r.startAt ? Date.parse(r.startAt) : null;
        case "state":
          // RANKED, NOT ALPHABETICAL. "Awaiting payment" before "Held"
          // before "On site" is an accident of the alphabet; this is the
          // order the work is in — what is running, what you have held, and
          // then what is blocked and needs something else resolved first.
          {
            // `as const` narrows STATE_ORDER to its literals; the row's
            // status is a plain string off the wire, so widen for the lookup.
            const i = (STATE_ORDER as readonly string[]).indexOf(r.status);
            // An unknown status sorts last rather than first — a new one
            // appearing at the top of the list would read as urgent.
            return i < 0 ? 99 : i;
          }
        case "reason":
          return r.streamPauseReasonLabel;
        case "checkBack":
          return r.streamResumeReminderAt ? Date.parse(r.streamResumeReminderAt) : null;
        default:
          return null;
      }
    };

    // Sorted on a COPY: `kept` is derived here, but sorting in place is the
    // habit that mutates a memoised array somebody else is holding.
    return [...kept].sort((a, b) => {
      const primary = cmp(key(a), key(b));
      if (primary !== 0) return primary;
      // One stable tie-break for every column, so repeated clicks do not
      // reshuffle rows that compare equal.
      return cmp(a.startAt ? Date.parse(a.startAt) : null, b.startAt ? Date.parse(b.startAt) : null);
    });
  }, [rows, q, pausedOnly, reasonCode, dueOnly, sortKey, sortDir]);

  /** The phone picker's options — SAME list the headers render from, so the
   *  two cannot offer different columns. */
  const sortCollection = useMemo(
    () => createListCollection({ items: SORTABLE.map((c) => ({ label: c.label, value: c.key })) }),
    [],
  );

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      live: all.filter((r) => r.status === "SCHEDULED").length,
      held: all.filter((r) => r.status === "STREAM_PAUSED").length,
      blocked: all.filter((r) => !r.canPause && !r.canResume).length,
      due: all.filter((r) => r.reminderDue).length,
    };
  }, [rows]);

  /** Rows a selection may contain at all. A blocked row cannot be ticked —
   *  a disabled box beside a stated reason teaches the rule; letting it be
   *  ticked and refused at commit time teaches nothing. */
  const selectableIds = useMemo(
    () => filtered.filter((r) => r.canPause || r.canResume).map((r) => r.id),
    [filtered],
  );

  const selectedRows = useMemo(
    () => (rows ?? []).filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  const toPause = selectedRows.filter((r) => r.canPause);
  const toResume = selectedRows.filter((r) => r.canResume);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The label a selection carries into the confirm and into any failure
   *  report. One builder, so the dialog and the message agree. */
  function selectionRow(r: Row): StreamSelectionRow {
    return {
      // `occurrenceId` here, not `id`: a selection OUTCOME is keyed by the
      // occurrence it describes, and the endpoints answer in those terms.
      occurrenceId: r.id,
      // The cadence stands in when the stream has no name of its own, so a
      // confirm never lists a row as "Patel Residence — Home · null".
      label: `${r.clientName} — ${r.propertyName} · ${
        r.service ?? (r.frequencyDays ? `every ${r.frequencyDays} days` : "repeating")
      }`,
      detail: r.canResume && r.suggestedResumeAt
        ? `restarts ${fmtDate(r.suggestedResumeAt)}`
        : r.startAt
          ? `next ${fmtDate(r.startAt)}`
          : null,
    };
  }

  if (rows === null) {
    return (
      <HStack justify="center" py="10">
        <Spinner size="sm" />
        <Text fontSize="sm" color="fg.muted">Loading repeating job occurrences…</Text>
      </HStack>
    );
  }

  return (
    <VStack align="stretch" gap={3} pb={selected.size > 0 ? "16" : "2"}>
      {/* THE UNIT IS THE JOB OCCURRENCE, and the copy has to say so. This
          read "Every service that repeats", which names the wrong thing: one
          service can carry several repeating occurrences — mowing and hedging
          on the same job — and each is held separately. An operator counting
          rows against their service list would have found more rows than
          services and no explanation for it.

          "Job occurrence" rather than our own word for it: the Settings card
          that owns the pause reasons is already titled "Repeating Job
          Occurrence Pause Reasons", so it is the vocabulary this operator
          already meets. */}
      <Box data-whats-new="repeating-tab">
        <HStack gap={2} mb={1}>
          <Box color="purple.fg"><Repeat size={16} /></Box>
          <Text fontWeight="semibold">Repeating job occurrences</Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          Every job occurrence that repeats, and whether it is running or held.
          Hold a whole season here in one pass instead of opening each visit.
          One-off visits are not listed — there is nothing to hold on one.
        </Text>
      </Box>

      {/* The shape of the book, before any filter. The blocked count is the
          number worth stating out loud: those are the streams an end-of-season
          sweep silently misses, and until this screen existed nothing said so. */}
      <HStack gap={2} wrap="wrap" data-testid="repeating-summary">
        <Badge variant="subtle">{counts.total} repeating</Badge>
        <Badge variant="subtle" colorPalette="blue">{counts.live} scheduled</Badge>
        <Badge variant="subtle" colorPalette="purple">{counts.held} held</Badge>
        {counts.blocked > 0 && (
          <Badge variant="subtle" colorPalette="orange">
            {counts.blocked} cannot be held yet
          </Badge>
        )}
        {counts.due > 0 && (
          <Badge variant="subtle" colorPalette="red">{counts.due} due a check-back</Badge>
        )}
      </HStack>

      <HStack gap={2} wrap="wrap" align="center">
        <Box flex="1" minW="200px">
          <SearchWithClear
            value={q}
            onChange={setQ}
            inputId="repeating-search"
            placeholder="Customer, property or service…"
          />
        </Box>
        <StreamPauseFilter
          active={pausedOnly}
          reasonCode={reasonCode}
          reasons={reasons}
          onChange={(next) => { setPausedOnly(next.active); setReasonCode(next.reasonCode); }}
        />
        <Button
          size="sm"
          variant={dueOnly ? "subtle" : "outline"}
          colorPalette={dueOnly ? "red" : undefined}
          onClick={() => setDueOnly((v) => !v)}
          title="Only the held services whose check-back date has arrived"
          data-testid="repeating-due-filter"
        >
          <BellRing size={13} />
          Due
        </Button>
      </HStack>

      {failed && (
        <Text fontSize="sm" color="red.fg">
          Could not load the list. Nothing has been changed.
        </Text>
      )}

      {canManage && selectableIds.length > 0 && (
        <HStack gap={2} wrap="wrap">
          <Button
            size="xs"
            variant="outline"
            onClick={() => setSelected(new Set(selectableIds))}
            data-testid="repeating-select-all"
          >
            {/* NAMES WHAT IT WILL TICK, and it is the filtered set, not the
                whole book. "Select all" over a filtered table is the one
                place a selection can quietly be bigger than it looks. */}
            Select these {selectableIds.length}
          </Button>
          {selected.size > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          )}
        </HStack>
      )}

      {/* SORTING ON A PHONE, where the headers that carry it do not render.
          Without this the feature simply would not exist below `md` — and
          reading the list on a phone is the half this operator does most.
          It writes the same `sortKey` / `sortDir` the headers do. */}
      <HStack gap={2} hideFrom="md">
        <Box flex="1" minW={0}>
          <Select.Root
            collection={sortCollection}
            value={[sortKey]}
            onValueChange={(e) => {
              const next = (e.value?.[0] ?? "next") as SortKey;
              setSortKey(next);
              setSortDir(SORTABLE.find((c) => c.key === next)?.defaultDir ?? "asc");
            }}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
          >
            <Select.HiddenSelect />
            <Select.Control>
              <Select.Trigger w="full" px="2" data-testid="repeating-sort-mobile">
                <Select.ValueText placeholder="Sort by…" />
                <Select.Indicator />
              </Select.Trigger>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {sortCollection.items.map((it) => (
                    <Select.Item key={it.value} item={it}>
                      {it.label}
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
          </Select.Root>
        </Box>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          title={sortDir === "asc" ? "Ascending — tap to reverse" : "Descending — tap to reverse"}
          aria-label={sortDir === "asc" ? "Sort ascending, reverse it" : "Sort descending, reverse it"}
          data-testid="repeating-sort-dir"
        >
          {sortDir === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
        </Button>
      </HStack>

      {/* Column headers, desk width only — on a phone each cell names itself. */}
      <Box
        display="grid"
        gridTemplateColumns={COLS}
        gap={3}
        px={2}
        hideBelow="md"
      >
        <Box />
        {/* EACH TITLE IS THE CONTROL. Rendered from SORTABLE rather than
            written out, so a column cannot be sortable in the header and
            missing from the phone picker below. The arrow appears only on
            the active column — an arrow on every header says nothing about
            which one the rows are actually in. */}
        {SORTABLE.map((col) => {
          const active = sortKey === col.key;
          return (
            <Box
              key={col.key}
              as="button"
              onClick={() => toggleSort(col.key)}
              display="inline-flex"
              alignItems="center"
              gap={1}
              textAlign="start"
              minW={0}
              cursor="pointer"
              color={active ? "fg" : "fg.muted"}
              fontWeight={active ? "semibold" : undefined}
              _hover={{ color: "fg" }}
              transition="color 0.1s"
              title={`Sort by ${col.label.toLowerCase()}`}
              aria-label={`Sort by ${col.label.toLowerCase()}${
                active ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""
              }`}
              data-testid={`repeating-sort-${col.key}`}
              data-active={active ? "1" : "0"}
              data-dir={active ? sortDir : ""}
            >
              <Box as="span" fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em">
                {col.label}
              </Box>
              {active &&
                (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
            </Box>
          );
        })}
        <Box />
      </Box>

      {filtered.length === 0 ? (
        <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" p={4}>
          <Text fontSize="sm" color="fg.muted">
            {counts.total === 0
              ? "No repeating job occurrences yet. One repeats once its service has a cadence."
              : "Nothing matches these filters."}
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={2} data-testid="repeating-rows">
          {filtered.map((row) => {
            const meta = statusMeta(row);
            const selectable = row.canPause || row.canResume;
            const isSelected = selected.has(row.id);
            return (
              <Box
                key={row.id}
                display="grid"
                gridTemplateColumns={COLS}
                gap={3}
                alignItems="start"
                borderWidth="1px"
                borderColor={isSelected ? "purple.emphasized" : "border"}
                bg={isSelected ? "purple.faint" : undefined}
                borderRadius="md"
                px={2}
                py={2}
                data-testid={`repeating-row-${row.id}`}
                data-status={row.status}
                data-selected={isSelected ? "1" : "0"}
              >
                <Box pt="1">
                  {canManage && (
                    <Checkbox.Root
                      checked={isSelected}
                      disabled={!selectable}
                      onCheckedChange={() => toggle(row.id)}
                      size="sm"
                      aria-label={`Select ${row.clientName} ${row.service ?? "repeating job occurrence"}`}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                    </Checkbox.Root>
                  )}
                </Box>

                {/* On a phone everything after the checkbox stacks into the
                    second column; at desk width each piece takes its own. */}
                <Cell label="Customer">
                  <Text fontSize="sm" fontWeight="medium">{row.clientName}</Text>
                  <Text fontSize="xs" color="fg.muted">{row.propertyName}</Text>
                </Cell>

                {/* THE CADENCE IS THE PRIMARY LINE WHEN NOTHING NAMES THE
                    STREAM, which is nearly always: no live stream in dev and
                    one of forty-five in production carries a job type, title
                    or description. Rendering a placeholder word on every row
                    filled the column with something that looked like data
                    until you noticed it never changed. */}
                <Cell label="Service">
                  {row.service ? (
                    <>
                      <Text fontSize="sm">{row.service}</Text>
                      <Text fontSize="xs" color="fg.muted">
                        {row.frequencyDays ? `every ${row.frequencyDays} days` : "—"}
                      </Text>
                    </>
                  ) : (
                    <Text fontSize="sm">
                      {row.frequencyDays ? `Every ${row.frequencyDays} days` : "—"}
                    </Text>
                  )}
                </Cell>

                <Cell label="Next visit">
                  <Text fontSize="sm">{row.startAt ? fmtDate(row.startAt) : "—"}</Text>
                </Cell>

                <Cell label="State">
                  <Badge size="sm" variant="subtle" colorPalette={meta.palette}>
                    {meta.label}
                  </Badge>
                  {/* WHY A ROW CANNOT BE TICKED, said on the row. The rule is
                      the operator's: settle the money first, then hold the
                      visit that replaces it. */}
                  {row.blockedReason && (
                    <Text fontSize="2xs" color="fg.muted" mt={1}>
                      {row.blockedReason}
                    </Text>
                  )}
                  {row.status === "PENDING_PAYMENT" && (
                    <Button
                      size="2xs"
                      variant="ghost"
                      colorPalette="orange"
                      px="1"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("navigate:staffTab", {
                            detail: { tab: "payments", category: "Money" },
                          }),
                        )
                      }
                      data-testid="repeating-go-payments"
                    >
                      Go to Payments
                    </Button>
                  )}
                </Cell>

                <Cell label="Reason" emptyOnMobile={!row.canResume}>
                  {row.canResume ? (
                    <>
                      <HStack gap={1}>
                        <Box color="purple.fg"><PauseCircle size={12} /></Box>
                        <Text fontSize="sm">{row.streamPauseReasonLabel ?? "Reason not recorded"}</Text>
                      </HStack>
                      {row.streamPauseReason && (
                        <Text fontSize="2xs" color="fg.muted">{row.streamPauseReason}</Text>
                      )}
                      <HStack gap={1} mt={1}>
                        <Box color={row.reminderDue ? "red.fg" : "fg.muted"}>
                          <CalendarClock size={11} />
                        </Box>
                        <Text fontSize="2xs" color={row.reminderDue ? "red.fg" : "fg.muted"}>
                          {row.streamResumeReminderAt
                            ? `check back ${fmtDate(row.streamResumeReminderAt)}`
                            : "no check-back date"}
                        </Text>
                      </HStack>
                    </>
                  ) : (
                    <Text fontSize="xs" color="fg.muted">—</Text>
                  )}
                </Cell>

                {/* ONE STACK, EVERY BUTTON THE FULL WIDTH OF THE COLUMN.
                    These were a wrapping, right-aligned row with the link
                    beneath it at a smaller size, which in a 176px column
                    produced three buttons at three widths on three
                    alignments — "Resume repeating" filling the line, "Edit
                    pause" ending short of it, "Open" starting left of both.
                    Nothing lined up with anything.

                    A fixed-width column cannot fit these side by side, so
                    the honest layout is a stack: same width, same size, same
                    edges, in a fixed order. It also gives a phone three
                    full-width tap targets instead of a wrapped row. */}
                <VStack
                  align="stretch"
                  gap={1}
                  gridColumn={{ base: "2", md: "auto" }}
                >
                  {/* THE SHARED CLUSTER, not buttons of this tab's own. */}
                  <StreamPauseActions
                    occ={row}
                    canManage={canManage}
                    controls={streamControls}
                    busyId={busyId}
                    setBusyId={setBusyId}
                    size="xs"
                  />
                  {/* Ghost, because it navigates rather than changing
                      anything — but the same size as the others, so the
                      column reads as one block. */}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenService(row.jobId, row.id)}
                    title="Open this job occurrence in Services"
                    data-testid="repeating-open-service"
                  >
                    <ExternalLink size={11} />
                    Open
                  </Button>
                </VStack>
              </Box>
            );
          })}
        </VStack>
      )}

      {/* THE SELECTION BAR. Sticky, because the rows it describes are what
          you scrolled through to build it, and a count you have to scroll
          back up to read is a count you stop trusting. */}
      {canManage && selected.size > 0 && (
        <Box
          position="sticky"
          bottom="0"
          bg="bg"
          borderTopWidth="1px"
          borderColor="border.emphasized"
          py={2}
          px={2}
          data-testid="repeating-selection-bar"
        >
          <HStack gap={2} wrap="wrap">
            <Text fontSize="sm" fontWeight="medium">
              {selected.size} selected
            </Text>
            {/* EACH BUTTON CARRIES ITS OWN COUNT. A mixed selection is normal
                in spring — some held, some running — and "Pause" over 23 rows
                when only 21 can be paused is the kind of quiet arithmetic
                this screen exists to remove. */}
            {toPause.length > 0 && (
              <Button
                size="sm"
                colorPalette="purple"
                variant="outline"
                loading={selection.busy}
                onClick={() => selection.openPauseMany(toPause.map(selectionRow))}
                data-testid="repeating-pause-selected"
              >
                Pause {toPause.length}
              </Button>
            )}
            {toResume.length > 0 && (
              <Button
                size="sm"
                colorPalette="green"
                variant="outline"
                loading={selection.busy}
                onClick={() => selection.openResumeMany(toResume.map(selectionRow))}
                data-testid="repeating-resume-selected"
              >
                Resume {toResume.length}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </HStack>
        </Box>
      )}

      {streamControls.dialogs}
      {selection.dialogs}
    </VStack>
  );
}
