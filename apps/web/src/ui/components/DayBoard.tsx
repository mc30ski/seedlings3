"use client";

/**
 * THE BOARD — the week's scoreboard, shown once a day on first login.
 *
 * Deliberately NOT themed. Every other surface in this app follows the 14
 * themes; this one is a fixed dark broadcast panel on purpose, the same way a
 * stadium scoreboard does not repaint when the lobby does. The committed dark
 * ground is most of why it reads as a broadcast graphic rather than another
 * card, and theming it would make it generic. Revisit only as a design
 * decision, not as a consistency cleanup. The theming build gate exempts THIS
 * FILE ONLY — its trigger (DayBoardButton.tsx) holds no colour at all, which
 * is why the dismiss button lives down here rather than in the dialog.
 *
 * WHAT IS NOT ON IT, ON PURPOSE:
 *   • No money, anywhere. Not per-person, not team total.
 *   • No hours per person.
 * Visits, acreage, properties and same-day closes only. Worker views must
 * never expose wages or cost-split percentages, and the moment a leaderboard
 * carries money it stops being a locker room and becomes a payroll dispute.
 * `/dashboard-summary`'s `topWorkers` rows DO carry `earnings` — take the name
 * and the job count and leave the rest behind.
 *
 * MOTION is split two ways, and the split is load-bearing:
 *   • ENTRANCE (panels rising, bars growing, numbers counting) runs off React
 *     state + CSS transitions. Under `prefers-reduced-motion` the transitions
 *     are killed and everything snaps straight to its final value — correct,
 *     not blank.
 *   • DECORATION (gloss sweep, drifting gradient, rail glow, ticker) runs off
 *     CSS animations. Those are switched off entirely under reduced motion and
 *     nothing depends on them having run.
 * Never move an entrance effect into the animation group: an `animation` with
 * `both` fill that gets disabled leaves the element stuck at opacity 0.
 *
 * Data is sample until the board endpoint lands. The PREVIEW chip says so, and
 * it is all-or-nothing by design: a board mixing four real numbers with twelve
 * invented ones, unmarked, is worse than one that is plainly a mock.
 */

import { useEffect, useRef, useState } from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";

/**
 * Bump this whenever the board changes in a way a person would NOTICE — new
 * panel, reordered sections, different stat. Everyone's trigger goes back to
 * its loudest "never seen this" state once, so a redesign actually gets looked
 * at instead of sitting behind an icon people have learned to ignore.
 *
 * You will not have to remember: `board-version-build-gate.test.ts` fingerprints
 * this file and fails the build when it changes, telling you to either bump
 * this or confirm the edit was cosmetic. Bumping re-nags EVERY user, so a
 * comment fix is not a reason to.
 */
export const BOARD_VERSION = "2";

export type BoardWorker = {
  /** Display name. Never an email — worker views must not expose those. */
  name: string;
  initials: string;
  visits: number;
  properties: number;
  sameDayCloses: number;
};

export type BoardData = {
  weekLabel: string;
  dayLabel: string;
  visitsThisWeek: number;
  visitsLastWeek: number;
  acres: number | null;
  properties: number;
  onTimePct: number;
  /** Mon–Sun. `null` = a day that has not happened yet. */
  byDay: Array<{ day: string; visits: number | null; today: boolean }>;
  roster: BoardWorker[];
  bestWeek: { visits: number; when: string } | null;
  streakDays: number | null;
  ticker: string[];
  isSample: boolean;
};

/* Fixed palette. Not theme tokens — see the header comment. */
const C = {
  ground: "#0b0f0c",
  panel: "#141a16",
  panel2: "#1b231d",
  line: "#27332a",
  ink: "#eff3ec",
  dim: "#8fa294",
  turf: "#5ec85e",
  turfDeep: "#2f6b32",
  amber: "#f2ad42",
};

const NUM = "'Big Shoulders Display', 'Archivo Black', system-ui, sans-serif";

function prefersReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** True one frame after mount, so CSS transitions actually run. */
function useEntered(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

/** Counts up to `target`, easing out. Snaps instantly under reduced motion. */
function useCountUp(target: number, delay: number, dur = 900, decimals = 0): string {
  const [v, setV] = useState(prefersReduced() ? target : 0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (prefersReduced()) { setV(target); return; }
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const e = now - t0;
      if (e < 0) { raf.current = requestAnimationFrame(tick); return; }
      const p = Math.min(1, e / dur);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
  }, [target, delay, dur]);
  return v.toFixed(decimals);
}

/** Fade + lift, driven by transition so reduced motion lands on the real state. */
function rise(entered: boolean, delay: number) {
  return {
    opacity: entered ? 1 : 0,
    transform: entered ? "translateY(0)" : "translateY(14px)",
    transition: `opacity 440ms ease ${delay}ms, transform 520ms cubic-bezier(.22,.9,.3,1) ${delay}ms`,
  } as const;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize="10px" fontWeight="700" letterSpacing="2.6px" textTransform="uppercase" color={C.dim} lineHeight="1.4">
      {children}
    </Text>
  );
}

export default function DayBoard({ data, onDismiss }: { data: BoardData; onDismiss?: () => void }) {
  const entered = useEntered();

  const delta = data.visitsThisWeek - data.visitsLastWeek;
  const up = delta >= 0;
  const peak = Math.max(data.visitsThisWeek, data.visitsLastWeek, 1);
  const dayPeak = Math.max(1, ...data.byDay.map((d) => d.visits ?? 0));
  const rosterPeak = Math.max(1, ...data.roster.map((r) => r.visits));

  const bigN = useCountUp(data.visitsThisWeek, 240, 1000);
  const acresN = useCountUp(data.acres ?? 0, 420, 900, 1);
  const propsN = useCountUp(data.properties, 500, 900);
  const timeN = useCountUp(data.onTimePct, 580, 900);

  return (
    /* THE BEZEL — the whole reason this does not read as an unstyled panel.
       A fixed dark surface sitting flush in a themed app looks broken; the
       same surface in a lit frame with something travelling around it reads
       as a device that was deliberately mounted there. Three layers: a
       one-shot CRT power-on, a slow outer glow so it looks powered, and a
       light chasing the perimeter so it never looks inert. */
    <Box
      position="relative"
      borderRadius="20px"
      p="5px"
      overflow="hidden"
      data-board-motion
      css={{
        animation:
          "seedlings-board-poweron 1100ms ease-out 1 both, seedlings-board-frame 3.4s ease-in-out 1100ms infinite",
      }}
    >
      {/* Square and oversized so the sweep stays even around a tall panel —
          sized past the dialog's diagonal rather than a % of a non-square box,
          which would make the light visibly speed up along the short edges. */}
      <Box
        position="absolute"
        top="50%"
        left="50%"
        w="1400px"
        h="1400px"
        ml="-700px"
        mt="-700px"
        pointerEvents="none"
        css={{
          /* TWO arcs, 180 apart, with a near-white core. One dim arc on a
             slow lap was easy to miss entirely; two bright ones mean a
             light is crossing an edge you are looking at almost always. */
          background: `conic-gradient(from 0deg,
            transparent 0 4%,
            rgba(94,200,94,.22) 9%,
            ${C.turf} 14%,
            #d8f8cc 17%,
            ${C.turf} 20%,
            rgba(94,200,94,.22) 25%,
            transparent 30% 54%,
            rgba(94,200,94,.22) 59%,
            ${C.turf} 64%,
            #d8f8cc 67%,
            ${C.turf} 70%,
            rgba(94,200,94,.22) 75%,
            transparent 80% 100%)`,
          animation: "seedlings-board-chase 3.2s linear infinite",
        }}
      />

    <Box
      bg={C.ground}
      color={C.ink}
      borderRadius="15px"
      p="18px 16px 16px"
      overflow="hidden"
      position="relative"
    >
      {/* A light running the top edge, forever. Cheapest possible signal
          that the board is live rather than a screenshot. */}
      <Box
        position="absolute"
        top="0"
        left="-75%"
        w="42%"
        h="2px"
        pointerEvents="none"
        zIndex={2}
        css={{
          background: `linear-gradient(90deg, transparent, ${C.turf}, transparent)`,
          animation: "seedlings-board-sweep 6s ease-in-out 900ms infinite",
        }}
      />

      <VStack align="stretch" gap="12px">

        {/* ── crest ───────────────────────────────────────────── */}
        <HStack justify="space-between" align="baseline" gap="12px" style={rise(entered, 0)}>
          <HStack gap="8px" align="baseline">
            <Text fontFamily={NUM} fontWeight="800" fontSize="22px" letterSpacing="1.4px" textTransform="uppercase">
              Seedlings<Box as="span" color={C.turf}>.</Box>
            </Text>
            {data.isSample && (
              <Box
                as="span"
                fontSize="9px"
                fontWeight="700"
                letterSpacing="1.6px"
                textTransform="uppercase"
                color={C.amber}
                borderWidth="1px"
                borderColor={C.amber}
                borderRadius="999px"
                px="6px"
                py="1px"
              >
                Preview
              </Box>
            )}
          </HStack>
          <Text fontSize="11px" color={C.dim}>{data.weekLabel} · {data.dayLabel}</Text>
        </HStack>

        {/* ── the score ───────────────────────────────────────── */}
        <Box
          position="relative"
          borderWidth="1px"
          borderColor={C.line}
          borderRadius="14px"
          p="20px 20px 18px"
          overflow="hidden"
          style={rise(entered, 90)}
          css={{
            backgroundImage: `linear-gradient(115deg, ${C.panel} 0%, #1a231c 34%, ${C.panel} 58%, #182019 100%)`,
            backgroundSize: "280% 100%",
            animation: "seedlings-board-drift 11s ease-in-out infinite",
          }}
        >
          {/* accent rail, breathing */}
          <Box position="absolute" left="0" top="0" bottom="0" w="5px" bg={C.turf}
               css={{ animation: "seedlings-board-rail 2.6s ease-in-out infinite" }} />

          {/* one gloss sweep across the hero on entry */}
          <Box
            position="absolute"
            top="-30%"
            bottom="-30%"
            w="55%"
            left="-75%"
            pointerEvents="none"
            css={{
              background: "linear-gradient(90deg, transparent, rgba(255,255,255,.17), transparent)",
              transform: "skewX(-18deg)",
              animation: "seedlings-board-sweep 7s cubic-bezier(.3,.7,.3,1) 420ms infinite",
            }}
          />

          <HStack gap="10px" mb="6px" flexWrap="wrap" position="relative">
            <Label>Visits closed this week</Label>
            <HStack
              gap="5px"
              bg={up ? "rgba(94,200,94,.14)" : "rgba(242,173,66,.14)"}
              borderWidth="1px"
              borderColor={up ? "rgba(94,200,94,.4)" : "rgba(242,173,66,.4)"}
              color={up ? C.turf : C.amber}
              borderRadius="999px"
              px="10px"
              py="4px"
              style={{
                opacity: entered ? 1 : 0,
                transform: entered ? "scale(1)" : "scale(.82)",
                transition: "opacity 300ms ease 1150ms, transform 420ms cubic-bezier(.2,1.5,.4,1) 1150ms",
              }}
            >
              <Box as="span" fontSize="12px" fontWeight="700" lineHeight="1">
                {up ? "▲" : "▼"} {Math.abs(delta)} vs last week
              </Box>
            </HStack>
          </HStack>

          <HStack align="flex-end" gap="14px" flexWrap="wrap" position="relative">
            <Text
              fontFamily={NUM}
              fontWeight="800"
              fontSize="104px"
              lineHeight="0.78"
              letterSpacing="-3px"
              css={{ animation: "seedlings-board-glow 4.5s ease-in-out 1600ms infinite" }}
            >
              {bigN}
            </Text>
            <Text fontSize="13px" fontWeight="600" letterSpacing="1px" textTransform="uppercase" color={C.dim} pb="12px">
              visits
            </Text>
          </HStack>

          <HStack gap="22px" mt="16px" flexWrap="wrap" position="relative">
            <VStack align="start" gap="3px">
              <Text fontFamily={NUM} fontWeight="800" fontSize="30px" lineHeight="1">
                {data.acres == null ? "—" : acresN}
              </Text>
              <Label>Acres cut</Label>
            </VStack>
            <VStack align="start" gap="3px">
              <Text fontFamily={NUM} fontWeight="800" fontSize="30px" lineHeight="1">{propsN}</Text>
              <Label>Properties</Label>
            </VStack>
            <VStack align="start" gap="3px">
              <Text fontFamily={NUM} fontWeight="800" fontSize="30px" lineHeight="1">{timeN}%</Text>
              <Label>On time</Label>
            </VStack>
          </HStack>
        </Box>

        {/* ── this week vs last ───────────────────────────────── */}
        <Box bg={C.panel} borderWidth="1px" borderColor={C.line} borderRadius="14px" p="16px 18px 18px" style={rise(entered, 190)}>
          <Box mb="14px"><Label>This week vs last</Label></Box>
          <VStack align="stretch" gap="12px">
            {[
              { tag: "This wk", v: data.visitsThisWeek, now: true, d: 520 },
              { tag: "Last wk", v: data.visitsLastWeek, now: false, d: 650 },
            ].map((row) => (
              <HStack key={row.tag} gap="12px">
                <Text w="64px" flexShrink={0} fontSize="11px" fontWeight="700" letterSpacing="1.2px" textTransform="uppercase" color={C.dim}>
                  {row.tag}
                </Text>
                <Box flex="1" h="26px" bg={C.panel2} borderRadius="5px" overflow="hidden" position="relative">
                  <Box
                    h="100%"
                    borderRadius="5px"
                    position="relative"
                    overflow="hidden"
                    bg={row.now ? `linear-gradient(90deg, ${C.turfDeep}, ${C.turf})` : "#39483c"}
                    style={{
                      width: entered ? `${Math.round((row.v / peak) * 100)}%` : "0%",
                      transition: `width 1000ms cubic-bezier(.22,.9,.3,1) ${row.d}ms`,
                    }}
                  >
                    {row.now && (
                      <Box
                        position="absolute"
                        top="0"
                        bottom="0"
                        left="-75%"
                        w="40%"
                        pointerEvents="none"
                        css={{
                          background: "linear-gradient(90deg, transparent, rgba(255,255,255,.4), transparent)",
                          animation: "seedlings-board-sweep 3.4s ease-in-out 1800ms infinite",
                        }}
                      />
                    )}
                  </Box>
                </Box>
                <Text w="34px" flexShrink={0} textAlign="right" fontFamily={NUM} fontWeight="800" fontSize="22px" lineHeight="1" color={row.now ? C.ink : C.dim}>
                  {row.v}
                </Text>
              </HStack>
            ))}
          </VStack>
        </Box>

        {/* ── by day ──────────────────────────────────────────── */}
        <Box bg={C.panel} borderWidth="1px" borderColor={C.line} borderRadius="14px" p="16px 18px 18px" style={rise(entered, 280)}>
          <Box mb="14px"><Label>By day</Label></Box>
          <HStack gap="6px" align="flex-end" h="92px">
            {data.byDay.map((d, i) => {
              const pending = d.visits == null;
              const pct = pending ? 4 : Math.max(5, Math.round(((d.visits ?? 0) / dayPeak) * 100));
              return (
                <VStack key={d.day} flex="1" h="100%" justify="flex-end" gap="7px">
                  <Text fontSize="11px" fontWeight="700" color={C.dim}>{pending ? "–" : d.visits}</Text>
                  <Box
                    w="100%"
                    borderRadius="4px 4px 2px 2px"
                    bg={d.today ? `linear-gradient(180deg, ${C.turf}, ${C.turfDeep})` : "#33432f"}
                    css={d.today ? { animation: "seedlings-board-rail 2.8s ease-in-out infinite" } : undefined}
                    style={{
                      height: entered ? `${pct}%` : "0%",
                      transition: `height 700ms cubic-bezier(.22,.9,.3,1) ${620 + i * 70}ms`,
                    }}
                  />
                  <Text fontSize="10px" fontWeight="700" letterSpacing="1px" textTransform="uppercase" color={d.today ? C.turf : C.dim}>
                    {d.day}
                  </Text>
                </VStack>
              );
            })}
          </HStack>
        </Box>

        {/* ── on the board ────────────────────────────────────── */}
        <Box bg={C.panel} borderWidth="1px" borderColor={C.line} borderRadius="14px" p="16px 18px 18px" style={rise(entered, 370)}>
          <Box mb="14px"><Label>On the board</Label></Box>
          <VStack align="stretch" gap="0">
            {data.roster.map((w, i) => {
              const lead = w.visits === rosterPeak;
              return (
                <HStack
                  key={w.name}
                  gap="12px"
                  p="11px 10px"
                  borderRadius="9px"
                  position="relative"
                  overflow="hidden"
                  bg={lead ? "rgba(94,200,94,.09)" : undefined}
                  borderTopWidth={i === 0 ? "0" : "1px"}
                  borderTopColor={C.line}
                  style={{
                    opacity: entered ? 1 : 0,
                    transform: entered ? "translateX(0)" : "translateX(-10px)",
                    transition: `opacity 360ms ease ${780 + i * 80}ms, transform 420ms cubic-bezier(.22,.9,.3,1) ${780 + i * 80}ms`,
                  }}
                >
                  {/* the leader's row keeps catching the light */}
                  {lead && (
                    <Box
                      position="absolute"
                      top="-40%"
                      bottom="-40%"
                      w="38%"
                      left="-75%"
                      pointerEvents="none"
                      css={{
                        background: "linear-gradient(90deg, transparent, rgba(94,200,94,.22), transparent)",
                        transform: "skewX(-18deg)",
                        animation: "seedlings-board-sweep 4.5s ease-in-out 1600ms infinite",
                      }}
                    />
                  )}
                  <Box
                    w="38px"
                    h="38px"
                    flexShrink={0}
                    borderRadius="10px"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    fontFamily={NUM}
                    fontWeight="800"
                    fontSize="17px"
                    borderWidth="1px"
                    position="relative"
                    bg={lead ? C.turf : C.panel2}
                    color={lead ? "#07130a" : C.ink}
                    borderColor={lead ? C.turf : C.line}
                    css={lead ? { animation: "seedlings-board-halo 2.6s ease-out 2000ms infinite" } : undefined}
                  >
                    {w.initials}
                  </Box>
                  <VStack flex="1" minW="0" align="start" gap="1px" position="relative">
                    <Text fontSize="15px" fontWeight="600">{w.name}</Text>
                    <Text fontSize="11px" color={C.dim}>
                      {w.properties} properties · {w.sameDayCloses} same-day closes
                    </Text>
                  </VStack>
                  <Text fontFamily={NUM} fontWeight="800" fontSize="26px" lineHeight="1" position="relative" color={lead ? C.turf : C.ink}>
                    {w.visits}
                  </Text>
                </HStack>
              );
            })}
          </VStack>
        </Box>

        {/* ── records ─────────────────────────────────────────── */}
        <HStack gap="10px" align="stretch" style={rise(entered, 470)}>
          <Box flex="1" bg={C.panel} borderWidth="1px" borderColor={C.line} borderRadius="14px" p="14px 14px 15px">
            <Text fontFamily={NUM} fontWeight="800" fontSize="34px" lineHeight="1" color={C.amber} mb="5px"
                  css={{ animation: "seedlings-board-flare 3.2s ease-in-out 1800ms infinite" }}>
              {data.bestWeek ? data.bestWeek.visits : "—"}
            </Text>
            <Label>Best week</Label>
            <Text fontSize="11px" color={C.dim} lineHeight="1.35" mt="4px">
              {data.bestWeek
                ? `Set ${data.bestWeek.when}.${
                    data.bestWeek.visits > data.visitsThisWeek
                      ? ` ${data.bestWeek.visits - data.visitsThisWeek} away.`
                      : " Beaten this week."
                  }`
                : "No record yet."}
            </Text>
          </Box>
          <Box flex="1" bg={C.panel} borderWidth="1px" borderColor={C.line} borderRadius="14px" p="14px 14px 15px">
            <Text fontFamily={NUM} fontWeight="800" fontSize="34px" lineHeight="1" color={C.amber} mb="5px"
                  css={{ animation: "seedlings-board-flare 3.2s ease-in-out 2400ms infinite" }}>
              {data.streakDays ?? "—"}
            </Text>
            <Label>Day streak</Label>
            <Text fontSize="11px" color={C.dim} lineHeight="1.35" mt="4px">
              Every visit closed same-day.
            </Text>
          </Box>
        </HStack>

        {/* ── ticker ──────────────────────────────────────────── */}
        {data.ticker.length > 0 && (
          <Box
            bg={C.turf}
            color="#07130a"
            borderRadius="10px"
            h="38px"
            display="flex"
            alignItems="center"
            overflow="hidden"
            style={rise(entered, 560)}
          >
            <HStack
              gap="0"
              flexWrap="nowrap"
              whiteSpace="nowrap"
              css={{ animation: "seedlings-board-slide 26s linear infinite" }}
            >
              {[...data.ticker, ...data.ticker].map((t, i) => (
                <Text key={`${t}-${i}`} px="18px" fontSize="12px" fontWeight="700" letterSpacing="0.8px" textTransform="uppercase">
                  {t}
                </Text>
              ))}
            </HStack>
          </Box>
        )}

        {/* The dismiss lives HERE, not in the trigger, so every colour on this
            surface sits in one file and the theming gate's exemption can stay
            as narrow as the one for the wall display. */}
        {onDismiss && (
          <Box pt="2px" style={rise(entered, 650)}>
            <Box
              as="button"
              w="full"
              minH="44px"
              borderRadius="10px"
              borderWidth="1px"
              borderColor={C.line}
              bg={C.panel}
              color={C.ink}
              fontSize="13px"
              fontWeight="600"
              cursor="pointer"
              _hover={{ borderColor: "#3d5142" }}
              onClick={onDismiss}
            >
              Get to work
            </Box>
            {data.isSample && (
              <Text fontSize="10px" color={C.dim} textAlign="center" mt="8px">
                Sample figures &mdash; the board endpoint isn&rsquo;t wired up yet.
              </Text>
            )}
          </Box>
        )}
      </VStack>
    </Box>
    </Box>
  );
}
