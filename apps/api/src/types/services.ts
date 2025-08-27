import type {
  Equipment,
  EquipmentStatus,
  AuditEvent,
  User,
  UserRole,
} from "@prisma/client";

export type Services = {
  equipment: {
    listAvailable(): Promise<Equipment[]>;
    listAll(): Promise<Equipment[]>;
    listForWorkers(): Promise<Equipment[]>;
    listMine(userId: string): Promise<Equipment[]>;
    create(input: {
      shortDesc: string;
      longDesc?: string;
      qrSlug?: string | null;
    }): Promise<Equipment>;
    update(
      id: string,
      patch: Partial<Pick<Equipment, "shortDesc" | "longDesc" | "qrSlug">>
    ): Promise<Equipment>;
    retire(id: string): Promise<Equipment>;
    unretire(id: string): Promise<Equipment>;
    hardDelete(id: string): Promise<{ deleted: true }>;
    assign(
      id: string,
      userId: string
    ): Promise<{
      id: string;
      equipmentId: string;
      userId: string;
      checkedOutAt: Date;
      releasedAt: Date | null;
    }>;
    release(id: string): Promise<{ released: true }>;
    claim(
      id: string,
      userId: string
    ): Promise<{
      id: string;
      equipmentId: string;
      userId: string;
      checkedOutAt: Date;
      releasedAt: Date | null;
    }>;
    releaseByUser(id: string, userId: string): Promise<{ released: true }>;
  };

  // UPDATED: toggle-only maintenance API
  maintenance: {
    start(equipmentId: string): Promise<Equipment>; // sets status: 'MAINTENANCE'
    end(equipmentId: string): Promise<Equipment>; // clears to AVAILABLE (then recompute)
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
