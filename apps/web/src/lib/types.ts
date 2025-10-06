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
  holder: EquipmentHolder | null;
};

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: ("ADMIN" | "WORKER")[];
  email?: string | null;
  displayName?: string | null;
};

export const StatusColor: Record<EquipmentStatus, any> = {
  AVAILABLE: { colorPalette: "green" },
  RESERVED: { colorPalette: "orange" },
  CHECKED_OUT: { colorPalette: "red" },
  MAINTENANCE: { colorPalette: "yellow" },
  RETIRED: { colorPalette: "gray" },
};
