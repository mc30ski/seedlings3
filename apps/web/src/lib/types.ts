export type Role = "SUPER" | "ADMIN" | "WORKER";

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: Role[];
  email?: string | null;
  displayName?: string | null;
};

export type TabRolePropType = { role: "worker" | "admin" };
