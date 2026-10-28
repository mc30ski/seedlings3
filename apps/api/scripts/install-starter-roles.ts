/**
 * INSTALL THE STARTER ROLES.
 *
 * The app ships with NO roles. This script creates the ones a lawn-care
 * operation actually needs, and it is the thing that replaces the old
 * `Role` enum (WORKER / ADMIN / SUPER). Another company runs it once and
 * then edits the roles, or writes their own set and never runs it again.
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 * A migration is schema. These are an opinion about how ONE company is
 * organised — the operator must be able to rename "Admin" to "Office
 * Manager", drop a role, or add three more, and a migration that recreated
 * them would fight that on every deploy.
 *
 * WHY `key` AND NOT `name`
 * Re-running this must not orphan anybody. Roles are upserted by their
 * immutable `key` ("seedlings.worker"), so rebuilding a role after adding an
 * entitlement PRESERVES ITS ID — and therefore every `UserCustomRole` and
 * `AreaAssignment` pointing at it. `name` is an editable label; keying on it
 * would mean renaming a role silently created a second one and quietly
 * stripped everyone's access to the first.
 *
 * WHY A LADDER, NOT FOUR FLAT SETS
 * Each role INHERITS the one below and adds to it. Adding an entitlement to
 * Worker reaches Admin and Super automatically — otherwise an operator
 * maintains four overlapping lists by hand and they drift. That is also why
 * Super is not special any more: it is Admin plus the rest, an ordinary row
 * in the same table, which is what lets you demote yourself safely and what
 * makes "view as Admin" a subset rather than a different code path.
 *
 * HOW THE SETS WERE CHOSEN
 * Derived from the route guards as they actually are, not invented: for each
 * entitlement, which legacy role could reach the routes it guards. That is
 * why flipping to entitlements is not supposed to change anybody's access —
 * it reproduces today's reachability, then lets you edit it.
 *
 *   npx tsx scripts/install-starter-roles.ts           # dry run
 *   npx tsx scripts/install-starter-roles.ts --apply   # writes
 */
import { PrismaClient } from "@prisma/client";
import { assertEntitlement, type Entitlement } from "@repo/permissions";

const APPLY = process.argv.includes("--apply");

/**
 * FIELD CLEARANCE is separate from the ladder on purpose.
 *
 * It is what a worker type used to encode — and that was the bug:
 * a payroll fact standing in for a permission. A trainee is an ordinary
 * employee who has not been granted this. Keeping it out of the ladder means
 * you can also withhold it from a brand-new hire of any kind, or from an
 * office admin who never goes out, without inventing a worker type for them.
 */
const FIELD_CLEARANCE = [
  "work.claim", "work.complete", "inventory.pull",
] as const;

export type StarterRole = {
  key: string;
  name: string;
  description: string;
  /** Entitlements this role ADDS to the one it inherits. */
  adds: readonly string[];
  inheritsKey?: string;
  /** Offered in the top-tab perspective dropdown, in this order. Omit it
   *  and the role is not a perspective — it still works as a role. */
  perspectiveOrder?: number;
  /** Icon drawn beside it there, as a `PERSPECTIVE_ICONS` key. These four
   *  restore what the dropdown drew before the roles refactor: the shells
   *  carried their own icons, so the icons went when the shells did. */
  perspectiveIcon?: string;
  /** A rung of the Trainee -> Worker -> Admin -> Super chain. At most one
   *  may be held per person, because each rung already contains the one
   *  below. Field Clearance and the "May …" roles are NOT rungs: they are
   *  granted on top. */
  ladderRung?: true;
};

const LADDER: StarterRole[] = [
  {
    key: "seedlings.trainee",
    ladderRung: true,
    perspectiveIcon: "graduation-cap",
    name: "Trainee",
    description:
      "Can see the work and be added to a visit by someone else, but cannot " +
      "pick it up or act on it. Grant Field Clearance when they are ready.",
    adds: [
      // `reports.view` IS NOT HERE, as of 2026-10-16. It was, and it grants
      // `GET /operations` and `GET /statistics` — the business rollup, with
      // money in it. No worker has ever SEEN that, because the UI hid it
      // behind the surface, so the grant was wider than the shipped
      // behaviour and nobody noticed. Moving tab visibility onto
      // capabilities is what would have exposed it: the rollup would have
      // appeared for every trainee the moment the surface flag stopped
      // being the gate. Moved to Admin, which matches what the app has
      // always actually done.
      "clients.contribute", "clients.view",
      // Crew VIEWING is on the base rung, so every rung above inherits it.
      // It sat on Admin, which put "see the crews and who is on them" out
      // of reach of the people who are ON them: the Groups tab is gated on
      // it, so a field worker could not open the tab at all.
      //
      // CrewsTab has always had the read-only half built — a trimmed "My
      // Groups" card list it falls back to for anyone who cannot BUILD
      // crews, whose own comment says that being on a crew is not the same
      // as making one. Nobody could reach it, because everyone who could
      // see crews could also build them. The branch was dead code and the
      // placement was the bug.
      //
      // Granting it costs nothing: the list behind it is an OWNERSHIP
      // route that returns only the caller's own crews.
      //
      // NOTE FOR EDITORS: G29 slices this block and treats every quoted
      // group-dot-verb string in it as a granted capability — comments
      // included. Name capabilities in prose here, never in quotes. (This
      // note said it with the example quoted, which made the example
      // itself parse as a grant on this rung.)
      "crews.view",
      "equipment.view",
      "estimates.accept", "estimates.create", "marketing.view",
      "materials.charge", "people.view", "pricing.view",
      // `routes.plan` IS HERE, on the base rung, so every rung above
      // inherits it. It sat on Super and Coordinator, which put route
      // planning in the hands of the office and withheld it from the
      // people who drive to the visits — a worker could not see how to
      // reach the jobs they had claimed.
      //
      // The tab is self-service at its core: its own header says
      // "anyone who can reach it plans THEIR OWN routes; `people.view`
      // adds the worker picker and the on-behalf endpoints". There is
      // one routes entitlement and nothing in it is about dispatching
      // somebody else, so the base rung is where it belongs.
      "routes.plan",
      "schedule.contribute", "schedule.view", "supplies.view",
    ],
    perspectiveOrder: 1,
  },
  {
    key: "seedlings.worker",
    ladderRung: true,
    perspectiveIcon: "user",
    name: "Worker",
    description: "A trainee who is cleared for field work.",
    inheritsKey: "seedlings.trainee",
    adds: FIELD_CLEARANCE,
    perspectiveOrder: 2,
  },
  {
    key: "seedlings.admin",
    ladderRung: true,
    perspectiveIcon: "user-key",
    name: "Admin",
    description:
      "Runs the day to day: scheduling, clients, equipment, crews, recording " +
      "money, reworking a split, approving hours on a visit.",
    inheritsKey: "seedlings.worker",
    adds: [
      // `books.view` IS NOT HERE, deliberately.
      //
      // docs/features/permissions.md: "`books.*` is global-only, so no
      // company P&L unless explicitly granted." The entitlement's own copy
      // is "See business expenses, the P&L and the reconcile period", and
      // every route behind it was pinned to the top role before the roles came out. An
      // admin runs the day; the company's books are the owner's.
      //
      // This is a STARTER DEFAULT, not a rule. An operator who wants their
      // admin reading the P&L grants `books.view` to that role in the role
      // builder, and nothing in the code resists it. That is the whole point
      // of the model — and it is why the fix belonged here rather than in 14
      // route guards.
      // Read the numbers the app runs on, without being able to change
      // them — the writes stay on the rung above.
      "settings.view",
      "audit.view", "clients.manage", "expenses.charge", "content.manage",
      // Crew VIEWING moved down to the base rung, so Admin inherits it
      // rather than listing it. Building crews stays here. See the note
      // on the base rung for why.
      "content.view", "crews.manage", "documents.view",
      "equipment.manage", "identity.link", "marketing.manage",
      "money.adjust", "money.record", "money.view", "notify.send",
      // `reports.view` STAYS HERE. It was briefly moved to Super to hide
      // the INSIGHTS card from Admin — and that took Admin's whole team
      // view with it, because the same entitlement also gated
      // /dashboard-summary/aggregate (Overview · team, the team pay
      // tiles). Admin's Home collapsed to a personal self-view. The
      // business-wide half is `reports.business`, granted on Super.
      "payroll.view", "people.manage", "reports.view", "roles.view", "schedule.manage", "supplies.hold",
      "timeline.view",
      "time.approve",
      // READ THE TERRITORY. Rearranging it stays on Super
      // (`areas.manage`); seeing which properties sit where is day-to-day
      // work for anybody running the schedule. Granted HERE rather than on
      // Super so Super and District Lead both inherit it — a role holding
      // `areas.manage` without this would open the Areas tab onto a 403.
      "areas.view"
    ],
    perspectiveOrder: 3,
  },
  {
    key: "seedlings.super",
    ladderRung: true,
    perspectiveIcon: "shield",
    name: "Super",
    description:
      "Everything someone with schedule authority can do, plus the decisions that change the " +
      "business: approving and reversing payments, the tax exports, " +
      "rewriting timesheets, buying supplies, payroll, pricing, compliance, " +
      "areas, settings, and who holds which role.",
    inheritsKey: "seedlings.admin",
    adds: [
      // `books.view` is granted HERE, not in the tier it was removed
      // from. Super INHERITS Admin, so taking an entitlement out of the base
      // takes it away from everything built on it — the first attempt left
      // nobody at all holding `books.view` and all 19 books routes
      // unreachable. Inheritance cuts both ways, and the gate below now
      // fails on any entitlement no starter role holds.
      "areas.manage", "books.export-tax", "books.manage", "books.view",
      // The business-wide INSIGHTS rollup (GET /operations). Admin keeps
      // `reports.view` for the team rollup — see the note on that tier.
      "reports.business",
      "clients.view-as", "compliance.manage", "compliance.view", "content.approve", "displays.manage",
      // `equipment.capital` and `marketing.campaigns` are the SUPER halves of
      // two entitlements that were single and too coarse: Admin keeps
      // `equipment.manage` (editing the fleet) and `marketing.manage`
      // (banners and announcements), and the decisions that were always the
      // owner's — putting equipment on the books or wiping it, and sending a
      // campaign out under the company name — are granted here. Before the
      // split no bundling could express the line: taking the single
      // entitlement off Admin to stop the 8 capital routes also took away 20
      // routes they use every day.
      "documents.manage", "equipment.capital", "forecasts.view",
      "marketing.campaigns", "money.approve",
      "payroll.manage", "people.approve", "people.grant-roles", "pricing.manage",
      // `routes.plan` moved to Trainee — Super inherits it. Granting it
      // again here would give one capability two sources, and the next
      // person taking it off a rung would find it still held.
      "roles.define", "settings.manage", "supplies.manage",
      "timeline.manage",
      "time.manage", "time.view"
    ],
    perspectiveOrder: 4,
  },
];

/**
 * DISTRICT LEAD — an Admin who is accountable for one territory's numbers.
 *
 * WHY THIS IS A ROLE AND NOT A GRANT ON ADMIN. "The lead of an area should
 * be able to roll up their area" is one capability away from Admin:
 * `reports.business`, which is what INSIGHTS is guarded on. Adding it to
 * Admin would have worked for the lead and ALSO handed every company-wide
 * Admin the business-wide INSIGHTS card — reversing the deliberate decision
 * recorded on the Admin tier above, which is there because the previous
 * attempt to move `reports.*` around collapsed Admin's Home to a personal
 * self-view.
 *
 * Inheriting instead keeps both answers: Admin is unchanged, and a lead
 * assigned THIS role inside an area sees that area's business numbers and
 * nothing outside it — `areaWhere` narrows `reports.business` the same as
 * everything else.
 *
 * GRANT IT AT AN AREA, not company-wide. Held company-wide it is simply
 * Admin plus the INSIGHTS card, which is a decision to make on purpose
 * rather than by leaving an area off.
 */
const DISTRICT_LEAD_ROLE: StarterRole = {
  key: "seedlings.district-lead",
  name: "District Lead",
  description:
    "An Admin who also sees the business rollup — jobs, revenue and equipment — " +
    "for the area they are assigned to. Assign it at an area, not company-wide.",
  inheritsKey: "seedlings.admin",
  adds: ["reports.business"],
};

const CLEARANCE_ROLE: StarterRole = {
  key: "seedlings.field-clearance",
  name: "Field Clearance",
  description:
    "Cleared to claim, start and complete visits and to pull inventory. " +
    "Withhold it for someone still being trained.",
  adds: FIELD_CLEARANCE,
};

/**
 * The two exceptions that used to be made with a per-person tick-box.
 *
 * `canPullInventory` and `canChargeBusinessExpenses` were per-person
 * columns on the user record. The model forbids that (G20): a per-person
 * tick is an entitlement that exists nowhere, inherits from nothing, and
 * cannot be traced back to a decision. Deleting the columns was right, but
 * it left holders of `schedule.manage` unable to make a narrow exception at all — creating a role
 * needs `roles.define`, which only the operator holds, so every one-off
 * became a request upstairs.
 *
 * These two restore that speed inside the model: real roles, grantable by
 * anyone with `people.grant-roles`, visible in the role list, audited like
 * any other grant.
 *
 * SCOPE IS DELIBERATELY TWO. They are the exceptions that actually existed
 * as ticks, so we know they are the ones people ask for. Minting a
 * single-capability role for every future request would rebuild the
 * per-person tick-box one row at a time — anything beyond these is a
 * conversation, not another entry here.
 *
 * `inventory.pull` also sits inside Field Clearance. That is not a
 * duplicate: this grants it WITHOUT `work.claim` / `work.complete`, which
 * is the office person who fetches supplies but never runs a visit.
 */
const EXCEPTION_ROLES: StarterRole[] = [
  {
    key: "seedlings.exception.inventory-pull",
    // "May …", matching the convention the operator's own one-off roles
    // already use. The name is also how `installStarterRoles` ADOPTS an
    // existing keyless row: it looks the name up first and attaches the key
    // rather than creating a near-duplicate. Dev already had "May charge
    // business expenses" with a live grant on it, and a second role called
    // "Can charge business expenses" would have left two rows meaning the
    // same thing with the grant on the wrong one.
    name: "May pull inventory",
    description:
      "Take equipment and supplies out for a job, without being cleared to " +
      "run visits. Grant it on its own to someone who fetches but does not work.",
    adds: ["inventory.pull"],
  },
  {
    key: "seedlings.exception.expenses-charge",
    name: "May charge business expenses",
    description:
      "Charge the company's own purchases to the business. Grant it on its " +
      "own to someone who buys supplies but has no other books access.",
    adds: ["expenses.charge"],
  },
];

/**
 * Every role this script installs.
 *
 * ONE list. It was spelled out twice — once in `installStarterRoles` and
 * once in `main` — so a role added to one and not the other would validate
 * in a dry run and never be written, or be written and never validated.
 */
/**
 * EXPORTED so the catch-up migration can be GENERATED from it rather than
 * transcribed. Those two drifted once already — the 2026-10-12 conversion
 * migration hand-copied this set, and by the time anyone compared them six
 * of eight roles disagreed, including a Super missing twelve capabilities.
 * A generator cannot drift from its own input.
 * See scripts/generate-starter-roles-migration.ts.
 */
export const ALL_STARTER_ROLES: StarterRole[] = [
  ...LADDER,
  CLEARANCE_ROLE,
  // After the ladder: it inherits Admin, so Admin has to exist first.
  DISTRICT_LEAD_ROLE,
  ...EXCEPTION_ROLES,
];

/**
 * Install (or re-install) the starter roles. Exported so the development seed
 * can call it directly — the seed assigns `seedlings.*` keys, so it cannot
 * assume somebody remembered to run this first.
 */
export async function installStarterRoles(
  prisma: PrismaClient,
  log: (msg: string) => void = () => {},
) {
  const all = ALL_STARTER_ROLES;
  for (const r of all) {
    for (const e of r.adds) assertEntitlement(e);
  }
  const idByKey = new Map<string, string>();
  for (const r of all) {
    const sameName = await prisma.customRole.findUnique({
      where: { name: r.name },
      select: { id: true, key: true },
    });
    if (sameName && sameName.key === null) {
      await prisma.customRole.update({ where: { id: sameName.id }, data: { key: r.key } });
      log(`  adopted existing "${r.name}" as ${r.key}`);
    } else if (sameName && sameName.key !== r.key) {
      throw new Error(
        `A different role already uses the name "${r.name}" (key=${sameName.key}). ` +
          `Rename it, or change this starter role's name — a name is a label and ` +
          `must stay editable, so this will not take one it does not own.`,
      );
    }
    const role = await prisma.customRole.upsert({
      where: { key: r.key },
      create: {
        key: r.key, name: r.name, description: r.description, isSystem: true,
        isLadderRung: r.ladderRung === true,
        isPerspective: r.perspectiveOrder != null,
        perspectiveOrder: r.perspectiveOrder ?? null,
        perspectiveIcon: r.perspectiveIcon ?? null,
        inheritsFromId: r.inheritsKey ? idByKey.get(r.inheritsKey) : null,
      },
      // `name`/`description` are NOT updated: the operator owns the label.
      update: {
        isSystem: true,
        isLadderRung: r.ladderRung === true,
        isPerspective: r.perspectiveOrder != null,
        perspectiveOrder: r.perspectiveOrder ?? null,
        // The icon IS re-asserted on re-run, unlike name/description: it
        // ships with the role rather than being the operator's label.
        perspectiveIcon: r.perspectiveIcon ?? null,
        inheritsFromId: r.inheritsKey ? idByKey.get(r.inheritsKey) : null,
      },
      select: { id: true, name: true },
    });
    idByKey.set(r.key, role.id);
    await prisma.roleEntitlement.deleteMany({
      where: { customRoleId: role.id, entitlement: { notIn: [...r.adds] as Entitlement[] } },
    });
    for (const entitlement of r.adds) {
      await prisma.roleEntitlement.upsert({
        where: { customRoleId_entitlement: { customRoleId: role.id, entitlement } },
        create: { customRoleId: role.id, entitlement },
        update: {},
      });
    }
    log(`  ${role.name.padEnd(18)} ${r.adds.length} own entitlement(s)`);
  }
  await installStarterSettings(prisma, idByKey, log);
  return idByKey;
}

/**
 * The settings that only make sense once roles exist.
 *
 * HERE RATHER THAN IN THE SEED, because the seed never runs against
 * production. Promoting this work meant hand-writing INSERTs in the Neon
 * console and remembering to — and the one that mattered could not even be
 * written until `CustomRole` existed, which is exactly the ordering this
 * script owns. Anything a fresh database needs alongside the starter roles
 * belongs in here.
 *
 * CREATE-ONLY, NEVER UPDATE. The installer's contract is that re-running it
 * preserves ids and every grant; silently resetting an operator's chosen
 * default role or their renamed tier labels would break that promise in a
 * way nothing would report. A row that exists is left exactly as it is.
 */
async function installStarterSettings(
  prisma: PrismaClient,
  idByKey: Map<string, string>,
  log: (msg: string) => void,
) {
  const workerRoleId = idByKey.get("seedlings.worker") ?? null;
  const rows: Array<{ key: string; value: string; description: string }> = [
    {
      key: "AREA_TIER_NAMES",
      value: JSON.stringify(["Region", "District", "Territory", "Route"]),
      description:
        "What a level of the area tree is called where you operate. Array of " +
        "strings. Suggestions only — Area.tier accepts any text.",
    },
    {
      key: "MANAGER_TITLES",
      value: JSON.stringify([
        "Regional Manager", "District Manager", "Crew Lead",
        "Office Coordinator", "Bookkeeper",
      ]),
      description:
        "Suggested names when creating a custom role. Array of strings. " +
        "Suggestions only — a role name is free text.",
    },
    // Only if the Worker rung exists — an operator may have installed a
    // trimmed set. Without it the web falls back to the starter key and
    // then to "approve without granting", both of which are fine.
    ...(workerRoleId
      ? [{
          key: "STAFF_DEFAULT_ROLE_ID",
          value: workerRoleId,
          description:
            "The role granted when a pending sign-up is approved as staff. " +
            "Set it to whichever role your new hires should start with; clear " +
            "it to approve without granting anything.",
        }]
      : []),
  ];

  let created = 0;
  for (const row of rows) {
    const existing = await prisma.setting.findUnique({
      where: { key: row.key },
      select: { key: true },
    });
    if (existing) continue;
    await prisma.setting.create({
      data: { ...row, section: "catalogs" },
    });
    created++;
    log(`  setting ${row.key} created`);
  }
  if (created === 0) log("  settings: all present, nothing changed");
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const all = ALL_STARTER_ROLES;
    for (const r of all) for (const e of r.adds) assertEntitlement(e);
    console.log(`✓ ${all.length} roles, every entitlement in the vocabulary.`);

    if (!APPLY) {
      console.log("\nDRY RUN — pass --apply to write.\n");
      for (const r of all) {
        const inh = r.inheritsKey ? ` (inherits ${r.inheritsKey})` : "";
        console.log(`  ${r.key}${inh}\n    +${r.adds.length}: ${r.adds.join(", ")}`);
      }
      return;
    }
    await installStarterRoles(prisma, (m) => console.log(m));
    console.log("\n✓ Starter roles installed. Ids preserved — existing grants still point at them.");
  } finally {
    await prisma.$disconnect();
  }
}

// Only run as a CLI, not when the seed imports the installer.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
