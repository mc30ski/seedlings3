"use client";

/**
 * Title-bar trigger for THE BOARD (see DayBoard.tsx).
 *
 * The icon nags until it has been opened once that day, then goes quiet: a
 * pulsing dot and a turf-green tint while unseen, plain muted grey after. That
 * is the whole "splash" mechanic — nobody is forced through a full-screen
 * takeover on every navigation, but the first login of the day has something
 * asking to be tapped.
 *
 * NOT VISIBLE TO CLIENTS. The caller gates on worker/admin/super AND on the
 * active role not being `client`; see the callsite in pages/index.tsx. The
 * title bar is shared with the client shell, so an ungated control here WOULD
 * render for a signed-in ClientContact and for a Super in client view-as.
 *
 * The seen-stamp is an ET business date key via `bizToday()`, never
 * `new Date().toISOString().slice(0,10)` — a UTC key flips the board back on
 * at 8pm ET. It is per-user so a shared device does not mark the board read
 * for the next person.
 */

import { useCallback, useEffect, useState } from "react";
import { Box, Dialog, Portal } from "@chakra-ui/react";
import { Trophy } from "lucide-react";
import { bizToday } from "@/src/lib/dates";
import DayBoard, { BOARD_VERSION, type BoardData } from "./DayBoard";

const KEY_PREFIX = "seedlings3:dayboard:seen:";
/* Stores the BOARD_VERSION the user last saw, not a bare "1" — a version
 * they have never seen reads the same as never having opened it at all. */
const EVER_PREFIX = "seedlings3:dayboard:ever:";

/** Sample content. Replaced wholesale when the board endpoint lands — see
 *  DayBoard.tsx on why this is all-or-nothing rather than part-real. */
const SAMPLE: BoardData = {
  weekLabel: "Week of Sep 28",
  dayLabel: "Thursday",
  visitsThisWeek: 47,
  visitsLastWeek: 38,
  acres: 31.4,
  properties: 22,
  onTimePct: 94,
  byDay: [
    { day: "Mon", visits: 9, today: false },
    { day: "Tue", visits: 11, today: false },
    { day: "Wed", visits: 8, today: false },
    { day: "Thu", visits: 10, today: true },
    { day: "Fri", visits: 9, today: false },
    { day: "Sat", visits: null, today: false },
    { day: "Sun", visits: null, today: false },
  ],
  roster: [
    { name: "Pete", initials: "PT", visits: 14, properties: 5, sameDayCloses: 4 },
    { name: "Maria", initials: "MR", visits: 12, properties: 4, sameDayCloses: 6 },
    { name: "Luis", initials: "LZ", visits: 11, properties: 5, sameDayCloses: 3 },
    { name: "Nina", initials: "NW", visits: 7, properties: 3, sameDayCloses: 5 },
    { name: "Sam", initials: "SB", visits: 3, properties: 2, sameDayCloses: 2 },
  ],
  bestWeek: { visits: 52, when: "15 Jun 2026" },
  streakDays: 14,
  ticker: [
    "Pete closed Harrington Lake 11:42",
    "Maria closed Willowbrook 11:18",
    "Luis started Martinez Cabin 10:55",
    "Nina closed Patel Residence 10:31",
    "Sam closed River Bend 09:47",
  ],
  isSample: true,
};

export default function DayBoardButton({ userId }: { userId?: string | null }) {
  const [open, setOpen] = useState(false);
  /** Bumped on every open so the board remounts and replays its entrance —
   *  otherwise the sting only ever runs the first time in a session. */
  const [runKey, setRunKey] = useState(0);
  // THREE states, loudest first:
  //   "new"   — never opened, ever. Someone's first day, or the first day the
  //             board shipped. Gets a ring, a halo and a wiggle: they have no
  //             idea this icon does anything and a 7px dot will not tell them.
  //   "today" — opened before, not yet today. The daily nudge. A pulsing dot.
  //   "seen"  — opened today. Silent grey, like every other header icon.
  // Both start optimistically quiet so a slow storage read never flashes a
  // nag at someone who already dealt with it.
  const [everSeen, setEverSeen] = useState(true);
  const [seenToday, setSeenToday] = useState(true);

  const storageKey = `${KEY_PREFIX}${userId ?? "anon"}`;
  const everKey = `${EVER_PREFIX}${userId ?? "anon"}`;

  useEffect(() => {
    // Private windows and cleared site data make this throw; a board that
    // quietly stops nagging is a far better failure than a crashed header.
    try {
      setSeenToday(window.localStorage.getItem(storageKey) === String(bizToday()));
      setEverSeen(window.localStorage.getItem(everKey) === BOARD_VERSION);
    } catch {
      setSeenToday(true);
      setEverSeen(true);
    }
  }, [storageKey, everKey]);

  const state: "new" | "today" | "seen" = !everSeen ? "new" : seenToday ? "seen" : "today";

  const markSeen = useCallback(() => {
    setSeenToday(true);
    setEverSeen(true);
    try {
      window.localStorage.setItem(storageKey, String(bizToday()));
      window.localStorage.setItem(everKey, BOARD_VERSION);
    } catch {
      /* storage unavailable — the nag just returns next load */
    }
  }, [storageKey, everKey]);

  const title =
    state === "new" ? "The Board — take a look"
    : state === "today" ? "The Board — new this week"
    : "The Board";

  return (
    <>
      <Box
        as="button"
        aria-label={title}
        title={title}
        position="relative"
        px="1"
        py={1}
        display="inline-flex"
        alignItems="center"
        cursor="pointer"
        color={state === "seen" ? "gray.fg" : "green.fg"}
        _hover={{ color: "green.fg" }}
        transition="color 0.1s"
        onClick={() => { setRunKey((n) => n + 1); setOpen(true); markSeen(); }}
        data-board-motion
      >
        {/* NEVER OPENED: an expanding ring pushing out from under the icon.
            This is the one that has to carry across a busy title bar. */}
        {state === "new" && (
          <Box
            position="absolute"
            top="50%"
            left="50%"
            w="22px"
            h="22px"
            mt="-11px"
            ml="-11px"
            borderRadius="full"
            pointerEvents="none"
            css={{ animation: "seedlings-dayboard-halo 2s ease-out infinite" }}
          />
        )}

        <Box
          display="inline-flex"
          css={state === "new" ? { animation: "seedlings-dayboard-nudge 3.4s ease-in-out infinite" } : undefined}
        >
          <Trophy size={16} />
        </Box>

        {state !== "seen" && (
          <Box
            position="absolute"
            top="2px"
            right="0"
            borderRadius="full"
            bg="green.solid"
            w={state === "new" ? "8px" : "7px"}
            h={state === "new" ? "8px" : "7px"}
            borderWidth={state === "new" ? "1.5px" : "0"}
            borderColor="bg.panel"
            css={{ animation: "seedlings-dayboard-pulse 1.8s ease-in-out infinite" }}
          />
        )}
      </Box>

      <Dialog.Root open={open} onOpenChange={(e) => setOpen(e.open)} size="md" scrollBehavior="inside">
        <Portal>
          {/* The room goes dark so the board reads as a lit object rather than
              a panel that lost its theme. A translucent scrim is
              theme-independent BY DESIGN — it darkens whatever is under it,
              whatever colour that is — which is exactly the case the theming
              gate carves out for `rgba()`. No hex here. */}
          <Dialog.Backdrop css={{ background: "rgba(0,0,0,.74)", backdropFilter: "blur(7px)" }} />
          <Dialog.Positioner>
            {/* No colour here on purpose — the board owns its whole surface
                (DayBoard.tsx), so this trigger stays fully themed and the
                theming gate's exemption covers exactly one file. */}
            {/* Transparent and un-clipped: the board below brings its own
                ground, corners and glowing bezel, and `overflow: hidden` here
                would crop that glow off at the edge. */}
            <Dialog.Content
              mx="3"
              maxW="430px"
              w="full"
              p="0"
              bg="transparent"
              boxShadow="none"
              overflow="visible"
            >
              <Dialog.Body p="0">
                <DayBoard key={runKey} data={SAMPLE} onDismiss={() => setOpen(false)} />
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
