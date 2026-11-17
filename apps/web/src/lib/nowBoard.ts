// The Now board — mirrors apps/api/src/services/displays.ts.
//
// WHAT IS CHECKED AND WHAT IS NOT, stated here rather than assumed.
//
// `BoardWorker` and `BoardJob` are name-matched with the API's, so the
// mirror gate compares them field for field and a rename or a dropped
// column fails the build. Those two carry the detail — a row per person and
// a row per visit — and they are where drift would actually be read as
// truth on screen.
//
// `NowBoard` is NOT compared, because its API counterpart is
// `Omit<PrivateBoard, "mode" | "photos">` and the gate only reads literal
// `export type X = { … }` declarations. That was the deliberate trade: the
// alternative is to restate ten fields beside `PrivateBoard` in the API,
// which buys a check here and creates an unguarded drift pair THERE,
// between two literals in the same file with nothing comparing them. One
// copy with a known gap beats two copies with none — and the gap is narrow,
// because a change to any of the three nested row shapes IS caught above.
//
// `weather` is omitted on purpose rather than mirrored: the payload carries
// it (the wall display needs it) and this tab renders none of it, because
// the app already has a WeatherBar in the header. A type for a thing
// nothing reads is just another thing to keep in step.

export type BoardWorker = {
  id: string;
  name: string;
  clockedInAt: string;
  onBreak: boolean;
  jobs: { id: string; title: string; place: string; status: string }[];
};

export type BoardJob = {
  id: string;
  title: string;
  client: string | null;
  place: string;
  status: string;
  startAt: string | null;
  crew: string[];
};

/** `GET /api/board/now` — see the route's own note for what narrows and
 *  what deliberately does not. */
export type NowBoard = {
  /** When the server built this. The age line reads from it, and that line
   *  is the only thing separating a live board from one that stopped
   *  updating on Tuesday. */
  generatedAt: string;
  dateKey: string;
  /** OPTIONAL BECAUSE IT IS A CAPABILITY. Present for a reader who holds
   *  `time.view`; absent — not empty — for one who does not. The server
   *  withholds it rather than the browser hiding it, so these two cases
   *  arrive genuinely different and the tab can say which it is. An empty
   *  array means nobody is clocked in; `undefined` means you may not ask. */
  onTheClock?: BoardWorker[];
  assignedNotClockedIn?: { id: string; name: string; jobs: number }[];
  jobs: BoardJob[];
  vehiclesOut: { id: string; name: string; driver: string; since: string }[];
  equipmentOut: { id: string; name: string; holder: string }[];
  counts: { done: number; inProgress: number; remaining: number; total: number };
  attention: { kind: string; label: string; detail: string }[];
};

/** Statuses that mean the visit is finished as far as the field is
 *  concerned — the same three the server counts as done, for the same
 *  reason: PENDING_PAYMENT is a money state, not a field one, and a screen
 *  that showed it as outstanding would have somebody drive back out. */
export const DONE_STATUSES = ["COMPLETED", "PENDING_PAYMENT", "CLOSED"];
export const ACTIVE_STATUSES = ["IN_PROGRESS", "PAUSED"];
