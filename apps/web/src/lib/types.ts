export type Role = "SUPER" | "ADMIN" | "WORKER";

export const EQUIPMENT_TYPES = [
  "MOWER",
  "TRIMMER",
  "BLOWER",
  "HEDGER",
  "EDGER",
  "CUTTER",
  "SPREADER",
  "WASHER",
  "MISC",
] as const;

export const EQUIPMENT_ENERGY = [
  "87 Octane",
  "93 Octane",
  "50:1 Mixed",
  "40:1 Mixed",
  "Electric Plugin",
  "Electric Battery",
  "Manual",
] as const;

export type EquipmentEnergy = (typeof EQUIPMENT_ENERGY)[number];

export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export type EquipmentStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "CHECKED_OUT"
  | "MAINTENANCE"
  | "RETIRED";

export type EquipmentHolder = {
  userId: string;
  displayName: string | null;
  email: string | null;
  reservedAt: string; // ISO
  checkedOutAt: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

export type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string | null;
  qrSlug: string | null;
  status: EquipmentStatus;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
  brand: string | null;
  model: string | null;
  type: EquipmentType | null;
  energy: EquipmentEnergy | null;
  features: string | null;
  condition: string | null;
  issues: string | null;
  age: string | null;
  holder: EquipmentHolder | null;
};

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: Role[];
  email?: string | null;
  displayName?: string | null;
};

export type TabRolePropType = { role: "worker" | "admin" };
