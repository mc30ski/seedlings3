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
/** The one place the two money clocks are computed... */
const WAIT = "apps/api/src/lib/paymentWait.ts";
/** ...and the one place they are drawn. */
const BADGES = "apps/web/src/ui/components/PaymentWaitBadges.tsx";
/** The OTHER screen that asks the same question about the same rows. */
const MONEY = "apps/web/src/ui/components/OutstandingRequestsSection.tsx";
const OUTSTANDING = "apps/api/src/services/paymentRequests.ts";
const CONTACT = "apps/web/src/ui/components/ClientContactMenu.tsx";

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
    for (const f of [SERVICE, ROUTES, TAB, CONTROLS, DIALOG, TABLE, SPEC, WAIT, BADGES, MONEY, OUTSTANDING, CONTACT]) {
      expect(read(f).length, `${f} is empty or missing`).toBeGreaterThan(200);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. NO NEW STATE
  // ───────────────────────────────────────────────────────────────────────


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

  it("the read is schedule.view-all, and that is the only route this tab has", () => {
    // ONE ROUTE NOW. The two selection writes went with the multi-select on
    // 2026-11-10; every write this screen makes is an ordinary per-occurrence
    // pause on its own existing endpoint.
    const src = code(read(ROUTES));
    expect(src, "the list must be guarded on the oversight read")
      .toMatch(/app\.get\(\s*"\/repeating-streams",\s*req_scheduleViewAll/);
    expect(src, "and the selection writes must stay gone — see the note in the service")
      .not.toMatch(/repeating-streams\/(pause|resume)/);
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
    // Since the multi-select went, every affordance on this screen is a
    // PER-ROW control, and they all come from `StreamPauseActions`, which
    // takes `canManage` and renders nothing without it. So the check is that
    // the tab hands it down honestly rather than hard-coding a true.
    const src = code(read(TAB));
    expect(src, "the tab must read the capability its actions mutate behind")
      .toMatch(/scope\.can\("schedule\.manage"\)/);
    expect(src, "and hand it to the shared per-row actions")
      .toMatch(/<StreamPauseActions[\s\S]{0,200}canManage=\{canManage\}/);
    expect(src, "never a literal")
      .not.toMatch(/canManage=\{true\}/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. THE SELECTION PATH IS SCOPED
  // ───────────────────────────────────────────────────────────────────────


  it("the read scopes on its own capability", () => {
    // A territory-limited holder must not see another district's book, and
    // the fragment has to be built with the capability the ROUTE is guarded
    // on — scoping a `schedule.view-all` read with `schedule.manage` would
    // hand the read-only oversight reader an empty table.
    const src = code(read(ROUTES));
    const i = src.indexOf('"/repeating-streams"');
    const listRoute = src.slice(i, i + 1200);
    // BOTH ROOTINGS, ONE CAPABILITY. The list answers two questions now —
    // which live visits, and which streams have none — and they reach a
    // portfolio by different paths (an occurrence through `job.property`, a
    // job through `property`). Scoping one and not the other, or scoping
    // them on different capabilities, leaves half the table unbounded for a
    // territory-limited holder.
    expect(listRoute, "the occurrence half must scope on schedule.view-all")
      .toMatch(/occurrence: occurrencePortfolioWhere\(req\.principal, "schedule\.view-all"\)/);
    expect(listRoute, "and the job half on the very same capability")
      .toMatch(/job: portfolioWhereVia\(req\.principal, "schedule\.view-all", "property"\)/);
    const caps = listRoute.match(/"schedule\.[a-z-]+"/g) ?? [];
    expect(new Set(caps).size, `both halves must name ONE capability, saw ${caps.join(", ")}`).toBe(1);
  });

  it("the list is scoped by current membership, not the frozen rows", () => {
    // `occurrencePortfolioWhere` resolves through job.property — where the
    // property sits TODAY. The occurrence's own frozen portfolio rows are the
    // deleted "as it happened" basis; a property moved into a district last
    // week is that district's work to hold this autumn.
    const seg = read(ROUTES);
    const i = seg.indexOf('app.get("/repeating-streams"');
    expect(i, "the list route must exist").toBeGreaterThan(-1);
    // 1400, not 600: the window has to hold BOTH rootings and the comment
    // that explains them. A window sized to yesterday's route is a gate that
    // starts passing vacuously the first time somebody adds a line.
    const route = seg.slice(i, i + 1400);
    expect(route, "the live visits resolve through job.property — where it sits TODAY")
      .toMatch(/occurrencePortfolioWhere\(req\.principal, "schedule\.view-all"\)/);
    // The job half reaches the same place one join shorter. Same principle:
    // the property's CURRENT membership, never a frozen row.
    expect(route, "and the streams with no visit resolve through property")
      .toMatch(/portfolioWhereVia\(req\.principal, "schedule\.view-all", "property"\)/);
  });


  // ───────────────────────────────────────────────────────────────────────
  // 4. IT TELLS THE TRUTH ABOUT WHAT HAPPENED
  // ───────────────────────────────────────────────────────────────────────



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



  // ───────────────────────────────────────────────────────────────────────
  // 6. THE TWO WAYS THE SCREEN COULD MISLEAD
  // ───────────────────────────────────────────────────────────────────────





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

  it("every sort key is reachable from the one list", () => {
    // `SORTABLE` is what both the headers and the phone picker render from,
    // so a key in the union that is missing from it is a branch nothing can
    // select. `"checkBack"` sat there with a live `case` in the comparator
    // and no way to reach it — tsc is perfectly happy with an unreachable
    // union member, so nothing said so.
    const tab = code(read(TAB));
    const union = tab.match(/type SortKey =([^;]+);/)?.[1] ?? "";
    const keys = [...union.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(keys.length, "could not read the SortKey union").toBeGreaterThan(2);
    const list = tab.slice(tab.indexOf("const SORTABLE"), tab.indexOf("];", tab.indexOf("const SORTABLE")));
    for (const k of keys) {
      expect(list, `SortKey "${k}" is not offered by SORTABLE, so nothing can select it`)
        .toContain(`key: "${k}"`);
    }
  });

  it("the header row has exactly one cell per column track", () => {
    // IT DID NOT, AND THE BUG ARRIVED BY DELETION. Removing the checkbox
    // column from COLS left the header's leading spacer behind, so six
    // header cells went into five tracks and every title sat over the column
    // to its right — the exact unreadability COLS exists to prevent, and the
    // thing tsc cannot see because a grid child count is not a type.
    // SLICED FROM THE RAW FILE — the markers are comments, which `code()`
    // strips — then stripped, so a `<Box />` written inside a comment is not
    // counted as a header cell.
    const raw = read(TAB);
    const md = raw.slice(raw.indexOf("  md:"), raw.indexOf("};", raw.indexOf("  md:")));
    // TRACK-SHAPED LITERALS, not every quote in the block. A trailing
    // comment on one of those lines quotes a sample value, and `code()`
    // keeps end-of-line comments — so a bare quote count read 7 tracks
    // where there are 6.
    const tracks = (md.match(/"[^"]*(?:fr\)|px)\s*"/g) ?? []).length;
    expect(tracks, "could not count the md column tracks").toBeGreaterThan(3);

    const header = code(
      raw.slice(
        raw.indexOf("{/* Column headers, desk width only"),
        raw.indexOf("{filtered.length === 0"),
      ),
    );
    expect(header.length, "could not isolate the header row").toBeGreaterThan(200);
    // One cell per sortable column, plus however many bare spacers remain.
    const spacers = (header.match(/<Box \/>/g) ?? []).length;
    const sortable = (code(raw).match(/\{ key: "/g) ?? []).length;
    expect(
      sortable + spacers,
      `the header draws ${sortable} titles + ${spacers} spacers into ${tracks} tracks`,
    ).toBe(tracks);
  });

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
    // THE UNSERVED RANK FIRST. They are customers the book says we have and
    // are not visiting — the only state on this screen where nobody has
    // decided anything, and the one that used not to appear at all.
    expect(names, "the rank is the order the work is in").toEqual([
      "NO_VISIT",
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
      .toMatch(/onOpenService\(row\.jobId, row\.occurrenceId\)/);
    // NOT `row.id`. A stream with no visit carries `id = "job:<jobId>"`, and
    // handing that over as an occurrence id sends Services hunting for a row
    // that does not exist.
    expect(src, "Open must not pass the synthetic row key as an occurrence id")
      .not.toMatch(/onOpenService\(row\.jobId, row\.id\)/);
    // Editing a cadence or a price in two places is two places for them to
    // disagree. Those stay in Services.
    for (const forbidden of [/frequencyDays:\s*\d/, /apiPatch\(/, /defaultPrice/]) {
      expect(src, `the Repeating tab must not edit service fields (${forbidden})`)
        .not.toMatch(forbidden);
    }
  });

  it("the multi-select stays removed, in every layer it reached", () => {
    // REMOVED 2026-11-10, not hidden. The book is ~40 pausable streams —
    // one screenful — and the operator would rather see each one: "we don't
    // have enough that make it worth it for now. I can rethink it when there
    // are many more clients."
    //
    // THIS ASSERTION IS THE POINT OF THE REMOVAL. The feature this whole
    // module replaced left `Job.clientBulkPausedAt` behind, and two dead
    // columns became a second way to pause that had to stay in step with the
    // first. Dead routes, an unreachable dialog mode and an unused hook are
    // that same debt in a different shape — and each one is individually
    // harmless, which is exactly how all four come back one at a time.
    //
    // If it is rebuilt deliberately, this test is the thing to delete, and
    // deleting it is a decision somebody has to make on purpose.
    const layers: Array<[string, string, RegExp]> = [
      ["the service", SERVICE, /pauseSelection|resumeSelection|withinScope|MAX_SELECTION/],
      ["the routes", ROUTES, /repeating-streams\/(pause|resume)/],
      ["the shared controls", CONTROLS, /useStreamPauseSelection|StreamSelectionRow/],
      ["the dialog", DIALOG, /pause-many|resume-many|selectionCount|summaryNode/],
      ["the tab", TAB, /setSelected|selectableIds|Checkbox\.Root|repeating-selection-bar/],
    ];
    for (const [label, file, pattern] of layers) {
      expect(code(read(file)), `the selection path is back in ${label}`)
        .not.toMatch(pattern);
    }
    // And the map must not still advertise the routes.
    expect(read("docs/features/permissions-ROUTE-MAP.md"), "the route map still lists them")
      .not.toContain("/repeating-streams/pause");
  });

  it("a date the operator picked is parsed in ET, not as UTC midnight", () => {
    // A SHIPPED OFF-BY-ONE, found by an e2e asserting a 14-day service
    // restarts one cadence on and getting 13.
    //
    // Both of this feature's date inputs are `<input type="date">`, so they
    // arrive as a bare "2026-11-24" — and `new Date("2026-11-24")` is UTC
    // midnight, which is the TWENTY-THIRD in ET. Every resume from a card
    // put the visit back a day early, and every pause reminder came due a
    // day early with it, which also moved the "N to review" count at the
    // boundary. Silent in both directions: the date picked and the date
    // shown only disagree if you go back and look.
    //
    // `parseUserDate` is the canonical reader — it anchors a bare date key
    // at ET midnight and passes a full datetime through untouched.
    const src = code(read(ROUTES));
    const streamRoutes = src.slice(
      src.indexOf('"/occurrences/:occurrenceId/stream-pause"'),
      src.indexOf('"/repeating-streams"'),
    );
    expect(streamRoutes.length, "could not isolate the stream pause routes")
      .toBeGreaterThan(200);
    expect(streamRoutes, "an operator-picked date must not be read as UTC midnight")
      .not.toMatch(/new Date\(\s*(body|String\(body)\.(newStartAt|reminderAt)/);
    expect(streamRoutes, "the resume date must go through parseUserDate")
      .toMatch(/parseUserDate\(String\(body\.newStartAt\)\)/);
    expect(streamRoutes, "and so must the reminder date")
      .toMatch(/parseUserDate\(String\(body\.reminderAt\)\)/);
  });

  it("contact details need their own capability, and are omitted not hidden", () => {
    // THE TAB OPENS ON `schedule.view-all` — an oversight READ over the
    // calendar. Seeing every visit is not the same trust as holding every
    // customer's phone number, and the live book has a role in exactly that
    // position. So the contact rides on `clients.view` ("See customers,
    // properties and contacts"), which is the capability that owns these
    // details everywhere else.
    //
    // OMITTED SERVER-SIDE, not hidden in the UI: a field the client never
    // receives cannot be read out of a network tab.
    const svc = code(read(SERVICE));
    const routes = code(read(ROUTES));
    expect(routes, "the list route must ask for the contact capability separately")
      .toMatch(/listRepeatingStreams\([\s\S]{0,200}callerCan\(req, "clients\.view"\)/);
    expect(svc, "and the service must default closed")
      .toMatch(/includeContact = false/);
    expect(svc, "the contacts must only be selected when permitted")
      .toMatch(/\.\.\.\(includeContact[\s\S]{0,80}contacts: \{/);
    // `callerCan` reads `req.principal`, so it honours the active
    // perspective. A fresh DB lookup would restore powers the lens removed —
    // a bug that has shipped three times in this codebase.
    expect(routes, "the capability must come from the principal, not a fresh read")
      .not.toMatch(/userCan\(db[\s\S]{0,80}clients\.view/);
  });

  it("messaging drafts, and never sends", () => {
    // Every item opens the operator's own SMS or mail client with the text
    // filled in. That is the only version safe to offer beside a
    // pause: the message stays theirs to read, edit or abandon, and nothing
    // is recorded as sent that a person did not send.
    const menu = code(read(CONTACT));
    expect(menu, "the draft must go out through the shared comms helpers")
      .toMatch(/buildSmsHref|buildMailtoHref/);
    expect(menu, "and carry the same CC list as a message from a job card")
      .toMatch(/fetchCommsCc\(\)/);
    expect(menu, "nothing here may post to the server")
      .not.toMatch(/apiPost|apiPatch|apiDelete/);
    // A customer with no phone and no email gets no icon — a disabled one
    // teaches the operator to ignore the control.
    expect(menu, "an unreachable customer must render nothing")
      .toMatch(/if \(!contactPhone && !contactEmail\) return null/);

    // IT SITS IN THE ROW'S ACTIONS COLUMN, whose rule is that every control
    // there has the same width, size and alignment — a stack, not a wrapped
    // row, because three buttons at three widths on three alignments is what
    // that column shipped as and could not be read. A square icon dropped
    // into a stack of stretched buttons broke the same rule from the other
    // side; it was the one thing in the column that did not line up.
    // SCOPED TO THE TRIGGER. The wrapper carries `w="full"` too, so a
    // whole-file match is satisfied by it — and shrinking the BUTTON back
    // out of the column's width sailed through.
    const trigger = menu.slice(
      menu.indexOf("<Button"),
      menu.indexOf("</Button>", menu.indexOf("<Button")),
    );
    expect(trigger.length, "could not isolate the trigger").toBeGreaterThan(60);
    expect(trigger, "the trigger must stretch like the buttons beside it")
      .toMatch(/w="full"/);
    expect(menu, "an icon-only trigger is what looked wrong")
      .not.toMatch(/<IconButton/);

    const tab = code(read(TAB));
    // AWAITING PAYMENT IS NOT DRAFTED HERE. Money → Payments owns that
    // message because it carries the invoice link and records the handoff;
    // a second, cheerier version written from this screen would reach the
    // customer with neither.
    // ISOLATED AND COUNTED. Asserting the function's closing `return null`
    // proved nothing — an extra draft added ABOVE it leaves the ending
    // exactly as it was, and that mutation sailed through. What has to hold
    // is the SHAPE: two drafts, one per thing this screen does.
    const draftFn = tab.slice(
      tab.indexOf("function draftFor(row: Row)"),
      tab.indexOf("function statusMeta"),
    );
    expect(draftFn.length, "could not isolate draftFor").toBeGreaterThan(200);
    expect(draftFn, "the draft must be keyed to what the row is about to do")
      .toMatch(/if \(row\.canPause\)[\s\S]{0,900}if \(row\.canResume\)/);
    const drafts = (draftFn.match(/return \{/g) ?? []).length;
    expect(drafts, "three drafts: the pause, the resume, and the check-in").toBe(3);
    // The third is the one this screen exists for — a customer who stopped
    // being visited, where the useful next action is to ask whether they
    // still want the service rather than silently rebook or silently drop.
    expect(draftFn, "an unserved stream must draft the check-in")
      .toMatch(/if \(row\.dormancy\)/);
    expect(draftFn, "everything else must fall through to no draft")
      .toMatch(/return null;/);
    expect(
      /invoice|\bpay\b|payment/i.test(draftFn),
      "the payment message belongs to Money → Payments — it carries the invoice link and records the handoff",
    ).toBe(false);
  });

  it("a stream is listed whether or not it has a visit", () => {
    // THE BUG THAT COST A CUSTOMER. This table listed live OCCURRENCES, so a
    // stream appeared only while it happened to have one — and the moment
    // its last visit closed, was cancelled, or was never created, the
    // customer dropped silently off the board. Nine streams in production
    // were invisible that way. One had been cancelled in September while her
    // job stayed an ACCEPTED fortnightly; 73 days and five missed visits
    // later the business found out from a bad review.
    //
    // The operator's rule, and the one this asserts: a thing may disappear
    // only if somebody deliberately archived it.
    const svc = code(read(SERVICE));
    expect(svc, "there must be a pass that finds streams with no live visit")
      .toMatch(/async function dormantStreams\(/);
    // AT THE START OF ITS OWN LINE, at function-body indent. A bare match on
    // the call text is satisfied by `if (false) out.push(...)` — which is
    // exactly the mutation that proved this assertion too weak, and exactly
    // the shape of the bug it is meant to prevent coming back.
    expect(svc, "and the list must append it unconditionally")
      .toMatch(/\n {2}out\.push\(\.\.\.\(await dormantStreams\(/);
    // Only the deliberate acts hide a row.
    expect(svc, "an archived customer or property is excluded")
      .toMatch(/property: \{ archivedAt: null, client: \{ archivedAt: null \} \}/);
    expect(svc, "and an archived job, which is the narrower deliberate act")
      .toMatch(/status: JobStatus\.ACCEPTED/);
    // REPEATING EITHER WAY ROUND. One production stream carries its cadence
    // only on its occurrences; a job-only test drops exactly the kind of row
    // this pass exists to stop losing.
    expect(svc, "a job whose cadence lives only on its occurrences must still count")
      .toMatch(/OR: \[\s*\{ frequencyDays: \{ not: null \} \}/);
    expect(svc, "the three kinds of nothing must be distinguished")
      .toMatch(/"never-ran"[\s\S]{0,200}"cancelled"[\s\S]{0,200}"stopped"/);
    // MISSED VISITS, NOT DAYS. "73 days" means nothing without the cadence;
    // "5.2 missed" is the same sentence for a weekly and a monthly customer,
    // and it is what makes the list sortable across a mixed book.
    expect(svc, "neglect must be measured in cycles, not days")
      .toMatch(/etDaysBetween\(etFormatDate\(lastServed\), today\) \/ freq/);
    // SERVED, not merely scheduled — a cancelled or still-future visit is
    // not work done, and counting it would reset the clock on the silence.
    expect(svc, "last-served must count only work actually done")
      .toMatch(/JobOccurrenceStatus\.COMPLETED[\s\S]{0,160}JobOccurrenceStatus\.CLOSED/);
    // A dormant row has no occurrence, so its key cannot be mistaken for one.
    expect(svc, "a visit-less row needs a key that is not an occurrence id")
      .toMatch(/id: `job:\$\{j\.id\}`/);
    expect(svc, "and must say so explicitly").toMatch(/occurrenceId: null/);
    // THE STATUS IT EMITS MUST NOT APE AN ENUM MEMBER. This is asserted on
    // the SERVICE as well as the tab, because the service is where the value
    // is produced — a tab-only check passed while the service happily went
    // back to emitting "CANCELLED" (two Ls, against the enum's one).
    expect(svc, "a visit-less row carries the one synthetic status")
      .toMatch(/status: NO_VISIT,/);
    expect(svc, "which must be declared, not inlined")
      .toMatch(/export const NO_VISIT = "NO_VISIT";/);
    expect(svc, "and no invented status may look like a JobOccurrenceStatus")
      .not.toMatch(/"(STOPPED|CANCELLED|NEVER_RAN)"/);

    // WHOLE VISITS, NOT FRACTIONS OF ONE. The first cut rounded to a tenth
    // and the screen read "5.2 missed" — a quantity nobody is, and one the
    // operator cannot act on. Sliced to the expression itself, because a
    // Math.floor anywhere else in this file would satisfy a file-wide match
    // while this line went on producing decimals.
    const missed = svc.slice(svc.indexOf("const missedCycles ="), svc.indexOf("const missedCycles =") + 200);
    expect(missed.length, "the missedCycles expression must be found at all")
      .toBeGreaterThan(40);
    expect(missed, "missed visits are whole visits, floored")
      .toMatch(/Math\.floor\([\s\S]{0,90}\/ freq\)/);
    expect(missed, "and never a fraction of a visit")
      .not.toMatch(/Math\.round|\* 10\) \/ 10|toFixed/);
  });

  it("the unserved reach the screen, ranked first, and can be filtered to", () => {
    const tab = code(read(TAB));
    for (const f of ["dormancy", "missedCycles", "lastServedAt", "occurrenceId"]) {
      expect(tab, `the tab's hand-copied Row must declare ${f}`).toContain(`${f}:`);
    }
    // ONE SYNTHETIC STATUS, AND IT MUST NOT LOOK LIKE AN ENUM MEMBER.
    //
    // `status` carries a real `JobOccurrenceStatus` on every other row. The
    // first cut of this feature put "STOPPED" and "CANCELLED" in it, and
    // "CANCELLED" has TWO Ls where `JobOccurrenceStatus.CANCELED` has one —
    // so `status === "CANCELED"` would silently skip these rows and
    // `=== "CANCELLED"` would silently skip the real ones, with nothing
    // anywhere failing. Which KIND of absence it is belongs in `dormancy`.
    expect(tab, "the unserved share one status that is not an enum member")
      .toMatch(/"NO_VISIT"/);
    expect(tab, "no invented status may ape a JobOccurrenceStatus spelling")
      .not.toMatch(/"(STOPPED|CANCELLED|NEVER_RAN)"/);
    expect(tab, "the label must be keyed on dormancy, not on a status string")
      .toMatch(/row\.dormancy === "stopped"[\s\S]{0,400}row\.dormancy === "never-ran"/);
    expect(tab, "and so must the predicate")
      .toMatch(/const isUnserved = \(r: Row\) => r\.dormancy !== null;/);
    expect(tab, "counted through the shared predicate")
      .toMatch(/unserved: all\.filter\(isUnserved\)\.length/);
    expect(tab, "and filtered through the very same one")
      .toMatch(/view === "unserved" && !isUnserved\(r\)/);
    // They are the only rows where nobody has decided anything, so they go
    // to the top rather than sorting in among the working streams.
    expect(tab, "the unserved must rank above every working state")
      .toMatch(/"NO_VISIT",\s*\n\s*"SCHEDULED"/);
    // Within one state they share no date, so the worst neglect must break
    // the tie or eleven-missed and two-missed arrive in database order.
    expect(tab, "worst neglect first among them")
      .toMatch(/\(b\.missedCycles \?\? -1\) - \(a\.missedCycles \?\? -1\)/);

    // ZERO IS NOT A MISSED VISIT. Flooring made 0 reachable — a stream
    // stopped inside its own first cadence window owes nobody anything
    // yet — and "0 missed" in the overdue colour is a false alarm on a
    // screen whose whole job is that the operator trusts its alarms.
    const cell = tab.slice(tab.indexOf('<Cell label="Next visit">'), tab.indexOf('<Cell label="Next visit">') + 1200);
    expect(cell.length, "the Next visit cell must be found at all")
      .toBeGreaterThan(200);
    expect(cell, "a floored count of zero says so in words")
      .toMatch(/row\.missedCycles === 0[\s\S]{0,60}"none missed yet"/);
    expect(cell, "and is not drawn as overdue")
      .toMatch(/color=\{row\.missedCycles === 0 \? "orange\.fg" : "red\.fg"\}/);
  });

  it("the Service column has one shape, and no raw code reaches a customer", () => {
    const svc = code(read(SERVICE));
    const tab = code(read(TAB));

    // THE CODE AND THE OPERATOR'S WORDS ARE TWO FIELDS, NOT ONE.
    //
    // They were collapsed into `service` with `||`, so the column printed
    // whichever happened to exist: a raw "MOW_TRIM_BLOW" on one row, 45
    // characters of mowing instructions on the next. Worse, `service` is
    // lower-cased into a customer-facing SMS draft, so the code went out
    // as "your mow_trim_blow". Split, the web can label the code and treat
    // the free text as the footnote it is.
    expect(svc, "the raw job-type code travels in its own field")
      .toMatch(/jobType: o\.jobType \|\| null,/);
    expect(svc, "on the visit-less rows too")
      .toMatch(/jobType: reps\[0\]\?\.jobType \|\| null,/);
    expect(svc, "and `service` carries only the operator's own words")
      .not.toMatch(/service: [^\n]*jobType/);

    // ONE RESOLVER. The tab asks this question in four places — cell,
    // search, sort, draft — and the draft is the one that cannot afford a
    // raw code. A second inline `row.jobType ||` chain is how three of the
    // four stayed right while the fourth drifted.
    expect(tab, "the label is resolved once, through the shared map")
      .toMatch(/function serviceLabel\(row: Row\): string \| null \{\s*\n\s*return jobTypeLabel\(row\.jobType\) \|\| row\.service \|\| null;/);
    const draft = tab.slice(tab.indexOf("function draftFor("), tab.indexOf("function draftFor(") + 400);
    expect(draft.length, "the draft builder must be found at all").toBeGreaterThan(100);
    expect(draft, "the customer-facing draft names the service through it")
      .toMatch(/serviceLabel\(row\)/);
    expect(draft, "never off the raw field")
      .not.toMatch(/row\.service|row\.jobType/);

    // ONE SHAPE PER ROW. The cadence and the name used to swap typographic
    // roles depending on whether the stream was named, in two different
    // capitalisations, and the column could not be read down.
    const cell = tab.slice(tab.indexOf('<Cell label="Service">'), tab.indexOf('<Cell label="Service">') + 700);
    expect(cell.length, "the Service cell must be found at all").toBeGreaterThan(150);
    expect(cell, "the cadence is the primary line unconditionally")
      .toMatch(/<Text fontSize="sm">\s*\n\s*\{row\.frequencyDays \? `Every \$\{row\.frequencyDays\} days`/);
    expect(cell, "and the name is always the secondary one")
      .toMatch(/fontSize="xs" color="fg\.muted" lineClamp=\{2\}/);
    // The lower-case "every" was the other half of the inconsistency.
    expect(cell, "with one capitalisation of the cadence, not two")
      .not.toMatch(/`every \$\{/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. MEMBERSHIP, AND THE SPEC THAT DESCRIBES IT
  // ───────────────────────────────────────────────────────────────────────

  it("membership is the cadence, with the occurrence overriding the service", () => {
    // The fallback is why this cannot be a `where` clause on the Job alone.
    const src = code(read(SERVICE));
    expect(src, "the cadence fallback must be applied")
      .toMatch(/o\.frequencyDays \?\? o\.job\.frequencyDays \?\? null/);
    expect(src, "and a row with no cadence must be skipped")
      .toMatch(/if \(freq === null\) continue/);
    expect(src, "only live streams are listed")
      .toMatch(/ACTIVE_STREAM_STATUSES/);
  });

  it("cadence alone is not membership — a one-off is excluded on its workflow", () => {
    // THIS IS THE BUG THIS ASSERTION EXISTS FOR, and it was live in
    // production: five ONE_OFF occurrences listed as repeating streams.
    //
    // Cadence resolves THROUGH the job, so a one-off carrying none of its own
    // on a job that still has `frequencyDays: 14` from when it did repeat
    // resolved to 14 and passed the test above. The screen's own first
    // paragraph tells the operator one-off visits are not listed.
    //
    // `listNextOccurrenceGhosts` carries a comment about the identical trap —
    // it advertised next visits for one-offs for exactly this reason. The dev
    // database is all STANDARD, which is why no test and no amount of local
    // clicking could have found it.
    const src = code(read(SERVICE));
    expect(src, "a non-STANDARD workflow must be dropped")
      .toMatch(/o\.workflow !== "STANDARD"/);
    expect(src, "and so must the legacy isOneOff flag, which outlives the workflow")
      .toMatch(/o\.isOneOff/);
    expect(src, "both have to be selected to be read")
      .toMatch(/workflow: true/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8. THE TWO CLOCKS — how long the money has waited, and what it cost
  // ───────────────────────────────────────────────────────────────────────

  it("the money clock starts at completion, not at the invoice", () => {
    // `paymentRequestFirstSentAt` reads like the truer anchor and the schema
    // even documents it as powering an "N days ago" display — but it is null
    // on 10 of 12 pending rows in dev, so a clock hung on it shows nothing on
    // most of the list and nothing at all on the worst row in it: the visit
    // nobody ever invoiced. `completedAt` is non-null on every pending row in
    // both databases and the schema keeps it that way on purpose.
    const src = code(read(WAIT));
    expect(src, "completion must be the first choice")
      .toMatch(/o\.completedAt \?\? o\.paymentRequestFirstSentAt/);
    expect(src, "the day count must go through the ET helpers, not raw ms")
      .toMatch(/etDaysBetween\(etFormatDate\(d\), today\)/);
    expect(src, "and be clamped, or a visit closed out after ET midnight reads -1 days")
      .toMatch(/Math\.max\(0, etDaysBetween/);
    // The caller resolves "today" once. Per-row `etToday()` can straddle
    // midnight mid-list and report two different todays in one table.
    expect(src, "today must be a parameter, not read per row")
      .toMatch(/today: EtDateKey = etToday\(\)/);
  });

  it("ONE rule answers the money clocks for BOTH screens", () => {
    // Money → Awaiting payment showed "Requested 3 days ago"; Work →
    // Repeating showed "Waiting 27 days". Same rows, two screens, two
    // numbers, and no way to reconcile them without opening the job. The
    // fix is not "show both on both" — it is one rule that both call, or
    // they drift again the moment one of them is edited.
    const repeating = code(read(SERVICE));
    const outstanding = code(read(OUTSTANDING));
    for (const [name, src] of [["Repeating", repeating], ["Awaiting payment", outstanding]] as const) {
      expect(src, `${name} must call the shared rule`).toMatch(/describePaymentWait\(/);
    }
    // The millisecond exemption `listOutstanding` used to carry produced a
    // DIFFERENT number from the calendar one: a request sent at 11pm
    // yesterday is "0 days" by milliseconds and "1 day" by the calendar, so
    // the operator read "Requested today" the next morning.
    expect(outstanding, "the elapsed-ms exemption must not come back")
      .not.toMatch(/date-handling-allow: elapsed-time/);
    expect(outstanding, "and the hand-rolled day division with it")
      .not.toMatch(/Math\.floor\(\(now - \w+\.getTime\(\)\) \/ dayMs\)/);
  });

  it("both screens draw the clocks with one component", () => {
    // "Same badge look and feel" is not a thing you achieve by writing the
    // same markup twice. The wording helpers lived in the Money section and
    // were deleted from it when this moved.
    const tab = code(read(TAB));
    const money = code(read(MONEY));
    for (const [name, src] of [["Repeating", tab], ["Awaiting payment", money]] as const) {
      expect(src, `${name} must render the shared badges`).toMatch(/<PaymentWaitBadges/);
    }
    const badges = code(read(BADGES));
    expect(badges, "waiting is stated as days and reads as a sentence at zero")
      .toMatch(/Finished today/);
    expect(badges, "and the invoice clock keeps its own wording")
      .toMatch(/Requested \$\{days\} days ago/);
    // Waiting is listed first deliberately: a re-send moves "Requested" back
    // to today while the visit has been unpaid for six weeks, so reading the
    // resettable number first makes an old receivable look fresh.
    //
    // BOTH MARKERS HAVE TO BE PRESENT BEFORE THE ORDER MEANS ANYTHING — a
    // bare indexOf comparison is satisfied by a MISSING marker (-1 is less
    // than everything), which is how this assertion first passed against a
    // file where one of the two badges had been renamed away.
    const iWaiting = badges.indexOf('data-testid="payment-wait-waiting"');
    const iRequested = badges.indexOf('data-testid="payment-wait-requested"');
    expect(iWaiting, "the waiting badge must be there to be ordered").toBeGreaterThan(-1);
    expect(iRequested, "and so must the requested badge").toBeGreaterThan(-1);
    expect(
      iWaiting,
      "the non-resetting clock must be rendered before the resettable one",
    ).toBeLessThan(iRequested);
    // "Never asked" and "asked, no answer" are opposite problems — one is
    // the operator's move, the other the client's.
    expect(badges, "never-requested must be its own state, not a missing number")
      .toMatch(/Never requested/);
  });

  it("expiry is read off rawStartAt, which is the only date that can be late", () => {
    // `computeNextOccurrenceStart` returns `startAt` as a DISPLAY date: an
    // overdue visit is snapped forward to today so it is not invisible in a
    // forward-looking view. Measure against that and nothing is ever expired.
    // Its own doc comment reserves `rawStartAt` for this question.
    const src = code(read(SERVICE));
    expect(src, "the projection must come from the renewer's own function")
      .toMatch(/computeNextOccurrenceStart\(/);
    expect(src, "and it must destructure rawStartAt, not startAt")
      .toMatch(/\{\s*rawStartAt\s*\}\s*=\s*computeNextOccurrenceStart/);
    expect(src, "expired is strictly before today — due today is a stream between visits")
      .toMatch(/if \(daysUntilDue < 0\) expiredDays/);
  });

  it("a held stream is never expired, and only the stream's latest visit can be", () => {
    // Two separate ways to get this wrong, both of which produce a red mark
    // on a row that is behaving correctly:
    //
    //   • A held stream stopped ON PURPOSE, with a reason and a check-back
    //     date. Painting the operator's own decision as a failure would
    //     discredit the one thing this screen exists to do.
    //   • A stream can briefly show two rows (a payment reverted after the
    //     next visit had already been started, so it survived the cleanup).
    //     Projecting from the older one dates the stall from the wrong visit.
    const src = code(read(SERVICE));
    expect(src, "the expiry branch must require !held and isLatest")
      .toMatch(/if \(!held && isLatest &&/);
    expect(src, "latest must be decided against every occurrence of the job, not the listed ones")
      .toMatch(/groupBy\([\s\S]{0,400}_max: \{ startAt: true \}/);
    expect(src, "a cancelled future visit is not a visit")
      .toMatch(/notIn: \[JobOccurrenceStatus\.CANCELED, JobOccurrenceStatus\.ARCHIVED\]/);
    expect(src, "and nothing is expired while a visit is still ahead of it")
      .toMatch(/latest!\.getTime\(\) <= now\.getTime\(\)/);
  });

  it("a silenced stall is carried, not obeyed — and rendered quietly", () => {
    // Suppressing a next-visit warning is what buys silence from the header
    // alert and the Today chip. Re-shouting it here would undo a deliberate
    // decision; dropping the row would hide it from the one screen built for
    // reviewing the whole book. So: still shown, no longer an alarm, and out
    // of the count that drives the badge.
    const svc = code(read(SERVICE));
    const tab = code(read(TAB));
    expect(svc, "the service must report the suppression rather than filter on it")
      .toMatch(/expirySuppressed: !!o\.nextVisitWarningSuppressedAt/);
    expect(svc, "it must not be used to skip the row")
      .not.toMatch(/nextVisitWarningSuppressedAt\) continue/);
    expect(tab, "a suppressed stall must drop to the quiet variant")
      .toMatch(/variant=\{row\.expirySuppressed \? "subtle" : "solid"\}/);
    expect(tab, "and must stay out of the count — which is the shared predicate")
      .toMatch(/r\.expiredDays !== null && !r\.expirySuppressed/);
  });

  it("expired wears the house sign, not a second invented one", () => {
    // Work → Jobs already marks expired next visits with a near-black chip
    // on the Today group. This screen shows the SAME stall from the other
    // end — the visit that never got made, seen from the visit that blocked
    // it — so a red icon-and-text here told the operator they had two
    // different problems.
    const tab = code(read(TAB));
    expect(tab, "the row marker must be a solid dark chip")
      .toMatch(/variant=\{row\.expirySuppressed \? "subtle" : "solid"\}[\s\S]{0,120}colorPalette="gray"/);
    // The Jobs chip pins `gray.600`/`gray.50`. A raw ramp value is the same
    // wash in all fourteen themes, four of which ground the page in near
    // black — where a gray.600 chip stops being the obvious thing. The
    // semantic step inverts per theme instead.
    expect(tab, "raw ramp greys must not be copied across for the chip")
      .not.toMatch(/bg="gray\.(600|700)"/);
    // One condition, one mark: the stripe takes the chip's own ink rather
    // than staying red beside a black chip.
    expect(tab, "the stripe must match the chip")
      .toMatch(/borderLeftColor=\{[\s\S]{0,400}"fg"/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 9. THE SUMMARY STRIP IS ALSO THE FILTER
  // ───────────────────────────────────────────────────────────────────────

  it("a chip's count and a chip's filter are the same expression", () => {
    // The strip states what the book is; clicking a chip shows that slice.
    // Counted one way and filtered another, a chip reads "6 expired" and
    // then shows a different six — and the operator cannot tell which
    // number is the lie.
    const tab = code(read(TAB));
    for (const pred of ["isScheduled", "isPausedRepeating", "isBlocked", "isExpired"]) {
      expect(tab, `${pred} must be defined once at module level`)
        .toMatch(new RegExp(`const ${pred} = \\(r: Row\\)`));
    }
    expect(tab, "the counts must be built from the predicates")
      .toMatch(/all\.filter\(isExpired\)\.length/);
    expect(tab, "and the filter must use the very same ones")
      .toMatch(/view === "expired" && !isExpired\(r\)/);
  });

  it("a chip writes the filter state that already existed, never a second copy", () => {
    // THE RULE THAT DELETED THE PREVIOUS FEATURE. Client-level bulk pause
    // needed its own `Job.clientBulkPausedAt` bookkeeping to undo itself,
    // which became a second way to pause that had to stay in step with the
    // first. It did not, and a stale stamp swept up a job the operator had
    // deliberately stopped.
    //
    // Two of these six chips name a filter that already has a control:
    // "held" is `pausedOnly` (StreamPauseFilter) and "due" is `dueOnly` (the
    // Due chip). Giving the chips their own booleans would be the same
    // shape of bug in miniature — click the chip, then clear the button, and
    // the rows stay filtered with nothing on screen saying why.
    const tab = code(read(TAB));
    expect(tab, "paused must write the existing pausedOnly")
      .toMatch(/setPausedOnly\(target === "paused"\)/);
    expect(tab, "due must write the existing dueOnly")
      .toMatch(/setDueOnly\(target === "due"\)/);
    // And `dueOnly` must have exactly ONE writer now that its button is
    // gone — the chip. A second one reintroduces the two-switch problem
    // from the other direction.
    const dueWriters = (code(tab).match(/setDueOnly\(/g) ?? []).length;
    expect(dueWriters, "dueOnly must be written in exactly one place").toBe(1);
    // Only the three with no existing home get the new state.
    expect(tab, "the new state covers only the three that needed it")
      .toMatch(/type View = "all" \| "scheduled" \| "blocked" \| "expired"/);
    // Which chip is LIT has to be read back out of that state, or clearing
    // the StreamPauseFilter leaves the paused chip lit.
    expect(tab, "the active chip must be derived, not stored")
      .toMatch(/const activeLens: Lens = pausedOnly/);
    // ONE SETTER. The chips toggle and the paused dropdown does not, and
    // that difference is real — a second reason picked while paused is on is
    // a re-narrowing, not a request to switch off. Both still have to land
    // in one statement of what a lens change does to the other filters and
    // the selection, or the dropdown quietly stops clearing them.
    expect(tab, "every entry point must route through setLens")
      .toMatch(/const setLens = useCallback\(/);
    expect(tab, "the chips' toggle must delegate rather than reimplement")
      .toMatch(/const target: Lens = next === activeLens \? "all" : next;\s*\n\s*setLens\(target\);/);
    expect(tab, "and so must the pause dropdown")
      .toMatch(/setLens\(next\.active \? "paused" : "all", next\.reasonCode\)/);
    const setters = (code(tab).match(/setPausedOnly\(/g) ?? []).length;
    expect(setters, "pausedOnly must be written in exactly one place").toBe(1);
    expect(tab, "there must be no seventh variable tracking it")
      .not.toMatch(/useState<Lens>/);
    // A reason only means something inside the held lens.
    expect(tab, "leaving the paused lens must clear the reason")
      .toMatch(/setReasonCode\(target === "paused" \? reason : ALL_PAUSE_REASONS\)/);
    // There is no selection to drop any more — the multi-select went on
    // 2026-11-10 — so what this guards now is that it stays gone. A tab that
    // reintroduces selection state without the rest of the design is how the
    // half-built version comes back.
    expect(tab, "selection state must not reappear piecemeal")
      .not.toMatch(/setSelected|selectableIds|repeating-select-all/);
  });

  it("the screen calls a paused repeating what the rest of the app calls it", () => {
    // It said "Held" — a word invented for this tab and used nowhere else in
    // the product. Work → Jobs filters on "Paused repeating", Customers on
    // "Paused repeating only", Services alerts on "Paused repeating to
    // review", and the button ON THIS VERY ROW says "Pause repeating". A row
    // whose action and whose state use different words for one thing teaches
    // the operator that they are two things — the same failure as the
    // role-named boolean that hid customers' completed jobs in production.
    const tab = read(TAB);
    expect(tab, "the state badge must use the product's own words")
      .toMatch(/STREAM_PAUSED"\) return \{ label: "Paused repeating"/);
    // The full two-word label matters: `PAUSED` is a worker's timer stopped
    // mid-visit and is rendered in this same column. One word apart would
    // put two unrelated states next to each other.
    expect(tab, '"Timer paused" must stay distinct from "Paused repeating"')
      .toMatch(/label: "Timer paused"/);
    // No operator-facing "hold" left anywhere on the screen or in the
    // refusal copy the server sends it.
    // COMMENT-STRIPPED. The comments above deliberately quote the old word
    // to explain why it went; scanning them would make this assertion
    // impossible to satisfy without deleting its own rationale.
    const copy = [code(tab), code(read(SERVICE))].join("\n");
    const strings = copy.match(/"[^"\n]{4,}"/g) ?? [];
    const holdy = strings.filter((x) => /\b(hold|holds|holding|held)\b/i.test(x));
    expect(holdy, `operator-facing copy still says "hold": ${holdy.join(", ")}`).toEqual([]);
    // Same rule, second invented word. "Check-back" named the reminder
    // queue on this screen alone.
    const checky = strings.filter((x) => /check.?back/i.test(x));
    expect(checky, `operator-facing copy still says "check-back": ${checky.join(", ")}`).toEqual([]);
  });

  it("the pause-reason menu is the shared one, worn by the chip", () => {
    // The chip counted the paused rows; a purple icon button two rows down
    // narrowed them to a reason; neither mentioned the other. Folded into
    // one control that states the count, the state and the reason.
    //
    // A `trigger` PROP rather than a second menu, because what has to stay
    // single is not the button — it is the item list and the rule that
    // switching off drops the reason. A copied menu is how one surface ends
    // up offering a reason another has retired.
    const tab = code(read(TAB));
    const controls = code(read(CONTROLS));
    // SCOPED TO THE CALL SITE for everything below. Whole-file matches here
    // are satisfied by the five ordinary chips and by LensChip's own prop
    // declarations, which is how two of these assertions first passed
    // against a chip that had lost the behaviour they name.
    const triggerBlock = tab.slice(
      tab.indexOf("<StreamPauseFilter"),
      tab.indexOf("/>", tab.indexOf("offLabel=")),
    );
    expect(triggerBlock.length, "could not isolate the trigger").toBeGreaterThan(80);
    expect(tab, "the chip must be handed to the shared filter as its trigger")
      .toMatch(/<StreamPauseFilter[\s\S]{0,400}trigger=\{[\s\S]{0,200}<LensChip/);
    expect(controls, "the shared filter must render a supplied trigger as-is")
      .toMatch(/<Select\.Trigger asChild>\{trigger\}<\/Select\.Trigger>/);
    expect(controls, "switching off must still drop the reason, for every host")
      .toMatch(/onChange\(\{ active: false, reasonCode: ALL_PAUSE_REASONS \}\)/);
    // The other two hosts must be untouched — they still want the icon.
    expect(code(read("apps/web/src/ui/tabs/JobsTab.tsx")), "Jobs must keep the icon trigger")
      .not.toMatch(/<StreamPauseFilter[\s\S]{0,300}trigger=/);
    // The chip opens a menu instead of toggling, and says so before it is
    // clicked.
    expect(triggerBlock, "the menu chip must carry its caret marker")
      .toMatch(/withMenu/);
    // THE BODY FILTERS, THE CARET OPENS THE MENU. The whole chip was the
    // trigger, so clicking it did not filter — you had to open the menu and
    // then pick "Paused — any reason", a second step with nothing on screen
    // to suggest it, while the five chips beside it all filtered on the
    // first click. The operator's words: "that isn't obvious".
    // SCOPED TO THE TRIGGER. The other five chips also read
    // `onPick={applyLens}`, so a whole-file match is satisfied by them —
    // and neutering THIS one back to a no-op sailed through, leaving the
    // chip opening a menu instead of filtering, which is the entire bug.
    expect(triggerBlock, "the chip body must filter like every other chip")
      .toMatch(/onPick=\{applyLens\}/);
    expect(tab, "the body must carry its own click target")
      .toMatch(/data-testid="lens-chip-body"/);
    // The Badge IS the Select trigger, so a click anywhere in it reaches the
    // menu. Stopping only `click` is too late — Ark opens on pointerdown.
    expect(tab, "the body must stop the event at pointerdown, not just click")
      .toMatch(/onPointerDown=\{\(e: React\.PointerEvent\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}\}/);
    expect(tab, "and at click, where it toggles the lens instead")
      .toMatch(/e\.stopPropagation\(\);\s*\n\s*onPick\(lens\);/);
    // The count has to follow the reason or the chip lies — the same rule
    // the other five chips are held to.
    expect(tab, "the paused count must honour the chosen reason")
      .toMatch(/all\.filter\(\(r\) => passesPauseFilter\(r, true, reasonCode\)\)\.length/);
    expect(tab, "and recompute when it changes").toMatch(/\}, \[rows, reasonCode\]\)/);
  });

  it("the reminder queue is called what the alert that links here calls it", () => {
    // The header alert and the Tasks page section both read "Paused
    // repeating to review" and both navigate to EXACTLY this set. The chip
    // said "due a check-back" — so clicking that alert landed the operator
    // on a screen giving the same two rows a third name.
    //
    // Two words legitimately survive, in their right places: the DATE is a
    // "Reminder date" (the pause dialog's own field label) and the WORK ITEM
    // its arrival creates is a review. That is a distinction, not a
    // contradiction — which is why the internal names (`dueOnly`,
    // `reminderDue` off the wire) stay as they are.
    const tab = read(TAB);
    expect(tab, "the chip must use the queue's established name")
      .toMatch(/\{counts\.due\} to review/);
    // THE BUTTON IS GONE, and that is the assertion now. It said the same
    // thing the chip says, right beside it — two controls for one question,
    // which is the shape this screen is otherwise careful about. `dueOnly`
    // has exactly one writer again.
    expect(tab, "the separate To review button must not come back")
      .not.toMatch(/data-testid="repeating-due-filter"/);
    // THE ROW STATES THE DATE, UNDER THE BADGE THAT PROMPTS THE QUESTION.
    // "Paused repeating" invites exactly one question — until when? — and
    // the answer used to sit two columns away in small grey text under a
    // heading that says "Reason". The operator's words: "it's not obvious".
    //
    // The Next visit column cannot carry it either: on a paused row that
    // column shows the date the pause is HOLDING, which is not a next visit.
    expect(tab, "the row must state the reminder date")
      .toMatch(/review"\} \$\{fmtDate\(row\.streamResumeReminderAt\)\}/);
    const stateCell = tab.slice(
      tab.indexOf('<Cell label="State">'),
      tab.indexOf('<Cell label="Reason"'),
    );
    expect(stateCell.length, "could not isolate the State cell").toBeGreaterThan(200);
    expect(stateCell, "the reminder belongs beside the state, not in Reason")
      .toMatch(/data-testid="repeating-reminder"/);
    const reasonCell = tab.slice(tab.indexOf('<Cell label="Reason"'));
    expect(
      reasonCell.slice(0, reasonCell.indexOf("</Cell>")),
      "and must not ALSO be in Reason — one fact, one place",
    ).not.toMatch(/streamResumeReminderAt/);
    // A PAUSE WITH NO REMINDER NEVER COMES BACK. Both surfaces that
    // resurface a paused stream query reminders that are already DUE, so one
    // with no reminder is invisible to them forever — which is what happened
    // to the production pause that predates the reason dropdown.
    expect(stateCell, "a pause with no reminder must say that it will not resurface")
      .toMatch(/no reminder — won't resurface/);
    // The alert this screen is the destination for. `alert-ordering-build-gate`
    // pins the alert itself; this says the two must agree.
    expect(read("apps/web/pages/index.tsx"), "the alert that links here must still carry that name")
      .toContain("Paused repeating to review");
  });

  it("a chip states both halves of its fill, so a host recipe cannot strip one", () => {
    // THE BUG THIS EXISTS FOR WAS INVISIBLE, NOT UGLY. Handing the paused
    // chip to `Select.Trigger asChild` let Chakra's trigger recipe override
    // the badge's `solid` BACKGROUND while leaving its `solid` FOREGROUND
    // alone — white text on the page's white ground. The chip simply was not
    // there, and the e2e read the right string out of the DOM throughout,
    // because the text was present and correct and painted in white.
    //
    // `solid` is a FILL and `contrast` is the ink that stays legible on it;
    // themeTokens tunes them as a pair per theme (see the note there about
    // lightening one half putting white on green at 2.28:1). Naming both
    // explicitly survives the recipe and still themes.
    const tab = code(read(TAB));
    expect(tab, "the filled rung must name its own background")
      .toMatch(/filled\s*\n?\s*\? `\$\{palette\}\.solid`/);
    expect(tab, "the lit-but-not-filled rung too — that is the neutral chip's step")
      .toMatch(/: lit\s*\n?\s*\? `\$\{palette\}\.emphasized`/);
    expect(tab, "and the resting one")
      .toMatch(/: `\$\{palette\}\.subtle`/);
    expect(tab, "and the ink that belongs with it")
      .toMatch(/color=\{filled \? `\$\{palette\}\.contrast` : `\$\{palette\}\.fg`\}/);
    // The same recipe imposes a form control's height, border and font size.
    // All six chips are one row; one of them silently becoming a 36px
    // outlined box is the column-alignment failure in miniature.
    expect(tab, "a menu chip must be pinned back to the badge's own shape")
      .toMatch(/withMenu \? \{ h: "auto", minH: "0", border: "none", fontSize: "xs" \}/);
  });

  it("the near-black fill means EXPIRED and nothing else on the strip", () => {
    // It did not, and the collision was visible on screen: the "N repeating"
    // chip sat on the gray palette and went `solid` when active, which is
    // near-black — the expired colour exactly, on a chip that has nothing to
    // do with expiry. Two unrelated things wearing one signal.
    //
    // The fix is a rule, not a one-off restyle: the dark fill is spent on
    // expiry, and the "show everything" chip takes no fill and no ring at
    // all. That is also the truer state — it being "active" means NO filter
    // is applied, which is the table at rest, not a selection.
    const tab = code(read(TAB));
    expect(tab, "the strip must distinguish the three tones explicitly")
      .toMatch(/tone\?: "normal" \| "expired" \| "neutral"/);
    expect(tab, 'only the expired chip may be "expired"')
      .toMatch(/tone="expired"/);
    expect(tab, 'and the show-everything chip must be "neutral"')
      .toMatch(/lens="all"[\s\S]{0,200}tone="neutral"/);
    // The neutral chip must be excluded from BOTH emphasis rungs — a fill
    // alone or a ring alone would bring the collision halfway back.
    // WHAT THE NEUTRAL CHIP MUST NOT TAKE IS THE NEAR-BLACK FILL, NOT THE
    // EMPHASIS. Excluding it from emphasis altogether was the first fix and
    // it overcorrected: the one chip that clears every filter then gave no
    // sign it had been used. It is lit like the others, a step darker
    // (`gray.emphasized`) rather than `gray.solid`, which stays the expired
    // sign.
    expect(tab, "the neutral chip must never take the solid fill")
      .toMatch(/const filled = expired \|\| \(lit && !neutral\);/);
    expect(tab, "but it must still light up like the rest")
      .toMatch(/const lit = active;/);
  });

  it("the lit chip clears back to everything", () => {
    // Every chip toggles the same way, so none of them is a special case.
    const tab = code(read(TAB));
    expect(tab, "clicking the active chip must return to all")
      .toMatch(/const target: Lens = next === activeLens \? "all" : next/);
  });

  it("the expiry stripe is reserved on every row, so no column shifts", () => {
    // The whole reason COLS exists is that this table's columns did not line
    // up and could not be read at a glance. A 3px border that appears only on
    // the expired rows moves those rows' contents 3px right and brings the
    // same unreadability back on exactly the rows that most need reading.
    const tab = code(read(TAB));
    expect(tab, "the stripe width must be unconditional")
      .toMatch(/borderLeftWidth="3px"/);
    expect(tab, "and the colour, not the width, is what varies — transparent when fine")
      .toMatch(/row\.expiredDays === null\s*\?\s*"transparent"/);
    expect(tab, "the row must expose the state for the specs to read")
      .toMatch(/data-expired=/);
  });

  it("both clocks reach the screen", () => {
    // The tab's Row type is a HAND-COPY of the server's, and the two have
    // already drifted once in this feature: the local shape said `string`
    // after the server had started returning null, `.toLowerCase()` threw
    // inside the filter, and the table rendered empty with no error on
    // screen. TypeScript cannot see across the wire, so the fields are
    // asserted present on both sides instead.
    const svc = code(read(SERVICE));
    const tab = code(read(TAB));
    // THE TYPE BLOCKS, not the whole file. A plain `toContain` over the tab
    // passes on a field that is only ever READ — which is the first thing
    // this assertion was written wrong as, and the mutation proving it
    // (deleting the declaration, keeping the read) sailed through. It is
    // `tsc` that catches that one; this assertion has to be about the
    // declared shape or it is about nothing.
    const block = (src: string, header: RegExp) => {
      const i = src.search(header);
      expect(i, `could not find ${header} to read the row shape from`).toBeGreaterThan(-1);
      const end = src.indexOf("\n};", i);
      expect(end, "the row type must be a closed block").toBeGreaterThan(i);
      return src.slice(i, end);
    };
    const svcRow = block(svc, /export type RepeatingStreamRow = \{/);
    const tabRow = block(tab, /^type Row = \{/m);
    for (const field of [
      "awaitingPaymentSince",
      "awaitingPaymentDays",
      "nextVisitDueOn",
      "expiredDays",
      "expirySuppressed",
      "paymentRequestedDays",
      "paymentFirstRequestedDays",
      "paymentResendCount",
      "paymentNeverRequested",
    ]) {
      expect(svcRow, `the service's row must declare ${field}`).toContain(`${field}:`);
      expect(tabRow, `and the tab's hand-copy must declare ${field}`).toContain(`${field}:`);
    }
    // The two nullable shapes that have actually drifted here before.
    expect(tabRow, "a day count is a number or absent, never a string")
      .toMatch(/awaitingPaymentDays: number \| null/);
    expect(tabRow, "and expiredDays being non-null IS the expired condition")
      .toMatch(/expiredDays: number \| null/);
  });

  it("the spec records the rules this gate enforces", () => {
    // The doc is the part a future reader meets first. If it stops naming the
    // removed feature, the next person builds it again.
    const spec = read(SPEC);
    for (const phrase of [
      "clientBulkPausedAt",
      "schedule.view-all",
      "computeResumeStartAt",
      "PENDING_PAYMENT",
      // The two clocks, and the three traps a future reader would otherwise
      // walk straight back into: the invoice looks like the right anchor, the
      // display date looks like the right date to measure against, and
      // cadence looks like the whole of membership.
      "completedAt",
      "rawStartAt",
      "expiredDays",
      "isOneOff",
      "nextVisitWarningSuppressedAt",
      // The shared rule, the shared component, and the filter invariant —
      // each one a thing a future reader would otherwise rebuild badly.
      "describePaymentWait",
      "PaymentWaitBadges",
      "Never requested",
      "activeLens",
      "pointerdown",
      "gray.emphasized",
      "clients.view",
      "ClientContactMenu",
      "pauseSelection",
    ]) {
      expect(spec, `the spec must still explain ${phrase}`).toContain(phrase);
    }
    expect(spec, "and must still say what the removed feature got wrong")
      .toMatch(/batch that remembered itself/i);
  });
});
