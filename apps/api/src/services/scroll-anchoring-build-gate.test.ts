// ─────────────────────────────────────────────────────────────────────────────
// Scroll anchoring build gate
//
// THE BUG THIS EXISTS TO PREVENT, in full, because it shipped:
//
// Clicking "Manage in Services" on a job card lands the operator on the
// Services tab and jumps to the matching occurrence row. The jump was done
// from an inline ref callback on the row:
//
//     ref={highlightOccId === occ.id ? (el) => {
//       if (el) {
//         requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth" }));
//         setTimeout(() => setFlashOccId(null), 3000);
//       }
//     } : undefined}
//
// An inline arrow is a NEW function identity on every render, so React detaches
// and reattaches the ref every time the component renders. Each reattach fired
// another smooth scrollIntoView, and restarted the 3s flash timer — whose own
// setState caused the next render.
//
// Nothing ever cleared `highlightOccId` (it doubles as the thing that keeps the
// row visible past the status filters), so the condition stayed true forever.
// The result the operator reported: the page was "sticky" — every hover,
// refetch or filter change yanked the viewport back to the same row and it
// could not be scrolled away from.
//
// THE RULE: scrolling is an EVENT, not a render side effect. It belongs in an
// event handler or an effect that can decide, once, that it has already run.
// A ref callback is neither — it runs as a consequence of rendering, and how
// often it runs is not something the callsite controls.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(full, out);
    } else if (e.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(join(REPO_ROOT, "apps/web/src")),
  ...walk(join(REPO_ROOT, "apps/web/pages")),
].map((f) => ({ rel: f.slice(REPO_ROOT.length + 1), text: readFileSync(f, "utf8") }));

/** Drop comments so the incident write-ups that QUOTE the bad code — this file
 *  and the one in ServicesTab — are not themselves flagged. A gate that
 *  punishes documenting the bug teaches people to delete the explanation. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The source of every `ref={...}` JSX attribute in a file, brace-matched so a
 *  multi-line callback is captured whole rather than guessed at by line count. */
function refAttributeBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\bref=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("scroll anchoring", () => {
  it("scans a meaningful number of web components", () => {
    // Guards the gate itself: a broken path makes every check below pass
    // vacuously, which is how a gate goes quietly dead.
    expect(files.length).toBeGreaterThan(50);
  });

  it("no ref callback scrolls", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const body of refAttributeBodies(stripComments(f.text))) {
        if (/scrollIntoView|scrollTo\s*\(/.test(body)) offenders.push(f.rel);
      }
    }
    expect([...new Set(offenders)], [
      "A ref callback runs as a consequence of RENDERING, and an inline arrow",
      "re-runs on every render — so this scrolls the viewport back repeatedly",
      "and the page cannot be scrolled away from. Move the scroll into an",
      "event handler, or an effect that records which target it already",
      "scrolled to and refuses to scroll for that target twice.",
    ].join(" ")).toEqual([]);
  });

  it("no ref callback starts a timer", () => {
    // Same failure mode, quieter symptom: a re-attached ref restarts the
    // timer, and the timer's own setState causes the next render.
    const offenders: string[] = [];
    for (const f of files) {
      for (const body of refAttributeBodies(stripComments(f.text))) {
        if (/setTimeout\s*\(|setInterval\s*\(/.test(body)) offenders.push(f.rel);
      }
    }
    expect([...new Set(offenders)], [
      "A ref callback re-runs on every render, so this timer is restarted",
      "every time — and if it calls setState, it schedules its own next run.",
      "Put it in a useEffect keyed on the value it is timing out.",
    ].join(" ")).toEqual([]);
  });

  it("the Services occurrence jump scrolls once per navigation", () => {
    const f = files.find((x) => x.rel.endsWith("ui/tabs/ServicesTab.tsx"));
    expect(f, "ServicesTab.tsx not found").toBeTruthy();
    const src = stripComments(f!.text);
    // The guard that makes it one-shot. Without it the effect re-scrolls every
    // time its deps change, which is the same symptom by another route.
    expect(src, "the one-shot scroll guard is gone").toMatch(
      /scrolledToOccRef\.current\s*===\s*highlightOccId/,
    );
    expect(src, "the guard must be SET after scrolling, or it never latches")
      .toMatch(/scrolledToOccRef\.current\s*=\s*highlightOccId/);
  });
});
