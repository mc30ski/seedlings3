"use client";

// Title-bar "on the clock" bubble. Extracted from pages/index.tsx so its
// 1-second ticker doesn't force the whole top-level page component to
// re-render every second — before this extraction, the parent's
// `refreshAllAlerts` effect (which depends on ~17 loader callbacks) got
// re-fired on every tick, hitting every count endpoint continuously
// while the Tasks page was open.
//
// Renders a solid blue pill with the running workday's elapsed time
// when the caller is IN_PROGRESS, an amber pill (frozen at pausedAt)
// when PAUSED. Nothing when NOT_STARTED, COMPLETED, or when the caller
// isn't a worker (unsigned, client-impersonating, etc.). Click jumps to
// Worker → Home so the WorkdayStrip's Complete/Pause/End/Resume/Edit
// controls are one tap away.
//
// Data:
//   - Fetches /api/me/workday/today on mount, on visibilitychange
//     (window refocus), and on seedlings:workday-changed events fired
//     by every workday mutation helper.
//   - The 1-Hz `tick` state is a LOCAL setInterval — only THIS
//     component re-renders each second, not the whole app shell.

import { useEffect, useState } from "react";
import { Box, Text } from "@chakra-ui/react";
import { Clock, Pause as PauseIcon } from "lucide-react";
import { fetchWorkdayToday, type WorkdayTodayPayload } from "@/src/lib/workday";

type Props = {
  /** True when a real signed-in user is present. Hides the bubble
   *  during sign-out flows / unauthenticated shell. */
  isSignedIn: boolean;
  /** True when a Super is in a client view-as session. The shell isn't
   *  a worker context; hide the bubble to avoid the illusion that the
   *  clock is running for whoever they're impersonating. */
  isClientImpersonating: boolean;
  /** Stable primary key of the current user; used as a re-fetch trigger
   *  when the account swaps. */
  meId: string | null | undefined;
};

// Compact H:MM / M:SS formatter for the pill.
//   < 1 hour  →  "M:SS"  (e.g. "5:23") — seconds tick live so the
//                worker can see the clock is running.
//   ≥ 1 hour  →  "Hh MMm" (e.g. "1h 23m") — drops seconds so the pill
//                doesn't grow to 7 chars. Suffixes ("h"/"m") also
//                disambiguate `1:05` (5s past 1m) from `1h 05m`.
function fmtDurationClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}h ${mm}m`;
  }
  const ss = s.toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function computeActiveMs(payload: WorkdayTodayPayload | null): number {
  if (!payload) return 0;
  const t = payload.today;
  if (t.state !== "IN_PROGRESS" && t.state !== "PAUSED") return 0;
  const wd = t.workday;
  // Endpoint for the interval:
  //   IN_PROGRESS → now (live-ticking).
  //   PAUSED → pausedAt (frozen; the open pause segment isn't yet in
  //   totalPausedMs so clip the interval to avoid double-counting).
  const endpoint = t.state === "PAUSED" && wd.pausedAt
    ? new Date(wd.pausedAt).getTime()
    : Date.now();
  const raw = endpoint - new Date(wd.startedAt).getTime();
  return Math.max(0, raw - wd.totalPausedMs);
}

function jumpToWorkdayControls() {
  // Same tab-switch event other components use to route into Worker →
  // Home. Also scroll to the top so the WorkdayStrip is above the fold.
  window.dispatchEvent(
    new CustomEvent("seedlings:switchTab", { detail: { outer: "worker", inner: "home" } }),
  );
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* no-op */ }
}

export default function OnClockBubble({ isSignedIn, isClientImpersonating, meId }: Props) {
  const [payload, setPayload] = useState<WorkdayTodayPayload | null>(null);
  const [tick, setTick] = useState(0);

  // Fetch on mount + on the workday-changed event + on tab focus.
  useEffect(() => {
    if (!isSignedIn || !meId) return;
    if (isClientImpersonating) return;
    let cancelled = false;
    const load = () => {
      fetchWorkdayToday()
        .then((p) => { if (!cancelled) setPayload(p); })
        .catch(() => {});
    };
    load();
    const onChanged = () => load();
    window.addEventListener("seedlings:workday-changed", onChanged);
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("seedlings:workday-changed", onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isSignedIn, meId, isClientImpersonating]);

  // 1-second tick — only re-renders THIS component. Stops when the
  // workday isn't running (PAUSED freezes the display; NOT_STARTED /
  // COMPLETED render nothing).
  const state = payload?.today.state;
  useEffect(() => {
    if (state !== "IN_PROGRESS") return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  if (!payload || isClientImpersonating) return null;
  if (state !== "IN_PROGRESS" && state !== "PAUSED") return null;

  const running = state === "IN_PROGRESS";
  const activeMs = computeActiveMs(payload);
  void tick; // dependency on tick — triggers the re-render, not a value read
  // Solid blue.500 white for IN_PROGRESS matches the WorkdayStrip's
  // Complete button so the bubble reads as an action target. Amber.500
  // white for PAUSED matches the strip's PAUSED-state theme.
  const bg = running ? "blue.500" : "yellow.500";
  const bgHover = running ? "blue.600" : "yellow.600";
  return (
    <Box
      as="button"
      cursor="pointer"
      px="3"
      py="1.5"
      borderRadius="full"
      bg={bg}
      color="white"
      shadow="sm"
      _hover={{ bg: bgHover, shadow: "md" }}
      title={running ? "On the clock — tap for workday controls" : "Workday paused — tap for controls"}
      onClick={jumpToWorkdayControls}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
    >
      <Box display="inline-flex" alignItems="center">
        {running ? <Clock size={14} /> : <PauseIcon size={14} />}
      </Box>
      <Text fontSize="sm" fontWeight="bold" lineHeight="1" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
        {fmtDurationClock(activeMs)}
      </Text>
    </Box>
  );
}
