// apps/api/src/types/services.ts
import type {
  Equipment,
  EquipmentStatus, // includes 'RESERVED'
  AuditEvent,
  User,
  UserRole,
} from "@prisma/client";

// --- result helpers ---
type ReserveResult = { id: string; userId: string };
type CheckoutResult = { id: string; userId: string };
type ReleaseResult = { released: true };
type CancelResult = { cancelled: true };

// --- admin holder shape for listAllAdmin() ---
export type AdminHolder = {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  reservedAt: Date;
  checkedOutAt?: Date | null;
  state: "RESERVED" | "CHECKED_OUT";
};

export type EquipmentWithHolder = Equipment & { holder: AdminHolder | null };

export type Services = {
  equipment: {
    // Lists
    listAvailable(): Promise<Equipment[]>;
    listAll(): Promise<Equipment[]>;
    /** Admin view with current holder (if any) */
    listAllAdmin(): Promise<EquipmentWithHolder[]>;
    /** Non-retired; includes MAINTENANCE/RESERVED/CHECKED_OUT */
    listForWorkers(): Promise<Equipment[]>;
    /** Items I currently hold (reserved or checked out) */
    listMine(userId: string): Promise<Equipment[]>;

    // CRUD
    create(input: {
      shortDesc: string;
      longDesc?: string;
      qrSlug?: string | null;
    }): Promise<Equipment>;
    update(
      id: string,
      patch: Partial<Pick<Equipment, "shortDesc" | "longDesc" | "qrSlug">>
    ): Promise<Equipment>;
    /** Blocked if status is RESERVED or CHECKED_OUT (or any active row exists) */
    retire(id: string): Promise<Equipment>;
    unretire(id: string): Promise<Equipment>;
    hardDelete(id: string): Promise<{ deleted: true }>;

    // Admin actions
    /** Direct checkout to user (bypasses reserve step) */
    assign(id: string, userId: string): Promise<{ id: string; userId: string }>;
    /** Force release (from RESERVED or CHECKED_OUT) */
    release(id: string): Promise<ReleaseResult>;

    // Worker lifecycle (RESERVE → CHECKOUT → RETURN)
    reserve(id: string, userId: string): Promise<ReserveResult>;
    cancelReservation(id: string, userId: string): Promise<CancelResult>;
    checkout(id: string, userId: string): Promise<CheckoutResult>;
    returnByUser(id: string, userId: string): Promise<ReleaseResult>;

    // Back-compat shims (legacy endpoints)
    /** Legacy "claim" maps to reserve() */
    claim(id: string, userId: string): Promise<ReserveResult>;
    /** Legacy "release" decides cancel vs return */
    releaseByUser(id: string, userId: string): Promise<ReleaseResult>;
  };

  // Maintenance toggle (sticky)
  maintenance: {
    start(equipmentId: string): Promise<Equipment>; // -> MAINTENANCE
    end(equipmentId: string): Promise<Equipment>; // -> recompute (AVAILABLE/RESERVED/CHECKED_OUT)
  };

  users: {
    list(params?: {
      approved?: boolean;
      role?: "ADMIN" | "WORKER";
    }): Promise<(User & { roles: UserRole[] })[]>;
    approve(userId: string): Promise<User>;
    addRole(userId: string, role: "ADMIN" | "WORKER"): Promise<UserRole>;
    removeRole(
      userId: string,
      role: "ADMIN" | "WORKER"
    ): Promise<{ deleted: boolean }>;
    me(clerkUserId: string): Promise<{
      id: string;
      isApproved: boolean;
      roles: ("ADMIN" | "WORKER")[];
      email?: string | null;
      displayName?: string | null;
    }>;
    remove(
      userId: string,
      actorUserId: string
    ): Promise<{ deleted: true; clerkDeleted: boolean }>;
  };

  audit: {
    list(params: {
      actorUserId?: string;
      equipmentId?: string;
      action?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    }): Promise<{ items: AuditEvent[]; total: number }>;
  };
};
