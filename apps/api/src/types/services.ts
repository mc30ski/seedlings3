import type {
  Equipment,
  AuditEvent,
  User,
  UserRole,
  Client,
  ClientContact,
  ClientStatus,
  Property,
  PropertyKind,
  PropertyStatus,
  Job,
  JobKind,
  JobStatus,
  JobSchedule,
  Cadence,
  JobOccurrence,
  JobOccurrenceStatus,
  JobOccurrenceSource,
  JobOccurrenceAssignee,
} from "@prisma/client";
import { AuditTuple } from "../lib/auditActions";

export type ClientWithContacts = Client & { contacts: ClientContact[] };

export type ClientListItem = Client & {
  contactCount: number;
  propertyCount: number;
  // full contacts list (UI filters as needed)
  contacts: Array<
    Pick<
      ClientContact,
      | "id"
      | "status"
      | "firstName"
      | "lastName"
      | "role"
      | "email"
      | "phone"
      | "normalizedPhone"
      | "isPrimary"
    >
  >;
  // small properties preview
  properties?: Array<
    Pick<Property, "id" | "displayName" | "city" | "state" | "status">
  >;
  // convenience field
  primaryContact?: Pick<
    ClientContact,
    | "id"
    | "status"
    | "firstName"
    | "lastName"
    | "role"
    | "email"
    | "phone"
    | "normalizedPhone"
    | "isPrimary"
  > | null;
};

export type ClientUpsert = Pick<
  Client,
  "type" | "displayName" | "status" | "notesInternal"
> & {
  id?: string;
};

export type ContactUpsert = Pick<
  ClientContact,
  "status" | "firstName" | "lastName" | "email" | "phone" | "role" | "isPrimary"
> & { id?: string };

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
  // Group rentals: when set, the checkout was made on behalf of the group.
  // The userId is the group's claimer; UI displays as "Alpha Crew (Alice)".
  groupId?: string | null;
  groupName?: string | null;
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

export type AdminActivityEvent = {
  equipmentName?: string;
  qrSlug?: string;
  brand?: string;
  model?: string;
  type?: string;
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

export type PropertyUpsert = Pick<
  Property,
  | "clientId"
  | "kind"
  | "status"
  | "displayName"
  | "street1"
  | "street2"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "accessNotes"
  | "pointOfContactId"
  | "lotSize"
  | "lotSizeUnit"
> & { id?: string };

export type PropertyListItemParams = {
  q?: string;
  clientId?: string;
  status?: PropertyStatus | "ALL";
  kind?: PropertyKind | "ALL";
  limit?: number;
};

export type PropertyListItem = Property & {
  client?: { id: string; displayName: string | null } | null;
  primaryContact?: Pick<
    ClientContact,
    "id" | "firstName" | "lastName" | "email" | "phone"
  > | null;
};

export type ServicesEquipment = {
  listAvailable(): Promise<Equipment[]>;
  listAllAdmin(): Promise<EquipmentWithHolder[]>;
  listForWorkers(): Promise<Equipment[]>; // includes MAINTENANCE/RESERVED/CHECKED_OUT
  listUnavailableForWorkers(): Promise<Equipment[]>; // cannot reserve RESERVED/CHECKED_OUT/MAINTENANCE/RETIRED
  listMine(userId: string): Promise<Equipment[]>; // items I currently hold (reserved or checked out)
  listUnavailableWithHolder(): Promise<EquipmentWithHolder[]>;

  create(
    currentUserId: string,
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
      dailyRate?: number | null;
      equivalentJobs?: number | null;
      requiresInsurance?: boolean;
    }
  ): Promise<Equipment>;

  update(
    currentUserId: string,
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
        | "dailyRate"
        | "equivalentJobs"
        | "requiresInsurance"
      >
    >
  ): Promise<Equipment>;

  // Blocked if status is RESERVED or CHECKED_OUT (or any active row exists)
  retire(currentUserId: string, id: string): Promise<Equipment>;
  unretire(currentUserId: string, id: string): Promise<Equipment>;
  hardDelete(currentUserId: string, id: string): Promise<{ deleted: true }>;

  release(currentUserId: string, id: string): Promise<ReleaseResult>; // Force release (from RESERVED or CHECKED_OUT)

  // Worker lifecycle (RESERVE → CHECKOUT → RETURN)
  reserve(
    currentUserId: string,
    id: string,
    userId: string,
    opts?: { groupId?: string | null }
  ): Promise<ReserveResult>;
  cancelReservation(
    currentUserId: string,
    id: string,
    userId: string
  ): Promise<CancelResult>;
  checkoutWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string
  ): Promise<CheckoutResult>;
  returnWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string
  ): Promise<ReleaseResult>;

  maintenanceStart(currentUserId: string, id: string): Promise<Equipment>;
  maintenanceEnd(currentUserId: string, id: string): Promise<Equipment>;

  // `cutoff` is the Business Start Date filter — pre-cutoff Checkouts (by
  // releasedAt) are excluded. Pass null/undefined for no filter. See
  // lib/businessStartCutoff.ts.
  listEquipmentCharges(params?: { userId?: string; from?: string; to?: string; cutoff?: Date | null }): Promise<any[]>;
  // Usage view respects the BSD cutoff just like other money-adjacent views —
  // pre-cutoff checkouts are hidden so the operator's "fresh slate" view of
  // the books is consistent across surfaces. Anchored on checkedOutAt (the
  // usage event) rather than releasedAt, so active (releasedAt=null) checkouts
  // post-cutoff still appear. Super reveal flips cutoff to null upstream.
  listUsage(params?: { from?: string; to?: string; userId?: string; cutoff?: Date | null }): Promise<any[]>;
};

export type ServicesUsers = {
  list(params?: {
    approved?: boolean;
    role?: Role;
  }): Promise<(User & { roles: UserRole[] })[]>;
  // Reserved + checked-out items (flat list used by AdminUsers UI)
  listHoldings(): Promise<AdminUserHolding[]>;

  approve(
    clerkUserId: string,
    userId: string,
    opts?: { linkContactId?: string | null },
  ): Promise<User>;
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
  ): Promise<{ deleted: true; clerkDeleted: boolean; contactsUnlinked: number }>;

  pendingApprovalCount(): Promise<{ pending: number }>;

  me(token: string, impersonateHeader?: string | string[] | null): Promise<{
    id: string;
    isApproved: boolean;
    roles: Role[];
    email?: string | null;
    displayName?: string | null;
    workerType?: string | null;
    hasInsuranceCert?: boolean;
    isInsuranceValid?: boolean;
    insuranceExpiresAt?: string | null;
    contractorAgreedAt?: string | null;
    w9Collected?: boolean;
    // Super-only impersonation echo fields — always present so the UI can
    // unconditionally check realRoles to decide whether to render the View-as
    // menu. When impersonation isn't active they mirror the regular fields.
    realRoles?: Role[];
    realWorkerType?: string | null;
    isImpersonating?: boolean;
  }>;

  setWorkerType(currentUserId: string, userId: string, workerType: string | null): Promise<User>;
  setIsOwner(currentUserId: string, userId: string, isOwner: boolean): Promise<User>;
  updateInsuranceCert(userId: string, r2Key: string, fileName: string | null, contentType: string | null, expiresAt: string): Promise<User>;
  recordContractorAgreement(userId: string): Promise<User>;
  setW9Collected(currentUserId: string, userId: string, collected: boolean): Promise<User>;
  setPrivilegeOverrides(
    currentUserId: string,
    userId: string,
    overrides: {
      canPullInventory?: boolean | null;
      canChargeBusinessExpenses?: boolean | null;
    },
  ): Promise<User>;
};

export type ServicesClients = {
  list(params?: {
    q?: string;
    status?: ClientStatus | "ALL";
    limit?: number;
  }): Promise<ClientListItem[]>;
  get(id: string): Promise<ClientWithContacts>;
  create(currentUserId: string, payload: ClientUpsert): Promise<Client | null>;
  update(
    currentUserId: string,
    id: string,
    payload: ClientUpsert
  ): Promise<Client | null>;
  pause(currentUserId: string, id: string): Promise<Client | null>;
  unpause(currentUserId: string, id: string): Promise<Client | null>;
  archive(currentUserId: string, id: string): Promise<Client | null>;
  unarchive(currentUserId: string, id: string): Promise<Client | null>;
  delete(currentUserId: string, id: string): Promise<{ deleted: true }>;

  //////////

  addContact(
    currentUserId: string,
    clientId: string,
    payload: ContactUpsert
  ): Promise<ClientContact | null>;
  updateContact(
    currentUserId: string,
    id: string,
    contactId: string,
    payload: ContactUpsert
  ): Promise<ClientContact | null>;
  pauseContact(
    currentUserId: string,
    id: string
  ): Promise<ClientContact | null>;
  unpauseContact(
    currentUserId: string,
    id: string
  ): Promise<ClientContact | null>;
  archiveContact(
    currentUserId: string,
    id: string
  ): Promise<ClientContact | null>;
  unarchiveContact(
    currentUserId: string,
    id: string
  ): Promise<ClientContact | null>;
  deleteContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ): Promise<{ deleted: true }>;
  setPrimaryContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ): Promise<{ primarySet: true }>;
};

export type ServicesCurrentUser = {
  me(clerkUserId: string): Promise<{
    id: string;
    isApproved: boolean;
    roles: Role[];
    email?: string | null;
    displayName?: string | null;
  }>;
};

export type ServicesActivity = {
  listUserActivity(): Promise<AdminActivityUser[]>;
};

export type ServicesAudit = {
  list(params: {
    actorUserId?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
    // Business Start Date filter — see lib/businessStartCutoff.ts.
    cutoff?: Date | null;
  }): Promise<{ items: AuditEvent[]; total: number }>;
};

export type ServicesProperties = {
  list(params?: PropertyListItemParams): Promise<PropertyListItem[]>;
  get(id: string): Promise<Property>;

  create(actorId: string, payload: PropertyUpsert): Promise<Property>;
  update(
    currentUserId: string,
    id: string,
    payload: PropertyUpsert
  ): Promise<Property>;
  archive(currentUserId: string, id: string): Promise<{ archived: true }>;
  unarchive(currentUserId: string, id: string): Promise<{ unarchived: true }>;
  hardDelete(currentUserId: string, id: string): Promise<{ deleted: true }>;

  setPrimaryContact(
    currentUserId: string,
    id: string,
    contactId: string | null
  ): Promise<{ primarySet: true }>;
};

/////////

export type JobListItem = Job & {
  property: Pick<Property, "id" | "displayName" | "city" | "state" | "status">;
  schedule?: JobSchedule | null;
  nextOccurrence?: Pick<
    JobOccurrence,
    "id" | "startAt" | "status" | "kind"
  > | null;
  assigneeCount: number;
};

export type JobUpsert = Pick<Job, "propertyId" | "kind" | "status"> & {
  id?: string;
  notes?: string | null;
  defaultPrice?: number | null;
};

export type JobScheduleUpsert = {
  autoRenew: boolean;
  cadence?: Cadence | null;
  interval?: number | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  preferredStartHour?: number | null;
  preferredEndHour?: number | null;
  horizonDays?: number | null;
  active?: boolean | null;
};

export type CreateOccurrenceInput = {
  // one-off or manual scheduling
  kind?: JobKind;
  name?: string | null;
  title?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  notes?: string | null;
  price?: number | null;
  estimatedMinutes?: number | null;

  workflow?: string;
  isOneOff?: boolean;
  isTentative?: boolean;
  isEstimate?: boolean;
  isAdminOnly?: boolean;
  jobType?: string | null;
  jobTags?: string | null;
  pinnedNote?: string | null;
  pinnedNoteRepeats?: boolean;
  frequencyDays?: number | null;

  // optional assignees at creation time
  assigneeUserIds?: string[];
};

export type AssignOccurrenceInput = {
  assigneeUserIds: string[]; // final desired set (replace semantics)
  assignedById?: string | null; // if you want audit attribution
};

export type ServicesJobs = {
  list(params?: {
    q?: string;
    propertyId?: string;
    status?: JobStatus | "ALL";
    kind?: JobKind | "ALL";
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<JobListItem[]>;

  listAllOccurrences(params?: { from?: string; to?: string; cutoff?: Date | null }): Promise<any[]>;
  getOccurrencesByIds(ids: string[], cutoff?: Date | null): Promise<any[]>;
  listMyOccurrences(userId: string, options?: { isAdmin?: boolean }): Promise<any[]>;
  listAvailableOccurrences(): Promise<any[]>;
  claimOccurrence(
    currentUserId: string,
    occurrenceId: string,
    opts?: { groupId?: string | null },
  ): Promise<{ claimed: true }>;
  updateOccurrenceStatus(
    currentUserId: string,
    occurrenceId: string,
    status: JobOccurrenceStatus,
    notes?: string,
    location?: { lat: number; lng: number },
    timestamps?: { startedAt?: string; completedAt?: string; totalPausedMs?: number },
    extras?: { completionSplits?: Array<{ userId: string; percent: number }> }
  ): Promise<JobOccurrence>;

  get(id: string, cutoff?: Date | null): Promise<
    Job & {
      property: Property;
      schedule?: JobSchedule | null;
      occurrences: JobOccurrence[];
      defaultAssignees: (JobOccurrenceAssignee | any)[]; // or define a better type for JobAssigneeDefault
    }
  >;

  create(currentUserId: string, payload: JobUpsert): Promise<Job>;
  update(currentUserId: string, id: string, payload: JobUpsert): Promise<Job>;

  // schedule acts like “calendar rules” for generating occurrences
  upsertSchedule(
    currentUserId: string,
    jobId: string,
    patch: JobScheduleUpsert
  ): Promise<JobSchedule>;
  generateOccurrences(
    currentUserId: string,
    jobId: string
  ): Promise<{ generated: number }>;

  // “create a one-off from the job” (manual instance, can act like template usage)
  createOccurrence(
    currentUserId: string,
    jobId: string,
    input: CreateOccurrenceInput
  ): Promise<JobOccurrence>;

  updateOccurrence(
    currentUserId: string,
    occurrenceId: string,
    patch: {
      kind?: "ENTIRE_SITE" | "SINGLE_ADDRESS";
      status?: string;
      name?: string | null;
      startAt?: string | Date | null;
      endAt?: string | Date | null;
      notes?: string | null;
      price?: number | null;
      isTentative?: boolean;
      isEstimate?: boolean;
      isAdminOnly?: boolean;
      paymentRevertReason?: string | null;
    },
    options?: { isAdmin?: boolean }
  ): Promise<JobOccurrence>;

  addOccurrenceAssignee(
    currentUserId: string,
    occurrenceId: string,
    targetUserId: string,
    role?: string | null
  ): Promise<{ added: true } | { added: false; reason: string }>;

  removeOccurrenceAssignee(
    currentUserId: string,
    occurrenceId: string,
    targetUserId: string
  ): Promise<{ removed: true }>;

  adminAddOccurrenceAssignee(
    adminUserId: string,
    occurrenceId: string,
    targetUserId: string,
    role?: string | null
  ): Promise<{ added: true } | { added: false; reason: string }>;

  createTask(
    currentUserId: string,
    input: { title: string; notes?: string; startAt: string; linkedOccurrenceId?: string }
  ): Promise<JobOccurrence>;

  adminRemoveOccurrenceAssignee(
    adminUserId: string,
    occurrenceId: string,
    targetUserId: string
  ): Promise<{ removed: true }>;

  unclaimOccurrence(
    currentUserId: string,
    occurrenceId: string
  ): Promise<{ unclaimed: true }>;

  archiveJob(currentUserId: string, jobId: string): Promise<Job>;
  archiveOccurrence(currentUserId: string, occurrenceId: string): Promise<JobOccurrence>;
  listArchivedJobs(params?: { page?: number; pageSize?: number }): Promise<{
    items: JobListItem[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  createEvent(
    adminUserId: string,
    input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null }
  ): Promise<JobOccurrence>;
  completeEvent(adminUserId: string, occurrenceId: string): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  createFollowup(
    adminUserId: string,
    input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null; clientIds?: string[]; jobIds?: string[] }
  ): Promise<JobOccurrence>;
  completeFollowup(adminUserId: string, occurrenceId: string): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  createAnnouncement(
    adminUserId: string,
    input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null }
  ): Promise<JobOccurrence>;
  completeAnnouncement(adminUserId: string, occurrenceId: string): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  deleteJob(jobId: string): Promise<{ deleted: true }>;
  deleteOccurrence(occurrenceId: string): Promise<{ deleted: true }>;

  // assignment at the occurrence level (workers only)
  setOccurrenceAssignees(
    currentUserId: string,
    occurrenceId: string,
    input: AssignOccurrenceInput
  ): Promise<{ updated: true }>;

  // Admin-only: move ownership of an occurrence to another worker.
  reassignClaimer(
    adminUserId: string,
    occurrenceId: string,
    newClaimerUserId: string
  ): Promise<any>;

  // Admin-only: change a specific assignee's role on an occurrence.
  // `newRole` of null clears the role override.
  changeAssigneeRole(
    adminUserId: string,
    occurrenceId: string,
    targetUserId: string,
    newRole: string | null
  ): Promise<any>;

  // Admin-only: lightweight estimate creation from the dispatch flow.
  createLightEstimate(
    adminUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      contactName?: string;
      contactPhone?: string;
      contactEmail?: string;
      estimateAddress?: string;
      proposalAmount?: number;
      proposalNotes?: string;
      jobTags?: string;
      jobType?: string;
      assigneeUserIds?: string[];
      jobId?: string;
    }
  ): Promise<JobOccurrence>;

  // Worker/admin: standalone reminder (no parent job/occurrence).
  createStandaloneReminder(
    currentUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      linkedOccurrenceId?: string;
      isHighPriority?: boolean;
    }
  ): Promise<JobOccurrence>;
};

export type ServicesPayments = {
  createPayment(
    currentUserId: string,
    input: {
      occurrenceId: string;
      amountPaid: number;
      method: string;
      note?: string | null;
      // Optional processor fee — set by admin paths when the payment
      // method has a known fee (Venmo/Zelle/card). Computed and
      // persisted on the resulting Payment row so the income/expense
      // exports tie out.
      processorFeeAmount?: number | null;
      // Worker percentages set by the claimer in the Take Payment dialog.
      // Server persists these to JobOccurrence.completionSplits and re-
      // snapshots promisedPayouts before creating the Payment row.
      completionSplits: Array<{ userId: string; percent: number }>;
    }
  ): Promise<any>;

  listMyPayments(
    userId: string,
    // `cutoff` is the Business Start Date filter — pre-cutoff payments are
    // excluded. Pass null (or omit) for no filter. See
    // lib/businessStartCutoff.ts.
    params?: { from?: string; to?: string; cutoff?: Date | null }
  ): Promise<{ items: any[]; totalAmount: number }>;

  listAllPayments(params?: {
    from?: string;
    to?: string;
    userId?: string;
    method?: string;
    cutoff?: Date | null;
  }): Promise<{
    items: any[];
    personTotals: Array<{ userId: string; displayName: string | null; total: number }>;
  }>;

  getPaymentByOccurrence(occurrenceId: string): Promise<any | null>;

  updatePayment(
    currentUserId: string,
    paymentId: string,
    input: {
      amountPaid?: number;
      method?: string;
      note?: string | null;
      splits?: Array<{ userId: string; amount: number }>;
    }
  ): Promise<any>;

  deletePayment(
    currentUserId: string,
    paymentId: string
  ): Promise<void>;

  recalculateSplits(occurrenceId: string): Promise<any>;
  forceCreateNextOccurrence(currentUserId: string, occurrenceId: string): Promise<any>;
  adminMarkInvoicePaid(
    currentUserId: string,
    occurrenceId: string,
    input: {
      amountPaid: number;
      method: string;
      note?: string | null;
      processorFeeAmount?: number | null;
    },
  ): Promise<any>;

  /**
   * Client-or-worker self-reported payment. Creates an unconfirmed Payment
   * row attached to the occurrence; occurrence stays in PENDING_PAYMENT
   * until an admin/super approves. Splits are not materialized here —
   * they're computed at approval time from JobOccurrence.completionSplits.
   */
  selfReportPayment(
    actorUserId: string | null,
    input: { occurrenceId: string; method: string; amountPaid: number; note?: string | null },
  ): Promise<any>;

  /**
   * Admin/super flips an existing self-reported Payment to confirmed=true.
   * Optionally adjusts amount/method (e.g., "client said $150 Zelle but I
   * see $140"). Materializes splits using completionSplits + final amount.
   * Closes the occurrence and runs the next-occurrence creation logic.
   */
  approvePayment(
    currentUserId: string,
    paymentId: string,
    overrides?: { amountPaid?: number; method?: string; note?: string | null; processorFeeAmount?: number },
  ): Promise<any>;

  /**
   * Admin/super deletes a pending self-reported Payment. Occurrence stays
   * PENDING_PAYMENT so the client can be re-prompted or admin can record
   * directly later.
   */
  rejectPayment(
    currentUserId: string,
    paymentId: string,
    reason?: string | null,
  ): Promise<void>;

  /**
   * Admin/super closes the books on a payment that will never be collected
   * (client refused, check bounced, etc.). Approves with collected=0;
   * employees+trainees get their promised net topped up from business funds,
   * contractors get $0, and Payment.shortfallAmount captures the absorbed
   * loss.
   */
  writeOffPayment(
    currentUserId: string,
    paymentId: string,
    reason?: string | null,
  ): Promise<any>;

  /**
   * Super-only "pretend this service never happened" — every money query,
   * export, dashboard aggregate, and 1099 total filters `skippedAt: null`
   * to exclude the payment. Under the hood runs the standard approval
   * path with collected=0 (so occurrence closes + next-occurrence
   * generation fires) then stamps `skippedAt`. See services/payments.ts
   * for the full rationale; gated by superGuard + type-APPROVE at the UI.
   */
  skipPayment(
    currentUserId: string,
    paymentId: string,
    reason?: string | null,
  ): Promise<any>;

  /** Occurrence-level Skip for surfaces without a Payment row yet
   *  (Outstanding Requests). Materializes a $0/CASH Payment first, then
   *  delegates to skipPayment. If a Payment already exists, delegates
   *  directly without materialization. */
  skipOccurrence(
    currentUserId: string,
    occurrenceId: string,
    reason?: string | null,
  ): Promise<any>;

  /** Reverse a skip. Clears skippedAt so the payment reappears in
   *  every aggregate. Same Super + type-APPROVE gate as skip. */
  unskipPayment(currentUserId: string, paymentId: string): Promise<any>;

  listPendingApprovals(cutoff?: Date | null): Promise<any[]>;
};

export type ExpenseInput = {
  cost: number;
  description: string;
  // Tax-ledger fields — populated on the linked BusinessExpense row.
  category?: string | null;     // Schedule C label, defaults to "Supplies"
  vendor?: string | null;
  date?: string | null;          // ISO date; defaults to today
};

export type ExpensePatchInput = {
  cost?: number;
  description?: string;
  category?: string | null;
  vendor?: string | null;
  date?: string | null;
};

export type ServicesExpenses = {
  addExpense(
    currentUserId: string,
    occurrenceId: string,
    input: ExpenseInput
  ): Promise<any>;

  updateExpense(
    currentUserId: string,
    expenseId: string,
    input: ExpensePatchInput
  ): Promise<any>;

  deleteExpense(
    currentUserId: string,
    expenseId: string
  ): Promise<{ deleted: true }>;

  adminAddExpense(
    currentUserId: string,
    occurrenceId: string,
    input: ExpenseInput
  ): Promise<any>;

  adminDeleteExpense(
    expenseId: string
  ): Promise<{ deleted: true }>;

  listExpensesByOccurrence(occurrenceId: string): Promise<any[]>;
};

export type SupplyCreateInput = {
  name: string;
  description?: string | null;
  unit: string;
  upc?: string | null;
  category?: string | null;
  businessCost?: number | null;
  jobPayoutCost: number;
};

export type SupplyPatchInput = {
  name?: string;
  description?: string | null;
  unit?: string;
  upc?: string | null;
  category?: string | null;
  businessCost?: number | null;
  jobPayoutCost?: number;
};

export type SupplyPurchaseInput = {
  quantity: number;
  // Total actually paid for the whole purchase, incl. tax and discounts —
  // the receipt/bank-statement figure. Per-unit cost is derived from this.
  totalCost: number;
  date?: string | null;
  vendor?: string | null;
  invoiceNumber?: string | null;
  notes?: string | null;
};

export type SupplyAdjustmentInput = {
  delta: number;
  reason: string;
};

export type SupplyHoldInput = {
  supplyId: string;
  quantity: number;
};

export type ServicesSupplies = {
  list(opts?: { includeArchived?: boolean; q?: string; includeHoldDetails?: boolean }): Promise<any[]>;
  getById(id: string): Promise<any | null>;
  create(currentUserId: string, input: SupplyCreateInput): Promise<any>;
  update(currentUserId: string, id: string, input: SupplyPatchInput): Promise<any>;
  archive(currentUserId: string, id: string): Promise<{ archived: true }>;
  unarchive(currentUserId: string, id: string): Promise<{ archived: false }>;

  recordPurchase(currentUserId: string, supplyId: string, input: SupplyPurchaseInput): Promise<any>;
  reversePurchase(currentUserId: string, purchaseId: string): Promise<{ reversed: true }>;

  recordAdjustment(currentUserId: string, supplyId: string, input: SupplyAdjustmentInput): Promise<any>;

  // `cutoff` is the Business Start Date filter — pre-cutoff SupplyPurchase
  // rows hidden. Holds and adjustments pass through (they're operational,
  // not money). See lib/businessStartCutoff.ts.
  listHistory(supplyId: string, opts?: { cutoff?: Date | null }): Promise<any[]>;

  // Add a hold (consumption reservation) on an occurrence — creates a paired
  // job-level Expense for payout deduction. Workers (claimers) and admins can
  // call this; the route layer enforces.
  addHold(currentUserId: string, occurrenceId: string, input: SupplyHoldInput): Promise<any>;
  removeHold(currentUserId: string, holdId: string): Promise<{ removed: true }>;
  adjustHold(currentUserId: string, holdId: string, newQuantity: number): Promise<any>;

  // Lifecycle: invoked by jobs service when an occurrence transitions.
  consumeHoldsForOccurrence(occurrenceId: string): Promise<{ consumed: number }>;
  releaseHoldsForOccurrence(occurrenceId: string): Promise<{ released: number }>;
  reactivateHoldsForOccurrence(occurrenceId: string): Promise<{ reactivated: number }>;
};

export type Services = {
  equipment: ServicesEquipment;
  users: ServicesUsers;
  currentUser: ServicesCurrentUser;
  activity: ServicesActivity;
  audit: ServicesAudit;
  clients: ServicesClients;
  properties: ServicesProperties;
  jobs: ServicesJobs;
  payments: ServicesPayments;
  expenses: ServicesExpenses;
  settings: ServicesSettings;
  supplies: ServicesSupplies;
  groups: typeof import("../services/groups").groups;
  companyDocuments: typeof import("../services/companyDocuments").companyDocuments;
  timelineEvents: typeof import("../services/timelineEvents").timelineEvents;
  banners: typeof import("../services/banners").banners;
  paymentRequests: typeof import("../services/paymentRequests").paymentRequests;
};

export type ServicesSettings = {
  getAll(): Promise<any[]>;
  get(key: string): Promise<{ key: string; value: string } | null>;
  getValue(key: string, fallback: string): Promise<string>;
  set(actorUserId: string, key: string, value: string): Promise<any>;
};
