/**
 * WHICH LAYOUT IS ON SCREEN — not what anyone is allowed to do.
 *
 * This was called `Role`, which is the name of a concept that no longer
 * exists: the `Role` enum and the `UserRole` table are deleted, and
 * authorization is `scope.can(capability)`. The type survived the cutover
 * because the question it answers survived — "am I rendering the worker, the
 * admin or the shell?" — but keeping the old NAME on it invites exactly
 * the mistake the rename exists to prevent, the way `mustBeAssigned` once read
 * as a visibility rule and caused a client-visibility bug.
 *
 * The VALUES stay as they are: they are the three shells, they are persisted
 * in `topTab`, and they are matched against in ~26 places. Renaming them is a
 * separate change with a migration of stored state behind it.
 *
 * A surface never decides permission. `scope.can(capability)` does.
 */

/**
 * Every staff tab id. ONE union, because there is one staff tab list.
 *
 * This was three unions, one per shell — overlapping
 * heavily and named after roles — all three are DELETED. They were the
 * type-level half of the
 * duplicate-tab problem: three descriptions of one set of features, which
 * is what let three copies of each tab look legitimate. Derived from what
 * `index.tsx` actually renders, so it cannot drift from the tab list.
 */
export type StaffTabs =
  | "activity"
  | "portfolios"
  | "audit"
  | "clients"
  | "collections"
  | "compliance"
  | "displays"
  | "documents"
  | "equipment"
  | "forecast"
  | "groups"
  | "guides"
  | "history"
  | "home"
  | "jobs"
  | "ledger"
  | "notify"
  | "payments"
  | "payroll"
  | "pricing"
  | "profile"
  | "promotions"
  | "properties"
  | "reconcile"
  | "roles"
  | "routes"
  | "services"
  | "settings"
  | "supplies"
  | "tasks"
  | "timeline"
  | "tools-mowing"
  | "tools-mulch"
  | "users"
  | "vanity"
  | "vehicles"
  | "workdays";

// Client "Services" uses `client-services` (not just `services`) so
// BreadcrumbNav's cross-role chip logic (matches inner-tab values
// across shells) doesn't pair it with the staff Work "Services" tab.
// Those two tabs share the label but are unrelated: staff Work →
// Services is the operator's service-catalog / job-recipe manager;
// Client → Services is the client's list of services they subscribe
// to. Wrong-way cross-navigation between them was reported as
// confusing.
export type ClientTabs = "my-jobs" | "public" | "client-services" | "statements" | "client-promotions";

export type PreviewTabs = "routes";

export type EventTypes =
  | "clientTabToPropertiesTabSearch"
  | "propertyTabToClientTabSearch"
  | "propertyTabToClientTabContactSearch"
  | "activityTavToEquipmentTabQRCodeSearch"
  | "jobsTabToPropertiesTabSearch"
  | "jobsTabToClientsTabSearch"
  | "paymentsTabToPropertiesTabSearch"
  | "paymentsTabToClientsTabSearch"
  | "paymentsTabToJobsTabSearch"
  | "jobsTabToServicesTabSearch"
  | "servicesTabToJobsTabSearch"
  | "clientsTabToServicesTabSearch"
  | "areasTabToPropertiesTabSearch"
  | "remindersToJobsTabSearch"
  | "jobsToEquipmentKindFilter";

export type DialogMode = "CREATE" | "UPDATE";

/**
 * The worker-type vocabulary, RE-EXPORTED rather than restated.
 *
 * This list used to be declared here independently of the API's enum, which
 * is how the web kept offering a worker type after the API removed it.
 * `WorkerType`
 * now comes from @repo/money — the module that decides pay class owns the
 * vocabulary — so a change there is a compile error here instead of a
 * dropdown offering a value the server rejects.
 */
export type { WorkerType } from "@repo/money";
import type { WorkerType } from "@repo/money";
export const WORKER_TYPE = ["EMPLOYEE", "CONTRACTOR", "UNPAID"] as const satisfies readonly WorkerType[];

export type Me = {
  id: string;
  isApproved?: boolean;
  /** What this caller may DO — resolved server-side, suspended grants
   *  filtered out, and NARROWED by any active perspective. Replaced `roles`:
   *  the Role enum is gone. Drives UI gating through `Scope.can`, using the
   *  same can() the route guard uses. */
  capabilities?: string[];
  /** Perspectives they may look through, lowest access first. */
  perspectives?: Array<{ roleId: string; key: string | null; name: string; icon?: string | null; order: number }>;
  /** The active perspective, or null for "everything I hold". */
  activePerspectiveRoleId?: string | null;
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
  // Override columns: null means "follow workerType default"; true/false is explicit.
  // The per-person privilege overrides are GONE. An exception is a named
  // role now (G20), so it shows up in the role list rather than as a
  // tri-state tick on a profile nobody thinks to check.
  // Effective privileges after resolution (management always true).
  privileges?: {
    canPullInventory: boolean;
    canChargeBusinessExpenses: boolean;
  };
  // Payment-request delivery channel override. null = use org default.
  paymentCommsMode?: "SERVER" | "CLAIMER" | null;
  // "View as" support. realRoles / realWorkerType
  // are the unmodified DB values — present even when no impersonation is
  // active (in which case they mirror roles / workerType). The View-as
  // picker was gated on a role check so it stayed visible
  // even after Super swaps their effective role to Worker/Trainee/etc.
  realWorkerType?: WorkerType | null;
  isImpersonating?: boolean;
  // True when Super has an active client "View as" session — /api/me
  // overlays the response with client-shaped identity so every visibility
  // guard renders the client tabs. Frontend rarely reads this directly;
  // most code just consumes the flipped roles/workerType/isApproved. The
  // ImpersonationBanner reads it via getClientImpersonation() from
  // localStorage, not from here.
  isClientImpersonating?: boolean;
  /** This login is attached to a customer record. Holding no capability
   *  means two different things — a customer, or a staff account nobody
   *  has granted a role to yet — and this is what separates them. */
  isClientContact?: boolean;
  /**
   * The territories this person's access is confined to, or null/absent
   * when it is not confined. `mixed` means they also hold something
   * company-wide, so only some views are narrowed. Drives PortfolioScopeNotice.
   */
  portfolioScope?: {
    trails: string[][];
    /** The same chains, each with the ROLE held there. A grant is
     *  (person, role, portfolio); the notice names all three. */
    grants?: Array<{ id: string; trail: string[]; role: string }>;
    /** False when every capability the grant carries is also held
     *  company-wide — the holder leads it on paper and sees everything. */
    narrows?: boolean;
    /** The company-wide roles covering it, when `narrows` is false. */
    coveredBy?: string[];
    mixed: boolean;
  } | null;
};

export type TabPropsType = {
  me: Me | null;
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
  qrSlug: string | null;
  shortDesc: string | null;
  brand: string | null;
  model: string | null;
  energy: EquipmentEnergy | null;

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
  /** Repeating visits currently on hold across this client's services —
   *  STREAM_PAUSED occurrences. Drives the "N repeating services paused"
   *  hint + click-through on the Clients tab. Was `pausedJobsCount`,
   *  a count of Jobs in status PAUSED; that operation is gone (it was
   *  archiving under a second name), and a held repeating visit is what
   *  remains. Populated by the /clients read, which returns it only to
   *  callers whose capabilities include the paused-visit detail. */
  pausedRepeatingCount?: number;
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

// PAUSED is gone from JobStatus — pausing a job service deleted every
// scheduled visit and rebuilt the chain on resume, which is exactly what
// Archive does through the same helpers. Holding work is now a repeating
// pause on the occurrence (JobOccurrenceStatus.STREAM_PAUSED), which keeps
// the visit, records why, and resumes onto a date you choose. Don't add it
// back: the API enum no longer has the value, so a filter offering it would
// return nothing and a PATCH sending it would 400.
export const JOB_STATUS = ["PROPOSED", "ACCEPTED", "ARCHIVED"] as const;
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



/** A frozen weather reading. Mirrors WeatherSnapshot in
 *  apps/api/src/services/occurrenceWeather.ts. Every field is nullable
 *  because every field is optional upstream — a partial reading is worth
 *  keeping, a fabricated one is not. */
export type WeatherSnapshot = {
  tempF: number | null;
  feelsLikeF: number | null;
  description: string | null;
  icon: string | null;
  humidityPct: number | null;
  windMph: number | null;
  rainMmLastHour: number | null;
  capturedAt: string;
  source: string;
  /** "gps" = the worker's own phone when they pressed the button;
   *  "property" = the property's stored or geocoded point. */
  locatedBy: "gps" | "property";
  lat: number;
  lng: number;
};

export type JobOccurrenceAssigneeWithUser = {
  id: string;
  occurrenceId: string;
  userId: string;
  assignedById?: string | null;
  assignedAt?: string | null;
  role?: string | null;
  user: {
    id: string;
    displayName?: string | null;
    email?: string | null;
    /** Needed by TeamMemberList (G33): only a person on payroll may hold a
     *  paid seat. Absent reads as "unknown", which re-enables the control. */
    workerType?: WorkerType | null;
  };
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
  mustBeAssigned?: boolean;
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
  /** What the weather ACTUALLY WAS, frozen at start and at completion. A
   *  forecast can be re-fetched; this cannot — the forecast endpoints carry
   *  no history, so these are the only record. Null means it was not
   *  captured (offline start, provider outage, or a job predating the
   *  feature), never "the weather was nothing". */
  startWeather?: WeatherSnapshot | null;
  completeWeather?: WeatherSnapshot | null;
  linkGroupId?: string | null;
  assignees: JobOccurrenceAssigneeWithUser[];
  payment?: PaymentInfo | null;
  invoiceCharges?: InvoiceChargeItem[];
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
    /** How to get onto the property — gate codes, dogs, where to park. Held
     *  on the property, shown on every visit to it: the worker who knew is
     *  not always the one sent, and someone at a locked gate cannot go and
     *  look it up. */
    accessNotes?: string | null;
    client?: { id: string; displayName: string } | null;
  };
  kind: JobKind;
  status: JobStatus;
  frequencyDays?: number | null;
  nextOccurrence?: {
    id: string;
    startAt?: string | null;
    status: string;
    kind: string;
  } | null;
  assigneeCount: number;
  defaultAssignees?: { id: string; userId: string; role?: string | null; user?: { id: string; displayName?: string | null; email?: string | null } }[];
  occurrenceCount?: number;
  /** Rollup of this service's repeating streams. A job service is only a
   *  default — what matters is whether it actually has a live repeating
   *  stream, and how many are on hold. Since job-pause was removed,
   *  Job.status no longer tells you that. */
  repeatingSummary?: {
    total: number;
    active: number;
    paused: number;
    /** Distinct reason codes among the paused ones. `__UNCODED__` marks a
     *  stream paused before the reason taxonomy existed. */
    pausedReasonCodes: string[];
  };
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

// ---- Invoice charges ----
//
// A line on the CLIENT'S INVOICE — what they are billed on top of labor.
// NOT a business expense: adding one writes no ledger row and creates no
// deduction. Named `ExpenseItem` until 2026-09-06, which is exactly how the
// two books got conflated. See docs/features/job-materials.md.

export type InvoiceChargeItem = {
  id: string;
  occurrenceId?: string;
  /** What the CLIENT IS CHARGED for this line — not a cost. Goes on the
   *  invoice. See docs/features/job-materials.md. */
  cost: number;
  /** Optional CLIENT-VISIBLE detail, e.g. "25 bags at $6.00". */
  detail?: string | null;
  /** What we actually paid, when recorded. Informational: job margin only,
   *  never the invoice and never the payout. `money.view` on the client. */
  actualCost?: number | null;
  /** The loosely-linked ledger charge, when one is pointed at. Decorative. */
  businessExpenseId?: string | null;
  businessExpense?: {
    id?: string;
    cost?: number | null;
    description?: string | null;
    vendor?: string | null;
    date?: string | null;
  } | null;
  /** Set when this charge came from consuming inventory. Its amount and name
   *  are DERIVED from quantity x Supply.clientUnitPrice. */
  supplyHold?: {
    id: string;
    quantity: number;
    status: "ACTIVE" | "CONSUMED" | "RELEASED";
    supply?: { id: string; name: string; unit: string } | null;
  } | null;
  description: string;
  createdById: string;
  createdBy?: { id: string; displayName?: string | null };
  createdAt?: string;
};

// ---- Payments ----

// Payment methods are fully configuration-driven via the PAYMENT_METHODS
// setting (a JSON taxonomy editable in Settings). There is no fixed
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
  user: { id: string; displayName?: string | null; email?: string | null; workerType?: WorkerType | null };
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
    invoiceCharges?: InvoiceChargeItem[];
    // Promised-net snapshot taken at Take-Payment time. Each row is the
    // per-worker outcome the canonical math computed for the invoiced
    // amount, BEFORE the client pays. Used by the PaymentsTab card to
    // show employees their expected payout on pending approvals (they're
    // made whole; only contractors are contingent on the actual collected
    // amount). Null on legacy occurrences that pre-date the snapshot.
    promisedPayouts?: Array<{
      userId: string;
      workerType: WorkerType | null;
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
      user?: { id: string; displayName?: string | null; email?: string | null; workerType?: WorkerType | null } | null;
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
    /** Client-facing "SL-XXXXXXXX" identifier — see Payment.receiptNumber
     *  in the API schema. Present on every confirmed payment; the
     *  legacy shape had this as a derived value at PDF-render time, so
     *  older API code paths may still omit it (hence optional here). */
    receiptNumber?: string | null;
  };
  occurrence: {
    id: string;
    jobId: string;
    startAt?: string | null;
    invoiceCharges?: InvoiceChargeItem[];
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
    workerType?: WorkerType | null;
  };
};

export type WorkerOccurrence = {
  /** Free text the CUSTOMER sees — rides along on the invoice, the receipt
   *  and the job in their account. Distinct from any internal note: what is
   *  written here leaves the building. Per-occurrence, so it describes THIS
   *  visit only. */
  customerVisibleNotes?: string | null;
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
  mustBeAssigned?: boolean;
  proposalAmount?: number | null;
  proposalNotes?: string | null;
  rejectionReason?: string | null;
  generatedEstimate?: string | null;
  generatedEstimateBreakdown?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** The one-line form — derived from the parts below, and the only thing
   *  estimates created before those columns have. Rendered on cards and maps. */
  estimateAddress?: string | null;
  estimateStreet1?: string | null;
  estimateStreet2?: string | null;
  estimateCity?: string | null;
  estimateState?: string | null;
  estimatePostalCode?: string | null;
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
  /** What the weather ACTUALLY WAS, frozen at start and at completion. A
   *  forecast can be re-fetched; this cannot — the forecast endpoints carry
   *  no history, so these are the only record. Null means it was not
   *  captured (offline start, provider outage, or a job predating the
   *  feature), never "the weather was nothing". */
  startWeather?: WeatherSnapshot | null;
  completeWeather?: WeatherSnapshot | null;
  /** Payroll-hours approval. Independent of payment status — a job can be
   *  CLOSED with hoursApprovedAt still null. The Gusto W-2 export excludes
   *  null rows. When the worker hits Complete, this is auto-set if actual
   *  time falls within the variance threshold (see jobs.ts
   *  evaluateHoursApproval); outside the threshold it stays null until an
   *  management approves via the Approve Time button. */
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
  /** Reconciliation hint — the payment method key the client last
   *  TAPPED on the public /pay/[token] page (Venmo "Open" button or
   *  Zelle "Pay with" modal). NOT a payment claim; operator uses
   *  this to know where to look when reconciling actual payments.
   *  See JobOccurrence.paymentIntentMethod docstring. */
  paymentIntentMethod?: string | null;
  paymentIntentAt?: string | null;
  payment?: PaymentInfo | null;
  invoiceCharges?: InvoiceChargeItem[];
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
  /** Marks a "next occurrence hasn't been scheduled yet" ghost card.
   *  Present on repeating jobs whose most-recent occurrence hasn't
   *  reached CLOSED yet (so the next one hasn't been auto-generated).
   *  Renders as a distinct gray/hollow card at the wouldBeDate so the
   *  operator/worker sees they need to chase the blocking occurrence
   *  (usually to accept payment). Clicking the card opens the
   *  blocking occurrence, not the ghost. */
  _isNextOccurrenceGhost?: boolean;
  /** Blocking occurrence — the actual (real, DB-persisted) occurrence
   *  that's holding up creation of the next one. Present only on ghost
   *  cards. */
  _blockingOccurrenceId?: string;
  _blockingOccurrenceStatus?: JobOccurrenceStatus;
  _ghostDate?: string;
  propertyPhotos?: { propertyPhoto: { id: string; r2Key: string; url?: string; fileName?: string | null; description?: string | null; sortOrder: number } }[];
  /** `detail` is the optional client-visible note captured when the service
   *  was added ("5 bushes at $25.00 each"). It was persisted from day one
   *  but omitted from every server select, so it reached no surface at all. */
  addons?: { id: string; tag?: string | null; customLabel?: string | null; price: number; detail?: string | null }[];
  instructions?: {
    id: string; text: string; isPreset: boolean;
    scope: "THIS_VISIT" | "EVERY_VISIT" | "NEXT_VISIT_ONLY";
    sortOrder: number;
    /** Set once a NEXT_VISIT_ONLY instruction has been handed to a later
     *  visit. The row stays put as the record that it was asked for here. */
    deliveredAt?: string | null;
    deliveredToOccurrenceId?: string | null;
  }[];
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
  /** Held back from OUTWARD-FACING surfaces — wall displays and the public
   *  activity feed. Never affects the owning client: their portal and their
   *  invoice show every photo of their own property. */
  hiddenFromDisplay?: boolean;
};

export type PropertyPhotoItem = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};
