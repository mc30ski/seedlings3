import { useEffect, useRef, useState } from "react";
// @types/react-dom isn't installed in this workspace; import is
// runtime-safe (react-dom ships with React) — one-line type shim
// avoids adding a new devDependency just for a single call.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error missing types for react-dom in this workspace
import { createPortal } from "react-dom";
import { getSeasonIcons } from "@/src/lib/season";
import { apiGet } from "@/src/lib/api";

// Full-viewport splash shown while the app is initializing. Static
// centered logo → fade + expand together when the app is ready.
//
// Startup typing animation: on every fresh mount (page load / refresh),
// a typing animation plays UNDER the logo. It types `seedlings.pro`,
// then cycles through vanity-URL slugs the operator opted in via the
// Vanity tab (`showInStartupAnimation` flag, ordered by sortOrder).
// SPA navigation within the app does NOT re-mount AppSplash, so the
// animation doesn't replay on tab switches.
//
// Uses plain DOM + inline styles (NOT Chakra Box) and keyframes from
// globals.css (NOT emotion-generated). Prior iterations of this
// component leaned on Chakra props (`display: grid; place-items:
// center`, animation prop backed by emotion keyframes) and produced
// a visible vertical jump on cold load: those styles were applied
// via CSS classes/rules injected at Chakra runtime, so on the very
// first frame the logo painted at the block-flow position (top of
// the viewport) and only snapped to center once the class landed.
// Inline styles + a static stylesheet dodge that entirely — the
// browser has everything it needs before it composites the first
// frame. `position: fixed` on the outer means it's viewport-anchored,
// so no Portal needed as long as no ancestor establishes a transform
// containing block (none in _app.tsx today).

const FADE_MS = 1000;
const MIN_DURATION_MS = 1000;

const DOMAIN_TEXT = "seedlings.pro";
const TYPE_CHAR_MS = 65;    // one letter every 65ms while typing the domain
const SLUG_TYPE_CHAR_MS = 42; // faster for slug portions — feels snappier
const ERASE_CHAR_MS = 22;   // faster on erase — feels more responsive
const HOLD_FULL_MS = 700;   // pause once a full "/slug" is on screen
const HOLD_BETWEEN_MS = 160; // pause after erasing before typing next
const HOLD_DOMAIN_MS = 650;  // pause after typing the domain, before first slug
const HOLD_END_MS = 800;     // extra settle pause after the last slug, before splash fades

// Estimated ms to walk one full slug cycle (type + hold + erase + gap).
// Used to size the splash's minimum duration so all slugs get a chance
// to display before the splash fades. Uses an average-ish slug length
// of 10 chars — over-estimates slightly (fine — splash extension is
// a floor, real animation runs until fade).
const SLUG_CYCLE_MS =
  10 * SLUG_TYPE_CHAR_MS + HOLD_FULL_MS + 10 * ERASE_CHAR_MS + HOLD_BETWEEN_MS;
const DOMAIN_PHASE_MS = DOMAIN_TEXT.length * TYPE_CHAR_MS + HOLD_DOMAIN_MS;

// Hard cap: splash MUST fully disappear this many ms after mount,
// no matter what `show` is doing. Protects against Clerk auth or the
// /api/me call hanging — without this, `show` never flips false and
// the splash stays over the whole app forever. 15s is well past any
// reasonable animation + auth+me round-trip.
const HARD_MAX_MS = 15000;

export default function AppSplash({ show }: { show: boolean }) {
  const [shouldRender, setShouldRender] = useState(show);
  const [fading, setFading] = useState(false);
  // Escape hatch — flips true after HARD_MAX_MS and forces the
  // splash to unmount even if `show` is stuck true.
  const [forceHide, setForceHide] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setForceHide(true), HARD_MAX_MS);
    return () => window.clearTimeout(t);
  }, []);
  // Portal-render gate — starts false so SSR + initial client render
  // return the same nothing; useEffect flips it after the first
  // commit and the portal appears. Prevents hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [slugs, setSlugs] = useState<string[]>([]);
  // Animation trigger. Starts `false` so SSR and initial client paint
  // produce IDENTICAL DOM structure (no <TypingAnimation> in either)
  // — flips to `true` in useEffect after mount if the gate below
  // says this render should play the animation.
  //
  // Gate rules (checked post-mount so it's hydration-safe):
  //   • Browser refresh (nav type "reload") → always play.
  //     Clears the session flag first so a re-refresh still plays.
  //   • Cold start (new tab / new browser, session flag missing) →
  //     play. Set the session flag so subsequent mounts skip.
  //   • Sign-out → causes AppSplash to remount with session flag
  //     still set → skip animation.
  //   • Any other in-app navigation → session flag set → skip.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    try {
      const nav = performance.getEntriesByType?.("navigation") as
        | { type?: string }[]
        | undefined;
      const navType = nav?.[0]?.type ?? "";
      const FLAG = "seedlings_splash_animated";
      if (navType === "reload") window.sessionStorage.removeItem(FLAG);
      if (window.sessionStorage.getItem(FLAG)) return;
      window.sessionStorage.setItem(FLAG, "1");
      setAnimate(true);
    } catch {
      // sessionStorage/perf can throw in exotic contexts — fail OPEN
      // (play the animation) so users get the intended experience.
      setAnimate(true);
    }
  }, []);
  const shownAtRef = useRef<number | null>(show ? Date.now() : null);
  const hideTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);

  // Fetch the animation slug list once at mount. Empty list → no
  // typed text renders. Fetch is intentionally silent — if the API
  // is unreachable, splash just shows the logo, no error.
  //
  // Uses apiGet so the URL is built via NEXT_PUBLIC_API_BASE_URL — in
  // prod that's `/api/_proxy`, which makes the final URL
  // `/api/_proxy/api/public/vanity/animation`. A bare "/api/public/…"
  // fetch would get mangled by the vercel.json `/api/(.*)` rewrite
  // and hit the API without its `/api/` prefix → 404.
  useEffect(() => {
    if (!animate) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ slugs?: string[] }>(
          "/api/public/vanity/animation",
        );
        if (cancelled) return;
        if (Array.isArray(data?.slugs)) setSlugs(data.slugs);
      } catch {
        // Silent — no animation is fine
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [animate]);

  useEffect(() => {
    if (show) {
      if (!shouldRender) setShouldRender(true);
      setFading(false);
      shownAtRef.current = shownAtRef.current ?? Date.now();
    } else {
      const startedAt = shownAtRef.current ?? Date.now();
      const elapsed = Date.now() - startedAt;
      // When there's an animation to play, extend the min duration
      // enough for one pass through the slug list — no more. Actual
      // per-slug cycles get faster with acceleration, so a generous
      // per-slug estimate (SLUG_CYCLE_MS ≈ full-speed cycle) would
      // leave dead air after the last slug. Using a shorter average
      // per slug and a tiny tail buffer keeps the splash tight to
      // the animation's real duration.
      // Min duration when the typing animation will play at all —
      // covers both signed-in (slugs came back) and signed-out /
      // slugs-empty cases. Without this, a fast-resolving auth
      // (signed-out or already-cached signed-in) makes `show` flip
      // false in under a second and the splash fades before the
      // animation gets a chance to type even the domain. Even with
      // 0 slugs the formula gives ~2.6s (domain phase + tail), which
      // is enough for the "seedlings.pro" type-out to be visible.
      const minDuration = animate
        ? Math.min(8000, DOMAIN_PHASE_MS + slugs.length * 900 + HOLD_END_MS + 150)
        : MIN_DURATION_MS;
      const remaining = Math.max(minDuration - elapsed, 0);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        setFading(true);
        unmountTimerRef.current = window.setTimeout(() => {
          setShouldRender(false);
          setFading(false);
          shownAtRef.current = null;
        }, FADE_MS);
      }, remaining);
    }
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);
    };
  }, [show, shouldRender, animate, slugs.length]);

  if (!shouldRender || forceHide) return null;
  // Portal to document.body — escapes any ancestor with `transform`,
  // `filter`, `perspective`, `contain: paint`, `will-change: transform`,
  // etc. Any of those on an ancestor would establish a containing
  // block for position:fixed and make our splash coordinates relative
  // to that ancestor instead of the viewport.
  //
  // SSR/hydration: `mounted` starts false → both server AND initial
  // client render return null (no mismatch). After first client
  // commit, `mounted` flips true and the portal is added. Prevents
  // "hydration failed" errors from the portal existing on client but
  // not on server.
  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden
      // Click/tap anywhere → skip straight to the app.
      onClick={() => setForceHide(true)}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20000,
        background: "white",
        cursor: "pointer",
        // Flex-center: logo + typing animation stack as flex children;
        // the OVERLAY itself centers the group both axes. Simple, no
        // absolute positioning, no transform gymnastics — the visual
        // center of the whole content (logo + animation) sits at
        // viewport center. Since history is INSIDE TypingAnimation as
        // an absolutely-positioned child, adding history lines doesn't
        // change the flex item's height and the logo stays put.
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        animation: fading ? `seedlings-splash-overlay-fade ${FADE_MS}ms ease forwards` : undefined,
      }}
    >
      <img
        src={typeof window !== "undefined" ? getSeasonIcons().icon : "/seedlings-icon.png"}
        alt="Seedlings"
        width={120}
        height={120}
        style={{
          display: "block",
          // Fade keyframe only applies `opacity + scale` — no more
          // translate needed since flex positioning centers the img
          // and the keyframe was rewritten to match.
          animation: fading ? `seedlings-splash-logo-expand ${FADE_MS}ms ease forwards` : undefined,
        }}
      />
      {animate && (
        <TypingAnimation slugs={slugs} paused={fading} />
      )}
    </div>,
    document.body,
  );
}

// ── Typing animation ─────────────────────────────────────────────────
//
// Sequence:
//   1. Type "seedlings.pro" one char at a time
//   2. Pause briefly
//   3. Type "/slug" — one slug per cycle
//   4. Pause
//   5. Erase back to "seedlings.pro"
//   6. Next slug — loops through the list forever until paused
//
// Empty slug list → just types the domain and holds. Never erases.
//
// The loop tracks the current text via a REF (not state closure) so
// successive typeString / eraseTo calls always know where they are on
// screen. Earlier iteration read `text` state from closure, which stayed
// pinned to its mount-time value ("") and caused erase to skip and the
// next typeString to overwrite from character 0 — visually looked like
// the animation was stuck on the first slug.

function TypingAnimation({
  slugs,
  paused,
}: {
  slugs: string[];
  paused: boolean;
}) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const currentRef = useRef("");
  const write = (next: string) => {
    currentRef.current = next;
    setText(next);
  };

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let timeout: number | null = null;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timeout = window.setTimeout(() => {
          timeout = null;
          resolve();
        }, ms);
      });

    const speedFactorFor = (idx: number) => Math.max(0.28, Math.pow(0.78, idx));
    const typeMsFor = (idx: number) =>
      idx < 0 ? TYPE_CHAR_MS : Math.max(15, Math.round(SLUG_TYPE_CHAR_MS * speedFactorFor(idx)));
    const eraseMsFor = (idx: number) =>
      idx < 0 ? ERASE_CHAR_MS : Math.max(10, Math.round(ERASE_CHAR_MS * speedFactorFor(idx)));
    const holdFullMsFor = (idx: number) =>
      Math.max(300, Math.round(HOLD_FULL_MS * speedFactorFor(idx)));
    const holdBetweenMsFor = (idx: number) =>
      Math.max(80, Math.round(HOLD_BETWEEN_MS * speedFactorFor(idx)));

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

    async function run() {
      if (currentRef.current.length < DOMAIN_TEXT.length) {
        await typeString(DOMAIN_TEXT, typeMsFor(-1));
        if (cancelled) return;
        await wait(HOLD_DOMAIN_MS);
      }

      if (slugs.length === 0) return;

      if (currentRef.current.length > DOMAIN_TEXT.length) {
        await eraseTo(DOMAIN_TEXT, eraseMsFor(0));
        if (cancelled) return;
        await wait(holdBetweenMsFor(0));
      }

      // ONE pass through the slug list. After each slug is typed and
      // held, it's captured into `history` (rendered below) BEFORE the
      // erase — so the list of previously-shown slugs stays visible
      // as the live line cycles. The last slug is captured too, then
      // NOT erased so the live line lands on it with the cursor.
      for (let idx = 0; idx < slugs.length && !cancelled; idx++) {
        const slug = slugs[idx];
        await typeString(`${DOMAIN_TEXT}/${slug}`, typeMsFor(idx));
        if (cancelled) return;
        // Push to history the instant the slug finishes typing, BEFORE
        // the hold — otherwise the history line lags the live line's
        // completion by the full hold duration (~700ms) and reads as
        // an unexplained delay.
        setHistory((prev) => [...prev, slug]);
        await wait(holdFullMsFor(idx));
        if (cancelled) return;
        if (idx < slugs.length - 1) {
          await eraseTo(DOMAIN_TEXT, eraseMsFor(idx));
          if (cancelled) return;
          await wait(holdBetweenMsFor(idx));
        }
      }
      if (!cancelled) await wait(HOLD_END_MS);
    }

    void run();

    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [slugs, paused]);

  // Style segments on the LIVE line: "seedlings" bold, ".pro" normal,
  // "/" muted, slug normal. Fixed offsets since the domain part is
  // a constant length.
  const bolded = text.slice(0, 9);
  const domainTail = text.slice(9, 13);
  const slash = text.slice(13, 14);
  const slug = text.slice(14);
  return (
    // The wrapper is `position: relative` so the absolutely-positioned
    // history stack anchors to its bottom without being part of the
    // flex layout. That way the wrapper's own height stays constant
    // (= one live line) and the parent flex (logo + this) doesn't
    // grow — logo stays viewport-centered even as history extends.
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
      {/* LIVE line — the original animation: types domain, then each
          /slug, then erases and types the next. Cursor always here. */}
      <div style={{ minHeight: "1.4em", whiteSpace: "nowrap", overflow: "hidden", textAlign: "center" }}>
        <span style={{ fontWeight: 700 }}>{bolded}</span>
        {domainTail}
        <span style={{ color: "#a0aec0" }}>{slash}</span>
        {slug}
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
      {/* HISTORY — absolutely positioned BELOW the live line so it
          doesn't push the logo up as it grows. Each already-shown
          slug renders as the full word the vanity spells out: the
          domain's ".pro" glues to the slug at the URL boundary, so
          "seedlings.pro/perty" reads as "property". History displays
          that full word (pro + slug), muted gray. */}
      {history.length > 0 && (
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
