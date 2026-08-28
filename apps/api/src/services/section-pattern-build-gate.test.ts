// ─────────────────────────────────────────────────────────────────────────────
// Section pattern build gate
//
// PURPOSE
// Home, Jobs, Inventory, Collections, Vehicles and Routes all render the
// same KIND of thing: a collapsible section with a title bar, an icon, a
// left accent stripe, a refresh control and a timeframe picker.
//
// Through 2026-08-26/27 every one of those was hand-rolled per call site.
// The consequences, all reported by the operator rather than caught by a
// test:
//   • two sections had no collapse at all
//   • one refresh reloaded the entire tab
//   • timeframe pickers were click-through chips in some places and
//     dropdowns in others
//   • collapsing re-fetched invisibly (children rendered in two branches)
//   • expanding flashed stale data before the spinner
//
// None of that is findable by reading one file. It is only visible when
// you line the sections up — which is what this gate does.
//
// WHAT THIS GATE REQUIRES
//   1. `Dashboard` still owns the shared behaviour (collapse, refresh,
//      overlay, timeframe). If these props disappear, the sections have
//      started hand-rolling again.
//   2. `Dashboard` renders `children` EXACTLY ONCE. Two branches is what
//      caused the invisible refetch-on-collapse.
//   3. The auto-refresh is NOT driven by an effect — an effect fires
//      after paint, which is what made expanding flash stale data.
//   4. No section file builds its own timeframe `Select.Root`.
//   5. No `<select>`/`<option>` anywhere (existing house rule, enforced
//      here for the files this gate already reads).
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * Source with comments stripped.
 *
 * Required for the native-<select> check: the very comments explaining
 * "never a native <select>" contain the string they forbid, so a raw
 * match fails on files that are doing the right thing. Same lesson as the
 * AI-truncation gate, which once passed by matching its own prose.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const DASHBOARD = "apps/web/src/ui/components/Dashboard.tsx";

/**
 * Files that render a Dashboard SECTION and previously carried their own
 * copy of the shared furniture. Explicit rather than globbed: a new
 * section should be added here deliberately, which is the moment to check
 * it isn't reinventing the frame.
 */
const SECTION_FILES = [
  "apps/web/src/ui/components/MyDashboard.tsx",
  "apps/web/src/ui/components/WorkerHourlyPayCard.tsx",
  "apps/web/src/ui/components/PayrollHomeSection.tsx",
  "apps/web/src/ui/components/AllWorkersHourlyPayCards.tsx",
  "apps/web/src/ui/tabs/HomeTab.parts.tsx",
  "apps/web/src/ui/tabs/PreviewRoutesTab.parts.tsx",
] as const;

describe("section pattern build gate — Dashboard owns the shared behaviour", () => {
  it("still accepts onRefresh / refreshing / timeframe", () => {
    const src = read(DASHBOARD);
    for (const prop of ["onRefresh?", "refreshing?", "timeframe?", "collapsedSummarySlot?"]) {
      expect(src, `Dashboard dropped the \`${prop}\` prop — sections will hand-roll it again`)
        .toContain(prop);
    }
  });

  it("renders children EXACTLY once", () => {
    // Two branches (`{open && …}` + `{!open && <Box display="none">…}`)
    // are different tree positions, so React remounts every child on each
    // toggle and anything that fetches on mount refetches invisibly.
    // Measured before the fix: collapse fired 1 request, expand fired 2.
    const src = read(DASHBOARD);
    const body = src.slice(src.indexOf("GlowContext.Provider"));
    const renders = (body.match(/\{children\}/g) ?? []).length;
    expect(
      renders,
      "Dashboard renders {children} more than once — collapsing will remount and refetch",
    ).toBe(1);
  });

  it("kicks off the expand-refresh from the click, not an effect", () => {
    // An effect runs AFTER paint, so the browser draws one frame of stale
    // data before the overlay appears. The toggle handler batches the
    // open + busy state together, so the first painted frame is correct.
    const src = read(DASHBOARD);
    const toggle = src.slice(src.indexOf("const toggle ="), src.indexOf("const toggle =") + 700);
    expect(toggle, "toggle no longer starts the refresh — the expand flash will return")
      .toMatch(/setExpandPending\(true\)/);
  });

  it("hides the refresh control while collapsed", () => {
    const src = read(DASHBOARD);
    expect(src, "refresh must be gated on `open` — a collapsed refresh does invisible work")
      .toMatch(/\{onRefresh && open && \(/);
  });
});

describe("section pattern build gate — sections don't reinvent it", () => {
  it("no section builds its own timeframe Select", () => {
    for (const rel of SECTION_FILES) {
      const src = code(rel);
      expect(
        src.includes("<Select.Root"),
        `${rel} hand-builds a Select — pass \`timeframe\` to Dashboard instead ` +
          "(see periodTimeframe() in WorkerHourlyPayCard.tsx)",
      ).toBe(false);
    }
  });

  it("no section hand-rolls a collapse toggle", () => {
    // The ▶/▼ text glyph was the tell in every hand-rolled frame.
    for (const rel of SECTION_FILES) {
      expect(code(rel), `${rel} still hand-rolls a collapse chevron`).not.toMatch(/[▶▼]/);
    }
  });

  it("no native <select> in any section file", () => {
    for (const rel of [DASHBOARD, ...SECTION_FILES]) {
      expect(code(rel), `${rel} uses a native <select> — house rule is Chakra Select.Root`)
        .not.toMatch(/<select[\s>]|<option[\s>]/);
    }
  });
});

describe("section pattern — a section refresh refreshes only itself", () => {
  // MY ACTIVITIES' children fetch independently, so its refresh button has
  // to reach them by event. It originally fired `seedlings:workday-changed`
  // — which means "the workday actually changed" and is listened to by
  // OTHER sections (WorkerHourlyPayCard recomputes /api/me/hourly-pay off
  // it). Pressing refresh on one section therefore refreshed several,
  // which is the opposite of what a section-scoped refresh is for.
  it("MY ACTIVITIES refresh uses the scoped event, not a workday change", () => {
    const home = read("apps/web/src/ui/tabs/HomeTab.tsx");
    const fn = home.slice(
      home.indexOf("const refreshActivities"),
      home.indexOf("const refreshTeamOverview"),
    );
    expect(fn, "refreshActivities must exist").toContain("setActivitiesRefreshing");
    expect(fn, "it must use the section-scoped event").toMatch(/bumpMyActivities\(\)/);
    expect(
      fn,
      "broadcasting workday-changed from a refresh button refreshes unrelated sections",
    ).not.toMatch(/workday-changed/);
  });

  it("the pay-per-hour card does NOT listen to the scoped event", () => {
    // It is a different section. If it ever subscribes here, the bug is
    // back with extra steps.
    const card = read("apps/web/src/ui/components/WorkerHourlyPayCard.tsx");
    expect(card).not.toMatch(/my-activities-refresh/);
  });
});
