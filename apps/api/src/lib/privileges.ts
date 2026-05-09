import type { Role, WorkerType } from "@prisma/client";

/**
 * Per-workerType defaults. Per-user override columns
 * (User.canPullInventory, User.canChargeBusinessExpenses) take precedence
 * when set; null falls back to these.
 *
 * Trainees get nothing; contractors and employees can pull from the
 * already-paid-for inventory; charging the business account is always an
 * explicit grant (never a default).
 */
const DEFAULTS_BY_WORKERTYPE: Record<
  WorkerType,
  { canPullInventory: boolean; canChargeBusinessExpenses: boolean }
> = {
  TRAINEE: { canPullInventory: false, canChargeBusinessExpenses: false },
  CONTRACTOR: { canPullInventory: true, canChargeBusinessExpenses: false },
  EMPLOYEE: { canPullInventory: true, canChargeBusinessExpenses: false },
};

export type ResolvedPrivileges = {
  canPullInventory: boolean;
  canChargeBusinessExpenses: boolean;
  /** True if the underlying role implies all privileges regardless of overrides. */
  isAdminOrSuper: boolean;
};

type UserShape = {
  workerType: WorkerType | null | undefined;
  canPullInventory: boolean | null | undefined;
  canChargeBusinessExpenses: boolean | null | undefined;
  roles?: { role: Role }[] | null | undefined;
};

/**
 * Compute effective privileges for a user. Admin/super override everything;
 * otherwise per-user nullable columns override workerType defaults.
 */
export function resolvePrivileges(user: UserShape): ResolvedPrivileges {
  const isAdminOrSuper = !!user.roles?.some(
    (r) => r.role === "ADMIN" || r.role === "SUPER",
  );
  if (isAdminOrSuper) {
    return {
      canPullInventory: true,
      canChargeBusinessExpenses: true,
      isAdminOrSuper: true,
    };
  }
  // Workers without a workerType (e.g. mid-onboarding) get nothing — safest default.
  const defaults =
    user.workerType != null
      ? DEFAULTS_BY_WORKERTYPE[user.workerType]
      : { canPullInventory: false, canChargeBusinessExpenses: false };
  return {
    canPullInventory: user.canPullInventory ?? defaults.canPullInventory,
    canChargeBusinessExpenses:
      user.canChargeBusinessExpenses ?? defaults.canChargeBusinessExpenses,
    isAdminOrSuper: false,
  };
}

/**
 * Returns the inherited default for a given workerType, used by the UI to
 * show "(default: ✅/❌)" hints next to the override selector.
 */
export function defaultPrivilegesFor(
  workerType: WorkerType | null | undefined,
): { canPullInventory: boolean; canChargeBusinessExpenses: boolean } {
  if (workerType == null) {
    return { canPullInventory: false, canChargeBusinessExpenses: false };
  }
  return DEFAULTS_BY_WORKERTYPE[workerType];
}
