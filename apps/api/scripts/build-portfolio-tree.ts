/**
 * Build the real portfolio tree and tag every property into it.
 *
 * DRY RUN BY DEFAULT. Pass `-- --apply` to write. Re-running is safe: it
 * upserts nodes by (parent, name) and only touches a property whose
 * membership is not already exactly what the rules below say.
 *
 *   npm run portfolio:tree            # show the plan, write nothing
 *   npm run portfolio:tree -- --apply # do it
 *
 * ── THE SHAPE, AND WHY ──────────────────────────────────────────────────
 *
 * State → Market → District → Zone NEST, in that order. Route and Book cut
 * ACROSS that spine: they sit at the lowest node containing everything they
 * touch, and a property belongs to one AS WELL AS its zone. That is what
 * many-to-many membership is for, and it is why this script computes a SET
 * per property rather than moving each one to a single node.
 *
 *   · Organised by DRIVE TIME AND ROUTE DENSITY, not county. Briar Chapel
 *     mails as Chapel Hill and physically sits in Chatham County; a county
 *     tree would cut the densest cluster away from the rest of the Chapel
 *     Hill book, which is backwards for routing.
 *   · Briar Chapel is a ZONE, not a Route. It is a subdivision with a
 *     boundary you could draw; nothing about the ORDER of visits inside it
 *     is load-bearing, and order is what would make it a route.
 *   · Chatham is its own district rather than Pittsboro folded under Chapel
 *     Hill. Eleven properties is thin — but A PORTFOLIO CANNOT BE
 *     REPARENTED (G14), so putting it in the wrong place costs a
 *     copy-and-retire later, which splits its frozen history across two
 *     nodes. Right the first time is free; wrong is not.
 *   · The lone Durham property gets no district. A node with one property
 *     is a node everyone clicks past. It lands in the unplaced list, which
 *     is the honest answer until there is a cluster.
 *   · "North Carolina" and "Triangle" hold nothing directly and are worth
 *     the two clicks: the day a second state or a second metro appears,
 *     it is a new sibling rather than a reshape — and a reshape is the one
 *     thing this model cannot do.
 *
 * ASSIGNMENT IS BY ZIP, with one carve-out. Briar Chapel cannot be derived
 * from a postcode, so it is matched on its street names. Streets beat
 * coordinates here: only part of the book is geocoded, and the map view
 * backfills lazily.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
 *
 * It does not create roles, grant anybody anything, or touch the
 * `PORTFOLIO_TIER_NAMES` setting. The vocabulary belongs to
 * `install-starter-roles.ts`, which knows how to upgrade a value it
 * shipped without overwriting one somebody edited. This script CHECKS that
 * the vocabulary is in place and tells you to run that first if it is not.
 */
import { prisma } from "../src/db/prisma";
import { services } from "../src/services/index";
import type { Principal } from "@repo/permissions";

const APPLY = process.argv.includes("--apply");

/** The script acts with system authority; the audit records who ran it. */
const SYSTEM: Principal = { kind: "system", name: "build-portfolio-tree" };

/** Streets known to be inside Briar Chapel. Extend as you find more. */
const BRIAR_CHAPEL = [
  "great ridge", "tobacco farm", "pokeberry", "juneberry", "amber wood",
  "stoney branch", "chauncey", "new parkside", "ashwood",
];

/**
 * THE BOOK — the accounts kept personally, wherever they are.
 *
 * A Book is defined by WHO does the work, not by where it is, so there is
 * no rule that can derive it: a postcode or a street would make it a zone.
 * It has to be named.
 *
 * Match is a case-insensitive substring against the property's street OR
 * its client's name, so either `"105 Hampton"` or `"Harrington Estate"`
 * works. A property matched here keeps its geographic zone AS WELL — that
 * is the whole point of the Book cutting across the spine.
 *
 * LEAVE IT EMPTY AND THE NODE IS NOT CREATED. An empty portfolio is a rung
 * everyone clicks past, and a Book with nobody's accounts in it is not a
 * thing that can be true.
 */
const MIKES_BOOK: string[] = [
  // e.g. "Harrington Estate", "105 Hampton Ct",
];

type Node = { name: string; tier: string; children?: Node[] };

/** The spine. Zones are the leaves that properties land in. */
const TREE: Node[] = [
  {
    name: "North Carolina", tier: "State",
    children: [
      {
        name: "Triangle", tier: "Market",
        children: [
          {
            name: "Chapel Hill", tier: "District",
            children: [
              { name: "Chapel Hill West", tier: "Zone" },
              { name: "Briar Chapel", tier: "Zone" },
              { name: "Chapel Hill East", tier: "Zone" },
              { name: "Carrboro", tier: "Zone" },
            ],
          },
          // Holds its properties directly. A district with no zones under
          // it is a real shape — eleven properties in one town does not
          // divide into anything a crew would route differently.
          { name: "Chatham", tier: "District" },
        ],
      },
    ],
  },
];

/** The node the Book hangs under: the lowest one containing all of it. */
const BOOK_PARENT = "Triangle";
const BOOK_NAME = "Mike's Book";

/** Which ZONE a property belongs to, or null when no rule covers it. */
function zoneFor(p: { street1: string | null; postalCode: string | null }): string | null {
  const zip = (p.postalCode ?? "").trim().slice(0, 5);
  const street = (p.street1 ?? "").toLowerCase();
  if (zip === "27516") {
    return BRIAR_CHAPEL.some((s) => street.includes(s)) ? "Briar Chapel" : "Chapel Hill West";
  }
  if (zip === "27514" || zip === "27517") return "Chapel Hill East";
  if (zip === "27510") return "Carrboro";
  if (zip === "27312") return "Chatham";
  return null;
}

/** Does this property belong to the Book? */
function inBook(p: { street1: string | null; client: { displayName: string | null } | null }): boolean {
  if (MIKES_BOOK.length === 0) return false;
  const hay = `${p.street1 ?? ""} ${p.client?.displayName ?? ""}`.toLowerCase();
  return MIKES_BOOK.some((m) => hay.includes(m.toLowerCase()));
}

(async () => {
  // WHICH DATABASE. Printed, not assumed. `DATABASE_URL` is overridable
  // from the shell, and a run whose output says "production" while it is
  // writing to dev — or the reverse — is the worst failure available here.
  const host = (() => {
    try { return new URL(process.env.DATABASE_URL ?? "").host; } catch { return "(unparseable DATABASE_URL)"; }
  })();

  const actor = await prisma.user.findFirst({
    where: { isOwner: true },
    select: { id: true, displayName: true },
  });
  // PINNED BY NAME AND OLDEST-FIRST. A bare `findFirst({ parentId: null })`
  // returns an arbitrary row, and e2e scratch data creates root-level
  // portfolios of its own — that is how a previous version of this pattern
  // built a second tree and stranded the real one under it.
  const root = await prisma.portfolio.findFirst({
    where: { parentId: null },
    orderBy: { id: "asc" },
    select: { id: true, name: true, path: true },
  });
  if (!actor) throw new Error("No owner on this database — nothing to attribute the audit to.");
  if (!root) throw new Error("No root portfolio — run the seed or the migration first.");

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"}  ·  db ${host}  ·  root "${root.name}"  ·  as ${actor.displayName}\n`);

  // ── 0. The vocabulary has to exist before the tree uses it ───────────
  const tierSetting = await prisma.setting.findUnique({
    where: { key: "PORTFOLIO_TIER_NAMES" },
    select: { value: true },
  });
  const configuredTiers = (() => {
    try {
      const parsed = JSON.parse(tierSetting?.value ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map((x: any) => (typeof x === "string" ? x : String(x?.name ?? ""))).filter(Boolean);
    } catch { return []; }
  })();
  const wanted = [...new Set(flatten(TREE).map((n) => n.tier).concat(MIKES_BOOK.length ? ["Book"] : []))];
  const missingTiers = wanted.filter((t) => !configuredTiers.includes(t));
  if (missingTiers.length) {
    console.log(
      `  ! PORTFOLIO_TIER_NAMES is missing: ${missingTiers.join(", ")}\n` +
        `    The tier picker offers only what that setting lists, so these nodes would\n` +
        `    be labelled with words nobody can reproduce in the UI.\n` +
        `    Run  npx tsx scripts/install-starter-roles.ts --apply  first.\n`,
    );
    if (APPLY) throw new Error("Refusing to build a tree the tier picker cannot express.");
  }

  // ── 1. The nodes ──────────────────────────────────────────────────────
  const idByName = new Map<string, string>();
  let created = 0;
  const ensure = async (name: string, tier: string, parentId: string): Promise<string> => {
    const found = await prisma.portfolio.findFirst({ where: { name, parentId }, select: { id: true, tier: true } });
    if (found) {
      idByName.set(name, found.id);
      const drift = found.tier !== tier ? `  (tier is "${found.tier ?? "none"}", expected "${tier}")` : "";
      console.log(`  = ${name}${drift}`);
      return found.id;
    }
    created++;
    if (!APPLY) { idByName.set(name, `dry:${name}`); console.log(`  + ${name} [${tier}]`); return `dry:${name}`; }
    const made = await services.portfolios.create(actor.id, { name, tier, parentId });
    idByName.set(name, made.id);
    console.log(`  + ${name} [${tier}]`);
    return made.id;
  };

  console.log("PORTFOLIOS");
  const walk = async (nodes: Node[], parentId: string) => {
    for (const n of nodes) {
      const id = await ensure(n.name, n.tier, parentId);
      if (n.children?.length) await walk(n.children, id);
    }
  };
  await walk(TREE, root.id);

  if (MIKES_BOOK.length === 0) {
    console.log(`  · ${BOOK_NAME} SKIPPED — MIKES_BOOK is empty. Name the accounts at the top of this script.`);
  } else {
    await ensure(BOOK_NAME, "Book", idByName.get(BOOK_PARENT)!);
  }

  // ── 2. The properties ─────────────────────────────────────────────────
  //
  // ONE CALL PER PROPERTY, WITH THE WHOLE SET. `setPropertyPortfolios`
  // REPLACES the membership list, so writing the zone and then the Book in
  // two calls would have the second erase the first. It also resyncs the
  // property's OPEN occurrences — which is the step that matters most
  // here: without it, recurring work keeps whatever it inherited and the
  // whole retag looks like it did nothing until the next cycle regenerates
  // visits.
  const props = await prisma.property.findMany({
    select: {
      id: true, displayName: true, street1: true, city: true, postalCode: true, status: true,
      client: { select: { displayName: true } },
      portfolios: { select: { portfolioId: true, portfolio: { select: { name: true } } } },
    },
    orderBy: [{ postalCode: "asc" }, { street1: "asc" }],
  });

  const tally = new Map<string, number>();
  const unplaced: string[] = [];
  let changed = 0, already = 0, resynced = 0;

  for (const p of props) {
    const zone = zoneFor(p);
    const book = inBook(p);
    if (!zone && !book) {
      // NAMED, NOT SKIPPED. A property in no portfolio counts toward no
      // rollup, and the only way that gets fixed is somebody seeing it.
      unplaced.push(`${p.street1 ?? "(no street)"} · ${p.city ?? "?"} · ${p.postalCode ?? "no ZIP"} [${p.status}]`);
      continue;
    }
    const wantNames = [...(zone ? [zone] : []), ...(book ? [BOOK_NAME] : [])];
    for (const n of wantNames) tally.set(n, (tally.get(n) ?? 0) + 1);

    // The root membership every property currently has is redundant once
    // it sits in a real node, and leaving it would badge every card "also
    // in All properties" — so the target set is the leaves and nothing else.
    const want = wantNames.map((n) => idByName.get(n)!);
    const has = p.portfolios.map((m) => m.portfolioId).sort();
    if (has.length === want.length && has.every((id, i) => id === [...want].sort()[i])) { already++; continue; }

    changed++;
    if (APPLY) {
      const res = await services.portfolios.setPropertyPortfolios(actor.id, SYSTEM, p.id, want);
      resynced += res.occurrencesResynced ?? 0;
    }
  }

  console.log("\nPROPERTIES");
  for (const [name, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  → ${name}`);
  }
  console.log(
    `\n  ${changed} propert(ies) to ${APPLY ? "change" : "be changed"}, ${already} already correct` +
      (APPLY ? `, ${resynced} open visit(s) resynced` : ""),
  );
  if (created > 0) console.log(`  ${created} portfolio(s) ${APPLY ? "created" : "to create"}`);
  if (unplaced.length) {
    console.log(`\n  ${unplaced.length} NO RULE COVERS — these keep whatever they have now:`);
    for (const u of unplaced) console.log(`    ${u}`);
  }
  if (!APPLY) console.log("\nDRY RUN — nothing was written. Re-run with  -- --apply");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

/** Every node in the tree, at any depth. */
function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}
