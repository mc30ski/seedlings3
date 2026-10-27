/**
 * Does THIS database actually refuse a dormant grant on a customer?
 *
 * G45 asserts the migration FILE exists with its triggers in it. That is a
 * different claim from "the database has them", and the gap is not
 * theoretical: `prisma migrate deploy` through the Neon pooler can stall on
 * its advisory lock and leave a migration unapplied, while the file sits in
 * the repo making the gate green. (The schema now declares `directUrl`, so
 * migrate no longer goes through the pooler — but that fixes the cause
 * going forward, not any database already carrying a half-applied run.)
 * The rule this guards —
 * `20261020140000_client_grants_require_a_worker_type` — is the only thing
 * standing between a mis-click in the Users tab and a customer account
 * silently holding live staff entitlements, so "probably applied" is not
 * good enough.
 *
 *   npm run verify:client-grant-guard
 *       Structural only. Pure reads of pg_proc / pg_trigger. Safe against
 *       any database including production.
 *
 *   npm run verify:client-grant-guard -- --probe --host=<host>
 *       Also PROVES each of the three entry points refuses, by trying them
 *       for real inside a transaction that always rolls back.
 *
 * WHY THE PROBE MAKES YOU TYPE THE HOST. It writes — rolled back, but
 * written — and the standing rule here is that nothing writes to production.
 * Rather than hardcode a hostname that will rot, the probe refuses unless
 * the `--host=` you pass matches the host the connection string actually
 * resolves to. You cannot fire it at a database by accident, because you
 * have to name the one you think you are pointing at.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FUNCTIONS = [
  "assert_client_grant_has_worker_type",
  "trg_grant_requires_worker_type",
  "trg_worker_type_cleared",
  "trg_contact_linked_to_grantee",
] as const;

const TRIGGERS: Array<{ name: string; table: string; why: string }> = [
  {
    name: "user_custom_role_requires_worker_type",
    table: "UserCustomRole",
    why: "granting a role to an unclassified customer",
  },
  {
    name: "user_worker_type_cleared_with_grants",
    table: "User",
    why: "clearing the worker type off a customer who holds grants",
  },
  {
    name: "client_contact_linked_to_grantee",
    table: "ClientContact",
    why: "attaching a customer contact to an unclassified account that holds grants",
  },
];

function hostOf(url: string | undefined): string {
  if (!url) return "(DATABASE_URL unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function structural(): Promise<boolean> {
  let ok = true;

  const fns = (await prisma.$queryRawUnsafe(
    `SELECT p.proname::text AS name FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    FUNCTIONS as unknown as string[],
  )) as Array<{ name: string }>;
  const haveFns = new Set(fns.map((r) => r.name));
  for (const f of FUNCTIONS) {
    const present = haveFns.has(f);
    if (!present) ok = false;
    console.log(`  ${present ? "ok  " : "MISS"}  function ${f}`);
  }

  const trgs = (await prisma.$queryRawUnsafe(
    `SELECT t.tgname::text AS name, c.relname::text AS tbl
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])`,
    TRIGGERS.map((t) => t.name),
  )) as Array<{ name: string; tbl: string }>;
  const haveTrgs = new Map(trgs.map((r) => [r.name, r.tbl]));
  for (const t of TRIGGERS) {
    const on = haveTrgs.get(t.name);
    const present = on === t.table;
    if (!present) ok = false;
    console.log(
      `  ${present ? "ok  " : "MISS"}  trigger  ${t.name} on ${t.table}` +
        (on && on !== t.table ? `  (found on ${on} instead!)` : ""),
    );
  }

  const applied = (await prisma.$queryRawUnsafe(
    `SELECT finished_at::text AS at FROM _prisma_migrations
      WHERE migration_name = $1 AND finished_at IS NOT NULL`,
    "20261020140000_client_grants_require_a_worker_type",
  )) as Array<{ at: string }>;
  const migrated = applied.length > 0;
  if (!migrated) ok = false;
  console.log(
    `  ${migrated ? "ok  " : "MISS"}  migration recorded as applied` +
      (migrated ? ` (${applied[0].at})` : ""),
  );
  return ok;
}

/**
 * Build the forbidden state for real and confirm the database says no.
 *
 * Everything happens inside one transaction that ends in a deliberate
 * rollback, so a pass and a failure leave the database identical.
 */
/**
 * Build the forbidden state for real and confirm the database says no.
 *
 * ONE TRANSACTION PER ENTRY POINT, not one for all three. Postgres aborts
 * the whole transaction on the first failed statement — "current
 * transaction is aborted, commands ignored until end of transaction
 * block" — so a single transaction can only ever observe the first
 * refusal and then collapses. Each probe therefore builds its own
 * fixtures and ends in its own deliberate rollback, so a pass and a
 * failure both leave the database exactly as they found it.
 */
async function probe(): Promise<boolean> {
  let refusals = 0;

  /** Run `body` in a transaction that never commits. Returns true if the
   *  database REFUSED the forbidden act inside it. */
  async function inRollback(
    why: string,
    body: (tx: any, tag: string, roleId: string, clientId: string) => Promise<void>,
  ): Promise<void> {
    const tag = `E2E_guard_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let refused = false;
    try {
      await prisma.$transaction(async (tx) => {
        const role = await tx.customRole.create({
          data: { name: `${tag}_role`, isSystem: false },
          select: { id: true },
        });
        const client = await tx.client.create({
          data: { displayName: `${tag}_client`, type: "PERSON" },
          select: { id: true },
        });
        try {
          await body(tx, tag, role.id, client.id);
        } catch {
          refused = true;
          // The transaction is now aborted and unusable; leave immediately.
          throw new Error("__rollback__");
        }
        throw new Error("__rollback__");
      });
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("__rollback__")) {
        console.log(`  ERROR while probing ${why}: ${e?.message ?? e}`);
        return;
      }
    }
    if (refused) refusals++;
    console.log(`  ${refused ? "ok    refused:" : "LEAK  ALLOWED:"} ${why}`);
  }

  // 1. Granting a role to an unclassified customer.
  await inRollback(TRIGGERS[0].why, async (tx, tag, roleId, clientId) => {
    const cust = await tx.user.create({
      data: { email: `${tag}_c@example.invalid`, clerkUserId: `${tag}_c`, isApproved: true },
      select: { id: true, clerkUserId: true },
    });
    await tx.clientContact.create({
      data: {
        clientId,
        firstName: "E2E",
        lastName: "contact",
        clerkUserId: cust.clerkUserId,
        status: "ACTIVE",
      },
    });
    await tx.userCustomRole.create({ data: { userId: cust.id, customRoleId: roleId } });
  });

  // 2. Clearing the worker type off a customer who holds grants.
  await inRollback(TRIGGERS[1].why, async (tx, tag, roleId, clientId) => {
    const u = await tx.user.create({
      data: {
        email: `${tag}_s@example.invalid`,
        clerkUserId: `${tag}_s`,
        isApproved: true,
        workerType: "EMPLOYEE",
      },
      select: { id: true, clerkUserId: true },
    });
    await tx.clientContact.create({
      data: {
        clientId,
        firstName: "E2E",
        lastName: "contact",
        clerkUserId: u.clerkUserId,
        status: "ACTIVE",
      },
    });
    await tx.userCustomRole.create({ data: { userId: u.id, customRoleId: roleId } });
    await tx.user.update({ where: { id: u.id }, data: { workerType: null } });
  });

  // 3. Attaching a customer contact to an unclassified account holding grants.
  await inRollback(TRIGGERS[2].why, async (tx, tag, roleId, clientId) => {
    const u = await tx.user.create({
      data: { email: `${tag}_g@example.invalid`, clerkUserId: `${tag}_g`, isApproved: true },
      select: { id: true, clerkUserId: true },
    });
    await tx.userCustomRole.create({ data: { userId: u.id, customRoleId: roleId } });
    await tx.clientContact.create({
      data: {
        clientId,
        firstName: "E2E",
        lastName: "contact",
        clerkUserId: u.clerkUserId,
        status: "ACTIVE",
      },
    });
  });

  return refusals === TRIGGERS.length;
}

(async () => {
  const args = process.argv.slice(2);
  const host = hostOf(process.env.DATABASE_URL);
  console.log(`\nclient-grant guard — ${host}\n`);

  let ok = await structural();

  if (args.includes("--probe")) {
    const named = args.find((a) => a.startsWith("--host="))?.slice("--host=".length);
    if (named !== host) {
      console.log(
        `\n  REFUSED: --probe writes (inside a rollback) and will not run until you\n` +
          `  name the database you are pointing at. Re-run with:\n\n` +
          `      npm run verify:client-grant-guard -- --probe --host=${host}\n`,
      );
      await prisma.$disconnect();
      process.exit(2);
    }
    console.log("\n  behavioural probe (all writes rolled back):");
    ok = (await probe()) && ok;
  } else {
    console.log("\n  (structural only — pass --probe to prove the triggers actually refuse)");
  }

  console.log(`\n${ok ? "PASS" : "FAIL"} — client-grant guard\n`);
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
})();
