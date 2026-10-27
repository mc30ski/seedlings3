/** Lives in apps/api rather than beside the package because vitest runs
 *  from this workspace — the same reason web-date-helpers.test.ts tests
 *  apps/web code from here. */
/**
 * can() MECHANICS.
 *
 * Pure throughout — no database, no Clerk, no clock. That is the whole point
 * of the module: the server decides whether a route may run and the browser
 * decides whether to draw the button, and one implementation means those two
 * cannot disagree.
 *
 * WHAT THIS FILE IS NOT: the persona outcome matrix. That matrix asserts
 * things like "Jake holds schedule.manage in Raleigh and nowhere else", and
 * every one of its answers depends on the STARTER ROLE SET being right. The
 * starter set is data a script writes, not a constant in the source, so its
 * contents are asserted where that script is tested. Here we assert only what
 * holds for ANY role set: the payroll gate, union semantics, the area prefix
 * rule, the never-area-scoped set, inheritance, perspectives, the system
 * bypass, and the vocabulary itself.
 */
import { describe, it, expect } from "vitest";
import {
  can,
  coversArea,
  heldCapabilities,
  flattenRole,
  isValidPerspective,
  ENTITLEMENTS,
  ENTITLEMENT_GROUPS,
  assertEntitlement,
  isEntitlement,
  refusalPhrase,
  type Principal,
  type RoleGrant,
  type RoleDefinition,
  type Entitlement,
} from "@repo/permissions";

// Synthetic area paths. Real ones are cuids; the only property that matters
// is that they are opaque ids delimited and terminated by "/".
const NC = "/nc/";
const TRIANGLE = "/nc/triangle/";
const RALEIGH = "/nc/triangle/raleigh/";
const DURHAM = "/nc/triangle/durham/";

/** A principal who IS on payroll. Worker type is supplied by default because
 *  the gate is checked first and a null one would make every other assertion
 *  in this file pass for the wrong reason. */
function user(over: Partial<Extract<Principal, { kind: "user" }>> = {}): Principal {
  return { kind: "user", workerType: "EMPLOYEE", roles: [], perspective: null, ...over };
}

/** A role held company-wide. */
const role = (name: string, ...entitlements: Entitlement[]): RoleGrant => ({
  roleId: `r-${name}`,
  name,
  entitlements,
});

/** The same role held only inside an area subtree. */
const inArea = (areaPath: string, name: string, ...entitlements: Entitlement[]): RoleGrant => ({
  ...role(name, ...entitlements),
  areaPath,
});

describe("the entitlement vocabulary", () => {
  it("has 65 entitlements, unique, grouped", () => {
    // 65 since `settings.view` split off `settings.manage` — the Settings
    // tab had no way to be opened read-only, so "see the rates" and
    // "change the rates" were one grant.
    // 64 since `reports.business` split off `reports.view` (the team
    // rollup an admin needs vs the business-wide Insights card), after
    // `equipment.capital` and `marketing.campaigns` split the
    // owner's half out of two entitlements that spanned two authorities.
    // A 2026-10-19 audit against the pre-cutover role guards found the
    // single versions handed Admin 45 writes that had always been
    // superGuard — promotions, vanity pages, and putting equipment on the
    // books — while no bundling could take them away without also removing
    // 26 routes an admin uses daily. Splitting is what let the ladder match
    // the roles it replaced.
    // 61 since `roles.view` split SEEING the role catalogue from EDITING
    // it. `roles.define` guarded `GET /roles`, so somebody holding
    // `people.grant-roles` — which the design deliberately separates, "an
    // office manager may well need the second without the first" — could
    // not list the roles they were allowed to hand out. The picker could
    // not be built against the old gating.
    // 51 → 55 when the money and tax capabilities were split. Four of them
    // guarded routes at two strictness levels, so one entitlement could not
    // express both: money.adjust, books.export-tax, time.manage and
    // supplies.hold exist to keep "approve a payment" and "download the tax
    // filings" separate from the day-to-day work they used to travel with.
    // 60 since `timeline.view` / `timeline.manage` gave the company
    // timeline its own vocabulary: its reads had been on `schedule.view`,
    // which every trainee holds, while a `/timeline` twin revealed
    // admin-hidden events to them.
    // 58 since `clients.view-as` split reading a customer's portal AS them
    // out of `identity.link`, which is admin-tier data entry.
    // 57 since `people.approve` split admission out of `people.manage`:
    // approving a sign-up decides whether somebody is in the system at all,
    // which someone with `schedule.manage` editing profiles should not imply.
    // 56 since `content.approve` split publishing authority out of
    // `content.manage` — education.md makes approving a guide `content.approve`
    // ("Holders of `schedule.manage` cannot publish their own work, deliberately") and both tiers
    // had been pointed at one entitlement.
    expect(ENTITLEMENTS).toHaveLength(65);
    // Uniqueness measured against the array itself, not a second copy of
    // the number. Two hardcoded counts for one fact drift: this one still
    // said 60 after the line above was updated to 61, and the failure
    // reported "expected 61 to be 60", which reads like the vocabulary is
    // wrong rather than the test.
    expect(new Set(ENTITLEMENTS).size).toBe(ENTITLEMENTS.length);
    expect(ENTITLEMENT_GROUPS.length).toBeGreaterThan(1);
  });

  it("every group's entitlements appear in the flat list, and vice versa", () => {
    // A role builder renders from the GROUPS and `can()` gates on the LIST.
    // An entitlement in one and not the other is either ungrantable or
    // invisible, and both failures are silent.
    const grouped = ENTITLEMENT_GROUPS.flatMap((g) => g.entitlements.map((e) => e.id));
    expect([...grouped].sort()).toEqual([...ENTITLEMENTS].sort());
  });

  it("every id is dotted lower-case with a verb", () => {
    for (const e of ENTITLEMENTS) expect(e).toMatch(/^[a-z]+\.[a-z-]+$/);
  });

  it("every entitlement carries role-builder copy", () => {
    for (const g of ENTITLEMENT_GROUPS) {
      for (const e of g.entitlements) {
        expect(e.copy.length, `${e.id} has no copy`).toBeGreaterThan(10);
        // Markdown entities would render literally in a checkbox label.
        expect(e.copy, `${e.id} copy carries an HTML entity`).not.toMatch(/&[a-z]+;/);
      }
    }
  });

  it("isEntitlement accepts members and rejects near-misses", () => {
    expect(isEntitlement("money.approve")).toBe(true);
    expect(isEntitlement("money.aprove")).toBe(false); // the typo that motivates G28
    expect(isEntitlement("MONEY.APPROVE")).toBe(false);
    expect(isEntitlement("money")).toBe(false);
    expect(isEntitlement(undefined)).toBe(false);
  });

  it("assertEntitlement throws on a value outside the union", () => {
    expect(() => assertEntitlement("money.approve")).not.toThrow();
    expect(() => assertEntitlement("money.aprove")).toThrow(/Not an entitlement/);
  });
});

describe("the payroll gate", () => {
  // Being in the system is not being cleared to act in it. Until someone
  // decides HOW a person is paid, they hold nothing — however many roles are
  // attached to them. This is checked before anything else, so a mis-ordered
  // refactor shows up here rather than as a quiet grant in production.
  it("a user with no worker type holds nothing, whatever roles they carry", () => {
    const pending = user({
      workerType: null,
      roles: [role("Owner", "money.approve", "books.manage", "roles.define")],
    });
    expect(can(pending, "money.approve")).toBe(false);
    expect(can(pending, "books.manage")).toBe(false);
    expect(heldCapabilities(pending)).toEqual([]);
  });

  it("the same roles resolve the moment a worker type is set", () => {
    const roles = [role("Owner", "money.approve")];
    expect(can(user({ workerType: null, roles }), "money.approve")).toBe(false);
    expect(can(user({ workerType: "EMPLOYEE", roles }), "money.approve")).toBe(true);
    expect(can(user({ workerType: "CONTRACTOR", roles }), "money.approve")).toBe(true);
    // UNPAID is a real worker type — not on payroll, but cleared to act. It is
    // the wife-with-app-access case, and it must NOT be gated like a pending
    // user, or the whole reason the type exists disappears.
    expect(can(user({ workerType: "UNPAID", roles }), "money.approve")).toBe(true);
  });
});

describe("can() — union semantics", () => {
  it("denies by default", () => {
    expect(can(user(), "money.approve")).toBe(false);
  });

  it("grants from a role the person holds", () => {
    expect(can(user({ roles: [role("Bookkeeper", "books.manage")] }), "books.manage")).toBe(true);
  });

  it("unions across roles rather than intersecting them", () => {
    const p = user({
      roles: [role("Dispatcher", "schedule.manage"), role("Bookkeeper", "books.manage")],
    });
    expect(can(p, "schedule.manage")).toBe(true);
    expect(can(p, "books.manage")).toBe(true);
  });

  it("a role grants nothing it does not list", () => {
    expect(can(user({ roles: [role("Dispatcher", "schedule.manage")] }), "money.approve")).toBe(false);
  });

  it("a system principal bypasses entitlements entirely", () => {
    const sys: Principal = { kind: "system", name: "cron:chain-rollover" };
    expect(can(sys, "money.approve")).toBe(true);
    // ...but holds nothing to display, so it never populates a UI.
    expect(heldCapabilities(sys)).toEqual([]);
  });
});

describe("can() — areas", () => {
  it("an area-held role applies inside its own subtree", () => {
    const p = user({ roles: [inArea(RALEIGH, "District Manager", "schedule.manage")] });
    expect(can(p, "schedule.manage", { areaPath: RALEIGH })).toBe(true);
  });

  it("and not in a sibling", () => {
    const p = user({ roles: [inArea(RALEIGH, "District Manager", "schedule.manage")] });
    expect(can(p, "schedule.manage", { areaPath: DURHAM })).toBe(false);
  });

  it("a parent assignment covers the whole subtree", () => {
    const p = user({ roles: [inArea(TRIANGLE, "Regional", "money.approve")] });
    expect(can(p, "money.approve", { areaPath: RALEIGH })).toBe(true);
    expect(can(p, "money.approve", { areaPath: DURHAM })).toBe(true);
  });

  it("a child assignment does NOT cover its parent", () => {
    const p = user({ roles: [inArea(RALEIGH, "District Manager", "money.approve")] });
    expect(can(p, "money.approve", { areaPath: TRIANGLE })).toBe(false);
    expect(can(p, "money.approve", { areaPath: NC })).toBe(false);
  });

  it("a globally-held role is never caged by an area", () => {
    // The rule that stops an area assignment demoting someone. An assignment
    // can only ever ADD places you can see.
    const p = user({
      roles: [
        role("Bookkeeper", "books.manage"),
        inArea(RALEIGH, "District Manager", "schedule.manage"),
      ],
    });
    expect(can(p, "books.manage", { areaPath: DURHAM })).toBe(true);
  });

  it("field capability is never narrowed by area", () => {
    // Promotion must not shrink where you can work. Someone looking after
    // Raleigh still covers a Durham visit when a crewmate calls out.
    const p = user({
      roles: [inArea(RALEIGH, "Field Worker", "work.claim", "work.complete", "schedule.manage")],
    });
    expect(can(p, "work.claim", { areaPath: DURHAM })).toBe(true);
    expect(can(p, "work.complete", { areaPath: DURHAM })).toBe(true);
    // Everything else in the same role IS narrowed.
    expect(can(p, "schedule.manage", { areaPath: DURHAM })).toBe(false);
  });

  it("an area-held capability counts when the request names no area", () => {
    const p = user({ roles: [inArea(RALEIGH, "District Manager", "reports.view")] });
    expect(can(p, "reports.view")).toBe(true);
  });
});

describe("coversArea", () => {
  it("matches self and descendants", () => {
    expect(coversArea(TRIANGLE, TRIANGLE)).toBe(true);
    expect(coversArea(TRIANGLE, RALEIGH)).toBe(true);
  });

  it("does not match ancestors or siblings", () => {
    expect(coversArea(RALEIGH, TRIANGLE)).toBe(false);
    expect(coversArea(RALEIGH, DURHAM)).toBe(false);
  });

  it("does not match an id that merely starts the same", () => {
    // The bug the trailing delimiter exists to prevent: without it, "/a/b"
    // prefix-matches "/a/bb" and a grant leaks into a sibling territory.
    expect(coversArea("/a/b/", "/a/bb/")).toBe(false);
    expect(coversArea("/a/b/", "/a/b/c/")).toBe(true);
  });

  it("refuses an undelimited path rather than guessing", () => {
    expect(() => coversArea("/a/b", "/a/b/c/")).toThrow(/delimited and terminated/);
    expect(() => coversArea("/a/b/", "/a/b/c")).toThrow(/delimited and terminated/);
  });
});

describe("flattenRole — inheritance", () => {
  const defs = (list: RoleDefinition[]) => new Map(list.map((r) => [r.id, r]));

  it("collects a parent's entitlements into the child", () => {
    // The reason inheritance exists: adding a capability to a base role
    // reaches everything built on it, instead of an operator maintaining
    // duplicated sets by hand until they drift.
    const byId = defs([
      { id: "trainee", name: "Trainee", entitlements: ["work.claim"] },
      { id: "worker", name: "Worker", inheritsFromId: "trainee", entitlements: ["work.complete"] },
    ]);
    expect(flattenRole("worker", byId)).toEqual(["work.claim", "work.complete"]);
  });

  it("walks a chain of any depth and de-duplicates", () => {
    const byId = defs([
      { id: "a", name: "A", entitlements: ["work.claim"] },
      { id: "b", name: "B", inheritsFromId: "a", entitlements: ["work.claim", "work.complete"] },
      { id: "c", name: "C", inheritsFromId: "b", entitlements: ["money.view"] },
    ]);
    expect(flattenRole("c", byId)).toEqual(["money.view", "work.claim", "work.complete"]);
  });

  it("a parent does NOT inherit from its child", () => {
    const byId = defs([
      { id: "base", name: "Base", entitlements: ["work.claim"] },
      { id: "sub", name: "Sub", inheritsFromId: "base", entitlements: ["money.approve"] },
    ]);
    expect(flattenRole("base", byId)).toEqual(["work.claim"]);
  });

  it("throws on a cycle rather than resolving to a partial set", () => {
    // A partial resolution would grant the wrong answer silently, forever.
    const byId = defs([
      { id: "x", name: "X", inheritsFromId: "y", entitlements: ["work.claim"] },
      { id: "y", name: "Y", inheritsFromId: "x", entitlements: ["money.approve"] },
    ]);
    expect(() => flattenRole("x", byId)).toThrow(/cycle/);
  });

  it("throws on a self-cycle", () => {
    const byId = defs([{ id: "s", name: "S", inheritsFromId: "s", entitlements: [] }]);
    expect(() => flattenRole("s", byId)).toThrow(/cycle/);
  });

  it("stops at a dangling parent instead of throwing", () => {
    // A deleted parent is a data problem, but the child's OWN entitlements
    // are still knowable and still correct. Refusing them would lock people
    // out over a broken pointer.
    const byId = defs([
      { id: "orphan", name: "Orphan", inheritsFromId: "gone", entitlements: ["work.claim"] },
    ]);
    expect(flattenRole("orphan", byId)).toEqual(["work.claim"]);
  });
});

describe("perspectives", () => {
  // A perspective is a named SUBSET of what someone holds, so they can see
  // the app as a person with less access sees it. It may only ever NARROW —
  // if a "downgrade" could grant, the entire feature is unsafe.
  const owner = () =>
    user({
      roles: [role("Owner", "money.approve", "books.manage", "schedule.manage", "work.claim")],
    });

  it("narrows to the chosen subset", () => {
    const p = user({
      ...(owner() as Extract<Principal, { kind: "user" }>),
      perspective: { roleId: "r-Field", entitlements: ["work.claim"] },
    });
    expect(can(p, "work.claim")).toBe(true);
    expect(can(p, "money.approve")).toBe(false);
    expect(can(p, "books.manage")).toBe(false);
  });

  it("cannot grant what the person does not hold", () => {
    // Belt as well as braces: isValidPerspective refuses the selection, and
    // can() would still not answer yes if a bad one reached it.
    const p = user({
      roles: [role("Dispatcher", "schedule.manage")],
      perspective: { roleId: "r-Owner", entitlements: ["money.approve", "schedule.manage"] },
    });
    expect(can(p, "money.approve")).toBe(false);
    expect(can(p, "schedule.manage")).toBe(true);
  });

  it("heldCapabilities reports the narrowed set, not the real one", () => {
    // What the UI draws must match what the routes will accept, or a button
    // appears for an action the server refuses.
    const p = user({
      ...(owner() as Extract<Principal, { kind: "user" }>),
      perspective: { roleId: "r-Field", entitlements: ["work.claim"] },
    });
    expect(heldCapabilities(p)).toEqual(["work.claim"]);
  });

  it("isValidPerspective accepts a subset and refuses anything wider", () => {
    const p = owner();
    expect(isValidPerspective(p, ["work.claim"])).toBe(true);
    expect(isValidPerspective(p, ["work.claim", "schedule.manage"])).toBe(true);
    expect(isValidPerspective(p, [])).toBe(true); // the client perspective holds nothing
    expect(isValidPerspective(p, ["payroll.manage"])).toBe(false);
    expect(isValidPerspective(p, ["work.claim", "payroll.manage"])).toBe(false);
  });

  it("validity is judged against the REAL set, not the active perspective", () => {
    // Otherwise switching to a narrow perspective would trap you there: every wider
    // perspective you actually hold would be judged a grant and refused.
    const narrowed = user({
      ...(owner() as Extract<Principal, { kind: "user" }>),
      perspective: { roleId: "r-Field", entitlements: ["work.claim"] },
    });
    expect(isValidPerspective(narrowed, ["money.approve"])).toBe(true);
  });

  it("a system principal has no perspective to adopt", () => {
    expect(isValidPerspective({ kind: "system", name: "cron" }, [])).toBe(false);
  });

  it("an area-held role still narrows by area under a perspective", () => {
    const p = user({
      roles: [inArea(RALEIGH, "District Manager", "schedule.manage")],
      perspective: { roleId: "r-DM", entitlements: ["schedule.manage"] },
    });
    expect(can(p, "schedule.manage", { areaPath: RALEIGH })).toBe(true);
    expect(can(p, "schedule.manage", { areaPath: DURHAM })).toBe(false);
  });
});

describe("heldCapabilities", () => {
  it("unions every role and sorts", () => {
    const p = user({
      roles: [
        role("Bookkeeper", "payroll.view"),
        inArea(RALEIGH, "District Manager", "money.view"),
        inArea(DURHAM, "District Manager", "money.view"),
      ],
    });
    expect(heldCapabilities(p)).toEqual(["money.view", "payroll.view"]);
  });

  it("ignores area entirely — it answers WHAT, never WHERE", () => {
    // Which is exactly why it must not be used for gating: a gate asks about
    // one capability and may carry an area, and answering through this would
    // silently drop it.
    const p = user({ roles: [inArea(RALEIGH, "District Manager", "money.approve")] });
    expect(heldCapabilities(p)).toEqual(["money.approve"]);
    expect(can(p, "money.approve", { areaPath: DURHAM })).toBe(false);
  });
});

describe("G6 — you cannot grant what you do not hold", () => {
  // The escalation this blocks, concretely: an operator is given
  // `roles.define` so they can tidy up role names. Without a held-set check
  // they can instead create "Office Helper" containing `books.export-tax`,
  // have somebody assign it to them, and walk away with the tax filings.
  //
  // The rule is a subset test, and it is the same shape as a perspective's:
  // a grant may only ever pass on what the grantor already has.
  const mayGrant = (held: readonly Entitlement[], wanted: readonly Entitlement[]) => {
    const h = new Set(held);
    return wanted.every((e) => h.has(e));
  };

  it("allows granting a subset of what the actor holds", () => {
    expect(mayGrant(["schedule.view", "schedule.manage"], ["schedule.view"])).toBe(true);
    expect(mayGrant(["schedule.view"], ["schedule.view"])).toBe(true);
    expect(mayGrant(["schedule.view"], [])).toBe(true);
  });

  it("refuses anything beyond it, however small", () => {
    expect(mayGrant(["schedule.view"], ["schedule.manage"])).toBe(false);
    // The dangerous shape: mostly legitimate, one smuggled in.
    expect(
      mayGrant(["schedule.view", "schedule.manage"], ["schedule.view", "books.export-tax"]),
    ).toBe(false);
  });

  it("an empty held set can grant nothing", () => {
    // Somebody with no worker type resolves to zero capabilities (the
    // payroll gate), so they must not be able to define a role that grants
    // anything either.
    expect(mayGrant([], ["schedule.view"])).toBe(false);
  });

  it("the set that matters is the INHERITED one", () => {
    // Granting a role grants everything in it, parents included. Checking a
    // role's own entitlements would miss exactly where the powerful ones
    // live: Super's own set is 18 entitlements, its effective set is 54.
    const byId = new Map<string, RoleDefinition>([
      ["base", { id: "base", name: "Base", entitlements: ["books.export-tax"] }],
      ["child", { id: "child", name: "Child", inheritsFromId: "base", entitlements: ["schedule.view"] }],
    ]);
    const own = byId.get("child")!.entitlements;
    const effective = flattenRole("child", byId);

    // An actor holding only schedule.view passes on the OWN set and fails on
    // the effective one — which is why the service flattens first.
    expect(mayGrant(["schedule.view"], own)).toBe(true);
    expect(mayGrant(["schedule.view"], effective)).toBe(false);
  });
});

describe("refusalPhrase — every refusal reads as a sentence", () => {
  // The web renders "You don't have permission to ${refusalPhrase(e)}." for
  // any 403 the guard names. There is no web test runner, so the rule is
  // locked here, over the real copy, for every entitlement at once.
  it("names an action, never a bare verb", () => {
    // "create." and "approve." were the output of an earlier rule that cut
    // at the first comma: four entitlements open with a list of verbs, and
    // a refusal that names no object tells the reader nothing.
    const tooShort = ENTITLEMENTS.filter(
      (e) => (refusalPhrase(e) ?? "").split(/\s+/).length < 3,
    ).map((e) => `${e}="${refusalPhrase(e)}"`);
    expect(tooShort).toEqual([]);
  });

  it("covers every entitlement, and starts lowercase to sit mid-sentence", () => {
    const broken = ENTITLEMENTS.filter((e) => {
      const p = refusalPhrase(e);
      return !p || /^[A-Z]/.test(p) || p.endsWith(".");
    });
    expect(broken).toEqual([]);
  });

  it("drops the em-dash aside and the area-scopable marker", () => {
    // Both are documentation for the role builder's reader, not part of
    // the action being refused.
    expect(refusalPhrase("books.export-tax")).toBe("download the tax exports");
    expect(refusalPhrase("people.view")).toBe("see the team and who is working");
  });

  it("returns null for an id that is not an entitlement", () => {
    // The caller falls back to a generic sentence — a raw entitlement name
    // must never be printed at a person.
    expect(refusalPhrase("schedule.vieww")).toBeNull();
  });
});
