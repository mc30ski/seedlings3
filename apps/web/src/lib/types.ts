export type Role = "SUPER" | "ADMIN" | "WORKER";

export type AdminTabs =
  | "tasks"
  | "home"
  | "reminders"
  | "equipment"
  | "clients"
  | "properties"
  | "users"
  | "activity"
  | "jobs"
  | "services"
  | "payments"
  | "routes"
  | "statistics"
  | "history"
  | "settings"
  | "profile"
  | "notify"
  | "collections"
  | "usage"
  | "supplies"
  | "groups"
  | "pricing"
  | "documents"
  | "timeline";

export type SuperTabs = "unclaimed" | "audit" | "settings" | "profile" | "ledger" | "supplies" | "pricing" | "documents" | "timeline" | "payments" | "users" | "reconcile" | "workdays" | "compliance";

export type ClientTabs = "my-jobs" | "public" | "services";

export type PreviewTabs = "routes";

export type WorkerTabs =
  | "home"
  | "tasks"
  | "reminders"
  | "routes"
  | "statistics"
  | "equipment"
  | "collections"
  | "usage"
  | "supplies"
  | "clients"
  | "properties"
  | "pricing"
  | "jobs"
  | "profile"
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
  | "servicesTabToJobsTabSearch"
  | "remindersToJobsTabSearch"
  | "jobsToEquipmentKindFilter";

export type DialogMode = "CREATE" | "UPDATE";

export const WORKER_TYPE = ["EMPLOYEE", "CONTRACTOR", "TRAINEE"] as const;
export type WorkerType = (typeof WORKER_TYPE)[number];

export type Me = {
  id: string;
  isApproved?: boolean;
  roles?: Role[];
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  workerType?: WorkerType | null;
  isOwner?: boolean;
  homeBaseAddress?: string | null;
  availableDays?: number[];
  availableHoursPerDay?: number;
  // Compliance-policy state (insurance, W-9, contractor agreement, safety
  // SOP, etc.) is served separately via GET /me/policies in Slice 2 and
  // rendered on the worker Compliance section (Slice 2 UI).
  // Guaranteed payout onboarding period (contractors only). Active when
  // guaranteedPayoutUntil > now. Surfaced on ProfileTab so the contractor
  // can see their own period and remaining days.
  guaranteedPayoutUntil?: string | null;
  guaranteedPayoutStartedAt?: string | null;
  // Override columns: null means "follow workerType default"; true/false is explicit.
  canPullInventoryOverride?: boolean | null;
  canChargeBusinessExpensesOverride?: boolean | null;
  // Effective privileges after resolution (admin/super always true).
  privileges?: {
    canPullInventory: boolean;
    canChargeBusinessExpenses: boolean;
  };
  // Payment-request delivery channel override. null = use org default.
  paymentCommsMode?: "SERVER" | "CLAIMER" | null;
  // Super-only "View as another role" support. realRoles / realWorkerType
  // are the unmodified DB values — present even when no impersonation is
  // active (in which case they mirror roles / workerType). The View-as
  // picker is gated on realRoles?.includes("SUPER") so it stays visible
  // even after Super swaps their effective role to Worker/Trainee/etc.
  realRoles?: Role[];
  realWorkerType?: WorkerType | null;
  isImpersonating?: boolean;
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
  "AERATOR",
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
  // Per-job + per-day-cap billing knob (see services/equipment.ts
  // computeRentalCost). null = legacy flat-daily billing. Positive int
  // engages per-job-with-cap mode for this piece.
  equivalentJobs?: number | null;
  // Per-piece policy requirements — array of PolicyDocument.id strings.
  // See services/equipment.ts and Slice 3 gate integration.
  requiredPolicyIds?: string[];

  createdAt: string | undefined;
  updatedAt?: string | undefined;
  retiredAt?: string | undefined;

  holder?: EquipmentHolder | undefined;
  hasPhotos?: boolean;
  instructions?: EquipmentInstruction[];
};

export type EquipmentInstruction = {
  id: string;
  text: string;
  isPreset: boolean;
  sortOrder: number;
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
  lastPhotos?: { id: string; url: string; contentType?: string | null }[];
};

export type Client = {
  id: string;
  type: ClientKind;
  displayName: string;
  status: ClientStatus;
  isVip?: boolean;
  vipReason?: string | null;
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

export const CLIENT_STATUS = ["ACTIVE", "ARCHIVED"] as const;
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
  /** Clerk user id this contact is bound to, or null if not linked yet. */
  clerkUserId?: string | null;
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

export const CONTACT_STATUS = ["ACTIVE", "ARCHIVED"] as const;
export type ContactStatus = (typeof CONTACT_STATUS)[number];

// ---- Jobs ----

export const JOB_KIND = ["SINGLE_ADDRESS", "ENTIRE_SITE"] as const;
export type JobKind = (typeof JOB_KIND)[number];

export const JOB_STATUS = ["PROPOSED", "ACCEPTED", "PAUSED", "ARCHIVED"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const JOB_OCCURRENCE_STATUS = [
  "SCHEDULED",
  "IN_PROGRESS",
  "PAUSED",
  "COMPLETED",
  "PENDING_PAYMENT",
  "CLOSED",
  "CANCELED",
  "ARCHIVED",
  "PROPOSAL_SUBMITTED",
  "ACCEPTED",
  "REJECTED",
] as const;
export type JobOccurrenceStatus = (typeof JOB_OCCURRENCE_STATUS)[number];

export const OCCURRENCE_WORKFLOW = ["STANDARD", "ONE_OFF", "ESTIMATE", "TASK", "REMINDER", "EVENT", "FOLLOWUP", "ANNOUNCEMENT"] as const;
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
  role?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null };
};

export type JobOccurrenceFull = {
  id: string;
  jobId?: string | null;
  kind?: JobKind | null;
  title?: string | null;
  status: JobOccurrenceStatus;
  source: string;
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;
  frequencyDays?: number | null;
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
  pausedAt?: string | null;
  totalPausedMs?: number | null;
  medianDurationMinutes?: number | null;
  startLat?: number | null;
  startLng?: number | null;
  completeLat?: number | null;
  completeLng?: number | null;
  linkGroupId?: string | null;
  assignees: JobOccurrenceAssigneeWithUser[];
  payment?: PaymentInfo | null;
  expenses?: ExpenseItem[];
  _count?: { photos: number; comments?: number };
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
  defaultAssignees?: { id: string; userId: string; role?: string | null; user?: { id: string; displayName?: string | null; email?: string | null } }[];
  occurrenceCount?: number;
  description?: string | null;
  notes?: string | null;
  guidanceNote?: string | null;
  defaultPrice?: number | null;
  estimatedMinutes?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type JobDetail = JobListItem & {
  defaultAssignees?: { id: string; userId: string; role?: string | null; user?: { id: string; displayName?: string | null; email?: string | null } }[];
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

// Payment methods are fully configuration-driven via the PAYMENT_METHODS
// setting (a JSON taxonomy editable in Super → Settings). There is no fixed
// enum — `PaymentMethod` is just a string keyed to that taxonomy. Use the
// usePaymentMethodLabels hook to render a method's display label.
export type PaymentMethod = string;

export type PaymentSplitItem = {
  id: string;
  userId: string;
  amount: number;
  // Per-worker breakdown fields (populated on rows created after the
  // reconciliation migration). Used to display the % split applied at
  // payment time (computed as grossAmount / Σ grossAmount).
  grossAmount?: number | null;
  ratePercent?: number | null;
  feeAmount?: number | null;
  netAmount?: number | null;
  topUpAmount?: number | null;
  // True when this split belongs to the LLC owner. UI renders these as
  // "Owner Earnings" instead of "Worker payout" to distinguish them.
  ownerEarnings?: boolean;
  // Set when the split's user was on a guaranteed-payout period at work
  // completion AND was advance-paid for this occurrence. The cash was
  // already disbursed via the GP advance row; this PaymentSplit exists
  // for audit + 1099 trace but doesn't trigger another disbursement.
  // UI labels these as "Advance paid" so admins don't pay twice.
  guaranteedPayoutPaidAt?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null; workerType?: string | null };
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
  // Processor-fee snapshot — what the payment service (e.g. Venmo) charged.
  processorFeePercent?: number | null;
  processorFeeFixed?: number | null;
  processorFeeAmount?: number | null;
  grossCharged?: number | null;
  netReceived?: number | null;
  collectedBy?: { id: string; displayName?: string | null };
  nextOccurrenceSkipReason?: string | null;
  splits: PaymentSplitItem[];
  createdAt: string;
  /** False = self-reported / worker-direct, awaiting admin approval.
   *  True = confirmed (admin approved or admin direct-recorded). */
  confirmed?: boolean;
  selfReported?: boolean;
};

export type PaymentListItem = PaymentInfo & {
  occurrence: {
    id: string;
    jobId: string;
    startAt?: string | null;
    expenses?: ExpenseItem[];
    // Promised-net snapshot taken at Take-Payment time. Each row is the
    // per-worker outcome the canonical math computed for the invoiced
    // amount, BEFORE the client pays. Used by the PaymentsTab card to
    // show employees their expected payout on pending approvals (they're
    // made whole; only contractors are contingent on the actual collected
    // amount). Null on legacy occurrences that pre-date the snapshot.
    promisedPayouts?: Array<{
      userId: string;
      workerType: string | null;
      splitPercent: number;
      gross: number;
      ratePercent: number;
      fee: number;
      net: number;
    }> | null;
    // Active + observer assignees on the occurrence, with workerType so
    // the card can fall back to compute promised-net for workers who
    // somehow lack a `promisedPayouts` entry (legacy data).
    assignees?: Array<{
      userId: string;
      role?: string | null;
      user?: { id: string; displayName?: string | null; email?: string | null; workerType?: string | null } | null;
    }>;
    job: {
      id: string;
      property: { id: string; displayName: string; client?: { id: string; displayName: string } | null };
    };
  };
};

export type WorkerPaymentItem = {
  splitId: string;
  myAmount: number;
  // What the worker was *promised* at Initiate-Payment time. For
  // employees this matches myAmount (they're made whole). For contractors
  // on underpaid jobs, myAmount < myPromisedNet — the difference is the
  // pro-rata reduction they absorbed.
  myPromisedNet?: number | null;
  // True when the viewing user is the LLC owner. Row label changes from
  // "Payout" to "Owner Earnings" so it's visually distinct.
  myOwnerEarnings?: boolean;
  payment: {
    id: string;
    amountPaid: number;
    method: PaymentMethod;
    note?: string | null;
    // confirmed = admin has approved the payment. Splits exist for both
    // confirmed and pending payments (since `createPayment` writes splits
    // immediately), so the UI shows a "Pending approval" badge on rows
    // where this is false to flag that the amount may still change at
    // admin approval (especially for contractors).
    confirmed?: boolean;
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
  // Per-day breakdown captured at release time. See
  // services/equipment.ts computeRentalCost and the
  // RentalBreakdownLine type for the shape. The worker money tab uses
  // this to render an expandable per-day audit trail of the charge.
  rentalBreakdown?:
    | {
        day: string;
        jobs: number | null;
        subtotal: number;
        capped: boolean;
      }[]
    | null;
  equipment: {
    id: string;
    shortDesc: string;
    brand: string | null;
    model: string | null;
    dailyRate: number | null;
    equivalentJobs?: number | null;
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
  jobId?: string | null;
  kind?: JobKind | null;
  title?: string | null;
  status: JobOccurrenceStatus;
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;
  frequencyDays?: number | null;
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
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  estimateAddress?: string | null;
  linkGroupId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  pausedAt?: string | null;
  totalPausedMs?: number | null;
  medianDurationMinutes?: number | null;
  startLat?: number | null;
  startLng?: number | null;
  completeLat?: number | null;
  completeLng?: number | null;
  /** Payroll-hours approval. Independent of payment status — a job can be
   *  CLOSED with hoursApprovedAt still null. The Gusto W-2 export excludes
   *  null rows. When the worker hits Complete, this is auto-set if actual
   *  time falls within the variance threshold (see jobs.ts
   *  evaluateHoursApproval); outside the threshold it stays null until an
   *  admin/super approves via the Approve Time button. */
  hoursApprovedAt?: string | null;
  hoursApprovedById?: string | null;
  /** Latest payment-rejection reason for this occurrence — surfaced on the
   *  PENDING_PAYMENT card so the claimer / admin can see why the most
   *  recent self-reported Payment was rejected. Cleared when a payment is
   *  approved (occurrence transitions to CLOSED). */
  lastPaymentRejectionReason?: string | null;
  lastPaymentRejectedAt?: string | null;
  /** Latest payment-revert reason. Set when admin reverts a previously-
   *  approved payment via the Services tab. Same display semantics as
   *  lastPaymentRejection*; cleared on the next approval. */
  lastPaymentRevertReason?: string | null;
  lastPaymentRevertedAt?: string | null;
  /** Set when the Request Payment path is committed (server-side
   *  auto-send in SERVER mode, or claimer tap in CLAIMER mode). Drives
   *  the "either-or" workflow on the job card — once set, Accept
   *  Payment is hidden and the worker either re-sends or cancels. */
  paymentRequestSentAt?: string | null;
  payment?: PaymentInfo | null;
  expenses?: ExpenseItem[];
  _count?: { photos: number; comments?: number };
  photos?: { id: string; url: string; contentType?: string | null }[];
  job?: {
    id: string;
    kind: JobKind;
    frequencyDays?: number | null;
    property: {
      id: string;
      displayName: string;
      street1: string;
      city: string;
      state: string;
      client?: { id: string; displayName: string; isVip?: boolean; vipReason?: string | null };
      pointOfContact?: { firstName: string; lastName: string; phone?: string | null; email?: string | null } | null;
    };
  } | null;
  assignees?: {
    userId: string;
    assignedById?: string | null;
    role?: string | null;
    user: { id: string; displayName?: string | null; email?: string | null; workerType?: WorkerType | null };
  }[];
  reminder?: { remindAt: string; note?: string | null } | null;
  _isReminderGhost?: boolean;
  _isPinnedGhost?: boolean;
  _ghostDate?: string;
  propertyPhotos?: { propertyPhoto: { id: string; r2Key: string; url?: string; fileName?: string | null; description?: string | null; sortOrder: number } }[];
  addons?: { id: string; tag?: string | null; customLabel?: string | null; price: number }[];
  instructions?: { id: string; text: string; isPreset: boolean; repeats: boolean; sortOrder: number }[];
  linkedOccurrenceId?: string | null;
  linkedOccurrence?: {
    id: string;
    startAt?: string | null;
    status: string;
    workflow?: string;
    jobType?: string | null;
    price?: number | null;
    job?: { id: string; property: { id: string; displayName: string; client?: { displayName?: string }; pointOfContact?: { firstName: string; lastName: string; phone?: string | null; email?: string | null } | null } } | null;
  } | null;
};

export type OccurrencePhoto = {
  id: string;
  fileName?: string | null;
  contentType?: string | null;
  uploadedBy?: { id: string; displayName?: string | null };
  createdAt: string;
  url: string;
};

export type PropertyPhotoItem = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};
