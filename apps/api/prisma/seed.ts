// apps/api/prisma/seed.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // --- Users ---
  const admin = await prisma.user.upsert({
    where: { clerkUserId: "clerk_admin_example" },
    update: {},
    create: {
      clerkUserId: "clerk_admin_example",
      email: "admin@example.com",
      displayName: "Admin One",
      isApproved: true,
      roles: { create: [{ role: "ADMIN" }] }, // <- string literal
    },
  });

  const worker = await prisma.user.upsert({
    where: { clerkUserId: "clerk_worker_example" },
    update: {},
    create: {
      clerkUserId: "clerk_worker_example",
      email: "worker@example.com",
      displayName: "Worker One",
      isApproved: true,
      roles: { create: [{ role: "WORKER" }] }, // <- string literal
    },
  });

  // --- Equipment ---
  const mower = await prisma.equipment.create({
    data: {
      shortDesc: "Honda Mower",
      longDesc: 'Self-propelled 21" mower, model HRX217',
      status: "AVAILABLE", // <- string literal
      qrSlug: "mower-hrx217",
      auditEvents: {
        create: {
          action: "EQUIPMENT_CREATED", // <- string literal
          actorUserId: admin.id,
          metadata: { note: "seed" },
        },
      },
    },
  });

  const trimmer = await prisma.equipment.create({
    data: {
      shortDesc: "Stihl Trimmer",
      longDesc: "String trimmer FS 56 RC-E",
      status: "AVAILABLE",
      qrSlug: "trimmer-fs56",
      auditEvents: {
        create: {
          action: "EQUIPMENT_CREATED",
          actorUserId: admin.id,
          metadata: { note: "seed" },
        },
      },
    },
  });

  const blower = await prisma.equipment.create({
    data: {
      shortDesc: "Leaf Blower",
      longDesc: "Backpack blower BR 600",
      status: "AVAILABLE",
      qrSlug: "blower-br600",
      auditEvents: {
        create: {
          action: "EQUIPMENT_CREATED",
          actorUserId: admin.id,
          metadata: { note: "seed" },
        },
      },
    },
  });

  // --- Maintenance window (trimmer, later today for 2 hours) ---
  const starts = new Date(Date.now() + 60 * 60 * 1000);
  const ends = new Date(Date.now() + 3 * 60 * 60 * 1000);

  await prisma.maintenanceWindow.create({
    data: {
      equipmentId: trimmer.id,
      startsAt: starts,
      endsAt: ends,
      reason: "Line head replacement",
    },
  });

  await prisma.auditEvent.create({
    data: {
      action: "MAINTENANCE_START",
      actorUserId: admin.id,
      equipmentId: trimmer.id,
      metadata: {
        reason: "Line head replacement",
        startsAt: starts,
        endsAt: ends,
      },
    },
  });

  // --- Example checkout (worker claims mower) ---
  await prisma.$transaction(async (tx) => {
    await tx.checkout.create({
      data: {
        equipmentId: mower.id,
        userId: worker.id,
      },
    });
    await tx.equipment.update({
      where: { id: mower.id },
      data: { status: "CHECKED_OUT" },
    });
    await tx.auditEvent.create({
      data: {
        action: "EQUIPMENT_CHECKED_OUT",
        actorUserId: worker.id,
        equipmentId: mower.id,
        metadata: { via: "seed" },
      },
    });
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
