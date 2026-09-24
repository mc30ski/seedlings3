// ─────────────────────────────────────────────────────────────────────────────
// THE WALL DISPLAY
//
// One page, opened full-screen in a kiosk browser on a device wired to a TV or
// a vertical panel. There is no native app and nothing to install.
//
// It is NOT signed in. A session would expire and need someone to carry a
// keyboard to the wall, so instead the page pairs once — it shows six digits, a
// Super approves them in the app — and keeps a long-lived token in
// localStorage. See services/displays.ts and the Display model for why.
//
// THREE RULES THIS PAGE IS BUILT AROUND
//
//  1. Never make the viewer wait. No carousel, no ticker, no loading state. You
//     look up for two seconds and either get your answer or you don't.
//  2. Updates are seamless. Data arrives in the background and re-renders; the
//     document only ever reloads for the two things that cannot be fixed in
//     place (a wedged page, a new JS bundle).
//  3. Say how old you are. Once updates are silent, a frozen board looks
//     exactly like a working one — same layout, same rows, nothing moving. The
//     age line is the only thing between "live" and "lying since Tuesday".
//
// Colours are pinned rather than themed. Like /pages/pay and /pages/promotion,
// this renders for a viewer with no stored theme, and a wall display wants one
// deliberate dark look — glare, viewing distance, and burn-in all point there.
// ─────────────────────────────────────────────────────────────────────────────

import Head from "next/head";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSeasonIcons } from "@/src/lib/season";
import { fmtTimeOpts, fmtDateOpts } from "@/src/lib/dates";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const TOKEN_KEY_BASE = "seedlings_display_token";
const DEVICE_SECRET_KEY_BASE = "seedlings_display_device_secret";

/** OPTIONAL SLOT: /display?slot=lobby
 *
 *  localStorage is per-ORIGIN, not per-tab. Without this, opening /display in
 *  a second tab reads the first tab's token and silently becomes a second view
 *  of the SAME screen — so you cannot watch a public and a private board side
 *  by side, and clearing storage to re-pair one knocks out the other.
 *
 *  A slot namespaces both keys, so one browser can hold several independent
 *  displays. Mostly a development affordance; harmless in production, and it
 *  changes nothing about auth — the token still decides what a screen sees.
 *
 *  Read from the URL directly rather than through the router so it is settled
 *  on the very first render, before the pairing effect looks for a token. */
function readSlot(): string {
  if (typeof window === "undefined") return "";
  const raw = new URLSearchParams(window.location.search).get("slot") ?? "";
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
}

/** Fast enough that someone clocking in shows up while they are still standing
 *  in front of it, and cheap enough not to matter: one display at 45s is under
 *  2,000 requests a day. It also bounds how long a revoke takes to bite. */
const POLL_MS = 45_000;

/** Pairing polls faster — a human is standing there watching. */
const PAIR_POLL_MS = 3_000;

/** How often to re-ask for a pairing code when the request to open one failed
 *  outright. Slower than the approval poll — nobody is waiting on this yet,
 *  and the pair endpoint has a flood guard that a tight retry would trip. */
const PAIR_RETRY_MS = 15_000;

/** No successful poll in this long means something is wedged in a way the page
 *  cannot fix from the inside, because the thing that would fix it is the
 *  thing that is broken. Reloading the document is the only recovery that does
 *  not involve driving to the shop. */
const WATCHDOG_MS = 10 * 60_000;

/** Past this the age line turns amber: the board is still showing its last
 *  good frame, but you should not trust it. */
const STALE_MS = 3 * 60_000;

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  panelEdge: "#232c38",
  ink: "#e8edf4",
  inkDim: "#97a3b6",
  accent: "#4c8dff",
  good: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  // Five counts need five inks that separate at ten feet. Sky and violet sit
  // clear of the blue/amber/green already in use and both clear 7:1 on the
  // #0d1117 ground.
  cool: "#38bdf8",
  violet: "#a78bfa",
  teal: "#2dd4bf",
  rose: "#fb7185",
};

type DisplayMeta = { id: string; name: string; mode: "PUBLIC" | "PRIVATE"; farViewing: boolean };

type BoardJob = {
  id: string; title: string; client: string | null; place: string;
  status: string; startAt: string | null; crew: string[];
};
type PrivateBoard = {
  mode: "PRIVATE"; generatedAt: string; dateKey: string;
  onTheClock: { id: string; name: string; clockedInAt: string; onBreak: boolean;
    jobs: { id: string; title: string; place: string; status: string }[] }[];
  assignedNotClockedIn: { id: string; name: string; jobs: number }[];
  jobs: BoardJob[];
  vehiclesOut: { id: string; name: string; driver: string; since: string }[];
  equipmentOut: { id: string; name: string; holder: string }[];
  counts: { done: number; inProgress: number; remaining: number; total: number };
  attention: { kind: string; label: string; detail: string }[];
  /** TODAY'S finished work only — not the public wall's trailing week. */
  photos: { id: string; url: string; takenAt: string }[];
  weather: BoardWeather;
};
type PublicBoard = {
  mode: "PUBLIC"; generatedAt: string;
  today: { scheduled: number; inProgress: number; completed: number };
  completed: { today: number; week: number; month: number; quarter: number; year: number };
  photos: { id: string; url: string; takenAt: string }[];
  promotions: {
    id: string; headline: string; body: string | null; url: string | null;
    /** Campaign artwork, cover first. Empty for a text-only promo. */
    photos: { id: string; url: string }[];
    /** The individual services the campaign is selling. */
    items: { id: string; title: string; body: string; photo: { id: string; url: string } | null }[];
  }[];
  company: { name: string | null; phone: string | null; email: string | null; serviceArea: string | null };
  weather: BoardWeather;
};
type BoardWeather = {
  tempF: number; description: string; icon: string;
  highF: number; lowF: number; rainChance: number;
  alerts: { event: string; severity: string }[];
  /** The next few days, today excluded. */
  forecast: { dateKey: string; highF: number; lowF: number; rainChance: number; icon: string }[];
} | null;
type Board = PrivateBoard | PublicBoard;

// ── Orientation ──────────────────────────────────────────────────────────────

/** Branch on ASPECT RATIO, not width. A 1080x1920 portrait kiosk and a
 *  1920x1080 TV both read as "desktop-wide" to conventional width breakpoints,
 *  so width-based CSS would hand them the same layout. */
function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-aspect-ratio: 1/1)");
    const apply = () => setLandscape(mq.matches);
    apply();
    // Re-evaluate rather than detecting once: kiosk browsers sometimes report
    // the pre-rotation viewport on boot, and a panel can be re-hung.
    mq.addEventListener("change", apply);
    window.addEventListener("resize", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);
  return landscape;
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ago(fromIso: string | null, now: number): string {
  if (!fromIso) return "never";
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Wall-clock time in ET, via the canonical helper.
 *
 *  This used to call `toLocaleTimeString("en-US", …)` directly, with no
 *  timeZone — which renders in the DEVICE's zone. On the one surface where
 *  that matters most: a kiosk mini-PC whose clock was never configured (a
 *  fresh Pi defaults to UTC) would have shown every clock-in and every trip
 *  four or five hours off, with nothing on screen to suggest it was wrong.
 *  The business runs on ET; the board says ET regardless of the box it is
 *  plugged into. */
function clockTime(iso: string): string {
  return fmtTimeOpts(iso, { hour: "numeric", minute: "2-digit" });
}

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "Working",
  PAUSED: "Paused",
  COMPLETED: "Done",
  PENDING_PAYMENT: "Done",
  CLOSED: "Done",
};
const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: C.good,
  PAUSED: C.warn,
  COMPLETED: C.inkDim,
  PENDING_PAYMENT: C.inkDim,
  CLOSED: C.inkDim,
  SCHEDULED: C.accent,
};

/** Keyframes for the board.
 *
 *  Injected with `dangerouslySetInnerHTML` rather than as a JSX text child.
 *  React serialises a <style> text node differently on the server and the
 *  client — a double quote comes back as &quot; from the server — so a single
 *  apostrophe anywhere in this CSS raises a hydration mismatch, and Next throws
 *  a full-screen error overlay across the display. That happened; the board was
 *  unreadable until it was found. This form ships the string verbatim and is
 *  immune to it.
 */
const BOARD_CSS = `
        @keyframes wallIn { from { opacity: 0 } to { opacity: 1 } }

        /* A departure-board drop: the notice falls in from above, overshoots,
           bounces back and LOCKS. The overshoot is the whole point — a linear
           slide reads as drifting, and drifting text makes you wait for it.
           This lands, stops dead, and then holds still long enough to read. */
        @keyframes noticeDrop {
          0%   { transform: translateY(-150%); opacity: 0 }
          55%  { transform: translateY(7%);    opacity: 1 }
          72%  { transform: translateY(-3%) }
          86%  { transform: translateY(1%) }
          100% { transform: translateY(0) }
        }
        /* The clunk. Brightens as it seats, then fades to resting, so the
           lock is visible from across the room without anything moving. */
        /* A page turn. Slides up a little as it fades in, so a list that has
           moved on is obviously a NEW page rather than rows that changed
           underneath you. */
        @keyframes pageIn {
          from { opacity: 0; transform: translateY(1.2vmin) }
          to   { opacity: 1; transform: translateY(0) }
        }
        @keyframes noticeLock {
          0%, 50% { filter: brightness(1) }
          60%     { filter: brightness(1.75) }
          100%    { filter: brightness(1) }
        }
        @keyframes kenBurns0 { from { transform: scale(1.02) translate(0, 0) }      to { transform: scale(1.14) translate(-2%, -1.5%) } }
        @keyframes kenBurns1 { from { transform: scale(1.12) translate(1.5%, -1%) } to { transform: scale(1.02) translate(0, 0) } }
        @keyframes kenBurns2 { from { transform: scale(1.02) translate(-1%, 1%) }   to { transform: scale(1.13) translate(1.5%, -1%) } }
        @keyframes kenBurns3 { from { transform: scale(1.1) translate(-1.5%, 1%) }  to { transform: scale(1.03) translate(1%, -0.5%) } }
      
`;

export default function DisplayPage() {
  const landscape = useIsLandscape();
  const now = useNow();

  const [slot, setSlot] = useState("");
  useEffect(() => setSlot(readSlot()), []);
  const TOKEN_KEY = slot ? `${TOKEN_KEY_BASE}:${slot}` : TOKEN_KEY_BASE;
  const DEVICE_SECRET_KEY = slot ? `${DEVICE_SECRET_KEY_BASE}:${slot}` : DEVICE_SECRET_KEY_BASE;

  // The same green/fall mark the app uses. Resolved on the client because the
  // season helper reads localStorage for an admin's override — a wall screen
  // has none, so it follows the natural ET season, which is the right
  // behaviour for a device nobody signs into.
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    try {
      setLogo(getSeasonIcons().icon);
    } catch {
      setLogo(null);
    }
  }, []);

  const [token, setToken] = useState<string | null>(null);
  const [meta, setMeta] = useState<DisplayMeta | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [booted, setBooted] = useState(false);

  const buildRef = useRef<string | null>(null);
  const lastGoodMsRef = useRef<number>(Date.now());

  // ── Pairing ────────────────────────────────────────────────────────────────

  const startPairing = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/public/display/pair`, { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      try {
        localStorage.setItem(DEVICE_SECRET_KEY, data.deviceSecret);
      } catch {}
      setPairing({ code: data.code, expiresAt: data.expiresAt });
    } catch {
      // Network not up yet (common on boot — the device beats the wifi). The
      // retry loop below simply tries again; no error screen, no human needed.
    }
  }, [DEVICE_SECRET_KEY]);

  useEffect(() => {
    let stored: string | null = null;
    let secret: string | null = null;
    try {
      stored = localStorage.getItem(TOKEN_KEY);
      secret = localStorage.getItem(DEVICE_SECRET_KEY);
    } catch {}
    if (stored) {
      setToken(stored);
      setBooted(true);
      return;
    }
    // RESUME an existing request rather than opening another one. Every reload
    // used to mint a fresh pairing row, so a screen that rebooted a few times —
    // or a developer opening the page — left a pile of identical "waiting"
    // entries for the operator to wade through. The device already has its
    // secret; ask about THAT request first and only start over if it is gone.
    (async () => {
      if (secret) {
        try {
          const res = await fetch(`${API_BASE}/api/public/display/pair/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceSecret: secret }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.status === "pending" && data.code) {
              setPairing({ code: data.code, expiresAt: data.expiresAt });
              setBooted(true);
              return;
            }
            if (data.status === "approved" && data.token) {
              try {
                localStorage.setItem(TOKEN_KEY, data.token);
                localStorage.removeItem(DEVICE_SECRET_KEY);
              } catch {}
              setToken(data.token);
              setMeta(data.display ?? null);
              setBooted(true);
              return;
            }
          }
        } catch {}
      }
      await startPairing();
      setBooted(true);
    })();
  }, [startPairing, TOKEN_KEY, DEVICE_SECRET_KEY]);

  // Poll for approval while a code is on screen.
  useEffect(() => {
    if (token || !pairing) return;
    let cancelled = false;
    const tick = async () => {
      let secret: string | null = null;
      try {
        secret = localStorage.getItem(DEVICE_SECRET_KEY);
      } catch {}
      if (!secret) return void startPairing();
      try {
        const res = await fetch(`${API_BASE}/api/public/display/pair/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The DEVICE SECRET, never the six digits. The code is on a wall
          // where anyone can read it; if it were enough to collect the token,
          // a client in the waiting room could pair themselves the moment the
          // real TV was approved.
          body: JSON.stringify({ deviceSecret: secret }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.status === "approved" && data.token) {
          try {
            localStorage.setItem(TOKEN_KEY, data.token);
            localStorage.removeItem(DEVICE_SECRET_KEY);
          } catch {}
          setToken(data.token);
          setMeta(data.display ?? null);
          setPairing(null);
        } else if (data.status === "expired") {
          void startPairing();
        }
      } catch {
        // Keep the code up and keep trying.
      }
    };
    const t = setInterval(tick, PAIR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, pairing, startPairing, TOKEN_KEY, DEVICE_SECRET_KEY]);

  // ── The board ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let failures = 0;

    const fetchBoard = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/public/display/board?token=${encodeURIComponent(token)}`);
        if (cancelled) return;

        if (res.status === 401) {
          // Revoked, or the display was deleted. Clear and drop straight back
          // to a pairing code — it must NOT freeze on the last good frame,
          // which looks identical to a working board.
          try {
            localStorage.removeItem(TOKEN_KEY);
          } catch {}
          setToken(null);
          setBoard(null);
          setMeta(null);
          void startPairing();
          return;
        }
        if (!res.ok) throw new Error(String(res.status));

        const data = await res.json();
        failures = 0;
        lastGoodMsRef.current = Date.now();
        setBoard(data.board);
        setMeta(data.display ?? null);
        setLastGoodAt(data.board?.generatedAt ?? new Date().toISOString());

        // A JS bundle cannot be hot-swapped in place, so a new deploy is one of
        // only two things that earns a document reload. Without it the wall
        // runs whatever shipped the day it was paired, indefinitely.
        if (buildRef.current == null) buildRef.current = data.build ?? null;
        else if (data.build && data.build !== buildRef.current) window.location.reload();
      } catch {
        // Hold the last good data and let the age line tell the truth. One
        // dropped request must never blank the screen.
        failures += 1;
      }
    };

    // Self-scheduling rather than setInterval, so the backoff is simply the
    // next delay rather than a modulo trick that has to be reasoned about.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await fetchBoard();
      if (cancelled) return;
      // Ease off when the network is down so a wedged display does not retry
      // in a tight loop, but never slower than a few minutes — the watchdog
      // is what handles the genuinely stuck case.
      const delay = POLL_MS * Math.min(4, 1 + failures);
      timer = setTimeout(loop, delay);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, startPairing, TOKEN_KEY]);

  // Watchdog. The last resort, and the only case besides a new build where a
  // document reload is the right tool.
  //
  // ONLY WHILE PAIRED. It used to run unconditionally, and `lastGoodMsRef` is
  // only ever touched by a successful BOARD fetch — which an unpaired screen
  // never makes. So a screen sitting on a pairing code, or one that had just
  // been revoked, tripped the watchdog ten minutes in and then reloaded itself
  // every sixty seconds, all night, flashing the code at whoever walked past.
  // A screen waiting to be paired is not wedged; it is waiting.
  useEffect(() => {
    if (!token) return;
    // Start the clock when pairing completes rather than at mount, so time
    // spent showing a code is not counted against the first board fetch.
    lastGoodMsRef.current = Date.now();
    const t = setInterval(() => {
      if (Date.now() - lastGoodMsRef.current > WATCHDOG_MS) window.location.reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [token]);

  // KEEP ASKING FOR A CODE until we get one.
  //
  // `startPairing` swallows a network failure on purpose — a device commonly
  // beats the wifi up on boot — and its comment promised "the retry loop below
  // simply tries again". There was no such loop. The approval poll only runs
  // once a code EXISTS, so a display that booted before the network (or hit
  // the pair endpoint's flood guard) rendered "— — —" and sat there until the
  // watchdog reloaded the document ten minutes later. On the one screen that
  // is supposed to recover unattended, that was the longest outage on it.
  useEffect(() => {
    if (!booted || token || pairing) return;
    const t = setInterval(() => void startPairing(), PAIR_RETRY_MS);
    return () => clearInterval(t);
  }, [booted, token, pairing, startPairing]);

  const staleness = useMemo(() => {
    if (!lastGoodAt) return { label: "waiting…", color: C.inkDim };
    const age = now - new Date(lastGoodAt).getTime();
    return {
      label: `updated ${ago(lastGoodAt, now)}`,
      color: age > STALE_MS ? C.warn : C.inkDim,
    };
  }, [lastGoodAt, now]);

  // Type scale. Distance is the one thing the page cannot detect for itself,
  // so it comes from the Display record.
  const scale = meta?.farViewing === false ? 0.72 : 1;

  return (
    <>
      <Head>
        <title>Seedlings Display</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {/* Motion lives here rather than inline because keyframes cannot be
          expressed as a style object. Four pan directions, so neighbouring
          tiles never drift the same way — a grid moving in unison reads as the
          whole page sliding, which is worse than no motion at all.

          The scale never drops below 1: at 1.0 exactly, a sub-pixel rounding
          error shows the panel colour at the edge as a hairline flicker. */}
      <style dangerouslySetInnerHTML={{ __html: BOARD_CSS }} />
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: C.bg,
          color: C.ink,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          // Overscan safe area: some TVs still crop 3-5% off every edge, and
          // the thing you lose first is whatever sits at the bottom — here,
          // the age line that tells you the board is alive.
          padding: "2.5vmin 3vmin",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {!booted ? null : !token ? (
          <Pairing code={pairing?.code ?? null} scale={scale} logo={logo} slot={slot} />
        ) : board?.mode === "PRIVATE" ? (
          <PrivateView board={board} landscape={landscape} scale={scale} now={now} token={token} />
        ) : board?.mode === "PUBLIC" ? (
          <PublicView board={board} landscape={landscape} scale={scale} logo={logo} token={token} />
        ) : (
          // Paired but the first payload has not landed. Deliberately quiet —
          // no spinner, because a wall board should never show a loading state.
          <div style={{ margin: "auto", color: C.inkDim, fontSize: `${2.4 * scale}vmin` }}>
            {meta?.name ?? "Display"}
          </div>
        )}

        <div
          style={{
            marginTop: "auto",
            paddingTop: "1.4vmin",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontSize: `${1.5 * scale}vmin`,
            color: staleness.color,
            flexShrink: 0,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "0.8vmin" }}>
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" style={{ height: `${2.2 * scale}vmin`, width: "auto", opacity: 0.85 }} />
            ) : null}
            {meta?.name ?? ""}
          </span>
          <span>{staleness.label}</span>
        </div>
      </div>
    </>
  );
}

// ── Pairing screen ───────────────────────────────────────────────────────────

function Pairing({ code, scale, logo, slot }: { code: string | null; scale: number; logo: string | null; slot: string }) {
  return (
    <div style={{ margin: "auto", textAlign: "center" }}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" style={{ height: `${9 * scale}vmin`, width: "auto", marginBottom: "3vmin" }} />
      ) : null}
      <div style={{ fontSize: `${2.2 * scale}vmin`, color: C.inkDim, marginBottom: "2vmin" }}>
        Enter this code in the Seedlings app
      </div>
      <div
        style={{
          fontSize: `${14 * scale}vmin`,
          fontWeight: 700,
          letterSpacing: "1.2vmin",
          fontVariantNumeric: "tabular-nums",
          color: C.ink,
        }}
      >
        {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "— — —"}
      </div>
      <div style={{ fontSize: `${1.8 * scale}vmin`, color: C.inkDim, marginTop: "2vmin" }}>
        Super → System → Displays
      </div>
      {slot ? (
        <div style={{ fontSize: `${1.5 * scale}vmin`, color: C.inkDim, marginTop: "1.2vmin", opacity: 0.8 }}>
          slot: {slot}
        </div>
      ) : null}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Panel({
  children, title, flex, centerContent,
}: {
  children: React.ReactNode; title?: string; flex?: string;
  /** Vertically centre the content under the title when the panel is taller
   *  than it needs to be. For panels told to GROW: without it the content
   *  clings to the top and the leftover height reads as a hole inside a
   *  bordered box, which is worse than the gap it was meant to remove. */
  centerContent?: boolean;
}) {
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.panelEdge}`,
        borderRadius: "1.2vmin",
        padding: "1.6vmin 1.8vmin",
        // A PANEL NEVER SHRINKS BELOW ITS CONTENT UNLESS ASKED TO.
        //
        // The CSS default for a flex child is `0 1 auto` — it may be squeezed
        // — and every panel here clips at its edge, so a squeeze does not
        // reflow anything, it slices a number in half. On a 1080x1920 kiosk,
        // where these stack into one tall column, that is exactly what
        // happened: the weather panel came out shorter than the temperature
        // inside it and rendered the top half of "58°".
        //
        // Panels that are MEANT to absorb or give up space say so — the photo
        // wall is `2`, the counts are `1 0 auto`. Everything else holds its
        // size, and the wall is what flexes around them.
        flex: flex ?? "0 0 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {title ? (
        <div
          style={{
            fontSize: "1.5vmin",
            letterSpacing: "0.25vmin",
            textTransform: "uppercase",
            color: C.inkDim,
            marginBottom: "1.2vmin",
            flexShrink: 0,
          }}
        >
          {title}
        </div>
      ) : null}
      {centerContent ? (
        <div style={{ margin: "auto 0", width: "100%", minHeight: 0 }}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}



/** How long a page of an overflowing list holds before the next one. Slower
 *  than the notice strip: these are multi-row lists and you read down them. */
const PAGE_HOLD_MS = 9_000;

/** Page through a list that does not fit.
 *
 *  A truncated list on a wall is a list whose tail NOBODY EVER SEES — and
 *  "+4 more" is worse than useless on a screen no one can touch, because it
 *  tells you something is missing and gives you no way to reach it.
 *
 *  A list that fits does not move. Only overflow rotates, which keeps the
 *  common case perfectly still.
 */
function usePagedItems<T>(items: T[], perPage: number): { page: T[]; index: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const [index, setIndex] = useState(0);

  // Keyed on the COUNT, not the array. The board refetches every 45 seconds
  // and hands back a fresh array each time; resetting on identity would send
  // every list back to page one before it ever reached page two.
  useEffect(() => {
    setIndex(0);
    if (pages <= 1) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % pages), PAGE_HOLD_MS);
    return () => clearInterval(t);
  }, [pages]);

  const safe = Math.min(index, pages - 1);
  return { page: items.slice(safe * perPage, safe * perPage + perPage), index: safe, pages };
}

/** The page counter, shown only when there is more than one page. */
function PageDots({ index, pages, scale }: { index: number; pages: number; scale: number }) {
  if (pages <= 1) return null;
  return (
    <div style={{ marginTop: "auto", paddingTop: "0.8vmin", fontSize: `${1.5 * scale}vmin`, color: C.inkDim, opacity: 0.75 }}>
      {index + 1} / {pages}
    </div>
  );
}

// ── The notice strip ─────────────────────────────────────────────────────────

/** How long each notice holds before the next drops in. Long enough to read a
 *  line twice from across a shop. */
const NOTICE_HOLD_MS = 8_000;

type Notice = { key: string; label: string; detail: string; tone: string };

/** Everything worth interrupting someone for, in one place: severe weather,
 *  rain that will decide the afternoon, and the exception queue.
 *
 *  Ordered by what changes a decision soonest — a tornado warning outranks an
 *  unclaimed visit — because with one item on screen at a time, order IS
 *  priority for anyone who only glances once. */
function buildNotices(board: PrivateBoard): Notice[] {
  const out: Notice[] = [];
  const w = board.weather;

  for (const a of w?.alerts ?? []) {
    out.push({ key: `wx-${a.event}`, label: a.event, detail: "active now", tone: C.bad });
  }
  // Rain is not an alert, but in lawn care it decides whether the afternoon
  // happens, which is exactly what this strip is for.
  if (w && w.rainChance >= 50) {
    out.push({
      key: "wx-rain",
      label: `${w.rainChance}% rain`,
      detail: "expect the day to move",
      tone: C.warn,
    });
  }
  for (const a of board.attention) {
    out.push({
      key: a.kind,
      label: a.label,
      detail: a.detail,
      tone: a.kind === "overdue" ? C.bad : C.warn,
    });
  }
  return out;
}

function NoticeBoard({ notices, scale }: { notices: Notice[]; scale: number }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    // Nothing to cycle through: one notice just sits there. Rotating a list of
    // one would animate the same line over and over for no reason.
    if (notices.length <= 1) {
      setI(0);
      return;
    }
    const t = setInterval(() => setI((n) => (n + 1) % notices.length), NOTICE_HOLD_MS);
    return () => clearInterval(t);
  }, [notices.length]);

  // Blank most days, and that is the point: a strip that is empty when nothing
  // is wrong is one people actually look at when it lights up.
  if (notices.length === 0) return null;

  const n = notices[Math.min(i, notices.length - 1)];

  return (
    <div
      style={{
        // Clips the drop, so the incoming notice appears from above the strip
        // rather than sliding across whatever is beside it.
        overflow: "hidden",
        borderRadius: "1.2vmin",
        border: `1px solid ${n.tone}`,
        background: "#1a1414",
        flexShrink: 0,
      }}
    >
      <div
        // Keyed on the notice so React remounts it and the animation replays.
        key={n.key + i}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "1.6vmin",
          padding: "1.2vmin 1.8vmin",
          animation: "noticeDrop 900ms cubic-bezier(.2,.9,.25,1) both, noticeLock 900ms ease-out both",
        }}
      >
        <span style={{ fontSize: `${2.6 * scale}vmin`, fontWeight: 700, color: n.tone }}>{n.label}</span>
        <span style={{ fontSize: `${1.9 * scale}vmin`, color: C.inkDim }}>{n.detail}</span>
        {notices.length > 1 ? (
          <span style={{ marginLeft: "auto", fontSize: `${1.6 * scale}vmin`, color: C.inkDim, opacity: 0.7 }}>
            {i + 1} / {notices.length}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Private (back office) ────────────────────────────────────────────────────

function PrivateView({
  board, landscape, scale, now, token,
}: { board: PrivateBoard; landscape: boolean; scale: number; now: number; token: string | null }) {
  // Everything that can overflow pages itself, so no row is permanently
  // invisible on a screen nobody can scroll.
  const clockPage = usePagedItems(board.onTheClock, landscape ? 7 : 9);
  const jobsPage = usePagedItems(board.jobs, landscape ? 8 : 12);
  const outItems = [
    ...board.vehiclesOut.map((v) => ({ kind: "vehicle" as const, ...v })),
    ...board.equipmentOut.map((e) => ({ kind: "equipment" as const, ...e })),
  ];
  const outPage = usePagedItems(outItems, 6);

  /* TODAY'S WORK, AS PICTURES. Deliberately a strip and not the public wall:
     this panel answers "what has the crew actually done today" in one glance,
     and anything taller would start competing with the job list for the eye.
     Absent entirely until there is something to show — an empty row of
     placeholder squares on a back-office board reads as the photos having
     failed to load.

     Tile COUNT is what sets tile size here, since the row is full-width and
     each tile is a fixed 4:3. Eight across a 16:9 board lands each one near a
     sixth of the screen's width, which is enough to recognise a property from
     a desk; more than that and they go back to being postage stamps. */
  const todayPhotos =
    board.photos.length > 0 ? (
      <Panel title={`Today's photos · ${board.photos.length}`} flex="0 0 auto">
        <PhotoStrip photos={board.photos} token={token} tiles={landscape ? 8 : 5} />
      </Panel>
    ) : null;
  const clock = (
    <Panel title={`On the clock · ${board.onTheClock.length}`} flex={landscape ? "2" : "1"}>
      {board.onTheClock.length === 0 ? (
        <Empty scale={scale}>Nobody is clocked in</Empty>
      ) : (
        <div
          key={`clock-${clockPage.index}`}
          style={{ display: "flex", flexDirection: "column", gap: "1.2vmin", overflow: "hidden", animation: "pageIn 500ms ease-out both" }}
        >
          {clockPage.page.map((w) => (
            <div key={w.id} style={{ display: "flex", alignItems: "baseline", gap: "1.4vmin" }}>
              <span style={{ fontSize: `${3.1 * scale}vmin`, fontWeight: 600, minWidth: "26%" }}>
                {w.name}
              </span>
              <span style={{ fontSize: `${2.1 * scale}vmin`, color: w.onBreak ? C.warn : C.inkDim }}>
                {w.onBreak ? "on break" : `since ${clockTime(w.clockedInAt)}`}
              </span>
              <span
                style={{
                  fontSize: `${2.1 * scale}vmin`,
                  color: C.ink,
                  marginLeft: "auto",
                  textAlign: "right",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {w.jobs[0] ? `${w.jobs[0].title}${w.jobs[0].place ? ` · ${w.jobs[0].place}` : ""}` : "—"}
                {w.jobs.length > 1 ? `  +${w.jobs.length - 1}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      <PageDots index={clockPage.index} pages={clockPage.pages} scale={scale} />
    </Panel>
  );

  const today = (
    <Panel title={`Today · ${board.counts.total}`} flex="1">
      <div style={{ display: "flex", gap: "2vmin", alignItems: "baseline" }}>
        <Stat label="done" value={board.counts.done} color={C.good} scale={scale} />
        <Stat label="working" value={board.counts.inProgress} color={C.accent} scale={scale} />
        <Stat label="to go" value={board.counts.remaining} color={C.ink} scale={scale} />
      </div>
    </Panel>
  );

  const outNow = (
    <Panel title={`Out now · ${outItems.length}`} flex="1">
      {outItems.length === 0 ? (
        <Empty scale={scale}>Nothing signed out</Empty>
      ) : (
        <>
          <div
            key={`out-${outPage.index}`}
            style={{ display: "flex", flexDirection: "column", gap: "0.9vmin", overflow: "hidden", animation: "pageIn 500ms ease-out both" }}
          >
            {outPage.page.map((item) => (
              <div key={item.id} style={{ display: "flex", alignItems: "baseline", gap: "1.2vmin" }}>
                <span
                  style={{
                    fontSize: `${(item.kind === "vehicle" ? 2.2 : 1.9) * scale}vmin`,
                    fontWeight: item.kind === "vehicle" ? 600 : 400,
                    color: C.ink,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.name}
                </span>
                <span
                  style={{
                    fontSize: `${1.8 * scale}vmin`,
                    color: C.inkDim,
                    marginLeft: "auto",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.kind === "vehicle" ? `${item.driver} · ${clockTime(item.since)}` : item.holder}
                </span>
              </div>
            ))}
          </div>
          <PageDots index={outPage.index} pages={outPage.pages} scale={scale} />
        </>
      )}
    </Panel>
  );

  const jobs = (
    <Panel title="Jobs" flex={landscape ? "3" : "2"}>
      {board.jobs.length === 0 ? (
        <Empty scale={scale}>Nothing scheduled today</Empty>
      ) : (
        <div
          key={`jobs-${jobsPage.index}`}
          style={{ display: "flex", flexDirection: "column", gap: "0.9vmin", overflow: "hidden", animation: "pageIn 500ms ease-out both" }}
        >
          {jobsPage.page.map((j) => (
            <div key={j.id} style={{ display: "flex", alignItems: "baseline", gap: "1.2vmin" }}>
              <span
                style={{
                  fontSize: `${1.6 * scale}vmin`,
                  color: STATUS_COLOR[j.status] ?? C.inkDim,
                  minWidth: "9%",
                  textTransform: "uppercase",
                  letterSpacing: "0.1vmin",
                }}
              >
                {STATUS_LABEL[j.status] ?? j.status}
              </span>
              <span style={{ fontSize: `${2.2 * scale}vmin`, fontWeight: 600 }}>{j.title}</span>
              <span style={{ fontSize: `${2 * scale}vmin`, color: C.inkDim }}>{j.place}</span>
              <span
                style={{
                  fontSize: `${2 * scale}vmin`,
                  color: C.inkDim,
                  marginLeft: "auto",
                  whiteSpace: "nowrap",
                }}
              >
                {j.crew.length ? j.crew.join(", ") : "unclaimed"}
              </span>
            </div>
          ))}
        </div>
      )}
      <PageDots index={jobsPage.index} pages={jobsPage.pages} scale={scale} />
    </Panel>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.6vmin", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          flexDirection: landscape ? "row" : "column",
          gap: "1.6vmin",
          flex: 1,
          minHeight: 0,
        }}
      >
        {landscape ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: "1.6vmin", flex: 2, minHeight: 0 }}>
              {clock}
              {jobs}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1.6vmin", flex: 1, minHeight: 0 }}>
              {today}
              {/* The Today panel held three counts and a lot of dead space.
                  What is signed out RIGHT NOW moves through the day the same
                  way the counts do, so it earns the room rather than padding
                  it with something static. */}
              {outNow}
              <Weather w={board.weather} scale={scale} />
            </div>
          </>
        ) : (
          <>
            {today}
            {outNow}
            <Weather w={board.weather} scale={scale} />
            {clock}
            {jobs}
          </>
        )}
      </div>

      {/* ITS OWN FULL-WIDTH ROW, not a tile in the side column. Squeezed into
          a third of the board the thumbnails came out too small to read as
          photographs at all — which defeats the point of showing them. Across
          the whole width the same short strip gets each image roughly four
          times the area for a couple of vmin of extra height. */}
      {todayPhotos}

      {/* One notice at a time, dropping into place and locking. Severe weather,
          rain that will move the day, and the exception queue all share this
          strip — they are the things worth interrupting someone for, and with
          one line on screen the ORDER is the priority. */}
      <NoticeBoard notices={buildNotices(board)} scale={scale} />
    </div>
  );
}

/** In lawn care weather is operational, not decoration — it decides whether the
 *  afternoon happens — so it gets a real panel rather than a corner note. */
function Weather({ w, scale }: { w: BoardWeather; scale: number }) {
  if (!w) return null;
  const severe = w.alerts.length > 0;
  return (
    <Panel title="Weather" flex="1 0 auto" centerContent>
      {/* CENTRE, not baseline. Baseline puts the big temperature's baseline on
          the FIRST of the two text lines, so the second line hangs below it
          and the pair reads as having slipped down the panel. The conditions
          are one block and belong centred against the number. */}
      <div style={{ display: "flex", alignItems: "center", gap: "1.6vmin", flexWrap: "nowrap" }}>
        <span style={{ fontSize: `${7 * scale}vmin`, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>
          {w.tempF}°
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: `${2.1 * scale}vmin`,
              textTransform: "capitalize",
              lineHeight: 1.25,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {w.description}
          </div>
          <div style={{ fontSize: `${1.8 * scale}vmin`, color: C.inkDim, lineHeight: 1.25, whiteSpace: "nowrap" }}>
            {w.highF}° / {w.lowF}°{w.rainChance > 0 ? ` · ${w.rainChance}% rain` : ""}
          </div>
        </div>
      </div>
      {/* THE NEXT FEW DAYS. In lawn care the forecast is not decoration — it
          decides whether Thursday happens — and it is the question a client
          sitting in the waiting room is most likely to be turning over. It
          also fills the column: with the promo moved out from under it, this
          side of the board had a dead strip where nothing grew.

          The weekday is formatted HERE, from the date key, through the app's
          ET-anchored formatter. A label the server rendered would be the
          server's idea of the day, and this page already had one bug where a
          box in the wrong timezone reported everything hours out. */}
      {w.forecast.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${w.forecast.length}, minmax(0, 1fr))`,
            gap: "1.2vmin",
            marginTop: "1.4vmin",
            paddingTop: "1.4vmin",
            borderTop: `1px solid ${C.panelEdge}`,
          }}
        >
          {w.forecast.map((d) => (
            <div key={d.dateKey} style={{ minWidth: 0 }}>
              <div style={{ fontSize: `${1.5 * scale}vmin`, color: C.inkDim, whiteSpace: "nowrap" }}>
                {fmtDateOpts(d.dateKey, { weekday: "short" })}
              </div>
              <div
                style={{
                  fontSize: `${2.2 * scale}vmin`,
                  fontWeight: 700,
                  marginTop: "0.4vmin",
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {d.highF}°
                <span style={{ color: C.inkDim, fontWeight: 400 }}> / {d.lowF}°</span>
              </div>
              {/* Shown only when it is worth planning around. A row of "0%
                  rain" under three dry days is three columns of noise. */}
              {d.rainChance >= 30 ? (
                <div style={{ fontSize: `${1.5 * scale}vmin`, color: C.cool, whiteSpace: "nowrap" }}>
                  {d.rainChance}% rain
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {severe ? (
        <div
          style={{
            marginTop: "1.2vmin",
            padding: "0.8vmin 1.2vmin",
            borderRadius: "0.8vmin",
            background: "#2a1a1a",
            border: `1px solid ${C.bad}`,
            fontSize: `${1.9 * scale}vmin`,
            color: C.bad,
            fontWeight: 600,
          }}
        >
          {w.alerts.map((a) => a.event).join(" · ")}
        </div>
      ) : null}
    </Panel>
  );
}

/** A row of counts that SHRINKS rather than wraps.
 *
 *  These rows are read from across a room, so their meaning comes from the
 *  numbers sitting side by side at a glance. Wrapping breaks that: "this year"
 *  dropping onto a line of its own reads as a separate, lesser statistic, and
 *  it happened as soon as the counts reached three digits.
 *
 *  So the row is a fixed N-column grid that never wraps, and the type is
 *  capped against the row's OWN width in container units — `min(design,
 *  fits)`. At normal counts nothing changes; when the digits would overflow,
 *  every cell in the row steps down together and they stay on one line.
 *
 *  Sized rather than measured. A ResizeObserver would be exact, but this runs
 *  unattended for months on a screen nobody reloads, and arithmetic over a
 *  known column count cannot get wedged. */
const DIGIT_EM = 0.62; // advance of one tabular digit in this face
const LABEL_EM = 0.52; // rough average glyph advance for the lowercase labels

function statFit(count: number, cells: { value: number; label: string }[]) {
  // Usable share of the row for one cell, as a percentage of the row's width.
  const share = (100 / count) * 0.9;
  const digits = Math.max(...cells.map((c) => String(c.value).length));
  const chars = Math.max(...cells.map((c) => c.label.length));
  return {
    valueCqi: share / (digits * DIGIT_EM),
    labelCqi: share / (chars * LABEL_EM),
  };
}

function Stat({
  label, value, color, scale, size = 7, fit,
}: {
  label: string; value: number; color: string; scale: number; size?: number;
  /** Caps from `statFit`. Omitted, the stat sizes purely on the design scale. */
  fit?: { valueCqi: number; labelCqi: number };
}) {
  const labelSize = Math.max(1.4, size * 0.24) * scale;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: fit
            ? `min(${size * scale}vmin, ${fit.valueCqi.toFixed(2)}cqi)`
            : `${size * scale}vmin`,
          fontWeight: 700,
          color,
          lineHeight: 1,
          whiteSpace: "nowrap",
          // Digits on a wall shift the label under them as the count ticks
          // over unless they share a width.
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: fit ? `min(${labelSize}vmin, ${fit.labelCqi.toFixed(2)}cqi)` : `${labelSize}vmin`,
          color: C.inkDim,
          marginTop: "0.6vmin",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function Empty({ children, scale }: { children: React.ReactNode; scale: number }) {
  return (
    <div style={{ color: C.inkDim, fontSize: `${2.2 * scale}vmin`, margin: "auto 0" }}>{children}</div>
  );
}


// ── The photo wall ───────────────────────────────────────────────────────────

/** How often ONE tile turns over. Tiles rotate round-robin rather than all at
 *  once: a whole-grid flip reads as a page change and pulls the eye, which is
 *  the opposite of what ambient content should do. */
const TILE_ROTATE_MS = 7_000;

/** A photo wall that never sits still.
 *
 *  Two kinds of motion, both local — NO extra requests. The board payload
 *  already carries the pool, and the app does not poll:
 *
 *   1. Each tile drifts and slowly zooms (a Ken Burns pan), with a different
 *      duration and direction per tile so they never move in lockstep.
 *   2. One tile at a time crossfades to the next photo in the pool.
 *
 *  The drift also happens to be the right answer for burn-in: a static bright
 *  panel is the shape that ghosts, and nothing here is static.
 */
/** How long each SLIDE holds.
 *
 *  Two speeds, because the two slides do different jobs. The overview is the
 *  only thing on this board a client is meant to READ — a headline and a
 *  couple of sentences — and rotating it at photo speed means nobody ever
 *  finishes one. An image slide is looked at, not read, so it moves sooner. */
const PROMO_TEXT_HOLD_MS = 11_000;
const PROMO_IMAGE_HOLD_MS = 7_000;

type PromoSlide = {
  key: string;
  headline: string;
  body: string | null;
  /** null on the campaign's opening slide — that one is the description on
   *  its own, the way the panel looked before there was any artwork. */
  photo: { id: string; url: string } | null;
};

/** The waiting-room promo panel.
 *
 *  Each campaign leads with its DESCRIPTION alone, then walks its artwork one
 *  image at a time, then hands over to the next campaign and eventually starts
 *  again. Opening on the text matters: someone glancing up mid-cycle sees a
 *  photograph, and the only thing that tells them what it is selling is the
 *  slide that came before it — so that slide has to come first and has to come
 *  back around.
 *
 *  It used to render `promotions[0]` and nothing else, so the second and third
 *  campaigns an operator had written were invisible on the one screen a client
 *  actually sits and studies, and the images uploaded against them never
 *  appeared anywhere but an invoice.
 *
 *  A campaign with no artwork is not skipped — it simply has one slide. Plenty
 *  are text-only, and dropping them would make "add a picture" the price of
 *  being on the wall at all. */
function PromoRotator({
  promos, token, scale,
}: {
  promos: {
    id: string; headline: string; body: string | null;
    photos: { id: string; url: string }[];
    items: { id: string; title: string; body: string; photo: { id: string; url: string } | null }[];
  }[];
  token: string | null;
  scale: number;
}) {
  const [i, setI] = useState(0);
  const [dead, setDead] = useState<Set<string>>(() => new Set());

  const slides = useMemo<PromoSlide[]>(() => {
    const out: PromoSlide[] = [];
    for (const p of promos) {
      // A CAMPAIGN WITH NOTHING ITEMISED SAYS ITS PIECE ONCE.
      //
      // Not a text slide followed by a slide per cover photo — that is three
      // turns of the same sentence, which is the repetition this whole change
      // exists to remove. One offer, one slide, with a picture on it.
      if (p.items.length === 0) {
        const cover = p.photos.find((ph) => !dead.has(ph.id)) ?? null;
        out.push({ key: `${p.id}:solo`, headline: p.headline, body: p.body, photo: cover });
        continue;
      }

      // Otherwise: the campaign in its own words first, as the cover…
      out.push({ key: `${p.id}:text`, headline: p.headline, body: p.body, photo: null });

      // …then the SERVICES, one at a time, each with ITS OWN title and words.
      //
      // The board used to page through the campaign's invoice artwork while
      // repeating the campaign headline on every slide, so a promotion
      // advertising four different services showed one sentence twice and
      // called it a rotation. The offers were in the landing page's items the
      // whole time; the board was looking at the cover art.
      for (const it of p.items) {
        // A dead image costs the picture, not the offer — the words still
        // stand on their own.
        const photo = it.photo && !dead.has(it.photo.id) ? it.photo : null;
        out.push({ key: `${p.id}:${it.id}`, headline: it.title, body: it.body, photo });
      }
    }
    return out;
  }, [promos, dead]);

  // Keyed on the COUNT. The board is refetched every 45s and hands back fresh
  // objects; keying on the array would restart the cycle on every poll and the
  // wall would never get past the first campaign's opening slide.
  useEffect(() => setI(0), [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const hold = slides[Math.min(i, slides.length - 1)]?.photo
      ? PROMO_IMAGE_HOLD_MS
      : PROMO_TEXT_HOLD_MS;
    const t = setTimeout(() => setI((n) => (n + 1) % slides.length), hold);
    return () => clearTimeout(t);
  }, [i, slides]);

  if (slides.length === 0) return null;
  const s = slides[Math.min(i, slides.length - 1)];

  return (
    <div
      // Keyed on the slide so React remounts and the entry animation replays.
      // Without it the text swaps in place under a new photo, which reads as a
      // rendering fault rather than a change of subject.
      key={s.key}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "2vmin",
        // A FIXED BAND. Sizing this by the artwork's aspect ratio is what
        // broke the panel in the side column: the image grew to the container
        // width, went taller than the box, and clipped the words out. Here the
        // band's height is the constant and the image is sized from it.
        height: "20vmin",
        animation: "wallIn 700ms ease-out",
      }}
    >
      {s.photo ? (
        <div
          style={{
            height: "100%",
            aspectRatio: "4 / 3",
            flexShrink: 0,
            borderRadius: "0.8vmin",
            overflow: "hidden",
            background: "#0d1117",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${s.photo.url}?token=${encodeURIComponent(token ?? "")}`}
            alt=""
            onError={() => {
              const id = s.photo!.id;
              setDead((prev) => new Set(prev).add(id));
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </div>
      ) : null}

      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: "0.8vmin" }}>
        <div style={{ fontSize: `${3 * scale}vmin`, fontWeight: 700, color: C.accent }}>
          {s.headline}
        </div>
        {s.body ? (
          <div
            style={{
              fontSize: `${2 * scale}vmin`,
              color: C.inkDim,
              lineHeight: 1.35,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {s.body}
          </div>
        ) : null}
      </div>

      {slides.length > 1 ? (
        <div
          style={{
            alignSelf: "flex-end",
            flexShrink: 0,
            fontSize: `${1.5 * scale}vmin`,
            color: C.inkDim,
            opacity: 0.75,
          }}
        >
          {i + 1} / {slides.length}
        </div>
      ) : null}
    </div>
  );
}

/** The private board's photo strip.
 *
 *  A short row of 4:3 tiles, fixed height, one crossfading at a time. It is
 *  NOT the public PhotoWall shrunk: no Ken Burns drift, because at this size a
 *  slow pan just looks like the image is wobbling, and the back-office board
 *  already has motion it wants the eye to catch — the notice strip and the job
 *  statuses.
 *
 *  Same dead-URL handling as the wall. A photo can be hidden or its visit
 *  reopened between polls, and a tile pointed at a 404 is a hole in the row. */
function PhotoStrip({
  photos, token, tiles,
}: {
  photos: { id: string; url: string }[];
  token: string | null;
  tiles: number;
}) {
  const srcOf = useCallback(
    (p: { url: string }) => `${p.url}?token=${encodeURIComponent(token ?? "")}`,
    [token],
  );
  // Never more tiles than photos — a repeated image side by side reads as a
  // rendering fault rather than a short day.
  const tileCount = Math.max(1, Math.min(tiles, photos.length));
  const [slots, setSlots] = useState<number[]>(() => Array.from({ length: tileCount }, (_, i) => i));
  const [dead, setDead] = useState<Set<string>>(() => new Set());

  useEffect(() => setDead(new Set()), [photos]);
  useEffect(() => {
    setSlots(Array.from({ length: tileCount }, (_, i) => i));
  }, [tileCount, photos.length]);

  // The interval reads these through refs so that neither a re-fetch nor a
  // newly-dead photo is a DEPENDENCY of the effect below.
  const photosRef = useRef(photos);
  const deadRef = useRef(dead);
  photosRef.current = photos;
  deadRef.current = dead;
  /** Survives effect restarts on purpose — see below. */
  const tickRef = useRef(0);

  useEffect(() => {
    if (photos.length <= tileCount) return; // nothing to rotate to

    // KEYED ON COUNT, NOT ARRAY IDENTITY, and the cursor lives in a ref.
    //
    // `photos` is a fresh array on every 45s board poll, so depending on it
    // tore down and rebuilt this interval every 45 seconds — which reset a
    // local `tick` to 0 each time. At 7s a tick that is only ~6 rotations per
    // poll, always starting at slot 0, so with 8 tiles slots 6 and 7 would
    // never have come up and two of the eight would have sat frozen all day.
    const t = setInterval(() => {
      const pool = photosRef.current;
      const gone = deadRef.current;
      if (pool.length === 0) return;
      setSlots((prev) => {
        const slot = tickRef.current % prev.length;
        tickRef.current += 1;
        const shown = new Set(prev);
        // Walk forward to the next photo nobody is showing, so the strip works
        // through the pool rather than flipping between the same few.
        let next = (prev[slot] + prev.length) % pool.length;
        for (let guard = 0; guard < pool.length; guard++) {
          if (!shown.has(next) && !gone.has(pool[next]?.id)) break;
          next = (next + 1) % pool.length;
        }
        // Exhausted: everything is either on screen or failed to load. Hold
        // the tile rather than duplicating a neighbour — the same picture
        // twice reads as a bug, a tile that holds does not.
        if (shown.has(next) || gone.has(pool[next]?.id)) return prev;
        const copy = [...prev];
        copy[slot] = next;
        return copy;
      });
    }, TILE_ROTATE_MS);
    return () => clearInterval(t);
  }, [photos.length, tileCount]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${tileCount}, minmax(0, 1fr))`,
        gap: "0.8vmin",
        flexShrink: 0,
      }}
    >
      {slots.map((photoIdx, i) => {
        const p = photos[photoIdx];
        if (!p) return null;
        return (
          <div
            key={i}
            style={{
              position: "relative",
              // 4:3 rather than square. Job photos are shot landscape, so a
              // square crop threw away a third of every frame — and it was the
              // sides, which is where the property is.
              aspectRatio: "4 / 3",
              borderRadius: "0.6vmin",
              overflow: "hidden",
              background: "#0d1117",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={p.id}
              src={srcOf(p)}
              alt=""
              onError={() => setDead((prev) => new Set(prev).add(p.id))}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                animation: "wallIn 900ms ease-out",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function PhotoWall({
  photos, token, cols, tiles,
}: {
  photos: { id: string; url: string }[];
  token: string | null;
  cols: number;
  tiles: number;
}) {
  const srcOf = useCallback(
    (p: { url: string }) => `${p.url}?token=${encodeURIComponent(token ?? "")}`,
    [token],
  );

  // NEVER MORE TILES THAN PHOTOS. `i % photos.length` wrapped, so four photos
  // in six tiles laid out as [0,1,2,3,0,1] — the same two lawns side by side,
  // which reads as a rendering fault rather than a small library. Fewer, larger
  // tiles is the honest answer when there is little to show.
  const tileCount = Math.max(1, Math.min(tiles, photos.length));

  const [slots, setSlots] = useState<number[]>(() =>
    Array.from({ length: tileCount }, (_, i) => i),
  );

  /** Photos whose image would not load. A photo can be hidden, deleted, or its
   *  visit reopened between one poll and the next — the board corrects itself
   *  on the following fetch, but until then a tile pointed at a dead URL is a
   *  hole in the wall. Remembering the failures lets rotation route around
   *  them immediately instead of parking on one. */
  const [dead, setDead] = useState<Set<string>>(() => new Set());

  // Forget them when the pool changes, so a photo that comes back (unhidden,
  // or a transient network blip) is given another chance rather than being
  // written off for the life of the page.
  useEffect(() => setDead(new Set()), [photos]);

  useEffect(() => {
    setSlots(Array.from({ length: tileCount }, (_, i) => i));
  }, [tileCount]);

  // Read through refs so neither a re-fetch nor a newly-dead photo is a
  // DEPENDENCY of the rotation effect. See the comment on its deps below.
  const poolRef = useRef(photos);
  const goneRef = useRef(dead);
  poolRef.current = photos;
  goneRef.current = dead;
  /** Survives effect restarts on purpose. */
  const tickRef = useRef(0);

  useEffect(() => {
    // Nothing to rotate through — leave the grid alone rather than shuffling
    // the same six pictures around, which reads as a glitch.
    if (photos.length <= tileCount) return;
    let cancelled = false;

    // KEYED ON COUNT, NOT ARRAY IDENTITY, with the cursor in a ref.
    //
    // `photos` is a fresh array on every 45s board poll, so depending on it
    // rebuilt this interval every 45 seconds and reset a local `tick` to 0. At
    // 7s a tick that is ~6 rotations per poll, always restarting at slot 0. Six
    // tiles and six rotations covered every slot by luck, so this never showed
    // — but it meant the tile count could never be raised without tiles at the
    // end of the row silently freezing.
    const t = setInterval(() => {
      const photos = poolRef.current;
      const dead = goneRef.current;
      if (photos.length === 0) return;
      setSlots((prev) => {
        const slot = tickRef.current % tileCount;
        tickRef.current += 1;
        const shown = new Set(prev);
        // Walk forward to the next photo nobody is showing, so the wall works
        // through the pool instead of flipping between the same few.
        let next = (prev[slot] + tileCount) % photos.length;
        let guard = 0;
        while ((shown.has(next) || dead.has(photos[next].id)) && guard < photos.length) {
          next = (next + 1) % photos.length;
          guard += 1;
        }
        // Exhausted: every photo is either on screen already or failed to
        // load. Leave the tile alone rather than duplicating a neighbour —
        // the same picture twice reads as a bug, a tile that holds does not.
        if (shown.has(next) || dead.has(photos[next].id)) return prev;
        // Warm the image before it is on screen. Without this the tile paints
        // empty for as long as the fetch takes, which on a slow shop
        // connection is a visible hole in the wall. A failure here is how a
        // photo that has since been hidden or deleted gets noticed.
        const img = new Image();
        const candidateId = photos[next].id;
        img.onerror = () => setDead((d) => new Set(d).add(candidateId));
        img.src = srcOf(photos[next]);
        if (cancelled) return prev;
        const copy = [...prev];
        copy[slot] = next;
        return copy;
      });
    }, TILE_ROTATE_MS);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [photos.length, tileCount, srcOf]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(cols, tileCount)}, 1fr)`,
        // ROWS SHARE THE HEIGHT THEY ARE GIVEN. Left as `auto`, each row sized
        // itself from its tiles and the grid simply grew past the panel, which
        // `overflow: hidden` then cut off — on a 1080x1920 kiosk that pushed
        // the phone number clean off the bottom of the board. Explicit 1fr
        // rows make the wall the thing that flexes, which is what it should be:
        // it is the only panel whose content has no natural size.
        gridTemplateRows: `repeat(${Math.ceil(tileCount / Math.min(cols, tileCount))}, minmax(0, 1fr))`,
        gap: "1vmin",
        flex: 1,
        minHeight: 0,
      }}
    >
      {slots.map((photoIdx, i) => {
        const photo = photos[photoIdx];
        if (!photo || dead.has(photo.id)) return <div key={i} />;
        return (
          <div
            key={i}
            style={{
              position: "relative",
              borderRadius: "0.8vmin",
              overflow: "hidden",
              minHeight: 0,
              background: C.panel,
            }}
          >
            {/* Keyed on the photo so a change remounts this layer and it fades
                in over whatever was there — a crossfade without having to keep
                the previous image in state. */}
            <div
              key={photo.id}
              style={{
                position: "absolute",
                inset: 0,
                backgroundImage: `url(${srcOf(photo)})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                animation: `wallIn 1200ms ease-out both, kenBurns${i % 4} ${26 + (i % 5) * 4}s ease-in-out infinite alternate`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Public (waiting room) ────────────────────────────────────────────────────

function PublicView({
  board, landscape, scale, logo, token,
}: { board: PublicBoard; landscape: boolean; scale: number; logo: string | null; token: string | null }) {
  const promo = board.promotions[0] ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.8vmin", flex: 1, minHeight: 0 }}>
      {/* The waiting room is the one screen a client actually studies, so it
          leads with the company mark rather than a bare wordmark. */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "2vmin" }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" style={{ height: `${8 * scale}vmin`, width: "auto", flexShrink: 0 }} />
        ) : null}
        <div>
          <div style={{ fontSize: `${4.2 * scale}vmin`, fontWeight: 700 }}>
            {board.company.name ?? "Seedlings Lawn Care"}
          </div>
          {board.company.serviceArea ? (
            <div style={{ fontSize: `${2 * scale}vmin`, color: C.inkDim, marginTop: "0.4vmin" }}>
              {board.company.serviceArea}
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: landscape ? "row" : "column",
          gap: "1.8vmin",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* The photo wall. AUTOMATIC — the latest finished work, the same
            instinct as the client photo lists. Nothing is curated in; a Super
            can only pull a photo OUT, via hiddenFromPublicAt.
            With no photos at all it does NOT render an empty frame: a big
            blank box is worse than not being there, so the evergreen content
            takes the space instead. */}
        {/* LEFT GROUP: the wall, with the promo directly beneath it.
            The promo used to run the full width of the board, under both
            columns, which made it the widest thing on screen for what is a
            headline and two sentences — and it stole height from the metrics
            column at the same time. Tucking it under the wall lines its edge
            up with the images above it and hands the right-hand column the
            full height of the board. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.8vmin",
            // GROWS IN BOTH ORIENTATIONS. Content-sizing this in portrait
            // collapsed the wall to a sliver: its grid rows are `1fr`, so they
            // have no intrinsic height to size a container from, and a group
            // that waits for its content to measure itself gets zero. The wall
            // is the panel that should absorb whatever is left over, which
            // means the group holding it has to ask for the room.
            flex: landscape ? 2 : 1,
            minHeight: 0,
          }}
        >
        <Panel flex="1 1 auto">
          {board.photos.length === 0 ? (
            <div
              style={{
                margin: "auto",
                textAlign: "center",
                padding: "0 3vmin",
              }}
            >
              <div style={{ fontSize: `${4 * scale}vmin`, fontWeight: 700, lineHeight: 1.2 }}>
                {promo?.headline ?? board.company.name ?? "Caring for lawns all season"}
              </div>
              {promo?.body ? (
                <div style={{ fontSize: `${2.2 * scale}vmin`, color: C.inkDim, marginTop: "1.6vmin" }}>
                  {promo.body}
                </div>
              ) : board.company.serviceArea ? (
                <div style={{ fontSize: `${2.2 * scale}vmin`, color: C.inkDim, marginTop: "1.6vmin" }}>
                  {board.company.serviceArea}
                </div>
              ) : null}
            </div>
          ) : (
            <PhotoWall
              photos={board.photos}
              token={token}
              // Verticals that waste two-thirds of a TV sit two-up on a
              // portrait panel instead.
              cols={landscape ? 3 : 2}
              tiles={6}
            />
          )}
        </Panel>

        {/* Not when the photo wall is already standing in for it — with no
            photos the fallback IS this promotion, and showing it twice on one
            screen reads as a bug. */}
        {promo && board.photos.length > 0 ? (
          <Panel flex="0 0 auto">
            <div style={{ display: "flex", gap: "2vmin", alignItems: "stretch", minWidth: 0 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <PromoRotator promos={board.promotions} token={token} scale={scale} />
              </div>
              {/* THE CODE LIVES WITH THE OFFERS IT LEADS TO.
                  It sat in the contact panel, which pushed that column past
                  the height of the board and clipped the email. Here it costs
                  NOTHING: the band is already 20vmin tall for the artwork, so
                  the code sizes itself from height that was spent anyway —
                  and it sits beside the thing it is a shortcut to instead of
                  beside a phone number.

                  A static file, not a generated image: the URL it encodes,
                  ?tab=client-promotions, never changes, so campaigns rotate
                  behind that address and this SVG stays correct for as long
                  as the tab exists.

                  The white plate is inside the SVG (its first path fills
                  41x41 white), which matters on a near-black board — a code
                  whose light modules are transparent renders dark-on-dark and
                  does not scan at all. */}
              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "0.6vmin",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: "0.8vmin",
                    padding: "0.7vmin",
                    lineHeight: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/promotions-qr.svg"
                    alt=""
                    style={{ width: `${16 * scale}vmin`, height: "auto", display: "block" }}
                  />
                </div>
                <div style={{ fontSize: `${1.4 * scale}vmin`, color: C.inkDim, whiteSpace: "nowrap" }}>
                  Scan for all offers
                </div>
              </div>
            </div>
          </Panel>
        ) : null}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.8vmin",
            flex: landscape ? 1 : "0 0 auto",
            // NO justifyContent. Pushing the slack between the panels turned
            // it into two conspicuous voids — the eye reads a gap that size as
            // something failing to load. The panels absorb it instead, each
            // taking an equal share and centring its content, so the column
            // simply looks like it was laid out for this screen.
            minHeight: 0,
          }}
        >
          {/* SEVEN COUNTS, SEVEN INKS. The three for today are grouped and set
              a step smaller — they are a breakdown of one day, and running
              them at the same weight as the running totals made the panel read
              as unrelated figures rather than "today, within the longer run".

              EVERY NUMBER CARRIES ITS OWN LABEL rather than leaning on the
              heading: two of these are not completions, and a count that only
              makes sense via the title above it stops making sense the moment
              anything else changes. It briefly did exactly that — the heading
              read TODAY while the numbers underneath were week and month.

              Shown even at zero. An early-morning 0 beside "23 this week"
              reads as a day not started; hiding the row instead made the panel
              change shape during the day, which is worse.

              Counts only: no client, no property, no address. A number
              identifies nobody, which is why these are safe here when the job
              list behind them is not. */}
          {/* THIS PANEL TAKES THE SLACK — BUT NEVER GIVES ANY BACK.
              The column's panels all size to their content, so with the promo
              moved out to its own band nothing in here grew and the leftover
              height collected at the bottom as a dead strip under the phone
              number. The counts are the panel that benefits from room, and
              their two rows spread into it rather than sitting at the top of a
              taller box.

              `1 0 auto`, NOT `1`. The shorthand `flex="1"` means `1 1 0%` — a
              zero basis and permission to shrink — so on a 1080x1920 kiosk,
              where the same panels stack into one tall column and space is
              tight, this panel was sized SHORTER than its own contents and
              Panel's `overflow: hidden` sliced the second row of numbers in
              half. Growing into spare height and refusing to shrink below the
              content are two different things, and this panel needs both. */}
          <Panel title="Work completed" flex="1 0 auto" centerContent>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "2.2vmin",
                alignItems: "baseline",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ containerType: "inline-size" } as any),
                // A quiet inset rather than a second border: the three belong
                // together, but the panel already has an edge and another one
                // inside it reads as a card within a card.
                background: "#0d1117",
                borderRadius: "0.9vmin",
                padding: "1.2vmin 1.4vmin",
              }}
            >
              {(() => {
                const cells = [
                  { label: "scheduled today", value: board.today.scheduled, color: C.accent },
                  { label: "in progress", value: board.today.inProgress, color: C.warn },
                  { label: "completed today", value: board.today.completed, color: C.good },
                ];
                const fit = statFit(cells.length, cells);
                return cells.map((c) => (
                  <Stat key={c.label} label={c.label} value={c.value} color={c.color} scale={scale} size={5.4} fit={fit} />
                ));
              })()}
            </div>
            {/* Four TRAILING windows, each nested inside the next, so they can
                only ever grow left to right.

                LABELLED FOR WHAT THEY MEASURE. These read "this week / this
                month / this quarter / this year" while the service behind
                them had already been changed to trailing windows — so "this
                year" was really the last twelve months, and a client in the
                waiting room reading 481 would have understood year-to-date.
                The numbers were right and the words were wrong, which is the
                harder half to notice. See buildPublicBoard for why the
                windows trail rather than follow the calendar. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: "2.4vmin",
                alignItems: "baseline",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ containerType: "inline-size" } as any),
                marginTop: "1.6vmin",
              }}
            >
              {(() => {
                const cells = [
                  { label: "past 7 days", value: board.completed.week, color: C.cool },
                  { label: "past month", value: board.completed.month, color: C.violet },
                  { label: "past 3 months", value: board.completed.quarter, color: C.teal },
                  { label: "past 12 months", value: board.completed.year, color: C.rose },
                ];
                const fit = statFit(cells.length, cells);
                return cells.map((c) => (
                  <Stat key={c.label} label={c.label} value={c.value} color={c.color} scale={scale} size={6} fit={fit} />
                ));
              })()}
            </div>
          </Panel>

          <Weather w={board.weather} scale={scale} />

          {/* CONTACT. The email was already being fetched and thrown away —
              on the one screen whose whole job is to be read by a client
              sitting in the room, the second way to reach the business was
              being dropped on the floor. */}
          {/* NO TITLE. A phone number and an email address under a heading
              that says "Get in touch" is the heading restating the content —
              on a board read from across a room, a line carrying no
              information is a line competing with the ones that do. */}
          {board.company.phone || board.company.email ? (
            <Panel flex="1 0 auto" centerContent>
              {board.company.phone ? (
                <div style={{ fontSize: `${2.6 * scale}vmin` }}>{board.company.phone}</div>
              ) : null}
              {board.company.email ? (
                <div style={{ fontSize: `${1.9 * scale}vmin`, color: C.inkDim, marginTop: "0.6vmin" }}>
                  {board.company.email}
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>
      </div>

    </div>
  );
}
