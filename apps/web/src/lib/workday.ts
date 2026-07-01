import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { bumpWorkday } from "@/src/lib/bus";
import {
  bizToLocalInputValue,
  bizParseLocalInputValue,
  fmtTimeOpts,
  fmtDateOpts,
} from "@/src/lib/lib";

// Worker-workday client types — mirror services/workdays.ts exactly. Keep
// in sync if the server shapes change.

export type WorkdaySummary = {
  id: string;
  userId: string;
  workdayDate: string;
  startedAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  totalPausedMs: number;
  approvedAt: string | null;
};

export type WorkdayState =
  | { state: "NOT_STARTED" }
  | { state: "IN_PROGRESS"; workday: WorkdaySummary }
  | { state: "PAUSED"; workday: WorkdaySummary }
  | { state: "COMPLETED"; workday: WorkdaySummary };

export type JobBlockingSummary = {
  occurrenceId: string;
  title: string;
  status: string;
  propertyName: string | null;
  clientName: string | null;
};

export type EquipmentCheckoutSummary = {
  checkoutId: string;
  equipmentId: string;
  shortDesc: string;
  brand: string | null;
  model: string | null;
  checkedOutAt: string;
};

export type OpenMileageSummary = {
  id: string;
  vehicleId: string;
  vehicleName: string;
  startedAt: string;
  startOdometer: number;
};

export type WorkdayTodayPayload = {
  today: WorkdayState;
  activeJobs: JobBlockingSummary[];
  activeCheckouts: EquipmentCheckoutSummary[];
  openPrior: WorkdaySummary[];
  /** Today's job counts for the worker (working assignments only — observer
   *  roles are excluded). Used by the WorkdayStrip to decide whether the
   *  NOT_STARTED card should pulse ("you have jobs today") or the
   *  IN_PROGRESS card should pulse ("you finished everything, time to
   *  clock out"). */
  todayJobs: { scheduled: number; remaining: number };
  /** Currently-open mileage sessions on any assigned vehicle. Used by
   *  the End Workday dialog to prompt the worker to record ending
   *  odometer + close each session before the workday actually ends. */
  openMileageEntries: OpenMileageSummary[];
};

/** When `viewAsUserId` is set, the call operates on that worker's workday
 *  (the Admin/Super viewing-as-worker flow). Server permission gate:
 *    • Reads: caller must be ADMIN or SUPER
 *    • Mutations: caller MUST be SUPER
 *  Falls through to the self-service path when omitted or matches the caller. */
type AsParam = { viewAsUserId?: string | null };

function asQuery(opts?: AsParam): string {
  if (!opts?.viewAsUserId) return "";
  return `?viewAsUserId=${encodeURIComponent(opts.viewAsUserId)}`;
}

export async function fetchWorkdayToday(opts?: AsParam): Promise<WorkdayTodayPayload> {
  return apiGet<WorkdayTodayPayload>(`/api/me/workday/today${asQuery(opts)}`);
}

// Every mutation helper below fires `bumpWorkday()` after the server
// confirms — broadcasting "workday state may have changed" to any
// component subscribed via window's seedlings:workday-changed event
// (e.g. WorkdayStrip on Worker Home). This is what keeps the strip in
// sync when the start-job flow's gate dialog starts/resumes/reopens
// the workday from a different React tree.

export async function startWorkday(
  input: { startedAt?: string | null },
  opts?: AsParam,
): Promise<{ workday: WorkdaySummary; created: boolean }> {
  const r = await apiPost<{ workday: WorkdaySummary; created: boolean }>(
    `/api/me/workday/start${asQuery(opts)}`,
    input,
  );
  bumpWorkday();
  return r;
}

export async function pauseWorkday(opts?: AsParam): Promise<WorkdaySummary> {
  const r = await apiPost<WorkdaySummary>(`/api/me/workday/pause${asQuery(opts)}`, {});
  bumpWorkday();
  return r;
}

export async function resumeWorkday(opts?: AsParam): Promise<WorkdaySummary> {
  const r = await apiPost<WorkdaySummary>(`/api/me/workday/resume${asQuery(opts)}`, {});
  bumpWorkday();
  return r;
}

/** Re-open today's workday after it was ended (typically by mistake).
 *  The gap between the bad endedAt and now is added to totalPausedMs
 *  server-side so off-the-clock time doesn't count as payable hours.
 *  Refused once the same-day edit window has closed or if the row
 *  has been approved. */
export async function reopenWorkday(opts?: AsParam): Promise<WorkdaySummary> {
  const r = await apiPost<WorkdaySummary>(`/api/me/workday/reopen${asQuery(opts)}`, {});
  bumpWorkday();
  return r;
}

/** Cancel today's workday — hard-deletes the row. Server refuses if the
 *  workday is already COMPLETED (use the End-times edit flow instead). */
export async function cancelWorkday(opts?: AsParam): Promise<{ cancelled: true }> {
  const r = await apiPost<{ cancelled: true }>(`/api/me/workday/cancel${asQuery(opts)}`, {});
  bumpWorkday();
  return r;
}

export async function endWorkday(
  input: {
    workdayId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  },
  opts?: AsParam,
): Promise<WorkdaySummary> {
  const r = await apiPost<WorkdaySummary>(`/api/me/workday/end${asQuery(opts)}`, input);
  bumpWorkday();
  return r;
}

export async function editWorkdayTimes(
  workdayId: string,
  input: {
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  },
  opts?: AsParam,
): Promise<WorkdaySummary> {
  const r = await apiPatch<WorkdaySummary>(`/api/me/workday/${workdayId}${asQuery(opts)}`, input);
  bumpWorkday();
  return r;
}

// ── Math helpers ────────────────────────────────────────────────────────

/** Active milliseconds for a workday. For currently-paused rows the open
 *  pause segment (now − pausedAt) is subtracted on top of totalPausedMs.
 *  For completed rows the formula reduces to (endedAt − startedAt) − totalPausedMs. */
export function activeMs(w: WorkdaySummary, now: number = Date.now()): number {
  const start = Date.parse(w.startedAt);
  const end = w.endedAt ? Date.parse(w.endedAt) : now;
  let paused = w.totalPausedMs;
  if (w.pausedAt && !w.endedAt) {
    paused += Math.max(0, now - Date.parse(w.pausedAt));
  }
  return Math.max(0, end - start - paused);
}

export function totalPausedMsLive(w: WorkdaySummary, now: number = Date.now()): number {
  let paused = w.totalPausedMs;
  if (w.pausedAt && !w.endedAt) {
    paused += Math.max(0, now - Date.parse(w.pausedAt));
  }
  return paused;
}

/** Format duration as "Xh Ym" — drops the hour when zero. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Format a timestamp as "8:30 AM" in ET. Always ET-anchored — see
 *  fmtTimeOpts for the rationale. */
export function fmtClockTime(iso: string): string {
  return fmtTimeOpts(iso, { hour: "numeric", minute: "2-digit" });
}

/** Format "Tuesday, Jun 10" for the forgot-yesterday header. Workday
 *  date is YYYY-MM-DD in ET; we anchor at noon UTC so the formatter
 *  lands on the same calendar day across any zone, then format in ET. */
export function fmtWorkdayDate(workdayDate: string): string {
  // date-handling-allow: workdayDate is a YYYY-MM-DD ET-anchored string;
  // T12:00:00Z is the canonical "noon UTC" trick the rest of the
  // codebase uses for these labels (matches fmtDate's handling).
  const anchor = `${workdayDate}T12:00:00Z`;
  return fmtDateOpts(anchor, { weekday: "long", month: "short", day: "numeric" });
}

// ── Datetime-local <input> helpers ──────────────────────────────────────
// Wrap the canonical helpers so the workday UI never bypasses the ET
// anchoring — see bizToLocalInputValue / bizParseLocalInputValue.

/** ISO → "YYYY-MM-DDTHH:mm" in ET (input value). */
export function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  return bizToLocalInputValue(iso);
}

/** "YYYY-MM-DDTHH:mm" → ISO at the ET wall-clock instant. Returns null
 *  when blank. */
export function localToIso(local: string): string | null {
  if (!local) return null;
  const r = bizParseLocalInputValue(local);
  return r || null;
}
