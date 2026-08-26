// ─────────────────────────────────────────────────────────────────────────────
// AI truncation build gate
//
// PURPOSE
// On 2026-08-25 the production route planner "failed" by showing the
// operator a wall of half-written JSON. Nothing threw. The model had hit
// `max_tokens: 3000` mid-week, stopped mid-word, `JSON.parse` threw into an
// empty `catch {}`, and the raw text was returned and rendered verbatim.
//
// The reason it was invisible is the same reason the audit-coverage gate
// exists: NOTHING FAILED. A truncated response is indistinguishable from a
// model returning nonsense unless you check `stop_reason`, and no call site
// did.
//
// WHAT THIS GATE REQUIRES of every Anthropic call whose output is parsed
// as JSON:
//   1. `stop_reason === "max_tokens"` is checked, so truncation is reported
//      as truncation rather than as a mysterious parse failure.
//   2. `max_tokens` is above a floor that the prompt could plausibly need.
//      A cap sized for the happy path is a latent outage.
//   3. Unparseable output is never handed to a user without an accompanying
//      `error` — silently rendering raw model output is what made this look
//      like the feature was broken rather than that a request had failed.
//
// Output is billed by tokens PRODUCED, not by the ceiling, so a generous
// cap costs nothing on a request that ends early.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");

/**
 * Anthropic call sites whose response is parsed as JSON.
 *
 * Deliberately an explicit list rather than a directory scan: a new AI
 * feature should have to be added here consciously, which is the moment to
 * ask whether its output can truncate. `notifications.ts` also calls
 * `messages.create`, but that is TWILIO — same method name, different SDK,
 * no truncation semantics.
 */
const JSON_PARSING_AI_CALLSITES = [
  {
    file: "apps/api/src/routes/preview.ts",
    what: "route planner",
    // A week of routes, each stop carrying prose. This is the one that
    // actually blew up; it needs real headroom.
    minTokens: 8000,
  },
  {
    file: "apps/api/src/routes/admin.ts",
    what: "estimate generator",
    // Two prose fields in a JSON envelope.
    minTokens: 3000,
  },
] as const;

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("AI truncation build gate", () => {
  for (const site of JSON_PARSING_AI_CALLSITES) {
    describe(site.what, () => {
      it("checks stop_reason for truncation", () => {
        // Without this the only symptom is unparseable JSON, which sends
        // the next person debugging the parser instead of the token limit.
        // Match the CODE, not prose. An earlier version of this assertion
        // accepted a bare `stop_reason === "max_tokens"`, which the
        // explanatory comment above the real check also contains — so
        // deleting the check left the gate green. Requiring the
        // `response.` receiver and an `if (` makes it an executable
        // statement rather than a sentence.
        const src = read(site.file);
        const withoutComments = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .join("\n");
        expect(
          withoutComments,
          `${site.file} must CHECK response.stop_reason === "max_tokens" in code`,
        ).toMatch(/if\s*\(\s*response\.stop_reason\s*===\s*"max_tokens"\s*\)/);
      });

      it(`sets max_tokens to at least ${site.minTokens}`, () => {
        const src = read(site.file);
        const values = [...src.matchAll(/max_tokens:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(values.length, `${site.file} should set max_tokens`).toBeGreaterThan(0);
        for (const v of values) {
          expect(
            v,
            `${site.file} sets max_tokens: ${v}, below the ${site.minTokens} floor — ` +
              "this is how the route planner silently truncated in production",
          ).toBeGreaterThanOrEqual(site.minTokens);
        }
      });
    });
  }

  it("the route planner never returns raw model output without an error", () => {
    // The operator saw a wall of JSON and no explanation. Raw output is
    // fine for diagnosis, but it must be paired with something that says
    // the request failed.
    const src = read("apps/api/src/routes/preview.ts");
    expect(src).toMatch(/raw:\s*parsed\s*\?\s*undefined\s*:\s*text/);
    expect(
      src,
      "unparseable output must be returned alongside an `error` field",
    ).toMatch(/error:\s*parsed\s*\n?\s*\?\s*undefined/);
  });

  it("a JSON.parse of model output is never left with a bare empty catch", () => {
    // `catch {}` is what swallowed the original failure. Capturing the
    // reason is the difference between "it broke" and "it truncated".
    const src = read("apps/api/src/routes/preview.ts");
    const parseBlock = src.slice(
      src.indexOf("let parsed"),
      src.indexOf("let parsed") + 600,
    );
    expect(parseBlock).toMatch(/catch\s*\(/);
    expect(parseBlock, "the parse failure reason must be captured").toMatch(/parseError/);
  });
});
