import { useEffect, useMemo, useRef, useState } from "react";
// @types/react-dom isn't installed in this workspace; import is
// runtime-safe (react-dom ships with React) — one-line type shim
// avoids adding a new devDependency just for a single call.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error missing types for react-dom in this workspace
import { createPortal } from "react-dom";
import { getSeasonIcons } from "@/src/lib/season";
import { apiGet } from "@/src/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// AppSplash — full-viewport white overlay with a centered logo and, on
// eligible loads, a typing animation that cycles vanity URLs.
//
// Lifecycle (single state machine, no interleaved flags):
//   idle → visible → fading → gone
//
// Rules:
//   • Every mount briefly enters `visible`, giving `show` a chance to
//     control the exit. When `show` flips false we hold for the
//     animation's remaining time (or MIN_LOGO_ONLY_MS if no animation)
//     then fade → gone.
//   • Hard cap: HARD_MAX_MS after mount we force `gone` no matter
//     what. Fail-safe for hung auth / hung DB.
//   • Portal to document.body so the overlay escapes any ancestor's
//     transform / filter containing block.
//   • Body background painted white while visible so brief iOS PWA
//     viewport shifts (URL/status bar animations) show white instead
//     of app content peeking through.
//   • Click anywhere → skip.
//
// Animation gate — should the typing play this mount?
//   1. VANITY_STARTUP_ANIMATION_ENABLED setting must be true (default true)
//   2. Navigation type must be "reload" (browser refresh) OR the
//      session flag "seedlings_splash_animated" must be unset.
//      On reload we clear the flag first. On other loads (SPA nav,
//      sign-out) the flag is set from a prior render and we skip.
//
// Kill switch: set the DB row VANITY_STARTUP_ANIMATION_ENABLED to
// "false" (via the Vanity tab toggle, or directly in the Neon SQL
// editor if the app is broken). Splash then reduces to logo-only.
// ─────────────────────────────────────────────────────────────────────────────

const HARD_MAX_MS = 15_000;
const FADE_MS = 800;
const MIN_LOGO_ONLY_MS = 900;

const DOMAIN_TEXT = "seedlings.pro";
const DOMAIN_TYPE_MS = 65;
const SLUG_TYPE_MS = 42;
const ERASE_MS = 22;
const HOLD_DOMAIN_MS = 650;
const HOLD_SLUG_MS = 700;
const HOLD_BETWEEN_MS = 160;
const HOLD_END_MS = 800;

const SESSION_FLAG = "seedlings_splash_animated";

// Rough per-slug wall-clock budget for the min-duration formula.
// Real cycle time is shorter (acceleration + short slugs), so this
// slightly over-estimates on purpose — better a beat of dead air
// than a slug clipped mid-type.
const SLUG_BUDGET_MS = 900;

type Phase = "idle" | "visible" | "fading" | "gone";

type AnimationConfig = {
  enabled: boolean;
  slugs: string[];
  showHistory: boolean;
  // Whether the config has been resolved (either fetch completed OR
  // we decided to skip the fetch). Drives min-duration calculation
  // so the splash holds long enough for the typing to finish even
  // when the fetch is slow.
  resolvedAt: number | null;
};

const INITIAL_CONFIG: AnimationConfig = {
  enabled: true,
  slugs: [],
  showHistory: true,
  resolvedAt: null,
};

export default function AppSplash({ show }: { show: boolean }) {
  const [phase, setPhase] = useState<Phase>(show ? "visible" : "idle");
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const mountedAtRef = useRef(Date.now());

  // Should the typing animation run this mount? Computed ONCE at
  // mount time; never flips later. Skips the animation on:
  //   • Any load that isn't a browser refresh AND has the session flag
  //     (already animated in this tab → sign-out / SPA nav)
  //   • Any load if the settings kill switch is off (checked after
  //     the fetch — see `config.enabled` below)
  const shouldAttemptAnimation = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      const nav = performance.getEntriesByType?.("navigation") as
        | { type?: string }[]
        | undefined;
      const navType = nav?.[0]?.type ?? "";
      if (navType === "reload") {
        window.sessionStorage.removeItem(SESSION_FLAG);
        return true;
      }
      if (window.sessionStorage.getItem(SESSION_FLAG)) return false;
      window.sessionStorage.setItem(SESSION_FLAG, "1");
      return true;
    } catch {
      // Storage/perf can throw in exotic contexts (private mode,
      // disabled storage). Fail OPEN — play the animation.
      return true;
    }
  }, []);

  // Fetch config once (only when we might animate). Endpoint returns
  // { enabled, slugs, showHistory }. On failure we render a plain
  // logo splash (no typing) — better than hanging.
  const [config, setConfig] = useState<AnimationConfig>(INITIAL_CONFIG);
  useEffect(() => {
    if (!shouldAttemptAnimation) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{
          enabled?: boolean;
          slugs?: string[];
          showHistory?: boolean;
        }>("/api/public/vanity/animation");
        if (cancelled) return;
        setConfig({
          enabled: data?.enabled !== false,
          slugs: Array.isArray(data?.slugs) ? data.slugs : [],
          showHistory: data?.showHistory !== false,
          resolvedAt: Date.now(),
        });
      } catch {
        if (cancelled) return;
        setConfig((prev) => ({ ...prev, resolvedAt: Date.now() }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldAttemptAnimation]);

  const willAnimate = shouldAttemptAnimation && config.enabled;

  // Paint body white while visible so brief iOS viewport shifts
  // don't reveal app content underneath. Restore on unmount.
  useEffect(() => {
    if (phase === "gone" || phase === "idle") return;
    const prev = document.body.style.background;
    document.body.style.background = "white";
    return () => {
      document.body.style.background = prev;
    };
  }, [phase]);

  // Hard cap: after HARD_MAX_MS we force `gone` regardless of any
  // other state. If auth / me / whatever hangs, users are NOT stuck
  // looking at the splash forever.
  useEffect(() => {
    const t = window.setTimeout(() => setPhase("gone"), HARD_MAX_MS);
    return () => window.clearTimeout(t);
  }, []);

  // React to `show` changes:
  //   show=true  → make sure we're visible
  //   show=false → schedule fade after the min-duration has elapsed
  useEffect(() => {
    if (phase === "gone") return;
    if (show) {
      if (phase === "idle") setPhase("visible");
      return;
    }
    // show=false. Compute how much longer to hold.
    const now = Date.now();
    const minEnd = calcMinEnd({
      mountedAt: mountedAtRef.current,
      willAnimate,
      config,
      now,
    });
    const holdRemaining = Math.max(minEnd - now, 0);
    const fadeTimer = window.setTimeout(() => setPhase("fading"), holdRemaining);
    const goneTimer = window.setTimeout(
      () => setPhase("gone"),
      holdRemaining + FADE_MS,
    );
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(goneTimer);
    };
  }, [show, phase, willAnimate, config]);

  if (!mounted || typeof document === "undefined") return null;
  if (phase === "idle" || phase === "gone") return null;

  const fading = phase === "fading";
  return createPortal(
    <div
      aria-hidden
      onClick={() => setPhase("gone")}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20000,
        background: "white",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        animation: fading
          ? `seedlings-splash-overlay-fade ${FADE_MS}ms ease forwards`
          : undefined,
      }}
    >
      <img
        src={
          typeof window !== "undefined"
            ? getSeasonIcons().icon
            : "/seedlings-icon.png"
        }
        alt="Seedlings"
        width={120}
        height={120}
        style={{
          display: "block",
          animation: fading
            ? `seedlings-splash-logo-expand ${FADE_MS}ms ease forwards`
            : undefined,
        }}
      />
      {willAnimate && (
        <TypingAnimation
          slugs={config.slugs}
          showHistory={config.showHistory}
          paused={fading}
        />
      )}
    </div>,
    document.body,
  );
}

// Calculates the earliest wall-clock time the splash may start
// fading. Kept as a pure function so the two useEffects that need it
// share a single source of truth and it's easy to reason about.
function calcMinEnd(args: {
  mountedAt: number;
  willAnimate: boolean;
  config: AnimationConfig;
  now: number;
}): number {
  const { mountedAt, willAnimate, config, now } = args;
  if (!willAnimate) return mountedAt + MIN_LOGO_ONLY_MS;
  // Animation timing needs slugs to have arrived. Anchor to the
  // arrival time — otherwise a slow fetch eats into the slug budget
  // and later slugs get cut off. If they haven't arrived yet, use
  // `now` as the anchor so the timer extends as data lands.
  const anchor = config.resolvedAt ?? now;
  const domainPhase = DOMAIN_TEXT.length * DOMAIN_TYPE_MS + HOLD_DOMAIN_MS;
  const slugPhase = config.slugs.length * SLUG_BUDGET_MS;
  return anchor + domainPhase + slugPhase + HOLD_END_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// TypingAnimation — types "seedlings.pro" once, then cycles through
// slugs. Slug typing accelerates per index for a snappy feel. Optional
// history stack renders below the current line, muted gray.
// ─────────────────────────────────────────────────────────────────────────────

function TypingAnimation({
  slugs,
  paused,
  showHistory,
}: {
  slugs: string[];
  paused: boolean;
  showHistory: boolean;
}) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  // Ref tracks current text so async cycles know where they are on
  // screen even after state updates React hasn't flushed yet.
  const currentRef = useRef("");
  const write = (next: string) => {
    currentRef.current = next;
    setText(next);
  };

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let timerId: number | null = null;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timerId = window.setTimeout(() => {
          timerId = null;
          resolve();
        }, ms);
      });

    const speedFactor = (idx: number) => Math.max(0.28, Math.pow(0.78, idx));
    const typeMs = (idx: number) =>
      idx < 0
        ? DOMAIN_TYPE_MS
        : Math.max(15, Math.round(SLUG_TYPE_MS * speedFactor(idx)));
    const eraseMs = (idx: number) =>
      Math.max(10, Math.round(ERASE_MS * speedFactor(idx)));
    const holdFullMs = (idx: number) =>
      Math.max(300, Math.round(HOLD_SLUG_MS * speedFactor(idx)));
    const holdBetweenMs = (idx: number) =>
      Math.max(80, Math.round(HOLD_BETWEEN_MS * speedFactor(idx)));

    async function typeString(target: string, charMs: number) {
      while (currentRef.current.length < target.length && !cancelled) {
        await wait(charMs);
        if (cancelled) return;
        write(target.slice(0, currentRef.current.length + 1));
      }
    }

    async function eraseTo(target: string, charMs: number) {
      while (currentRef.current.length > target.length && !cancelled) {
        await wait(charMs);
        if (cancelled) return;
        write(currentRef.current.slice(0, -1));
      }
    }

    (async () => {
      // Phase 1 — type the domain (resumes if partial from prior run).
      if (currentRef.current.length < DOMAIN_TEXT.length) {
        await typeString(DOMAIN_TEXT, typeMs(-1));
        if (cancelled) return;
        await wait(HOLD_DOMAIN_MS);
      }
      if (slugs.length === 0) return;
      // Phase 2 — cycle slugs. Each captured to history when done
      // (before the erase) so history reflects "shown" not "current".
      for (let idx = 0; idx < slugs.length && !cancelled; idx++) {
        const slug = slugs[idx];
        await typeString(`${DOMAIN_TEXT}/${slug}`, typeMs(idx));
        if (cancelled) return;
        setHistory((prev) => [...prev, slug]);
        await wait(holdFullMs(idx));
        if (cancelled) return;
        // Last slug stays on screen — don't erase it.
        if (idx < slugs.length - 1) {
          await eraseTo(DOMAIN_TEXT, eraseMs(idx));
          if (cancelled) return;
          await wait(holdBetweenMs(idx));
        }
      }
      if (!cancelled) await wait(HOLD_END_MS);
    })();

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [slugs, paused]);

  // Style segments — "seedlings" bold, ".pro" normal, "/" muted,
  // slug normal. Slicing by fixed offsets works because the domain
  // part is a known length.
  const domainBold = text.slice(0, 9);
  const domainTail = text.slice(9, 13);
  const slash = text.slice(13, 14);
  const slugPart = text.slice(14);

  return (
    <div
      style={{
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Roboto Mono', monospace",
        fontSize: "clamp(15px, 4.5vw, 22px)",
        color: "#4a5568",
        letterSpacing: "0.5px",
        maxWidth: "92vw",
        userSelect: "none",
        position: "relative",
      }}
    >
      <div
        style={{
          minHeight: "1.4em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textAlign: "center",
        }}
      >
        <span style={{ fontWeight: 700 }}>{domainBold}</span>
        {domainTail}
        <span style={{ color: "#a0aec0" }}>{slash}</span>
        {slugPart}
        <span
          style={{
            display: "inline-block",
            width: "0.6em",
            marginLeft: "1px",
            borderRight: "2px solid #4a5568",
            animation: "seedlings-splash-cursor-blink 1s step-end infinite",
          }}
        />
      </div>
      {showHistory && history.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            marginTop: "6px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            color: "#718096",
          }}
        >
          {history.map((s, i) => (
            <div
              key={`${i}-${s}`}
              style={{
                minHeight: "1.4em",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              pro{s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
