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
  HStack,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { ArrowDown, ArrowUp, CalendarClock, ChevronDown, ExternalLink, PauseCircle, Repeat } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import type { Scope } from "@/src/lib/scope";
import { fmtDate } from "@/src/lib/dates";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import PaymentWaitBadges from "@/src/ui/components/PaymentWaitBadges";
import ClientContactMenu, { type DraftMessage } from "@/src/ui/components/ClientContactMenu";
import {
  ALL_PAUSE_REASONS,
  StreamPauseActions,
  StreamPauseFilter,
  passesPauseFilter,
  useStreamPauseControls,
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
  /** PENDING_PAYMENT only. Measured from the day the work was finished —
   *  see the server type for why that and not the invoice date. */
  awaitingPaymentSince: string | null;
  awaitingPaymentDays: number | null;
  /** The other clock — when we last asked the client, and the original ask. */
  paymentRequestedAt: string | null;
  paymentRequestedDays: number | null;
  paymentFirstRequestedAt: string | null;
  paymentFirstRequestedDays: number | null;
  paymentResendCount: number;
  /** Nobody has asked for this money yet — the operator's move. */
  paymentNeverRequested: boolean;
  /** The day this stream's next visit was due, when it stopped making them. */
  nextVisitDueOn: string | null;
  /** Days past that date. Non-null IS the expired condition. */
  expiredDays: number | null;
  /** The stall has already been silenced elsewhere — show it quietly. */
  expirySuppressed: boolean;
  /** The customer's primary contact. Null unless the caller holds
   *  `clients.view` — the server omits them, it does not hide them. */
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** NULL when this stream has no live visit — see `dormancy`. `id` is the
   *  row key either way (`job:<jobId>` when there is no occurrence). */
  occurrenceId: string | null;
  /** Why this stream has no live visit. Null when it has one. */
  dormancy: "never-ran" | "cancelled" | "stopped" | null;
  lastServedAt: string | null;
  /** Visits missed since `lastServedAt`, in this stream's own cadence. */
  missedCycles: number | null;
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
  // ONE TRACK ON A PHONE now that the tick column is gone; cells no longer
  // need pinning to a second column (see the note on `Cell`).
  base: "minmax(0, 1fr)",
  md:
    "minmax(0, 1.5fr) " + // customer + property
    "minmax(0, 1fr) " + // service + cadence
    "116px " + // next visit — a date, with the Expired chip beneath it
    "232px " + // state badge, both money clocks, and why it is blocked
    "minmax(0, 1.2fr) " + // reason + note + reminder
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
  // THE UNSERVED COME FIRST. Everything below them is a stream doing
  // something; this one is a customer the book says we have and are not
  // visiting, which is the most urgent thing this screen can tell you and
  // the thing it used not to say at all.
  "NO_VISIT",
  "SCHEDULED",
  "STREAM_PAUSED",
  "PENDING_PAYMENT",
  "IN_PROGRESS",
  "PAUSED",
] as const;

/** Every key here must appear in `SORTABLE` below, which is the ONE list
 *  both the headers and the phone picker render from — so a key missing
 *  from it is a branch nothing can reach. `"checkBack"` was exactly that:
 *  a member of this union with a live `case` in the comparator and no way
 *  on earth to select it. Found by the vocabulary scan, not by tsc, which
 *  is perfectly happy with an unreachable union member. */
type SortKey = "customer" | "service" | "next" | "state" | "reason";

/**
 * The summary strip doubles as the filter, and each chip resolves to ONE
 * piece of state — never a second copy of one that already exists.
 *
 * Two of these six already had a dedicated control: "paused" is what
 * `StreamPauseFilter` writes and "due" is what the Due button writes. Giving
 * the chips their own booleans for those would have been two switches for one
 * question, which is the precise shape of the bug that got the previous
 * bulk-pause feature deleted — a stale second stamp swept up a job the
 * operator had deliberately stopped.
 *
 * So the chips WRITE the existing state and READ their active flag back out
 * of it (`activeLens` below). Click "paused" and the StreamPauseFilter button
 * lights up with it, because there is only one `pausedOnly`.
 */
type Lens = "all" | "scheduled" | "paused" | "blocked" | "due" | "expired" | "unserved";

/** The three lenses that needed state of their own; the other three are
 *  derived from controls that already existed. */
type View = "all" | "scheduled" | "blocked" | "expired" | "unserved";

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

/**
 * One chip in the summary strip: a count, and the way into that slice.
 *
 * ONE COMPONENT so "lit" looks the same on all six. The active rung is
 * `solid` against `subtle`, which is the same step the Due button and the
 * sort headers already use for on/off on this screen.
 *
 * THREE TONES, and the distinction between them is a colour rule rather
 * than a styling preference:
 *
 *   "expired" — the near-black house sign, matching the "Expired N" chip
 *       Work → Jobs puts on the Today group. THE DARK FILL MEANS EXPIRED AND
 *       NOTHING ELSE on this strip. It pins no raw ramp value: the Jobs chip
 *       uses `gray.600`/`gray.50`, which is the one thing the theming rules
 *       here forbid, because a raw ramp number is the same wash in all
 *       fourteen themes — including the four built on a dark ground, where a
 *       gray.600 chip sits on a near-black card and stops being obvious. The
 *       `solid` step resolves per theme instead.
 *
 *   "neutral" — the "show everything" chip. It NEVER takes a fill or a ring,
 *       and that is the fix for a real collision: it was grey like every
 *       other unlit chip, then went `solid` on the gray palette when active
 *       — which is near-black, the expired colour exactly, on a chip that
 *       has nothing to do with expiry.
 *
 *       Leaving it unemphasised is also the more honest state. This chip
 *       being "active" means NO filter is applied, which is the table's
 *       resting state, not a selection. Nothing was chosen, so nothing
 *       should look chosen — the confirmation that the click worked is the
 *       other chips going dark and the rows coming back.
 *
 *   "normal" — subtle, going solid with a ring when lit. The coloured
 *       palettes stay legible as themselves at both rungs.
 */
function LensChip({
  lens,
  active,
  onPick,
  palette,
  tone = "normal",
  withMenu = false,
  title,
  children,
  ...rest
}: {
  lens: Lens;
  active: boolean;
  onPick: (l: Lens) => void;
  palette: string;
  tone?: "normal" | "expired" | "neutral";
  /** This chip opens a menu instead of toggling — it gets a caret so the
   *  difference is visible before you click, and drops the "click again to
   *  show everything" hint, which is not how it clears. */
  withMenu?: boolean;
  title: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const expired = tone === "expired";
  const neutral = tone === "neutral";
  // The ring is what separates a LIT chip from an unlit expired one, which
  // is already solid. EVERY chip gets it, the neutral one included — what
  // that chip must not take is the near-black FILL, not the emphasis.
  const lit = active;
  // Filled with the palette's `solid` step — near-black on gray, which is
  // the expired sign. The neutral chip is deliberately excluded and takes a
  // darker grey instead; see below.
  const filled = expired || (lit && !neutral);
  return (
    <Badge
      as="button"
      variant={filled ? "solid" : "subtle"}
      colorPalette={palette}
      /* BOTH HALVES OF THE PAIR, SPELLED OUT, and that is not belt-and-braces.
         The paused chip is handed to `Select.Trigger asChild`, and Chakra's
         trigger recipe overrode the badge's `solid` BACKGROUND while leaving
         its `solid` FOREGROUND alone — so the lit chip rendered white text on
         the page's white ground and simply vanished. Invisible, not ugly: the
         e2e read the right string out of the DOM the whole time.

         `solid` is a fill and `contrast` is the ink that has to stay legible
         on it; themeTokens keeps them tuned as a pair per theme, which is why
         naming both here still themes correctly where a raw hex would not. */
      /* THREE RUNGS, NOT TWO. The lit neutral chip steps from `gray.subtle`
         to `gray.emphasized` — visibly pressed, still plainly grey. It had
         been excluded from emphasis altogether, which fixed the collision
         with the expired chip (both went near-black) by overcorrecting: the
         one chip that clears every filter gave no sign it had been used. */
      bg={
        filled
          ? `${palette}.solid`
          : lit
            ? `${palette}.emphasized`
            : `${palette}.subtle`
      }
      color={filled ? `${palette}.contrast` : `${palette}.fg`}
      /* The same recipe also imposes a form-control's height and border on
         the chip it is wrapping, which made the paused one a 36px outlined
         box in a row of 20px tinted chips. Pinned back to the badge's own
         shape so it sits in the strip as one of six, not as a form field
         that wandered in — height, border AND font size, which was the last
         one left and made this chip's text a size larger than its five
         neighbours. Measured, not eyeballed: all six are 20px tall, 12px
         text, no border. */
      {...(withMenu ? { h: "auto", minH: "0", border: "none", fontSize: "xs" } : {})}
      onClick={() => onPick(lens)}
      cursor="pointer"
      px="2"
      borderRadius={expired ? "full" : undefined}
      title={`${title}${active && !neutral && !withMenu ? " — click again to show everything" : ""}`}
      aria-pressed={neutral ? undefined : active}
      outline={lit ? "2px solid" : undefined}
      outlineColor={lit ? "fg.muted" : undefined}
      outlineOffset={lit ? "1px" : undefined}
      data-active={active ? "1" : "0"}
      data-lens={lens}
      display={withMenu ? "inline-flex" : undefined}
      alignItems={withMenu ? "center" : undefined}
      gap={withMenu ? "1" : undefined}
      {...rest}
    >
      {/* THE CHIP BODY FILTERS; ONLY THE CARET OPENS THE MENU.
          The whole chip was the menu trigger, so clicking it did not filter
          — you had to open it and then pick "Paused — any reason", a second
          step with nothing on screen to suggest it, while the five chips
          beside it all filtered on the first click.

          The Badge IS the Select trigger (asChild), so a click anywhere in
          it reaches the menu. The body stops that at both `pointerdown` —
          which is where the menu actually opens, so stopping only `click`
          is too late — and `click`, then toggles the lens itself. The caret
          is left unwrapped and so still bubbles through. */}
      {withMenu ? (
        <Box
          as="span"
          display="inline-flex"
          alignItems="center"
          onPointerDown={(e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            onPick(lens);
          }}
          data-testid="lens-chip-body"
        >
          {children}
        </Box>
      ) : (
        children
      )}
      {withMenu && (
        <Box as="span" display="inline-flex" title="Narrow to one pause reason">
          <ChevronDown size={11} />
        </Box>
      )}
    </Badge>
  );
}

/** THE FOUR PREDICATES, module level so the chip's count and the chip's
 *  filter are provably the same expression. They were inline in two places
 *  and that is how a count and the list under it start to disagree. */
const isScheduled = (r: Row) => r.status === "SCHEDULED";
/** `PausedRepeating`, never bare `isPaused` — `status === "PAUSED"` is a
 *  worker's timer stopped mid-visit, an unrelated state this table also
 *  lists. The two have been one careless rename apart since they were named. */
const isPausedRepeating = (r: Row) => r.status === "STREAM_PAUSED";
/** Cannot be held yet — blocked on something else being resolved first. */
const isBlocked = (r: Row) => !r.canPause && !r.canResume;
/** A silenced stall is deliberately NOT expired for counting or filtering —
 *  somebody already said they know about it. The row still shows it, muted. */
const isExpired = (r: Row) => r.expiredDays !== null && !r.expirySuppressed;
/** No live visit at all: stopped, cancelled, or never started.
 *
 *  Asks `dormancy`, which EXISTS only for these rows, rather than matching a
 *  list of status strings — one less place for a spelling to drift. */
const isUnserved = (r: Row) => r.dormancy !== null;

/**
 * The message the operator would plausibly send about THIS row.
 *
 * Keyed on what they are about to do, which is the whole value: the point of
 * a contact icon here rather than a trip to Customers is that the decision
 * and the telling happen in one place. A row with nothing obvious to say
 * returns null and still offers the bare Text / Email / Call.
 *
 * DRAFTS, NEVER SENDS — see the note in ClientContactMenu. The operator
 * reads and edits every one of these in their own messaging app, which is
 * why the copy can be warm without being a liability: nothing goes out that
 * a person did not read first.
 */
function draftFor(row: Row): DraftMessage | null {
  const who = row.contactName ? `Hi ${row.contactName},` : "Hi,";
  const what = row.service ? row.service.toLowerCase() : "recurring service";
  const where = row.propertyName && row.propertyName !== "—" ? ` at ${row.propertyName}` : "";

  if (row.canPause) {
    const when = row.startAt ? ` after the visit on ${fmtDate(row.startAt)}` : "";
    return {
      label: "Draft: we're pausing this",
      subject: "Seedlings Lawn Care — pausing your service",
      body:
        `${who}\n\nJust a heads up that we're going to pause your ${what}${where}${when}. ` +
        `Nothing else changes, and we'll be in touch before we start back up.\n\n` +
        `Thanks,\nSeedlings Lawn Care`,
    };
  }
  if (row.canResume) {
    const when = row.suggestedResumeAt ? ` starting ${fmtDate(row.suggestedResumeAt)}` : "";
    return {
      label: "Draft: we're starting back up",
      subject: "Seedlings Lawn Care — restarting your service",
      body:
        `${who}\n\nGood news — we're restarting your ${what}${where}${when}. ` +
        `You don't need to do anything.\n\nThanks,\nSeedlings Lawn Care`,
    };
  }
  if (row.dormancy) {
    // THE MESSAGE THIS WHOLE FEATURE IS FOR. The row exists because a
    // customer stopped being visited and nobody noticed; the useful next
    // action is almost always to ask them whether they still want the
    // service, not to silently rebook or silently drop them.
    const gap = row.lastServedAt ? ` since ${fmtDate(row.lastServedAt)}` : "";
    return {
      label: "Draft: are we still on?",
      subject: "Seedlings Lawn Care — checking in",
      body:
        `${who}\n\nI was reviewing our schedule and noticed we haven't been ` +
        `out${where}${gap}. I wanted to check whether you'd like us to pick ` +
        `your ${what} back up, or whether you'd rather we hold off.\n\n` +
        `Either way is fine — just let me know.\n\nThanks,\nSeedlings Lawn Care`,
    };
  }
  // AWAITING PAYMENT IS NOT DRAFTED HERE, on purpose. Money → Payments owns
  // that message because it carries the invoice link and records the
  // handoff; a cheerful second version written from this screen would reach
  // the customer without either.
  return null;
}

function statusMeta(row: Row): { label: string; palette: string } {
  // "PAUSED REPEATING", WHICH IS WHAT THE REST OF THE APP CALLS IT. This
  // read "Held" — a word invented for this tab and used nowhere else in the
  // product. Work → Jobs filters on "Paused repeating", Customers filters on
  // "Paused repeating only", Services alerts on "Paused repeating to
  // review", and the button on this very row says "Pause repeating". A row
  // whose action and whose state use different words for one thing teaches
  // the operator that they are two things.
  //
  // The full two-word label rather than a bare "Paused", because "Timer
  // paused" is a DIFFERENT state four lines below this one: `PAUSED` is a
  // worker's timer stopped mid-visit, `STREAM_PAUSED` is the repeating
  // stopped. Shortening it would put two unrelated states one word apart in
  // the same column.
  if (row.status === "STREAM_PAUSED") return { label: "Paused repeating", palette: "purple" };
  if (row.status === "SCHEDULED") return { label: "Scheduled", palette: "blue" };
  if (row.status === "PENDING_PAYMENT") return { label: "Awaiting payment", palette: "orange" };
  if (row.status === "IN_PROGRESS") return { label: "On site", palette: "green" };
  if (row.status === "PAUSED") return { label: "Timer paused", palette: "yellow" };
  // THE STREAMS WITH NO LIVE VISIT. Red, because every one of them is a
  // customer the business believes it is serving and is not — the state that
  // let a cancelled fortnightly go 73 days unnoticed.
  //
  // KEYED ON `dormancy`, NOT ON A FAKE STATUS. `status` carries a real
  // `JobOccurrenceStatus` on every other row; these have no occurrence, so
  // theirs is the single synthetic `NO_VISIT` and the three-way distinction
  // lives in its own field. The first cut put "STOPPED"/"CANCELLED" in
  // `status` — and "CANCELLED" has two Ls where the enum has one, which is a
  // mismatch no test and no compiler would ever have reported.
  if (row.dormancy === "stopped") return { label: "Not being served", palette: "red" };
  if (row.dormancy === "cancelled") return { label: "Cancelled, nothing since", palette: "red" };
  if (row.dormancy === "never-ran") return { label: "Never started", palette: "red" };
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
  onOpenService: (jobId: string, occurrenceId: string | null) => void;
}) {
  // `schedule.manage` — the capability every per-row pause and resume
  // endpoint is guarded on. Named here, on the control's own screen, rather
  // than inferred from where the tab happens to be mounted.
  const canManage = scope.can("schedule.manage");

  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [pausedOnly, setPausedOnly] = useState(false);
  const [reasonCode, setReasonCode] = useState<string>(ALL_PAUSE_REASONS);
  const [dueOnly, setDueOnly] = useState(false);
  const [view, setView] = useState<View>("all");
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
      // The three lenses with state of their own. Each predicate is the
      // SAME expression its chip counts with — written once below in
      // `counts` and reused here, so a chip can never read "6 expired" and
      // then show a different six.
      if (view === "scheduled" && !isScheduled(r)) return false;
      if (view === "blocked" && !isBlocked(r)) return false;
      if (view === "expired" && !isExpired(r)) return false;
      if (view === "unserved" && !isUnserved(r)) return false;
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
     * A row with no pause reason, or no name of its own, carries no
     * information about where it belongs in that order. Letting it fall out
     * of the comparison naturally would float every one of them to the top
     * the moment you reversed the sort — and on this table a blank Reason is
     * the commonest value in that column by far, since only a paused row has
     * one, so reversing would bury the reasons under the blanks instead of
     * showing them.
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
        default:
          return null;
      }
    };

    // Sorted on a COPY: `kept` is derived here, but sorting in place is the
    // habit that mutates a memoised array somebody else is holding.
    return [...kept].sort((a, b) => {
      const primary = cmp(key(a), key(b));
      if (primary !== 0) return primary;
      // WORST NEGLECT FIRST among the unserved. They share a state and have
      // no `startAt` to break the tie, so without this the customer missed
      // eleven times and the one missed twice arrive in whatever order the
      // database felt like.
      if (a.missedCycles !== null || b.missedCycles !== null) {
        const d = (b.missedCycles ?? -1) - (a.missedCycles ?? -1);
        if (d !== 0) return d;
      }
      // One stable tie-break for every column, so repeated clicks do not
      // reshuffle rows that compare equal.
      return cmp(a.startAt ? Date.parse(a.startAt) : null, b.startAt ? Date.parse(b.startAt) : null);
    });
  }, [rows, q, pausedOnly, reasonCode, dueOnly, view, sortKey, sortDir]);

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
      live: all.filter(isScheduled).length,
      // THROUGH THE SHARED PREDICATE, because this chip's filter is now a
      // reason as well as a state. Counting every paused row while showing
      // only the "Season over" ones is exactly the count-says-one-thing,
      // table-shows-another failure the other five chips are gated against.
      paused: all.filter((r) => passesPauseFilter(r, true, reasonCode)).length,
      blocked: all.filter(isBlocked).length,
      due: all.filter((r) => r.reminderDue).length,
      expired: all.filter(isExpired).length,
      unserved: all.filter(isUnserved).length,
    };
  }, [rows, reasonCode]);

  /**
   * WHICH CHIP IS LIT, derived rather than stored.
   *
   * Three of the six lenses live in state that predates them, so asking
   * "which chip is active" has to be a question about that state and not a
   * seventh variable tracking it. Stored separately, clearing the Due button
   * would leave its chip lit.
   */
  /** The chosen reason in the operator's words, for the chip and its title.
   *  Falls back to the raw code so a reason retired since the pause was
   *  written still renders as something rather than vanishing. */
  const pauseReasonLabel =
    reasons.find((r) => r.code === reasonCode)?.label ?? reasonCode;

  const activeLens: Lens = pausedOnly
    ? "paused"
    : dueOnly
      ? "due"
      : view !== "all"
        ? view
        : "all";

  /**
   * THE ONE PLACE A LENS CHANGE HAPPENS. No toggling here — it takes the
   * target outright — because the two ways into it want different answers to
   * "what does clicking the thing that is already on mean":
   *
   *   • A chip toggles: clicking the lit one clears back to everything.
   *   • The paused dropdown does not. Picking a second reason while paused is
   *     already on is a re-narrowing, not a request to switch it off; routed
   *     through a toggle it would have cleared the filter instead.
   *
   * Both still land here, so there is still one statement of what a lens
   * change does to the other filters.
   */
  const setLens = useCallback((target: Lens, reason: string = ALL_PAUSE_REASONS) => {
    setPausedOnly(target === "paused");
    // A reason only means something inside the paused lens; leaving it set
    // would silently narrow the NEXT paused click to last time's reason.
    setReasonCode(target === "paused" ? reason : ALL_PAUSE_REASONS);
    setDueOnly(target === "due");
    setView(
      target === "scheduled" || target === "blocked" || target === "expired" || target === "unserved"
        ? target
        : "all",
    );
  }, []);

  /** A chip: clicking the lit one returns to everything. */
  const applyLens = useCallback(
    (next: Lens) => {
      const target: Lens = next === activeLens ? "all" : next;
      setLens(target);
    },
    [activeLens, setLens],
  );

  /**
   * The paused chip's dropdown, which is the shared `StreamPauseFilter`
   * wearing the chip as its trigger. It speaks `{active, reasonCode}`; this
   * translates that into the lens model without a second copy of the rules.
   */
  const applyPauseFilter = useCallback(
    (next: { active: boolean; reasonCode: string }) =>
      setLens(next.active ? "paused" : "all", next.reasonCode),
    [setLens],
  );

  if (rows === null) {
    return (
      <HStack justify="center" py="10">
        <Spinner size="sm" />
        <Text fontSize="sm" color="fg.muted">Loading repeating job occurrences…</Text>
      </HStack>
    );
  }

  return (
    <VStack align="stretch" gap={3} pb="2">
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
          Every job occurrence that repeats, and whether it is running or paused.
          Pause a whole season here in one pass instead of opening each visit.
          One-off visits are not listed — there is nothing to pause on one.
        </Text>
      </Box>

      {/* THE SHAPE OF THE BOOK, AND THE FILTER. Counted against every row,
          never the filtered set — the strip says what the book is, and a
          strip whose numbers moved as you filtered could not tell you that.

          Each chip is also the way into its own slice. Clicking the lit one
          clears back to everything, which is the toggle the Due button
          already had. See the `Lens` type for why three of these write state
          that already existed rather than adding their own. */}
      <HStack gap={2} wrap="wrap" data-testid="repeating-summary">
        <LensChip
          lens="all"
          active={activeLens === "all"}
          onPick={applyLens}
          palette="gray"
          tone="neutral"
          title="Show every repeating job occurrence"
        >
          {counts.total} repeating
        </LensChip>
        {/* THE CHIP THIS WHOLE PASS EXISTS FOR. A customer whose repeating
            stopped used to vanish from this table entirely — no row, no
            count, nothing to filter to. One of them was cancelled in
            September and went 73 days and five missed visits before anyone
            noticed, and the way they noticed was a bad review. */}
        {counts.unserved > 0 && (
          <LensChip lens="unserved" active={activeLens === "unserved"} onPick={applyLens} palette="red"
            title="Customers we believe we have, with no visit booked and nobody having decided to stop — stopped, cancelled, or never started">
            {counts.unserved} not being served
          </LensChip>
        )}
        <LensChip lens="scheduled" active={activeLens === "scheduled"} onPick={applyLens} palette="blue"
          title="Only the ones still running — these are what an end-of-season sweep pauses">
          {counts.live} scheduled
        </LensChip>
        {/* THE PAUSED CHIP IS THE REASON FILTER. It used to be a chip plus a
            separate purple icon button two rows down, which between them
            said one thing twice: the chip counted the paused rows, the
            button narrowed them to a reason, and neither mentioned the
            other. Folding the menu onto the chip leaves one control that
            states the count, the state, and the reason it is narrowed to.

            It opens a menu rather than toggling, unlike the other five — a
            second reason picked while paused is already on is a
            re-narrowing, not a request to switch off. "All repeating job
            occurrences" at the top of the menu is how you clear it. */}
        <StreamPauseFilter
          active={pausedOnly}
          reasonCode={reasonCode}
          reasons={reasons}
          onChange={applyPauseFilter}
          offLabel="All repeating job occurrences"
          trigger={
            <LensChip
              lens="paused"
              active={activeLens === "paused"}
              /* Clicking the body filters to every paused row, exactly like
                 the five chips beside it. The caret is what opens the reason
                 menu — see the note in LensChip about why the body has to
                 stop the event at pointerdown. */
              onPick={applyLens}
              palette="purple"
              withMenu
              /* A PLAIN TOGGLE, like the five beside it. Widening to "all
                 paused" on a click while narrowed was the other candidate
                 and it loses: it makes this one chip answer a click
                 differently depending on its own state, which is the thing
                 that just sent the operator hunting through a menu. */
              title={
                !pausedOnly
                  ? "Only the ones already paused — the repeating is stopped, the customer is not archived. Use the arrow to narrow to one reason"
                  : reasonCode !== ALL_PAUSE_REASONS
                    ? `Showing only: paused — ${pauseReasonLabel}. Click to show everything; use the arrow to pick another reason`
                    : "Showing only the paused ones. Click to show everything; use the arrow to narrow to one reason"
              }
            >
              {counts.paused} paused
              {pausedOnly && reasonCode !== ALL_PAUSE_REASONS ? ` · ${pauseReasonLabel}` : ""}
            </LensChip>
          }
        />
        {counts.blocked > 0 && (
          <LensChip lens="blocked" active={activeLens === "blocked"} onPick={applyLens} palette="orange"
            title="Only the ones that cannot be paused until something else is resolved first">
            {counts.blocked} cannot be paused yet
          </LensChip>
        )}
        {counts.due > 0 && (
          <LensChip lens="due" active={activeLens === "due"} onPick={applyLens} palette="red"
            title="Only the paused ones whose reminder date has arrived — the ones asking for a decision">
            {counts.due} to review
          </LensChip>
        )}
        {/* THE NUMBER NOBODY WAS BEING TOLD. A stream whose next visit came
            due and was never made is not held, not scheduled and not
            finished — it is simply gone from the calendar, and the only
            trace was a gap. Nine of them in the live book when this was
            written, the oldest a month old, eight waiting on money.

            THE DARK CHIP IS THE HOUSE SIGN FOR EXPIRED — the same one Work →
            Jobs puts on the Today group for expired next visits, which is
            the same event seen from the other end. Two names and two colours
            for one condition is how an operator ends up thinking they are
            two problems. */}
        {counts.expired > 0 && (
          <LensChip
            lens="expired"
            active={activeLens === "expired"}
            onPick={applyLens}
            palette="gray"
            tone="expired"
            title="The next visit came due and was never created — usually because the current one is still waiting on payment."
            data-testid="repeating-expired-count"
          >
            {counts.expired} expired
          </LensChip>
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
        {/* NO FILTER CONTROLS LEFT HERE — the summary strip is all of them.
            A "To review" button and a pause-reason icon button used to sit
            beside this box, each saying what a chip one row up already said.
            Both are folded into their chips, so every filter on this screen
            has exactly one control and the strip is the whole story. */}
      </HStack>

      {failed && (
        <Text fontSize="sm" color="red.fg">
          Could not load the list. Nothing has been changed.
        </Text>
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
        {/* NO LEADING SPACER. There was one, for the checkbox column, and
            removing that column from COLS without removing it here put SIX
            header cells into five tracks — every title sat over the column
            to its right, which is the exact unreadability COLS exists to
            prevent, reintroduced by a deletion rather than an addition. */}
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
            return (
              <Box
                key={row.id}
                display="grid"
                gridTemplateColumns={COLS}
                gap={3}
                alignItems="start"
                borderWidth="1px"
                borderColor="border"
                /* A STRIPE, AND IT IS ALWAYS THERE. The expired rows are the
                   ones to find while scanning, so the highlight has to work
                   without reading any cell — but a border that only appears
                   on some rows moves those rows' contents 3px right, and
                   columns that do not line up is the exact failure this
                   table's COLS constant exists to prevent. So every row
                   reserves the stripe and only the expired ones ink it.

                   Left edge rather than the whole border: the full border is
                   already spoken for by the row's own outline. */
                borderLeftWidth="3px"
                borderLeftColor={
                  row.expiredDays === null
                    ? "transparent"
                    : row.expirySuppressed
                      ? "border.emphasized"
                      : /* Matches the chip rather than competing with it. It
                           was red while the chip is near-black, which made
                           one condition look like two marks for two
                           reasons. `fg` is the ink the chip is filled with,
                           so the stripe and the chip read as one signal and
                           both invert together on a dark ground. */
                        "fg"
                }
                borderRadius="md"
                px={2}
                py={2}
                data-testid={`repeating-row-${row.id}`}
                data-status={row.status}
                data-expired={row.expiredDays === null ? "0" : String(row.expiredDays)}
              >
                {/* On a phone the cells stack; at desk width each takes its
                    own column. */}
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
                  {/* NO DATE MEANS NO VISIT, and the cell has to say which
                      kind of nothing rather than printing an em dash. The
                      number is MISSED VISITS, not days: "73 days" means
                      nothing without knowing the cadence, while "5.2 missed"
                      reads the same for a weekly and a monthly customer. */}
                  {row.dormancy ? (
                    <>
                      <Text fontSize="sm" color="red.fg" fontWeight="medium">
                        {row.missedCycles === null
                          ? "No visit ever"
                          : `${row.missedCycles} missed`}
                      </Text>
                      <Text fontSize="2xs" color="fg.muted">
                        {row.lastServedAt
                          ? `last served ${fmtDate(row.lastServedAt)}`
                          : "never served"}
                      </Text>
                    </>
                  ) : (
                    <Text fontSize="sm">{row.startAt ? fmtDate(row.startAt) : "—"}</Text>
                  )}
                  {/* THE STREAM HAS STOPPED MAKING VISITS. Said in the
                      column it happened to: the date above is the last one
                      this stream produced, and the next one never arrived.

                      QUIET WHEN SILENCED. `expirySuppressed` means somebody
                      already decided this stall is known about, and shouting
                      it in red here would undo that. The row still carries
                      the fact, because this screen is where the book gets
                      reviewed — it just stops being an alarm. */}
                  {row.expiredDays !== null && (
                    <Badge
                      mt="1"
                      size="xs"
                      /* THE HOUSE SIGN FOR EXPIRED — the near-black chip Work
                         → Jobs puts on the Today group for expired next
                         visits. Same condition seen from the other end of
                         the same stall, so it gets the same mark; a red
                         icon-and-text here said "a different kind of
                         problem" about an identical one.

                         `solid` on gray rather than the Jobs chip's pinned
                         `gray.600`/`gray.50`: a raw ramp value is the same
                         wash in all fourteen themes, and four of them put
                         this row on a dark ground where a gray.600 chip
                         stops being obvious. The semantic step inverts per
                         theme, so it stays the loudest thing on the row.

                         SUBTLE WHEN SILENCED. Somebody already said they
                         know; it stays visible and stops shouting. */
                      variant={row.expirySuppressed ? "subtle" : "solid"}
                      colorPalette="gray"
                      borderRadius="full"
                      px="2"
                      whiteSpace="nowrap"
                      title={
                        `The next visit was due ${
                          row.nextVisitDueOn ? fmtDate(row.nextVisitDueOn) : "earlier"
                        } and was never created, so this stream has stopped.` +
                        (row.expirySuppressed ? " This warning has been silenced." : "")
                      }
                      data-testid="repeating-expired"
                    >
                      Expired {row.expiredDays}d
                    </Badge>
                  )}
                </Cell>

                <Cell label="State">
                  <Badge size="sm" variant="subtle" colorPalette={meta.palette}>
                    {meta.label}
                  </Badge>
                  {/* WHEN IT COMES BACK, under the badge that says it is
                      paused — because "Paused repeating" invites exactly one
                      question and the answer was two columns away in small
                      grey text, under a heading that says "Reason".

                      The Next visit column cannot carry it either: for a
                      paused row that column shows the date the pause is
                      HOLDING, which is not a next visit at all. */}
                  {row.canResume && (
                    <HStack gap={1} mt={1}>
                      <Box
                        flex="0 0 auto"
                        color={
                          row.reminderDue
                            ? "red.fg"
                            : row.streamResumeReminderAt
                              ? "fg.muted"
                              : "orange.fg"
                        }
                      >
                        <CalendarClock size={11} />
                      </Box>
                      <Text
                        fontSize="2xs"
                        fontWeight={row.reminderDue ? "medium" : undefined}
                        color={
                          row.reminderDue
                            ? "red.fg"
                            : row.streamResumeReminderAt
                              ? "fg.muted"
                              : "orange.fg"
                        }
                        data-testid="repeating-reminder"
                      >
                        {row.streamResumeReminderAt
                          ? `${row.reminderDue ? "review due" : "review"} ${fmtDate(row.streamResumeReminderAt)}`
                          : /* THE PAUSE THAT DISAPPEARS. Both surfaces that
                               resurface a paused stream query reminders that
                               are already DUE, so one with no reminder is
                               invisible to them forever — which is exactly
                               what happened to the production pause that
                               predates the reason dropdown. */
                            "no reminder — won't resurface"}
                      </Text>
                    </HStack>
                  )}
                  {/* BOTH CLOCKS, from the component Money → Awaiting
                      payment draws too. The badge said "Awaiting payment"
                      and stopped there, which reads the same at two days and
                      at forty-five — and forty-five is the one that has cost
                      the stream its visits.

                      ORANGE, matching the status badge directly above it, so
                      the money information on this row is one colour family.
                      Purple would have matched the Money card but collides
                      with "Held" in this very column. */}
                  {row.awaitingPaymentDays !== null && (
                    <Box mt={1} data-testid="repeating-awaiting-age">
                      <PaymentWaitBadges
                        palette="orange"
                        size="xs"
                        /* THE LOUD RUNG IS "IT HAS ALREADY COST A VISIT".
                           Money → Awaiting payment reads its own
                           PAYMENT_REQUEST_STALE_DAYS setting, which is about
                           chasing an invoice. On this screen the question is
                           whether the wait has broken the stream, and that
                           answer is already computed. */
                        stale={row.expiredDays !== null && !row.expirySuppressed}
                        wait={{
                          waitingDays: row.awaitingPaymentDays,
                          requestedDays: row.paymentRequestedDays,
                          firstRequestedDays: row.paymentFirstRequestedDays,
                          resendCount: row.paymentResendCount,
                          neverRequested: row.paymentNeverRequested,
                        }}
                      />
                    </Box>
                  )}
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
                  {/* MESSAGE THE CUSTOMER, beside the decision rather than a
                      tab away. Pausing somebody's service is a thing they
                      should hear about, and the draft behind this button is
                      keyed to what this row is about to do. Renders nothing
                      at all when the caller may not see contacts, or when
                      the customer has neither phone nor email.

                      SECOND IN THE ORDER, deliberately: the decision, then
                      telling them about it, then navigating away. */}
                  <ClientContactMenu contact={row} draft={draftFor(row)} />
                  {/* Ghost, because it navigates rather than changing
                      anything — but the same size as the others, so the
                      column reads as one block. */}
                  <Button
                    size="xs"
                    variant="ghost"
                    /* `occurrenceId`, NOT `id`. A stream with no visit has
                       `id = "job:<jobId>"`, and handing that over as an
                       occurrence id would send Services hunting for a row
                       that does not exist. Null is already handled there —
                       it means "just open the job". */
                    onClick={() => onOpenService(row.jobId, row.occurrenceId)}
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

      {streamControls.dialogs}
    </VStack>
  );
}
