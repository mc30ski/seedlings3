import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * THE APP DOES NOT POLL.
 *
 * Not "tries not to" — does not. Data arrives when someone asks for it or when
 * an action causes it, and a screen that wants fresher numbers gets a refresh
 * control. A timer quietly re-hitting the API every few seconds costs a Neon
 * connection per tick on a serverless backend, and it does it forever, on every
 * open tab, whether or not anyone is looking.
 *
 * ONE EXCEPTION, GRANTED DELIBERATELY: the wall display at /display, and only
 * once it is paired. That screen has nobody standing at it and no way to ask
 * for a refresh — polling is the entire mechanism by which it works.
 *
 * This rule exists because it was broken within an hour of being agreed. The
 * Displays admin tab shipped with a 15-second `setInterval` refetch, justified
 * in a comment as convenience during pairing, and nobody would have noticed
 * until it was in production on every operator's open tab.
 */

const WEB = join(__dirname, "../../../web");

/** Calls that mean "this touched the network". `location.reload()` is here
 *  because it refetches the document, even though it is not an API call. */
const NETWORK = /\b(fetch\(|api(?:Get|Post|Patch|Delete|Put)\(|void load\(|load\(\)|refetch|mutate\(|location\.reload\()/;

/** Where polling is allowed, and why. Every entry is a decision someone made
 *  on purpose — adding one should feel like it needs a sentence, because it
 *  does. */
const ALLOWED: { file: string; why: string }[] = [
  {
    file: "pages/display.tsx",
    why: "The granted exception. A wall display has nobody at it and no refresh control; polling IS the feature. Gated on being paired — see the token check below.",
  },
  {
    file: "src/ui/components/DocumentSyncStatusPanel.tsx",
    why: "PRE-EXISTING, and bounded: it polls only while `serverInProgress` is true — a progress bar for a running sync, not an idle tab. Flagged 2026-09-20; kept rather than silently exempted so it stays visible.",
  },
];

function webFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "tests") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(join(WEB, "src"));
  walk(join(WEB, "pages"));
  return out;
}

const rel = (p: string) => p.slice(WEB.length + 1);

describe("[build-gate] the app does not poll", () => {
  it("reads the files it guards", () => {
    const files = webFiles();
    expect(files.length, "the scan found nothing — the walk is broken").toBeGreaterThan(50);
  });

  it("no timer re-fetches outside the one place it is allowed", () => {
    const offenders: string[] = [];
    for (const path of webFiles()) {
      const src = readFileSync(path, "utf8");
      const file = rel(path);
      if (ALLOWED.some((a) => file === a.file)) continue;

      for (const m of src.matchAll(/setInterval\s*\(/g)) {
        // The callback plus a little slack. A timer that merely ticks a clock
        // (`setNow(Date.now())`) is not polling and must not be flagged — this
        // rule is about traffic, not about timers.
        const body = src.slice(m.index!, m.index! + 320);
        if (!NETWORK.test(body)) continue;
        const line = src.slice(0, m.index!).split("\n").length;
        offenders.push(`${file}:${line} — ${body.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    expect(
      offenders,
      "a setInterval that hits the network. The app does not poll: fetch on mount, refetch on action, and give the user a refresh control. If this genuinely needs an exception, add it to ALLOWED with a reason.",
    ).toEqual([]);
  });

  it("the display's own polling is gated on being paired", () => {
    // The exception is "/display, once paired" — not "/display". An unpaired
    // screen showing a code must not be hammering the board endpoint with a
    // token it does not have.
    const src = readFileSync(join(WEB, "pages/display.tsx"), "utf8");
    const at = src.indexOf("const fetchBoard");
    expect(at, "the board fetch must exist").toBeGreaterThan(-1);
    const effectStart = src.lastIndexOf("useEffect(", at);
    const guard = src.slice(effectStart, at);
    expect(
      guard,
      "the board poll must return early when there is no token — an unpaired screen polls nothing",
    ).toMatch(/if \(!token\) return;/);
  });

  it("the admin tab that broke this rule does not quietly regain a timer", () => {
    // Named explicitly. This is the file the rule was written for, and a
    // general scan would stop mentioning it the moment someone renamed a
    // helper the NETWORK regex happens to match.
    const src = readFileSync(join(WEB, "src/ui/tabs/DisplaysTab.tsx"), "utf8");
    expect(src, "the Displays tab must not poll — it fetches once and offers Refresh")
      .not.toMatch(/setInterval/);
    expect(src, "and it must still offer a way to refresh by hand")
      .toMatch(/manual: true/);
  });
});
