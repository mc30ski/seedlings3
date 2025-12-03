export type Role = "SUPER" | "ADMIN" | "WORKER";

export type AdminTabs =
  | "equipment"
  | "clients"
  | "properties"
  | "users"
  | "activity"
  | "jobs"
  | "payments"
  | "audit";

export type WorkerTabs =
  | "equipment"
  | "clients"
  | "properties"
  | "jobs"
  | "payments";

export type EventTypes =
  | "clientTabToPropertiesTabSearch"
  | "propertyTabToClientTabSearch"
  | "propertyTabToClientTabContactSearch"
  | "activityTavToEquipmentTabQRCodeSearch";

export type DialogMode = "CREATE" | "UPDATE";

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: Role[];
  email?: string | null;
  displayName?: string | null;
};

export type TabPropsType = {
  me: Me | null;
  purpose: Role;
};

export const EQUIPMENT_KIND = [
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
export type EquipmentKind = (typeof EQUIPMENT_KIND)[number];

export const EQUIPMENT_STATUS = [
  "AVAILABLE",
  "RESERVED",
  "CHECKED_OUT",
  "MAINTENANCE",
  "RETIRED",
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUS)[number];

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
  type: EquipmentKind;
  status: EquipmentStatus;
  qrSlug: string;
  shortDesc: string;
  brand: string;
  model: string;
  energy: EquipmentEnergy;

  longDesc?: string | undefined;
  features?: string | undefined;
  condition?: string | undefined;
  issues?: string | undefined;
  age?: string | undefined;

  createdAt: string | undefined;
  updatedAt?: string | undefined;
  retiredAt?: string | undefined;

  holder?: EquipmentHolder | undefined;
};

export const PROPERTY_KIND = ["SINGLE", "AGGREGATE_SITE"] as const;
export type PropertyKind = (typeof PROPERTY_KIND)[number];

export const PROPERTY_STATUS = ["PENDING", "ACTIVE", "ARCHIVED"] as const;
export type PropertyStatus = (typeof PROPERTY_STATUS)[number];

export type Property = {
  id: string;
  kind: PropertyKind;
  status: PropertyStatus;
  displayName: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  accessNotes?: string;

  clientId?: string;
  //TODO: When Client type created.
  client?: any;
  pointOfContactId?: string;
  //TODO: When Client type created.
  pointOfContact?: any;

  createdAt: string | undefined;
  updatedAt?: string | undefined;
  archivedAt?: string | undefined;
};

export type Client = {
  id: string;
  type: ClientKind;
  displayName: string;
  status: ClientStatus;
  notesInternal?: string | null;

  createdAt?: string | null;
  updatedAt?: string | null;

  contacts?: Contact[];
};

export const CLIENT_KIND = [
  "INDIVIDUAL",
  "HOUSEHOLD",
  "ORGANIZATION",
  "COMMUNITY",
] as const;
export type ClientKind = (typeof CLIENT_KIND)[number];

export const CLIENT_STATUS = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type ClientStatus = (typeof CLIENT_STATUS)[number];

export type Contact = {
  id: string;
  status: ContactStatus;
  clientId: string;
  role: string;
  active: boolean;
  firstName: string;
  lastName: string;
  email: string | null;
  phone?: string | null;
  normalizedPhone?: string | null;
  isPrimary?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export const CONTACT_KIND = [
  "OWNER",
  "SPOUSE",
  "COMMUNITY_MANAGER",
  "PROPERTY_MANAGER",
  "BILLING",
  "TECHNICAL",
  "OPERATIONS",
  "LEGAL",
  "OTHER",
] as const;
export type ContactKind = (typeof CONTACT_KIND)[number];

export const CONTACT_STATUS = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type ContactStatus = (typeof CONTACT_STATUS)[number];
