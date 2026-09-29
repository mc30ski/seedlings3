// ─────────────────────────────────────────────────────────────────────────────
// WHY A REPEATING SERVICE IS PAUSED — the taxonomy behind the dropdown.
//
// A Setting, not an enum, for the reason every user-facing taxonomy in this
// app is a Setting: the operator adds "Storm damage" in October and needs it
// that afternoon, not after a migration and a deploy.
//
// The free-text note beside it is never removed. The code is what you can
// count and filter on; the note is what actually happened. Neither replaces
// the other, and only the code is required.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";

// The key doubles as the Settings-card title: prettySettingName() derives
// "Repeating Job Occurrence Pause Reasons" straight from it, with no
// override map to keep in step. It was STREAM_PAUSE_REASONS; "stream" is
// our word, not the operator's, and it was the only name they would ever
// see for this list — in the Settings tab and in the Neon row they copy to
// production.
export const PAUSE_REASONS_SETTING_KEY = "REPEATING_JOB_OCCURRENCE_PAUSE_REASONS";

export type PauseReason = {
  /** Stable key stored on the occurrence and snapshotted into history. */
  code: string;
  label: string;
  /** Sentence shown under the option so two similar reasons stay distinct. */
  hint?: string;
  /** Days from today to pre-fill the resume reminder.
   *
   *  This is the field that stops a pause becoming a disappearance. The one
   *  stream paused in production before this shipped had no reminder and had
   *  been silent for three months — invisible to the alerts and the Tasks
   *  page, both of which only query reminders that are already due. A reason
   *  that suggests its own horizon means the pause resurfaces itself. */
  defaultReminderDays?: number | null;
  /** Retired reasons stay in the list so historical rows still render a
   *  label, but are not offered for new pauses. */
  retired?: boolean;
};

/** Shipped defaults. Seeded into dev; production is the operator's to write. */
export const DEFAULT_PAUSE_REASONS: PauseReason[] = [
  {
    code: "season_over",
    label: "Season over",
    hint: "Growth has stopped for the year. Resume next season.",
    defaultReminderDays: 150,
  },
  {
    code: "customer_hold",
    label: "Customer asked us to hold",
    hint: "They want service to stop for now and expect to come back.",
    defaultReminderDays: 30,
  },
  {
    // "Non-payment", not "Awaiting payment". The latter echoed the
    // PENDING_PAYMENT status, and the two are different things: a visit
    // sitting in PENDING_PAYMENT already holds the chain by itself (the
    // next visit is only created when a payment is approved) and raises its
    // own stalled-visit warning. That is a stall to chase. THIS is a
    // decision — the client has not paid, so the next visit, which is on
    // the books and would otherwise happen, does not.
    code: "non_payment",
    label: "Non-payment",
    hint: "The client has not paid — hold the next scheduled visit until they do.",
    defaultReminderDays: 14,
  },
  {
    code: "property_inaccessible",
    label: "Property inaccessible",
    hint: "Construction, a locked gate, a dog — we cannot work the site.",
    defaultReminderDays: 21,
  },
  {
    code: "weather_or_site",
    label: "Weather or site conditions",
    hint: "Drought, flooding, or ground conditions make the visit pointless.",
    defaultReminderDays: 21,
  },
  {
    code: "customer_unresponsive",
    label: "Customer unresponsive",
    hint: "We cannot reach them to confirm continuing.",
    defaultReminderDays: 30,
  },
  {
    code: "other",
    label: "Other",
    hint: "Anything else — say what happened in the note.",
    defaultReminderDays: null,
  },
];

function parse(raw: unknown): PauseReason[] {
  if (!Array.isArray(raw)) return DEFAULT_PAUSE_REASONS;
  const out: PauseReason[] = [];
  for (const r of raw as any[]) {
    const code = typeof r?.code === "string" ? r.code.trim() : "";
    const label = typeof r?.label === "string" ? r.label.trim() : "";
    if (!code || !label) continue; // a half-written row is skipped, not fatal
    out.push({
      code,
      label,
      hint: typeof r?.hint === "string" ? r.hint : undefined,
      defaultReminderDays:
        typeof r?.defaultReminderDays === "number" ? r.defaultReminderDays : null,
      retired: r?.retired === true,
    });
  }
  // An empty or unparseable setting falls back rather than leaving the
  // dropdown blank — a mandatory field with no options cannot be submitted,
  // which would block pausing entirely.
  return out.length ? out : DEFAULT_PAUSE_REASONS;
}

export async function listPauseReasons(): Promise<PauseReason[]> {
  const row = await prisma.setting.findUnique({
    where: { key: PAUSE_REASONS_SETTING_KEY },
  });
  if (!row?.value) return DEFAULT_PAUSE_REASONS;
  try {
    return parse(typeof row.value === "string" ? JSON.parse(row.value) : row.value);
  } catch {
    return DEFAULT_PAUSE_REASONS;
  }
}

/** Resolve a code to its label at pause time.
 *
 *  Snapshotted into history rather than joined, so retiring or renaming a
 *  reason next year does not rewrite what last winter's pauses said. */
export async function resolvePauseReason(code: string): Promise<PauseReason> {
  const all = await listPauseReasons();
  const hit = all.find((r) => r.code === code);
  if (!hit) {
    throw new Error(`Unknown pause reason "${code}".`);
  }
  return hit;
}

/** Sentinel for a stream paused before the taxonomy existed.
 *
 *  Such rows have a note and no code. Bucketing them explicitly keeps the
 *  card's reason list honest: "1 paused" with no reason shown reads as a
 *  rendering bug, while "reason not recorded" reads as the truth. */
export const UNCODED_PAUSE_REASON = "__UNCODED__";

/** Occurrence statuses that mean "this stream is still alive".
 *
 *  PAUSED belongs here and STREAM_PAUSED is separated out by the callers:
 *  PAUSED is the worker's mid-visit timer — the visit is happening — while
 *  STREAM_PAUSED is the stream being held. The two share a spelling across
 *  two different enums, which is exactly why this list is written once. */
export const ACTIVE_STREAM_STATUSES = [
  "SCHEDULED",
  "IN_PROGRESS",
  "PENDING_PAYMENT",
  "PAUSED",
  "STREAM_PAUSED",
] as const;

/** Per-job-service rollup of its repeating streams, for the service card. */
export type RepeatingSummary = {
  /** Repeating streams in a live state (paused ones included). */
  total: number;
  /** Live and not held. */
  active: number;
  /** Held via a repeating pause. */
  paused: number;
  /** Distinct reason codes across the paused ones, in first-seen order.
   *  Codes, not labels: the client already has the taxonomy and renders the
   *  label, so a renamed reason does not need the API redeployed. */
  pausedReasonCodes: string[];
};

/** Validate a REPEATING_JOB_OCCURRENCE_PAUSE_REASONS payload before it is stored.
 *
 *  `parse()` above is deliberately forgiving — it is the READ path, and a
 *  half-written row there must degrade to a usable list rather than take the
 *  pause dialog down. The WRITE path is the opposite: silently dropping a row
 *  the operator just typed is how a reason goes missing without anyone
 *  noticing, so anything malformed is rejected with the row that caused it.
 *
 *  Throws on the first problem; returns the parsed list otherwise.
 */
export function validatePauseReasonsJson(raw: string): PauseReason[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`REPEATING_JOB_OCCURRENCE_PAUSE_REASONS must be valid JSON: ${err?.message ?? err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("REPEATING_JOB_OCCURRENCE_PAUSE_REASONS must be a JSON array of reasons.");
  }
  if (parsed.length === 0) {
    // A mandatory field with no options cannot be submitted, so an empty
    // list does not disable the feature — it makes pausing impossible.
    throw new Error("Keep at least one pause reason — the reason field is required when pausing.");
  }

  const out: PauseReason[] = [];
  const seen = new Set<string>();
  parsed.forEach((r: any, i) => {
    const code = typeof r?.code === "string" ? r.code.trim() : "";
    const label = typeof r?.label === "string" ? r.label.trim() : "";
    if (!code) throw new Error(`Reason ${i + 1} needs a code.`);
    if (!label) throw new Error(`Reason "${code}" needs a label.`);
    // The code is stored on the occurrence and snapshotted into history.
    // Restricting it keeps it usable as a URL/filter value and stops a
    // pasted label becoming a key.
    if (!/^[a-z0-9_]+$/.test(code)) {
      throw new Error(
        `Code "${code}" must be lower-case letters, numbers and underscores — it is stored on every pause that uses it.`,
      );
    }
    if (code === UNCODED_PAUSE_REASON) {
      throw new Error(`"${UNCODED_PAUSE_REASON}" is reserved for pauses recorded before this list existed.`);
    }
    if (seen.has(code)) {
      throw new Error(`Duplicate code "${code}" — two reasons cannot share one code.`);
    }
    seen.add(code);

    const days = r?.defaultReminderDays;
    if (days != null && (typeof days !== "number" || !Number.isFinite(days) || days < 0 || days > 3650)) {
      throw new Error(`"${label}" has an invalid reminder default — use a whole number of days, or leave it blank.`);
    }

    out.push({
      code,
      label,
      hint: typeof r?.hint === "string" && r.hint.trim() ? r.hint.trim() : undefined,
      defaultReminderDays: typeof days === "number" ? Math.round(days) : null,
      retired: r?.retired === true,
    });
  });

  if (out.every((r) => r.retired)) {
    throw new Error("At least one reason must stay active — retiring all of them makes pausing impossible.");
  }
  return out;
}
