// One-off — write the SOCIAL_LINKS setting row with an empty default
// value. Idempotent. Run when adding the feature to an environment that
// you don't want to reseed (prod).
//
// After this runs, the SettingsTab editor in that env will see the row
// and let the operator add Instagram / Facebook / Nextdoor / Google
// Reviews entries with uploaded brand icons.

import { prisma } from "../src/db/prisma";

async function main() {
  const value = JSON.stringify({ links: [] });
  const description =
    "List of social media links shown as a row of clickable brand-icon tiles under the property photos on the public invoice/pay page. Each entry stores a display label, the destination URL, and a brand icon uploaded as a data URL (50 KB max).";

  const existing = await prisma.setting.findUnique({
    where: { key: "SOCIAL_LINKS" },
  });

  // Pick an actor — prefer LLC-owner, then any SUPER, then ADMIN.
  const actor = await prisma.user.findFirst({
    where: { OR: [{ isOwner: true }, { roles: { some: { role: "SUPER" } } }, { roles: { some: { role: "ADMIN" } } }] },
    orderBy: [{ isOwner: "desc" }],
    select: { id: true, displayName: true, email: true },
  });
  if (!actor) {
    console.error("No user with isOwner/SUPER/ADMIN found — can't set updatedById. Aborting.");
    process.exit(1);
  }

  if (existing) {
    console.log("SOCIAL_LINKS already exists. Current value:");
    console.log(`  ${existing.value}`);
    console.log("Leaving value untouched; updating description + section only.");
    await prisma.setting.update({
      where: { key: "SOCIAL_LINKS" },
      // `section` drives the SettingsTab grouping — must be set so the
      // row doesn't fall into the "Other" catch-all. See
      // apps/web/src/lib/settingSections.ts.
      data: { description, section: "client_requests", updatedById: actor.id },
    });
  } else {
    await prisma.setting.create({
      data: {
        key: "SOCIAL_LINKS",
        value,
        description,
        section: "client_requests",
        updatedById: actor.id,
      },
    });
    console.log("SOCIAL_LINKS created with empty links array.");
  }
  console.log(`Actor: ${actor.displayName ?? actor.email ?? actor.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
