/**
 * Portfolio scoping, with the two failure modes that matter.
 *
 * Getting this wrong is silent in both directions:
 *   too loose  → a page renders perfectly with another territory's money in
 *                it, which is the shape of the view-as bug that shipped three
 *                times here
 *   too tight  → a territory's money vanishes, which looks identical to that
 *                territory having earned nothing
 *
 * So `null` (no restriction) and `[]` (sees nothing) are tested as distinct
 * outcomes, never conflated.
 */
import { describe, it, expect } from "vitest";
import {
  visiblePortfolioPaths,
  portfolioWhere,
  portfolioWhereVia,
  isPortfolioLimited,
} from "./portfolioScope";
import { can } from "@repo/permissions";
import type { Entitlement, Principal, RoleGrant } from "@repo/permissions";

/**
 * The shape `portfolioWhere` emits.
 *
 * `some`, because a property belongs to any number of portfolios. This was
 * `{ portfolio: { OR: … } }` against a single column, and the function's
 * return type is `Record<string, unknown>` — so when membership became a
 * list nothing here failed to compile. These assertions are the only thing
 * standing between a stale fragment and an app that silently matches no
 * rows for every scoped reader.
 */
type Shape = {
  portfolios: { some: { portfolio: { OR: Array<{ path: { startsWith: string } }> } } };
};

const NC = "/nc/";
const TRIANGLE = "/nc/triangle/";
const RALEIGH = "/nc/triangle/raleigh/";
const DURHAM = "/nc/triangle/durham/";

/** On payroll by default — the payroll gate is checked first, so a null
 *  worker type would make every assertion below pass for the wrong reason.
 *  It gets its own test instead. */
const user = (over: Partial<Extract<Principal, { kind: "user" }>> = {}): Principal => ({
  kind: "user",
  workerType: "EMPLOYEE",
  roles: [],
  perspective: null,
  ...over,
});

/** A role held company-wide: nothing to narrow. */
const global_ = (...entitlements: Entitlement[]): RoleGrant => ({
  roleId: "r-global",
  name: "Bookkeeper",
  entitlements,
});

/** The same role held only inside a portfolio subtree. */
const inArea = (portfolioPath: string, ...entitlements: Entitlement[]): RoleGrant => ({
  roleId: `r-${portfolioPath}`,
  name: "District Manager",
  portfolioPath,
  entitlements,
});

describe("visiblePortfolioPaths — null and [] are different answers", () => {
  it("a company-wide role returns null, not a list", () => {
    // Held company-wide, so there is nothing to narrow.
    expect(visiblePortfolioPaths(user({ roles: [global_("money.view")] }), "money.view")).toBeNull();
  });

  it("a second company-wide role is just as global", () => {
    expect(
      visiblePortfolioPaths(user({ roles: [global_("money.view")] }), "money.view"),
    ).toBeNull();
  });

  it("a portfolio-only grant returns exactly that subtree", () => {
    const p = user({ roles: [inArea(RALEIGH, "money.view")] });
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([RALEIGH]);
  });

  it("several assignments return all of them", () => {
    const p = user({
      roles: [
        inArea(RALEIGH, "money.view"),
        inArea(DURHAM, "money.view"),
      ],
    });
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([RALEIGH, DURHAM]);
  });

  it("holding it nowhere returns [], which is NOT null", () => {
    const p = user({ roles: [inArea(RALEIGH, "schedule.view")] });
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([]);
  });

  it("a global grant is not caged by also holding a portfolio grant", () => {
    // The rule that stops an assignment demoting someone with `schedule.manage`.
    const p = user({
      roles: [global_("money.view"), inArea(RALEIGH, "money.view")],
    });
    expect(visiblePortfolioPaths(p, "money.view")).toBeNull();
  });

  it("a user with no worker type sees nothing, and that is NOT null", () => {
    // The payroll gate. Nothing resolves for them, so there is nothing to
    // scope — but the answer must be [] (an impossible condition) rather than
    // null (no restriction), or a pending user reads the whole book.
    const pending = user({ workerType: null, roles: [global_("money.view")] });
    expect(visiblePortfolioPaths(pending, "money.view")).toEqual([]);
    expect(portfolioWhere(pending, "money.view")).toEqual({ portfolios: { none: {} } });
  });

  it("no principal means no narrowing", () => {
    expect(visiblePortfolioPaths(undefined, "money.view")).toBeNull();
  });

  it("the SYSTEM principal is not territorial", () => {
    const sys: Principal = { kind: "system", name: "cron:chain-rollover" };
    expect(visiblePortfolioPaths(sys, "money.view")).toBeNull();
  });
});

describe("field capability is never narrowed", () => {
  it("work.claim is not scoped even for a portfolio-assigned worker", () => {
    // Promotion must not shrink where you can work (G11).
    const p = user({ roles: [inArea(RALEIGH, "work.claim", "schedule.manage")] });
    expect(visiblePortfolioPaths(p, "work.claim")).toBeNull();
  });
});

describe("portfolioWhere — the Prisma fragment", () => {
  it("is EMPTY for global authority, so the query is byte-identical", () => {
    // Invariant 1. An extra `where` key on an unrestricted read is a
    // behaviour change disguised as a feature flag.
    expect(portfolioWhere(user({ roles: [global_("money.view")] }), "money.view")).toEqual({});
  });

  it("prefix-matches the subtree for a portfolio grant", () => {
    const p = user({ roles: [inArea(TRIANGLE, "money.view")] });
    expect(portfolioWhere(p, "money.view")).toEqual({
      portfolios: { some: { portfolio: { OR: [{ path: { startsWith: TRIANGLE } }] } } },
    });
  });

  it("is an impossible condition when the capability is held nowhere", () => {
    // NOT an empty where — that would silently return everything to someone
    // entitled to nothing.
    const p = user({ roles: [inArea(RALEIGH, "schedule.view")] });
    expect(portfolioWhere(p, "money.view")).toEqual({ portfolios: { none: {} } });
  });

  it("nests under a relation with portfolioWhereVia", () => {
    const p = user({ roles: [inArea(RALEIGH, "money.view")] });
    expect(portfolioWhereVia(p, "money.view", "job")).toEqual({
      job: { portfolios: { some: { portfolio: { OR: [{ path: { startsWith: RALEIGH } }] } } } },
    });
  });

  it("portfolioWhereVia stays empty for global authority", () => {
    expect(portfolioWhereVia(user({ roles: [global_("money.view")] }), "money.view", "job")).toEqual({});
  });
});

describe("the prefix rule", () => {
  it("a parent grant covers its children", () => {
    const p = user({ roles: [inArea(TRIANGLE, "money.view")] });
    const where = portfolioWhere(p, "money.view") as Shape;
    const prefix = where.portfolios.some.portfolio.OR[0].path.startsWith;
    expect(RALEIGH.startsWith(prefix)).toBe(true);
    expect(DURHAM.startsWith(prefix)).toBe(true);
  });

  it("a child grant does not reach its parent", () => {
    const p = user({ roles: [inArea(RALEIGH, "money.view")] });
    const where = portfolioWhere(p, "money.view") as Shape;
    const prefix = where.portfolios.some.portfolio.OR[0].path.startsWith;
    expect(TRIANGLE.startsWith(prefix)).toBe(false);
    expect(NC.startsWith(prefix)).toBe(false);
  });

  it("does not leak into a sibling whose id starts the same", () => {
    // The bug the trailing delimiter exists to prevent.
    const p = user({ roles: [inArea("/a/b/", "money.view")] });
    const where = portfolioWhere(p, "money.view") as Shape;
    const prefix = where.portfolios.some.portfolio.OR[0].path.startsWith;
    expect("/a/bb/".startsWith(prefix)).toBe(false);
    expect("/a/b/c/".startsWith(prefix)).toBe(true);
  });
});

describe("isPortfolioLimited", () => {
  it("is false for global authority and true for a portfolio grant", () => {
    expect(isPortfolioLimited(user({ roles: [global_("money.view")] }), "money.view")).toBe(false);
    expect(
      isPortfolioLimited(
        user({ roles: [inArea(RALEIGH, "money.view")] }),
        "money.view",
      ),
    ).toBe(true);
  });
});

describe("G16 — moving a visit needs authority in BOTH portfolios", () => {
  // The rule, as a set of outcomes. The service does this with two `can`
  // calls carrying different areaPaths; these assert the DECISIONS, so a
  // refactor that keeps the rule keeps the test.
  const DURHAM = "/nc/triangle/durham/";
  const CHAPEL = "/nc/triangle/chapel-hill/";
  const TRIANGLE = "/nc/triangle/";

  const manages = (...paths: string[]): Principal => ({
    kind: "user",
    workerType: "EMPLOYEE",
    perspective: null,
    roles: paths.map((p, i) => ({
      roleId: `r${i}`,
      name: "District Manager",
      portfolioPath: p,
      entitlements: ["schedule.manage"],
    })),
  });

  const mayMove = (p: Principal, from: string, to: string) =>
    can(p, "schedule.manage", { portfolioPath: from }) &&
    can(p, "schedule.manage", { portfolioPath: to });

  it("allows a move between two portfolios the person runs", () => {
    expect(mayMove(manages(DURHAM, CHAPEL), DURHAM, CHAPEL)).toBe(true);
  });

  it("refuses pulling work IN from a portfolio they do not run", () => {
    // The revenue-grab: they run Chapel Hill and want Durham's job on their
    // own books. Destination-only would have allowed it.
    const p = manages(CHAPEL);
    expect(can(p, "schedule.manage", { portfolioPath: CHAPEL })).toBe(true);
    expect(mayMove(p, DURHAM, CHAPEL)).toBe(false);
  });

  it("refuses pushing work OUT to a portfolio they do not run", () => {
    // The mirror image: shed a loss onto somebody else's books.
    const p = manages(DURHAM);
    expect(can(p, "schedule.manage", { portfolioPath: DURHAM })).toBe(true);
    expect(mayMove(p, DURHAM, CHAPEL)).toBe(false);
  });

  it("a parent-portfolio manager may move between its children", () => {
    // Holding the Triangle covers both districts beneath it, so this person
    // is answerable for both sides and the move is legitimate.
    expect(mayMove(manages(TRIANGLE), DURHAM, CHAPEL)).toBe(true);
  });

  it("a company-wide holder may move anywhere", () => {
    const global: Principal = {
      kind: "user", workerType: "EMPLOYEE", perspective: null,
      roles: [{ roleId: "g", name: "Ops", entitlements: ["schedule.manage"] }],
    };
    expect(mayMove(global, DURHAM, CHAPEL)).toBe(true);
  });

  it("a narrowed perspective cannot move what the perspective hides", () => {
    // Looking through a perspective that does not include schedule.manage must not
    // allow a move, even though the person really holds it. This is why the
    // service takes the resolved principal instead of looking the caller up.
    const narrowed: Principal = {
      ...(manages(DURHAM, CHAPEL) as Extract<Principal, { kind: "user" }>),
      perspective: { roleId: "r-field", entitlements: ["work.claim"] },
    };
    expect(mayMove(narrowed, DURHAM, CHAPEL)).toBe(false);
  });
});

/**
 * THE LENS — "show me only Durham", chosen by the viewer.
 *
 * A grant and a lens pull in opposite directions and this is where they
 * meet. Both failure modes from the top of this file apply, and one more
 * that is specific to the lens: it must be incapable of WIDENING. A
 * Durham-only lead who sends a Chapel Hill lens must see nothing — not
 * Chapel Hill, and not a silently-ignored header that hands them their
 * full Durham view while the UI says they are looking at Chapel Hill.
 */
describe("the portfolio lens narrows, and can never widen", () => {
  const CHAPEL = "/nc/triangle/chapel-hill/";
  const lensed = (lensPath: string, ...roles: RoleGrant[]): Principal =>
    user({ roles, lensPath });

  it("no lens leaves a global reader completely unfiltered", () => {
    // The off-state must stay byte-identical to pre-feature behaviour.
    const p = user({ roles: [global_("money.view")] });
    expect(visiblePortfolioPaths(p, "money.view")).toBeNull();
    expect(portfolioWhere(p, "money.view")).toEqual({});
  });

  it("a global reader looking at one district sees that district", () => {
    const p = lensed(DURHAM, global_("money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([DURHAM]);
  });

  it("a lens on an ancestor of your grant leaves the grant, not the ancestor", () => {
    // A Raleigh lead asking to look at the whole region still sees Raleigh.
    // Taking the lens literally here would hand them the region.
    const p = lensed(TRIANGLE, inArea(RALEIGH, "money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([RALEIGH]);
  });

  it("a lens on a descendant of your grant narrows to the descendant", () => {
    const p = lensed(RALEIGH, inArea(TRIANGLE, "money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([RALEIGH]);
  });

  it("A LENS OUTSIDE YOUR GRANTS SHOWS NOTHING, never that territory", () => {
    // The security property. A crafted header is a way to see less.
    const p = lensed(CHAPEL, inArea(DURHAM, "money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([]);
    expect(portfolioWhere(p, "money.view")).toEqual({ portfolios: { none: {} } });
  });

  it("a sibling prefix is not a match", () => {
    // "/nc/triangle/durham/" must not be reached by a lens on
    // "/nc/triangle/durh/" — the trailing delimiter is what stops it.
    const p = lensed("/nc/triangle/durh/", inArea(DURHAM, "money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([]);
  });

  it("a lens cannot conjure a capability you do not hold", () => {
    // Holding nothing relevant is [] before the lens and [] after it.
    const p = lensed(DURHAM, global_("schedule.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([]);
  });

  it("a lens still narrows the LIST for a never-portfolio-scoped capability", () => {
    // `work.claim` is never narrowed BY A GRANT, so cover across districts
    // keeps working. A lens is the viewer's own request, so it does apply
    // to what they are shown — and because nothing here feeds `can()`, the
    // Chapel Hill visit they open by its link is still claimable.
    const p = lensed(DURHAM, global_("work.claim"));
    expect(visiblePortfolioPaths(p, "work.claim")).toEqual([DURHAM]);
    expect(can(p, "work.claim")).toBe(true);
  });

  it("a lens does not rescue a capability the payroll gate already refused", () => {
    // workerType null resolves to nothing BEFORE any portfolio logic runs.
    const p = user({ workerType: null, roles: [global_("money.view")], lensPath: DURHAM });
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([]);
  });

  it("the system principal is not territorial, lens or no lens", () => {
    // Cron has no viewer, so there is nobody to have chosen a lens.
    expect(visiblePortfolioPaths({ kind: "system", name: "cron" }, "money.view")).toBeNull();
  });

  it("two grants intersect independently", () => {
    // Held in Raleigh AND Durham, looking at Durham: only Durham survives.
    const p = lensed(DURHAM, inArea(RALEIGH, "money.view"), inArea(DURHAM, "money.view"));
    expect(visiblePortfolioPaths(p, "money.view")).toEqual([DURHAM]);
  });
});
