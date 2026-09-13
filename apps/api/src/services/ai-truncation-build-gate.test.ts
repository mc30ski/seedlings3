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
  // The ROUTE PLANNER used to be here, with the largest headroom of the lot —
  // it is the one that actually truncated in production. It no longer calls a
  // model at all: the routing provider had always done the routing, and what
  // remained was arithmetic, a sort key and caption text. See
  // lib/routePlanner.ts, and the "route planning is deterministic" gate below
  // which keeps the call from coming back.
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

  // TWO TESTS REMOVED HERE, both about the route planner's handling of model
  // output: that raw text was never returned without an `error` beside it, and
  // that the JSON.parse was never left with a bare `catch {}`. Both described
  // a code path that no longer exists — there is no model output to mishandle.
  // The estimate generator above still carries the equivalent checks.
});


describe("[build-gate] route planning is deterministic", () => {
  // The route planner was an LLM call and is now plain code. The provider had
  // always solved the routing with real driving times — the prompt said so
  // itself — leaving the model arithmetic, a sort key, and caption text.
  //
  // Two of those were worse for having a model. The budget is addition, and a
  // model asked to "do the math before selecting jobs" got it wrong: a worker
  // with 22 claimed jobs for a Saturday had most of the day binned against a
  // 4-hour default he never set. And a generated reason narrates an ordering
  // it did not compute, so it can say "closest to your previous stop" about a
  // stop that is not — rendered as muted italic nobody re-checks.
  //
  // Deleting the call also deleted its failure modes: a truncation branch, a
  // JSON-parse branch, a filter dropping hallucinated stops matching no real
  // job, and a claimed-mode re-flattening step that existed because the
  // response schema invited the model to spread one day across a week.
  const ROUTE = readFileSync(join(__dirname, "../routes/preview.ts"), "utf8");
  const PLANNER = readFileSync(join(__dirname, "../lib/routePlanner.ts"), "utf8");

  it("parses the files it is guarding", () => {
    expect(ROUTE).toContain("/preview/route-suggestions");
    expect(PLANNER).toContain("export function planRoute");
  });

  it("the route suggestions endpoint calls no model", () => {
    expect(ROUTE, "the Anthropic SDK is back in the route planner")
      .not.toMatch(/@anthropic-ai\/sdk|new Anthropic\(|anthropic\.messages/);
    expect(ROUTE, "no API key belongs in this path any more")
      .not.toMatch(/ANTHROPIC_API_KEY/);
    expect(ROUTE, "the plan must come from the deterministic planner")
      .toContain("planRoute(");
  });

  it("claimed mode plans only claimed work", () => {
    // The same query serves both modes, so without an explicit filter the
    // "just order what I've already taken" view grows suggestions — and
    // counts them as date changes. Caught in testing, not in review.
    expect(PLANNER).toMatch(/mode === "claimed" \? jobs\.filter\(\(j\) => j\.type === "claimed"\)/);
  });

  it("no job is ever dropped for exceeding the stated hours", () => {
    // The budget is reported, never enforced. A worker who has committed to
    // the work decides what to shed; the planner marks where the hours run
    // out and keeps going.
    expect(PLANNER, "the budget must only mark, not filter")
      .toMatch(/pastBudget/);
    // Anchored on the assignment and read to its semicolon, rather than a
    // fixed character window — widening the expression (to account for the
    // drive home) broke the first version of this rule against correct code.
    const at = PLANNER.indexOf("const pastBudget =");
    expect(at, "the budget check moved").toBeGreaterThan(-1);
    const expr = PLANNER.slice(at, PLANNER.indexOf(";", at));
    expect(expr, "claimed work can never be marked optional")
      .toMatch(/job\.type !== "claimed"/);
    expect(expr, "the budget must be compared against the day's hours")
      .toMatch(/budgetMins/);
    expect(expr, "the whole day's driving counts, including the leg home")
      .toMatch(/reservedDriveMins/);
  });

  it("every reason is built from a measured value", () => {
    // Each clause is a provider-reported leg, a stored date, a history lookup
    // or a running total — nothing narrated.
    expect(PLANNER).toMatch(/function buildReason/);
    expect(PLANNER, "drive legs must come from the provider")
      .toMatch(/leg\.durationFromPrev/);
  });
});
