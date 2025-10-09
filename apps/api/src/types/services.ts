// apps/web/src/types/services.ts
import type { Equipment, AuditEvent, User, UserRole } from "@prisma/client";

export type Role = "SUPER" | "ADMIN" | "WORKER";

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

/** ------------------ Admin → Activity (types) ------------------ **/

/** Query params for GET /api/admin/activity */
export type AdminListUserActivityParams = {
  /** Optional free-text search (matches displayName/email). */
  q?: string;
  /**
   * Limit of events to return per user.
   * Server defaults to 25 and caps at 100 if omitted/out of range.
   */
  limitPerUser?: number;
};

/** A single activity event associated with a user. */
export type AdminActivityEvent = {
  /** Event id (from audit log). */
  id: string;
  /** Timestamp of the event. */
  at: Date;
  /** Backend event type (e.g., "RESERVE", "CHECKOUT", "RETURN", "SIGN_IN"). */
  type: string;
  /** Human-readable summary generated on the server (optional). */
  summary?: string;
};

/** Aggregated activity for a single user. */
export type AdminActivityUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  /** Timestamp of the most recent event for this user (or null). */
  lastActivityAt: Date | null;
  /** Number of events included in `events` for this response. */
  count: number;
  /** Chronological list of events (oldest → newest). */
  events: AdminActivityEvent[];
};

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
      brand?: string;
      model?: string;
      type?: string;
      energy?: string;
      features?: string;
      condition?: string;
      issues?: string;
      age?: string;
      qrSlug?: string | null;
    }): Promise<Equipment>;
    update(
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
    checkoutWithQr(
      id: string,
      userId: string,
      slug: string
    ): Promise<CheckoutResult>;
    returnByUser(id: string, userId: string): Promise<ReleaseResult>;

    releaseByUser(id: string, userId: string): Promise<ReleaseResult>;

    returnWithQr(
      id: string,
      userId: string,
      slug: string
    ): Promise<ReleaseResult>;
  };

  maintenance: {
    start(equipmentId: string): Promise<Equipment>;
    end(equipmentId: string): Promise<Equipment>;
  };

  users: {
    list(params?: {
      approved?: boolean;
      role?: Role;
    }): Promise<(User & { roles: UserRole[] })[]>;
    // Reserved + checked-out items (flat list used by AdminUsers UI)
    listHoldings(): Promise<AdminUserHolding[]>;

    approve(userId: string): Promise<User>;
    addRole(userId: string, role: Role): Promise<UserRole>;
    removeRole(userId: string, role: Role): Promise<{ deleted: boolean }>;

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

  /** Admin-only helpers */
  admin: {
    /**
     * List recent activity per user (schema-safe; uses existing audit data).
     * - GET /api/admin/activity?q={q}&limitPerUser={n}
     * - Returns one entry per user that matches the query.
     */
    listUserActivity(
      params?: AdminListUserActivityParams
    ): Promise<AdminActivityUser[]>;
  };
};
