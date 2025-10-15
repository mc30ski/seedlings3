// apps/web/src/types/services.ts
import type { Equipment, AuditEvent, User, UserRole } from "@prisma/client";

export type Role = "SUPER" | "ADMIN" | "WORKER";

type ReserveResult = { id: string; userId: string };
type CheckoutResult = { id: string; userId: string };
type ReleaseResult = { released: true };
type CancelResult = { cancelled: true };

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
  qrSlug: string;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: Date;
  checkedOutAt: Date | null;
};

export type EquipmentWithHolder = Equipment & { holder: AdminHolder | null };

/** ------------------ Admin → Activity (types) ------------------ **/

export type AdminActivityEvent = {
  // ---- Equipment details
  equipmentName?: string;
  qrSlug?: string;
  brand?: string;
  model?: string;
  type?: string;
  // ---- Role details
  role?: string;
};

export type AdminActivityUser = {
  userId: string;
  displayName?: string;
  email?: string;
  lastActivityAt: Date | null;
  count: number;
  events: AdminActivityEvent[];
};

export type Services = {
  equipment: {
    // -------- LISTS --------
    listAvailable(): Promise<Equipment[]>;
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
    create(
      clerkUserId: string,
      input: {
        shortDesc: string;
        longDesc?: string;
        brand?: string;
        model?: string;
        type?: string;
        energy?: string;
        features?: string;
        condition?: string;
        issues?: string;
        age?: string;
        qrSlug?: string | null;
      }
    ): Promise<Equipment>;

    update(
      clerkUserId: string,
      id: string,
      patch: Partial<
        Pick<
          Equipment,
          | "shortDesc"
          | "longDesc"
          | "qrSlug"
          | "brand"
          | "model"
          | "type"
          | "energy"
          | "features"
          | "condition"
          | "issues"
          | "age"
        >
      >
    ): Promise<Equipment>;

    // Blocked if status is RESERVED or CHECKED_OUT (or any active row exists)
    retire(clerkUserId: string, id: string): Promise<Equipment>;
    unretire(clerkUserId: string, id: string): Promise<Equipment>;
    hardDelete(clerkUserId: string, id: string): Promise<{ deleted: true }>;

    // Force release (from RESERVED or CHECKED_OUT)
    release(clerkUserId: string, id: string): Promise<ReleaseResult>;

    // Worker lifecycle (RESERVE → CHECKOUT → RETURN)
    reserve(
      clerkUserId: string,
      id: string,
      userId: string
    ): Promise<ReserveResult>;
    cancelReservation(
      clerkUserId: string,
      id: string,
      userId: string
    ): Promise<CancelResult>;
    checkoutWithQr(
      clerkUserId: string,
      id: string,
      userId: string,
      slug: string
    ): Promise<CheckoutResult>;
    returnWithQr(
      clerkUserId: string,
      id: string,
      userId: string,
      slug: string
    ): Promise<ReleaseResult>;
  };

  maintenance: {
    start(clerkUserId: string, id: string): Promise<Equipment>;
    end(clerkUserId: string, id: string): Promise<Equipment>;
  };

  users: {
    list(params?: {
      approved?: boolean;
      role?: Role;
    }): Promise<(User & { roles: UserRole[] })[]>;
    // Reserved + checked-out items (flat list used by AdminUsers UI)
    listHoldings(): Promise<AdminUserHolding[]>;

    approve(clerkUserId: string, userId: string): Promise<User>;
    addRole(clerkUserId: string, userId: string, role: Role): Promise<UserRole>;
    removeRole(
      clerkUserId: string,
      userId: string,
      role: Role
    ): Promise<{ deleted: boolean }>;
    // Hard-delete user (Clerk + DB)
    remove(
      clerkUserId: string,
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
      action?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    }): Promise<{ items: AuditEvent[]; total: number }>;
  };

  admin: {
    listUserActivity(): Promise<AdminActivityUser[]>;
  };
};
