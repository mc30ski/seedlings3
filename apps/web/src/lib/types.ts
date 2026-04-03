export type Role = "SUPER" | "ADMIN" | "WORKER";

export type AdminTabs =
  | "reminders"
  | "equipment"
  | "clients"
  | "properties"
  | "users"
  | "activity"
  | "jobs"
  | "admin-jobs"
  | "payments"
  | "routes"
  | "statistics"
  | "audit"
  | "settings";

export type ClientTabs = "my-jobs" | "public" | "services";

export type PreviewTabs = "routes";

export type WorkerTabs =
  | "reminders"
  | "routes"
  | "statistics"
  | "equipment"
  | "clients"
  | "properties"
  | "jobs"
  | "payments";

export type EventTypes =
  | "clientTabToPropertiesTabSearch"
  | "propertyTabToClientTabSearch"
  | "propertyTabToClientTabContactSearch"
  | "activityTavToEquipmentTabQRCodeSearch"
  | "jobsTabToPropertiesTabSearch"
  | "jobsTabToClientsTabSearch"
  | "paymentsTabToPropertiesTabSearch"
  | "paymentsTabToClientsTabSearch"
  | "paymentsTabToServicesTabSearch"
  | "jobsTabToServicesTabSearch"
  | "remindersToJobsTabSearch";

export type DialogMode = "CREATE" | "UPDATE";

export const WORKER_TYPE = ["EMPLOYEE", "CONTRACTOR", "TRAINEE"] as const;
export type WorkerType = (typeof WORKER_TYPE)[number];

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: Role[];
  email?: string | null;
  displayName?: string | null;
  workerType?: WorkerType | null;
  homeBaseAddress?: string | null;
  hasInsuranceCert?: boolean;
  isInsuranceValid?: boolean;
  insuranceExpiresAt?: string | null;
  contractorAgreedAt?: string | null;
  w9Collected?: boolean;
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

  dailyRate?: number | null;
  requiresInsurance?: boolean;

  createdAt: string | undefined;
  updatedAt?: string | undefined;
  retiredAt?: string | undefined;

  holder?: EquipmentHolder | undefined;
};

export const PROPERTY_KIND = ["SINGLE", "AGGREGATE_SITE"] as const;
export type PropertyKind = (typeof PROPERTY_KIND)[number];

export const PROPERTY_STATUS = ["ACTIVE", "ARCHIVED"] as const;
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
  "PERSON",
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
  nickname?: string | null;
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

// ---- Jobs ----

export const JOB_KIND = ["SINGLE_ADDRESS", "ENTIRE_SITE"] as const;
export type JobKind = (typeof JOB_KIND)[number];

export const JOB_STATUS = ["PROPOSED", "ACCEPTED", "PAUSED", "ARCHIVED"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const JOB_OCCURRENCE_STATUS = [
  "SCHEDULED",
  "IN_PROGRESS",
  "PENDING_PAYMENT",
  "CLOSED",
  "ARCHIVED",
  "PROPOSAL_SUBMITTED",
  "ACCEPTED",
  "REJECTED",
] as const;
export type JobOccurrenceStatus = (typeof JOB_OCCURRENCE_STATUS)[number];

export const OCCURRENCE_WORKFLOW = ["STANDARD", "ONE_OFF", "ESTIMATE"] as const;
export type OccurrenceWorkflow = (typeof OCCURRENCE_WORKFLOW)[number];

export const JOB_TYPE_OPTIONS = [
  { value: "", label: "Not specified" },
  { value: "MOW_ONLY", label: "Mow Only" },
  { value: "MOW_TRIM_BLOW", label: "Mow / Trim / Blow" },
  { value: "FULL_SERVICE", label: "Full Service (Mow / Trim / Edge / Blow)" },
  { value: "TRIM_BLOW", label: "Trim & Blow" },
  { value: "EDGE_TRIM", label: "Edge & Trim" },
  { value: "LEAF_REMOVAL", label: "Leaf Removal" },
  { value: "LEAF_CLEANUP", label: "Leaf Cleanup & Blow" },
  { value: "MULCH_INSTALL", label: "Mulch Install" },
  { value: "MULCH_BED_REFRESH", label: "Mulch Bed Refresh" },
  { value: "HEDGE_TRIMMING", label: "Hedge Trimming" },
  { value: "BUSH_PRUNING", label: "Bush / Shrub Pruning" },
  { value: "TREE_TRIMMING", label: "Tree Trimming (Low Branches)" },
  { value: "WEED_CONTROL", label: "Weed Control / Pull" },
  { value: "BED_WEEDING", label: "Flower Bed Weeding" },
  { value: "FERTILIZATION", label: "Fertilization" },
  { value: "AERATION", label: "Lawn Aeration" },
  { value: "OVERSEEDING", label: "Overseeding" },
  { value: "AERATION_OVERSEEDING", label: "Aeration & Overseeding" },
  { value: "DETHATCHING", label: "Dethatching" },
  { value: "SOD_INSTALL", label: "Sod Installation" },
  { value: "SEED_INSTALL", label: "Seed Installation" },
  { value: "SPRING_CLEANUP", label: "Spring Cleanup" },
  { value: "FALL_CLEANUP", label: "Fall Cleanup" },
  { value: "GUTTER_CLEANING", label: "Gutter Cleaning" },
  { value: "PRESSURE_WASHING", label: "Pressure Washing" },
  { value: "DRIVEWAY_CLEANING", label: "Driveway / Walkway Cleaning" },
  { value: "DEBRIS_REMOVAL", label: "Debris / Brush Removal" },
  { value: "STUMP_GRINDING", label: "Stump Grinding" },
  { value: "FLOWER_PLANTING", label: "Flower / Plant Installation" },
  { value: "LANDSCAPE_DESIGN", label: "Landscape Design" },
  { value: "IRRIGATION_CHECK", label: "Irrigation Check / Repair" },
  { value: "DRAINAGE", label: "Drainage Work" },
  { value: "GRADING", label: "Grading / Leveling" },
  { value: "RETAINING_WALL", label: "Retaining Wall" },
  { value: "PATIO_WALKWAY", label: "Patio / Walkway Install" },
  { value: "SNOW_REMOVAL", label: "Snow Removal" },
  { value: "SALT_TREATMENT", label: "Salt / Ice Treatment" },
  { value: "OTHER", label: "Other" },
] as const;

export const JOB_CADENCE = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type JobCadence = (typeof JOB_CADENCE)[number];

export type JobSchedule = {
  id: string;
  jobId: string;
  autoRenew: boolean;
  cadence?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  active: boolean;
};

export type JobOccurrenceAssigneeWithUser = {
  id: string;
  occurrenceId: string;
  userId: string;
  assignedById?: string | null;
  assignedAt?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null };
};

export type JobOccurrenceFull = {
  id: string;
  jobId: string;
  kind: JobKind;
  status: JobOccurrenceStatus;
  source: string;
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;
  workflow?: OccurrenceWorkflow;
  isOneOff?: boolean;
  isTentative?: boolean;
  isEstimate?: boolean;
  isAdminOnly?: boolean;
  proposalAmount?: number | null;
  proposalNotes?: string | null;
  rejectionReason?: string | null;
  generatedEstimate?: string | null;
  generatedEstimateBreakdown?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  startLat?: number | null;
  startLng?: number | null;
  completeLat?: number | null;
  completeLng?: number | null;
  assignees: JobOccurrenceAssigneeWithUser[];
  payment?: PaymentInfo | null;
  expenses?: ExpenseItem[];
  _count?: { photos: number };
  createdAt?: string;
};

export type JobListItem = {
  id: string;
  propertyId: string;
  property: {
    id: string;
    displayName: string;
    street1?: string | null;
    city?: string | null;
    state?: string | null;
    status: string;
    client?: { id: string; displayName: string } | null;
  };
  kind: JobKind;
  status: JobStatus;
  frequencyDays?: number | null;
  schedule?: JobSchedule | null;
  nextOccurrence?: {
    id: string;
    startAt?: string | null;
    status: string;
    kind: string;
  } | null;
  assigneeCount: number;
  occurrenceCount?: number;
  notes?: string | null;
  defaultPrice?: number | null;
  estimatedMinutes?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type JobDetail = JobListItem & {
  defaultAssignees?: { id: string; userId: string; user?: { id: string; displayName?: string | null; email?: string | null } }[];
  occurrences: JobOccurrenceFull[];
};

// ---- Expenses ----

export type ExpenseItem = {
  id: string;
  occurrenceId?: string;
  cost: number;
  description: string;
  createdById: string;
  createdBy?: { id: string; displayName?: string | null };
  createdAt?: string;
};

// ---- Payments ----

export const PAYMENT_METHOD = ["CASH", "CHECK", "VENMO", "ZELLE", "APPLE_PAY", "CASH_APP", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export type PaymentSplitItem = {
  id: string;
  userId: string;
  amount: number;
  user: { id: string; displayName?: string | null; email?: string | null };
};

export type PaymentInfo = {
  id: string;
  occurrenceId: string;
  amountPaid: number;
  method: PaymentMethod;
  note?: string | null;
  platformFeePercent?: number | null;
  platformFeeAmount?: number | null;
  businessMarginPercent?: number | null;
  businessMarginAmount?: number | null;
  collectedBy?: { id: string; displayName?: string | null };
  splits: PaymentSplitItem[];
  createdAt: string;
};

export type PaymentListItem = PaymentInfo & {
  occurrence: {
    id: string;
    jobId: string;
    startAt?: string | null;
    expenses?: ExpenseItem[];
    job: {
      id: string;
      property: { id: string; displayName: string; client?: { id: string; displayName: string } | null };
    };
  };
};

export type WorkerPaymentItem = {
  splitId: string;
  myAmount: number;
  payment: {
    id: string;
    amountPaid: number;
    method: PaymentMethod;
    note?: string | null;
    platformFeePercent?: number | null;
    platformFeeAmount?: number | null;
    businessMarginPercent?: number | null;
    businessMarginAmount?: number | null;
    collectedBy?: { id: string; displayName?: string | null };
    createdAt: string;
    splits: PaymentSplitItem[];
  };
  occurrence: {
    id: string;
    jobId: string;
    startAt?: string | null;
    expenses?: ExpenseItem[];
    job: {
      id: string;
      property: { id: string; displayName: string; client?: { id: string; displayName: string } | null };
    };
  };
};

export type EquipmentCharge = {
  id: string;
  equipmentId: string;
  userId: string;
  reservedAt: string;
  checkedOutAt: string | null;
  releasedAt: string | null;
  rentalDays: number | null;
  rentalCost: number | null;
  equipment: {
    id: string;
    shortDesc: string;
    brand: string | null;
    model: string | null;
    dailyRate: number | null;
  };
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
    workerType?: string | null;
  };
};

export type WorkerOccurrence = {
  id: string;
  jobId: string;
  kind: JobKind;
  status: JobOccurrenceStatus;
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;
  workflow?: OccurrenceWorkflow;
  isOneOff?: boolean;
  isTentative?: boolean;
  isEstimate?: boolean;
  isAdminOnly?: boolean;
  proposalAmount?: number | null;
  proposalNotes?: string | null;
  rejectionReason?: string | null;
  generatedEstimate?: string | null;
  generatedEstimateBreakdown?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  startLat?: number | null;
  startLng?: number | null;
  completeLat?: number | null;
  completeLng?: number | null;
  payment?: PaymentInfo | null;
  expenses?: ExpenseItem[];
  _count?: { photos: number };
  job: {
    id: string;
    kind: JobKind;
    frequencyDays?: number | null;
    property: {
      id: string;
      displayName: string;
      street1: string;
      city: string;
      state: string;
      client?: { id: string; displayName: string };
    };
  };
  assignees?: {
    userId: string;
    assignedById?: string | null;
    user: { id: string; displayName?: string | null; email?: string | null; workerType?: WorkerType | null };
  }[];
};

export type OccurrencePhoto = {
  id: string;
  fileName?: string | null;
  contentType?: string | null;
  uploadedBy?: { id: string; displayName?: string | null };
  createdAt: string;
  url: string;
};
