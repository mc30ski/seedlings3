// ─────────────────────────────────────────────────────────────────────────────
// Dual-use vehicle management.
//
// Vehicles are personal-owned but used partly for business. Super
// manages the fleet list + assignments (which workers can log mileage
// against which vehicle). Workers with an active VehicleAssignment
// see the vehicle in their MileageStrip; workers without one see
// nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

export type VehicleInput = {
  displayName: string;
  make?: string | null;
  vehicleModel?: string | null;
  year?: number | null;
  plate?: string | null;
  inServiceDate?: string | null;
};

/** Load all vehicles, active first, then archived. Include the active
 *  assignment list so the admin UI can render worker chips without a
 *  follow-up roundtrip. */
export async function listVehicles(opts: { includeArchived?: boolean } = {}) {
  return prisma.vehicle.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ archivedAt: "asc" }, { displayName: "asc" }],
    include: {
      assignments: {
        where: { archivedAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, email: true, workerType: true },
          },
        },
      },
    },
  });
}

export async function getVehicle(id: string) {
  return prisma.vehicle.findUnique({
    where: { id },
    include: {
      assignments: {
        where: { archivedAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, email: true, workerType: true },
          },
        },
      },
    },
  });
}

export async function createVehicle(currentUserId: string, input: VehicleInput) {
  const displayName = input.displayName?.trim();
  if (!displayName) throw new Error("displayName is required");
  return prisma.$transaction(async (tx) => {
    const created = await tx.vehicle.create({
      data: {
        displayName,
        make: input.make ?? null,
        vehicleModel: input.vehicleModel ?? null,
        year: input.year ?? null,
        plate: input.plate ?? null,
        inServiceDate: input.inServiceDate ?? null,
      },
    });
    // inServiceDate anchors depreciation and the mileage deduction, so
    // the fleet row's origin is a tax fact, not just bookkeeping.
    await writeAudit(tx, AUDIT.VEHICLE.CREATED, currentUserId, {
      vehicleId: created.id,
      displayName: created.displayName,
      make: created.make,
      vehicleModel: created.vehicleModel,
      year: created.year,
      plate: created.plate,
      inServiceDate: created.inServiceDate,
    });
    return created;
  });
}

export async function updateVehicle(
  currentUserId: string,
  id: string,
  patch: Partial<VehicleInput>,
) {
  const data: Record<string, any> = {};
  if (patch.displayName !== undefined) {
    const dn = patch.displayName?.trim();
    if (!dn) throw new Error("displayName cannot be empty");
    data.displayName = dn;
  }
  if (patch.make !== undefined) data.make = patch.make ?? null;
  if (patch.vehicleModel !== undefined) data.vehicleModel = patch.vehicleModel ?? null;
  if (patch.year !== undefined) data.year = patch.year ?? null;
  if (patch.plate !== undefined) data.plate = patch.plate ?? null;
  if (patch.inServiceDate !== undefined) data.inServiceDate = patch.inServiceDate ?? null;
  const before = await prisma.vehicle.findUnique({ where: { id } });
  if (!before) throw new Error("Vehicle not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.vehicle.update({ where: { id }, data });
    // Moving inServiceDate retroactively shifts the depreciation /
    // deduction anchor for every mile already logged against this
    // vehicle — before/after is the whole point of this row.
    await writeAudit(tx, AUDIT.VEHICLE.UPDATED, currentUserId, {
      vehicleId: id,
      changedFields: Object.keys(data),
      before: {
        displayName: before.displayName,
        make: before.make,
        vehicleModel: before.vehicleModel,
        year: before.year,
        plate: before.plate,
        inServiceDate: before.inServiceDate,
      },
      after: {
        displayName: updated.displayName,
        make: updated.make,
        vehicleModel: updated.vehicleModel,
        year: updated.year,
        plate: updated.plate,
        inServiceDate: updated.inServiceDate,
      },
    });
    return updated;
  });
}

export async function archiveVehicle(currentUserId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.vehicle.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    // Archiving instantly revokes mileage logging for every assigned
    // worker (userCanLogAgainstVehicle checks vehicle.archivedAt), so
    // it explains a sudden gap in someone's deductible miles.
    await writeAudit(tx, AUDIT.VEHICLE.ARCHIVED, currentUserId, {
      vehicleId: updated.id,
      displayName: updated.displayName,
      archivedAt: updated.archivedAt,
    });
    return updated;
  });
}

export async function unarchiveVehicle(currentUserId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.vehicle.update({
      where: { id },
      data: { archivedAt: null },
    });
    // Restores mileage logging for every still-active assignment —
    // the mirror of ARCHIVED, and equally load-bearing for explaining
    // when a worker's miles resume.
    await writeAudit(tx, AUDIT.VEHICLE.UNARCHIVED, currentUserId, {
      vehicleId: updated.id,
      displayName: updated.displayName,
    });
    return updated;
  });
}

/** Assign a worker to a vehicle. Idempotent — re-activates a
 *  previously-archived assignment. */
export async function assignUserToVehicle(
  currentUserId: string,
  vehicleId: string,
  userId: string,
) {
  const existing = await prisma.vehicleAssignment.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
  });
  if (existing) {
    if (existing.archivedAt) {
      return prisma.$transaction(async (tx) => {
        const reactivated = await tx.vehicleAssignment.update({
          where: { id: existing.id },
          data: { archivedAt: null },
        });
        // Re-granting a previously-revoked right to log deductible
        // miles is the same privilege change as a fresh assignment.
        await writeAudit(tx, AUDIT.VEHICLE.ASSIGNED, currentUserId, {
          vehicleId,
          assignmentId: reactivated.id,
          subjectUserId: userId,
          reactivated: true,
          previouslyArchivedAt: existing.archivedAt,
        });
        return reactivated;
      });
    }
    // Already active — no state change, nothing to record.
    return existing;
  }
  return prisma.$transaction(async (tx) => {
    const created = await tx.vehicleAssignment.create({
      data: { vehicleId, userId },
    });
    // Assignment is the gate on logging business miles against this
    // vehicle — i.e. it grants a worker the ability to create
    // deductible/reimbursable records.
    await writeAudit(tx, AUDIT.VEHICLE.ASSIGNED, currentUserId, {
      vehicleId,
      assignmentId: created.id,
      subjectUserId: userId,
      reactivated: false,
    });
    return created;
  });
}

/** Soft-remove. Preserves history for mileage entries the user
 *  logged against this vehicle. */
export async function unassignUserFromVehicle(
  currentUserId: string,
  vehicleId: string,
  userId: string,
) {
  const existing = await prisma.vehicleAssignment.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
  });
  // Missing or already archived — no state change, nothing to record.
  if (!existing || existing.archivedAt) return existing;
  return prisma.$transaction(async (tx) => {
    const archived = await tx.vehicleAssignment.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
    // Revokes the worker's ability to log miles against this vehicle
    // from this moment on; explains why their entries stop.
    await writeAudit(tx, AUDIT.VEHICLE.UNASSIGNED, currentUserId, {
      vehicleId,
      assignmentId: archived.id,
      subjectUserId: userId,
      archivedAt: archived.archivedAt,
      assignedSince: existing.createdAt,
    });
    return archived;
  });
}

/** Vehicles this user can currently log mileage against.
 *  Excludes archived assignments and archived vehicles. */
export async function listAssignedVehiclesForUser(userId: string) {
  const rows = await prisma.vehicleAssignment.findMany({
    where: { userId, archivedAt: null, vehicle: { archivedAt: null } },
    include: {
      vehicle: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.vehicle);
}

/** Fast "is this user allowed to log against this vehicle right now?"
 *  check. Used at the start of every mileage-entry mutation. */
export async function userCanLogAgainstVehicle(
  userId: string,
  vehicleId: string,
): Promise<boolean> {
  const row = await prisma.vehicleAssignment.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
    include: { vehicle: { select: { archivedAt: true } } },
  });
  if (!row) return false;
  if (row.archivedAt) return false;
  if (row.vehicle.archivedAt) return false;
  return true;
}
