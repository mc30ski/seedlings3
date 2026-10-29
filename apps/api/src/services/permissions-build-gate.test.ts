import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * G1–G26 — the permissions / roles / portfolios design, enforced.
 *
 * Spec: docs/features/permissions.md · Checklist: permissions-BUILD.md
 *
 * REGISTERED in `test:build-gate`. Gates whose subject does not exist yet
 * are `skip`/`todo`, which do not fail a run — so this file is green today
 * and each gate activates by itself as its subject appears. No separate
 * pending file to remember to merge.
 *
 * Gates whose subject does not exist yet skip with a stated reason rather
 * than passing vacuously — a green tick for an absent thing is worse than a
 * skip, because it reads as coverage.
 */

const API = path.resolve(__dirname, "..");
const WEB = path.resolve(__dirname, "../../../web");
const SCHEMA = path.resolve(__dirname, "../../prisma/schema.prisma");

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const schema = () => read(SCHEMA);

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const webFiles = () => [...walk(path.join(WEB, "src"), /\.tsx?$/), ...walk(path.join(WEB, "pages"), /\.tsx?$/)];
const apiFiles = () => walk(path.join(API), /\.ts$/);

/** The permission module, once it exists. */
// The permission model moved to packages/permissions so the web app can
// use the SAME can() the server does — one implementation is the cheapest
// way to satisfy G15. It stays gate-able from here because it is pure.
const PERM = path.resolve(API, "../../../packages/permissions/permissions.ts");
const ENT_FILE = path.resolve(API, "../../../packages/permissions/entitlements.ts");
const hasPerm = () => existsSync(PERM);

// ─────────────────────────────────────────────────────────────────────────
describe("[G1-G2] the web Scope object", () => {
  it("G1 — exactly one exported Scope type; none declared inline", () => {
    const inline = webFiles()
      // lib/scope.ts is where the type is DEFINED — excluding it is the
      // point, not an exemption.
      .filter((f) => !f.endsWith(path.join("lib", "scope.ts")))
      .filter((f) => /isWorker:\s*boolean;?\s*\n?\s*isAdmin:\s*boolean;?\s*\n?\s*isSuper:\s*boolean/.test(read(f)));
    expect(
      inline.map((f) => path.relative(WEB, f)),
      "Each inline declaration is its own structural type, so the compiler " +
        "CANNOT tell you which one you missed when the shape changes. Export " +
        "one Scope type and convert all of them before touching any tab.",
    ).toEqual([]);
  });

  it("G2 — every scope default fails closed", () => {
    const open: string[] = [];
    for (const f of webFiles()) {
      const src = read(f);
      for (const m of src.matchAll(/scope\s*\?\?\s*\{([^}]*)\}/g)) {
        if (/isAdmin:\s*true|isSuper:\s*true/.test(m[1])) open.push(path.relative(WEB, f));
      }
    }
    expect(
      open,
      "A missing scope prop must never yield admin. Harmless today because " +
        "callers always pass one; actively dangerous once scope carries " +
        "capabilities.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[G3-G4] resolution", () => {
  it.skipIf(!hasPerm())("G3 — the permission module reads no database and no cache", () => {
    const src = read(PERM);
    expect(src, "a lookup here bypasses view-as and restores real powers").not.toMatch(/from "\.\.\/db\/prisma"/);
    expect(src, "caching permissions means stale authority outliving a revoke").not.toMatch(/from "\.\/cache"/);
    expect(src, "`can` must take a resolved principal, never a user id").not.toMatch(/function can\(\s*userId/);
  });

  it("G4 — capabilities resolve AFTER impersonation", () => {
    // This gate used to compare the first occurrence of
    // /entitlements|capabilities/ against the first occurrence of
    // "resolveImpersonation" — and BOTH were import lines, so it passed on
    // import ordering and would have kept passing with the resolution in
    // entirely the wrong place. Anchor on the CALL and the ASSIGNMENT.
    const rbac = read(path.join(API, "plugins", "rbac.ts"));

    // The role swap became a PERSPECTIVE. Same ordering requirement, better
    // mechanism: the old version replaced the roles array with a synthetic
    // one and dropped custom grants wholesale, so it could only ever show
    // the generic worker experience. A perspective narrows the person's own
    // set, which is what makes "view as" actually show what someone sees.
    const call = rbac.indexOf("resolvePerspective(");
    expect(call, "rbac.ts must resolve the active perspective").toBeGreaterThan(-1);

    const assign = rbac.search(/\bconst principal\b|\bcapabilities\s*[:=]/);
    if (assign === -1) return; // not built yet
    expect(
      assign,
      "Capabilities resolved before impersonation would hand the settings viewing " +
        "as a worker their own full powers. Order: roles -> impersonation -> " +
        "capabilities.",
    ).toBeGreaterThan(call);

    // The spread is the actual trap: `{ ...me, roles }` copies every other
    // field verbatim, so a capability field ON `me` survives the roles swap.
    const spread = /\{\s*\.\.\.me\b([^}]*)\}/g;
    for (const m of rbac.matchAll(spread)) {
      expect(
        m[1],
        "A capability field inside `{ ...me, ... }` is carried through " +
          "impersonation intact. Assign it from the effective roles instead.",
      ).not.toMatch(/capabilit|entitlement|principal/i);
    }

    // THE PERSPECTIVE MUST NOT LEAK THE REAL POWERS, which is what this gate has
    // always been about — but the mechanism changed and the old assertion
    // is obsolete.
    //
    // It required `impersonation ? [] : grants`: the role swap dropped
    // custom-role grants wholesale, because there was no other user whose
    // grants applied. That is why it could only ever show the GENERIC worker
    // experience, and why someone with `settings.manage` could not check what one of their own
    // people actually sees.
    //
    // A perspective narrows the person's OWN set by intersection instead, so
    // the grants stay and `can()` does the filtering. What has to hold now:
    // the perspective reaches the principal, and it comes from the caller's
    // OWN available list rather than straight off the header.
    const regionStart = rbac.search(/\bconst perspective\b/);
    const regionEnd = rbac.indexOf("(req as any).principal");
    expect(regionStart, "the perspective is not resolved in rbac.ts").toBeGreaterThan(-1);
    expect(regionEnd, "no principal is attached to the request").toBeGreaterThan(regionStart);
    const principalBlock = rbac.slice(regionStart, regionEnd);

    expect(
      principalBlock,
      "the resolved perspective must reach the principal — a principal built " +
        "with `perspective: null` ignores the perspective entirely and hands the " +
        "person their real powers back.",
    ).toMatch(/perspective,|perspective:\s*perspective\b/);
    expect(
      principalBlock,
      "the perspective must come from resolvePerspective against the " +
        "caller's own `perspectives` list. Parsing the header straight into " +
        "the principal would let any roleId be asserted, which is the one " +
        "thing a downgrade must never allow.",
    ).toMatch(/resolvePerspective\(\s*me\.perspectives/);
    expect(
      principalBlock,
      "the principal's roles still come from the person's real grants — a " +
        "perspective NARROWS by intersection, it does not replace them.",
    ).toMatch(/me\.roleGrants/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[G8, G19-G23] structural invariants", () => {
  it("G19 — the `Role` enum does not exist", () => {
    // This gate has been through three jobs, and the arc is the whole story
    // of the cutover:
    //
    //   1. "Role has exactly THREE values"  — WORKER | ADMIN | SUPER.
    //   2. "...exactly FOUR"                — STAFF added as the floor.
    //   3. this                             — the enum is gone entirely.
    //
    // Its purpose never changed: stop anybody adding a role. A new enum
    // value needs a judgement call at every role check in the app — ~1,300
    // in apps/web alone, measured — and fails silently wherever it is
    // missed. The answer was never a better enum; it was capabilities, which
    // an operator composes without touching code.
    expect(
      schema(),
      "`Role` is gone. A role is a CustomRole row now — a name, an " +
        "entitlement set and a parent to inherit from. Adding an enum value " +
        "would reintroduce the thing that needed a code change per role.",
    ).not.toMatch(/enum Role \{/);
    expect(
      schema(),
      "`UserRole` is gone too. A grant is a UserCustomRole row, which can be " +
        "suspended, audited and scoped to a portfolio — none of which an enum " +
        "row could be.",
    ).not.toMatch(/model UserRole \{/);
  });

  it("G20 — no per-person entitlement table", () => {
    expect(
      /model UserEntitlement\b/.test(schema()),
      "Every grant goes through a named role. Per-person grants scatter " +
        "exceptions nobody can audit.",
    ).toBe(false);
  });

  it.skipIf(!/model Portfolio\b/.test(schema()))("G21 — Portfolio.path is built from ids, not names", () => {
    // The first version of this matched /path\s*[:=].*slug/ across the whole
    // API and fired on `path: ["slug"]` in vanityPages.ts — a Zod error path
    // for a vanity slug, nothing to do with portfolios. A gate that cries wolf on
    // unrelated code gets its regex deleted rather than its subject fixed, so
    // this one only looks at lines that are actually about a portfolio path.
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      for (const [i, line] of read(file).split("\n").entries()) {
        // Only lines that assign a path AND mention a portfolio.
        //
        // `[A-Za-z]*[Pp]ath`, not `\bpath\b`: the word-boundary version
        // missed `const portfolioPath = parent.path + slugify(portfolio.name)`
        // entirely, because there is no boundary inside "portfolioPath" — and
        // that is exactly the variable name somebody writes when building
        // one. Found 2026-10-26 while checking the rule still fired after
        // a carve-out was added below.
        if (!/(?:^|[^A-Za-z])[A-Za-z]*[Pp]ath\s*[:=][^=]/.test(line)) continue;
        if (!/portfolio/i.test(line)) continue;
        // `path: true` is a Prisma FIELD SELECTION, never a construction.
        // The first version of this read the whole line, so it fired on a
        // `select` listing both `name` and `path`, and on audit metadata
        // RECORDING a path next to a name. Both are reads. Judge only the
        // value side of the assignment — that is where a path gets built.
        const value = line.replace(/^.*?[A-Za-z]*[Pp]ath\s*[:=]\s*/, "");
        if (/^\s*(true|false)\b/.test(value)) continue;
        // A TYPE ANNOTATION is not a construction either, and it is the
        // same category as the `path: true` carve-out above: `{ path:
        // string; name: string }` describes a shape, it does not build
        // anything. Caught `const grantedAreas: Array<{ path: string; name:
        // string }>` in users.ts, which reads ids OUT of a path to look up
        // their names — the opposite direction from the bug this guards.
        if (/^\s*(string|number|boolean)\b/.test(value)) continue;
        if (/\b(name|slug|slugify|title|label)\b/i.test(value)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "A portfolio path built from names breaks on rename, and names are neither " +
        "unique nor stable — two portfolios may both be called Raleigh. Build it " +
        "from ids.",
    ).toEqual([]);
  });

  it("G23 — \"manager\" never appears in user-facing copy", () => {
    // Identifiers are not copy: PushManager, PropertyPhotosManager, a
    // MANAGER_TITLES taxonomy key. Only quoted prose counts.
    const hits: string[] = [];
    for (const f of webFiles()) {
      for (const m of read(f).matchAll(/["'`]([^"'`\n]{4,120})["'`]/g)) {
        const s = m[1];
        if (!/\bmanagers?\b/i.test(s)) continue;
        if (/^[@./]|Manager['"]?$|MANAGER_|[A-Z][a-z]+Manager/.test(s)) continue; // import paths, component names, taxonomy keys
        if (!/\s/.test(s)) continue; // single identifier, not a sentence
        hits.push(`${path.relative(WEB, f)}: ${s.slice(0, 60)}`);
      }
    }
    expect(
      hits,
      "\"Manager\" is a title from a taxonomy, not a role the system knows. " +
        "Writing it in an interface promotes a label into a role.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[G12, G14, G17, G22, G26] portfolio invariants", () => {
  const hasAreas = () => /model Portfolio\b/.test(schema());

  it.skipIf(!hasAreas())("G12/G22 — portfolioId is never written on a completed occurrence", () => {
    const svc = read(path.join(API, "services", "jobs.ts"));
    expect(svc).not.toMatch(/status:\s*JobOccurrenceStatus\.(COMPLETED|CLOSED)[\s\S]{0,200}portfolioId:/);
  });

  it.skipIf(!hasAreas())("G14 — nothing reparents a portfolio", () => {
    const svc = apiFiles().map(read).join("\n");
    expect(
      svc,
      "Portfolios are copy-and-retired, never moved — moving one restates its " +
        "parent's history.",
      // `parentId: true` inside a `select` is a field selection, not a move.
      // The original pattern was `portfolio.update([^)]*parentId`, and `[^)]*`
      // happily spanned the whole call into a `select` block — so a perfectly
      // safe rename that merely READ parentId back tripped it.
    ).not.toMatch(/portfolio\.update\([\s\S]*?data:\s*\{[^}]*parentId/);
  });

  it.skipIf(!hasAreas())("G17 — there is no informational 'home portfolio' to mistake for a grant", () => {
    // WHAT THIS USED TO SAY, AND WHY IT CHANGED.
    //
    // `AreaMembership` was "this person usually works here" — informational,
    // granting nothing. G17 asserted that no permission check read it,
    // because a check there would silently restrict where somebody is
    // ALLOWED to work rather than merely describing where they usually do.
    //
    // The model was never used. Not one line of `apps/api`, `apps/web` or
    // `packages` ever read or wrote it, so the table sat empty in every
    // environment while the permissions model grew up around it. It was
    // dropped on 2026-10-28 (`drop_dead_area_membership`).
    //
    // The rule is now stronger and cheaper to keep: the concept must not
    // come back. A second portfolio relation on User whose name says "where they
    // are" is exactly the shape that invites a permission check — the next
    // person sees two portfolio tables and reasonably assumes both are consulted.
    // There is ONE portfolio relation that means anything, `PortfolioAssignment`, and
    // it grants. If you need somewhere to record a home base, that is
    // `User.homeBaseAddress`, which no authorization path reads either.
    expect(
      schema(),
      "AreaMembership was dead and was dropped. Do not reintroduce an " +
        "informational portfolio relation — PortfolioAssignment is the only one, and " +
        "it grants. A home base goes on User.homeBaseAddress.",
    ).not.toMatch(/AreaMembership/);

    const perm = hasPerm() ? read(PERM) : "";
    expect(perm, "no permission check may consult a home portfolio").not.toMatch(
      /AreaMembership|areaMembership/,
    );
  });

  it.skipIf(!hasAreas())("G26 — at most one isSystem role per user", () => {
    // This used to assert only that the string "isSystem" appeared SOMEWHERE
    // in the API, which the seed satisfied without any service enforcing
    // anything. The rule is not expressible as a unique index — the condition
    // is "at most one row whose JOINED role has isSystem" — so it has to live
    // in the grant path, and this has to check the grant path.
    const svc = read(path.join(API, "services", "customRoles.ts"));
    expect(svc, "customRoles service must exist to own this rule").not.toBe("");

    const assign = svc.slice(svc.indexOf("async assign"), svc.indexOf("async revoke"));
    // KEYED ON `isLadderRung`, NOT `isSystem`. `isSystem` means "the install
    // script made it", which is seven roles: the four rungs plus Field
    // Clearance and the two "May …" exception roles. Those three exist to be
    // granted ON TOP of a rung, and while the rule read `isSystem` they
    // could not be granted to anybody who held one — the whole reason they
    // exist, unreachable.
    expect(
      assign,
      "assign() must look for an existing LADDER RUNG before adding one, " +
        "not for any role the installer happens to own.",
    ).toMatch(/isLadderRung:\s*true/);
    expect(
      assign,
      "assign() must REFUSE a second rung of the ladder — each rung already " +
        "contains the one below it.",
    ).toMatch(/ONE_LADDER_ROLE/);
    expect(
      assign,
      "assign() must REFUSE two roles in one inheritance chain: the union is " +
        "just the wider of the two, and provenance becomes ambiguous.",
    ).toMatch(/SAME_ROLE_CHAIN/);
    expect(
      assign,
      "the ladder rule must NOT be keyed on isSystem again — that is the " +
        "flag the installer stamps on every role it owns.",
    ).not.toMatch(/customRole:\s*\{\s*isSystem:\s*true\s*\}/);

    // ── The atomic move works on ANY chain, not just the starter ladder ──
    //
    // It used to find the role to move FROM with
    // `where: { customRole: { isLadderRung: true } }`, which has exactly
    // one answer because the installer flags one chain. An operator who
    // builds a second hierarchy got no move at all, and the UI fell back
    // to revoke-then-grant — the two-request window the endpoint exists to
    // close, reopened for every role the operator defined themselves.
    const moveStart = svc.indexOf("async moveWithinChain");
    expect(
      moveStart,
      "the atomic move must still exist, and be named for the chain it " +
        "walks rather than the one ladder it used to assume.",
    ).toBeGreaterThan(-1);
    const move = svc.slice(moveStart, svc.indexOf("async revoke", moveStart));
    expect(
      move,
      "the move must not find the role to move FROM by the isLadderRung " +
        "flag — that hard-codes a single hierarchy.",
    ).not.toMatch(/customRole:\s*\{\s*isLadderRung:\s*true\s*\}/);
    expect(
      move,
      "the move must walk the inheritance chain, the same relation " +
        "assign()'s SAME_ROLE_CHAIN refuses, so a move offered in the UI " +
        "is never one the grant path would reject.",
    ).toMatch(/inheritsFromId/);
    expect(
      assign,
      "a suspended role must not be grantable — its grants are inactive, so " +
        "granting it would look like it worked and do nothing.",
    ).toMatch(/ROLE_SUSPENDED/);
  });

  it.skipIf(!hasAreas())("G26 — the one-system-role check compares ROLE ids, not grant ids", () => {
    // WHY THIS IS A SEPARATE ASSERTION.
    //
    // The scan above proves the refusal is SHAPED right — the strings are
    // all present — and that is all it can prove. It passed for the whole
    // life of a bug that made the refusal fire on every single grant of a
    // ladder role: the lookup selected the UserCustomRole's own `id` and
    // compared it against a CustomRole id, so the "same role, nothing to
    // do" escape could never be taken and promotion was impossible.
    //
    // Two id spaces that are never equal is invisible to a string scan and
    // invisible to the type checker — both are `string`. So assert the one
    // thing that distinguishes the correct code: the row it reads must be
    // the role reference, and the comparison must use it.
    const svc = read(path.join(API, "services", "customRoles.ts"));
    const assign = svc.slice(svc.indexOf("async assign"), svc.indexOf("async revoke"));
    // Anchored on the lookup itself. It used to anchor on
    // `if (role.isSystem)`, which stopped existing when the ladder rule
    // moved to `isLadderRung` — and a slice from an index of -1 silently
    // searches the whole function, which would have kept this green for the
    // wrong reason.
    const at = assign.indexOf("const heldGrants");
    expect(at, "the existing-grant lookup must still be called `heldGrants`").toBeGreaterThan(-1);
    const check = assign.slice(at);

    expect(
      /select:\s*\{\s*customRoleId:\s*true/.test(check),
      "the existing-grant lookup must select `customRoleId`. Selecting only " +
        "`id` gives the GRANT's id, and comparing that to a role id is a " +
        "test that can never be true.",
    ).toBe(true);
    expect(
      /\.customRoleId\s*!==\s*customRoleId/.test(check),
      "the comparison must be `e.customRoleId !== customRoleId`. Comparing " +
        "`e.id` crosses id spaces and refuses every grant.",
    ).toBe(true);
    expect(
      /e\.id\s*!==\s*customRoleId/.test(check),
      "`e.id !== customRoleId` is the bug itself — a grant id against a role id.",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[G6-G7, G9, G11, G13, G15-G16, G25, G28-G29] awaiting the feature", () => {
  // Declared so the list is complete and visible. Each becomes a real
  // assertion when its subject exists; a vacuous green tick now would read
  // as coverage that does not exist.
  it("G5 — every guarded route agrees with the route map", () => {
    // The strongest gate in this design, and the one that keeps the other
    // artefacts honest. Two directions:
    //
    //   a bare role guard  -> the route must be STRUCTURAL in the map
    //                         (OWNERSHIP / PUBLIC / CLIENT-PORTAL /
    //                          TOP-ROLE / ROLE-GRANT)
    //   a requires() guard -> its entitlement must BE the map's entitlement
    //
    // Without (a), a route quietly keeps a role check and never gets an
    // entitlement. Without (b), code and map drift and the map stops being
    // evidence of anything.
    const MAPFILE = path.resolve(API, "../../../docs/features/permissions-ROUTE-MAP.md");
    if (!existsSync(MAPFILE)) return; // docs deleted when the work ships
    const map = new Map<string, string>();
    let group: string | null = null;
    for (const line of readFileSync(MAPFILE, "utf8").split("\n")) {
      const h = /^## ([A-Za-z.\-]+)(?: \(bounded\))?\s+\(\d+\)$/.exec(line);
      if (h) { group = h[1]; continue; }
      const r = /^\| `([A-Z]+)` \| `([^`]+)` \|$/.exec(line);
      if (r && group) map.set(`${r[1]} ${r[2]}`, group);
    }
    expect(map.size, "the route map must be readable").toBeGreaterThan(600);

    // The map's non-entitlement sections, exactly. This listed "SUPER-only"
    // and "ROLE-GRANT", neither of which the map has had since the cord was
    // cut, and OMITTED "SYSTEM", which it does have (cron + healthz). A
    // stale allow-list here is a gate that waves routes through.
    const STRUCTURAL = new Set(["OWNERSHIP", "PUBLIC", "CLIENT-PORTAL", "SYSTEM"]);
    const norm = (x: string) => x.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x");
    const problems: string[] = [];

    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      if (file.endsWith(".test.ts")) continue;
      const src = read(file);
      const rel = path.basename(file);
      const re = /app\.(get|post|patch|delete|put)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*,/g;
      for (const m of src.matchAll(re)) {
        const key = `${m[1].toUpperCase()} ${norm(m[2])}`;
        const group = map.get(key);
        if (!group) { problems.push(`${rel}: ${key} is in no route-map group`); continue; }

        const decl = new RegExp(
          `\\bconst\\s+${m[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*requires\\(\\s*"([^"]+)"`,
        ).exec(src);

        if (decl) {
          if (STRUCTURAL.has(group)) {
            problems.push(`${rel}: ${key} declares "${decl[1]}" but the map calls it ${group}`);
          } else if (decl[1] !== group) {
            problems.push(`${rel}: ${key} declares "${decl[1]}", map says "${group}"`);
          }
        }
        // A branch here used to catch routes still on a bare
        // `workerGuard`/`adminGuard`/`superGuard`. Those identifiers no
        // longer exist anywhere in the route layer, and G24b fails the
        // build if a guard is ever named for a role again, so the branch
        // could not fire. Removed 2026-10-18 rather than left as dead code
        // that reads like live protection.
      }
    }
    expect(
      problems,
      "Routes and the route map disagree. Either the route needs its " +
        "entitlement declared, or the map is wrong — the two cannot differ.",
    ).toEqual([]);
  });
  it("G6 — you cannot grant an entitlement you do not hold", () => {
    // A REAL HOLE THIS CLOSED. `assertEntitlement` only checks a string is
    // in the vocabulary, which is not the security question. Without a
    // held-set check, anyone with `roles.define` could mint a role
    // containing `books.export-tax`, `money.approve` or `payroll.manage` and
    // have it assigned — a complete escalation through the one surface whose
    // whole job is deciding who may do what.
    //
    // Four entry points can grant, and ALL FOUR need it:
    //   create           — entitlements in a new role
    //   setEntitlements  — replacing a role's set
    //   update           — RE-PARENTING, because that changes what the role
    //                      grants, and is the way around the other three
    //   assign           — granting the role grants everything in it
    const svc = read(path.join(API, "services", "customRoles.ts"));
    expect(svc, "the grant check must exist").toMatch(/function assertMayGrant/);

    for (const fn of ["create", "setEntitlements", "update", "assign"]) {
      const at = svc.indexOf(`async ${fn}(`);
      expect(at, `customRoles.${fn} not found — renamed?`).toBeGreaterThan(-1);
      const body = svc.slice(at, svc.indexOf("\n  async ", at + 1));
      expect(
        body,
        `customRoles.${fn} can grant, so it must call assertMayGrant`,
      ).toMatch(/assertMayGrant\(/);
      expect(
        body,
        `customRoles.${fn} must take the actor's set as a PARAMETER. ` +
          `Resolving it inside would read their real capabilities and ignore ` +
          `an active perspective, letting someone grant what the perspective hides.`,
      ).toMatch(/actorCapabilities/);
    }

    // ── THE FIFTH ENTRY POINT, FOUND 2026-10-13 ─────────────────────────
    //
    // `portfolios.assign` is a role grant too. `currentUser` loads
    // `portfolioAssignments` into the principal exactly as it loads `customRoles`,
    // so a portfolio assignment confers real capabilities — but it lives in a
    // different FILE, so the loop above never looked at it, and it shipped
    // with no grant check at all. A holder of `portfolios.manage` could assign a
    // role holding every entitlement to anybody inside a portfolio.
    //
    // It was unreachable only because `portfolios.manage` happened to sit in one
    // starter role. That is a seed fact, not a check. This assertion is here
    // because the gate was scoped to a file rather than to the BEHAVIOUR.
    const areasSvc = read(path.join(API, "services", "portfolios.ts"));
    const assignAt = areasSvc.indexOf("async assign(");
    expect(assignAt, "portfolios.assign not found — renamed?").toBeGreaterThan(-1);
    const assignBody = areasSvc.slice(
      assignAt,
      areasSvc.indexOf("\n  async ", assignAt + 1),
    );
    expect(
      assignBody,
      "portfolios.assign grants a role within a portfolio, so it must call " +
        "assertMayGrant — the same check customRoles.assign applies.",
    ).toMatch(/assertMayGrant\(/);
    expect(
      assignBody,
      "portfolios.assign must take the actor's set as a PARAMETER, for the same " +
        "reason every other grant path does: resolving it inside would " +
        "ignore an active perspective.",
    ).toMatch(/actorCapabilities/);
    expect(
      assignBody,
      "portfolios.assign must flatten the role before checking it — granting a " +
        "role grants its whole parent chain, which is where the powerful " +
        "entitlements live.",
    ).toMatch(/flattenRole\(/);

    // `assign` and `update` must check the INHERITED set, not just the
    // role's own — the powerful entitlements live up the parent chain.
    for (const fn of ["assign", "update"]) {
      const at = svc.indexOf(`async ${fn}(`);
      const body = svc.slice(at, svc.indexOf("\n  async ", at + 1));
      expect(
        body,
        `customRoles.${fn} must flatten inheritance before checking — a role ` +
          `whose PARENT holds money.approve grants money.approve`,
      ).toMatch(/flattenRole\(/);
    }

    // And the service must never resolve the actor itself.
    expect(
      svc,
      "customRoles must not look up the actor's capabilities — the caller " +
        "passes them in, from req.principal.",
    ).not.toMatch(/capabilitiesForUsers\(|userCan\(/);
  });
  // G9 — RETIRED (decision 47, superseded). It asserted that break-glass
  // resolved WITHOUT consulting the entitlement tables, so one bad grant row
  // could not lock the owner out. The env-var break-glass is deleted: there
  // are no enum roles left to grant, so it would have had to resolve
  // THROUGH those tables — making the recovery path the thing that needs
  // recovering. Initial assignment is the starter script run against the
  // database, which cannot be locked out because it does not go through can().
  it("the two capability resolvers agree about portfolio grants", () => {
    // TWO FUNCTIONS ANSWER "WHAT MAY THIS PERSON DO", AND THEY DIVERGED.
    //
    // `currentUser.me` builds `req.principal`, which the route guards use.
    // `users.me` builds the `/api/me` payload, which every tab, button and
    // menu in the web app gates on. Both must count company-wide roles AND
    // portfolio assignments.
    //
    // `users.me` counted only `customRoles`. So somebody whose only access
    // is an PortfolioAssignment — the entire point of the portfolio feature — was
    // authorized correctly by the server and shown the no-access notice by
    // the browser. Portfolio scoping was unusable in the UI from the day it
    // shipped, and no test caught it because every server-side check went
    // through the principal.
    //
    // Asserting the SHAPE rather than the behaviour, because the behaviour
    // needs a Clerk token. Each file must load `portfolioAssignments` and fold
    // them into the ids it resolves entitlements from.
    const users = readFileSync(path.join(API, "services/users.ts"), "utf8");
    const current = readFileSync(path.join(API, "services/currentUser.ts"), "utf8");

    for (const [label, body] of [["users.ts", users], ["currentUser.ts", current]] as const) {
      expect(body, `${label} must load portfolioAssignments with the user`)
        .toMatch(/portfolioAssignments:\s*\{/);
      expect(body, `${label} must read customRoleId off the portfolio assignments`)
        .toMatch(/portfolioAssignments\s*\?\?\s*\[\]\)[\s\S]{0,120}customRoleId/);
    }

    // And specifically: the id list `users.me` resolves capabilities from
    // must not be built from `customRoles` alone again.
    const at = users.indexOf("const heldRoleIds");
    expect(at, "users.me must still build heldRoleIds").toBeGreaterThan(-1);
    const decl = users.slice(at, users.indexOf(";", users.indexOf("]", at)));
    expect(decl, "heldRoleIds must include portfolio assignments, not just customRoles")
      .toMatch(/portfolioAssignments/);
  });

  it("G10 — every portfolio-scopable list read applies portfolioScope() or is annotated", () => {
    // SCOPE OF THIS GATE, deliberately narrow in two ways.
    //
    // 1. LIST READS ONLY. 261 routes sit behind the portfolio-scopable
    //    entitlements, but only 107 are GETs — which is what the design's
    //    "~101 scopable routes" actually counts. Portfolio scoping is a `where`
    //    filter on a list; a mutation on one record by id is ownership-checked
    //    on THAT record instead. Demanding portfolioScope() on 154 mutations would
    //    force meaningless annotations and teach people to ignore the gate.
    //
    // 2. books.* AND payroll.* ARE EXCLUDED, pending a decision. They sit in
    //    the Money group headed "(portfolio-scopable)", while resolved question C
    //    says "books.* is global-only, so no company P&L unless explicitly
    //    granted". Both cannot be true. Scoping the P&L by territory would
    //    show a manager a slice of the books as though it were the whole
    //    thing; leaving payroll unscoped may expose wages company-wide. That
    //    is a money-visibility policy call, so this gate enforces what IS
    //    settled and records what is not, rather than freezing a guess.
    const SETTLED_SCOPABLE = [
      "clients.contribute", "clients.manage", "clients.view",
      "crews.manage",
      "estimates.accept", "estimates.create",
      "money.approve", "money.record", "money.view",
      // Added 2026-10-14: a district lead's operations numbers are their
      // district's. `books.*`, `payroll.*` and `audit.view` were considered
      // at the same time and are deliberately NOT here — see the
      // GLOBAL_BY_DESIGN note in scripts/_portfolio-scope-probe.ts.
      "reports.view",
      "schedule.contribute", "schedule.view",
      "time.approve",
    ];
    // GLOBAL BY DECISION — not "not done yet". Each has a reason, kept here
    // so nobody re-opens it by quietly adding one back to the scopable list.
    //
    // 2026-10-14 — money is NEVER territorial. "The company's books are the
    // owner's"; there is no district P&L.
    //
    // 2026-10-18 — the operator's call: a district lead sees ALL people.
    // That settles `people.view`, and the same reasoning carries three more:
    //   • `people.view`     — a person is not IN a territory. The design says
    //                         it outright ("the tree models AREAS, not
    //                         people"); oversight comes from containment, and
    //                         `PortfolioAssignment` is a grant, not a home.
    //   • `crews.view`      — a crew is a set of PEOPLE, not a place. It has
    //                         no `portfolioId` and placing one would mean picking
    //                         a territory for a van that works three.
    //   • `pricing.view`    — a catalogue. One price list, one business.
    //   • `schedule.manage` — its only scopable GET is `/pause-reasons`, a
    //                         taxonomy of reason codes. Scoping a dropdown's
    //                         vocabulary by territory is nonsense.
    // 2026-10-18 — timesheets and driving are a PERSON and a DAY, not a
    // place, so neither `WorkerWorkday` nor `MileageEntry` carries an
    // `portfolioId` and neither sensibly could: a Tuesday spent on two Durham
    // lawns and one in Chapel Hill belongs to no single district.
    //   • `time.view`   — the sibling `time.manage`, which APPROVES those
    //                     rows, was already global. Scoping what somebody
    //                     SEES while leaving what they APPROVE global is
    //                     the inconsistency, not the reverse.
    //   • `routes.plan` — its one scopable GET, `/routes/operations`, is a
    //                     rollup over the same MileageEntry rows.
    //
    // NOT the same thing as per-visit hours. `time.approve` covers
    // `JobOccurrence.hoursApprovedAt` — a visit, which DOES carry a portfolio —
    // and stays territorial. Two surfaces, both called "hours"; only one of
    // them happens in a place.
    //
    // If a district lead's workday queue should ever be genuinely theirs,
    // that is the point to derive territory from the day's occurrences, and
    // it is a migration plus an answer to the two-districts question.
    const GLOBAL_BY_DECISION = [
      "books.manage", "books.view", "payroll.manage", "payroll.view",
      "people.view", "crews.view", "pricing.view", "schedule.manage",
      "time.view", "routes.plan",
    ];

    // THREADED SO FAR. The gate is binding for these groups and informational
    // for the rest, which is the only honest arrangement while the work is in
    // progress: it cannot regress what is finished, and it cannot cry wolf
    // about what has not started.
    //
    // Money first, per the design: highest consequence, smallest surface, and
    // the rows start at the occurrence so they gain one `where` clause with no
    // joins. ADD A GROUP HERE AS YOU THREAD IT — the gate then enforces it
    // forever.
    // THREADED SO FAR. Each entry here makes G10 binding for that
    // capability — a route guarded by it must carry a portfolio filter or an
    // explicit allow. Grown 2026-10-14 from one to eight after the portfolio
    // probe (`scripts/_portfolio-scope-probe.ts`) showed ten reads returning
    // another district's rows; `npm run portfolios:check` is the output test that
    // proves each one actually narrows instead of merely mentioning the
    // helper.
    const THREADED = [
      "money.view",
      "clients.view",
      "schedule.view",
      "schedule.contribute",
      "time.approve",
      "reports.view",
      // 2026-10-18.
      "estimates.create",
    ];


    /**
     * KNOWN-UNTHREADED, AND THE LIST MAY ONLY SHRINK.
     *
     * Binding G10 for six capabilities on 2026-10-14 surfaced these at once.
     * They are NOT all bugs — they fall into four kinds, and each needs a
     * different answer rather than a blanket filter:
     *
     *   - already caller-scoped (`/occurrences/mine`, `/pinned`, `/liked`,
     *     `/reminders`) — portfolio adds nothing to "my own rows"; these want an
     *     `portfolio-scope-allow` note, not a filter.
     *   - counts that must agree with a list that IS filtered
     *     (`/…/unapproved-hours-count`, `/change-requests/pending-count`) —
     *     a count that disagrees with its list is worse than either.
     *   - single-item reads by id (`/clients/:id`, `/occurrences/:id/…`) —
     *     real territorial reads, but you need the id first, so they are
     *     lower risk than a list and want deciding deliberately.
     *   - genuinely not territorial (`/weather/location`,
     *     `/client-contacts/check`).
     *
     * Listed rather than silently excluded so the work is counted. Deleting
     * an entry is how it gets done; adding one needs a reason in review.
     */
    const PENDING_AREA_THREADING = new Set<string>([
      // `/statistics` WAS listed here. Resolved 2026-10-26: scoped, and
      // deliberately left on `reports.view`. Moving it to
      // `reports.business` was the tidier-sounding option and would have
      // removed the screen from Admin and Bookkeeper, who hold
      // `reports.view` and not `reports.business` — narrowing it for one
      // district lead by taking it away from company-wide staff. Do not
      // re-propose the move without re-checking who holds what.
    ]);
    const pendingSeenArea = new Set<string>();

    const MAPFILE = path.resolve(API, "../../../docs/features/permissions-ROUTE-MAP.md");
    if (!existsSync(MAPFILE)) return;

    // Which GET routes are scopable, per the map.
    const scopableGets = new Set<string>();
    let group: string | null = null;
    for (const line of readFileSync(MAPFILE, "utf8").split("\n")) {
      const h = /^## ([A-Za-z.\-]+)(?: \(bounded\))?\s+\(\d+\)$/.exec(line);
      if (h) { group = h[1]; continue; }
      const r = /^\| `(GET)` \| `([^`]+)` \|$/.exec(line);
      if (r && group && SETTLED_SCOPABLE.includes(group) && THREADED.includes(group)) {
        scopableGets.add(r[2]);
      }
    }
    expect(scopableGets.size, "the threaded groups must yield GET routes").toBeGreaterThan(0);

    // The threading has not started yet, so this gate is informational until
    // portfolioScope appears in the routes. Once it does, it becomes binding and
    // every remaining route must be annotated.
    const routeSrc = walk(path.join(API, "routes"), /\.ts$/)
      .filter((f) => !f.endsWith(".test.ts"))
      .map(read)
      .join("\n");
    if (!/portfolioScope|portfolioWhere/.test(routeSrc)) return;

    const norm = (x: string) => x.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x");
    const missing: string[] = [];
    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      if (file.endsWith(".test.ts")) continue;
      const src = read(file);
      const rel = path.basename(file);
      // SLICED TO THE NEXT ROUTE, not to a character budget.
      //
      // This used `[\s\S]{0,1800}?` up to the closing brace, so a handler
      // longer than ~1800 characters never matched at all — and a route the
      // regex cannot see is a route this gate silently approves. In
      // reports.ts it could see THREE routes; `/dashboard-summary/aggregate`
      // is 24,418 characters and was not one of them, which is how an
      // unscoped company-wide read sat under `reports.view` — a threaded,
      // settled-scopable capability — without ever being flagged. The
      // longest handlers do the most reading, so the cap excluded exactly
      // the routes worth checking.
      const decls = [...src.matchAll(/app\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)];
      for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        if (d[1] !== "get") continue;
        const start = d.index!;
        const end = i + 1 < decls.length ? decls[i + 1].index! : src.length;
        if (!scopableGets.has(norm(d[2]))) continue;
        const body = src.slice(start, end);
        const m = [d[0], d[2]] as unknown as RegExpMatchArray;
        if (/portfolioWhere|portfolioWhereVia|areaWhereOn|portfolio-scope-allow:/.test(body)) continue;

        if (PENDING_AREA_THREADING.has(`${rel}: GET ${m[1]}`)) { pendingSeenArea.add(`${rel}: GET ${m[1]}`); continue; }
        missing.push(`${rel}: GET ${m[1]}`);
      }
    }
    expect(
      [...PENDING_AREA_THREADING].filter((r) => !pendingSeenArea.has(r)).sort(),
      "These routes are on the portfolio-threading backlog but no longer match a " +
        "route guarded by a threaded capability — the work landed, or the " +
        "route moved. Delete them from PENDING_AREA_THREADING.",
    ).toEqual([]);

    expect(
      missing,
      "These list reads can return another territory's rows. Apply " +
        "portfolioWhere() or carry `// portfolio-scope-allow: <reason>`. G10 catches a " +
        "MISSING filter; only the output test (G25) catches a WRONG one.",
    ).toEqual([]);

    // Recorded, not enforced. Both lists are here so the remaining work is
    // visible in the gate rather than in somebody's head.
    // None of the money capabilities may drift onto the scopable list.
    expect(
      GLOBAL_BY_DECISION.filter((g) => SETTLED_SCOPABLE.includes(g)),
      "money is global by decision (2026-10-14) — adding one of these to " +
        "SETTLED_SCOPABLE re-opens a settled question. If the policy really " +
        "changed, change it here and say so.",
    ).toEqual([]);

    // A RATCHET. 18 on 2026-10-14, 14 after the first threading pass, 6 on
    // 2026-10-18 once the capabilities that are not territorial at all moved
    // to GLOBAL_BY_DECISION. Lower the ceiling whenever it falls, or the
    // slack hides a regression.
    //
    // All 6 remaining are zero-work: five have no GET route whatsoever, and
    // `clients.contribute`'s only one is `/properties/:x/photos`, a by-id
    // read rather than discovery. They clear themselves the moment such a
    // route appears, because adding the group to THREADED makes G10 binding.
    expect(
      SETTLED_SCOPABLE.filter((g) => !THREADED.includes(g)).length,
      "groups still to thread — this number should fall to 0, never rise",
    ).toBeLessThanOrEqual(6);
  });
  it("G13 — a retired portfolio refuses new work and stays visible in reporting", () => {
    // RETIRED IS NOT DELETED. A portfolio is retired, never deleted, because
    // money and history are tagged to it: dropping it would restate last
    // year's numbers. So retirement has to mean exactly two things, and the
    // two pull in opposite directions —
    //
    //   1. NOTHING NEW LANDS THERE. Every method that takes a portfolio as a
    //      DESTINATION must refuse a retired one. Miss one and the portfolio
    //      quietly comes back to life, which is worse than never having
    //      retired it: the operator believes it is closed.
    //   2. IT STAYS IN REPORTING. The read paths must NOT filter retired
    //      rows out, or retiring a portfolio silently rewrites history — the
    //      exact outcome retirement-instead-of-deletion exists to prevent.
    //
    // Those are easy to hold today and easy to break with one more write
    // path, which is why this is a gate rather than a convention.
    const svc = read(path.join(API, "services", "portfolios.ts"));
    expect(svc, "services/portfolios.ts must exist").not.toBe("");

    // ── 1. Destination-taking writes refuse a retired portfolio ──────────────
    //
    // `rename` and `revoke` are deliberately absent: renaming a retired
    // portfolio is legitimate (fixing a typo on a closed region), and `revoke`
    // takes an assignmentId, not a portfolio.
    const DESTINATION_WRITES = ["create", "assign", "setPropertyPortfolios"];
    const missing: string[] = [];
    for (const fn of DESTINATION_WRITES) {
      const at = svc.indexOf(`async ${fn}(`);
      if (at === -1) { missing.push(`${fn} — not found; renamed?`); continue; }
      // Body runs to the next method at the same indent.
      const next = svc.indexOf("\n  async ", at + 1);
      const body = svc.slice(at, next === -1 ? svc.length : next);
      // It must READ retiredAt and THROW on it. Selecting the column
      // without acting on it is the shape that looks checked and is not.
      const reads = /retiredAt/.test(body);
      const refuses = /if\s*\([^)]*\.retiredAt\s*\)[\s\S]{0,300}?(throw|ServiceError)/.test(body);
      if (!reads || !refuses) {
        missing.push(`${fn} — ${reads ? "reads retiredAt but never refuses on it" : "never reads retiredAt"}`);
      }
    }
    expect(
      missing,
      "These methods accept a portfolio as a DESTINATION and must refuse a " +
        "retired one. A retired portfolio that still accepts new work is not " +
        "retired, and the operator who closed it has no way to tell.",
    ).toEqual([]);

    // ── 2. Reads keep retired rows, and say which they are ──────────────
    for (const fn of ["list", "assignments"]) {
      const at = svc.indexOf(`async ${fn}(`);
      expect(at, `portfolios.${fn} not found — renamed?`).toBeGreaterThan(-1);
      const next = svc.indexOf("\n  async ", at + 1);
      const body = svc.slice(at, next === -1 ? svc.length : next);
      expect(
        body,
        `portfolios.${fn} must SELECT retiredAt, so a caller can tell a retired ` +
          `portfolio from a live one. Without it a picker cannot filter and a ` +
          `report cannot label.`,
      ).toMatch(/retiredAt:\s*true/);
      expect(
        body,
        `portfolios.${fn} must NOT filter retired rows out — retirement must not ` +
          `rewrite history. Filtering belongs in the PICKER, not the read.`,
      ).not.toMatch(/where:[\s\S]{0,200}retiredAt:\s*null/);
    }

    // ── Negative control ────────────────────────────────────────────────
    //
    // Everything above is a regex over a file. If the file stopped holding
    // these methods the loops would pass over nothing and the gate would go
    // quietly green, which is how `it.todo("G15")` outlived its own
    // implementation. Assert the subject is present.
    for (const fn of [...DESTINATION_WRITES, "list", "assignments", "setRetired"]) {
      expect(svc, `portfolios.${fn} must exist for G13 to be about anything`)
        .toContain(`async ${fn}(`);
    }
    // And that retirement is reachable at all.
    expect(
      read(path.join(API, "routes", "permissions.ts")),
      "the retire/unretire routes must exist",
    ).toMatch(/"\/portfolios\/:id\/retire"/);
  });
  // G15 is BUILT — it lives in its own file, `ui-capability-build-gate.test.ts`,
  // because it scans the web tree rather than this one. This `it.todo`
  // outlived the implementation and made three memory files report G15 as
  // unbuilt. A todo for something that exists is worse than no todo.
  it("G16 — retagging a visit checks schedule.manage in BOTH portfolios", () => {
    // A SINGLE-SIDED CHECK IS THE WHOLE PROBLEM. Check only the
    // destination and a manager can pull revenue onto their own books from a
    // territory they have no part in; check only the source and they can
    // push a loss off themselves. Needing both means a move only ever happens
    // between two places the same person is answerable for.
    const svc = read(path.join(API, "services", "portfolios.ts"));
    // MOVED, NOT DROPPED. `retagOccurrence` is gone — an open visit
    // follows its property now, so a per-visit override would be erased by
    // the next resync — but the escalation it guarded is identical one
    // level up, so the check lives on the call that moves work.
    const at = svc.indexOf("async setPropertyPortfolios(");
    expect(at, "portfolios.setPropertyPortfolios not found — renamed?").toBeGreaterThan(-1);
    const body = svc.slice(at, svc.indexOf("\n  /**", at + 1));

    const checks = [...body.matchAll(/can\(\s*principal\s*,\s*"schedule\.manage"\s*,\s*\{\s*portfolioPath:\s*([^}]+)\}/g)];
    expect(
      checks.length,
      "both the source and the destination portfolio must be checked — one call is " +
        "a single-sided check",
    ).toBe(2);
    // And they must be DIFFERENT paths: two checks against the destination
    // would pass this count while being exactly the bug.
    const paths = checks.map((m) => m[1].trim());
    expect(
      new Set(paths).size,
      `both checks use the same path (${paths.join(" and ")}) — one must be the ` +
        `source portfolio and the other the destination`,
    ).toBe(2);

    // The PRINCIPAL is passed in, never looked up — a fresh read would
    // ignore an active perspective and answer with the powers it hides.
    expect(body, "retagOccurrence must take a resolved principal").toMatch(
      /principal: Principal/,
    );
    expect(
      body,
      "it must not resolve the caller itself",
    ).not.toMatch(/capabilitiesForUsers\(|userCan\(/);

    // G22 STILL HOLDS, one call away.
    //
    // The freeze used to be an inline `if (occ.completedAt) throw` in
    // `retagOccurrence`, because that method moved one visit. Membership
    // now changes at the PROPERTY, and the fan-out to its visits runs
    // through `resyncPortfoliosForProperty`, so that is where the rule has
    // to be — both in the query that selects only open visits and in
    // `syncOccurrencePortfolios`, which refuses a frozen one even if a
    // caller hands it the id directly. Asserting it there rather than here
    // keeps the gate pointed at the code that enforces it.
    expect(
      body,
      "the fan-out to a property's visits must go through the helper that " +
        "knows about completion, not write occurrence rows itself",
    ).toMatch(/resyncPortfoliosForProperty\(/);

    const occLib = read(path.join(API, "lib", "occurrencePortfolio.ts"));
    expect(occLib, "lib/occurrencePortfolio.ts must exist for G22 to be about anything").not.toBe("");
    expect(
      occLib,
      "a completed visit's portfolios are what the work counted toward — changing " +
        "them restates what every past rollup reports",
    ).toMatch(/if \(!occ \|\| occ\.completedAt\) return;/);
    expect(
      occLib,
      "the resync must select only open visits rather than filtering after the read",
    ).toMatch(/completedAt: null/);
  });
  it("G18 — no money or payroll route resolves to schedule.manage", () => {
    // Write-off, mark-paid, split recalculation and hours approval all
    // sat inside `schedule.manage`, because it was the catch-all for
    // the occurrence routes. A manager with scheduling rights could have
    // changed worker pay. Found by the route-map review, not by anyone
    // reading the code.
    const MAPFILE = path.resolve(API, "../../../docs/features/permissions-ROUTE-MAP.md");
    if (!existsSync(MAPFILE)) return;

    let group: string | null = null;
    const offenders: string[] = [];
    // Paths whose names say they move money or touch pay.
    const MONEY = /(payment|payout|invoice|refund|write-off|writeoff|mark-paid|split|payroll|wage|earnings|hours|time-?entry|approve-hours|tax|ledger|expense|charge)/i;
    // Scheduling verbs that legitimately contain a money-ish word.
    const ALLOW = /\/(reschedule|confirm|reminder|snooze)\b/i;

    for (const line of readFileSync(MAPFILE, "utf8").split("\n")) {
      const h = /^## ([A-Za-z.\-]+)(?: \(bounded\))?\s+\(\d+\)$/.exec(line);
      if (h) { group = h[1]; continue; }
      const r = /^\| `([A-Z]+)` \| `([^`]+)` \|$/.exec(line);
      if (!r || group !== "schedule.manage") continue;
      const [, method, route] = r;
      if (MONEY.test(route) && !ALLOW.test(route)) offenders.push(`${method} ${route}`);
    }

    expect(
      offenders,
      "These routes move money or touch pay but resolve to schedule.manage, " +
        "so anyone who can arrange the week could change what people are " +
        "paid. Give them a money.* or payroll.* entitlement.",
    ).toEqual([]);
  });
  // G24 — RETIRED. It asserted that BOTH guard paths existed while
  // `ENTITLEMENTS_ENABLED` was readable, and that the flag defaulted off. Its
  // subject is gone: the flag and the legacy `requireRole` branch were
  // deleted when the `Role` enum was, so "keep the old path executable" now
  // means keeping a branch that can never run and has nothing to fall back
  // to. It is replaced by the two below, which assert what matters once there
  // is only one path.
  it("G24a — there is exactly ONE authorization path", () => {
    // The risk inverted. While two paths existed, the danger was deleting the
    // fallback too early. With one, the danger is a dead flag or a surviving
    // role check that looks like policy and decides nothing — or worse,
    // decides something nobody is reading.
    const guards = read(path.join(API, "lib", "routeGuards.ts"));
    expect(guards, "routeGuards must exist").toBeTruthy();
    // CODE ONLY. The file documents that the flag was removed and why, so the
    // prose necessarily contains its name — and a gate that fires on the
    // explanation of a removal teaches people to delete the explanation.
    const code = guards
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(
      code,
      "the cutover flag is gone — a readable flag nothing branches on is a " +
        "switch that lies about being able to recover.",
    ).not.toContain("ENTITLEMENTS_ENABLED");
    expect(
      code,
      "no guard may fall back to a role check: there is no Role enum to check.",
    ).not.toMatch(/requireRole\(/);
    expect(code, "every decision goes through can().").toMatch(/\bcan\(/);
  });

  it("G24b — no route is gated by a role name", () => {
    // `adminGuard` / `superGuard` / `workerGuard` named a ROLE, which is not
    // what authorizes anything now. A route wanting "someone with `schedule.manage`" would be
    // asking the one question this model exists to stop asking — and the
    // names surviving is how it would creep back.
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      if (!rel.startsWith("routes" + path.sep)) continue;
      for (const [i, line] of read(file).split("\n").entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/\b(worker|admin|super)Guard\b/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "These name a role. Use `requires(entitlement)`, or `approvedUser` for " +
        "an OWNERSHIP route that needs an approved caller and no capability.",
    ).toEqual([]);
  });

  it("G26 — every occurrence creation decides its portfolio, or says why not", () => {
    // THE HOLE THIS CLOSED: `portfolioId` was written by nothing. The backfill
    // migration placed every existing row in the root portfolio and then the
    // column was never touched again — so every visit created after it
    // belonged to no portfolio, and every territorial rollup would have returned
    // a number that quietly shrank over time.
    //
    // There are THIRTEEN creation sites. Four make a real visit and call
    // `syncOccurrencePortfolios`; the rest make tasks, reminders, events,
    // announcements and light estimates, which happen at no property and so
    // belong to no territory. That distinction is worth stating per site
    // rather than inferring, which is what the annotation is for — the same
    // shape as `claimer-invariant-allow`, and for the same reason: four
    // write paths each forgetting something different is how the claimer
    // invariant reached production broken.
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      const lines = read(file).split("\n");
      lines.forEach((line, i) => {
        if (!/jobOccurrence\.create\(/.test(line)) return;
        // The portfolio decision, or the annotation, near the create.
        //
        // The forward reach is deliberately long. The old resolver ran
        // BEFORE the create and handed it an id, so the decision sat a few
        // lines above. The sync runs AFTER — it needs the new row's id —
        // and a `jobOccurrence.create` data block is thirty-odd lines, so
        // a window that only looked ten lines ahead would miss every one
        // of them and report four false offenders.
        const window = lines.slice(Math.max(0, i - 8), i + 45).join("\n");
        if (/syncOccurrencePortfolios\(/.test(window)) return;
        if (/portfolioId:/.test(window)) return;
        if (/occurrence-portfolio-allow:/.test(window)) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "A new occurrence must set its portfolios through syncOccurrencePortfolios, " +
        "which copies the property's current memberships — or carry " +
        "`// occurrence-portfolio-allow: <reason>` when it is not work at a " +
        "property. A visit in no portfolio appears in NO rollup.",
    ).toEqual([]);
  });

  it("G24c — `approvedUser` is only on routes the map calls OWNERSHIP", () => {
    // THE MISTAKE THIS CATCHES, which actually happened: replacing the
    // role-named guards was done with one pass of
    // `adminGuard|superGuard|workerGuard -> approvedUser`. That is correct
    // for the ~100 ownership routes and a privilege escalation everywhere
    // else — it briefly left `POST /users/:id/roles` open to any
    // approved user, so anybody could have granted themselves ADMIN.
    //
    // It compiled, every test passed, and nothing else would have noticed:
    // `approvedUser` is a perfectly valid guard, just the wrong one. The
    // route map is the only thing that knows which routes are ownership, so
    // it is what this checks against.
    const mapPath = path.join(API, "..", "..", "..", "docs", "features", "permissions-ROUTE-MAP.md");
    const md = read(mapPath);
    if (!md) return; // map not present

    const OWNERSHIP_LIKE = new Set(["OWNERSHIP", "PUBLIC", "CLIENT-PORTAL", "SYSTEM"]);
    const mapped = new Map<string, string>();
    let section: string | null = null;
    for (const line of md.split("\n")) {
      const h = /^##\s+(.+?)\s*\(\d+\)\s*$/.exec(line);
      if (h) { section = h[1].trim(); continue; }
      const r = /^\|\s*`(GET|POST|PATCH|PUT|DELETE)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      if (r && section) mapped.set(`${r[1]} ${r[2]}`, section);
    }

    const norm = (p: string) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x");
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      if (!rel.startsWith("routes" + path.sep)) continue;
      const body = read(file);
      for (const m of body.matchAll(/app\.(get|post|patch|put|delete)\("([^"]+)",\s*approvedUser\b/g)) {
        const key = `${m[1].toUpperCase()} ${norm(m[2])}`;
        const bucket = mapped.get(key);
        // An UNMAPPED route is G5's problem, not this one.
        if (bucket && !OWNERSHIP_LIKE.has(bucket)) {
          offenders.push(`${rel}  ${key}  map says ${bucket}`);
        }
      }
    }
    expect(
      offenders,
      "`approvedUser` means 'any approved caller' — correct for an ownership " +
        "route that scopes its own query, and a privilege escalation on " +
        "anything else. Give these a `requires(entitlement)`, or correct the " +
        "route map if it is the thing that is wrong.",
    ).toEqual([]);
  });


  it("G7 — the entitlement vocabulary is the single source for the matrix", () => {
    // The role builder renders from ENTITLEMENT_GROUPS and `can()` gates on
    // ENTITLEMENTS. A value in one and not the other is either ungrantable or
    // invisible, and both failures are silent: the builder shows a checkbox
    // that grants nothing, or a capability nobody can ever be given.
    const ent = read(ENT_FILE);
    expect(ent, "the entitlements module must exist").toBeTruthy();
    const flat = [...ent.matchAll(/^\s*"([a-z]+\.[a-z-]+)",?$/gm)].map((m) => m[1]);
    const grouped = [...ent.matchAll(/\{\s*id:\s*"([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]);
    expect(grouped.length, "no grouped entitlements found — did the shape change?")
      .toBeGreaterThan(40);
    expect(
      [...new Set(grouped)].sort(),
      "every grouped entitlement must appear in the flat union and vice versa",
    ).toEqual([...new Set(flat.length ? flat : grouped)].sort());
    // And nothing may hand-maintain a second list.
    expect(
      ent,
      "the flat union must be DERIVED from the groups, never typed out twice",
    ).toMatch(/flatMap|ENTITLEMENT_GROUPS\s*\.\s*flatMap/);
  });

  it("G8 — no conditional branches on a role, tier or title NAME", () => {
    // Names are labels from a taxonomy the operator edits. Branching on one
    // turns a label into behaviour, so renaming "District" silently changes
    // what the code does — and that is precisely what portfolios-as-assignment and
    // roles-as-capabilities exist to prevent.
    const offenders: string[] = [];
    // A ROLE NAME, a portfolio TIER or a manager TITLE. Deliberately NOT the
    // assignee `role` field, which is a different concept entirely —
    // claimer / observer / helper / primary describe a person's part in one
    // visit, carry no permissions, and comparing them is correct. The first
    // version of this matched `role ===` and reported 91 of them.
    const ASSIGNEE_VOCAB = /"(?:observer|helper|primary|claimer)"/;
    // `typeof x.title === "string"` is a TYPE GUARD, not a branch on a name,
    // and a bare `title` matches guide titles and request payloads. The
    // subject here is specific: a ROLE's name, an PORTFOLIO's tier, or a MANAGER
    // TITLE from the MANAGER_TITLES taxonomy.
    const NAME_COMPARE =
      /\b(?:roleName|customRole\.name|role\.name|\.tier|tierName|managerTitle)\s*(?:===|!==)\s*["'`]/;
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      read(file).split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/name-compare-allow:/.test(line)) return;
        if (ASSIGNEE_VOCAB.test(line)) return;
        if (/\btypeof\b/.test(line)) return;
        if (NAME_COMPARE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "A conditional on a role/tier/title NAME makes a rename a behaviour " +
        "change. Branch on a capability, or on the role's stable `key`.",
    ).toEqual([]);
  });

  it("G11 — field capability is never narrowed by portfolio", () => {
    // Promotion must not shrink where somebody can work: a person looking
    // after one district still covers a visit in the next one when a
    // crewmate calls out. Both halves must hold — the set must exist, and
    // portfolioScope must honour it rather than restating it.
    const perm = read(PERM);
    expect(perm, "NEVER_AREA_SCOPED must exist and be exported").toMatch(
      /export const NEVER_AREA_SCOPED/,
    );
    for (const cap of ["work.claim", "work.complete"]) {
      expect(perm, `${cap} must be in NEVER_AREA_SCOPED`).toMatch(
        new RegExp(`NEVER_AREA_SCOPED[\\s\\S]{0,300}"${cap.replace(".", "\\.")}"`),
      );
    }
    const scope = read(path.join(API, "lib", "portfolioScope.ts"));
    expect(
      scope,
      "portfolioScope must honour NEVER_AREA_SCOPED rather than keep a second copy " +
        "— a capability added to one list and not the other reads as a data bug",
    ).toMatch(/NEVER_AREA_SCOPED\.has\(/);
  });

  it("G28 — every RoleEntitlement write goes through the validator", () => {
    // The column is `String` by design, so an unvalidated write stores a
    // value the builder displays and can() denies — a grant that silently
    // does nothing, with no error anywhere.
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      const src = read(file);
      for (const m of src.matchAll(/roleEntitlement\s*\.\s*(create|createMany|upsert|update)\s*\(/g)) {
        // The enclosing METHOD, found by its indentation — the first
        // version looked back to the nearest `async `, which lands on the
        // `async (tx) =>` transaction callback and misses the validation
        // at the top of the method.
        const fnStart = src.lastIndexOf("\n  async ", m.index);
        const scopeText = src.slice(Math.max(0, fnStart), m.index! + 400);
        if (/assertEntitlement|isEntitlement/.test(scopeText)) continue;
        if (/entitlement-write-allow:/.test(scopeText)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      "A RoleEntitlement write must validate against the TS union first " +
        "(assertEntitlement). A stored value outside it is a grant that looks " +
        "correct in the builder and is refused at the gate.",
    ).toEqual([]);
  });

  it("G31 — no worker type means no entitlements, whatever roles are held", () => {
    // The payroll gate, and it must be FIRST in can(): being in the system is
    // not being cleared to act in it. Checked structurally because the
    // ordering is the property — a gate placed after the role walk would let
    // an unclassified person through on a lucky early return.
    const perm = read(PERM);
    const fn = perm.slice(perm.indexOf("export function can("));
    const gate = fn.indexOf("workerType === null");
    const roleWalk = fn.indexOf("for (const role of");
    expect(gate, "can() must gate on a null workerType").toBeGreaterThan(-1);
    expect(roleWalk, "can() must walk the roles").toBeGreaterThan(-1);
    expect(
      gate,
      "the payroll gate must come BEFORE the role walk, or a person with no " +
        "pay class can be let through by a role match",
    ).toBeLessThan(roleWalk);
  });

  it("G32 — TRAINEE is not a worker type anywhere", () => {
    // It carried no payroll meaning — four money call sites read
    // `EMPLOYEE || TRAINEE` identically — so it was a permission concern
    // living in a tax enum. A trainee is an EMPLOYEE without the field role.
    expect(schema(), "TRAINEE must not be in the WorkerType enum").not.toMatch(
      /enum WorkerType \{[^}]*TRAINEE/,
    );
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(API, file);
      read(file).split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/["'`]TRAINEE["'`]/.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "TRAINEE is gone as a worker type. A trainee is an EMPLOYEE who has not " +
        "been granted field clearance.",
    ).toEqual([]);
  });

  it("G35 — a perspective can only ever narrow", () => {
    // The entire value of the dropdown is that looking at the app as somebody
    // with less access is SAFE. A perspective that grants is not a downgrade.
    // Two independent guarantees, and both must be present:
    const perm = read(PERM);
    expect(
      perm,
      "can() must intersect with the active perspective",
    ).toMatch(/principal\.perspective[\s\S]{0,200}includes\(capability\)/);
    expect(perm, "isValidPerspective must enforce the subset property").toMatch(
      /export function isValidPerspective[\s\S]{0,400}every\(/,
    );
    // And the perspective must be chosen from the person's OWN list, never the header.
    const imp = read(path.join(API, "lib", "impersonation.ts"));
    expect(
      imp,
      "resolvePerspective must only return a perspective present in the caller's own " +
        "available list — that single check is what makes the header incapable " +
        "of granting anything",
    ).toMatch(/available\.find\(/);
  });

  it("G25 — a route narrows by the capability it is GUARDED on", () => {
    // G10 CATCHES A MISSING FILTER. THIS CATCHES A WRONG ONE.
    //
    // `portfolioWhere(principal, cap)` answers "which territories may this person
    // see THROUGH cap". Pass a capability the route is not guarded on and the
    // answer is about the wrong grant:
    //
    //   • a WIDER cap the caller holds company-wide returns `{}` — no
    //     narrowing at all, so a territory-limited manager reads every
    //     region's rows while the route still looks scoped, and G10 is
    //     satisfied because a filter IS present;
    //   • a NARROWER cap they hold nowhere returns the impossible condition,
    //     and the list silently empties for someone entitled to it.
    //
    // Neither is visible from the call site, and both read as correct. The
    // rule that removes the judgement: the capability you narrow by is the
    // capability the route is guarded on. One source, no second decision.
    const ROUTES = path.join(API, "routes");
    const calls: string[] = [];
    const wrong: string[] = [];

    for (const file of walk(ROUTES, /\.ts$/)) {
      if (file.endsWith(".test.ts")) continue;
      const src = read(file);
      const rel = path.basename(file);

      // guard identifier -> entitlement
      const guards = new Map<string, string>();
      for (const g of src.matchAll(/const\s+(\w+)\s*=\s*requires\(\s*"([^"]+)"/g)) {
        guards.set(g[1], g[2]);
      }

      // Route declarations, in source order. A handler runs until the NEXT
      // declaration — bounding on a closing brace instead reads into the
      // following route when the multi-line `app.post(\n "path",\n guard,`
      // form is used, which is how an earlier pass invented a mismatch that
      // was not there.
      const decls = [...src.matchAll(
        /app\.(get|post|patch|put|delete)\s*\(\s*\n?\s*"([^"]+)"\s*,\s*\n?\s*(\w+)\s*,/g,
      )];
      for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        const body = src.slice(d.index!, i + 1 < decls.length ? decls[i + 1].index! : src.length);
        const entitlement = guards.get(d[3]);
        for (const a of body.matchAll(
          /portfolio(?:Where|WhereVia|WhereOn)\s*\((?:[^()]|\([^()]*\))*?"([a-z.\-]+)"/g,
        )) {
          const cap = a[1];
          const where = `${rel}: ${d[1].toUpperCase()} ${d[2]}`;
          calls.push(where);
          // `approvedUser` routes have no entitlement to compare against —
          // they scope themselves in-handler and G24c already polices them.
          if (!entitlement) continue;
          if (cap !== entitlement) {
            wrong.push(`${where} — guarded on \`${entitlement}\` but narrows by \`${cap}\``);
          }
        }
      }
    }

    expect(
      wrong,
      "A portfolio filter must ask about the SAME capability the route is " +
        "guarded on. A wider one stops narrowing for a territory-limited " +
        "caller; a narrower one empties the list for someone entitled to it. " +
        "Both leave a filter in place, so G10 stays green.",
    ).toEqual([]);

    // ── Negative control ────────────────────────────────────────────────
    //
    // The loop above is regexes over files. If the route layer stopped
    // calling portfolioWhere, or the declaration pattern changed shape, `calls`
    // empties and this passes while checking nothing.
    expect(
      calls.length,
      "G25 found no portfolio filters at all. Either threading was removed, or " +
        "the route-declaration pattern changed and this gate is now blind.",
    ).toBeGreaterThanOrEqual(15);
  });

  // STILL MISSING, DELIBERATELY NAMED: there is no LIVE-DATA test that puts
  // a territory-limited principal against each scopable route and asserts no
  // other territory's rows come back. G10 proves a filter is present, G25
  // that it asks the right question — neither executes a query.
  //
  // It cannot be written yet: the seed creates portfolios but ZERO
  // PortfolioAssignment rows, so no persona is territory-limited and there is
  // nothing to be excluded from. Logged in project_deferred_work.md.
  // G27/G28 guard the STAFF floor and the entitlement write boundary. Both
  // subjects are step-1 code that does not exist yet: nothing grants STAFF on
  // user creation, and there is no RoleEntitlement write helper to funnel
  // through. The rows are here so the count cannot quietly shrink.
  // G27 — RETIRED (decision 3, superseded by 40).
  //
  // It guarded the STAFF floor: STAFF was the UserRole row that survived
  // demotion, because a user with zero rows was locked out of their own
  // profile. There is no `Role` enum and no `UserRole` table now, so there
  // is no floor to keep — and the lockout it prevented cannot happen,
  // because "on payroll, holding no roles" is a valid state and profile
  // access is OWNERSHIP rather than a capability (`approvedUser`).
  //
  // Nothing replaces it. The equivalent risk under the new model — a person
  // left with no way in — is covered by the conversion migration's
  // in-transaction assertion that nobody who held a role above STAFF ends
  // with no grant, and by `approvedUser` needing no capability at all.
  it("G29 — no manage-level capability sits in the Trainee or Worker tier", () => {
    // WHAT CHANGED. G29 used to be enforced by
    // `scripts/derive-base-bundles.ts`, which computed what each role
    // granted by reading the route guards. That script is DELETED, because
    // its job disappeared: roles are database rows now, created by the
    // starter script and editable by the operator, so there is nothing left
    // to derive. The failure it existed to catch — a worker-guarded route
    // mapped to a manage verb, then baked into WORKER's computed bundle —
    // cannot happen when the bundle is explicit data rather than a
    // derivation.
    //
    // What remains worth asserting is the SHIPPED DEFAULT. Every new install
    // gets this ladder, and a `.manage` or `.approve` capability landing in
    // Trainee or Worker would hand it to every field worker on day one. The
    // operator can edit roles afterwards and that is the point of the model
    // — this guards what they START from, which is the only part code owns.
    const starter = read(path.join(API, "..", "scripts", "install-starter-roles.ts"));
    expect(starter, "the starter-role script must exist").toBeTruthy();

    // The two lower tiers: Trainee's own list, plus FIELD_CLEARANCE, which
    // is what Worker adds.
    const tierAdds = (key: string) => {
      const at = starter.indexOf(`key: "${key}"`);
      expect(at, `${key} not found in the ladder`).toBeGreaterThan(-1);
      const block = starter.slice(at, starter.indexOf("},", at));
      return [...block.matchAll(/"([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]);
    };
    const fieldBlock = starter.slice(
      starter.indexOf("const FIELD_CLEARANCE"),
      starter.indexOf("]", starter.indexOf("const FIELD_CLEARANCE")),
    );
    const lower = [
      ...tierAdds("seedlings.trainee"),
      ...[...fieldBlock.matchAll(/"([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]),
    ];
    expect(lower.length, "parsed no capabilities — did the ladder's shape change?")
      .toBeGreaterThan(10);

    // The privileged verbs. `.create` / `.accept` / `.charge` / `.contribute`
    // are deliberately NOT here: a worker raising an estimate, accepting one
    // or charging materials on their own visit is ordinary field work, and
    // the ownership check is what bounds it.
    const PRIVILEGED = /\.(manage|approve|record|adjust|define|grant-roles|export-tax)$/;
    const offenders = lower.filter((e) => PRIVILEGED.test(e)).sort();
    expect(
      offenders,
      "These sit in the Trainee or Worker tier of the SHIPPED ladder, so " +
        "every field worker on a fresh install would hold them. A worker " +
        "acting on their own record is OWNERSHIP — gate it on approval and " +
        "scope the query, rather than handing out a manage verb.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[G37] no source reads a field the cord-cut deleted", () => {
  /**
   * THE BUG CLASS THIS EXISTS FOR.
   *
   * Three live bugs in one afternoon, all the same shape: code read a field
   * that no longer exists, through a cast that hid it from the compiler.
   *
   *   businessStartCutoff.ts  `(req as any).user?.roles` → `undefined?.includes("SUPER")`
   *                           → the X-Reveal-Pre-Cutoff header silently stopped working.
   *   the route layer       `(req.user?.roles ?? []).includes("SUPER")` → `[]`
   *                           → NOBODY could set an hourly wage, at all.
   *   pay/[paymentToken].tsx  `me.roles.map(r => r.role)` → `[]`
   *                           → a worker opening a client's pay link was served
   *                             the client's payment methods.
   *
   * None of the three failed to compile. Two failed closed and one failed
   * open, which is the part that makes the class dangerous: you cannot
   * predict the direction, so you cannot reason about the blast radius
   * without finding every instance.
   *
   * `as any` is why the compiler stayed quiet, and it is far too common in a
   * Fastify codebase to ban outright. So this gate bans the NAMES instead —
   * every identifier the cord-cut removed. Deleting a field from the schema
   * or the request type is now a two-step job: delete it, then add it here,
   * and the scan finds the readers the compiler cannot.
   */
  const REMOVED: Array<{ pattern: RegExp; what: string; instead: string }> = [
    {
      // `.roles` read off a request or a /me payload. `customRoles`,
      // `realRoles` and `roleGrants` are real fields and are excluded by
      // the leading boundary plus the explicit prefixes.
      pattern: /(?<![A-Za-z])(?:req|request|user|me|m|u)\s*(?:\?\.|\.)\s*(?:user\s*(?:\?\.|\.)\s*)?roles\b/,
      what: "`.roles` — the Role enum and the UserRole table are deleted",
      instead:
        "`callerCan(req, cap)` on the server, `holds(me, cap)` in the web app",
    },
    {
      pattern: /\brequireRole\s*\(/,
      what: "`requireRole()` — it compared against a roles array",
      instead: "`requires(entitlement)` from lib/routeGuards",
    },
    {
      pattern: /\b(?:admin|super|worker|staff)Guard\b/,
      what: "a per-role guard constant",
      instead: "`requires(entitlement)`, or `approvedUser` for an ownership-gated route",
    },
    {
      pattern: /\bresolvePrivileges\b|lib\/privileges/,
      what: "`resolvePrivileges` / lib/privileges — deleted, it was a second source of truth",
      instead: "the capability itself (`inventory.pull`, `expenses.charge`)",
    },
    {
      pattern: /\bRoleVal\b|\bRole\.(?:ADMIN|SUPER|WORKER|STAFF)\b/,
      what: "a Role enum member",
      instead: "the entitlement the route actually needs",
    },
    {
      pattern: /\bprisma\s*\.\s*userRole\b|\btx\s*\.\s*userRole\b/,
      what: "the UserRole table",
      instead: "`UserCustomRole` (`prisma.userCustomRole`)",
    },
    {
      pattern: /"TRAINEE"|'TRAINEE'|\bTRAINEE\b/,
      what: "the TRAINEE worker type — removed; it conflated pay class with clearance",
      instead:
        "the Trainee ROLE for clearance (`seedlings.trainee`), and EMPLOYEE / CONTRACTOR / UNPAID for pay class",
    },
    {
      // The two removed User columns. `privileges.canPullInventory` on the
      // /me payload is a different thing and still exists, so the match is
      // anchored to a user-ish receiver.
      pattern: /(?<![A-Za-z])(?:user|u|row|person)\s*(?:\?\.|\.)\s*can(?:PullInventory|ChargeBusinessExpenses)\b/,
      what: "a removed User privilege column",
      instead: "the capability (`inventory.pull`, `expenses.charge`)",
    },
    {
      // A TYPE named for the deleted concept. The web's surface selector was
      // `export type Role = "SUPER" | "ADMIN" | "WORKER"`, which is not an
      // authorization type at all — it answers "which layout am I rendering".
      // Carrying the old name on it is how `mustBeAssigned` once read as a
      // visibility rule and shipped a client-visibility bug. It is `Surface`
      // now. Anchored to the declaration so `CustomRole`, `UserCustomRole`
      // and `RoleEntitlement` are untouched.
      pattern: /\b(?:export\s+)?type\s+Role\s*=/,
      what: "a type named `Role` — the enum is deleted and this is a SURFACE",
      instead: "`Surface` from apps/web/src/lib/types.ts, and `scope.can(capability)` for any actual permission question",
    },
  ];

  const scanned = () => [...apiFiles(), ...webFiles()];

  /**
   * Blank out every comment while KEEPING line numbers, so a hit can still
   * be reported as `file:line`.
   *
   * The per-line `/^\s*(\/\/|\*)/` test the older gates in this file use
   * is not enough here: these names live mostly in prose, and prose wraps.
   * A block comment's second line often starts with a bare word, so a
   * line-shaped filter flagged a dozen paragraphs explaining the very
   * migration this gate enforces. String literals are deliberately NOT
   * blanked — `"TRAINEE"` in code is one of the things being looked for.
   */
  function stripComments(src: string): string {
    let out = "";
    let i = 0;
    type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
    let mode: Mode = "code";
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (mode === "code") {
        if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
        if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
        if (c === "'") mode = "sq";
        else if (c === '"') mode = "dq";
        else if (c === "`") mode = "tpl";
        out += c; i++; continue;
      }
      if (mode === "line") {
        if (c === "\n") { mode = "code"; out += c; } else out += " ";
        i++; continue;
      }
      if (mode === "block") {
        if (c === "*" && n === "/") { mode = "code"; out += "  "; i += 2; continue; }
        out += c === "\n" ? c : " "; i++; continue;
      }
      // Inside a string: copy through, honour escapes, and bail on a newline
      // so an unterminated quote cannot swallow the rest of the file.
      if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
      if (c === "\n") { mode = "code"; out += c; i++; continue; }
      if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) mode = "code";
      out += c; i++; continue;
    }
    return out;
  }

  it("scans a meaningful number of files", () => {
    // A scan that silently stops finding files is a gate that passes
    // vacuously — the exact failure this file's header warns about.
    expect(scanned().length).toBeGreaterThan(200);
  });

  for (const { pattern, what, instead } of REMOVED) {
    it(`no live code reads ${what.split("—")[0].trim()}`, () => {
      const hits: string[] = [];
      for (const file of scanned()) {
        // Comments are the one place these names SHOULD still appear:
        // every fix above left a note saying what the field used to be, so
        // the next reader doesn't rediscover the bug.
        const src = stripComments(read(file));
        src.split("\n").forEach((line, i) => {
          if (!pattern.test(line)) return;
          hits.push(`${path.relative(path.join(API, "../../.."), file)}:${i + 1}  ${line.trim()}`);
        });
      }
      expect(
        hits,
        `${what}.\nUse ${instead} instead.\n` +
          "These reads do not fail to compile — an `as any` or an optional " +
          "chain makes them silently undefined, and the behaviour around " +
          "them changes with no error anywhere.",
      ).toEqual([]);
    });
  }

  it("G24d — an `approvedUser` route that takes a target-user param checks it", () => {
    /**
     * `approvedUser` IS A PROMISE, AND NOTHING WAS VERIFYING IT.
     *
     * The guard means "an approved caller, and the handler scopes its own
     * query to them" — that is why it carries no entitlement. G24c checks
     * the ROUTE MAP calls such a route ownership. It cannot check the
     * handler actually behaves like ownership.
     *
     * `/preview/route-suggestions` did not. It honoured `?userId=` with no
     * check, so any approved account could read anyone's claimed schedule
     * plus their email, worker type and home-base address — and the handler
     * named that branch `isAdminRoute` while gating nothing on it. It had
     * been role-gated before the cord-cut; converting it to `approvedUser`
     * is what opened it.
     *
     * So: if an ownership-gated handler reads a target-user parameter, it is
     * acting on somebody else by definition, and something in that handler
     * must decide whether it may. A sweep found 97 `approvedUser` routes, 6
     * of which take such a parameter — small enough to hold the line on.
     */
    const offenders: string[] = [];
    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      const src = read(file);
      const lines = src.split("\n");
      for (const m of src.matchAll(
        /app\.(get|post|patch|delete|put)\(\s*"([^"]+)"\s*,\s*approvedUser/g,
      )) {
        const start = src.slice(0, m.index!).split("\n").length - 1;
        const body = lines.slice(start, start + 60).join("\n");
        const takes = /query\??\.(userId|targetUserId|viewAsUserId|asUserId)/.exec(body);
        if (!takes) continue;
        const CHECK = /callerCan\(|userCan\(|httpErrors\.forbidden|NOT_AUTHORIZED|ServiceError\(\s*\n?\s*"FORBIDDEN"/;

        // One level of indirection. The payroll routes delegate to a shared
        // `resolvePayrollTarget(req)` that throws 403 unless the caller is
        // someone with `schedule.manage` — the right structure, and a check this gate must not
        // call a leak. So if the handler calls a helper declared in the same
        // file, the helper's own body counts.
        const viaHelper = [...body.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*req\b/g)].some((c) => {
          const decl = new RegExp(
            `(?:async\\s+)?function\\s+${c[1]}\\s*\\(`,
          ).exec(src);
          if (!decl) return false;
          return CHECK.test(src.slice(decl.index!, decl.index! + 1500));
        });

        const checks = CHECK.test(body) || viaHelper;
        if (!checks) {
          offenders.push(
            `${path.relative(path.join(API, "../../.."), file)}: ` +
              `${m[1].toUpperCase()} ${m[2]} reads ?${takes[1]} with no authorization check`,
          );
        }
      }
    }
    expect(
      offenders,
      "An ownership-gated route that accepts a target-user parameter is not " +
        "ownership-gated. Either check the capability that permits acting on " +
        "someone else, or stop reading the parameter.",
    ).toEqual([]);
  });

  it("G40 — no route path names a role", () => {
    /**
     * A URL IS A NAME, AND THESE NAMES LIE.
     *
     * `/clients` is not authorized by the word "admin" — the guard is,
     * and it asks for `clients.view`. So the prefix never granted anything.
     * It did something worse: it told every reader that routes come in tiers,
     * in a system where they do not, and that belief is what produced the
     * day's real bugs. Someone reading a role-prefixed documents path
     * reasonably assumed something enforced the prefix. Nothing did.
     *
     * Where the prefix was LOAD-BEARING it was a security hole outright: the
     * two prefixed twins of `/documents` were the SAME handler, differing
     * only in whether admin-hidden records came back, gated on the SAME
     * entitlement — so the client chose its own privilege level by picking a
     * URL. NINE routes were like that (verified against HEAD), including a
     * timeline pair sitting on a capability every trainee holds.
     *
     * Every role-named path is gone. Measured against HEAD: 431 route
     * declarations began with a role segment, across 354 distinct paths and
     * 415 distinct verb+suffix combinations. 33 of those combinations already
     * had a bare `/X` twin serving the same resource and had to be MERGED
     * before they could be renamed. Each is now one route that decides from
     * a capability. `PENDING_RESOURCES` is empty and must stay that way.
     */
    const PENDING_RESOURCES = new Set<string>([]);

    const offenders: string[] = [];
    const pendingSeen = new Set<string>();

    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      const src = read(file);
      for (const m of src.matchAll(/app\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)) {
        const route = m[2];
        const seg = route.split("/")[1];
        if (seg !== "admin" && seg !== "super") continue;
        const resource = route.split("/")[2] ?? "";
        if (PENDING_RESOURCES.has(resource)) { pendingSeen.add(resource); continue; }
        offenders.push(
          `${path.relative(path.join(API, "../../.."), file)}: ${m[1].toUpperCase()} ${route}`,
        );
      }
    }

    expect(
      offenders,
      "A route path may not begin with a role name. Authorization is the " +
        "guard's entitlement; the path is just the resource. Drop the " +
        "prefix — and if a bare twin already exists, merge the two handlers " +
        "into one that decides from a capability rather than from the URL.",
    ).toEqual([]);

    // The list must only shrink. A resource that no longer has a prefixed
    // route is a merge that landed — delete it, or the exemption quietly
    // covers the next one somebody adds.
    expect(
      [...PENDING_RESOURCES].filter((r) => !pendingSeen.has(r)).sort(),
      "These resources are exempted but no longer have any /admin or /super " +
        "route. The work is done — remove them from PENDING_RESOURCES.",
    ).toEqual([]);
  });

  it("G41 — no role name anywhere in a route path, not just the prefix", () => {
    /**
     * THE PREFIX CHECK ABOVE LOOKED ONLY AT SEGMENT 1, AND ONLY FOR TWO WORDS.
     *
     * It compared `route.split("/")[1]` against "admin" and "super". Two holes
     * fell out of that, and one of them was occupied:
     *
     *   1. `worker` and `staff` were never checked at all, though both were
     *      `Role` enum values. A `/worker/...` path would have sailed through
     *      the gate that exists to forbid exactly that.
     *   2. A role name attached to an ACTION rather than used as a tier was
     *      invisible. `POST /occurrences/:occurrenceId/admin-mark-paid` lived
     *      through the entire rename this way: segment 1 is "occurrences", so
     *      the check never looked further. The name still told the reader that
     *      an "admin" does this, in a system where a capability does
     *      (`money.record`), which is the precise belief the rename exists to
     *      destroy. It is now `/occurrences/:occurrenceId/mark-paid`.
     *
     * WHAT IS STILL ALLOWED, DELIBERATELY: `worker` as a DOMAIN NOUN. A
     * `/workers` collection and a `users/:id/worker-type` field are not tiers
     * — `workerType` is a real column (EMPLOYEE / CONTRACTOR / UNPAID) and
     * `isPaid()` reads it to decide whether someone can hold a paid seat.
     * Forbidding the word outright would rename live domain vocabulary to
     * satisfy a rule about authorization. So: a segment that IS a role name is
     * banned; a segment that merely CONTAINS "worker" is not.
     */
    const ROLE_WORDS = ["admin", "super", "worker", "staff"];
    // A role word used as a qualifier on an action name. "worker-" is absent
    // on purpose — see `worker-type` above.
    const QUALIFIER = /^(admin|super|staff)-/;

    const offenders: string[] = [];
    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      const src = read(file);
      for (const m of src.matchAll(/app\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)) {
        const route = m[2];
        for (const seg of route.split("/")) {
          if (!seg || seg.startsWith(":")) continue;
          const bad =
            ROLE_WORDS.includes(seg.toLowerCase()) || QUALIFIER.test(seg.toLowerCase());
          if (bad) {
            offenders.push(
              `${path.relative(path.join(API, "../../.."), file)}: ` +
                `${m[1].toUpperCase()} ${route}  (segment "${seg}")`,
            );
            break;
          }
        }
      }
    }

    expect(
      offenders,
      "A role name may not appear as a path segment ANYWHERE in a route, " +
        "nor as a qualifier on an action (`admin-mark-paid`). There are no " +
        "roles — a capability decides, and the path is just the resource. " +
        "Rename the segment to say what the action DOES.",
    ).toEqual([]);
  });

  it("G39 — nobody resolves the CALLER's capabilities by a fresh read", () => {
    /**
     * THE VIEW-AS BYPASS, FOR THE FOURTH TIME.
     *
     * `userCan(db, id, …)` and `capabilitiesForUsers(db, [id])` read a
     * person's REAL grants. For somebody ELSE that is correct and necessary.
     * For the CALLER it is the bug this repo has shipped three times: it
     * ignores the active perspective, so someone with `settings.manage` looking through a Trainee
     * perspective keeps every power they are pretending not to have.
     *
     * Twelve call sites did it, in jobs, supplies, invoiceCharges, payroll
     * and the client-impersonation plugin. None was careless — services take
     * `currentUserId: string`, so the principal could not reach them and the
     * forbidden read was the only tool available. The fix was a channel:
     * `CallerCan`, a test the route resolves once from the narrowed principal
     * and passes down as an argument.
     *
     * A legitimate target check still reads by id — `equipment.reserve` asks
     * whether the person the gear is FOR is cleared to hold stock, which must
     * not change because the caller narrowed their own view. So this gate
     * looks for the caller's OWN id as the subject, not for the helpers.
     */
    // WIDENED 2026-10-13. The list used to stop at the six names below, and
    // a real bypass walked straight through the gap: `GET /occurrences`
    // resolved field clearance with `userCan(prisma, uid, "inventory.pull")`.
    // The subject was named `uid`, which was not in this list, so G39 never
    // looked at the line — while the CORRECT ternary sat three lines above it
    // on `schedule.manage`. A gate keyed to variable NAMES only catches the
    // names somebody remembered. `uid` and `user.id` are the two commonest
    // spellings of "the person this request is about", so they are in.
    const CALLER_ID =
      /\b(uid|user\.id|currentUserId|callerUser\.id|callerUid|actionUser\.id|caller\.id|claimUser\.id)\b/;
    const offenders: string[] = [];

    for (const file of [...walk(path.join(API, "services"), /\.ts$/),
                        ...walk(path.join(API, "routes"), /\.ts$/),
                        ...walk(path.join(API, "plugins"), /\.ts$/)]) {
      if (/userCapabilities\.ts$/.test(file)) continue;
      const lines = read(file).split("\n");
      lines.forEach((line, i) => {
        // Comments are where these names SHOULD still appear: every fix left
        // a note naming the call it replaced.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // DOCUMENTED EXCEPTION, same convention as `view-as-allow` and
        // `date-handling-allow`. One case is real: an `onRequest` hook runs
        // before any route preHandler, so `req.principal` does not exist yet
        // and there is nothing to read the caller off. Such a site must
        // resolve the perspective itself — and must say so, in a reason long
        // enough to be a reason.
        const prior = lines.slice(Math.max(0, i - 6), i).join("\n");
        const allow = /\/\/\s*caller-read-allow:(.*)/.exec(prior);
        if (allow && allow[1].trim().length >= 20) return;
        const m = /(?:await\s+)?(?:userCan|capabilitiesForUsers)\(\s*(?:prisma|tx|db)\s*,\s*([^,)]+)/.exec(line);
        if (!m) return;
        if (!CALLER_ID.test(m[1])) return;
        // The documented correct shape is an explicit branch: ask `callerCan`
        // for yourself, `userCan` only for somebody else.
        const ctx = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
        if (/callerCan\(/.test(ctx)) return;
        offenders.push(
          `${path.relative(path.join(API, "../../.."), file)}:${i + 1}  ` +
            `resolves ${m[1].trim()} (the caller) by a fresh read`,
        );
      });
    }

    expect(
      offenders,
      "Use the `CallerCan` passed in from the route — it comes from the " +
        "already-narrowed principal. A fresh read by the caller's own id " +
        "returns their real grants and silently defeats view-as.",
    ).toEqual([]);
  });

  it("G42 — the cron routes fail CLOSED when the secret is missing", () => {
    /**
     * THE `&&` THAT DISABLED THE ONLY CHECK.
     *
     * Every route in `routes/cron.ts` used to carry its own copy of:
     *
     *     if (secret && authHeader !== `Bearer ${secret}`) return 401
     *
     * When `CRON_SECRET` is unset, `secret` is undefined, the `&&`
     * short-circuits, and the request is ALLOWED. A missing secret therefore
     * switched off the only protection these endpoints had — and
     * `plugins/auth.ts` does not reject unauthenticated requests (it sets
     * `req.auth = {}` and continues), so nothing else stood behind it. In
     * production the old code logged "request allowed but this is insecure"
     * and then ran the job for whoever asked.
     *
     * Three of the four are real scheduled jobs in `vercel.json#crons`, and
     * one of those pushes a notification to every worker.
     *
     * This gate asserts the SHAPE that cannot fail open: one shared helper,
     * which refuses in production when no secret is configured, and no route
     * carrying its own `secret &&` short-circuit.
     */
    const src = read(path.join(API, "routes", "cron.ts"));

    // Comments quote the old pattern deliberately — strip them before
    // scanning, or this gate fails on its own explanation.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    expect(
      code,
      "no cron route may guard itself with `secret && …` — that short-" +
        "circuits to ALLOWED when the secret is unset.",
    ).not.toMatch(/secret\s*&&/);

    expect(
      code,
      "the shared cron authorization helper must exist.",
    ).toMatch(/function cronAuthorized\(/);

    expect(
      code,
      "a missing secret in production must REFUSE, not warn-and-continue.",
    ).toMatch(/refusing to run unprotected/);

    // Every cron route has to actually call it, or the helper is decoration.
    const routes = [...code.matchAll(/app\.(get|post)\(\s*"(\/cron\/[^"]+)"/g)];
    expect(routes.length, "cron routes not found — file renamed?").toBeGreaterThan(0);
    const calls = [...code.matchAll(/cronAuthorized\(/g)];
    expect(
      calls.length,
      `all ${routes.length} cron routes must call cronAuthorized; found ` +
        `${calls.length} call(s).`,
    ).toBeGreaterThanOrEqual(routes.length);
  });

  it("G43 — every `in-handler-scoped` annotation names a route and a reason", () => {
    /**
     * THE ANNOTATION THAT EXCUSES A GUARD FROM ITS OWN ALLOW TEST.
     *
     * A route may use its entitlement as a FLOOR and then apply a narrower
     * rule — "you must be the claimer of this visit", "you must be on this
     * job". Holding the entitlement is then correctly not enough, so the API
     * e2e suite's ALLOW assertion does not apply, and the route says so with
     * `// in-handler-scoped: <reason>` above its declaration.
     *
     * That makes it an excuse, and every excuse in this repo is gated the
     * same way (`view-as-allow`, `caller-read-allow`,
     * `claimer-invariant-allow`, `date-handling-allow`): it must carry a
     * reason long enough to be a reason, and it must be attached to the thing
     * it excuses.
     *
     * The e2e suite additionally VERIFIES each annotation is load-bearing —
     * an annotated route that starts admitting a bare entitlement holder
     * fails there. That already caught an annotation I added to
     * `POST /occurrences/:id/complete` which could never fire, because the
     * route validates its body first and answers 400. This gate is the static
     * half: shape and reason.
     */
    const DECL = /app\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(/;
    const offenders: string[] = [];

    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      if (file.endsWith(".test.ts")) continue;
      const lines = read(file).split("\n");
      const rel = path.relative(path.join(API, "../../.."), file);

      lines.forEach((line, i) => {
        const m = /\/\/\s*in-handler-scoped:(.*)$/.exec(line);
        if (!m) return;

        // A reason, not a shrug.
        if (m[1].trim().length < 20) {
          offenders.push(
            `${rel}:${i + 1} — reason is too short to be a reason ("${m[1].trim()}")`,
          );
        }

        // It must sit above a route declaration, with nothing but comment
        // lines between. An orphaned annotation silently excuses whichever
        // route happens to follow it.
        let j = i + 1;
        while (j < lines.length && /^\s*(\/\/|$)/.test(lines[j] ?? "")) j++;
        if (!DECL.test(lines[j] ?? "")) {
          offenders.push(
            `${rel}:${i + 1} — not attached to a route declaration; the next ` +
              `non-comment line is \`${(lines[j] ?? "").trim().slice(0, 60)}\``,
          );
        }
      });
    }

    expect(
      offenders,
      "`// in-handler-scoped:` excuses a route from the e2e suite's ALLOW " +
        "assertion, so it must name a real reason and sit directly above the " +
        "route it excuses.",
    ).toEqual([]);
  });

  it("G38 — every entitlement is held by some starter role", () => {
    /**
     * INHERITANCE CUTS BOTH WAYS, AND THIS IS THE BUG IT CAUSES.
     *
     * Restoring the `books.view` boundary on the company books meant taking
     * `books.view` out of the base starter role. But the tiers INHERIT, so
     * removing it from the base removed it from everything above too — and for one
     * reseed nobody in the system held `books.view` at all, which made 19
     * routes unreachable by every role the installer creates. Nothing failed:
     * the entitlement existed, the routes declared it, the roles were valid,
     * and the only symptom would have been a 403 on a screen somebody opened
     * later.
     *
     * An entitlement no starter role grants is either dead vocabulary or a
     * locked door. Both are worth a build failure.
     *
     * This asserts the SHIPPED LADDER, not the database: a fresh install is
     * what the installer produces, and an operator is free to build roles
     * that hold any subset afterwards.
     */
    const starter = read(path.join(API, "../scripts/install-starter-roles.ts"));
    expect(starter, "install-starter-roles.ts not found").not.toBe("");

    const granted = new Set(
      [...starter.matchAll(/"([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]),
    );
    const all = [...read(ENT_FILE).matchAll(/\{ id: "([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]);
    expect(all.length, "could not parse the entitlement list").toBeGreaterThan(30);

    const orphans = all.filter((e) => !granted.has(e)).sort();
    expect(
      orphans,
      "No starter role grants these, so a fresh install has routes nobody " +
        "can reach. Add each to the tier that should hold it — and remember " +
        "that removing one from a BASE role removes it from every role that " +
        "inherits that base.",
    ).toEqual([]);
  });

  it("G37b — no guard is named for a role", () => {
    /**
     * WHAT THIS REPLACED, AND WHY THE FIRST VERSION WAS WRONG.
     *
     * The original G37b asserted that a `_super`-suffixed guard must not
     * resolve to the same entitlement as its `_admin` sibling. It caught a
     * real bug — every `content.approve` guide route was reachable by any admin
     * while the constant still said `_super` — but its premise was the dead
     * role model. "Admin" and "Super" are not tiers in this system: they are
     * two `CustomRole` rows whose contents an operator edits, and whether
     * one of them holds `books.view` is a line in the starter script, not a
     * property of a route.
     *
     * Reasoning in tiers is also what produced the worse bug that followed.
     * Told that 14 superGuard'd read routes resolved to an entitlement the
     * Admin role held, I repointed them at `books.manage` — putting READS
     * behind a WRITE verb, so "let the bookkeeper read the P&L" became
     * ungrantable without also granting the power to rewrite the books. The
     * vocabulary was never wrong. The seed was.
     *
     * So the rule is now the one that actually holds: a route declares the
     * CAPABILITY it needs, and nothing in its name may claim a role. A name
     * that says `_super` is a claim the code cannot keep — and the moment it
     * stops being true, nothing fails.
     */
    const offenders: string[] = [];
    for (const file of walk(path.join(API, "routes"), /\.ts$/)) {
      const src = read(file);
      for (const m of src.matchAll(
        /const\s+([A-Za-z0-9_]+)\s*=\s*requires\(\s*"([^"]+)"\s*\)/g,
      )) {
        const [, name, entitlement] = m;
        if (/_(admin|super|worker|staff|trainee)\b/i.test(name)) {
          offenders.push(
            `${path.relative(path.join(API, "../../.."), file)}: ${name} ` +
              `(requires "${entitlement}")`,
          );
        }
      }
    }
    expect(
      offenders,
      "A guard constant may not be named for a role. Roles are editable " +
        "database rows — `seedlings.admin` holding a capability is a seed " +
        "default, not a fact about the route. Name the guard after the " +
        "entitlement it requires (`req_booksView` for `books.view`), so the " +
        "name cannot drift from the check.",
    ).toEqual([]);
  });

  it("the FastifyRequest augmentation does not re-declare `roles`", () => {
    // The structural half. While `req.user` carried a `roles` field in its
    // type, every read of it compiled — which is how a caller with `schedule.manage`.ts wage gate
    // went unnoticed. Keeping it off the interface is what makes the NEXT
    // one a build error rather than a scan hit.
    const rbac = read(path.join(API, "plugins/rbac.ts"));
    expect(rbac, "rbac.ts not found — did the plugin move?").not.toBe("");
    const augmentation = rbac.slice(rbac.indexOf('declare module "fastify"'));
    expect(
      /\broles\s*\??\s*:/.test(augmentation),
      "`roles` is back on the FastifyRequest augmentation. The field does " +
        "not exist on the user row any more, so declaring it makes every " +
        "read of it compile and return undefined.",
    ).toBe(false);
  });
  it("G45 — the database still refuses a dormant grant on a customer", () => {
    // THE SECOND HALF OF THE PAYROLL GATE, and the half code cannot assert.
    //
    // `can()` makes a grant to a customer resolve to nothing (G31), which is
    // what makes such a grant look harmless. It is dormant, not void: give
    // that account a worker type later and every grant on it wakes up at
    // once. The rule spans User, UserCustomRole and ClientContact, so it
    // lives in a trigger rather than a CHECK — the only trigger in the
    // schema, and therefore the easiest thing in it to delete by accident.
    //
    // This asserts the migration is still there and still installs all
    // three entry points. A later migration dropping them would not be
    // caught here; nothing short of querying a live database would. That is
    // the limit of a source scan, and it is still worth the floor.
    const dir = path.join(API, "../prisma/migrations/20261020140000_client_grants_require_a_worker_type");
    const sql = read(path.join(dir, "migration.sql"));
    expect(sql, "the client/grant guard migration is missing").not.toBe("");

    for (const trigger of [
      "user_custom_role_requires_worker_type",
      "user_worker_type_cleared_with_grants",
      "client_contact_linked_to_grantee",
    ]) {
      expect(sql, `the guard must still install ${trigger}`).toContain(`CREATE TRIGGER ${trigger}`);
    }
    expect(
      sql,
      "the shared assertion must still exist — the three triggers all call it",
    ).toContain("FUNCTION public.assert_client_grant_has_worker_type");

    // No later migration may quietly undo it.
    const migRoot = path.join(API, "../prisma/migrations");
    const dropped: string[] = [];
    for (const name of readdirSync(migRoot)) {
      if (name <= "20261020140000_client_grants_require_a_worker_type") continue;
      const body = read(path.join(migRoot, name, "migration.sql"));
      if (/DROP\s+TRIGGER[\s\S]{0,120}(user_custom_role_requires_worker_type|user_worker_type_cleared_with_grants|client_contact_linked_to_grantee)/i.test(body)
          || /DROP\s+FUNCTION[\s\S]{0,80}assert_client_grant_has_worker_type/i.test(body)) {
        dropped.push(name);
      }
    }
    expect(
      dropped,
      "a later migration drops the client/grant guard. A customer could then " +
        "be handed a dormant role grant that activates the day somebody sets " +
        "a worker type on their account.",
    ).toEqual([]);
  });
});

describe("[G47] the portfolio lens", () => {
  it("G47 — the portfolio lens narrows visibility and never authorization", () => {
    // A LENS MAY HIDE A ROW. IT MAY NEVER REFUSE AN ACTION.
    //
    // `principal.lensPath` is the viewer's own "show me only Durham". It is
    // a `where` fragment and nothing else. The moment a permission check
    // reads it, the control stops being a filter and becomes a cage: a
    // worker looking at Durham opens the Chapel Hill visit they are
    // covering and gets a 403 from a dropdown they set last Tuesday —
    // and the refusal names a capability they genuinely hold, so it reads
    // as a permissions bug and gets "fixed" by widening a grant.
    //
    // The rule is mechanical: `lensPath` may be DECLARED in the permissions
    // package and READ by portfolioScope (which builds query filters) and by the
    // plugin that resolves it. Nowhere else.
    const permsSrc = read(path.resolve(API, "../../../packages/permissions/permissions.ts"));
    expect(permsSrc, "the permissions package is missing").not.toBe("");

    // Strip the Principal type's own declaration + doc comment; what is
    // left is executable logic, and none of it may mention the lens.
    const declEnd = permsSrc.indexOf("export const NEVER_AREA_SCOPED");
    expect(declEnd, "NEVER_AREA_SCOPED moved — this gate's slice is stale").toBeGreaterThan(0);
    const logic = permsSrc.slice(declEnd);
    expect(
      logic.includes("lensPath"),
      "can() (or something after it in @repo/permissions) reads `lensPath`. " +
        "The portfolio lens must never decide whether an action is allowed — only " +
        "which rows a query returns. See lib/portfolioLens.ts.",
    ).toBe(false);

    // And on the API side, only the files that are allowed to.
    //
    // THE TEST FOR ADMISSION IS NOT "it needs the lens" — it is "nothing it
    // does with the lens can become a refusal". The first three build the
    // query filter, resolve the header and attach it. The fourth picks which
    // coordinates to forecast: a wrong value there anchors the weather on an
    // unhelpful town, which is a bad forecast, not a locked door. A handler
    // that branched on `lensPath` to decide whether to ANSWER would not
    // qualify, however convenient — route that through portfolioWhere().
    const allowed = new Set([
      path.join(API, "lib/portfolioScope.ts"),
      path.join(API, "lib/portfolioLens.ts"),
      path.join(API, "plugins/rbac.ts"),
      path.join(API, "routes/weather.ts"),
    ]);
    const offenders = apiFiles().filter(
      (f) => !allowed.has(f) && /\blensPath\b/.test(read(f)),
    );
    expect(
      offenders.map((f) => path.relative(API, f)),
      "`lensPath` is read outside portfolioScope/portfolioLens/rbac. A lens belongs in " +
        "a query filter, not in a handler's decision — route it through " +
        "portfolioWhere() so it cannot turn into a refusal.",
    ).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// G48 — `inventory.pull` IS NOT FIELD CLEARANCE.
//
// It has now been read as one FOUR times. The starter Field Clearance role
// grants `work.claim`, `work.complete` and `inventory.pull` together, so
// for as long as those travelled as a bundle the wrong read was invisible —
// every holder of one held all three. The grantable "May pull inventory"
// role broke the bundle ON PURPOSE: it exists for the office person who
// fetches supplies and runs no visits.
//
// Each time, the consequence was the same and silent: that person was
// treated as field-cleared and handed the uncleared-redaction BYPASS —
// other workers' payment splits, completion percentages, promised payouts,
// processor fees and expense costs. The fourth copy was found on
// `GET /occurrences/mine` on 2026-10-28, forty lines from a comment that
// named the first three.
//
// Clearance is `work.claim`. Seeing what the crew is paid is
// `work.claim || money.view` — being on the crew, or the money being your
// job. Fetching a mower is neither.
// ─────────────────────────────────────────────────────────────────────────────
describe("[G48] inventory.pull is not a clearance test", () => {
  /** Lines where the entitlement decides who may see something. */
  const SUSPECT = /(cleared|redact|bypass|maySee|canSee|visib)/i;

  function sources(): string[] {
    return [
      ...walk(path.join(API, "routes"), /\.ts$/),
      ...walk(path.join(API, "services"), /\.ts$/),
      ...walk(path.join(API, "lib"), /\.ts$/),
      ...walk(path.join(WEB, "src"), /\.tsx?$/),
    ].filter((f) => !/\.test\.tsx?$/.test(f));
  }

  it("catches one when shown one", () => {
    // The gate reads its own detector back, so a regex that quietly stops
    // matching cannot pass by finding nothing.
    expect(SUSPECT.test('      callerCan(req, "inventory.pull"),  // callerFieldCleared')).toBe(true);
    expect(SUSPECT.test('const cleared = can("inventory.pull");')).toBe(true);
    expect(SUSPECT.test('redactUnclearedFieldsForCaller(rows, uid, pull, admin)')).toBe(true);
    // …and leaves an honest use alone: actually pulling inventory.
    expect(SUSPECT.test('if (!callerCan(req, "inventory.pull")) throw forbidden')).toBe(false);
  });

  it("no clearance or redaction decision reads inventory.pull", () => {
    const files = sources();
    expect(files.length, "no source files were read").toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const f of files) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("inventory.pull")) return;
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        // The decision may name the entitlement on this line, or take it as
        // an argument whose meaning is set by the line above — both show up
        // within a line of the word that gives the game away.
        const context = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
        if (SUSPECT.test(context)) {
          offenders.push(`${path.relative(path.join(API, "../../.."), f)}:${i + 1}  ${t.slice(0, 76)}`);
        }
      });
    }
    expect(
      offenders,
      "`inventory.pull` is permission to fetch equipment, not field " +
        "clearance and not permission to see what the crew is paid. " +
        "Clearance is `work.claim`; crew pay is `work.claim || money.view`. " +
        "Read it only to decide whether somebody may take equipment out.",
    ).toEqual([]);
  });
});
