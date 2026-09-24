import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * A WALL SCREEN HAS TO RECOVER ON ITS OWN.
 *
 * Nobody stands at it, nobody reloads it, and the nearest keyboard is a drive
 * away. Every rule here guards a failure that looked fine in code review and
 * would only ever have been found by staring at a TV in a shop — which is to
 * say, weeks later, by the owner.
 */

const API = join(__dirname, "../..");
const WEB = join(API, "../web");
const display = () => readFileSync(join(WEB, "pages/display.tsx"), "utf8");

describe("[build-gate] the wall display recovers unattended", () => {
  it("the watchdog only runs while PAIRED", () => {
    // `lastGoodMsRef` is touched by a successful BOARD fetch and nothing else,
    // and an unpaired screen never makes one. An unconditional watchdog
    // therefore fired ten minutes after boot and reloaded the document every
    // sixty seconds, all night, on a screen that was merely waiting for
    // someone to type its code. Waiting is not wedged.
    const src = display();
    const at = src.indexOf("WATCHDOG_MS) window.location.reload()");
    expect(at, "the watchdog must exist").toBeGreaterThan(-1);
    const effect = src.slice(src.lastIndexOf("useEffect(", at), at);
    expect(
      effect,
      "the watchdog must bail out when there is no token — an unpaired screen is not wedged",
    ).toMatch(/if \(!token\) return;/);
  });

  it("a failed request for a pairing code is retried", () => {
    // `startPairing` swallows network errors on purpose, because a device
    // routinely beats the wifi up on boot. That is only safe if something
    // tries again: the approval poll does not, since it needs a code to
    // already exist. Without this the screen showed "— — —" until the
    // watchdog reloaded it ten minutes later.
    const src = display();
    expect(src, "a retry cadence must be defined").toMatch(/const PAIR_RETRY_MS\s*=/);
    expect(
      src,
      "something must re-call startPairing when booted with neither a token nor a code",
    ).toMatch(/if \(!booted \|\| token \|\| pairing\) return;[\s\S]{0,200}startPairing\(\)/);
  });

  it("photo rotation does not restart on every board poll", () => {
    // `photos` is a fresh array each poll. An effect that depends on it
    // rebuilds its interval every 45s and resets the tile cursor to 0, so only
    // the first few slots ever rotate and tiles at the end of the row freeze.
    // Both the wall and the strip have been caught by this.
    const src = display();
    const deps = [...src.matchAll(/\}, \[photos[^\]]*\]\);/g)].map((m) => m[0]);
    expect(deps.length, "the rotation effects must be findable").toBeGreaterThanOrEqual(2);
    for (const d of deps) {
      expect(
        d,
        `rotation keyed on the photos ARRAY restarts every poll and freezes late tiles: ${d}`,
      ).not.toMatch(/\[photos,/);
    }
  });

  it("every 'work completed' count is built from the SAME filter", () => {
    // Five running totals sat beside two today-counts on the public wall, all
    // written out by hand, and the five had drifted: no workflow exclusion, so
    // completed reminders and internal tasks counted as work done, and no
    // upper bound, so future-dated finished rows counted too. Nothing about
    // looking at "481 this year" reveals what went into it.
    const src = readFileSync(join(API, "src/services/displays.ts"), "utf8");
    expect(src, "the shared filter must exist").toMatch(/const doneWorkBetween\s*=/);

    const start = src.indexOf("export async function buildPublicBoard");
    expect(start, "buildPublicBoard must exist").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("return {", start));

    // EVERY count on this board excludes internal workflow rows — either by
    // going through the helper, or by naming the exclusion itself. Checking
    // "does it start with a brace" instead let a one-line inline `where`
    // through, which is the exact shape the bug had.
    const counts = [...body.matchAll(/jobOccurrence\.count\(\{/g)].map((m) =>
      body.slice(m.index!, m.index! + 400),
    );
    expect(counts.length, "the board must still count occurrences").toBeGreaterThanOrEqual(7);
    const leaky = counts.filter(
      (c) => !c.includes("doneWorkBetween") && !c.includes("NON_JOB_WORKFLOW_EXCLUSION"),
    );
    expect(
      leaky.map((c) => c.replace(/\s+/g, " ").slice(0, 90)),
      "a public-board count that lets reminders, tasks and follow-ups inflate it",
    ).toEqual([]);

    const helper = src.slice(src.indexOf("const doneWorkBetween"), src.indexOf("const doneWorkBetween") + 320);
    expect(helper, "it must exclude internal workflow rows").toContain("NON_JOB_WORKFLOW_EXCLUSION");
    expect(helper, "and it must bound the window at BOTH ends").toMatch(/gte:[^,]*,\s*lte:/);
  });

  it("an issued token survives a dropped response", () => {
    // The plaintext used to be destroyed in the same transaction that returned
    // it, so a response lost in flight destroyed the only copy — and the
    // Display row it belonged to became a credential nobody held. Re-collection
    // still costs the device secret, so the window is not a new exposure.
    const src = readFileSync(join(API, "src/routes/public.ts"), "utf8");
    expect(src, "a bounded collection window must exist").toMatch(/TOKEN_COLLECT_GRACE_MS\s*=\s*[0-9_]+/);

    const at = src.indexOf('app.post("/public/display/pair/poll"');
    expect(at, "the poll route must exist").toBeGreaterThan(-1);
    const route = src.slice(at, src.indexOf("app.get(", at));
    expect(
      route,
      "the token must NOT be nulled in the same write that hands it back",
    ).not.toMatch(/issuedToken: null,\s*consumedAt:/);
    expect(route, "the window must be what retires it").toContain("TOKEN_COLLECT_GRACE_MS");
  });

  it("the pairing flood guard is per-caller, not one global bucket", () => {
    // A single global counter let one stuck tab lock every other screen in the
    // shop out of pairing — the failure the guard exists to prevent, inverted.
    const src = readFileSync(join(API, "src/routes/public.ts"), "utf8");
    const at = src.indexOf('app.post("/public/display/pair"');
    const route = src.slice(at, src.indexOf("app.post(", at + 10));
    expect(
      route,
      "the guard must count THIS caller's requests, not just everyone's",
    ).toMatch(/requestedIp: ip/);
  });
});
