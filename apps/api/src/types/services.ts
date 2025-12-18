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
    userId: string
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
};

export type ServicesUsers = {
  list(params?: {
    approved?: boolean;
    role?: Role;
  }): Promise<(User & { roles: UserRole[] })[]>;
  // Reserved + checked-out items (flat list used by AdminUsers UI)
  listHoldings(): Promise<AdminUserHolding[]>;

  approve(clerkUserId: string, userId: string): Promise<User>;
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
  approve(currentUserId: string, id: string): Promise<{ updated: true }>;
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
    "id" | "startAt" | "windowStart" | "status" | "kind"
  > | null;
  assigneeCount: number;
};

export type JobUpsert = Pick<Job, "propertyId" | "kind" | "status"> & {
  id?: string;
  // optional: allow attaching clients/contacts later
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
  windowStart?: string | Date | null;
  windowEnd?: string | Date | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  notes?: string | null;

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
  }): Promise<JobListItem[]>;

  get(id: string): Promise<
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
      status?: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELED";
      windowStart?: string | Date | null;
      windowEnd?: string | Date | null;
      startAt?: string | Date | null;
      endAt?: string | Date | null;
      notes?: string | null;
    }
  ): Promise<JobOccurrence>;

  // assignment at the occurrence level (workers only)
  setOccurrenceAssignees(
    currentUserId: string,
    occurrenceId: string,
    input: AssignOccurrenceInput
  ): Promise<{ updated: true }>;
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
};
