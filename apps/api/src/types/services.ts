import type { CallerCan } from "../lib/callerCan";
import type {
  Equipment,
  AuditEvent,
  User,
  Client,
  ClientContact,
  ClientStatus,
  Property,
  PropertyKind,
  PropertyStatus,
  Job,
  JobKind,
  JobStatus,
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

/** Derived from the Prisma enum, never hand-listed.
 *
 *  A hand-maintained copy of this union went stale the moment a new value
 *  was added to the schema, breaking `tsc` in the route layer while the
 *  build gate stayed green — the gate runs vitest and never typechecks.
 *  Aliasing the generated type means a new enum value cannot reintroduce
 *  that gap. */
// There is no role enum. What someone may do comes from the capabilities
// their roles grant — see @repo/permissions.

type ReserveResult = { id: string; userId: string };
type CheckoutResult = { id: string; userId: string };
type ReleaseResult = { released: true };
type CancelResult = { cancelled: true };

export type EquipmentHolder = {
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

export type UserHolding = {
  userId: string;
  equipmentId: string;
  shortDesc: string;
  qrSlug: string;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: Date;
  checkedOutAt: Date | null;
};

export type EquipmentWithHolder = Equipment & { holder: EquipmentHolder | null };

export type DirectoryActivityEvent = {
  equipmentName?: string;
  qrSlug?: string;
  brand?: string;
  model?: string;
  type?: string;
  role?: string;
};

export type DirectoryActivityUser = {
  userId: string;
  displayName?: string;
  email?: string;
  lastActivityAt: Date | null;
  count: number;
  events: DirectoryActivityEvent[];
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
> & {
  id?: string;
  /** Which portfolios this property belongs to. Omitted means "inherit
   *  from this client's other properties when they all agree, otherwise
   *  leave it in none" — see `properties.create`. Belonging to none is
   *  legal; the consequence is that its work counts toward no rollup. */
  portfolioIds?: string[];
};

export type PropertyListItemParams = {
  q?: string;
  clientId?: string;
  status?: PropertyStatus | "ALL";
  kind?: PropertyKind | "ALL";
  limit?: number;
  /** Territory filter from `portfolioWhere(principal, "clients.view")`, computed
   *  at the route because only the route has the principal. `{}` means the
   *  caller holds the capability company-wide. */
  portfolioWhere?: Record<string, unknown>;
  /** Narrow to properties this user is on the work for — set by the route
   *  for a caller who is not field-cleared and cannot manage clients. The
   *  same rule PropertiesTab was applying in the browser, moved to where
   *  it actually withholds the rows. */
  assignedToUserId?: string;
  /**
   * Show one portfolio's properties — the SUBTREE, so picking a district
   * includes its routes and the list agrees with the count beside it on
   * the Portfolios tab.
   *
   * A VIEW filter, not a permission: it is ANDed with `portfolioWhere` above, so
   * it can only ever subtract from what the caller may already see.
   * `"none"` asks for the properties in NO portfolio, which is the one question
   * the portfolio tree cannot answer about itself.
   */
  portfolioSubtreePath?: string | "none";
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
  listAllUnscoped(): Promise<EquipmentWithHolder[]>;
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
      requiredPolicyIds?: string[];
    },
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
        | "requiredPolicyIds"
      >
    >,
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
    opts?: { groupId?: string | null },
  ): Promise<ReserveResult>;
  cancelReservation(
    currentUserId: string,
    id: string,
    userId: string,
  ): Promise<CancelResult>;
  checkoutWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string,
  ): Promise<CheckoutResult>;
  returnWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string,
  ): Promise<ReleaseResult>;

  maintenanceStart(currentUserId: string, id: string): Promise<Equipment>;
  maintenanceEnd(currentUserId: string, id: string): Promise<Equipment>;

  // `cutoff` is the Business Start Date filter — pre-cutoff Checkouts (by
  // releasedAt) are excluded. Pass null/undefined for no filter. See
  // lib/businessStartCutoff.ts.
  listEquipmentCharges(params?: {
    userId?: string;
    from?: string;
    to?: string;
    cutoff?: Date | null;
  }): Promise<any[]>;
  // Usage view respects the BSD cutoff just like other money-adjacent views —
  // pre-cutoff checkouts are hidden so the operator's "fresh slate" view of
  // the books is consistent across surfaces. Anchored on checkedOutAt (the
  // usage event) rather than releasedAt, so active (releasedAt=null) checkouts
  // post-cutoff still appear. the reveal flips cutoff to null upstream.
  listUsage(params?: {
    from?: string;
    to?: string;
    userId?: string;
    cutoff?: Date | null;
  }): Promise<any[]>;
};

/**
 * A row in the user directory.
 *
 * `roleGrants` and `capabilities` are the reason this type exists. The
 * directory used to read `u.roles` — `{ role: Role }[]` straight off the
 * deleted UserRole table — to decide whether someone was team or client, to
 * filter by worker type, and to resolve privileges client-side. With the
 * table gone, `list()` returned bare user rows and every one of those reads
 * was `undefined.some(...)`: the tab threw before it rendered.
 *
 * So the server answers both questions it is actually being asked. Which
 * ROLES does this person hold (what the badges show, and what a grant screen
 * edits) and what can they DO (one flattened set, resolved by the same
 * `heldCapabilities` the request path uses). The second is not derivable from
 * the first without the inheritance table, which is exactly the computation
 * that must not be duplicated in the browser.
 */
export type DirectoryUserRow = User & {
  roleGrants: Array<{
    roleId: string;
    /** Stable key for a starter role; null for an operator-built one. */
    key: string | null;
    name: string;
    /**
     * null for a company-wide grant (a `UserCustomRole` row); set for one
     * scoped to a single portfolio (a `PortfolioAssignment` row). The two live in
     * separate tables because they are different grants, and the directory
     * has to tell them apart: "Admin" and "Admin in Durham" are not the same
     * badge, and only the first makes someone someone with `schedule.manage` of the business.
     */
    /** `PortfolioAssignment.id`, so a person's card can revoke the grant
     *  itself. Null for a company-wide grant, which is revoked by role. */
    grantId: string | null;
    portfolioId: string | null;
    portfolioName: string | null;
    /** Temporary cover — a `PortfolioAssignment` flag; always false company-wide. */
    isTemporary: boolean;
  }>;
  /**
   * DOES THIS LOGIN BELONG TO A CUSTOMER?
   *
   * An ACTIVE `ClientContact` for their Clerk id — the same rule `/me` uses,
   * and it never consults roles. A customer's login is an ordinary `User`
   * row with no `workerType`, so without this flag the directory cannot
   * tell one from a staff account that was never set up, and reads twenty
   * customers as twenty broken employees.
   *
   * It is NOT the opposite of "worker": a customer may also work for you.
   * Such an account has a worker type and roles AND this flag set.
   */
  isClientContact: boolean;
  /**
   * What this person can do EVERYWHERE — their company-wide grants,
   * flattened through inheritance, suspension already applied.
   *
   * Portfolio-scoped grants are deliberately excluded. `heldCapabilities` is a
   * union and does not consider `portfolioPath`, so including them would report
   * someone who runs one district as running the business. Read those out
   * of `roleGrants`, where each carries its own portfolio.
   */
  capabilities: string[];
};

export type ServicesUsers = {
  list(params?: {
    approved?: boolean;
    /** Filter to people holding this role, by its stable key
     *  ("seedlings.worker"). Was a `Role` enum value. */
    roleKey?: string;
    /** Only people with a worker type — i.e. not a customer-only login.
     *  The payroll gate, which is the staff/customer boundary. */
    hasWorkerType?: boolean;
  }): Promise<DirectoryUserRow[]>;
  // Reserved + checked-out items (flat list used by AdminUsers UI)
  listHoldings(): Promise<UserHolding[]>;

  approve(
    clerkUserId: string,
    userId: string,
    opts?: { linkContactId?: string | null },
  ): Promise<User>;
  // addRole / removeRole are GONE. Granting a role is `customRoles.assign`
  // / `.revoke`, which audit and enforce the one-system-role rule.
  // Hard-delete user (Clerk + DB)
  remove(
    clerkUserId: string,
    userId: string,
    actorUserId: string,
  ): Promise<{
    deleted: true;
    clerkDeleted: boolean;
    contactsUnlinked: number;
  }>;

  pendingApprovalCount(): Promise<{ pending: number }>;

  me(
    token: string,
    impersonateHeader?: string | string[] | null,
    // The client "View as" contact ID (`clients.view-as`). Set by
    // plugins/clientImpersonation.ts on request.impersonatedContact.id and
    // passed through from the /me route. When active + the caller is really
    // SUPER, the returned payload is overlaid to look like a signed-in
    // client (no capabilities, client identity fields) so UI visibility
    // guards render the client tabs. Ignored for callers without
    // `identity.link`.
    clientImpersonationContactId?: string | null,
  ): Promise<{
    id: string;
    isApproved: boolean;
    /** What this caller may DO, narrowed by any active perspective. The web gates
     *  every button on this, so it must match what the routes will accept. */
    capabilities?: string[];
    /** Perspectives available, lowest access first — the top-tab dropdown. */
    perspectives?: Array<{ roleId: string; key: string | null; name: string; order: number }>;
    /** The active perspective, or null for "everything I hold". */
    activePerspectiveRoleId?: string | null;
    email?: string | null;
    displayName?: string | null;
    workerType?: string | null;
    // Compliance-policy state (insurance, W-9, contractor agreement, safety
    // SOP, etc.) served separately via GET /me/policies in Slice 2.
    /** Mirrors the regular field when no perspective is active. Kept so the UI can
     *  always show what the person really is while looking through one. */
    realWorkerType?: string | null;
    isImpersonating?: boolean;
    isClientImpersonating?: boolean;
  }>;

  setWorkerType(
    currentUserId: string,
    userId: string,
    workerType: string | null,
  ): Promise<User>;
  setIsOwner(
    currentUserId: string,
    userId: string,
    isOwner: boolean,
  ): Promise<User>;
};

export type ServicesClients = {
  list(params?: {
    q?: string;
    status?: ClientStatus | "ALL";
    limit?: number;
    /** Territory filter from `portfolioWhere(principal, "clients.view")`; the
     *  service wraps it in the hop through `properties`. */
    portfolioWhere?: Record<string, unknown>;
    /** Narrow to clients this user is on the work for — set by the route
     *  for a caller who is not field-cleared and cannot manage clients. */
    assignedToUserId?: string;
  }): Promise<ClientListItem[]>;
  get(id: string): Promise<ClientWithContacts>;
  create(currentUserId: string, payload: ClientUpsert): Promise<Client | null>;
  update(
    currentUserId: string,
    id: string,
    payload: ClientUpsert,
  ): Promise<Client | null>;
  // pause/unpause removed in Step 3 — see services/clients.ts comment.
  archive(
    currentUserId: string,
    id: string,
  ): Promise<{
    archived: boolean;
    propertiesArchived: number;
    jobsArchived: number;
    cascadeGroupId: string;
  }>;
  unarchive(
    currentUserId: string,
    id: string,
  ): Promise<{
    unarchived: boolean;
    propertiesUnarchived: number;
    jobsUnarchived: number;
    cascadeGroupId: string;
  }>;
  delete(currentUserId: string, id: string): Promise<{ deleted: true }>;

  //////////

  addContact(
    currentUserId: string,
    clientId: string,
    payload: ContactUpsert,
  ): Promise<ClientContact | null>;
  updateContact(
    currentUserId: string,
    id: string,
    contactId: string,
    payload: ContactUpsert,
  ): Promise<ClientContact | null>;
  // pauseContact/unpauseContact removed in Step 3 — see services/clients.ts.
  archiveContact(
    currentUserId: string,
    id: string,
  ): Promise<ClientContact | null>;
  unarchiveContact(
    currentUserId: string,
    id: string,
  ): Promise<ClientContact | null>;
  deleteContact(
    currentUserId: string,
    clientId: string,
    contactId: string,
  ): Promise<{ deleted: true }>;
  setPrimaryContact(
    currentUserId: string,
    clientId: string,
    contactId: string,
  ): Promise<{ primarySet: true }>;
};

export type ServicesCurrentUser = {
  me(clerkUserId: string): Promise<{
    id: string;
    isApproved: boolean;
    email?: string | null;
    displayName?: string | null;
    /** How this person is paid. NULL means nothing resolves — being in the
     *  system is not being cleared to act in it. */
    workerType: "EMPLOYEE" | "CONTRACTOR" | "UNPAID" | null;
    /** Live roles with inheritance already flattened. `portfolioPath` present
     *  means the role is held within that subtree rather than company-wide.
     *
     *  NOT the person's capabilities. The rbac plugin builds those into a
     *  principal; a field named `capabilities` here is exactly what
     *  `{ ...me }` would spread through a narrowed perspective (G4). */
    roleGrants: Array<{
      roleId: string;
      name: string;
      entitlements: string[];
      portfolioPath?: string;
    }>;
    /** Perspectives this person may look through, lowest access first. Always a
     *  subset of what they hold — a perspective can only ever narrow. */
    perspectives: Array<{
      roleId: string;
      key: string | null;
      name: string;
      order: number;
      entitlements: string[];
    }>;
  }>;
};

export type ServicesActivity = {
  listUserActivity(): Promise<DirectoryActivityUser[]>;
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

/** One pin on the portfolio map. */
export type PropertyMapPoint = {
  id: string;
  displayName: string;
  street1: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** Set when the geocoder could not place this address. Such a property is
   *  skipped by the resolver rather than retried on every open. */
  parcelLookupError: string | null;
  /** Every portfolio this property is in. Plural: a pin can belong to a
   *  location portfolio and a route at the same time. */
  portfolios: { portfolio: { id: string; name: string } }[];
  client: { displayName: string | null } | null;
};

export type PropertyMapScope = {
  portfolioWhere?: Record<string, unknown>;
  portfolioSubtreePath?: string | "none";
  assignedToUserId?: string;
};

export type ServicesProperties = {
  /** Pins for the portfolio map. A pure read — never geocodes. */
  mapPoints(params: PropertyMapScope & { portfolioId?: string }): Promise<{
    /** The portfolio's own configured point — what its weather is anchored on. */
    portfolioCentre: { id: string; name: string; lat: number; lng: number } | null;
    points: PropertyMapPoint[];
    total: number;
    placed: number;
    /** Still to geocode; excludes the known-unplaceable. */
    pending: number;
    unplaceable: number;
  }>;
  /** Geocode the next few unplaced properties. Small batches, called
   *  repeatedly — one address costs seconds. */
  resolveMapPoints(params: PropertyMapScope & { limit: number }): Promise<{
    resolved: Array<{ id: string; lat: number; lng: number }>;
    failed: string[];
    remaining: number;
  }>;
  list(params?: PropertyListItemParams): Promise<PropertyListItem[]>;
  get(id: string): Promise<Property>;

  create(actorId: string, payload: PropertyUpsert): Promise<Property>;
  update(
    currentUserId: string,
    id: string,
    payload: PropertyUpsert,
  ): Promise<Property>;
  archive(
    currentUserId: string,
    id: string,
    opts?: { cascadeGroupId?: string; tx?: any },
  ): Promise<{ archived: true; jobsArchived: number; cascadeGroupId: string }>;
  unarchive(
    currentUserId: string,
    id: string,
    opts?: { cascadeGroupId?: string; tx?: any },
  ): Promise<{
    unarchived: true;
    jobsUnarchived: number;
    cascadeGroupId: string;
  }>;
  hardDelete(currentUserId: string, id: string): Promise<{ deleted: true }>;

  setPrimaryContact(
    currentUserId: string,
    id: string,
    contactId: string | null,
  ): Promise<{ primarySet: true }>;
};

/////////

export type JobListItem = Job & {
  property: Pick<Property, "id" | "displayName" | "city" | "state" | "status">;
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
  mustBeAssigned?: boolean;
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
      /** From `portfolioWhereVia(principal, cap, "property")`. */
    portfolioWhere?: Record<string, unknown>;
  }): Promise<JobListItem[]>;

  listAllOccurrences(params?: {
    from?: string;
    to?: string;
    cutoff?: Date | null;
      /** Territory filter from `portfolioWhere(principal, "schedule.view")`.
     *  A JobOccurrence reaches its portfolios through a join. */
    portfolioWhere?: Record<string, unknown>;
  }): Promise<any[]>;
  listNextOccurrenceGhosts(params: {
    from?: string;
    to?: string;
    assigneeUserId?: string | null;
    cutoff?: Date | null;
      /** From `portfolioWhereVia(principal, cap, "property")`. */
    portfolioWhere?: Record<string, unknown>;
  }): Promise<any[]>;
  countGhostExpiry(params: {
    assigneeUserId?: string | null;
    cutoff?: Date | null;
      portfolioWhere?: Record<string, unknown>;
  }): Promise<{ expiringSoon: number; expired: number }>;
  getOccurrencesByIds(ids: string[], cutoff?: Date | null): Promise<any[]>;
  listMyOccurrences(
    userId: string,
    options?: { canManageSchedule?: boolean },
  ): Promise<any[]>;
  /** @param portfolioWhere territory filter from
   *  `portfolioWhere(principal, "schedule.view")`; `{}` for a global reader. */
  listAvailableOccurrences(portfolioWhere?: Record<string, unknown>): Promise<any[]>;
  /**
   * These four decide whether the caller may act on a visit that is not
   * theirs — unclaim somebody else's, remove another person's assignment,
   * force a status. Each answered it with `userCan(tx, currentUserId, …)`, a
   * fresh read of the caller's REAL grants that ignored any active
   * perspective. `callerCan` is the route's already-narrowed test.
   */
  claimOccurrence(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    opts?: { groupId?: string | null },
  ): Promise<{ claimed: true }>;
  updateOccurrenceStatus(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    status: JobOccurrenceStatus,
    notes?: string,
    location?: { lat: number; lng: number },
    timestamps?: {
      startedAt?: string;
      completedAt?: string;
      totalPausedMs?: number;
    },
    extras?: { completionSplits?: Array<{ userId: string; percent: number }> },
  ): Promise<JobOccurrence>;

  get(
    id: string,
    cutoff?: Date | null,
  ): Promise<
    Job & {
      property: Property;
          occurrences: JobOccurrence[];
      defaultAssignees: (JobOccurrenceAssignee | any)[]; // or define a better type for JobAssigneeDefault
    }
  >;

  create(currentUserId: string, payload: JobUpsert): Promise<Job>;
  update(currentUserId: string, id: string, payload: JobUpsert): Promise<Job>;

  // schedule acts like “calendar rules” for generating occurrences

  // “create a one-off from the job” (manual instance, can act like template usage)
  createOccurrence(
    currentUserId: string,
    jobId: string,
    input: CreateOccurrenceInput,
  ): Promise<JobOccurrence>;

  /** Change what a visit is billed at, after the work is done but before any
   *  payment exists. Re-snapshots the promised payouts. */
  adjustOccurrencePrice(
    currentUserId: string,
    occurrenceId: string,
    price: number,
    reason?: string | null,
    laborDetail?: string | null,
  ): Promise<{
    price: number;
    priceTotal: number;
    promisedPayouts: Array<{ userId: string; net: number }> | null;
  }>;

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
      mustBeAssigned?: boolean;
      paymentRevertReason?: string | null;
    },
    options?: { canManageSchedule?: boolean },
  ): Promise<JobOccurrence>;

  /** Caller must already be on the visit, or hold `schedule.manage`. */
  addOccurrenceAssignee(
    actingUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    targetUserId: string,
    role?: string | null,
  ): Promise<{ added: true } | { added: false; reason: string }>;

  createTask(
    currentUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      linkedOccurrenceId?: string;
    },
  ): Promise<JobOccurrence>;

  /** Caller must be the claimer, or hold `schedule.manage`. */
  removeOccurrenceAssignee(
    actingUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    targetUserId: string,
  ): Promise<{ removed: true }>;

  unclaimOccurrence(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
  ): Promise<{ unclaimed: true }>;

  archiveJob(
    currentUserId: string,
    jobId: string,
    opts?: { cascadeGroupId?: string; tx?: any },
  ): Promise<Job>;
  unarchiveJob(
    currentUserId: string,
    jobId: string,
    opts?: { cascadeGroupId?: string; tx?: any },
  ): Promise<Job>;
  archiveOccurrence(
    currentUserId: string,
    occurrenceId: string,
  ): Promise<JobOccurrence>;
  listArchivedJobs(params?: { page?: number; pageSize?: number; portfolioWhere?: Record<string, unknown> }): Promise<{
    items: JobListItem[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  createEvent(
    actingUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      frequencyDays?: number | null;
    },
  ): Promise<JobOccurrence>;
  completeEvent(
    actingUserId: string,
    occurrenceId: string,
  ): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  createFollowup(
    actingUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      frequencyDays?: number | null;
      clientIds?: string[];
      jobIds?: string[];
    },
  ): Promise<JobOccurrence>;
  completeFollowup(
    actingUserId: string,
    occurrenceId: string,
  ): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  createAnnouncement(
    actingUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      frequencyDays?: number | null;
    },
  ): Promise<JobOccurrence>;
  completeAnnouncement(
    actingUserId: string,
    occurrenceId: string,
  ): Promise<{ completed: JobOccurrence; next: JobOccurrence | null }>;

  /** currentUserId is optional only so existing callers kept compiling
   *  during the audit-coverage sweep; ALWAYS pass it — a hard delete
   *  with a null actor is a trail that names no one. */
  deleteJob(jobId: string, currentUserId?: string | null): Promise<{ deleted: true }>;
  deleteOccurrence(occurrenceId: string, currentUserId?: string | null): Promise<{ deleted: true }>;

  // assignment at the occurrence level (workers only)
  setOccurrenceAssignees(
    currentUserId: string,
    occurrenceId: string,
    input: AssignOccurrenceInput,
  ): Promise<{ updated: true }>;

  // `schedule.manage`: move ownership of an occurrence to another worker.
  reassignClaimer(
    actingUserId: string,
    occurrenceId: string,
    newClaimerUserId: string,
  ): Promise<any>;

  // `schedule.manage`: change a specific assignee's seat on an occurrence.
  // `newRole` of null clears the role override.
  changeAssigneeRole(
    actingUserId: string,
    occurrenceId: string,
    targetUserId: string,
    newRole: string | null,
  ): Promise<any>;

  // `schedule.manage`: lightweight estimate creation from the dispatch flow.
  createLightEstimate(
    actingUserId: string,
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
    },
  ): Promise<JobOccurrence>;

  // Assignee-or-admin: update a light estimate (ESTIMATE workflow).
  updateLightEstimate(
    actorUserId: string,
    occurrenceId: string,
    input: {
      title?: string;
      notes?: string | null;
      startAt?: string;
      contactName?: string | null;
      contactPhone?: string | null;
      contactEmail?: string | null;
      estimateAddress?: string | null;
      proposalAmount?: number | null;
      proposalNotes?: string | null;
      jobTags?: string | string[] | null;
      jobType?: string | null;
      assigneeUserIds?: string[];
      jobId?: string | null;
    },
    options?: { canManageSchedule?: boolean },
  ): Promise<any>;

  // A reminder with no parent job or occurrence. `approvedUser` — any
  // approved caller, because the reminder belongs to whoever made it.
  createStandaloneReminder(
    currentUserId: string,
    input: {
      title: string;
      notes?: string;
      startAt: string;
      linkedOccurrenceId?: string;
      isHighPriority?: boolean;
    },
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
      // Optional processor fee — set by the back-office money paths
      // (`money.record` at mark-paid, `money.approve` at approval) when the
      // payment method has a known fee (Venmo/Zelle/card). Computed and
      // persisted on the resulting Payment row so the income/expense
      // exports tie out.
      processorFeeAmount?: number | null;
      // Worker percentages set by the claimer in the Take Payment dialog.
      // Server persists these to JobOccurrence.completionSplits and re-
      // snapshots promisedPayouts before creating the Payment row.
      completionSplits: Array<{ userId: string; percent: number }>;
      /** When set, the Payment row's `createdAt` uses this instant
       *  instead of the default `now()`. Lets admin-side reconciliation
       *  flows record when the money ACTUALLY landed vs. when the
       *  operator opened the app. Approval path pairs this with
       *  `confirmedAt` so both timestamps align. */
      createdAt?: Date;
    },
  ): Promise<any>;

  listMyPayments(
    userId: string,
    // `cutoff` is the Business Start Date filter — pre-cutoff payments are
    // excluded. Pass null (or omit) for no filter. See
    // lib/businessStartCutoff.ts.
    params?: { from?: string; to?: string; cutoff?: Date | null },
  ): Promise<{ items: any[]; totalAmount: number }>;

  listAllPayments(params?: {
    from?: string;
    to?: string;
    userId?: string;
    method?: string;
    cutoff?: Date | null;
    /** Portfolio filter from `portfolioWhereVia(principal, "money.view", "occurrence")`.
     *  EMPTY means no narrowing — a global money.view holder sees everything
     *  and the query is byte-identical to its pre-feature shape. */
    portfolioWhere?: Record<string, unknown>;
  }): Promise<{
    items: any[];
    personTotals: Array<{
      userId: string;
      displayName: string | null;
      total: number;
    }>;
  }>;

  getPaymentByOccurrence(occurrenceId: string): Promise<any | null>;

  updatePayment(
    currentUserId: string,
    paymentId: string,
    input: {
      amountPaid?: number;
      method?: string;
      note?: string | null;
      /** Corrected money-received date. Re-anchors Payment.createdAt (and
       *  confirmedAt when the row is already confirmed) — see
       *  services/payments.ts updatePayment. */
      paidAt?: Date;
      splits?: Array<{ userId: string; amount: number }>;
    },
  ): Promise<any>;

  deletePayment(currentUserId: string, paymentId: string): Promise<void>;

  recalculateSplits(occurrenceId: string, currentUserId?: string | null): Promise<any>;
  forceCreateNextOccurrence(
    currentUserId: string,
    occurrenceId: string,
  ): Promise<any>;
  markInvoicePaidAsManager(
    currentUserId: string,
    occurrenceId: string,
    input: {
      amountPaid: number;
      method: string;
      note?: string | null;
      processorFeeAmount?: number | null;
      /** When set, the resulting Payment's `createdAt` and
       *  `confirmedAt` are both anchored to this instant so
       *  cash-basis reports and BSD filters see the payment on
       *  the day the money actually landed. See approvePayment
       *  overrides.paidAt for the shared plumbing. */
      paidAt?: Date;
    },
  ): Promise<any>;

  /**
   * Client-or-worker self-reported payment. Creates an unconfirmed Payment
   * row attached to the occurrence; occurrence stays in PENDING_PAYMENT
   * until someone with `schedule.manage` approves. Splits are not materialized here —
   * they're computed at approval time from JobOccurrence.completionSplits.
   */
  selfReportPayment(
    actorUserId: string | null,
    input: {
      occurrenceId: string;
      method: string;
      amountPaid: number;
      note?: string | null;
    },
  ): Promise<any>;

  /**
   * `money.approve` flips an existing self-reported Payment to confirmed=true.
   * Optionally adjusts amount/method (e.g., "client said $150 Zelle but I
   * see $140"). Materializes splits using completionSplits + final amount.
   * Closes the occurrence and runs the next-occurrence creation logic.
   */
  approvePayment(
    currentUserId: string,
    paymentId: string,
    overrides?: {
      amountPaid?: number;
      method?: string;
      note?: string | null;
      processorFeeAmount?: number;
      /** When set, the payment's `confirmedAt` is stamped to this
       *  instant instead of `new Date()`. Also shifts `createdAt` so
       *  every date-bucketed report (cash-basis statements, BSD
       *  filters, income CSVs, etc.) sees the payment on the day
       *  the money actually landed — not the day the operator
       *  happened to open the app. Recommended for reconciliation
       *  workflows where the operator is entering historical data. */
      paidAt?: Date;
      /** Designates part (or all) of an overpayment as a tip and divides
       *  it between the business and the workers. Clamped to the computed
       *  overage — you cannot tip money the client didn't overpay.
       *  Percentages must total 100; the UI validates before submitting. */
      tip?: {
        amount: number;
        businessPercent: number;
        workerPercents: Array<{ userId: string; percent: number }>;
      } | null;
    },
  ): Promise<any>;

  /**
   * `money.approve` deletes a pending self-reported Payment. Occurrence stays
   * PENDING_PAYMENT so the client can be re-prompted, or the payment recorded
   * directly later.
   */
  rejectPayment(
    currentUserId: string,
    paymentId: string,
    reason?: string | null,
  ): Promise<void>;

  /**
   * `money.approve` closes the books on a payment that will never be collected
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
   * "Pretend this service never happened" (`schedule.manage`) — every money query,
   * export, dashboard aggregate, and 1099 total filters `skippedAt: null`
   * to exclude the payment. Under the hood runs the standard approval
   * path with collected=0 (so occurrence closes + next-occurrence
   * generation fires) then stamps `skippedAt`. See services/payments.ts
   * for the full rationale; gated by `money.approve` + type-APPROVE at the UI.
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

  /** Occurrence-level Write off — same shape as skipOccurrence but
   *  delegates to writeOffPayment. Used from Outstanding Requests when
   *  the client has ghosted and the operator wants a bad-debt record
   *  on the P&L (rather than a full erasure via Void). */
  writeOffOccurrence(
    currentUserId: string,
    occurrenceId: string,
    reason?: string | null,
  ): Promise<any>;

  /** Reverse a skip. Clears skippedAt so the payment reappears in
   *  every aggregate. Same `money.approve` + type-APPROVE gate as skip. */
  unskipPayment(currentUserId: string, paymentId: string): Promise<any>;

  listPendingApprovals(
    cutoff?: Date | null,
    /** From `portfolioWhereVia(principal, "money.view", "occurrence")`. Empty
     *  means no narrowing. */
    portfolioWhere?: Record<string, unknown>,
  ): Promise<any[]>;
};

export type InvoiceChargeInput = {
  /** What the CLIENT IS CHARGED for this line. Goes on the invoice. */
  cost: number;
  /** The line name the client reads, e.g. "Mulch". */
  description: string;
  /** What we actually paid. Optional and informational — job margin only,
   *  never the invoice and never the payout. */
  actualCost?: number | null;
  /** CLIENT-VISIBLE detail, e.g. "25 bags at $6.00". Optional. */
  detail?: string | null;
  // NO category, vendor or date. An invoice charge writes no BusinessExpense,
  // so there is no Schedule C line to file it against. Adding them back would
  // collect a tax category that reaches nothing.
};

export type InvoiceChargePatchInput = {
  cost?: number;
  description?: string;
  /** Null CLEARS it — how an operator removes a cost entered by mistake, so
   *  callers must distinguish "absent" from "null". */
  actualCost?: number | null;
  /** Null CLEARS it. */
  detail?: string | null;
};

export type ServicesInvoiceCharges = {
  /**
   * `callerCan` IS NOT OPTIONAL, AND THAT IS THE POINT.
   *
   * These four decide whether the caller may bill a visit that is not theirs.
   * They used to answer it with `userCan(prisma, currentUserId, …)` — a fresh
   * read that returns the person's REAL grants and ignores any active
   * perspective, so someone with `settings.manage` looking through a Trainee perspective still billed like
   * someone with `settings.manage`. The principal could not reach a service, so the route passes its
   * test down instead. Required, so TypeScript names every call site rather
   * than leaving one silently re-reading the database.
   */
  addInvoiceCharge(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    input: InvoiceChargeInput,
  ): Promise<any>;

  updateInvoiceCharge(
    currentUserId: string,
    callerCan: CallerCan,
    invoiceChargeId: string,
    input: InvoiceChargePatchInput,
  ): Promise<any>;

  deleteInvoiceCharge(
    currentUserId: string,
    callerCan: CallerCan,
    invoiceChargeId: string,
  ): Promise<{ deleted: true }>;

  addInvoiceCharge(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    input: InvoiceChargeInput,
  ): Promise<any>;

  deleteInvoiceCharge(
    currentUserId: string,
    callerCan: CallerCan,
    invoiceChargeId: string,
  ): Promise<{ deleted: true }>;

  listInvoiceChargesByOccurrence(occurrenceId: string): Promise<any[]>;
};

export type SupplyCreateInput = {
  name: string;
  description?: string | null;
  unit: string;
  upc?: string | null;
  category?: string | null;
  /** DEFAULT charge to a client per unit. What the stock COST is not settable
   *  here — it is derived from the purchases; see lib/supplyCost.ts. */
  clientUnitPrice: number;
  /** Percent on top of average cost, INSTEAD of the fixed price above.
   *  Null uses the fixed price; `0` is a real markup (bill at cost). */
  clientMarkupPercent?: number | null;
};

export type SupplyPatchInput = {
  name?: string;
  description?: string | null;
  unit?: string;
  upc?: string | null;
  category?: string | null;
  clientUnitPrice?: number;
  /** Present-and-null switches a markup back to the fixed price. */
  clientMarkupPercent?: number | null;
};

export type SupplyPurchaseInput = {
  quantity: number;
  // Total actually paid for the whole purchase, incl. tax and discounts —
  // the receipt/bank-statement figure. Per-unit cost is derived from this.
  totalCost: number;
  date?: string | null;
  notes?: string | null;  /** OPTIONAL, MANY-TO-ONE breadcrumb to a real ledger charge. Never set
   *  automatically — recording a purchase creates no ledger row. */
  businessExpenseId?: string | null;
};

export type SupplyAdjustmentInput = {
  delta: number;
  reason: string;
};

export type SupplyHoldInput = {
  supplyId: string;
  quantity: number;
  /**
   * What THIS client is charged per unit, for THIS job.
   *
   * The price is decided when the supply goes onto a job, not when the supply
   * is catalogued — the same bag of mulch can be billed differently to two
   * clients. The catalog carries a DEFAULT; this overrides it, and whatever is
   * used is snapshotted on the hold so later repricing never moves it.
   *
   * Omit to use the supply's default.
   */
  clientUnitPrice?: number | null;
  /** The headline a client reads. Defaults to the supply's name. */
  description?: string | null;
  /** Optional client-visible detail — "5 bags at $5.00 each". Same shape as
   *  any other invoice charge; a supply line is not a special kind. */
  detail?: string | null;
};

/**
 * `callerCan` on every mutating method is the CALLER's capability test,
 * resolved at the route from the already-narrowed principal. These used to
 * ask `userCan(prisma, currentUserId, …)`, a fresh read that returns real
 * grants and ignores an active perspective — so someone with `settings.manage` looking through a
 * Trainee perspective could still rewrite the catalogue.
 */
export type ServicesSupplies = {
  list(opts?: {
    includeArchived?: boolean;
    q?: string;
    includeHoldDetails?: boolean;
  }): Promise<any[]>;
  getById(id: string): Promise<any | null>;
  create(currentUserId: string,
    callerCan: CallerCan, input: SupplyCreateInput): Promise<any>;
  update(
    currentUserId: string,
    callerCan: CallerCan,
    id: string,
    input: SupplyPatchInput,
  ): Promise<any>;
  archive(currentUserId: string,
    callerCan: CallerCan, id: string): Promise<{ archived: true }>;
  unarchive(currentUserId: string,
    callerCan: CallerCan, id: string): Promise<{ archived: false }>;

  recordPurchase(
    currentUserId: string,
    callerCan: CallerCan,
    supplyId: string,
    input: SupplyPurchaseInput,
  ): Promise<any>;
  reversePurchase(
    currentUserId: string,
    callerCan: CallerCan,
    purchaseId: string,
  ): Promise<{ reversed: true }>;

  recordAdjustment(
    currentUserId: string,
    callerCan: CallerCan,
    supplyId: string,
    input: SupplyAdjustmentInput,
  ): Promise<any>;

  // `cutoff` is the Business Start Date filter — pre-cutoff SupplyPurchase
  // rows hidden. Holds and adjustments pass through (they're operational,
  // not money). See lib/businessStartCutoff.ts.
  listHistory(
    supplyId: string,
    opts?: { cutoff?: Date | null },
  ): Promise<any[]>;

  // Add a hold (consumption reservation) on an occurrence — creates a paired
  // job-level Expense for payout deduction. Workers (claimers) and holders of `schedule.manage` can
  // call this; the route layer enforces.
  addHold(
    currentUserId: string,
    callerCan: CallerCan,
    occurrenceId: string,
    input: SupplyHoldInput,
  ): Promise<any>;
  removeHold(currentUserId: string,
    callerCan: CallerCan, holdId: string): Promise<{ removed: true }>;
  adjustHold(
    currentUserId: string,
    callerCan: CallerCan,
    holdId: string,
    newQuantity: number,
  ): Promise<any>;

  // Lifecycle: invoked by jobs service when an occurrence transitions.
  consumeHoldsForOccurrence(
    occurrenceId: string,
  ): Promise<{ consumed: number }>;
  releaseHoldsForOccurrence(
    occurrenceId: string,
  ): Promise<{ released: number }>;
  reactivateHoldsForOccurrence(
    occurrenceId: string,
  ): Promise<{ reactivated: number }>;
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
  invoiceCharges: ServicesInvoiceCharges;
  settings: ServicesSettings;
  supplies: ServicesSupplies;
  groups: typeof import("../services/groups").groups;
  board: typeof import("../services/board").board;
  companyDocuments: typeof import("../services/companyDocuments").companyDocuments;
  timelineEvents: typeof import("../services/timelineEvents").timelineEvents;
  banners: typeof import("../services/banners").banners;
  paymentRequests: typeof import("../services/paymentRequests").paymentRequests;
  policies: typeof import("../services/policies").policies;
  customRoles: typeof import("../services/customRoles").customRoles;
  portfolios: typeof import("../services/portfolios").portfolios;
};

export type ServicesSettings = {
  getAll(): Promise<any[]>;
  get(key: string): Promise<{ key: string; value: string } | null>;
  getValue(key: string, fallback: string): Promise<string>;
  set(actorUserId: string, key: string, value: string): Promise<any>;
};
