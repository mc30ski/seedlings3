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
// isn't a worker (unsigned, client-impersonating, etc.). Clicking the
// pill opens a small dropdown with the state-appropriate workday actions
// (Pause / Resume / Complete workday / Open workday controls). Cancel
// is intentionally left OUT of the dropdown — it stays in the expanded
// WorkdayStrip only, so a stray tap on this shortcut can't destroy a
// workday. Labels + coloring mirror WorkdayStrip's buttons so operators
// recognize "Complete" here as the same action.
//
// Data:
//   - Fetches /api/me/workday/today on mount, on visibilitychange
//     (window refocus), on window focus, and on seedlings:workday-changed
//     events fired by every workday mutation helper.
//   - The 1-Hz `tick` state is a LOCAL setInterval — only THIS
//     component re-renders each second, not the whole app shell.

import { useEffect, useRef, useState } from "react";
// @types/react-dom isn't installed in this workspace — one-line type
// shim, same pattern AppSplash uses to avoid adding a devDependency.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error missing types for react-dom in this workspace
import { createPortal } from "react-dom";
import { Box, HStack, Spinner, Text } from "@chakra-ui/react";
import { Clock, Pause as PauseIcon, Play, Check, ExternalLink } from "lucide-react";
import {
  endWorkday,
  fetchWorkdayToday,
  pauseWorkday,
  resumeWorkday,
  type WorkdayTodayPayload,
} from "@/src/lib/workday";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

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
  /** Reports whether the bubble is currently rendering a live pill
   *  (IN_PROGRESS or PAUSED). Parent can use this to swap chrome — e.g.
   *  hide the brand cluster and let the bubble take that spot. Fires on
   *  every state transition; safe to no-op. */
  onActiveChange?: (active: boolean) => void;
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

export default function OnClockBubble({ isSignedIn, isClientImpersonating, meId, onActiveChange }: Props) {
  const [payload, setPayload] = useState<WorkdayTodayPayload | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"pause" | "resume" | "end" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  // Dropdown position (viewport-fixed) — recomputed each time the menu
  // opens. Using position:fixed + a portal to document.body is what
  // escapes the header's overflow:hidden. Position:absolute (nested
  // under the chip) was being clipped by pages/index.tsx line ~3437.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

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
    // Also refetch on window focus — some browsers (esp. mobile Safari)
    // don't fire visibilitychange reliably when returning from a linked
    // app (e.g. Venmo → back to app). Belt-and-suspenders with the
    // event bus.
    window.addEventListener("focus", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("seedlings:workday-changed", onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onChanged);
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

  // Report active state to the parent so it can adjust chrome (e.g. hide
  // the brand cluster and let the bubble take that space). Fires on every
  // transition; parent is expected to memoize its handler.
  const isActive =
    !!payload && !isClientImpersonating
    && (state === "IN_PROGRESS" || state === "PAUSED");
  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  // Close the menu on outside click. The menu is portaled to
  // document.body (to escape the header's overflow:hidden), so we
  // check against BOTH the chip wrapper AND a data-attribute on the
  // portaled menu — a plain wrapRef.contains would never catch the
  // portaled menu since it's not a DOM descendant.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(target)) return;
      const menuEl = document.querySelector<HTMLElement>("[data-onclock-menu='1']");
      if (menuEl && menuEl.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Recompute the menu's viewport position when it opens, and on
  // window scroll/resize while it's open so it stays anchored to the
  // chip if the page shifts under it.
  useEffect(() => {
    if (!open) return;
    function recompute() {
      const r = chipRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 4, left: r.left });
    }
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  if (!isActive) return null;

  const running = state === "IN_PROGRESS";
  const activeMs = computeActiveMs(payload);
  void tick; // dependency on tick — triggers the re-render, not a value read

  async function doPause() {
    setBusy("pause");
    try {
      await pauseWorkday();
      setOpen(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to pause workday.", err) });
    } finally {
      setBusy(null);
    }
  }

  async function doResume() {
    setBusy("resume");
    try {
      await resumeWorkday();
      setOpen(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to resume workday.", err) });
    } finally {
      setBusy(null);
    }
  }

  async function doEnd() {
    if (!payload || (state !== "IN_PROGRESS" && state !== "PAUSED")) return;
    const wd = payload.today.workday;
    setBusy("end");
    try {
      // Post with workdayId only — server records endedAt=now (matches the
      // WorkdayStrip's default End action). For edit-times workflows the
      // user should open the workday controls page instead.
      await endWorkday({ workdayId: wd.id });
      setOpen(false);
      setConfirmEnd(false);
      publishInlineMessage({ type: "SUCCESS", text: "Workday ended." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to end workday.", err) });
    } finally {
      setBusy(null);
    }
  }

  // Solid blue.500 white for IN_PROGRESS matches the WorkdayStrip's
  // Complete button so the bubble reads as an action target. Amber.500
  // white for PAUSED matches the strip's PAUSED-state theme.
  const bg = running ? "blue.500" : "yellow.500";
  const bgHover = running ? "blue.600" : "yellow.600";
  const busyAny = busy !== null;

  return (
    <Box position="relative" ref={wrapRef} display="inline-flex">
      <Box
        as="button"
        ref={chipRef as any}
        cursor="pointer"
        px="3"
        py="1.5"
        borderRadius="full"
        bg={bg}
        color="white"
        shadow="sm"
        _hover={{ bg: bgHover, shadow: "md" }}
        title={running ? "On the clock — tap for workday actions" : "Workday paused — tap for actions"}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        // touch-action: manipulation removes the 300ms tap delay AND
        // tells iOS to treat this as a tap target rather than gesture-
        // detect it. Without this, iOS PWA can swallow a tap that
        // straddled a pull-to-refresh threshold.
        style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
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
      {open && menuPos && typeof document !== "undefined" && createPortal(
        <Box
          data-onclock-menu="1"
          position="fixed"
          zIndex={20000}
          top={`${menuPos.top}px`}
          left={`${menuPos.left}px`}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          rounded="lg"
          shadow="lg"
          minW="200px"
          py={1}
        >
          <Box px={3} py={1.5}>
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
              Workday
            </Text>
          </Box>
          {running ? (
            <HStack
              as="button"
              w="full"
              px={3}
              py={2}
              gap={2}
              cursor={busyAny ? "not-allowed" : "pointer"}
              opacity={busyAny ? 0.6 : 1}
              _hover={busyAny ? undefined : { bg: "gray.50" }}
              onClick={() => { if (!busyAny) void doPause(); }}
            >
              {busy === "pause" ? <Spinner size="xs" /> : <PauseIcon size={14} />}
              <Text fontSize="sm">Pause workday</Text>
            </HStack>
          ) : (
            <HStack
              as="button"
              w="full"
              px={3}
              py={2}
              gap={2}
              cursor={busyAny ? "not-allowed" : "pointer"}
              opacity={busyAny ? 0.6 : 1}
              _hover={busyAny ? undefined : { bg: "gray.50" }}
              onClick={() => { if (!busyAny) void doResume(); }}
            >
              {busy === "resume" ? <Spinner size="xs" /> : <Play size={14} />}
              <Text fontSize="sm">Resume workday</Text>
            </HStack>
          )}
          {/* Complete workday — the same action WorkdayStrip's blue
              "Complete" button fires. Labeled/styled to match so
              operators recognize it as the same operation. Note: Cancel
              is intentionally NOT surfaced here — it stays in the
              expanded WorkdayStrip section only, so an accidental tap
              on this shortcut can't destroy a workday. */}
          <HStack
            as="button"
            w="full"
            px={3}
            py={2}
            gap={2}
            cursor={busyAny ? "not-allowed" : "pointer"}
            opacity={busyAny ? 0.6 : 1}
            color="blue.700"
            _hover={busyAny ? undefined : { bg: "blue.50" }}
            onClick={() => { if (!busyAny) { setOpen(false); setConfirmEnd(true); } }}
          >
            {busy === "end" ? <Spinner size="xs" /> : <Check size={14} strokeWidth={3} />}
            <Text fontSize="sm" fontWeight="medium">Complete workday</Text>
          </HStack>
          <Box h="1px" bg="gray.200" my={1} />
          <HStack
            as="button"
            w="full"
            px={3}
            py={2}
            gap={2}
            cursor="pointer"
            _hover={{ bg: "gray.50" }}
            onClick={() => { setOpen(false); jumpToWorkdayControls(); }}
          >
            <ExternalLink size={14} />
            <Text fontSize="sm">Open workday controls</Text>
          </HStack>
        </Box>,
        document.body,
      )}
      <ConfirmDialog
        open={confirmEnd}
        title="Complete workday?"
        message="This closes today's workday at the current time. You can re-open it from the workday controls if you complete it by mistake."
        confirmLabel={busy === "end" ? "Completing…" : "Complete workday"}
        confirmColorPalette="blue"
        onConfirm={() => void doEnd()}
        onCancel={() => setConfirmEnd(false)}
      />
    </Box>
  );
}
