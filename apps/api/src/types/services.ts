import type { Equipment, AuditEvent, User, UserRole } from "@prisma/client";

export type Role = "ADMIN" | "WORKER";

type ReserveResult = { id: string; userId: string };
type CheckoutResult = { id: string; userId: string };
type ReleaseResult = { released: true };
type CancelResult = { cancelled: true };

//TODO: WHY DO I NEED BOTH OF THESE?
export type AdminHolder = {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  reservedAt: Date;
  checkedOutAt?: Date | null;
  state: "RESERVED" | "CHECKED_OUT";
};
export type AdminUserHolding = {
  userId: string;
  equipmentId: string;
  shortDesc: string;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: Date;
  checkedOutAt: Date | null;
};

export type EquipmentWithHolder = Equipment & { holder: AdminHolder | null };

export type Services = {
  equipment: {
    // -------- LISTS --------
    listAvailable(): Promise<Equipment[]>;
    listAll(): Promise<Equipment[]>;
    // Admin view with current holder (if any)
    listAllAdmin(): Promise<EquipmentWithHolder[]>;
    // Non-retired; includes MAINTENANCE/RESERVED/CHECKED_OUT
    listForWorkers(): Promise<Equipment[]>;
    // Items workers cannot reserve RESERVED/CHECKED_OUT/MAINTENANCE/RETIRED
    listUnavailableForWorkers(): Promise<Equipment[]>;
    // Items I currently hold (reserved or checked out)
    listMine(userId: string): Promise<Equipment[]>;
    listUnavailableWithHolder(): Promise<EquipmentWithHolder[]>;

    // -------- CRUD --------
    create(input: {
      shortDesc: string;
      longDesc?: string;
      qrSlug?: string | null;
    }): Promise<Equipment>;
    update(
      id: string,
      patch: Partial<Pick<Equipment, "shortDesc" | "longDesc" | "qrSlug">>
    ): Promise<Equipment>;
    // Blocked if status is RESERVED or CHECKED_OUT (or any active row exists)
    retire(id: string): Promise<Equipment>;
    unretire(id: string): Promise<Equipment>;
    hardDelete(id: string): Promise<{ deleted: true }>;

    // -------- ADMIN ACTIONS --------
    // Direct checkout to user (bypasses reserve step)
    assign(id: string, userId: string): Promise<{ id: string; userId: string }>;
    // Force release (from RESERVED or CHECKED_OUT)
    release(id: string): Promise<ReleaseResult>;

    // Worker lifecycle (RESERVE → CHECKOUT → RETURN)
    reserve(id: string, userId: string): Promise<ReserveResult>;
    cancelReservation(id: string, userId: string): Promise<CancelResult>;
    checkout(id: string, userId: string): Promise<CheckoutResult>;
    returnByUser(id: string, userId: string): Promise<ReleaseResult>;

    releaseByUser(id: string, userId: string): Promise<ReleaseResult>;
  };

  maintenance: {
    start(equipmentId: string): Promise<Equipment>;
    end(equipmentId: string): Promise<Equipment>;
  };

  users: {
    list(params?: {
      approved?: boolean;
      role?: "ADMIN" | "WORKER";
    }): Promise<(User & { roles: UserRole[] })[]>;
    // Reserved + checked-out items (flat list used by AdminUsers UI)
    listHoldings(): Promise<AdminUserHolding[]>;

    approve(userId: string): Promise<User>;
    addRole(userId: string, role: "ADMIN" | "WORKER"): Promise<UserRole>;
    removeRole(
      userId: string,
      role: "ADMIN" | "WORKER"
    ): Promise<{ deleted: boolean }>;

    // Hard-delete user (Clerk + DB)
    remove(
      userId: string,
      actorUserId: string
    ): Promise<{ deleted: true; clerkDeleted: boolean }>;

    pendingApprovalCount(): Promise<{ pending: number }>;

    me(token: string): Promise<{
      id: string;
      isApproved: boolean;
      roles: Role[];
      email?: string | null;
      displayName?: string | null;
    }>;
  };

  currentUser: {
    me(clerkUserId: string): Promise<{
      id: string;
      isApproved: boolean;
      roles: Role[];
      email?: string | null;
      displayName?: string | null;
    }>;
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
