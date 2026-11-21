"use client";

// ─────────────────────────────────────────────────────────────────────────────
// NowTab — what is happening right now.
//
// THIS IS THE WALL DISPLAY'S BACK-OFFICE BOARD, SIGNED IN. The payload is
// `buildPrivateBoard`, the same one the paired screen in the shop reads; it
// was simply unreachable without a device token. Nothing here re-derives
// "today" — a second query answering the same question is how two screens
// come to disagree about how much work is left, and this codebase has
// already paid for that shape once in the payment preview.
//
// WHAT IT IS NOT. It is not Home. Home is MY day — my next stop, my hours,
// my pay — and it is baseline, for everybody. This is THE OPERATION's day,
// gated on `schedule.view-all`, and it answers one question: who is out
// there, where are they, and what is left. The read-only oversight tier
// (Auditor in production holds this read and no schedule write) gets the
// whole board and no buttons.
//
// IT DOES NOT POLL. Hard rule in this repo, with one granted exception that
// is the wall display, precisely because that screen has nobody standing at
// it. Somebody IS standing at this one, so it gets what the display cannot
// have: a refresh control. It also re-reads when the tab becomes visible
// again, which is an event rather than a timer.
//
// AND IT SAYS HOW OLD IT IS. That line is not decoration. Once a board
// updates quietly, a frozen one looks exactly like a working one — same
// layout, same rows, nothing moving. The age line is the only thing between
// "live" and "lying since this morning".
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, Card, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiArrowRight, FiRefreshCw, FiSun } from "react-icons/fi";
import { AlertTriangle, Clock, Package, Truck, UserX } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtClockTime, fmtDuration, fetchWorkdayToday } from "@/src/lib/workday";
import { occurrenceStatusColor } from "@/src/lib/statusColors";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import PhotoLightbox from "@/src/ui/components/PhotoLightbox";
import {
  ACTIVE_STATUSES,
  DONE_STATUSES,
  WORKFLOW_LABEL,
  isFieldWork,
  type NowBoard,
} from "@/src/lib/nowBoard";
import { canSeeTab } from "@/src/lib/tabRequirements";
import type { Scope } from "@/src/lib/scope";

type Props = {
  /** What the reader may do. The board itself is already gated by
   *  TAB_REQUIREMENTS; this decides what the explainer claims, whether the
   *  attendance panels are expected at all, and whether the one action on
   *  the tab is offered. */
  scope: Scope;
  /** Home — your own day, where the workday actually starts. */
  onOpenMyDay: () => void;
  /** Work → Jobs, for the full day list with its filters and actions. */
  onOpenJobs: () => void;
};

/** Past this, the age line stops being reassuring and starts being a
 *  warning. Same three minutes the wall display uses, for the same reason —
 *  the board is still showing its last good frame, but do not trust it. */
const STALE_MS = 3 * 60_000;

/** How often the ELAPSED NUMBERS re-render. Touches no network: it moves
 *  "2h 14m" to "2h 15m" and nothing else, which is the distinction the
 *  no-polling rule draws. The board's own figures are only ever re-read on
 *  mount, on the refresh control, or when this tab becomes visible again. */
const CLOCK_TICK_MS = 30_000;

export default function NowTab({ scope, onOpenMyDay, onOpenJobs }: Props) {
  const [board, setBoard] = useState<NowBoard | null>(null);
  /** The visit whose photos the viewer is open on, and where in them. */
  const [viewer, setViewer] = useState<{ photos: { url: string }[]; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  /** `null` = not yet known. The Start-working card renders only on a
   *  definite `false`, so it never appears and then vanishes. Same rule
   *  Home's hero follows. */
  const [workdayStarted, setWorkdayStarted] = useState<boolean | null>(null);

  /**
   * MAY THIS READER START A DAY'S WORK?
   *
   * `work.claim` — clearance to do FIELD WORK, which is the authority to
   * pick work up. The same question `isFieldCleared` asks, and the same
   * capability `POST /occurrences/:id/claim` is guarded on.
   *
   * IT ASKED FOR A PAY CLASS AND THAT WAS WRONG. The first version rendered
   * this on `me?.workerType` being set — "is this person on the payroll" —
   * which is a different question and lets in exactly the people it should
   * not. An UNPAID observer has a worker type: the live book has one, an
   * Auditor who watches the business and takes no part in it, and she would
   * have been offered a button to start her working day.
   *
   * The pay-class check is not lost, it is subsumed: `can()` returns false
   * for a null `workerType` BEFORE it walks any roles (G31), so nobody can
   * hold `work.claim` without one. One question, asked once, in the
   * vocabulary the rest of the app uses.
   *
   * AND THE DESTINATION HAS TO EXIST. The card navigates to Home, so
   * somebody who cannot open Home would be offered a door to a tab they do
   * not have. `canSeeTab` reads the same TAB_REQUIREMENTS row the strip
   * does, rather than this file keeping its own idea of what Home costs.
   */
  /**
   * Open one visit on the Jobs tab, scrolled to and expanded.
   *
   * JobsTab owns this handoff and documents it: write `<occId>|<startAt>`
   * to `seedlings_jobs_pendingHighlight`, then navigate with `remount: true`
   * — the effect that consumes the key runs once per mount, so without the
   * remount a reader already on Jobs would get nothing at all. The anchor
   * date matters too: it pins the date filter to that one day instead of
   * leaving the reader in their own default window with the row filtered
   * out of it. Copied from HomeTab's row click rather than reinvented, so
   * the two behave the same.
   */
  const openVisit = useCallback((id: string, startAt: string | null) => {
    try {
      localStorage.setItem("seedlings_jobs_pendingHighlight", `${id}|${startAt ?? ""}`);
    } catch {}
    window.dispatchEvent(
      new CustomEvent("navigate:staffTab", { detail: { tab: "jobs", remount: true } }),
    );
  }, []);

  const canStartWork = scope.can("work.claim") && canSeeTab("home", scope.can);

  // Local clock only. See CLOCK_TICK_MS.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const pull = useCallback(async () => {
    setBusy(true);
    try {
      const b = await apiGet<NowBoard>("/api/board/now");
      setBoard(b);
      setFailed(false);
    } catch (e) {
      // Keep the last good board on screen rather than blanking it — a
      // stale board with an honest age line beats an empty one. The banner
      // and the amber age line together say what happened.
      setFailed(true);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not read the board just now.", e),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void pull();
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    window.addEventListener("visibilitychange", onVisible);
    return () => window.removeEventListener("visibilitychange", onVisible);
  }, [pull]);

  // Is the reader themselves clocked in? Only asked of somebody who could
  // act on the answer — an observer has no workday to start, so asking
  // would be a request made purely to decide not to use it.
  useEffect(() => {
    if (!canStartWork) return;
    let cancelled = false;
    fetchWorkdayToday()
      .then((payload) => {
        if (cancelled) return;
        const st = payload?.today?.state;
        setWorkdayStarted(st === "IN_PROGRESS" || st === "PAUSED");
      })
      // A workday lookup failing must not remove a working button.
      .catch(() => { if (!cancelled) setWorkdayStarted(false); });
    return () => { cancelled = true; };
  }, [canStartWork]);

  /**
   * THE HELP, written from the code rather than from the plan.
   *
   * Capability-additive: the base copy is what an oversight reader can
   * actually do here, and the attendance paragraph is gated on the
   * capability the SERVER uses to decide whether those panels ship at all,
   * so the help cannot promise a panel that is not in the payload.
   */
  const tabHelp = (
    <TabExplainer explainerId="seedlings:nowTab:guideOpen">
      <ExplainerText>
        The operation <Em>right now</Em> — who is out, what they are on, and
        how much of today is left. It is the same board the shop display
        shows, so the two never disagree.
      </ExplainerText>
      <ExplainerText>
        It does <Em>not refresh itself</Em>. Use Refresh, and read the
        &ldquo;as of&rdquo; time beside it: once a board updates quietly, one
        that has stopped looks exactly like one that is working. The time
        turns amber when the figures are more than a few minutes old.
      </ExplainerText>
      <ExplainerText>
        A portfolio filter narrows <Em>the visits</Em> and everything counted
        from them. It does not narrow who is out in a vehicle or holding
        equipment — those belong to the business, not to a territory, so
        those two panels say so on their face rather than letting you assume
        the whole screen moved.
      </ExplainerText>
      <CapabilitySection capability="time.view" scope={scope}>
        <ExplainerText>
          You also see <Em>the timeclock</Em>: who is on, since when, who is
          on a break, and — usually the useful half — who has work today and
          never clocked in. Attendance is a separate grant from the schedule,
          so a reader without it gets this board with those two panels
          absent.
        </ExplainerText>
      </CapabilitySection>
    </TabExplainer>
  );

  const ageMs = board ? now - Date.parse(board.generatedAt) : 0;
  const stale = board != null && (failed || ageMs > STALE_MS);

  /** The clock panels are a capability, and `undefined` is not `[]`. One
   *  means "you may not see this", the other means "nobody is clocked in" —
   *  and a screen that renders them the same way has told the reader the
   *  yard is empty when it is full. */
  const clockWithheld = board != null && board.onTheClock === undefined;
  const onTheClock = board?.onTheClock ?? [];
  const notClockedIn = board?.assignedNotClockedIn ?? [];

  // THREE GROUPS, BECAUSE THE PANEL IS CALLED "TODAY'S VISITS".
  //
  // The first draft listed only the live two and left the finished ones out,
  // which made the heading a small lie and — worse — left the "Done: 4" tile
  // above pointing at rows that were nowhere on the page. The same partition
  // the counts use, so the tiles and the list cannot disagree.
  //
  // PARTITIONED ON FIELD WORK, because the heading says "visits" and the
  // tiles above count visits. The board also carries the office's own day —
  // tasks, reminders, follow-ups — and those are listed below under their
  // own heading rather than dropped: an overseer who is not shown today's
  // reminders is being told the day is emptier than it is. What they must
  // not be told is that a reminder is a visit, which is what this screen
  // did when one list served both and a titleless reminder rendered as the
  // literal word "Visit".
  const visits = (board?.jobs ?? []).filter((j) => isFieldWork(j.workflow));
  const officeRows = (board?.jobs ?? []).filter((j) => !isFieldWork(j.workflow));
  const activeJobs = visits.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const doneJobs = visits.filter((j) => DONE_STATUSES.includes(j.status));
  const restOfDay = visits.filter(
    (j) => !ACTIVE_STATUSES.includes(j.status) && !DONE_STATUSES.includes(j.status),
  );

  if (board === null) {
    return (
      <VStack align="stretch" gap={3} pb="2">
        {tabHelp}
        <HStack justify="center" py="10">
          <Spinner size="sm" />
          <Text color="fg.muted" fontSize="sm">Reading the board…</Text>
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={3} pb="2">
      {tabHelp}

      {/* ── Start working ────────────────────────────────────────────────
          The one ACTION on an otherwise read-only screen, and the reason
          this tab can be the first thing somebody sees in the morning.

          IT GOES TO HOME rather than launching begin-workday here. Home is
          where a person's own day lives — the hero that starts the workday,
          the hours, the next stop — so this hands them to that screen and
          lets them choose, instead of dropping a multi-step workflow over a
          board they had just opened to read. The whole card is armed, so it
          cannot look interactive while doing nothing.

          `canStartWork` is the gate, and it is a capability — see its own
          note for why asking for a pay class was wrong. An oversight reader
          gets this tab with no action on it at all, which is exactly what
          the read-only tier is. */}
      {canStartWork && workdayStarted === false && (
        <Card.Root
          variant="outline"
          bg="green.faint"
          borderColor="green.emphasized"
          cursor="pointer"
          onClick={onOpenMyDay}
          _hover={{ shadow: "md", borderColor: "green.strong" }}
          data-testid="now-start-working"
        >
          <Card.Body px={3} py={3}>
            <HStack gap={3} align="center">
              <Box bg="green.solid" color="green.contrast" p={2} borderRadius="full" flexShrink={0}>
                <FiSun size={22} />
              </Box>
              <Box flex={1} minW={0}>
                <Text fontSize="md" fontWeight="bold" color="green.fg">Start working</Text>
                {/* NAMES ITS DESTINATION. The card goes to Home; it does not
                    clock you in from here. Copy that said "Open your day to
                    clock in" described the screen it lands on rather than
                    the press, so the one thing the press actually does —
                    move you to Home — was the thing it did not say. */}
                <Text fontSize="sm" color="green.fg">
                  Go to Home, where you clock in and start your first stop
                </Text>
              </Box>
              <Box color="green.fg" flexShrink={0}><FiArrowRight size={20} /></Box>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}
      {canStartWork && workdayStarted === true && (
        <Card.Root variant="outline" data-testid="now-my-day">
          <Card.Body px={3} py={2}>
            <HStack gap={3} align="center">
              <Box color="green.fg" flexShrink={0}><Clock size={18} /></Box>
              <Text flex={1} minW={0} fontSize="sm" color="fg.muted">
                You are on the clock.
              </Text>
              <Button size="xs" variant="outline" onClick={onOpenMyDay} flexShrink={0}>
                My day <FiArrowRight size={13} />
              </Button>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* ── As of, and the refresh control the display cannot have ─────── */}
      <HStack gap={2} align="center" wrap="wrap">
        <Text
          fontSize="xs"
          color={stale ? "orange.fg" : "fg.subtle"}
          fontWeight={stale ? "semibold" : "normal"}
          data-testid="now-as-of"
          data-stale={stale ? "1" : "0"}
        >
          {failed
            ? `Could not refresh — still showing ${fmtClockTime(board.generatedAt)}`
            : `As of ${fmtClockTime(board.generatedAt)}`}
          {!failed && ageMs > STALE_MS ? ` · ${fmtDuration(ageMs)} old` : ""}
        </Text>
        <Box flex={1} />
        <Button
          size="xs"
          variant="outline"
          onClick={() => void pull()}
          loading={busy}
          data-testid="now-refresh"
          // What "Show me" rings for the `now-tab` announcement. Refresh
          // rather than the Start-working card on purpose: the card is
          // conditional — absent for somebody already on the clock and for
          // anyone without a pay class — and a coach-mark that points at
          // nothing is the failure the spotlight exists to prevent. This
          // button is always here once the board has loaded, and it is also
          // the one thing about the tab that surprises people.
          data-whats-new="now-tab"
        >
          <FiRefreshCw size={13} /> Refresh
        </Button>
      </HStack>

      {/* ── How much of today is done ───────────────────────────────────── */}
      <SimpleGrid columns={{ base: 2, md: 4 }} gap={2}>
        {[
          { label: "Working now", value: board.counts.inProgress, tone: "cyan" },
          { label: "Done", value: board.counts.done, tone: "green" },
          { label: "Left", value: board.counts.remaining, tone: "blue" },
          { label: "Visits today", value: board.counts.total, tone: "gray" },
        ].map((c) => (
          <Card.Root key={c.label} variant="subtle" data-testid={`now-count-${c.label.replace(/\s+/g, "-").toLowerCase()}`}>
            <Card.Body px={3} py={2}>
              <Text fontSize="2xl" fontWeight="bold" color={`${c.tone}.fg`} lineHeight="1.1">
                {c.value}
              </Text>
              <Text fontSize="xs" color="fg.muted">{c.label}</Text>
            </Card.Body>
          </Card.Root>
        ))}
      </SimpleGrid>

      {/* ── Attention. Usually empty, and that is the point ─────────────── */}
      {board.attention.length > 0 && (
        <Card.Root variant="outline" borderColor="orange.emphasized" bg="orange.faint">
          <Card.Body px={3} py={2}>
            <VStack align="stretch" gap={1}>
              {board.attention.map((a) => (
                <HStack key={a.kind} gap={2} align="start" data-testid={`now-attention-${a.kind}`}>
                  <Box color="orange.fg" flexShrink={0} mt="2px"><AlertTriangle size={14} /></Box>
                  <Text fontSize="sm" color="orange.fg">
                    <Box as="span" fontWeight="semibold">{a.label}</Box>
                    {" — "}{a.detail}
                  </Text>
                </HStack>
              ))}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* ── On the clock — the headline panel ───────────────────────────── */}
      {!clockWithheld && (
        <Card.Root variant="outline" data-testid="now-on-the-clock">
          <Card.Body px={3} py={2}>
            <VStack align="stretch" gap={2}>
              <HStack gap={2}>
                <Box color="fg.muted"><Clock size={15} /></Box>
                <Text fontSize="sm" fontWeight="semibold">On the clock</Text>
                <Badge size="sm" variant="subtle">{onTheClock.length}</Badge>
              </HStack>
              {onTheClock.length === 0 && (
                <Text fontSize="sm" color="fg.muted">Nobody is clocked in right now.</Text>
              )}
              {onTheClock.map((w) => (
                <Box
                  key={w.id}
                  borderTopWidth="1px"
                  borderColor="border.muted"
                  pt={2}
                  data-testid="now-worker"
                >
                  <HStack gap={2} align="center" wrap="wrap">
                    <Text fontSize="sm" fontWeight="semibold">{w.name}</Text>
                    {w.onBreak && <Badge size="sm" colorPalette="orange">On break</Badge>}
                    <Text fontSize="xs" color="fg.subtle">
                      since {fmtClockTime(w.clockedInAt)} ·{" "}
                      {fmtDuration(Math.max(0, now - Date.parse(w.clockedInAt)))} on the clock
                    </Text>
                  </HStack>
                  {w.jobs.length === 0 ? (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      No visit open — on the clock with nothing started.
                    </Text>
                  ) : (
                    <VStack align="stretch" gap={1} mt={1}>
                      {w.jobs.map((j) => (
                        <HStack key={j.id} gap={2} align="center" wrap="wrap">
                          <Badge size="sm" colorPalette={occurrenceStatusColor(j.status)}>
                            {j.status.replace(/_/g, " ").toLowerCase()}
                          </Badge>
                          <Text fontSize="sm">{j.title}</Text>
                          <Text fontSize="xs" color="fg.muted">{j.place}</Text>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                </Box>
              ))}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* ── Assigned, nobody on the clock. The other half of the truth ─── */}
      {!clockWithheld && notClockedIn.length > 0 && (
        <Card.Root variant="outline" borderColor="orange.emphasized" data-testid="now-not-clocked-in">
          <Card.Body px={3} py={2}>
            <VStack align="stretch" gap={1}>
              <HStack gap={2}>
                <Box color="orange.fg"><UserX size={15} /></Box>
                <Text fontSize="sm" fontWeight="semibold">Has work today, not clocked in</Text>
                <Badge size="sm" colorPalette="orange">{notClockedIn.length}</Badge>
              </HStack>
              {notClockedIn.map((r) => (
                <Text key={r.id} fontSize="sm">
                  {r.name}{" "}
                  <Box as="span" color="fg.muted">
                    — {r.jobs} {r.jobs === 1 ? "visit" : "visits"} outstanding
                  </Box>
                </Text>
              ))}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* The capability case, said out loud. An absent panel with no
          explanation reads as a broken screen; worse, it reads as an empty
          yard. */}
      {clockWithheld && (
        <Card.Root variant="subtle" data-testid="now-clock-withheld">
          <Card.Body px={3} py={2}>
            <Text fontSize="sm" color="fg.muted">
              Who is clocked in is not shown here — that needs time-tracking
              access, which is a separate grant from the schedule. The visits
              below are complete.
            </Text>
          </Card.Body>
        </Card.Root>
      )}

      {/* ── The day's visits ────────────────────────────────────────────── */}
      {/* The panel "Show me" rings for `now-visit-photos`: both halves of
          that announcement live in here — the thumbnails on the finished
          rows, and the office rows at its foot. */}
      <Card.Root variant="outline" data-testid="now-visits" data-whats-new="now-visit-photos">
        <Card.Body px={3} py={2}>
          <VStack align="stretch" gap={2}>
            <HStack gap={2} wrap="wrap">
              <Text fontSize="sm" fontWeight="semibold">Today&rsquo;s visits</Text>
              <Box flex={1} />
              <Button size="xs" variant="ghost" onClick={onOpenJobs}>
                Open in Jobs <FiArrowRight size={13} />
              </Button>
            </HStack>
            {visits.length === 0 && (
              <Text fontSize="sm" color="fg.muted">No visits are scheduled today.</Text>
            )}
            {[
              { heading: "Underway", rows: activeJobs },
              { heading: "Still to do", rows: restOfDay },
              { heading: "Finished", rows: doneJobs },
            ].map((group) =>
              group.rows.length === 0 ? null : (
                <Box key={group.heading}>
                  <Text fontSize="xs" color="fg.subtle" textTransform="uppercase" letterSpacing="wide" mb={1}>
                    {group.heading} ({group.rows.length})
                  </Text>
                  <VStack align="stretch" gap={1}>
                    {group.rows.map((j) => (
                      <HStack
                        key={j.id}
                        gap={2}
                        align="center"
                        wrap="wrap"
                        borderTopWidth="1px"
                        borderColor="border.muted"
                        pt={1}
                        px={1}
                        mx={-1}
                        borderRadius="sm"
                        cursor="pointer"
                        role="button"
                        tabIndex={0}
                        _hover={{ bg: "bg.subtle" }}
                        // A list of today's work whose rows go nowhere makes
                        // the reader hunt for the same visit by hand on
                        // another tab. Keyboard too: this is a button, so it
                        // answers to Enter and Space like one.
                        onClick={() => openVisit(j.id, j.startAt)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openVisit(j.id, j.startAt);
                          }
                        }}
                        aria-label={`Open ${j.title}${j.client ? ` for ${j.client}` : ""} in Jobs`}
                        data-testid="now-visit"
                      >
                        <Badge size="sm" colorPalette={occurrenceStatusColor(j.status)}>
                          {j.status.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                        <Text fontSize="sm" fontWeight="medium">{j.title}</Text>
                        {j.client && <Text fontSize="sm" color="fg.muted">{j.client}</Text>}
                        <Text fontSize="xs" color="fg.muted">{j.place}</Text>
                        <Box flex={1} />
                        <Text fontSize="xs" color="fg.subtle">
                          {j.crew.length > 0 ? j.crew.join(", ") : "nobody on it"}
                        </Text>
                        {/* WHAT THE CREW ACTUALLY PHOTOGRAPHED, on finished
                            work. This is the one thing on the board that is
                            evidence rather than status: a row can say
                            "completed" because somebody tapped a button, and
                            a picture of the lawn cannot. Sits on the row it
                            belongs to rather than in a strip of its own, so
                            there is never a question of which visit it is
                            from. On a phone it takes its own line under the
                            row; from `md` up it sits inline at the end of
                            the row instead, because a single 54px tile
                            alone on a 1280px line reads as a layout
                            mistake rather than as a thumbnail. */}
                        {(j.photos?.length ?? 0) > 0 && (
                          <HStack
                            gap={1}
                            flexBasis={{ base: "100%", md: "auto" }}
                            pt={{ base: 1, md: 0 }}
                            data-testid="now-visit-photos"
                          >
                            {j.photos!.slice(0, 3).map((ph, idx) => (
                              <Box
                                key={ph.id}
                                as="img"
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                {...({ src: ph.url, alt: `${j.title} — ${j.place}`, loading: "lazy" } as any)}
                                boxSize="54px"
                                objectFit="cover"
                                borderRadius="sm"
                                borderWidth="1px"
                                borderColor="border.muted"
                                bg="bg.muted"
                                cursor="zoom-in"
                                // STOP THE ROW. The row navigates to Jobs;
                                // the photo opens the viewer. Without this
                                // the click bubbles and does both, and the
                                // viewer is unmounted mid-open.
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  setViewer({ photos: j.photos!, index: idx });
                                }}
                                data-testid="now-visit-photo"
                              />
                            ))}
                            {/* The row shows three; the viewer holds the
                                lot. Saying how many more is the difference
                                between "three photos" and "three of nine". */}
                            {j.photos!.length > 3 && (
                              <Box
                                // A Box, NOT a `<button>`. The row around it
                                // is already `role="button"`, and a real
                                // button nested inside one is invalid to
                                // assistive tech — it announces two controls
                                // where a reader can only mean one. Mouse
                                // affordance only, like the jobs card's own
                                // photo tiles; a keyboard reader activates
                                // the row and gets the visit itself, which
                                // has every photo on it anyway.
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                                boxSize="54px"
                                borderRadius="sm"
                                borderWidth="1px"
                                borderColor="border.muted"
                                bg="bg.muted"
                                fontSize="xs"
                                color="fg.muted"
                                cursor="zoom-in"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  setViewer({ photos: j.photos!, index: 3 });
                                }}
                                title={`View all ${j.photos!.length} photos`}
                                data-testid="now-visit-photo-more"
                              >
                                +{j.photos!.length - 3}
                              </Box>
                            )}
                          </HStack>
                        )}
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              ),
            )}

            {/* ── THE OFFICE'S OWN DAY ──────────────────────────────────
                Tasks, reminders, follow-ups, events and announcements dated
                today. They were already on this board; they were just
                mixed in with the visits, under a heading that called them
                visits and a count that counted them as such. Shown, named,
                and left out of the numbers. */}
            {officeRows.length > 0 && (
              <Box pt={1} data-testid="now-office-rows">
                <Text fontSize="xs" color="fg.subtle" textTransform="uppercase" letterSpacing="wide" mb={1}>
                  Also today ({officeRows.length}) &mdash; not visits
                </Text>
                <VStack align="stretch" gap={1}>
                  {officeRows.map((j) => (
                    <HStack
                      key={j.id}
                      gap={2}
                      align="center"
                      wrap="wrap"
                      borderTopWidth="1px"
                      borderColor="border.muted"
                      pt={1}
                      px={1}
                      mx={-1}
                      borderRadius="sm"
                      cursor="pointer"
                      role="button"
                      tabIndex={0}
                      _hover={{ bg: "bg.subtle" }}
                      onClick={() => openVisit(j.id, j.startAt)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openVisit(j.id, j.startAt);
                        }
                      }}
                      aria-label={`Open ${j.title} in Jobs`}
                      data-testid="now-office-row"
                    >
                      <Badge size="sm" variant="outline" colorPalette="purple">
                        {WORKFLOW_LABEL[j.workflow] ?? j.workflow.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                      <Text fontSize="sm" fontWeight="medium">{j.title}</Text>
                      {j.client && <Text fontSize="sm" color="fg.muted">{j.client}</Text>}
                      <Box flex={1} />
                      <Text fontSize="xs" color="fg.subtle">
                        {j.status.replace(/_/g, " ").toLowerCase()}
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              </Box>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* ── Out right now ───────────────────────────────────────────────────
          DELIBERATELY NOT NARROWED, and labelled so. A vehicle and a piece
          of equipment belong to the business rather than to a territory, so
          there is no honest way to filter them by portfolio — and inventing
          one would UNDER-report what is out, which is the opposite of what
          this panel is for. The heading says "business-wide" rather than
          letting a reader with a filter on assume otherwise. */}
      {(board.vehiclesOut.length > 0 || board.equipmentOut.length > 0) && (
        <Card.Root variant="outline" data-testid="now-out">
          <Card.Body px={3} py={2}>
            <VStack align="stretch" gap={2}>
              <HStack gap={2} wrap="wrap">
                <Text fontSize="sm" fontWeight="semibold">Out right now</Text>
                <Badge size="sm" variant="subtle">business-wide</Badge>
              </HStack>
              {board.vehiclesOut.map((v) => (
                <HStack key={v.id} gap={2} align="center" wrap="wrap">
                  <Box color="fg.muted" flexShrink={0}><Truck size={14} /></Box>
                  <Text fontSize="sm">{v.name}</Text>
                  <Text fontSize="sm" color="fg.muted">{v.driver}</Text>
                  <Text fontSize="xs" color="fg.subtle">
                    since {fmtClockTime(v.since)}
                  </Text>
                </HStack>
              ))}
              {board.equipmentOut.map((e) => (
                <HStack key={e.id} gap={2} align="center" wrap="wrap">
                  <Box color="fg.muted" flexShrink={0}><Package size={14} /></Box>
                  <Text fontSize="sm">{e.name}</Text>
                  <Text fontSize="sm" color="fg.muted">{e.holder}</Text>
                </HStack>
              ))}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* THE SHARED VIEWER, not a fourth copy of one. `PhotoLightbox`
          already backs the payment page, the promotion landing page and
          Supplies, and it brings the things a hand-rolled one forgets:
          arrow keys, Escape, swipe on a phone, and an "n / total" counter
          — which is the part that makes a viewer honest about how many
          photos there are. Read-only on purpose: the jobs card's own
          viewer carries Delete and a public-visibility toggle, and this
          tab opens for a read-only oversight tier that holds neither. */}
      {viewer && (
        <PhotoLightbox
          photos={viewer.photos}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onPrev={() => setViewer((v) => (v && v.index > 0 ? { ...v, index: v.index - 1 } : v))}
          onNext={() =>
            setViewer((v) => (v && v.index < v.photos.length - 1 ? { ...v, index: v.index + 1 } : v))
          }
        />
      )}
    </VStack>
  );
}
