/**
 * G44 — the tab table and the tabs agree.
 *
 * `apps/web/src/lib/tabRequirements.ts` decides which inner tabs a person
 * sees, from what they can do. It is the ONE capability→UI mapping the web
 * app keeps, because "which tabs exist" has no route to agree with, and a
 * mapping nothing checks is how two parallel documents endpoints — one
 * filtered, one not — drifted into a privilege hole, with the URL deciding
 * the caller's privilege level.
 *
 * So this checks it, in both directions:
 *
 *   1. Every entitlement it names is real. A typo is a tab nobody can ever
 *      see, failing silently and looking like a permissions problem.
 *   2. Every tab rendered in `index.tsx` has a row. A tab added without one
 *      disappears for everybody (`canSeeTab` returns false for an unknown
 *      id, deliberately — the alternative is a tab that defaults to visible
 *      for everybody, which is the wrong way to fail).
 *   3. Every row corresponds to a tab. A renamed tab leaves a dead row that
 *      reads as policy and governs nothing.
 *   4. No row is an empty array. `[]` reads as "needs nothing" and means
 *      "reachable by nobody" — the ALWAYS sentinel exists so those two
 *      cannot look alike.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ENTITLEMENTS } from "@repo/permissions";

const WEB = path.resolve(__dirname, "../../../web");
const TABLE_FILE = path.join(WEB, "src/lib/tabRequirements.ts");
const INDEX_FILE = path.join(WEB, "pages/index.tsx");

/**
 * Tab values in `index.tsx` that are NOT capability-gated inner tabs:
 * the four shells, and the client portal's own tabs. The client portal is
 * gated on being a customer, not on holding anything, so it has no row.
 *
 * Listed explicitly rather than pattern-matched: a new client tab should
 * have to be named here, which is the moment somebody asks whether it is
 * really a client tab.
 */
const NOT_CAPABILITY_GATED = new Set([
  // Shells (navTabs). TWO now: the client portal and staff. There were
  // four — `worker`, `admin` and `super` were the same staff app rendered
  // three ways, which is what made one feature three tabs.
  "client", "staff",
  // Client portal inner tabs.
  "my-jobs", "statements", "public", "client-services", "client-promotions",
]);

function readTable(source?: string) {
  const src = source ?? fs.readFileSync(TABLE_FILE, "utf8");
  const body = src.slice(
    src.indexOf("export const TAB_REQUIREMENTS = {"),
    src.indexOf("} as const satisfies Record<string, TabRequirement>;"),
  );
  expect(body.length, "TAB_REQUIREMENTS literal not found — did its shape change?")
    .toBeGreaterThan(0);

  const rows = new Map<string, string[] | "ALWAYS">();
  for (const m of body.matchAll(/^\s{2}"?([A-Za-z][A-Za-z0-9-]*)"?:\s*(ALWAYS|\[[^\]]*\]),/gm)) {
    const [, id, value] = m;
    if (value === "ALWAYS") rows.set(id, "ALWAYS");
    else rows.set(id, [...value.matchAll(/"([^"]+)"/g)].map((e) => e[1]));
  }
  return rows;
}

function readRenderedTabValues(source?: string) {
  const src = source ?? fs.readFileSync(INDEX_FILE, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/^\s*value:\s*"([A-Za-z][A-Za-z0-9-]*)",/gm)) {
    found.add(m[1]);
  }
  return found;
}

describe("G44 — tab visibility table", () => {
  // ── Negative controls ────────────────────────────────────────────────
  // A gate nobody has watched fail is a gate nobody knows works. These
  // feed the two parsers synthetic input rather than mutating the real
  // files, so the controls run on every build instead of once, by hand,
  // and with the dev server serving a half-broken module.
  describe("the parsers detect what the gate relies on", () => {
    const SYNTHETIC_TABLE = [
      "export const TAB_REQUIREMENTS = {",
      '  home: ["schedule.view"],',
      '  workdays: ["time.view", "time.approve"],',
      '  broken: ["schedule.vieww"],',
      "  nothing: [],",
      "  profile: ALWAYS,",
      '  "tools-mowing": ALWAYS,',
      "} as const satisfies Record<string, TabRequirement>;",
    ].join("\n");

    it("reads every row, including quoted keys and multi-entitlement rows", () => {
      const rows = readTable(SYNTHETIC_TABLE);
      expect([...rows.keys()].sort()).toEqual(
        ["broken", "home", "nothing", "profile", "tools-mowing", "workdays"],
      );
      expect(rows.get("workdays")).toEqual(["time.view", "time.approve"]);
      expect(rows.get("profile")).toBe("ALWAYS");
    });

    it("would fail on a misspelled entitlement", () => {
      const known = new Set<string>(ENTITLEMENTS);
      const bogus = [...readTable(SYNTHETIC_TABLE)]
        .filter(([, need]) => need !== "ALWAYS")
        .flatMap(([id, need]) => (need as string[]).filter((e) => !known.has(e)).map((e) => `${id} → ${e}`));
      expect(bogus).toEqual(["broken → schedule.vieww"]);
    });

    it("would fail on an empty row", () => {
      const empty = [...readTable(SYNTHETIC_TABLE).entries()]
        .filter(([, need]) => need !== "ALWAYS" && (need as string[]).length === 0)
        .map(([id]) => id);
      expect(empty).toEqual(["nothing"]);
    });

    it("reads tab values out of a shell, and would miss none", () => {
      const found = readRenderedTabValues(
        [
          "  const adminTabs: TabItem[] = [",
          "    {",
          '      value: "home",',
          '      label: "Home",',
          "    },",
          "    {",
          '      value: "tools-mowing",',
          "    },",
          "  ];",
        ].join("\n"),
      );
      expect([...found].sort()).toEqual(["home", "tools-mowing"]);
    });
  });

  it("names only real entitlements", () => {
    const rows = readTable();
    const known = new Set<string>(ENTITLEMENTS);
    const bogus: string[] = [];
    for (const [id, need] of rows) {
      if (need === "ALWAYS") continue;
      for (const e of need) if (!known.has(e)) bogus.push(`${id} → ${e}`);
    }
    expect(bogus, "not entitlements — the tab would be invisible to everyone").toEqual([]);
  });

  it("has a row for every tab index.tsx renders", () => {
    const rows = readTable();
    const rendered = readRenderedTabValues();
    const missing = [...rendered].filter(
      (v) => !NOT_CAPABILITY_GATED.has(v) && !rows.has(v),
    );
    expect(missing, "tabs with no row — they are hidden from everybody").toEqual([]);
  });

  it("has no row for a tab that no longer exists", () => {
    const rows = readTable();
    const rendered = readRenderedTabValues();
    // There is no exemption list. `roles` and `areas` had one while those
    // screens were being written; both exist now, so it is gone. Do not
    // reintroduce it — a row with no tab is policy that governs nothing.
    const orphans = [...rows.keys()].filter((id) => !rendered.has(id));
    expect(orphans, "rows governing nothing — delete them or restore the tab").toEqual([]);
  });

  it("uses the ALWAYS sentinel rather than an empty array", () => {
    const rows = readTable();
    const empty = [...rows.entries()]
      .filter(([, need]) => need !== "ALWAYS" && (need as string[]).length === 0)
      .map(([id]) => id);
    expect(empty, "`[]` reads as both 'needs nothing' and 'nobody' — use ALWAYS").toEqual([]);
  });

  it("G36 — the role screens render from the vocabulary, not a local list", () => {
    // A capability must appear in exactly one badged row on a screen, and
    // the cheap way to break that is to hand-write the list. Uniqueness of
    // the vocabulary itself is asserted in permissions.test.ts; what can
    // regress HERE is the role builder and the matrix growing their own
    // copy of it — which is the mistake `PRIV_DEFAULTS` made: a second
    // table of what a role means, which drifted from the first.
    const src = fs.readFileSync(path.join(WEB, "src/ui/tabs/RolesTab.tsx"), "utf8");
    expect(src, "the entitlement list must come from GET /entitlements")
      .toContain('apiGet<{ groups: EntitlementGroup[]; all: string[] }>("/api/entitlements")');
    // No literal entitlement ids: every one shown is a row the server sent.
    // Matched against the real vocabulary, because `"orange.faint"` has the
    // same shape as `"money.approve"` and a dotted-string regex alone
    // reports twenty-two Chakra colour tokens.
    const known = new Set<string>(ENTITLEMENTS);
    const literals = [...src.matchAll(/"([a-z][a-z.-]+)"/g)]
      .map((m) => m[1])
      .filter((e) => known.has(e))
      // The screen legitimately NAMES the two capabilities it gates itself
      // on — that is a check, not a rendered list.
      .filter((e) => e !== "roles.define" && e !== "roles.view");
    expect(literals, "hardcoded entitlement ids — render from the fetched groups")
      .toEqual([]);
  });

  it("the no-access state is reachable", () => {
    // `hasCapabilityTab` must exclude the ALWAYS rows. Counting them makes
    // it permanently true, and the four accounts holding nothing go back to
    // seeing an empty frame — the exact bug it exists to catch.
    const src = fs.readFileSync(TABLE_FILE, "utf8");
    const fn = src.slice(src.indexOf("export function hasCapabilityTab"));
    expect(fn, "hasCapabilityTab must skip ALWAYS rows").toMatch(/need\s*!==\s*ALWAYS/);
  });
});
