// One-off — write the PAYROLL_TAX_ESTIMATES setting row with default
// values. Idempotent. Run when adding the feature to an environment
// that you don't want to reseed (prod).
//
// Defaults are reasonable NC small-employer estimates:
//   • Social Security (employer):  6.20%
//   • Medicare (employer):         1.45%
//   • FUTA (employer):             0.60%
//   • SUTA (employer):             1.50%  ← replace with your NCDES rate
//
// Workers' Comp is intentionally NOT included (it's an insurance
// premium, tracked as a BusinessExpense).

import { prisma } from "../src/db/prisma";

async function main() {
  const value = JSON.stringify({
    socialSecurityEmployerPct: 6.2,
    medicareEmployerPct: 1.45,
    futaEmployerPct: 0.6,
    sutaEmployerPct: 1.5,
  });
  const description =
    "Operator-tunable employer-side payroll tax rates (Social Security, Medicare, FUTA, SUTA) used on the Reconcile P&L's 'Employer payroll taxes (est.)' line. Defaults are NC small-employer estimates; replace SUTA with your NCDES rate notice value.";

  const existing = await prisma.setting.findUnique({
    where: { key: "PAYROLL_TAX_ESTIMATES" },
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
    console.log("PAYROLL_TAX_ESTIMATES already exists. Current value:");
    console.log(`  ${existing.value}`);
    console.log("Leaving value untouched; updating description + section only.");
    await prisma.setting.update({
      where: { key: "PAYROLL_TAX_ESTIMATES" },
      // `section` drives the SettingsTab grouping — must be set so the
      // row doesn't fall into the "Other" catch-all. See
      // apps/web/src/lib/settingSections.ts.
      data: { description, section: "payments", updatedById: actor.id },
    });
  } else {
    await prisma.setting.create({
      data: {
        key: "PAYROLL_TAX_ESTIMATES",
        value,
        description,
        section: "payments",
        updatedById: actor.id,
      },
    });
    console.log("PAYROLL_TAX_ESTIMATES created with defaults:");
    console.log(`  ${value}`);
  }
  console.log(`Actor: ${actor.displayName ?? actor.email ?? actor.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
