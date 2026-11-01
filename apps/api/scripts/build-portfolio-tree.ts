/**
 * Build the real portfolio tree and tag every property into it.
 *
 *   npm run portfolio:tree            # show the plan, write nothing
 *   npm run portfolio:tree -- --apply # do it
 *
 * DRY RUN BY DEFAULT. Re-running is safe: nodes upsert by (parent, name)
 * and a property is only written when its membership is not already
 * exactly what the rules below say.
 *
 * ── THE SHAPE, AND WHY ──────────────────────────────────────────────────
 *
 * State → Market → District → Zone NEST, in that order. Route and Book cut
 * ACROSS that spine: they sit at the lowest node containing everything
 * they touch, and a property belongs to one AS WELL AS its zone. That is
 * what many-to-many membership is for, and it is why this script computes
 * a SET per property rather than moving each to a single node.
 *
 *   · Organised by DRIVE TIME AND ROUTE DENSITY, not county. Briar Chapel
 *     mails as Chapel Hill and sits in Chatham County; a county tree would
 *     cut the densest cluster away from the rest of the Chapel Hill book,
 *     which is backwards for routing.
 *   · Briar Chapel is a ZONE, not a Route. It is a subdivision with a
 *     boundary you could draw, and nothing about the ORDER of visits
 *     inside it is load-bearing — order is what would make it a route.
 *   · Chatham is its own district rather than folded under Chapel Hill.
 *     Eleven properties is thin, but A PORTFOLIO IS NEVER REPARENTED
 *     (G14), so putting it in the wrong place costs a copy-and-retire
 *     later, which splits its history across two nodes. Right the first
 *     time is free; wrong is not.
 *   · There is no Durham node. The one Durham property was deleted on
 *     2026-10-31, and a node for a single address is one everybody clicks
 *     past.
 *
 * PLACEMENT IS BY POSTCODE, with one carve-out: Briar Chapel cannot be
 * derived from 27516, so it is matched on its street names. Streets beat
 * coordinates here — only part of the book is geocoded.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
 *
 * No role is created or granted. No money row is written — not a payment,
 * split, invoice, charge or ledger entry; the three tables it touches are
 * `Portfolio`, `PropertyPortfolio` and `JobOccurrencePortfolio`, plus the
 * audit. Completed visits are never re-pointed: `setPropertyPortfolios`
 * resyncs only unfinished ones, which is the rule that keeps last year's
 * revenue where it was earned.
 *
 * It also does not touch `PORTFOLIO_TIER_NAMES` — that belongs to
 * `install-starter-roles.ts`. This script CHECKS the vocabulary is in
 * place and refuses to build a tree the tier picker cannot express.
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
 * MIKE'S BOOK — the accounts kept personally, wherever they are.
 *
 * A Book is defined by WHO does the work, not by where it is, so no rule
 * can derive it: a postcode or a street would make it a zone. Named by
 * the operator on 2026-11-01, matched on the client's EXACT displayName.
 *
 * These properties keep their geographic zone AS WELL. The overlap is
 * deliberate and was confirmed — "the properties in Mike's Book can be
 * duplicates, it's fine" — so Chapel Hill West and Mike's Book will both
 * count the same three addresses. Each figure is right on its own; it is
 * summing siblings that would double-count, and parent roll-ups already
 * count each property once.
 *
 * Note "Christiano" is the whole client name in the database — the
 * operator called them Patricia Christiano, but the record carries only
 * the surname, and the apostrophe in "Melissa O’Hara" is U+2019. Both are
 * copied from the live rows rather than retyped.
 */
const MIKES_BOOK_CLIENTS = [
  "Laurie Aithaus",
  "Alexis Besosa",
  "Rick Belford",
  "Melissa O’Hara",
  "Christiano",
  "Jane Calloway",
  "Pete (Omi Neighbor)",
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
          // Holds its properties directly. A district with no zones is a
          // real shape — eleven properties in one town do not divide into
          // anything a crew would route differently.
          { name: "Chatham", tier: "District" },
          // THE BOOK SITS AT THE MARKET, because its seven properties span
          // Chapel Hill AND Chatham, and a cross-cutting portfolio belongs
          // at the lowest node containing everything it touches.
          { name: "Mike's Book", tier: "Book" },
        ],
      },
    ],
  },
];

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

/** Every node in the tree, at any depth. */
function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

(async () => {
  // WHICH DATABASE. Printed, not assumed — a run whose output says
  // production while it writes to dev, or the reverse, is the worst
  // failure available here.
  const host = (() => {
    try { return new URL(process.env.DATABASE_URL ?? "").host; } catch { return "(unparseable DATABASE_URL)"; }
  })();

  const actor = await prisma.user.findFirst({ where: { isOwner: true }, select: { id: true, displayName: true } });
  // PINNED OLDEST-FIRST. A bare findFirst returns an arbitrary row, and
  // e2e scratch data creates root-level portfolios of its own — that is
  // how an earlier version of this pattern built a second tree and
  // stranded the real one under it.
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
  const missingTiers = [...new Set(flatten(TREE).map((n) => n.tier))].filter((t) => !configuredTiers.includes(t));
  if (missingTiers.length) {
    console.log(
      `  ! PORTFOLIO_TIER_NAMES is missing: ${missingTiers.join(", ")}\n` +
        `    The tier picker offers only what that setting lists, and it has no\n` +
        `    free-text escape, so these nodes would be labelled with words nobody\n` +
        `    can reproduce in the UI.\n` +
        `    Run  npx tsx scripts/install-starter-roles.ts --apply  first.\n`,
    );
    if (APPLY) throw new Error("Refusing to build a tree the tier picker cannot express.");
  }

  // ── 1. The nodes ──────────────────────────────────────────────────────
  const idByName = new Map<string, string>();
  let created = 0;
  const ensure = async (name: string, tier: string, parentId: string, depth: number): Promise<string> => {
    const pad = "  ".repeat(depth);
    const found = await prisma.portfolio.findFirst({ where: { name, parentId }, select: { id: true, tier: true } });
    if (found) {
      idByName.set(name, found.id);
      const drift = found.tier !== tier ? `   (tier is "${found.tier ?? "none"}", expected "${tier}")` : "";
      console.log(`  = ${pad}${name}${drift}`);
      return found.id;
    }
    created++;
    if (!APPLY) { idByName.set(name, `dry:${name}`); console.log(`  + ${pad}${name} [${tier}]`); return `dry:${name}`; }
    const made = await services.portfolios.create(actor.id, { name, tier, parentId });
    idByName.set(name, made.id);
    console.log(`  + ${pad}${name} [${tier}]`);
    return made.id;
  };

  console.log("PORTFOLIOS");
  const walk = async (nodes: Node[], parentId: string, depth: number) => {
    for (const n of nodes) {
      const id = await ensure(n.name, n.tier, parentId, depth);
      if (n.children?.length) await walk(n.children, id, depth + 1);
    }
  };
  await walk(TREE, root.id, 0);

  // ── 2. The properties ─────────────────────────────────────────────────
  //
  // ONE CALL PER PROPERTY, WITH THE WHOLE SET. `setPropertyPortfolios`
  // REPLACES the membership list, so writing the zone and then the Book as
  // two calls would have the second erase the first. It also resyncs the
  // property's UNFINISHED visits — the step that matters most here:
  // without it, recurring work keeps whatever it inherited and the retag
  // looks like it did nothing until the next cycle regenerates visits.
  const props = await prisma.property.findMany({
    select: {
      id: true, displayName: true, street1: true, city: true, postalCode: true, status: true,
      client: { select: { displayName: true } },
      portfolios: { select: { portfolioId: true } },
    },
    orderBy: [{ postalCode: "asc" }, { street1: "asc" }],
  });

  const tally = new Map<string, number>();
  const bookRows: string[] = [];
  const unplaced: string[] = [];
  let changed = 0, already = 0, resynced = 0;

  for (const p of props) {
    const zone = zoneFor(p);
    const inBook = MIKES_BOOK_CLIENTS.includes(p.client?.displayName ?? "");
    if (!zone && !inBook) {
      // NAMED, NOT SKIPPED. A property in no portfolio counts toward no
      // rollup, and the only way that gets fixed is somebody seeing it.
      unplaced.push(`${p.street1 ?? "(no street)"} · ${p.city ?? "?"} · ${p.postalCode ?? "no ZIP"} [${p.status}]`);
      continue;
    }
    const wantNames = [...(zone ? [zone] : []), ...(inBook ? [BOOK_NAME] : [])];
    for (const n of wantNames) tally.set(n, (tally.get(n) ?? 0) + 1);
    if (inBook) bookRows.push(`${(p.client?.displayName ?? "?").padEnd(22)} ${(p.street1 ?? "").padEnd(26)} → also ${zone ?? "(no zone)"}`);

    // The root membership every property currently has is redundant once
    // it sits in a real node, and leaving it would badge every card "also
    // in All properties" — so the target set is the leaves and nothing else.
    const want = wantNames.map((n) => idByName.get(n)!).sort();
    const has = p.portfolios.map((m) => m.portfolioId).sort();
    if (has.length === want.length && has.every((id, i) => id === want[i])) { already++; continue; }

    changed++;
    if (!APPLY) continue;
    // DEFENCE IN DEPTH. A `dry:` placeholder can only be produced when
    // APPLY is false, so reaching here with one would mean the two halves
    // of this script disagree about which mode they are in — worth
    // stopping the run over rather than discovering as a NOT_FOUND
    // halfway through the book.
    const fake = want.filter((id) => id.startsWith("dry:"));
    if (fake.length) throw new Error(`Refusing to write a dry-run placeholder id: ${fake.join(", ")}`);
    const res = await services.portfolios.setPropertyPortfolios(actor.id, SYSTEM, p.id, want);
    resynced += res.occurrencesResynced ?? 0;
  }

  console.log("\nPROPERTIES");
  for (const [name, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  → ${name}`);
  }
  console.log(`\nMIKE'S BOOK (${bookRows.length}) — each ALSO keeps its zone`);
  for (const r of bookRows) console.log(`     ${r}`);

  console.log(
    `\n  ${changed} propert(ies) to ${APPLY ? "change" : "be changed"}, ${already} already correct` +
      (APPLY ? `, ${resynced} unfinished visit(s) resynced` : ""),
  );
  if (created > 0) console.log(`  ${created} portfolio(s) ${APPLY ? "created" : "to create"}`);
  if (unplaced.length) {
    console.log(`\n  ${unplaced.length} NO RULE COVERS — these keep whatever they have now:`);
    for (const u of unplaced) console.log(`    ${u}`);
  }

  // HISTORY DOES NOT FOLLOW THE PROPERTY, and this script does not make
  // it. Completed visits keep what they counted toward. Under the money
  // basis that shipped on 2026-10-31 the default view is "as organized
  // now", which reads the property's CURRENT portfolio — so each zone
  // shows its full history immediately, without a single historical row
  // being rewritten. See docs/features/portfolio-money-basis.md.
  console.log(
    "\nHISTORY\n  Completed visits are not touched. With the money basis defaulting to\n" +
      "  \"as organized now\", each portfolio still shows its full revenue history —\n" +
      "  that is a reading choice, not a rewrite.",
  );

  if (!APPLY) console.log("\nDRY RUN — nothing was written. Re-run with  -- --apply");
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
