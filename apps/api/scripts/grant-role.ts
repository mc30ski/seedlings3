/**
 * Grant a role to a person from the command line. THE WAY BACK IN.
 *
 * `install-starter-roles.ts` creates roles and grants them to NOBODY, so
 * after it runs there is still no way into an app where nothing holds
 * `people.grant-roles` any more — and granting a role needs exactly that
 * capability. Delete the role carrying it, or revoke its last grant, and
 * the in-app path is closed: `UserCustomRole.customRoleId` cascades, so the
 * grants go with the role, and the install script recreates the role while
 * granting it to nobody. Without this you would be hand-writing SQL at the
 * worst possible moment.
 *
 * This is deliberately NOT an in-app break-glass. It needs shell access and
 * the database URL, which is the point: the recovery path is as privileged
 * as the thing it recovers.
 *
 *   npx tsx scripts/grant-role.ts --email you@example.com --role seedlings.super
 *   npx tsx scripts/grant-role.ts --email you@example.com --role seedlings.super --apply
 *
 * Dry run by default. It applies the SAME rules the UI does — one ladder
 * rung, nothing from an inheritance chain already held — because a recovery
 * that leaves an invalid state is not a recovery. It does NOT check the
 * actor's own capabilities: there is no actor, and if there were one with
 * the right capability you would not need this.
 */
import "dotenv/config";
import { prisma } from "../src/db/prisma";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const email = arg("email");
  const roleKey = arg("role");
  const apply = process.argv.includes("--apply");
  if (!email || !roleKey) {
    console.error("Usage: tsx scripts/grant-role.ts --email <email> --role <role key or name> [--apply]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, displayName: true, workerType: true, isApproved: true },
  });
  if (!user) throw new Error(`No user with email ${email}.`);

  const role =
    (await prisma.customRole.findUnique({ where: { key: roleKey } })) ??
    (await prisma.customRole.findUnique({ where: { name: roleKey } }));
  if (!role) throw new Error(`No role with key or name "${roleKey}". Run install-starter-roles.ts first.`);
  if (role.suspendedAt) throw new Error(`"${role.name}" is suspended — its grants are inactive. Un-suspend it first.`);

  // The same two refusals the service applies, so this cannot create a state
  // the UI would have rejected.
  const held = await prisma.userCustomRole.findMany({
    where: { userId: user.id },
    select: { customRoleId: true, customRole: { select: { name: true, isLadderRung: true } } },
  });
  const others = held.filter((g) => g.customRoleId !== role.id);
  if (role.isLadderRung) {
    const rung = others.find((g) => g.customRole.isLadderRung);
    if (rung) throw new Error(`Already holds the rung "${rung.customRole.name}". Revoke it first.`);
  }
  const all = await prisma.customRole.findMany({ select: { id: true, inheritsFromId: true } });
  const parent = new Map(all.map((r) => [r.id, r.inheritsFromId]));
  const chainOf = (start: string) => {
    const out = new Set<string>();
    let cur: string | null | undefined = start;
    while (cur && !out.has(cur)) { out.add(cur); cur = parent.get(cur) ?? null; }
    return out;
  };
  const targetChain = chainOf(role.id);
  const clash = others.find((g) => targetChain.has(g.customRoleId) || chainOf(g.customRoleId).has(role.id));
  if (clash) throw new Error(`"${role.name}" and "${clash.customRole.name}" are in one inheritance chain. Revoke the other first.`);

  console.log(`user : ${user.displayName ?? user.email}  (approved: ${user.isApproved}, worker type: ${user.workerType ?? "NONE"})`);
  console.log(`role : ${role.name}  (${role.key ?? "no key"})`);
  if (!user.isApproved) console.log("WARNING: this account is not approved — the grant lands but every request is still refused.");
  if (user.workerType === null) {
    console.log("WARNING: this account has NO WORKER TYPE. The payroll gate resolves it to zero");
    console.log("         entitlements, so the grant will appear to do nothing until one is set.");
  }

  if (!apply) { console.log("\nDRY RUN — pass --apply to write.\n"); return; }

  await prisma.$transaction(async (tx) => {
    await tx.userCustomRole.upsert({
      where: { userId_customRoleId: { userId: user.id, customRoleId: role.id } },
      create: { userId: user.id, customRoleId: role.id },
      update: { suspendedAt: null },
    });
    // Audited like any other grant. Actor is the person themselves: a shell
    // operator has no user row, and attributing it to nobody would read as a
    // grant that appeared from nowhere.
    await tx.auditEvent.create({
      data: {
        scope: "ROLE", verb: "ROLE_ASSIGNED", actorUserId: user.id,
        metadata: {
          grantedToUserId: user.id, customRoleId: role.id, roleName: role.name,
          via: "scripts/grant-role.ts",
          why: "Command-line recovery grant — no in-app actor holds people.grant-roles.",
        },
      },
    });
  });
  console.log(`\n✓ ${role.name} granted to ${user.email}.`);
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
