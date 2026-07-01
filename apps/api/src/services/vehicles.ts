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

export async function createVehicle(input: VehicleInput) {
  const displayName = input.displayName?.trim();
  if (!displayName) throw new Error("displayName is required");
  return prisma.vehicle.create({
    data: {
      displayName,
      make: input.make ?? null,
      vehicleModel: input.vehicleModel ?? null,
      year: input.year ?? null,
      plate: input.plate ?? null,
      inServiceDate: input.inServiceDate ?? null,
    },
  });
}

export async function updateVehicle(id: string, patch: Partial<VehicleInput>) {
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
  return prisma.vehicle.update({ where: { id }, data });
}

export async function archiveVehicle(id: string) {
  return prisma.vehicle.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
}

export async function unarchiveVehicle(id: string) {
  return prisma.vehicle.update({
    where: { id },
    data: { archivedAt: null },
  });
}

/** Assign a worker to a vehicle. Idempotent — re-activates a
 *  previously-archived assignment. */
export async function assignUserToVehicle(vehicleId: string, userId: string) {
  const existing = await prisma.vehicleAssignment.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
  });
  if (existing) {
    if (existing.archivedAt) {
      return prisma.vehicleAssignment.update({
        where: { id: existing.id },
        data: { archivedAt: null },
      });
    }
    return existing;
  }
  return prisma.vehicleAssignment.create({
    data: { vehicleId, userId },
  });
}

/** Soft-remove. Preserves history for mileage entries the user
 *  logged against this vehicle. */
export async function unassignUserFromVehicle(vehicleId: string, userId: string) {
  const existing = await prisma.vehicleAssignment.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
  });
  if (!existing || existing.archivedAt) return existing;
  return prisma.vehicleAssignment.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
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
