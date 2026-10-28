// apps/web/src/ui/tabs/UsersTab.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Stack,
  Text,
  Badge,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Check, ChevronDown, ChevronRight, Filter, Info, Minus, RefreshCw, Shield, Tag, UserPlus, X } from "lucide-react";
// The vocabulary itself — the same constant the server compiles in, so
// the "does not have it" rows cannot drift from what `can()` knows about.
import { ENTITLEMENTS, ENTITLEMENT_GROUPS } from "@repo/permissions";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import { fmtDate, bizToday, bizAddDays, bizDateKey, bizDaysBetween } from "@/src/lib/dates";
import { prettyStatus } from "@/src/lib/labels";
import { equipmentStatusColor } from "@/src/lib/statusColors";
import { WorkerType } from "@/src/lib/types";
import { openEventSearch } from "@/src/lib/bus";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { NudgeUserButton } from "@/src/ui/tabs/ComplianceTab";
import ApproveAndLinkClientDialog from "@/src/ui/dialogs/ApproveAndLinkClientDialog";
import UserActivitySection from "@/src/ui/components/UserActivitySection";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { Dashboard } from "@/src/ui/components/Dashboard";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import type { Scope } from "@/src/lib/scope";
import { holds } from "@/src/lib/roles";
import { isCustomerOnly } from "@/src/lib/people";
import { CAPABILITIES_CHANGED_EVENT } from "@/src/lib/impersonation";
// `readOnly` forces the directory to render with no mutation surface —
// no approve, no worker-type change, no delete — regardless of what the
// caller holds. Pending sign-ups still render, with identity badges only,
// so the queue is visible to somebody who cannot act on it.
//
// It is a CEILING, not the permission: what each control needs is its own
// capability, listed on the props below. This comment used to end "user
// management actions are for one role only — handled via a separate tab"; there
// is no Users, there is one directory, and the actions are gated
// on `people.manage`, `people.approve` and `people.grant-roles`
// separately, because they are separately grantable.
export type TabRolePropType = {
  readOnly?: boolean;
  /** What the caller may do, as capabilities. Each is read where the
   *  control it gates lives, because each is separately grantable.
   *  `people.manage`      → THE BRANCH. With it, the full directory; the
   *                         per-user edit controls and the effective-
   *                         permissions drawer read it again.
   *  `people.view`        → without `people.manage`, the trimmed
   *                         <WorkerTeamRoster />: names and worker types,
   *                         no email, wage, roles or splits. Holding
   *                         neither gets <UnavailableNotice />.
   *  `people.approve`     → approve or decline a pending sign-up.
   *  `people.grant-roles` → the role-grant picker.
   *  `roles.view`         → the role catalogue the filter is built from.
   *  Absent fails closed — it grants nothing. */
  scope?: Scope;
};

/** One row of `GET /roles` — only the fields the picker needs. */
type RoleOption = {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  suspendedAt: string | null;
  isPerspective: boolean;
  isLadderRung: boolean;
  /** What the role itself grants, inheritance NOT resolved. Used to tell a
   *  role from a lone permission wearing a role's clothes — see the picker's
   *  grouping. `own`, not `effective`: a role inheriting Trainee would carry
   *  13 effective capabilities while granting one of its own. */
  own?: string[];
  /** What HOLDING it actually gives, inheritance resolved — the server
   *  computes it on `GET /roles`. Needed to answer "does this grant
   *  people.grant-roles", which a role can do by inheriting, without
   *  owning it. Walking the chain here would be a second opinion about
   *  what a role means. */
  effective?: string[];
  /** Null means it stands on nothing, so holding it alone gives only its own
   *  capabilities — an add-on, not a self-sufficient role. */
  inheritsFromId?: string | null;
};

type ApiUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  isApproved: boolean;
  /** An ACTIVE ClientContact for this login's Clerk id — from GET /users.
   *  The authoritative customer test; see lib/people.ts. */
  isClientContact?: boolean;
  /**
   * Which roles this person holds, as the server resolved them. Replaces
   * `roles: { role: Role }[]` — the UserRole table it came from is deleted,
   * so that field arrived undefined and every `u.roles.some(...)` below
   * threw before the tab could render.
   *
   * A grant with an `areaId` is held only in that area. It is a separate
   * badge ("Admin — Durham"), and it is NOT in `capabilities`.
   */
  roleGrants: Array<{
    roleId: string;
    key: string | null;
    name: string;
    areaId: string | null;
    areaName: string | null;
    isTemporary: boolean;
  }>;
  /** What this person can do company-wide. Resolved by the server through
   *  role inheritance, with the same function the request path uses — so a
   *  badge here cannot disagree with a 403 from a route. */
  capabilities: string[];
  workerType?: string | null;
  isOwner?: boolean;
  // Compliance-policy status (insurance, W-9, contractor agreement, safety
  // SOP, etc.) is surfaced separately in Slice 4 via the Compliance
  // tab + a per-user "Compliance: OK / N pending" chip added to this card
  // in Slice 5. Removed inline fields as part of the migration.
  // Per-user privilege overrides. Null = follow workerType default.
  // The two per-person privilege columns are GONE from the schema and from
  // this payload. They were a per-person entitlement grant, which the model
  // forbids outright (G20): an exception is a NAMED ROLE, visible in a role
  // list, not a hidden toggle on somebody's profile. Read the capability out
  // of `capabilities` instead.
  // Last time the auth plugin saw a new JWT `iat` for this user. Null
  // when the user has never signed in (e.g. a pending sign-up the
  // operator hasn't approved yet — though in practice that case won't
  // appear, since visiting the app at all mints a JWT). Used to render
  // "Last signed in" on the card; the full sign-in history lives in the
  // paged activity section.
  lastSignInAt?: string | null;
};

type Me = {
  id: string;
  isApproved: boolean;
  /** Mirrors `/api/me`. This was `roles: Role[]`, which the payload stopped
   *  carrying — so the local type was asserting a field that never arrives,
   *  and the role check below was silently always false. */
  capabilities?: string[];
  email?: string | null;
  displayName?: string | null;
};

type Holding = {
  userId: string;
  equipmentId: string;
  shortDesc: string;
  brand: string | null;
  model: string | null;
  qrSlug: string | null;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: string; // ISO
  checkedOutAt: string | null; // ISO
};

// Inline confirm state
type ConfirmKind = "delete" | "decline";
type ConfirmState = { userId: string; kind: ConfirmKind } | null;

/** Target for the high-friction "Approve as Worker" modal. Separate from
 *  the inline confirm bar (which still handles delete + decline) because
 *  worker approval grants access to all internal data — jobs, payments,
 *  equipment, crew schedules — and the operator must re-type the user's
 *  email to confirm intent. See ConfirmDialog `requiredInputValue`. */
type ApproveWorkerTarget = {
  userId: string;
  displayName: string;
  email: string;
} | null;

// Status filter type for this page
type Status = "all" | "pending" | "approved";

const statusFilterItems = [
  { label: "All Statuses", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
];
const statusFilterCollection = createListCollection({ items: statusFilterItems });

/**
 * The role filter is built from the role catalogue, not from a literal.
 *
 * It used to list Worker / Admin — two rows of a table the operator owns,
 * so a renamed role stopped matching and a new one could not be filtered on
 * at all. The value is the role's stable KEY, which is what the endpoint
 * takes and what honours inheritance: filtering on `seedlings.worker`
 * includes everyone whose role inherits it.
 *
 * "Client" stays a literal because it is not a role: it is the absence of
 * one plus a customer record, and the filter applies it client-side.
 */
const ROLE_FILTER_FIXED = [
  { label: "All Roles", value: "all" },
  { label: "Client", value: "client" },
];
function buildRoleFilterItems(catalogue: RoleOption[]) {
  return [
    ROLE_FILTER_FIXED[0],
    ...catalogue
      .filter((r) => r.key && !r.isPerspective)
      .map((r) => ({ label: r.name, value: r.key as string })),
    ROLE_FILTER_FIXED[1],
  ];
}

const workerTypeFilterItems = [
  { label: "All Types", value: "all" },
  { label: "Unclassified", value: "unclassified" },
  { label: "Unpaid helper", value: "UNPAID" },
  { label: "Employee", value: "EMPLOYEE" },
  { label: "Contractor", value: "CONTRACTOR" },
];
const workerTypeFilterCollection = createListCollection({ items: workerTypeFilterItems });

/** The pay classes a person may be approved into. Not the filter list
 *  above — that one carries an "all" row, which is not a pay class. */
const approveWorkerTypeCollection = createListCollection({
  items: [
    { label: "Employee — on payroll, W-2", value: "EMPLOYEE" },
    { label: "Contractor — paid per job, 1099", value: "CONTRACTOR" },
    { label: "Unpaid — access, but never paid", value: "UNPAID" },
  ],
});

export default function UsersTab({ readOnly = false, scope }: TabRolePropType) {
  // Absent scope grants nothing. A `role` prop sat beside this one and
  // was destructured but never read — index.tsx passed the literal
  // `role="admin"`, so it only kept a deleted role alive in the signature.
  const effScope: Scope = scope ?? { can: () => false };
  // Render path for callers WITHOUT `people.manage` — a trimmed "Team
  // roster" card list. Wholly separate render tree from the full
  // directory; keeps this path simple and prevents accidental leakage of
  // the management surface's sensitive controls.
  // The trimmed roster is for somebody who may SEE the team but not
  // manage it. Managing is what the full directory is for.
  if (!effScope.can("people.manage")) {
    return effScope.can("people.view") ? <WorkerTeamRoster /> : <UnavailableNotice />;
  }

  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);
  // Per-user compliance summary — keyed by userId. Loaded once per tab
  // mount from /policies/user-compliance and rendered as a chip on
  // each card. Missing entries fall back to "no data" (chip hidden).
  const [complianceByUserId, setComplianceByUserId] = useState<
    Record<string, { current: boolean; pendingCount: number }>
  >({});

  // who am I? (used to hide actions for self)
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false); // prevents action button flash

  // Admitting a pending sign-up, which is `people.approve` — not "being a
  // super", and not the same grant as `people.manage`: an operator can hand
  // someone the directory without handing them the front door.
  //
  // This was a role check. With the enum gone `me.roles`
  // is undefined, so the expression was always falsy and the approve
  // controls had silently disappeared, with nothing to compile-fail about
  // it. There was also a second clause about "scope carrying the intent
  // (which tab you came in through)" — there is one tab, so there is no intent to
  // carry, only the capability.
  const canApproveSignups = effScope.can("people.approve");

  // Collapsed-by-default Permissions section per user. Most admin tasks
  // don't involve toggling these — keep the card compact unless drilled in.
  const [permsOpen, setPermsOpen] = useState<Set<string>>(new Set());

  // simple filters
  const [q, setQ] = useState("");
  const [status, setStatus] = usePersistedState<Status>("users_status", "all");
  // "all" | "client" | a role KEY. Was a union of two role names.
  const [accessRole, setAccessRole] = usePersistedState<string>(
    "users_role", "all"
  );
  const [workerTypeFilter, setWorkerTypeFilter] = usePersistedState("users_workerType", "all");
  // Section toggles — the directory is split three ways:
  //   • Pending  — unapproved sign-ups awaiting Approve/Decline. Defaults to
  //                open because pending rows represent unfinished work.
  //   • Team     — approved workers/holders of `people.manage`. Defaults to open since
  //                most directory tasks target it.
  //   • Clients  — approved users with no operational role. Defaults to
  //                collapsed so holders of `people.manage` don't accidentally interact with
  //                client rows during routine team management.
  const [teamSectionOpen, setTeamSectionOpen] = usePersistedState("users_teamSectionOpen", true);
  const [clientSectionOpen, setClientSectionOpen] = usePersistedState("users_clientSectionOpen", false);


  // Check for pending-approvals navigation from the header
  // badge — on mount and via event. Supports three payload shapes:
  //   { status } → set the status filter (pending users path)
  //   { role }   → set the accessRole filter ("all" used by the alert
  //                chip so the persisted role filter is reset on arrival)
  useEffect(() => {
    try {
      const flag = sessionStorage.getItem("users:openOnce");
      if (flag) {
        sessionStorage.removeItem("users:openOnce");
        const parsed = JSON.parse(flag);
        if (parsed?.status) setStatus(parsed.status);
        if (parsed?.role) setAccessRole(parsed.role);
      }
    } catch {}
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail?.status) setStatus(detail.status);
      if (detail?.role) setAccessRole(detail.role);
    };
    window.addEventListener("users:open", onOpen as EventListener);
    return () => window.removeEventListener("users:open", onOpen as EventListener);
  }, []);
  // Info overlay is opt-in only — opens when the user taps the (i) button.
  // Used to auto-open on first visit (gated by a localStorage dismiss flag);
  // that behavior was removed to stop surprise modals from interrupting
  // returning users on fresh devices / browser sessions.
  const [showInfoOverlay, setShowInfoOverlay] = useState(false);

  // current holdings map (userId -> Holding[])
  const [holdingsByUser, setHoldingsByUser] = useState<
    Record<string, Holding[]>
  >({});

  // confirm bar state (for Delete or Decline)
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // "Approve as Worker" modal target — separate from the inline confirm
  // bar above. Requires the operator to re-type the user's email before
  // the Confirm button enables (typed-confirmation gate).
  const [approveWorkerTarget, setApproveWorkerTarget] = useState<ApproveWorkerTarget>(null);
  const [approveWorkerBusy, setApproveWorkerBusy] = useState(false);
  // THE PAY CLASS, ASKED FOR AT APPROVAL.
  //
  // `approve()` writes `isApproved` and nothing else, so a worker type was
  // a separate profile edit somebody had to remember. Under the old model
  // forgetting cost nothing; under this one `can()` returns false for a
  // null worker type before it looks at a single role (G31), so "approve,
  // then grant Admin" produced an account that could do NOTHING and said
  // why on no screen. Exactly one production account reached that state
  // before anyone noticed, and only because the migration surfaced it.
  //
  // No default. A wrong pay class is a tax question, so the operator picks
  // rather than accepts whatever was pre-selected.
  const [approveWorkerType, setApproveWorkerType] = useState<string>("");
  // "Approve as Client" target. Opens the contact-picker dialog so the
  // approval and the Clerk→ClientContact link happen in a single
  // transaction. Previously this was a one-click approve; see
  // services/users.ts approve() and ApproveAndLinkClientDialog.
  const [approveClientTarget, setApproveClientTarget] = useState<{
    id: string;
    displayName: string | null;
    email: string | null;
  } | null>(null);

  // Listen for programmatic open: set status filter
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { status } = (e as CustomEvent<{ status?: Status }>).detail || {};
      if (status === "pending" || status === "approved" || status === "all") {
        setStatus(status);
      }
    };
    window.addEventListener("seedlings3:open-users", onOpen as EventListener);
    return () =>
      window.removeEventListener(
        "seedlings3:open-users",
        onOpen as EventListener
      );
  }, []);

  // Also react to a status change in the URL after mount (e.g., client nav)
  useEffect(() => {
    const onPop = () => {
      try {
        const sp = new URLSearchParams(window.location.search);
        const s = sp.get("status");
        if (s === "pending" || s === "approved" || s === "all") {
          setStatus(s);
        }
      } catch {}
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Load "me" and set meReady when done (success or fail)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await apiGet<Me>("/api/me");
        if (!cancelled) setMe(m);
      } catch {
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setMeReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * IS THIS PERSON STAFF? — the one question the directory actually needs.
   *
   * It was `surfaces(u)`, returning three role booleans derived from three
   * capabilities, and the card then printed those three as badges.
   * That is the deleted role ladder redrawn in the UI: a bookkeeper lit
   * none of the three and appeared in the directory as a CLIENT, with the
   * Decline button that implies.
   *
   * Staff is the absence of nothing — holding at least one role. A client
   * is somebody with a customer record and no role at all, which is what
   * the role filter at the top of this file already says.
   */
  const holdsAnyRole = (u: ApiUser) => (u.roleGrants?.length ?? 0) > 0;

  /**
   * The role catalogue, for the grant picker.
   *
   * Read once, from `GET /roles` — the same list the role builder edits, so
   * this screen cannot offer a role that does not exist or miss one that
   * does. Gated on `roles.view`, which is separate from `roles.define`
   * precisely so somebody who may GRANT roles can see which ones there are.
   * A caller without it gets an empty catalogue and no picker, rather than
   * a failed request.
   */
  const [roleCatalogue, setRoleCatalogue] = useState<RoleOption[]>([]);
  useEffect(() => {
    if (!scope?.can?.("roles.view")) return;
    let cancelled = false;
    void apiGet<RoleOption[]>("/api/roles")
      .then((rows) => {
        if (!cancelled) setRoleCatalogue(rows.filter((r) => !r.suspendedAt));
      })
      .catch(() => {
        // Non-fatal: the rest of the directory still works, the picker
        // simply does not appear.
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  /**
   * The role a new hire starts on, resolved by KEY.
   *
   * Never by name — "Worker" is a row an operator may rename to "Crew" or
   * delete outright, and a lookup by name would silently stop matching.
   */
  const roleFilterItems = useMemo(() => buildRoleFilterItems(roleCatalogue), [roleCatalogue]);
  const roleFilterCollection = useMemo(
    () => createListCollection({ items: roleFilterItems }),
    [roleFilterItems],
  );

  // The filter used to persist "worker" / "admin"; it now persists a role
  // KEY. A browser holding the old value would send `roleKey=worker`, match
  // nothing, and show an empty directory that looks like a data problem.
  // Drop anything the catalogue does not recognise, once it has loaded.
  useEffect(() => {
    if (roleCatalogue.length === 0) return;
    if (accessRole === "all" || accessRole === "client") return;
    if (roleCatalogue.some((r) => r.key === accessRole)) return;
    setAccessRole("all");
  }, [roleCatalogue, accessRole, setAccessRole]);

  /**
   * Which role a newly approved staff member starts with.
   *
   * FROM A SETTING, NOT A HARDCODED KEY. This read
   * `roleCatalogue.find((r) => r.key === "seedlings.worker")`. Naming a
   * specific role as a configurable DEFAULT is legitimate — unlike
   * deciding what somebody may do by role name — but as a constant it
   * breaks the moment an operator renames that role, deletes it, or
   * builds a structure that never contains it, and nothing on screen
   * would explain why approvals stopped granting anything.
   *
   * `STAFF_DEFAULT_ROLE_ID` holds the role id. Falling back to the
   * starter key keeps a database seeded before this setting existed
   * working, and resolving by id means a RENAME is now invisible here —
   * which is the point.
   */
  const [staffDefaultRoleId, setStaffDefaultRoleId] = useState<string | null>(null);
  useEffect(() => {
    apiGet<Array<{ key: string; value: string | null }>>("/api/settings")
      .then((rows) => {
        const row = rows.find((r) => r.key === "STAFF_DEFAULT_ROLE_ID");
        setStaffDefaultRoleId(row?.value?.trim() || null);
      })
      .catch(() => setStaffDefaultRoleId(null));
  }, []);
  const baselineStaffRole = useMemo(
    () =>
      (staffDefaultRoleId
        ? roleCatalogue.find((r) => r.id === staffDefaultRoleId)
        : null)
      ?? roleCatalogue.find((r) => r.key === "seedlings.worker")
      ?? null,
    [roleCatalogue, staffDefaultRoleId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Build users params
      const params = new URLSearchParams();
      if (status === "pending") params.set("approved", "false");
      if (status === "approved") params.set("approved", "true");
      // `roleKey`, not `role`. The endpoint takes a role's stable key and
      // honours inheritance, so "seedlings.worker" includes every admin and
      // super too — which is what the old role filter meant in practice,
      // since the tiers inherited. The old param name was ignored,
      // so this filter had stopped narrowing anything.
      if (accessRole !== "all" && accessRole !== "client") {
        params.set("roleKey", accessRole);
      }
      // "client" filter is applied client-side after fetch

      // Load users + holdings + compliance summary together.
      //
      // ASK FIRST, don't fire and catch. `/policies/user-compliance` is
      // guarded on `compliance.view`, and this used to call it for
      // everybody and swallow the 403 — so a caller holding `people.view`
      // alone took a guaranteed refusal on every load of this tab. It is
      // invisible in the UI (the chip just doesn't render) and it trips
      // the refusal interceptor, which reports a gate that disagrees with
      // its route. Checking the capability the endpoint is guarded on
      // gives the same screen without the refusal.
      const canSeeCompliance = !!effScope.can("compliance.view");
      // `/holdings` is `equipment.view`, which `people.view` does not
      // imply. This one was NOT caught, so for a role holding `people.view`
      // alone — Payroll, in the seeded set — the 403 rejected the whole
      // Promise.all and the tab rendered "Failed to load users" with no
      // list at all. The equipment column is the only thing it feeds.
      const canSeeHoldings = !!effScope.can("equipment.view");
      const [users, holdings, complianceSummary] = await Promise.all([
        apiGet<ApiUser[]>(
          `/api/users${params.toString() ? `?${params}` : ""}`
        ),
        canSeeHoldings
          ? apiGet<Holding[]>(`/api/holdings`)
          : Promise.resolve([] as Holding[]),
        canSeeCompliance
          ? apiGet<Array<{ userId: string; current: boolean; pendingCount: number }>>(
              `/api/policies/user-compliance`,
            ).catch(() => [] as Array<{ userId: string; current: boolean; pendingCount: number }>)
          : Promise.resolve([] as Array<{ userId: string; current: boolean; pendingCount: number }>),
      ]);

      setItems(users);

      // group holdings by userId for quick lookup
      const map: Record<string, Holding[]> = {};
      for (const h of holdings) {
        if (!map[h.userId]) map[h.userId] = [];
        map[h.userId].push(h);
      }
      setHoldingsByUser(map);

      // Index compliance summary by userId for O(1) chip lookup.
      const complianceMap: Record<string, { current: boolean; pendingCount: number }> = {};
      for (const c of complianceSummary) {
        complianceMap[c.userId] = { current: c.current, pendingCount: c.pendingCount };
      }
      setComplianceByUserId(complianceMap);
      setConfirm(null);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load users", err),
      });
    } finally {
      setLoading(false);
    }
  }, [status, accessRole]);

  useEffect(() => {
    void load();
  }, [load]);

  // General filters applied to every section (Pending / Team / Clients).
  // Worker-specific filters (workerTypeFilter) are
  // applied AFTER segmenting, only to the Team subset — they don't make
  // sense for clients or pending users.
  const filtered = useMemo(() => {
    let rows = items;
    // Read-only mode (Admin Directory → Users) renders pending users
    // but suppresses every mutation surface — the action buttons are
    // gated separately by `!readOnly` further down. Showing pending
    // sign-ups gives non-super holders of `people.manage` awareness of the queue without
    // letting them act on it; super holders of `people.manage` still see the same rows
    // with Approve / Decline buttons via the Users tab.
    // Client filter: approved, no roles
    if (accessRole === "client") {
      rows = rows.filter((u) => u.isApproved && !holdsAnyRole(u));
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((u) => {
        const name = (u.displayName ?? "").toLowerCase();
        const email = (u.email ?? "").toLowerCase();
        return name.includes(qlc) || email.includes(qlc);
      });
    }
    return rows;
  }, [items, q, accessRole, readOnly]);

  // Section predicates. Each user lands in exactly one of Pending / Team /
  // Clients (the three are mutually exclusive and exhaustive).
  //   Pending = not yet approved — pre-decision row.
  //   Team    = approved AND can see the work at all.
  //   Client  = approved AND holds no internal capability.
  //
  // `schedule.view` is the dividing line, and it is the right one: every
  // starter role from Trainee upward holds it, and a client holds nothing.
  // The old test named two enum values, which is why a
  // Trainee — who held neither — would have landed in Clients.
  // THE BOUNDARY IS THE PAYROLL GATE, NOT ROLE ABSENCE.
  //
  // These read `holdsAnyRole(u)`: hold nothing, be filed as a customer. A
  // new hire holds nothing, so every staff account awaiting its first grant
  // landed under Clients — where this tab hides the role controls, so the
  // one screen that grants a first role would not grant it to the people
  // who needed one. Four production accounts were stuck there.
  //
  // `isCustomerOnly` asks the real question (no worker type AND an active
  // client contact) and lives in lib/people.ts, shared with the Roles →
  // People view so the two screens cannot disagree about who is a customer.
  const isPendingUser = (u: ApiUser): boolean => !u.isApproved;
  const isTeamUser = (u: ApiUser): boolean => u.isApproved && !isCustomerOnly(u);
  const isClientUser = (u: ApiUser): boolean => u.isApproved && isCustomerOnly(u);

  const pendingUsers = useMemo(() => filtered.filter(isPendingUser), [filtered]);
  // Team gets the worker-specific filters layered on top. Clients and
  // pending users are never narrowed by workerType — a pay class is not a
  // thing a customer has.
  const teamUsers = useMemo(() => {
    let rows = filtered.filter(isTeamUser);
    if (workerTypeFilter !== "all") {
      if (workerTypeFilter === "unclassified") {
        rows = rows.filter((u) => !u.workerType && holdsAnyRole(u));
      } else {
        rows = rows.filter((u) => u.workerType === workerTypeFilter);
      }
    }
    return rows;
  }, [filtered, workerTypeFilter]);
  const clientUsers = useMemo(() => filtered.filter(isClientUser), [filtered]);

  /**
   * Grant a role, by id. Posts `{ customRoleId }` — the id, never a name,
   * because the operator may rename any role.
   *
   * GRANTS EXACTLY ONE ROLE. Roles inherit, so whatever the granted role
   * builds on comes with it. Granting a second "base" role alongside would
   * be this screen deciding policy that belongs to the role definition.
   */
  /**
   * Grant a role, or MOVE between rungs of the starter ladder.
   *
   * The two are different endpoints on purpose. A person holds at most one
   * rung, so picking a second is a replacement — and done as revoke + grant
   * there is a moment where they hold nothing, and a failure on the second
   * call leaves them demoted by what the operator clicked as a promotion.
   * `POST /users/:id/roles/move` does both halves in one transaction.
   */
  /**
   * Your own grants just moved, so what the app believes you may do is out
   * of date until `/api/me` is asked again. Only fires for YOUR row —
   * changing somebody else's roles does not change yours. Without it the
   * screen you just used to grant yourself a capability goes on insisting
   * you do not hold it.
   */
  function announceIfMine(userId: string) {
    if (!me?.id || userId !== me.id) return;
    try { window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT)); } catch { /* no listener is survivable */ }
  }

  async function addRole(userId: string, roleId: string, roleName: string, move = false) {
    try {
      if (move) {
        await apiPost(`/api/users/${userId}/roles/move`, { toRoleId: roleId });
        publishInlineMessage({ type: "SUCCESS", text: `Moved to ${roleName}` });
      } else {
        await apiPost(`/api/users/${userId}/roles`, { customRoleId: roleId });
        publishInlineMessage({ type: "SUCCESS", text: `Granted ${roleName}` });
      }
      announceIfMine(userId);
      load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Grant role failed.", err),
      });
    }
  }

  async function removeRole(userId: string, roleId: string, roleName: string) {
    try {
      await apiDelete(`/api/users/${userId}/roles/${roleId}`);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Removed ${roleName}`,
      });
      announceIfMine(userId);
      load();
    } catch (err: any) {
      // Detect a 409 regardless of fetch wrapper
      const status =
        err?.status ??
        err?.httpStatus ??
        err?.response?.status ??
        (/\b409\b/.test(String(err)) ? 409 : undefined);

      const msg =
        status === 409
          ? `This user currently has reserved or checked-out equipment. Release every item before removing ${roleName}.`
          : getErrorMessage("Remove role failed.", err);

      publishInlineMessage({
        type: "ERROR",
        text: msg,
      });
    }
  }

  const [workerTypeConfirm, setWorkerTypeConfirm] = useState<{ userId: string; workerType: string | null } | null>(null);
  // Remove-worker confirm — destructive enough to need an explicit modal
  // (vs. the inline bar used for Delete/Decline). Loses worker capabilities
  // but doesn't delete the user.
  /**
   * Revoking a grant. Role-agnostic, because the roles are rows an operator
   * owns — the previous version was hardcoded to "Remove Worker role?" and
   * spelled out that role's consequences, which stops being true the moment
   * somebody edits it.
   */
  const [revokeRoleConfirm, setRevokeRoleConfirm] = useState<
    {
      userId: string;
      roleId: string;
      roleName: string;
      displayName: string;
      /** Removing this would leave NOBODY able to grant roles in the app. */
      lastWayIn?: boolean;
    } | null
  >(null);
  const canGrantRoles = !!scope?.can?.("people.grant-roles");

  /**
   * WOULD THIS REMOVAL CLOSE THE DOOR BEHIND US?
   *
   * `people.grant-roles` is the capability that hands out every other one.
   * `customRoles.revoke` does not defend it — it deletes the grant and
   * returns — so if the last holder loses it, nobody can grant anything
   * from inside the app again and the way back is
   * `apps/api/scripts/grant-role.ts` at a terminal.
   *
   * That is recoverable, which is why this warns rather than refuses: an
   * operator is allowed to do deliberate things to their own account. It is
   * not obvious, which is why the warning makes them type.
   *
   * Reads `capabilities`, the set the SERVER resolved through inheritance,
   * rather than re-deriving it from role names here — the directory must
   * not hold a second opinion about what a role grants.
   */
  function isLastWayIn(userId: string, roleId: string): boolean {
    const target = items.find((x) => x.id === userId);
    if (!target) return false;
    const grantsIt = (target.capabilities ?? []).includes("people.grant-roles");
    if (!grantsIt) return false;
    // Do they hold it through some OTHER role as well? Then this one going
    // changes nothing about the door.
    const viaOthers = (target.roleGrants ?? [])
      .filter((g) => g.roleId !== roleId && !g.areaId)
      .some((g) => (roleCatalogue.find((r) => r.id === g.roleId)?.effective ?? [])
        .includes("people.grant-roles"));
    if (viaOthers) return false;
    // Anybody else still holding it company-wide?
    return !items.some(
      (other) =>
        other.id !== userId &&
        other.isApproved &&
        (other.capabilities ?? []).includes("people.grant-roles"),
    );
  }

  function promptWorkerType(userId: string, workerType: string | null) {
    setWorkerTypeConfirm({ userId, workerType });
  }

  async function confirmWorkerType() {
    if (!workerTypeConfirm) return;
    const { userId, workerType } = workerTypeConfirm;
    setWorkerTypeConfirm(null);
    try {
      await apiPatch(`/api/users/${userId}/worker-type`, { workerType });
      const label = workerType ? workerType.toLowerCase() : "unclassified";
      publishInlineMessage({ type: "SUCCESS", text: `Set as ${label}` });
      try { window.dispatchEvent(new Event("seedlings3:users-changed")); } catch {}
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Set worker type failed", err) });
    }
  }

  // toggleW9 was removed with the compliance-policy migration. W-9 is now
  // a PolicyDocument (workerAction = NONE + allowUploadOnBehalf) and
  // admin uploads via the Slice 4 Compliance tab's "upload on behalf" flow.

  // Owner-flag toggle (`settings.manage`). Singleton enforced server-side. We mirror
  // it client-side so the button doesn't render on users who can't take it
  // anyway — clicking would just 409 with OWNER_ALREADY_SET.
  const hasOwner = useMemo(() => items.some((u) => u.isOwner), [items]);
  const [ownerConfirm, setOwnerConfirm] = useState<{ userId: string; isOwner: boolean; displayName: string } | null>(null);

  async function confirmOwner() {
    if (!ownerConfirm) return;
    const { userId, isOwner } = ownerConfirm;
    setOwnerConfirm(null);
    try {
      await apiPatch(`/api/users/${userId}/owner`, { isOwner });
      publishInlineMessage({ type: "SUCCESS", text: isOwner ? "Flagged as LLC owner." : "Owner flag cleared." });
      try { window.dispatchEvent(new Event("seedlings3:users-changed")); } catch {}
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Owner flag update failed", err) });
    }
  }

  // setPrivilegeOverride IS GONE, with the endpoint it called.
  //
  // It PATCHed a per-person privileges endpoint, removed along with the
  // two columns it wrote — so every flick of those switches was a 404 that
  // rolled the optimistic update back, and the only sign was a toast. What
  // replaced it is not another toggle: granting a capability to one person is
  // granting them a ROLE that carries it, through `people.grant-roles`, which
  // leaves an audit row and shows up in a role list. The section below now
  // reports what someone holds and where it comes from.

  /**
   * Read the privilege off the server's capability set.
   *
   * This used to resolve it here: admin-or-super wins, else a per-user
   * override column, else a default by worker type. All three inputs are
   * gone. The columns were dropped (a per-person tick is what the role model
   * forbids — an exception is a NAMED ROLE, visible in a role list, not a
   * hidden toggle on a profile), and worker type no longer decides anything
   * about authorization.
   *
   * There is now one answer, computed once on the server, and this reads it.
   */
  function resolveEffective(u: ApiUser, key: "canPullInventory" | "canChargeBusinessExpenses"): boolean {
    const cap = key === "canPullInventory" ? "inventory.pull" : "expenses.charge";
    return (u.capabilities ?? []).includes(cap);
  }

  // Hard delete (DB + Clerk) — used for both Delete and Decline confirmations
  async function deleteUser(userId: string) {
    try {
      await apiDelete(`/api/users/${userId}`);
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
      publishInlineMessage({
        type: "SUCCESS",
        text: `User removed`,
      });
      load();
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Remove failed", err),
      });
    }
  }

  return (
    <Box w="full">
      <TabExplainer explainerId={`seedlings:usersTab:guideOpen:${canApproveSignups ? "super" : "admin"}`}>
        <ExplainerText>
          Everyone with an account, including sign-ups waiting to be approved — so you know
          who is here and who is queued. Until a sign-up is approved they cannot use the app
          at all.
        </ExplainerText>
        <ExplainerText>
          Worker type is not a label: it decides how someone is paid. Employees are made
          whole when a client underpays and are paid through payroll with tax withheld;
          contractors take a short payment pro-rata and are paid 1099; an unpaid person
          never reaches payroll at all. It is a separate question from which roles they
          hold — changing one never changes the other.
        </ExplainerText>
        {/* Say so when the queue is visible but not actionable. The pending
            rows render for anyone who can see the directory, so without
            this someone reads a queue they cannot clear and goes looking
            for a button that was never rendered for them. */}
        {!canApproveSignups && (
          <ExplainerText>
            Pending sign-ups are <Em>Read-only for you</Em> — approving one needs the
            sign-up approval permission, which is granted separately from seeing the
            directory.
          </ExplainerText>
        )}
        <CapabilitySection capability="people.approve" scope={scope}>
          <ExplainerText>
            <Em>Approving a new sign-up is yours alone</Em> — you also set worker type
            from here.
          </ExplainerText>
        </CapabilitySection>
      </TabExplainer>
      {/* Filters */}
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-subtle)" }}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="user-search"
          placeholder="Search…"
        />
        {/* Status filter — hidden in read-only mode since pending users
         *  are excluded from the list entirely. Approved-only is the
         *  only meaningful view for read-only holders of `people.manage`. */}
        {!readOnly && <Select.Root
          collection={statusFilterCollection}
          value={[status]}
          onValueChange={(e) => setStatus(e.value[0] as Status)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: status !== "all" ? "var(--chakra-colors-blue-muted)" : "var(--chakra-colors-blue-subtle)", border: status !== "all" ? "1px solid var(--chakra-colors-blue-strong)" : "1px solid var(--chakra-colors-blue-emphasized)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>}
        <Select.Root
          collection={roleFilterCollection}
          value={[accessRole]}
          onValueChange={(e) => setAccessRole(e.value[0] as "all" | "worker" | "admin")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: accessRole !== "all" ? "var(--chakra-colors-purple-muted)" : "var(--chakra-colors-purple-subtle)", border: accessRole !== "all" ? "1px solid var(--chakra-colors-purple-strong)" : "1px solid var(--chakra-colors-purple-emphasized)", borderRadius: "6px" }}>
              <Shield size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {roleFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={workerTypeFilterCollection}
          value={[workerTypeFilter]}
          onValueChange={(e) => setWorkerTypeFilter(e.value[0] ?? "all")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: workerTypeFilter !== "all" ? "var(--chakra-colors-orange-muted)" : "var(--chakra-colors-orange-subtle)", border: workerTypeFilter !== "all" ? "1px solid var(--chakra-colors-orange-strong)" : "1px solid var(--chakra-colors-orange-emphasized)", borderRadius: "6px" }}>
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {workerTypeFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => setShowInfoOverlay(true)}
          title="Role & type information"
        >
          <Info size={14} />
        </Button>
      </HStack>
      {(status !== "all" || accessRole !== "all" || workerTypeFilter !== "all") && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {status !== "all" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {statusFilterItems.find((i) => i.value === status)?.label}
            </Badge>
          )}
          {accessRole !== "all" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {roleFilterItems.find((i) => i.value === accessRole)?.label}
            </Badge>
          )}
          {workerTypeFilter !== "all" && (
            <Badge size="sm" colorPalette="orange" variant="solid">
              {workerTypeFilterItems.find((i) => i.value === workerTypeFilter)?.label}
            </Badge>
          )}
          {!(status === "all" && accessRole === "all" && workerTypeFilter === "all") && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setStatus("all");
                setAccessRole("all");
                setWorkerTypeFilter("all");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {/* List */}
      {loading && <LoadingCenter />}
      {!loading && filtered.length === 0 && (
        <Box textAlign="center" py={6}>
          <Text color="fg.muted">No users match the current filters.</Text>
          <Button
            size="sm"
            variant="outline"
            mt={2}
            onClick={() => {
              setStatus("all");
              setAccessRole("all");
              setWorkerTypeFilter("all");
              setQ("");
            }}
          >
            Clear filters
          </Button>
        </Box>
      )}
      {!loading && filtered.length > 0 && (() => {
        const renderUserCard = (u: ApiUser) => {
          const isMe = !!me?.id && u.id === me.id;
          // Same rule as the section split above — a roleless staff account
          // is staff, and must keep its role-granting controls.
          const isClient = u.isApproved && isCustomerOnly(u);
          // Kept separate and named for what it asks. The old single `staff`
          // flag meant "holds a role" but was READ as "is staff" in eight
          // places, which is how a new hire lost the controls that would
          // have made them one.
          const hasRole = holdsAnyRole(u);
          const showDecline = !u.isApproved && !isMe;

          const isConfirming = confirm?.userId === u.id;
          const confirmKind = confirm?.kind;

          const confirmCopy =
            confirmKind === "decline"
              ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
              : "Delete this user? This removes their account and Clerk entry. This action cannot be undone.";

          const confirmCTA =
            confirmKind === "decline" ? "Confirm decline" : "Confirm delete";

          const isContractor = u.workerType === "CONTRACTOR";
          const isEmployee = u.workerType === "EMPLOYEE";
          // Field clearance is `work.claim` — the capability the Worker
          // role adds on top of Trainee. (Both are ROLES; the worker type
          // is a separate field.) The old read went through a `privileges`
          // object this endpoint does not return, so it was always
          // `undefined` and every single row rendered as not cleared.
          const notFieldCleared = !(u.capabilities ?? []).includes("work.claim");
          const displayName = u.displayName || u.email;
          // WHETHER THE EDITABLE "ROLES" SECTION IS ON SCREEN for this row.
          // It is the same condition the section itself is rendered under,
          // kept here because the badge strip below has to know: with both
          // showing, every role appeared twice on the same card, once as a
          // status chip and once as a removable one a few pixels below.
          // Not a copy of the rule by choice — the section sits inside a
          // branch too deep to lift, so the two must be changed together.
          const rolesSectionShown =
            !readOnly && meReady && !isMe && u.isApproved && !isClient && canGrantRoles;

          return (
            <Box
              key={u.id}
              p={3}
              borderWidth="1px"
              borderRadius="lg"
              mb={3}
              w="full"
            >
              <VStack align="stretch" gap="3" w="full">
                <Box>
                  <HStack gap="8px" wrap="wrap" align="center">
                    <Text fontSize="sm" fontWeight="semibold">
                      {displayName || "(no name)"}
                    </Text>
                    {displayName !== u.email && (
                      // Orange inside PENDING SIGN-UPS, default elsewhere.
                      // The unapproved rows are exactly what that orange
                      // section renders, so `!u.isApproved` IS "in the
                      // pending section" — a default blue-grey chip read
                      // as foreign against the orange frame, the same
                      // clash the Approve button was already fixed for.
                      <Badge
                        colorPalette={u.isApproved ? undefined : "orange"}
                        variant={u.isApproved ? undefined : "solid"}
                        bg={u.isApproved ? undefined : "orange.muted"}
                        color={u.isApproved ? undefined : "orange.fg"}
                      >
                        {u.email}
                      </Badge>
                    )}
                  </HStack>

                  <HStack gap="2" mt={2} flexWrap="wrap">
                    <Badge colorPalette="green">
                      {u.isApproved ? "Approved" : "Pending"}
                    </Badge>
                    {/* THE ROLES THEY ACTUALLY HOLD, by name. This was three
                        fixed badges — Worker, Admin, Super — read off three
                        capabilities, so a Bookkeeper showed up wearing none
                        of them and a role the operator built themselves was
                        invisible in the directory that lists it. An
                        area-scoped grant says which area.
                        SHOWN ONLY WHERE THE ROLES SECTION IS NOT. These
                        still carry the whole weight on the rows that have
                        no section: a client, yourself, a pending sign-up,
                        the read-only Directory, and anyone whose viewer
                        lacks `people.grant-roles`. Where the section does
                        render it says the same thing and lets you act on
                        it, so this strip would only be repeating it. */}
                    {!rolesSectionShown && (u.roleGrants ?? []).map((g) => (
                      <Badge
                        key={`${g.roleId}:${g.areaId ?? ""}`}
                        colorPalette={g.areaId ? "teal" : "purple"}
                        variant={g.isTemporary ? "outline" : "subtle"}
                      >
                        {g.areaName ? `${g.name} — ${g.areaName}` : g.name}
                      </Badge>
                    ))}
                    {u.isOwner && <Badge colorPalette="purple" variant="solid">LLC Owner</Badge>}
                    {isClient && <Badge colorPalette="green">Client</Badge>}
                    {isEmployee && <Badge colorPalette="blue">Employee</Badge>}
                    {isContractor && <Badge colorPalette="orange">Contractor</Badge>}
                    {notFieldCleared && <Badge colorPalette="cyan">No field clearance</Badge>}
                    {!u.workerType && !isClient && <Badge colorPalette="gray" variant="outline">Unclassified</Badge>}
                    {/* Compliance chip. Sourced from the bulk
                        /policies/user-compliance endpoint. Counts
                        BLOCK-enforcement policies where the worker is
                        missing a current signature — i.e., things that
                        actually gate their work (workday start, job
                        claim, equipment reserve). WARN/INFO misses are
                        excluded on purpose so this chip only lights up
                        for issues that stop the worker from working. See
                        the Compliance sign matrix for the full paperwork
                        picture. */}
                    {complianceByUserId[u.id] && (
                      complianceByUserId[u.id].pendingCount > 0 ? (
                        <HStack gap={1}>
                          <Badge
                            colorPalette="red"
                            variant="solid"
                            title="Number of BLOCK-enforcement policies still preventing this worker from starting a workday, claiming jobs, or reserving equipment. Non-blocking WARN/INFO misses aren't counted — see the sign matrix for the full paperwork picture."
                          >
                            Compliance blocks: {complianceByUserId[u.id].pendingCount}
                          </Badge>
                          <NudgeUserButton userId={u.id} hasPending={true} />
                        </HStack>
                      ) : (
                        <Badge
                          colorPalette="green"
                          variant="subtle"
                          title="No BLOCK-enforcement policies are currently gating this worker. They may still have optional (WARN/INFO) items showing on their compliance tab — see the sign matrix."
                        >
                          Compliance: cleared
                        </Badge>
                      )
                    )}
                  </HStack>
                </Box>

                {/* Actions — each needs its own entitlement
                    (`people.manage`, `people.approve`,
                    `people.grant-roles`, `settings.manage` for the owner
                    flag). In
                 *  read-only mode (Admin Directory → Users) the card
                 *  renders identity badges only, no buttons. */}
                {!readOnly && meReady && (
                  <Stack
                    direction="row"
                    gap="2"
                    flexWrap="wrap"
                    justify="flex-start"
                  >
                    {/* YOUR OWN CARD GETS THE ROLE SECTION TOO.
                        This was `{isMe ? null : …}`, which hid the whole
                        block from you — so the one person who holds
                        `people.grant-roles` could grant a role to anybody
                        except themselves, and had to reach for
                        `scripts/grant-role.ts` to change their own. Nothing
                        about `people.grant-roles` says "other people":
                        somebody trusted to put a role on anyone is trusted
                        to take one off themselves.
                        The approve/decline branch below is unreachable for
                        yourself anyway — you are signed in, so approved —
                        and Delete carries its own `!isMe`. What self-
                        service needs is not a hidden control but a louder
                        confirmation, which is what `lastWayIn` builds. */}
                    {(
                      <>
                        {!u.isApproved ? (
                          <>
                            <Button
                              size={{ base: "xs", md: "sm" }}
                              // Dark orange, not the default black. It sits
                              // inside the orange PENDING SIGN-UPS section,
                              // and a black solid button read as unrelated
                              // to the frame around it. orange.600 keeps it
                              // clearly the primary action against the
                              // section's orange.200 band.
                              colorPalette="orange"
                              variant="solid"
                              bg="orange.600"
                              _hover={{ bg: "orange.700" }}
                              _active={{ bg: "orange.800" }}
                              onClick={() =>
                                setApproveClientTarget({
                                  id: u.id,
                                  displayName: u.displayName ?? null,
                                  email: u.email ?? null,
                                })
                              }
                            >
                              Approve as Client
                            </Button>
                            <Button
                              size={{ base: "xs", md: "sm" }}
                              variant="ghost"
                              onClick={() =>
                                setApproveWorkerTarget({
                                  userId: u.id,
                                  displayName: u.displayName || u.email || "this user",
                                  email: u.email || "",
                                })
                              }
                              disabled={!u.email}
                              title={!u.email ? "User has no email on file — cannot use typed-email confirmation." : "Approve this pending sign-up as a Worker"}
                            >
                              Approve as Worker
                            </Button>
                            {!isConfirming && showDecline && (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                variant="outline"
                                colorPalette="red"
                                onClick={() =>
                                  setConfirm({ userId: u.id, kind: "decline" })
                                }
                                title="Decline and remove this user"
                              >
                                Decline
                              </Button>
                            )}
                          </>
                        ) : (
                          <>
                            {/* Role toggles */}
                            {/* GRANTING IS A PICKER, NOT FOUR BUTTONS.
                                "Make Admin" / "Add Worker" / "Remove Admin"
                                / "Remove Worker" named four rows of a table
                                an operator can rename, redefine or delete —
                                and they posted the deleted enum, so none of
                                them worked. What a person holds is now the
                                badges below, each removable, plus a picker
                                of everything they do not hold yet. */}
                            {!isClient && canGrantRoles && (
                              <RoleGrantControls
                                user={u}
                                catalogue={roleCatalogue}
                                onGrant={(roleId, roleName, move) =>
                                  addRole(u.id, roleId, roleName, move)
                                }
                                onRevokeRequest={(roleId, roleName) =>
                                  setRevokeRoleConfirm({
                                    userId: u.id,
                                    roleId,
                                    roleName,
                                    displayName: u.displayName || u.email || "this user",
                                    lastWayIn: isLastWayIn(u.id, roleId),
                                  })
                                }
                              />
                            )}
                            {/* HOLDS ROLES, HAS NO PAY CLASS — can do nothing.
                                `can()` returns false for a null worker type
                                before it reads a single role (G31), so this
                                account signs in to the no-access screen while
                                its row here shows role badges. Nothing else on
                                this page contradicts those badges, which is how
                                one production account sat in this state for
                                three weeks: the person who granted the role saw
                                the grant succeed and had no reason to look
                                further.
                                The approval dialog now requires a pay class, so
                                new accounts cannot land here. This is for the
                                ones that already did, and for a type cleared by
                                hand afterwards. */}
                            {!isClient
                              && u.isApproved
                              && !u.workerType
                              && u.roleGrants.length > 0 && (
                              <Box
                                mt={1}
                                px={2}
                                py={1.5}
                                bg="red.faint"
                                borderWidth="1px"
                                borderColor="red.emphasized"
                                rounded="md"
                              >
                                <Text fontSize="xs" color="red.fg" fontWeight="semibold">
                                  No pay class — this person can do nothing
                                </Text>
                                <Text fontSize="xs" color="red.fg">
                                  They hold {u.roleGrants.length === 1 ? "a role" : `${u.roleGrants.length} roles`},
                                  but every permission resolves to nothing until their worker type
                                  is set. Set it on their profile.
                                </Text>
                              </Box>
                            )}
                            {/* WHY they hold it, not just what. Reads
                                `GET /users/:id/effective-permissions`, which
                                names both the role HELD and the role the
                                entitlement is WRITTEN ON — the difference
                                between editing the right role and the
                                wrong one. Gated on `people.manage`, which
                                is what the route requires. */}
                            {!isClient && (
                              <EffectivePermissions
                                userId={u.id}
                                canRead={!!scope?.can?.("people.manage")}
                              />
                            )}
                            {u.isApproved &&
                              !hasRole &&
                              !isMe &&
                              !isConfirming && (
                                <Button
                                  size={{ base: "xs", md: "sm" }}
                                  variant="outline"
                                  colorPalette="red"
                                  onClick={() =>
                                    setConfirm({ userId: u.id, kind: "delete" })
                                  }
                                  title="Remove this user completely"
                                  disabled={!canApproveSignups}
                                >
                                  Delete
                                </Button>
                              )}
                          </>
                        )}
                      </>
                    )}
                    {/* Worker type & W-9 — available for all users including self */}
                    {!isClient && u.workerType !== "UNPAID" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, "UNPAID")}
                        variant="outline"
                        colorPalette="purple"
                      >
                        {/* The label said "Set Trainee" while the action set
                            UNPAID. The old worker type of that name was a
                            restricted EMPLOYEE, paid like any other W-2;
                            UNPAID means never paid at all. Clicking this to
                            mark a new hire as a trainee quietly took them
                            out of payroll.
                            Trainee is a ROLE — granted on the
                            Roles tab, which is a different field. */}
                        Set Unpaid
                      </Button>
                    )}
                    {!isClient && u.workerType !== "CONTRACTOR" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, "CONTRACTOR")}
                        variant="outline"
                        colorPalette="orange"
                      >
                        Set Contractor
                      </Button>
                    )}
                    {!isClient && u.workerType !== "EMPLOYEE" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, "EMPLOYEE")}
                        variant="outline"
                        colorPalette="blue"
                      >
                        Set Employee
                      </Button>
                    )}
                    {!isClient && u.workerType != null && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, null)}
                        variant="outline"
                        colorPalette="gray"
                      >
                        Unclassify
                      </Button>
                    )}
                    {/* "Collect W-9" button removed with the compliance-policy
                        migration. W-9 is now a PolicyDocument with
                        workerAction = NONE + allowUploadOnBehalf; the
                        Slice 4 Compliance tab surfaces the upload-on-behalf
                        flow with a full audit trail and versioning. */}
                    {/* LLC-owner toggle. `settings.manage` — the route enforces it
                        too. Singleton: only one user can hold the flag, so
                        once any user is flagged, the "Set as Owner" button
                        is hidden on everyone else (server would 409 anyway).
                        The current owner keeps the "Owner ✓" button so they
                        can be unflagged. */}
                    {canApproveSignups && (u.isOwner || !hasOwner) && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => setOwnerConfirm({ userId: u.id, isOwner: !u.isOwner, displayName: u.displayName ?? u.email ?? u.id })}
                        variant={u.isOwner ? "subtle" : "outline"}
                        colorPalette={u.isOwner ? "purple" : "gray"}
                      >
                        {u.isOwner ? "Owner ✓" : "Set as Owner"}
                      </Button>
                    )}
                  </Stack>
                )}

                {/* Permissions — collapsed by default. Header toggles open;
                    body shows the same per-permission switches as before.
                    Read-only mode renders the switches in their current
                    state but disabled, so holders of people authority can see what's granted
                    without being able to mutate it. */}
                {!isClient && (() => {
                  const open = permsOpen.has(u.id);
                  return (
                    <Box mt={3} pt={3} borderTopWidth="1px" borderColor="gray.emphasized">
                      <HStack
                        gap={1}
                        cursor="pointer"
                        onClick={() => {
                          setPermsOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.id)) next.delete(u.id);
                            else next.add(u.id);
                            return next;
                          });
                        }}
                        _hover={{ color: "fg" }}
                        color="fg.muted"
                        userSelect="none"
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <Text fontSize="xs" fontWeight="medium">
                          Permissions
                        </Text>
                      </HStack>
                      {open && (
                        <VStack align="stretch" gap={2} mt={2}>
                          {[
                            {
                              key: "canPullInventory" as const,
                              label: "Use company supplies",
                              help: "Pull from already-purchased inventory on jobs they've claimed.",
                            },
                            {
                              key: "canChargeBusinessExpenses" as const,
                              label: "Charge business expenses",
                              help: "Record new expenses paid on the company account (gas, parts, etc.).",
                            },
                          ].map((perm) => {
                            // One answer, from the server. `grantedByRole`
                            // used to mean "admin or super, so assume yes"
                            // and shadow the real value; the capability set
                            // already accounts for every role they hold,
                            // inheritance included.
                            const effective = resolveEffective(u, perm.key);
                            return (
                              <HStack
                                key={perm.key}
                                justify="space-between"
                                align="flex-start"
                                gap={3}
                              >
                                <Box flex="1" minW={0}>
                                  <Text fontSize="sm" fontWeight="medium">
                                    {perm.label}
                                  </Text>
                                  <Text fontSize="xs" color="fg.muted">
                                    {effective
                                      ? "Granted by a role this person holds."
                                      : perm.help}
                                  </Text>
                                </Box>
                                {/* REPORTED, NOT EDITED. This was a Switch
                                    writing a per-person override column —
                                    both the column and its endpoint are
                                    gone, so the control could only 404.
                                    Changing this for one person means
                                    granting them a role that carries it. */}
                                <Badge
                                  size="sm"
                                  colorPalette={effective ? "green" : "gray"}
                                  flexShrink={0}
                                >
                                  {effective ? "Granted" : "Not granted"}
                                </Badge>
                              </HStack>
                            );
                          })}
                        </VStack>
                      )}
                    </Box>
                  );
                })()}
              </VStack>

              {isConfirming && (
                <HStack
                  mt={3}
                  align="center"
                  p={3}
                  borderRadius="md"
                  borderWidth="1px"
                  borderColor="red.emphasized"
                  bg="red.faint"
                  justify="space-between"
                  flexWrap="wrap"
                  gap="2"
                >
                  <Text
                    fontSize="sm"
                    color="red.fg"
                    flex="1 1 auto"
                    minW="220px"
                  >
                    {confirmCopy}
                  </Text>
                  <HStack gap="2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      colorPalette="red"
                      onClick={() => deleteUser(u.id)}
                    >
                      {confirmCTA}
                    </Button>
                  </HStack>
                </HStack>
              )}

              {(holdingsByUser[u.id]?.length ?? 0) > 0 && (
                <Stack direction="row" gap="2" flexWrap="wrap" mt={2} w="full">
                  {holdingsByUser[u.id].map((h) => (
                    <Badge
                      key={h.equipmentId}
                      onClick={() =>
                        openEventSearch(
                          "activityTavToEquipmentTabQRCodeSearch",
                          h.qrSlug || "",
                        )
                      }
                      variant="subtle"
                      colorPalette={equipmentStatusColor(h.state)}
                      css={{ whiteSpace: "normal", wordBreak: "break-word", maxWidth: "100%" }}
                      fontSize="xs"
                    >{`${h.shortDesc} (${h.qrSlug}) - ${prettyStatus(h.state)}`}</Badge>
                  ))}
                </Stack>
              )}

              {/* Sign-ins & activity. readOnly is true in a caller with `people.manage`
                  Directory → Users surface, false in Users; the API
                  route also requires `audit.view` as a second line of
                  defense. */}
              {!readOnly && (
                <UserActivitySection userId={u.id} lastSignInAt={u.lastSignInAt ?? null} />
              )}
            </Box>
          );
        };

        // Section header — collapsible, shows the group name + count.
        // Made visually prominent: larger type, taller, accent-colored band
        // on the left so the three sections clearly separate the directory
        // into distinct piles instead of looking like sub-rows.
        const SectionHeader = ({ label, count, open, onToggle, accent }: { label: string; count: number; open: boolean; onToggle: () => void; accent: string }) => (
          <HStack
            gap={2}
            mb={2}
            mt={4}
            px={3}
            py={2}
            cursor="pointer"
            onClick={onToggle}
            borderRadius="md"
            bg="gray.subtle"
            borderWidth="1px"
            borderColor="gray.emphasized"
            borderLeftWidth="4px"
            borderLeftColor={accent}
            _hover={{ bg: "gray.muted" }}
            userSelect="none"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Text fontSize="sm" fontWeight="semibold" textTransform="uppercase" letterSpacing="wide">
              {label} ({count})
            </Text>
          </HStack>
        );

        return (
          <>
            {/* Pending sign-ups — `people.approve`, and the shared section frame.
                Approving an account is someone with sign-up approval action; showing someone with people authority a
                queue they cannot act on was an invitation to ask why the
                buttons did nothing. Team and Clients below stay plain
                SectionHeaders: those are groupings of the directory, not
                work blocked on the operator. */}
            {canApproveSignups && (
              <Box mt={4} mb={3}>
                <Dashboard
                  storageKey="seedlings:usersTab:pendingOpen"
                  title={`Pending sign-ups (${pendingUsers.length})`}
                  icon={UserPlus}
                  variant="attention"
                  count={pendingUsers.length}
                  /* Pulses only when someone is actually waiting — this
                     section stays on screen at zero so the pile is still
                     visibly part of the directory. */
                  forceGlow={pendingUsers.length > 0 ? "orange" : undefined}
                  onRefresh={load}
                  refreshing={loading}
                >
                  {pendingUsers.length === 0 ? (
                    <Text fontSize="sm" color="fg.muted">No pending sign-ups.</Text>
                  ) : (
                    pendingUsers.map(renderUserCard)
                  )}
                </Dashboard>
              </Box>
            )}
            <SectionHeader
              label="Team"
              count={teamUsers.length}
              open={teamSectionOpen}
              onToggle={() => setTeamSectionOpen((v) => !v)}
              accent="blue.500"
            />
            {teamSectionOpen && (
              teamUsers.length === 0
                ? <Text fontSize="sm" color="fg.muted" pl={2} mb={3}>No team members match the current filters.</Text>
                : teamUsers.map(renderUserCard)
            )}
            <SectionHeader
              label="Clients"
              count={clientUsers.length}
              open={clientSectionOpen}
              onToggle={() => setClientSectionOpen((v) => !v)}
              accent="green.500"
            />
            {clientSectionOpen && (
              clientUsers.length === 0
                ? <Text fontSize="sm" color="fg.muted" pl={2} mb={3}>No clients match the current filters.</Text>
                : clientUsers.map(renderUserCard)
            )}
          </>
        );
      })()}
      <ConfirmDialog
        open={!!workerTypeConfirm}
        title="Change Worker Type"
        message={`Are you sure you want to set this worker as ${workerTypeConfirm?.workerType?.toLowerCase() ?? "unclassified"}?`}
        confirmLabel="Confirm"
        onConfirm={confirmWorkerType}
        onCancel={() => setWorkerTypeConfirm(null)}
      />
      <ConfirmDialog
        open={!!ownerConfirm}
        title={ownerConfirm?.isOwner ? "Flag as LLC Owner" : "Clear Owner Flag"}
        message={
          ownerConfirm?.isOwner
            ? `Flag ${ownerConfirm?.displayName} as the LLC owner? Their job earnings will continue to be tracked but will be EXCLUDED from Gusto payroll and QB labor-expense exports. Only one user can hold this flag.`
            : `Clear the LLC-owner flag from ${ownerConfirm?.displayName}? Future job earnings for this user will appear in Gusto/QB exports like any other worker.`
        }
        confirmLabel="Confirm"
        onConfirm={confirmOwner}
        onCancel={() => setOwnerConfirm(null)}
      />
      <ConfirmDialog
        open={!!revokeRoleConfirm}
        title={revokeRoleConfirm ? `Remove ${revokeRoleConfirm.roleName}?` : "Remove role?"}
        message={
          revokeRoleConfirm
            ? (revokeRoleConfirm.lastWayIn
                ? `${revokeRoleConfirm.roleName} is the last thing granting ` +
                  `"put a role on a person" to anyone in this business. Take it away and ` +
                  `NOBODY can grant a role from inside the app again — including this one, ` +
                  `back to ${revokeRoleConfirm.displayName}. The only way back in is running ` +
                  `apps/api/scripts/grant-role.ts at a terminal with database access. ` +
                  `Everything else that role grants goes too.`
                : `Take ${revokeRoleConfirm.roleName} away from ${revokeRoleConfirm.displayName}? ` +
                  `They lose everything that role grants, including anything it inherits, ` +
                  `and any screen that needed it disappears for them. Their account stays and ` +
                  `the role can be granted again. If they are holding equipment this will be refused ` +
                  `until it is released.`)
            : ""
        }
        confirmLabel={revokeRoleConfirm?.lastWayIn ? "Remove it anyway" : "Remove role"}
        confirmColorPalette="red"
        /* THE SECOND APPROVAL. An ordinary revoke is one click behind this
           dialog. The one that leaves nobody able to grant roles asks the
           operator to type the words as well — the same device the prod
           migration script uses for the irreversible step. It is a warning
           and not a refusal because it IS recoverable, and because an
           operator is allowed to do deliberate things to their own
           account. */
        requiredInputValue={revokeRoleConfirm?.lastWayIn ? "LOCK ME OUT" : undefined}
        inputLabel={
          revokeRoleConfirm?.lastWayIn
            ? "Type LOCK ME OUT to confirm"
            : undefined
        }
        inputPlaceholder={revokeRoleConfirm?.lastWayIn ? "LOCK ME OUT" : undefined}
        onConfirm={async () => {
          const target = revokeRoleConfirm;
          setRevokeRoleConfirm(null);
          if (target) await removeRole(target.userId, target.roleId, target.roleName);
        }}
        onCancel={() => setRevokeRoleConfirm(null)}
      />

      {/* Roles & Types Info Overlay */}
      <Dialog.Root open={showInfoOverlay} onOpenChange={(e) => { if (!e.open) setShowInfoOverlay(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg" maxH="80vh" overflowY="auto">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Roles & Worker Types</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={4}>
                  <Box>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Roles</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      A role is a named set of permissions that you build. There are no
                      fixed roles in the app — the three that used to be here (Worker,
                      Admin, Super) are gone, and nothing is hard-coded in their place.
                    </Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Text fontSize="sm">
                      Each role lists the things somebody holding it may do — see the
                      schedule, approve a payment, manage equipment, and so on. A role can
                      also inherit from another, so it starts with everything that one
                      allows and adds to it. Build and edit them on the Roles tab.
                    </Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Text fontSize="sm">
                      A person can hold more than one role, and holding more only ever adds.
                      What they may do is the union of every role they hold; a tab appears
                      for them when one of their roles allows something on it. A grant can
                      also be limited to an <Em>area</Em>, in which case it applies there
                      and nowhere else.
                    </Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Text fontSize="sm">
                      Somebody with no role at all is a <Em>client</Em> — a customer with a
                      login and no part in running the business.
                    </Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Worker Types</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      Separate from roles. A worker type says how somebody is PAID, not
                      what they may do — the two are deliberately different fields, so
                      changing one never silently changes the other.
                    </Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="gray.emphasized">
                    <Badge colorPalette="gray" variant="outline" mb={1}>Unclassified</Badge>
                    <Text fontSize="sm">No worker type assigned yet. Nothing can pay them: the money system refuses to price a worker with no pay class, so they cannot hold a paid seat on a visit and can only be added as an observer. Classify them before putting them on work.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="purple.emphasized">
                    <Badge colorPalette="purple" mb={1}>Unpaid</Badge>
                    <Text fontSize="sm">Has real access to the app and no place in payroll — a family member or an observer. Never appears in a payout, an export or the payroll-tax base. Like Unclassified, they can only join a visit as an observer.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.emphasized">
                    <Badge colorPalette="blue" mb={1}>Employee (W-2)</Badge>
                    <Text fontSize="sm">Full access. Can claim any job including high-value. Can reserve any equipment. No insurance requirement. No platform fee on payments. No contractor agreement required.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="orange.emphasized">
                    <Badge colorPalette="orange" mb={1}>Contractor (1099)</Badge>
                    <Text fontSize="sm">Must acknowledge a contractor agreement every time they claim a job. Can claim standard jobs without insurance. High-value jobs and insurance-flagged equipment require a valid insurance certificate. Platform fee (configured in Settings) is deducted from their payment splits after expenses. Admin tracks W-9 collection and insurance expiration.</Text>
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button
                    size="sm"
                    onClick={() => setShowInfoOverlay(false)}
                  >
                    Close
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Approve as Worker — typed-email confirmation modal.
       *
       *  Worker approval grants access to every job, payment, equipment
       *  checkout, and crew schedule across the business. Mis-tapping
       *  this for a client sign-up would expose internal data to an
       *  external party. The friction here (re-type the email exactly)
       *  prevents accidental approval — the operator must read the
       *  email, copy or re-type it, and only THEN can the Confirm
       *  button enable. See ConfirmDialog.requiredInputValue.
       */}
      <ConfirmDialog
        open={approveWorkerTarget !== null}
        title="Approve as Worker?"
        message=""
        messageNode={
          approveWorkerTarget ? (
            <VStack align="stretch" gap={2}>
              <Box p={3} bg="gray.faint" rounded="md" borderWidth="1px" borderColor="gray.emphasized">
                <Text fontSize="sm" color="fg.muted">User</Text>
                <Text fontSize="md" fontWeight="semibold">{approveWorkerTarget.displayName}</Text>
                <Text fontSize="sm" color="fg.muted" fontFamily="mono">{approveWorkerTarget.email}</Text>
              </Box>
              <Text fontSize="sm">
                {baselineStaffRole
                  ? `This admits them to the business and grants ${baselineStaffRole.name} — the starting role for staff. Whatever that role currently grants, they get. Undoing it is two steps: remove the role, then decide whether the account should stay.`
                  : "This admits them to the business. No role is granted, because the starting staff role is missing from the role list — grant one from the picker on their row afterwards, or they will see nothing."}
              </Text>
              <Box>
                <Text fontSize="sm" fontWeight="semibold" mb={1}>
                  How are they paid? <Text as="span" color="red.fg">*</Text>
                </Text>
                <Text fontSize="xs" color="fg.muted" mb={2}>
                  Required. Without a pay class the account resolves to no access at
                  all, whatever role it holds — so approving without one creates a
                  person who can sign in and do nothing.
                </Text>
                <Select.Root
                  collection={approveWorkerTypeCollection}
                  size="sm"
                  value={approveWorkerType ? [approveWorkerType] : []}
                  onValueChange={(e) => setApproveWorkerType(e.value[0] ?? "")}
                >
                  <Select.HiddenSelect />
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Choose a pay class" />
                    </Select.Trigger>
                    <Select.IndicatorGroup>
                      <Select.Indicator />
                    </Select.IndicatorGroup>
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content>
                        {approveWorkerTypeCollection.items.map((o) => (
                          <Select.Item item={o} key={o.value}>
                            {o.label}
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
              </Box>
            </VStack>
          ) : null
        }
        warning={
          approveWorkerTarget
            ? `If you intended to approve "${approveWorkerTarget.displayName}" as a Client (an external account with no operational access), cancel this dialog and click "Approve as Client" instead.`
            : undefined
        }
        confirmLabel={approveWorkerBusy ? "Approving..." : "Approve as Worker"}
        confirmColorPalette="red"
        inputLabel={approveWorkerTarget ? `Type the email "${approveWorkerTarget.email}" to confirm` : undefined}
        inputPlaceholder={approveWorkerTarget?.email ?? ""}
        requiredInputValue={approveWorkerTarget?.email ?? undefined}
        confirmDisabled={!approveWorkerType}
        onConfirm={async () => {
          if (!approveWorkerTarget || approveWorkerBusy) return;
          const userId = approveWorkerTarget.userId;
          setApproveWorkerBusy(true);
          try {
            // PAY CLASS FIRST, deliberately. If this fails we have changed
            // nothing: the account is still unapproved and the operator can
            // retry. Approving first and failing here would leave exactly
            // the state this dialog exists to prevent — approved, roled,
            // and unable to do anything.
            await apiPatch(`/api/users/${userId}/worker-type`, { workerType: approveWorkerType });
            await apiPost(`/api/users/${userId}/approve`);
            // Resolve the role by its stable KEY, never by name: the name
            // is the operator's to change. If the starter role is gone,
            // approval still stands — admitting someone and giving them a
            // role are two decisions, and failing the first because the
            // second cannot be made would leave the account in limbo.
            if (baselineStaffRole) {
              await addRole(userId, baselineStaffRole.id, baselineStaffRole.name);
            }
            window.dispatchEvent(new Event("seedlings3:users-changed"));
            publishInlineMessage({
              type: baselineStaffRole ? "SUCCESS" : "WARNING",
              text: baselineStaffRole
                ? `Approved, and granted ${baselineStaffRole.name}.`
                : "Approved. No role was granted — grant one from their row.",
            });
            setApproveWorkerTarget(null);
            // Clear the pay class with the dialog. Left set, the NEXT
            // person approved arrives with the previous answer already
            // chosen and a Confirm button that is already enabled — which
            // is the pre-selected default this deliberately does not have.
            setApproveWorkerType("");
            void load();
          } catch (err: any) {
            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Approve failed.", err) });
          } finally {
            setApproveWorkerBusy(false);
          }
        }}
        onCancel={() => {
          if (approveWorkerBusy) return;
          setApproveWorkerTarget(null);
          setApproveWorkerType("");
        }}
      />

      {approveClientTarget && (
        <ApproveAndLinkClientDialog
          open={!!approveClientTarget}
          user={approveClientTarget}
          onClose={() => setApproveClientTarget(null)}
          onApproved={() => {
            setApproveClientTarget(null);
            void load();
          }}
        />
      )}
    </Box>
  );
}

// ─── Worker "Team roster" view ───────────────────────────────────────
// Compact card list of approved workers, name + worker-type only.
// Explicitly hides email, phone, wage, role names,
// privilege flags, approval state, pending users, mutations.
// Data comes from /api/me/team which strips sensitive fields
// server-side; we filter defense-in-depth here too.
type WorkerTeammate = {
  id: string;
  displayName?: string | null;
  workerType?: WorkerType | null;
};

function workerTypeBadge(workerType?: WorkerType | null): { label: string; palette: string } | null {
  if (workerType === "CONTRACTOR") return { label: "Contractor", palette: "orange" };
  if (workerType === "EMPLOYEE") return { label: "Employee", palette: "blue" };
  if (workerType === "UNPAID") return { label: "Unpaid", palette: "purple" };
  return null;
}

function WorkerTeamRoster() {
  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<WorkerTeammate[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiGet<WorkerTeammate[]>("/api/me/team");
        if (cancelled) return;
        // Defense-in-depth strip: keep ONLY the sanitized fields even
        // if the API is later loosened by mistake.
        const clean = (Array.isArray(list) ? list : []).map((u) => ({
          id: u.id,
          displayName: u.displayName ?? null,
          workerType: u.workerType ?? null,
        }));
        clean.sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""));
        setTeam(clean);
      } catch (err) {
        if (!cancelled) {
          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load team", err) });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const qlc = q.trim().toLowerCase();
    if (!qlc) return team;
    return team.filter((u) => (u.displayName ?? "").toLowerCase().includes(qlc));
  }, [team, q]);

  return (
    <Box w="full">
      <TabExplainer explainerId="seedlings:usersTab:guideOpen:roster">
        <ExplainerText>
          The people you work alongside — names and whether each is an employee or
          contractor. That is deliberately <Em>all</Em> it shows.
        </ExplainerText>
        <ExplainerText>
          Contact details, pay, roles and permissions are <Em>not here and not withheld by accident</Em>{" "}
          — this view is built to carry only what a crew needs to know about each other.
        </ExplainerText>
      </TabExplainer>
      <HStack mb={3} gap={2}>
        <SearchWithClear value={q} onChange={setQ} inputId="worker-team-search" placeholder="Search teammates…" />
      </HStack>
      {loading ? (
        <LoadingCenter />
      ) : filtered.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" pl={2}>No teammates to show.</Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {filtered.map((u) => {
            const badge = workerTypeBadge(u.workerType);
            return (
              <Card.Root key={u.id} variant="outline">
                <Card.Body p={3}>
                  <HStack gap={2} wrap="wrap">
                    <Text fontSize="sm" fontWeight="semibold">
                      {u.displayName || "(no name)"}
                    </Text>
                    {badge && <Badge size="sm" colorPalette={badge.palette}>{badge.label}</Badge>}
                  </HStack>
                </Card.Body>
              </Card.Root>
            );
          })}
        </VStack>
      )}
    </Box>
  );
}

/**
 * What this person holds, and a picker for what they do not.
 *
 * REPLACES four buttons named after four rows of a database table —
 * "Make Admin", "Remove Admin", "Add Worker", "Remove Worker". Those named
 * roles the operator can rename, redefine or delete, they could not express
 * a grant of any other role, and they posted the deleted enum so none of
 * them worked.
 *
 * Area grants are shown and NOT removable here. A grant scoped to an area
 * reads "Admin — Durham" and means something different from the same role
 * held company-wide; revoking it belongs with the area assignment that
 * created it, not next to a company-wide badge it only resembles.
 *
 * The picker offers only what the person does not already hold. The server
 * refuses a grant of anything the CALLER does not hold themselves (G6), and
 * that refusal now names the capability — so an over-offer is a legible
 * message rather than a silent failure. Filtering by the caller's own set
 * here as well would be a second copy of that rule.
 */
function RoleGrantControls({
  user,
  catalogue,
  onGrant,
  onRevokeRequest,
}: {
  user: ApiUser;
  catalogue: RoleOption[];
  onGrant: (roleId: string, roleName: string, move: boolean) => void;
  onRevokeRequest: (roleId: string, roleName: string) => void;
}) {
  const companyWide = user.roleGrants.filter((g) => !g.areaId);
  const areaScoped = user.roleGrants.filter((g) => g.areaId);
  const heldIds = new Set(user.roleGrants.map((g) => g.roleId));

  // EVERY ROLE THEY DO NOT HOLD, perspectives included.
  //
  // This used to filter out `isPerspective`, reasoning that a perspective is
  // something you take on roles you already hold rather than a role to hand
  // out. That is true of the LENS and false of the ROLE: all four rungs of
  // the starter ladder are perspectives, so the filter removed Trainee,
  // Worker, Admin and Super from the picker — the ladder could not be
  // granted from this screen at all, which is why nobody noticed that the
  // exclusivity rule underneath it refused every grant too.
  //
  // Being offered as a lens and being grantable are different properties.
  // Holding the role is what makes the lens available in the first place.
  const grantable = catalogue.filter((r) => !heldIds.has(r.id) && !r.suspendedAt);

  // ONE SECTION PER HIERARCHY THEY STAND IN.
  //
  // The first cut of this said "Ladder — replaces their rung", which named
  // an implementation detail (`isLadderRung`, a flag the installer stamps
  // on four rows) and assumed the app has exactly one hierarchy. It can
  // have any number: a role is a name and a parent, so an operator can
  // build an office ladder beside the field one. Somebody can stand on a
  // rung of each, and the move within one has nothing to do with the other.
  //
  // So the grouping is derived from the SHAPE OF THE DATA: walk each role
  // they hold up its parents, and whatever else is grantable in that same
  // chain is where they can move. The section is headed by the role they
  // currently hold there, because that is the question being answered —
  // "they are a Worker; what else can they be instead?"
  const chainOf = (id: string) => {
    const out = new Set<string>();
    let cur: string | null | undefined = id;
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = catalogue.find((r) => r.id === cur)?.inheritsFromId ?? null;
    }
    return out;
  };
  // Ancestor OR descendant — the exact relation the server's
  // SAME_ROLE_CHAIN refuses a grant for, so every move offered here is a
  // move the server will take, and nothing offered as a plain grant will
  // come back a 409. Siblings are deliberately NOT in a chain: Coordinator
  // and Worker both inherit Trainee and neither contains the other, so
  // holding both is legal and means something.
  const sameChain = (a: string, b: string) => chainOf(a).has(b) || chainOf(b).has(a);

  // WHAT KIND OF THING A ROLE IS, as a property of the role itself. Every
  // held role was the same blue chip, so a lone permission and a seven-
  // capability role looked identical and the difference only showed in a
  // dropdown you had to open.
  //
  // DELIBERATELY NOT THE SAME QUESTION the picker's groups answer. This is
  // absolute — "Coordinator sits in a hierarchy" — while a group is
  // relative to the person: Coordinator is in a hierarchy AND is an
  // add-on for an Admin, because it hangs off Trainee on a different
  // branch and neither contains the other. Both statements are true, and
  // collapsing them would mean either colouring by something that changes
  // per row or grouping by something that ignores who you are looking at.
  type RoleKind = "chain" | "custom" | "permission";
  const kindOf = (roleId: string): RoleKind => {
    const r = catalogue.find((x) => x.id === roleId);
    if (!r) return "custom";
    // In a hierarchy if anything inherits it, or it inherits anything.
    const inHierarchy =
      !!r.inheritsFromId || catalogue.some((x) => x.inheritsFromId === r.id);
    if (inHierarchy) return "chain";
    return r.own?.length === 1 ? "permission" : "custom";
  };
  const KIND_PALETTE: Record<RoleKind, string> = {
    chain: "blue",
    custom: "purple",
    permission: "cyan",
  };

  const moveGroups = companyWide
    .map((g) => ({
      key: `chain:${g.roleId}`,
      // The heading IS the role they hold. No verb, because the items
      // below each carry one.
      label: g.name,
      items: grantable.filter((r) => sameChain(r.id, g.roleId)),
    }))
    .filter((g) => g.items.length > 0);

  // Everything a move group claimed is spoken for; what is left is additive.
  const inAMove = new Set(moveGroups.flatMap((g) => g.items.map((r) => r.id)));
  const movable = new Set(inAMove);
  const rest = grantable.filter((r) => !inAMove.has(r.id));

  // A HIERARCHY THEY DO NOT STAND IN YET still gets its own section.
  //
  // Without this, somebody holding nothing in the starter ladder saw
  // Trainee, Worker, Admin and Super listed under "Custom roles" — which
  // they are not; they are the installed hierarchy, and the heading was
  // simply false. They fell there because the move grouping asks "is this
  // in a chain with something they hold?", and the answer is no when they
  // hold nothing in it. Entering a hierarchy and moving within one are the
  // same decision asked at different times, so they belong in the same
  // kind of section.
  //
  // GROUPED BY THE ROOT of the tree, and headed with its name — the one
  // label every member of the group actually shares. Note what this
  // section does NOT claim: not "pick one". Exclusivity runs along a
  // CHAIN, not a tree, and Worker and Coordinator both hang off Trainee
  // without containing each other, so holding both is legal. Saying
  // "pick one" over a tree would be the same kind of false heading this
  // replaces.
  const rootOf = (id: string) => {
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const parent = catalogue.find((r) => r.id === cur)?.inheritsFromId;
      if (!parent) return cur;
      cur = parent;
    }
  };
  const inHierarchy = (r: RoleOption) =>
    !!r.inheritsFromId || catalogue.some((x) => x.inheritsFromId === r.id);
  const hierarchyRoots = Array.from(
    new Set(rest.filter(inHierarchy).map((r) => rootOf(r.id))),
  );
  const hierarchyGroups = hierarchyRoots
    .map((rootId) => ({
      key: `tree:${rootId}`,
      label: `${catalogue.find((r) => r.id === rootId)?.name ?? "Role"} hierarchy`,
      items: rest.filter((r) => inHierarchy(r) && rootOf(r.id) === rootId),
    }))
    .filter((g) => g.items.length > 0);
  const inAHierarchy = new Set(hierarchyGroups.flatMap((g) => g.items.map((r) => r.id)));
  const standalone = rest.filter((r) => !inAHierarchy.has(r.id));

  const groups = [
    ...moveGroups,
    ...hierarchyGroups,
    {
      key: "roles",
      // Two cuts here, both properties of the row rather than a judgement
      // about what a role is for. `own.length` of 1 means the role IS that
      // permission wearing a role's clothes; add a second capability and it
      // moves groups, which is the right answer rather than a misfiled one.
      // `own`, not `effective`: Coordinator inherits Trainee, so effective
      // would count 13 where it grants 7 of its own.
      label: "Custom roles",
      items: standalone.filter((r) => (r.own?.length ?? 2) > 1),
    },
    {
      key: "permissions",
      label: "Single permissions",
      items: standalone.filter((r) => r.own?.length === 1),
    },
  ].filter((g) => g.items.length > 0);

  const collection = createListCollection({
    items: grantable.map((r) => ({
      // Name the operation. Picking inside a chain they already stand in
      // REPLACES what they hold there; everything else adds.
      label: movable.has(r.id) ? `Move to ${r.name}` : r.name,
      value: r.id,
    })),
  });

  return (
    // A BOUNDED SECTION, because this is the one control on the row that
    // changes what somebody can DO. It used to sit loose in the same wrap
    // as "Set Employee", "Set Contractor" and "Delete": a strip of badges
    // and a picker with nothing around them, reading as more buttons. What
    // a person holds, and the act of granting, are a different question
    // from their pay class, and the row gave no sign of it.
    <Box
      w="full"
      borderWidth="1px"
      borderColor="border.emphasized"
      rounded="md"
      bg="bg.subtle"
      px={2.5}
      py={2}
    >
      <VStack align="stretch" gap={2} w="full">
        <Text fontSize="2xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
          Roles
        </Text>
        <HStack gap={1.5} wrap="wrap">
        {companyWide.length === 0 && areaScoped.length === 0 && (
          <Text fontSize="xs" color="fg.muted">
            No roles — this person sees nothing until one is granted.
          </Text>
        )}
        {companyWide.map((g) => (
          <Badge
            key={g.roleId}
            size="sm"
            variant="subtle"
            colorPalette={KIND_PALETTE[kindOf(g.roleId)]}
            title={
              {
                chain: "A role in a hierarchy — moving along it replaces this one.",
                custom: "A custom role. Stacks on whatever else they hold.",
                permission: "A single permission. Stacks on whatever else they hold.",
              }[kindOf(g.roleId)]
            }
          >
            <HStack gap={1}>
              <Text>{g.name}</Text>
              {g.isTemporary && (
                <Text fontSize="2xs" color="fg.muted">
                  temporary
                </Text>
              )}
              <Box
                as="button"
                aria-label={`Remove ${g.name}`}
                title={`Remove ${g.name}`}
                onClick={() => onRevokeRequest(g.roleId, g.name)}
                display="inline-flex"
              >
                <X size={11} />
              </Box>
            </HStack>
          </Badge>
        ))}
        {areaScoped.map((g) => (
          <Badge
            key={`${g.roleId}:${g.areaId}`}
            size="sm"
            variant="outline"
            colorPalette="purple"
            title="Held only in this area. Change it where the area is assigned."
          >
            {g.name} — {g.areaName ?? "an area"}
          </Badge>
        ))}
      </HStack>
      {grantable.length > 0 && (
        <Select.Root
          collection={collection}
          size="sm"
          width="full"
          maxW="64"
          value={[]}
          onValueChange={(e) => {
            const id = e.value[0];
            const role = grantable.find((r) => r.id === id);
            // Inside a chain they already stand in it is a MOVE, not a
            // grant — the same test that wrote the label, so the button
            // can never say one thing and post the other.
            if (role) onGrant(role.id, role.name, movable.has(role.id));
          }}
        >
          <Select.HiddenSelect />
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Grant a role…" />
            </Select.Trigger>
            <Select.IndicatorGroup>
              <Select.Indicator />
            </Select.IndicatorGroup>
          </Select.Control>
          <Portal>
            <Select.Positioner>
              <Select.Content>
                {groups.map((g) => (
                  <Select.ItemGroup key={g.key}>
                    <Select.ItemGroupLabel
                      fontSize="2xs"
                      fontWeight="semibold"
                      color="fg.muted"
                      textTransform="uppercase"
                      letterSpacing="wide"
                    >
                      {g.label}
                    </Select.ItemGroupLabel>
                    {g.items.map((r) => {
                      const item = collection.items.find((i) => i.value === r.id);
                      if (!item) return null;
                      return (
                        <Select.Item key={item.value} item={item} ps={5}>
                          <Select.ItemText>{item.label}</Select.ItemText>
                          <Select.ItemIndicator />
                        </Select.Item>
                      );
                    })}
                  </Select.ItemGroup>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Portal>
        </Select.Root>
      )}
      </VStack>
    </Box>
  );
}

/**
 * EVERY capability in the app, and whether this person has it.
 *
 * Two questions, and they need different answers:
 *
 *   "Why CAN Dave do that?"    — answered by the provenance line, which
 *                                names both the role HELD and the role the
 *                                entitlement is WRITTEN ON. `schedule.view`
 *                                on someone with `people.manage` reads "via Admin, written on
 *                                Trainee": editing Admin to remove it would
 *                                do nothing.
 *   "Why CAN'T Dave do that?"  — answerable only if the thing he lacks is
 *                                ON SCREEN. The first version of this panel
 *                                listed held capabilities only, so an absent
 *                                one was simply missing, and the question
 *                                had nowhere to land.
 *
 * So it renders the WHOLE vocabulary, grouped as the role builder groups it,
 * with the gaps shown rather than omitted.
 *
 * The vocabulary comes from `@repo/permissions` directly rather than from
 * `GET /entitlements`: it is the same data the server compiles in, and a
 * second request per expanded row buys nothing. What must come from the
 * server is the HELD set, because only the server resolves inheritance,
 * suspended grants and the payroll gate.
 */
function EffectivePermissions({ userId, canRead }: { userId: string; canRead: boolean }) {
  type Row = {
    entitlement: string;
    copy: string | null;
    scope: "global" | "area";
    overriddenByGlobal: boolean;
    via: Array<{
      roleId: string;
      roleName: string;
      writtenOn: string;
      scope: "global" | "area";
      areaId: string | null;
      areaName: string | null;
    }>;
  };
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showGaps, setShowGaps] = useState(true);

  const held = useMemo(
    () => new Map((rows ?? []).map((r) => [r.entitlement, r])),
    [rows],
  );

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || rows || loading) return;
    setLoading(true);
    try {
      setRows(await apiGet<Row[]>(`/api/users/${userId}/effective-permissions`));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't work out what this person can do.", err),
      });
    } finally {
      setLoading(false);
    }
  }

  if (!canRead) return null;

  return (
    <VStack align="stretch" gap={1} w="full">
      <Button size="xs" variant="ghost" alignSelf="start" onClick={toggle}>
        {open ? "Hide permissions ↑" : "What can they do? ↓"}
      </Button>
      {open &&
        (loading ? (
          <Spinner size="sm" />
        ) : (
          <VStack align="stretch" gap={2} pl={1}>
            <HStack gap={2} wrap="wrap">
              <Text fontSize="2xs" color="fg.muted">
                {held.size} of {ENTITLEMENTS.length} capabilities
              </Text>
              <Button size="xs" variant="ghost" onClick={() => setShowGaps((v) => !v)}>
                {showGaps ? "Only what they have" : "Show everything"}
              </Button>
            </HStack>
            {held.size === 0 && (
              <Text fontSize="xs" color="fg.muted">
                They hold no role that grants anything, so the app has nothing
                to show them — they land on the &ldquo;no access&rdquo; page.
              </Text>
            )}
            {ENTITLEMENT_GROUPS.map((g) => {
              const items = g.entitlements.filter(
                (e) => showGaps || held.has(e.id),
              );
              if (items.length === 0) return null;
              return (
                <Box key={g.group}>
                  <Text fontSize="2xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
                    {g.group}
                  </Text>
                  <VStack align="stretch" gap={1} mt={1}>
                    {items.map((e) => {
                      const r = held.get(e.id);
                      return (
                        <HStack key={e.id} align="start" gap={2}>
                          {/* Shape as well as colour: a tick and a dash read
                              differently at a glance and survive a reader who
                              cannot separate the two greens. */}
                          <Box
                            as="span"
                            mt={0.5}
                            color={r ? "green.fg" : "fg.subtle"}
                            display="inline-flex"
                            flexShrink={0}
                            aria-label={r ? "has it" : "does not have it"}
                          >
                            {r ? <Check size={12} /> : <Minus size={12} />}
                          </Box>
                          <Box minW={0}>
                            <HStack gap={2} wrap="wrap">
                              <Text fontSize="xs" color={r ? undefined : "fg.muted"}>
                                {e.copy}
                              </Text>
                              {r?.scope === "area" && (
                                <Badge size="sm" variant="subtle" colorPalette="purple">
                                  {r.via.find((v) => v.scope === "area")?.areaName ?? "one area"} only
                                </Badge>
                              )}
                              {/* Held both ways means held EVERYWHERE — the
                                  area grant adds nothing. Saying so stops a
                                  reader concluding the person is confined. */}
                              {r?.overriddenByGlobal && (
                                <Badge size="sm" variant="subtle" colorPalette="gray">
                                  also held everywhere
                                </Badge>
                              )}
                            </HStack>
                            {r ? (
                              <Text fontSize="2xs" color="fg.muted">
                                {r.via
                                  .map((v) =>
                                    v.roleName === v.writtenOn
                                      ? `via ${v.roleName}`
                                      : `via ${v.roleName}, written on ${v.writtenOn}`,
                                  )
                                  // One role can reach a capability by two
                                  // paths; saying it twice reads as two grants.
                                  .filter((t, i, all) => all.indexOf(t) === i)
                                  .join(" · ")}
                              </Text>
                            ) : (
                              <Text fontSize="2xs" color="fg.subtle" fontFamily="mono">
                                {e.id}
                              </Text>
                            )}
                          </Box>
                        </HStack>
                      );
                    })}
                  </VStack>
                </Box>
              );
            })}
          </VStack>
        ))}
    </VStack>
  );
}
