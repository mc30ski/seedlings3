// ─────────────────────────────────────────────────────────────────────────────
// Repeating tab build gate
//
// WHAT THIS PROTECTS
// Work → Repeating acts on many repeating services at once, and a feature
// shaped like that already shipped here and was REMOVED. The client-level
// "Pause services" / "Resume services" pair was a loop over Jobs that read as
// a standing switch, and the `Job.clientBulkPausedAt` bookkeeping it needed in
// order to undo itself became a second way to pause a job that had to stay in
// step with the first. It did not: a stale stamp swept up a job the operator
// had deliberately stopped. Two dead columns are still on the Job model.
//
// The failure was not batching. It was A BATCH THAT REMEMBERED ITSELF. So the
// rules below are mostly about what this feature must NOT acquire — its own
// state, its own dialog, its own idea of what a pause is. Every one of them
// is invisible in a passing test suite and in a code review of one file,
// which is why they are asserted here rather than trusted.
//
// Spec: docs/features/repeating.md
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const SERVICE = "apps/api/src/services/repeatingStreams.ts";
const ROUTES = "apps/api/src/routes/occurrences.ts";
const TAB = "apps/web/src/ui/tabs/RepeatingTab.tsx";
const CONTROLS = "apps/web/src/ui/components/StreamPauseControls.tsx";
const DIALOG = "apps/web/src/ui/dialogs/StreamPauseDialog.tsx";
const TABLE = "apps/web/src/lib/tabRequirements.ts";
const SPEC = "docs/features/repeating.md";

/** Source with comments stripped, for assertions that must not be satisfied
 *  by a sentence ABOUT the rule instead of the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("[build-gate] Repeating — the lens does not become a second pause", () => {
  it("reads the files it guards", () => {
    // A gate whose paths have moved passes vacuously, which is the one
    // failure mode that looks identical to success.
    for (const f of [SERVICE, ROUTES, TAB, CONTROLS, DIALOG, TABLE, SPEC]) {
      expect(read(f).length, `${f} is empty or missing`).toBeGreaterThan(200);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. NO NEW STATE
  // ───────────────────────────────────────────────────────────────────────

  it("the selection writes go through the per-occurrence pause, not their own", () => {
    // The whole claim of this feature is that a selection is N ordinary
    // pauses. A direct write here would be a second code path to the same
    // state, and the two would drift on the history row, the audit row, or
    // the reason snapshot — all three of which pauseStream owns.
    const src = code(read(SERVICE));
    expect(src, "pauseSelection must call the shared pauseStream")
      .toMatch(/await pauseStream\(/);
    expect(src, "resumeSelection must call the shared resumeStream")
      .toMatch(/await resumeStream\(/);
    expect(src, "and must not write occurrence status itself")
      .not.toMatch(/jobOccurrence\.update\s*\(/);
    expect(src, "nor open a transaction of its own around the sweep")
      .not.toMatch(/\$transaction/);
    expect(src, "nor write a pause history row directly")
      .not.toMatch(/jobOccurrencePauseEvent/);
  });

  it("nothing records that a batch happened", () => {
    // THE EXACT SHAPE OF THE REMOVED FEATURE. A column, a flag or an id
    // stamped on the rows of a selection is a second source of truth about
    // whether a service is held, and undoing it then has to agree with the
    // ordinary resume. It did not last time.
    const src = code(read(SERVICE)) + code(read(TAB)) + code(read(CONTROLS));
    const forbidden = [
      /bulkPaused/i,
      /batchId/i,
      /sweepId/i,
      /selectionId/i,
      /seasonPausedAt/i,
    ];
    const hits = forbidden.filter((re) => re.test(src)).map(String);
    expect(
      hits,
      "a selection must leave no trace of its own — see the removed " +
        "client-level pause in docs/features/repeating.md",
    ).toEqual([]);
  });

  it("the dead client-bulk columns gain no reader", () => {
    // They are kept so the removal stays reversible and no historical row is
    // destroyed. A new READER would resurrect the feature by the back door.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (rel.endsWith("repeating-build-gate.test.ts")) continue;
        // ClientsTab names them in the comment explaining the removal, which
        // is the one place saying the words is the point.
        const src = code(read(rel));
        if (/clientBulkPaused/.test(src)) offenders.push(rel);
      }
    };
    walk("apps/api/src");
    walk("apps/web/src");
    expect(
      offenders,
      "these read a column the removed client-level pause left behind",
    ).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. THE CAPABILITY SPLIT
  // ───────────────────────────────────────────────────────────────────────

  it("the read is schedule.view-all and the writes are schedule.manage", () => {
    const src = read(ROUTES);
    expect(src, "the guard must be declared from the entitlement")
      .toMatch(/const req_scheduleViewAll = requires\("schedule\.view-all"\)/);
    expect(src, "the list is the oversight read")
      .toMatch(/app\.get\("\/repeating-streams", req_scheduleViewAll/);
    for (const verb of ["pause", "resume"]) {
      expect(src, `the ${verb} selection must need schedule.manage`)
        .toMatch(new RegExp(`app\\.post\\("/repeating-streams/${verb}", req_scheduleManage`));
    }
  });

  it("the tab row names the endpoint it reads, and only that", () => {
    // ANY-OF WOULD BE A SILENT 403. A custom role may hold `schedule.manage`
    // without `schedule.view-all` — the live book's Coordinator does — and
    // listing both would open the tab for them onto a refusal from the only
    // endpoint it calls. Same reasoning as the `portfolios` row.
    const row = /repeating:\s*\[([^\]]*)\]/.exec(read(TABLE));
    expect(row, "TAB_REQUIREMENTS must have a `repeating` row").toBeTruthy();
    const names = row![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(names, "exactly the capability GET /repeating-streams is guarded on")
      .toEqual(["schedule.view-all"]);
  });

  it("the tab names the capability its actions mutate behind", () => {
    // G15's rule, asserted here for this file specifically because the whole
    // read-only tier depends on it: the gate decides whether an oversight
    // reader gets a table with no buttons or a table whose buttons 403.
    expect(code(read(TAB)), "RepeatingTab must ask for schedule.manage")
      .toMatch(/scope\.can\("schedule\.manage"\)/);
  });

  it("every action affordance is behind canManage", () => {
    // THE READ-ONLY TIER HAS NO PLAYWRIGHT PERSONA. The dev seed's example
    // roles are Coordinator (manage, no view-all), Bookkeeper and Payroll —
    // none of them holds the oversight read without the write, though the
    // live book's Auditor role does. So the rendered read-only state cannot
    // be driven by a spec today, and this is what stands in for it.
    //
    // Each affordance is checked individually on purpose: a single
    // `canManage` somewhere in the file would be satisfied by gating the
    // checkbox and forgetting the footer, which is a bar offering to pause
    // twenty services to somebody whose every click would 403.
    const src = code(read(TAB));
    const guarded = [
      // The per-row tick.
      /\{canManage && \(\s*<Checkbox\.Root/,
      // The select-all row.
      /\{canManage && selectableIds\.length > 0 && \(/,
      // The sticky selection bar that carries Pause / Resume.
      /\{canManage && selected\.size > 0 && \(/,
    ];
    const ungated = guarded.filter((re) => !re.test(src)).map(String);
    expect(
      ungated,
      "an action affordance is not behind `canManage` — an oversight reader " +
        "would be offered a control whose every click refuses",
    ).toEqual([]);
    // And the shared cluster is handed the same answer rather than deciding
    // for itself from somewhere else.
    expect(src, "the row actions take canManage from the tab's own check")
      .toMatch(/canManage=\{canManage\}/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. THE SELECTION PATH IS SCOPED
  // ───────────────────────────────────────────────────────────────────────

  it("a selection cannot reach outside the caller's portfolios", () => {
    // pauseStream has no idea who is calling. Every other caller reaches it
    // with one id the operator had on screen; this one takes a LIST from the
    // request body, so a portfolio-limited holder could post an id from a
    // district they cannot see and have it written.
    const src = code(read(SERVICE));
    expect(src, "the scope narrowing must exist")
      .toMatch(/async function withinScope\(/);
    const pause = src.slice(src.indexOf("export async function pauseSelection"));
    expect(pause.slice(0, 1400), "pauseSelection must narrow before writing")
      .toMatch(/await withinScope\(/);
    const resume = src.slice(src.indexOf("export async function resumeSelection"));
    expect(resume.slice(0, 1400), "resumeSelection must narrow before writing")
      .toMatch(/await withinScope\(/);
    // And the narrowing has to be USED, not merely computed.
    expect(pause.slice(0, 2000), "ids outside scope must be refused by name")
      .toMatch(/allowed\.has\(/);
    expect(resume.slice(0, 2600), "ids outside scope must be refused by name")
      .toMatch(/allowed\.has\(/);
  });

  it("the writes scope on the write's own capability", () => {
    // A territorial grant of `schedule.manage` must bound what a selection
    // touches even where the same person's `schedule.view-all` is wider.
    // Scoping the write on the READ's capability would widen it.
    const src = read(ROUTES);
    const seg = src.slice(src.indexOf('app.post("/repeating-streams/pause"'));
    expect(seg.slice(0, 1600), "the pause selection scopes on schedule.manage")
      .toMatch(/occurrencePortfolioWhere\(req\.principal, "schedule\.manage"\)/);
    const seg2 = src.slice(src.indexOf('app.post("/repeating-streams/resume"'));
    expect(seg2.slice(0, 1600), "the resume selection scopes on schedule.manage")
      .toMatch(/occurrencePortfolioWhere\(req\.principal, "schedule\.manage"\)/);
  });

  it("the list is scoped by current membership, not the frozen rows", () => {
    // `occurrencePortfolioWhere` resolves through job.property — where the
    // property sits TODAY. The occurrence's own frozen portfolio rows are the
    // deleted "as it happened" basis; a property moved into a district last
    // week is that district's work to hold this autumn.
    const seg = read(ROUTES);
    const i = seg.indexOf('app.get("/repeating-streams"');
    expect(i, "the list route must exist").toBeGreaterThan(-1);
    expect(seg.slice(i, i + 600))
      .toMatch(/occurrencePortfolioWhere\(req\.principal, "schedule\.view-all"\)/);
  });

  it("the loop is bounded by something the caller does not choose", () => {
    const src = code(read(SERVICE));
    expect(src, "a cap must exist").toMatch(/MAX_SELECTION\s*=\s*\d+/);
    expect(src, "and be enforced on the incoming list")
      .toMatch(/length > MAX_SELECTION/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. IT TELLS THE TRUTH ABOUT WHAT HAPPENED
  // ───────────────────────────────────────────────────────────────────────

  it("rows are written independently and reported per row", () => {
    const src = code(read(SERVICE));
    expect(src, "the result must carry per-row outcomes")
      .toMatch(/outcomes/);
    expect(src, "and separate what applied from what did not")
      .toMatch(/applied:[\s\S]{0,80}refused:/);
    // A throw inside the loop would abandon the rest of the selection.
    const pause = src.slice(src.indexOf("export async function pauseSelection"));
    expect(pause.slice(0, 2000), "a refused row must not abort the selection")
      .toMatch(/catch\s*\(/);
  });

  it("a partial failure is not reported as success", () => {
    // THE WAY A SELECTION LIES. 21 of 23 taking, with a green "Done", leaves
    // two services running through the winter and nothing to find them by.
    const src = code(read(CONTROLS));
    const i = src.indexOf("function describe(");
    expect(i, "the selection controller must describe its own result").toBeGreaterThan(-1);
    const body = src.slice(i, i + 1800);
    expect(body, "failures must be counted").toMatch(/failed/);
    expect(body, "and named, not just counted").toMatch(/name\.get\(/);
    expect(body, "and must not be published as SUCCESS")
      .toMatch(/type: result\.applied > 0 \? "WARNING" : "ERROR"/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. ONE PAUSE IMPLEMENTATION, AND ONE CONFIRM THAT NAMES THE ROWS
  // ───────────────────────────────────────────────────────────────────────

  it("Repeating uses the same pause components as Services and Jobs", () => {
    const src = read(TAB);
    expect(src, "must mount the shared action cluster").toMatch(/<StreamPauseActions/);
    // `streamControls`, spelled as Services and Jobs spell it — the
    // job-materials gate pins that name across all three tabs, and a
    // controller called something else in one of them is the first step of
    // the drift this pair of gates exists to stop.
    expect(src, "must render the shared dialogs").toMatch(/streamControls\.dialogs/);
    expect(src, "must use the shared reason filter").toMatch(/passesPauseFilter\(/);
    // Hand-rolling the dialog is how Services and Jobs drifted the first time.
    expect(src, "must not wire StreamPauseDialog directly")
      .not.toMatch(/<StreamPauseDialog/);
  });

  it("the selection confirm lists the rows, not just a count", () => {
    // The operator's own objection to the removed feature was that it "sorta
    // hid what was happening as it cascaded actions". A count is a cascade
    // with a number on it.
    const ctrl = code(read(CONTROLS));
    // BOTH selection dialogs, counted — not "it appears somewhere".
    //
    // This asserted a single match and was caught by mutation: deleting the
    // summary from the PAUSE dialog still passed, because the resume dialog
    // alone satisfied it. The failure that matters is per-dialog, and pausing
    // thirty services unlisted is the worse of the two.
    const summaries = ctrl.match(/summaryNode=\{summary\(/g) ?? [];
    expect(
      summaries.length,
      "both the pause-many and resume-many dialogs must list their rows",
    ).toBe(2);
    expect(ctrl, "the summary must render each row's label")
      .toMatch(/rows\.map\(\(r\) =>[\s\S]{0,400}r\.label/);
    const dlg = code(read(DIALOG));
    expect(dlg, "and the dialog must render it")
      .toMatch(/props\.summaryNode/);
  });

  it("the selection dialog reuses the mandatory reason field", () => {
    // The reason is what makes a pause findable again next spring, and it
    // pre-fills the reminder from its own horizon. A second copy of that
    // logic is a second set of pauses nobody can find.
    const dlg = code(read(DIALOG));
    expect(dlg, "pause-many must take the same reason branch as pause")
      .toMatch(/asksForReason\s*=[\s\S]{0,200}"pause-many"/);
    expect(dlg, "and a reason must still be required to confirm")
      .toMatch(/canConfirm/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. THE TWO WAYS THE SCREEN COULD MISLEAD
  // ───────────────────────────────────────────────────────────────────────

  it("a row that cannot be held cannot be ticked, and says why", () => {
    const src = code(read(TAB));
    expect(src, "selectability comes from what the row can actually do")
      .toMatch(/const selectable = row\.canPause \|\| row\.canResume/);
    expect(src, "and disables the checkbox")
      .toMatch(/disabled=\{!selectable\}/);
    expect(read(TAB), "the blocker must be stated on the row")
      .toMatch(/row\.blockedReason/);
    // The server has to supply a reason for every blocked state or the row
    // renders a disabled box with nothing beside it.
    const svc = code(read(SERVICE));
    expect(svc, "every non-actionable status needs operator-facing copy")
      .toMatch(/function blockedReasonFor\(/);
    for (const status of ["PENDING_PAYMENT", "IN_PROGRESS", "PAUSED"]) {
      expect(svc, `${status} must have a stated reason`).toMatch(status);
    }
  });

  it("select-all operates on the filtered rows and says how many", () => {
    // A select-all over a filtered table is the one place a selection can
    // quietly be larger than what is on screen.
    const src = code(read(TAB));
    expect(src, "the selectable set derives from the FILTERED rows")
      .toMatch(/selectableIds[\s\S]{0,200}filtered\.filter\(/);
    expect(read(TAB), "and the control names the count it will tick")
      .toMatch(/Select these \{selectableIds\.length\}/);
  });

  it("resuming a selection defaults to each stream's own cadence", () => {
    // ONE SHARED DATE DROPS THE BOOK ON ONE WEEK. Thirty held streams
    // resumed onto one April date is thirty visits in a day — a pile-up
    // created by the control meant to undo a book-wide hold.
    const dlg = code(read(DIALOG));
    expect(dlg, "cadence must be the default mode")
      .toMatch(/useState<"cadence" \| "date">\("cadence"\)/);
    const svc = code(read(SERVICE));
    expect(svc, "and the server must compute per-row when no date is given")
      .toMatch(/computeResumeStartAt\(row\.startAt, freq, now\)/);
    // The same function the single-row path and the table's preview use, so
    // the date shown before committing is the date written.
    expect(svc, "the table must preview that same date")
      .toMatch(/suggestedResumeAt/);
  });

  it("a read-only reader gets labels without a capability they lack", () => {
    // `/pause-reasons` requires `schedule.manage`. Resolving labels on the
    // client would 403 for the oversight reader and cache an empty list,
    // leaving them raw codes and a filter with nothing in it.
    const svc = code(read(SERVICE));
    expect(svc, "the server must resolve the reason label")
      .toMatch(/streamPauseReasonLabel/);
    expect(svc, "from the taxonomy, not a join")
      .toMatch(/listPauseReasons\(\)/);
    const tab = code(read(TAB));
    expect(tab, "the filter options must come from the rows")
      .toMatch(/streamPauseReasonLabel \?\? r\.streamPauseReasonCode/);
    expect(tab, "and the tab must not fetch the taxonomy itself")
      .not.toMatch(/usePauseReasons\(/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6b. SORTING — one decision, and an order that means something
  // ───────────────────────────────────────────────────────────────────────

  it("the headers and the phone picker sort from one list", () => {
    // The headers only render at desk width, so a phone needs its own
    // control — and a second hand-written list of columns is how a column
    // ends up sortable in one place and missing from the other. Both read
    // SORTABLE, and there is one sortKey/sortDir behind them.
    const src = code(read(TAB));
    expect(src, "the sortable columns must be declared once")
      .toMatch(/const SORTABLE:/);
    expect(src, "the headers must render from that list")
      .toMatch(/SORTABLE\.map\(\(col\)/);
    expect(src, "and the phone picker from the same list")
      .toMatch(/createListCollection\(\{ items: SORTABLE\.map\(/);
    // One state, written by both.
    expect((src.match(/useState<SortKey>/g) ?? []).length, "exactly one sort key state").toBe(1);
    expect(src, "the phone picker writes the same state the headers do")
      .toMatch(/data-testid="repeating-sort-mobile"/);
  });

  it("blanks sort last whichever way the column is pointing", () => {
    // "No check-back date" is the commonest value in that column. Letting
    // blanks fall out of the comparator naturally floats every one of them
    // to the top the moment the sort is reversed, burying the dates the
    // operator reversed the column to see.
    const src = code(read(TAB));
    const i = src.indexOf("const cmp = (");
    expect(i, "the comparator must exist").toBeGreaterThan(-1);
    const body = src.slice(i, i + 700);
    // The empty branches must return a FIXED side, never one multiplied by
    // the direction — that multiplication is exactly the bug.
    expect(body, "an empty value sorts after a present one").toMatch(/if \(aEmpty\) return 1;/);
    expect(body, "and the mirror case").toMatch(/if \(bEmpty\) return -1;/);
    expect(body, "the empty branches must not be flipped by direction")
      .not.toMatch(/if \(aEmpty\) return [^;]*dir/);
  });

  it("State sorts in work order, not alphabetical order", () => {
    // Alphabetically "Awaiting payment" leads and "Timer paused" trails,
    // which tells an operator nothing. The rank is what is running, then
    // what you have held, then what is blocked behind something else.
    const src = code(read(TAB));
    expect(src, "a declared rank must exist").toMatch(/const STATE_ORDER = \[/);
    const order = /const STATE_ORDER = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
    const names = [...order.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(names, "the rank is the order the work is in").toEqual([
      "SCHEDULED",
      "STREAM_PAUSED",
      "PENDING_PAYMENT",
      "IN_PROGRESS",
      "PAUSED",
    ]);
    expect(src, "and the comparator must use it").toMatch(/STATE_ORDER as readonly string\[\]/);
    // An unrecognised status must land at the END. Sorting it to 0 would put
    // a status nobody has seen before at the top of the operator's list.
    expect(src, "an unknown status sorts last").toMatch(/i < 0 \? 99 : i/);
  });

  it("sorting does not mutate the filtered array", () => {
    // `.sort()` is in-place. Sorting the memoised array that other hooks
    // read is the classic version of this bug — it works until something
    // else reads the list in a different render.
    expect(code(read(TAB)), "sort a copy").toMatch(/\[\.\.\.kept\]\.sort\(/);
  });

  it("a row is handed to the shared pause helpers without a cast", () => {
    // THE BUG THIS CLOSES, and it reached the operator. The row's fields
    // were named `occurrenceId` / `pauseReasonCode` / `pauseNote`, while the
    // shared helpers read `streamPauseReasonCode` — and `passesPauseFilter`
    // marks every field optional, so the mismatch type-checked. Filtering by
    // a specific pause reason returned zero rows for every reason, while
    // "any reason" kept working because that branch returns before it reads
    // the field. Nothing failed; the list was just always empty.
    //
    // An `as any` at the callsite was what made the two shapes look
    // compatible. Passing the row unCAST is the standing proof that it
    // really is one: if the names drift again, this stops compiling.
    const src = code(read(TAB));
    expect(src, "the row goes to the action cluster as itself")
      .toMatch(/occ=\{row\}/);
    expect(src, "no cast may paper over a shape mismatch here")
      .not.toMatch(/occ=\{row as any\}/);
    // And the row must spell the pause fields the way the helpers read them.
    for (const field of ["streamPauseReasonCode", "streamPauseReason", "streamResumeReminderAt"]) {
      expect(src, `the row must carry ${field} under the shared name`).toMatch(field);
    }
  });

  it("the row's actions are one stack at one width", () => {
    // THEY WERE A WRAPPING, RIGHT-ALIGNED ROW with the link beneath it at a
    // smaller size. In a fixed 176px column that produced three buttons at
    // three widths on three alignments — "Resume repeating" filling the
    // line, "Edit pause" ending short of it, "Open" starting left of both —
    // and the column read as jumbled on every held row.
    //
    // A fixed-width column cannot fit them side by side, so the layout has
    // to be a stack. Nothing about that is enforced by the compiler and a
    // passing suite looks identical either way.
    const src = code(read(TAB));
    const i = src.indexOf("<StreamPauseActions");
    expect(i, "the action cluster must be mounted").toBeGreaterThan(-1);
    // Look at the element that WRAPS the cluster, not the whole file.
    // The NEAREST stack opened before the cluster is the one that lays it
    // out. Anchoring on "immediately precedes" was wrong: `code()` strips
    // the comment between them and leaves its braces behind.
    const before = src.slice(0, i);
    const opens = [...before.matchAll(/<(VStack|HStack)([^>]*)>/g)];
    const nearest = opens[opens.length - 1];
    expect(nearest, "the cluster must sit inside a stack").toBeTruthy();
    expect(
      `${nearest![1]}${nearest![2]}`,
      "the actions sit in a stretched VStack — a wrapping HStack is what " +
        "jumbled them into three widths on three alignments",
    ).toMatch(/^VStack[^>]*align="stretch"/);
    expect(nearest![2], "and it must not wrap").not.toMatch(/wrap=/);
    // One size for the whole column, or the link sits at a different height
    // from the buttons above it.
    const after = src.slice(i, i + 900);
    const sizes = [...after.matchAll(/size="([^"]+)"/g)].map((m) => m[1]);
    expect(
      new Set(sizes).size,
      `the action column must use one button size, found: ${sizes.join(", ")}`,
    ).toBe(1);
  });

  it("the table links out instead of growing an editor", () => {
    const src = code(read(TAB));
    // THE JOB ID IS PASSED, not just the occurrence. Resolving the job from
    // the occurrence meant looking it up in the due-reminders list, which
    // holds only held rows whose check-back has arrived — so Open worked for
    // a handful of rows and dumped every other one on "No jobs match current
    // filters". The table has the jobId; it must hand it over.
    expect(src, "a row must offer a way to the service, by job id")
      .toMatch(/onOpenService\(row\.jobId, row\.id\)/);
    // Editing a cadence or a price in two places is two places for them to
    // disagree. Those stay in Services.
    for (const forbidden of [/frequencyDays:\s*\d/, /apiPatch\(/, /defaultPrice/]) {
      expect(src, `the Repeating tab must not edit service fields (${forbidden})`)
        .not.toMatch(forbidden);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. MEMBERSHIP, AND THE SPEC THAT DESCRIBES IT
  // ───────────────────────────────────────────────────────────────────────

  it("membership is the cadence, with the occurrence overriding the service", () => {
    // A one-off has nothing to hold. The fallback is why this cannot be a
    // `where` clause on the Job alone — and dropping it would silently fill
    // the table with one-off visits that have no action.
    const src = code(read(SERVICE));
    expect(src, "the cadence fallback must be applied")
      .toMatch(/o\.frequencyDays \?\? o\.job\?\.frequencyDays \?\? null/);
    expect(src, "and a row with no cadence must be skipped")
      .toMatch(/if \(freq === null\) continue/);
    expect(src, "only live streams are listed")
      .toMatch(/ACTIVE_STREAM_STATUSES/);
  });

  it("the spec records the rules this gate enforces", () => {
    // The doc is the part a future reader meets first. If it stops naming the
    // removed feature, the next person builds it again.
    const spec = read(SPEC);
    for (const phrase of [
      "clientBulkPausedAt",
      "schedule.view-all",
      "MAX_SELECTION",
      "computeResumeStartAt",
      "PENDING_PAYMENT",
    ]) {
      expect(spec, `the spec must still explain ${phrase}`).toContain(phrase);
    }
    expect(spec, "and must still say what the removed feature got wrong")
      .toMatch(/batch that remembered itself/i);
  });
});
