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
  weather: BoardWeather;
};
type PublicBoard = {
  mode: "PUBLIC"; generatedAt: string;
  crewsOutToday: string[];
  today: { scheduled: number; inProgress: number; completed: number };
  completed: { today: number; week: number; month: number; quarter: number; year: number };
  photos: { id: string; url: string; takenAt: string }[];
  promotions: { id: string; headline: string; body: string | null; url: string | null }[];
  company: { name: string | null; phone: string | null; email: string | null; serviceArea: string | null };
  weather: BoardWeather;
};
type BoardWeather = {
  tempF: number; description: string; icon: string;
  highF: number; lowF: number; rainChance: number;
  alerts: { event: string; severity: string }[];
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

function clockTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
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
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastGoodMsRef.current > WATCHDOG_MS) window.location.reload();
    }, 60_000);
    return () => clearInterval(t);
  }, []);

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
          <PrivateView board={board} landscape={landscape} scale={scale} now={now} />
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

function Panel({ children, title, flex }: { children: React.ReactNode; title?: string; flex?: string }) {
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.panelEdge}`,
        borderRadius: "1.2vmin",
        padding: "1.6vmin 1.8vmin",
        flex,
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
      {children}
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
  board, landscape, scale, now,
}: { board: PrivateBoard; landscape: boolean; scale: number; now: number }) {
  // Everything that can overflow pages itself, so no row is permanently
  // invisible on a screen nobody can scroll.
  const clockPage = usePagedItems(board.onTheClock, landscape ? 7 : 9);
  const jobsPage = usePagedItems(board.jobs, landscape ? 8 : 12);
  const outItems = [
    ...board.vehiclesOut.map((v) => ({ kind: "vehicle" as const, ...v })),
    ...board.equipmentOut.map((e) => ({ kind: "equipment" as const, ...e })),
  ];
  const outPage = usePagedItems(outItems, 6);
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
    <Panel title="Weather">
      <div style={{ display: "flex", alignItems: "baseline", gap: "1.6vmin", flexWrap: "wrap" }}>
        <span style={{ fontSize: `${7 * scale}vmin`, fontWeight: 700, lineHeight: 1 }}>{w.tempF}°</span>
        <div>
          <div style={{ fontSize: `${2.1 * scale}vmin`, textTransform: "capitalize" }}>{w.description}</div>
          <div style={{ fontSize: `${1.8 * scale}vmin`, color: C.inkDim }}>
            {w.highF}° / {w.lowF}°{w.rainChance > 0 ? ` · ${w.rainChance}% rain` : ""}
          </div>
        </div>
      </div>
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

function Stat({
  label, value, color, scale, size = 7,
}: { label: string; value: number; color: string; scale: number; size?: number }) {
  return (
    <div>
      <div
        style={{
          fontSize: `${size * scale}vmin`,
          fontWeight: 700,
          color,
          lineHeight: 1,
          // Digits on a wall shift the label under them as the count ticks
          // over unless they share a width.
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: `${Math.max(1.4, size * 0.24) * scale}vmin`, color: C.inkDim, marginTop: "0.6vmin" }}>
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

  const [slots, setSlots] = useState<number[]>(() =>
    Array.from({ length: tiles }, (_, i) => i % Math.max(1, photos.length)),
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
    setSlots(Array.from({ length: tiles }, (_, i) => i % Math.max(1, photos.length)));
  }, [tiles, photos.length]);

  useEffect(() => {
    // Nothing to rotate through — leave the grid alone rather than shuffling
    // the same six pictures around, which reads as a glitch.
    if (photos.length <= tiles) return;
    let tick = 0;
    let cancelled = false;

    const t = setInterval(() => {
      setSlots((prev) => {
        const slot = tick % tiles;
        tick += 1;
        const shown = new Set(prev);
        // Walk forward to the next photo nobody is showing, so the wall works
        // through the pool instead of flipping between the same few.
        let next = (prev[slot] + tiles) % photos.length;
        let guard = 0;
        while ((shown.has(next) || dead.has(photos[next].id)) && guard < photos.length) {
          next = (next + 1) % photos.length;
          guard += 1;
        }
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
  }, [photos, tiles, srcOf, dead]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
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

  // DEGRADE GRACEFULLY. "0 crews out today" on a lobby screen at 8am on a rain
  // day is a worse impression than showing nothing, so a thin day falls back to
  // evergreen content rather than reporting an empty one.
  const thinDay = board.crewsOutToday.length === 0;

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
        {/* The photo wall. Hand-picked only — see JobOccurrencePhoto.
            With nothing picked yet it does NOT render an empty frame: a big
            blank box is worse than not being there, so the evergreen content
            takes the space instead. */}
        <Panel flex={landscape ? "2" : "2"}>
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

        <div style={{ display: "flex", flexDirection: "column", gap: "1.8vmin", flex: 1, minHeight: 0 }}>
          {!thinDay ? (
            <Panel title="Out today">
              <div style={{ fontSize: `${2.6 * scale}vmin`, lineHeight: 1.5 }}>
                {board.crewsOutToday.join(" · ")}
              </div>
            </Panel>
          ) : null}

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
          <Panel title="Work completed">
            <div
              style={{
                display: "flex",
                gap: "2.2vmin",
                alignItems: "baseline",
                flexWrap: "wrap",
                // A quiet inset rather than a second border: the three belong
                // together, but the panel already has an edge and another one
                // inside it reads as a card within a card.
                background: "#0d1117",
                borderRadius: "0.9vmin",
                padding: "1.2vmin 1.4vmin",
              }}
            >
              <Stat label="scheduled today" value={board.today.scheduled} color={C.accent} scale={scale} size={5.4} />
              <Stat label="in progress" value={board.today.inProgress} color={C.warn} scale={scale} size={5.4} />
              <Stat label="completed today" value={board.today.completed} color={C.good} scale={scale} size={5.4} />
            </div>
            {/* Four calendar periods, each nested inside the next, so they can
                only ever grow left to right. They were rolling windows until
                quarter and year joined them, at which point a rolling month
                could out-count a calendar year-to-date in January. */}
            <div style={{ display: "flex", gap: "2.4vmin", alignItems: "baseline", flexWrap: "wrap", marginTop: "1.6vmin" }}>
              <Stat label="this week" value={board.completed.week} color={C.cool} scale={scale} size={6} />
              <Stat label="this month" value={board.completed.month} color={C.violet} scale={scale} size={6} />
              <Stat label="this quarter" value={board.completed.quarter} color={C.teal} scale={scale} size={6} />
              <Stat label="this year" value={board.completed.year} color={C.rose} scale={scale} size={6} />
            </div>
          </Panel>

          {/* Not when the photo wall is already standing in for it — with no
              photos picked yet the fallback IS this promotion, and showing it
              twice on one screen reads as a bug. */}
          {promo && board.photos.length > 0 ? (
            <Panel flex="1">
              <div style={{ fontSize: `${3 * scale}vmin`, fontWeight: 700, color: C.accent }}>
                {promo.headline}
              </div>
              {promo.body ? (
                <div style={{ fontSize: `${2 * scale}vmin`, color: C.inkDim, marginTop: "1vmin" }}>
                  {promo.body}
                </div>
              ) : null}
            </Panel>
          ) : null}

          <Weather w={board.weather} scale={scale} />

          {board.company.phone ? (
            <Panel>
              <div style={{ fontSize: `${2.6 * scale}vmin` }}>{board.company.phone}</div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
