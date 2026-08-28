// ─────────────────────────────────────────────────────────────────────────────
// Education-guides build gate
//
// Canonical spec: docs/features/education.md
//
// The rules below are the ones that are invisible in review and expensive
// to get wrong. Each maps to a decision made deliberately during design:
//
//   1. A WORKER'S QUERY CANNOT RETURN AN UNPUBLISHED GUIDE. Visibility is
//      a WHERE clause, not a client-side filter — hiding a draft in the UI
//      would still ship its body in the payload.
//   2. VIDEO IS SUPER-ONLY. It is the one asset class that can quietly
//      become expensive and the one with a playback trap, so exactly one
//      role uploads it.
//   3. ASSETS ARE IMMUTABLE. No update path exists, because replacing an
//      image under an approved page would change published content without
//      an approver seeing it — the approval gate would become advisory.
//   4. SIZE IS VERIFIED FROM R2, NOT FROM THE BROWSER. A presigned PUT is
//      signed on content-type only, so the declared size is unenforceable.
//   5. DELETING AN ASSET IS REFERENCE-CHECKED, so nobody breaks a guide a
//      worker is reading in a field.
//   6. PERMANENT DELETE SNAPSHOTS BEFORE DESTROYING, because afterwards
//      the audit row is the only record the guide existed.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const SERVICE = read("apps/api/src/services/guides.ts");
const ROUTES = read("apps/api/src/routes/guides.ts");

/** Source with comments stripped — the rules below are ABOUT the prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("guides build gate — worker visibility", () => {
  it("a worker's guide query is scoped to a published version", () => {
    // The scoping must be in the WHERE clause. A worker receiving a draft
    // body and the client choosing not to render it is not access control.
    expect(
      code(SERVICE),
      "visibilityWhere must constrain workers to guides with a currentVersionId",
    ).toMatch(/kind === "worker"[\s\S]{0,200}currentVersionId:\s*\{\s*not:\s*null\s*\}/);
  });

  it("worker read routes never expose the authoring surface", () => {
    // Every mutation must sit behind adminGuard or superGuard. A worker
    // route that mutated would bypass the whole workflow.
    const workerRoutes = [...code(ROUTES).matchAll(/app\.(get|post|patch|delete)\("(\/me\/[^"]+)"[^,]*,\s*(\w+)/g)];
    expect(workerRoutes.length).toBeGreaterThan(0);
    for (const [, method, path, guard] of workerRoutes) {
      expect(method, `${path} is a worker route and must be read-only`).toBe("get");
      expect(guard, `${path} must use workerGuard`).toBe("workerGuard");
    }
  });
});

describe("guides build gate — media rules", () => {
  it("video upload is refused for anyone but a Super", () => {
    // Asserted PER FUNCTION, not as a total count. A count is satisfied by
    // any two of the three guards, so removing finalize's check survived
    // it — the finalize route is separately callable, which is exactly the
    // hole that would have shipped.
    const src = code(SERVICE);
    for (const fn of ["presignAssetUpload", "finalizeAsset", "deleteAsset"]) {
      const start = src.indexOf(`export async function ${fn}`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      expect(
        body,
        `${fn} must refuse video from a non-Super — each entry point is callable on its own`,
      ).toMatch(/"VIDEO" && viewer\.kind !== "super"/);
    }
  });

  it("assets are immutable — no update path exists", () => {
    // `guideAsset.update(` specifically — NOT `updateMany`, which purge
    // uses to detach assets from a guide it is destroying. Detaching an
    // owner is not replacing content.
    expect(
      code(SERVICE),
      "guideAsset.update would let a published page's media change without re-approval",
    ).not.toMatch(/guideAsset\.update\(/);
  });

  it("the stored size comes from R2, not from the request", () => {
    // Scoped to the CREATE, not the whole file: the audit metadata also
    // writes `sizeBytes: head.sizeBytes`, so a file-wide match stayed green
    // while the stored column was zeroed.
    const src = code(SERVICE);
    expect(src, "finalizeAsset must headObject the uploaded key").toMatch(/headObject\(/);
    const createStart = src.indexOf("tx.guideAsset.create(");
    expect(createStart, "the asset create was not found").toBeGreaterThan(-1);
    const createBlock = src.slice(createStart, src.indexOf("});", createStart));
    expect(
      createBlock,
      "the stored sizeBytes must come from the verified head, not the client payload",
    ).toMatch(/sizeBytes:\s*head\.sizeBytes/);
  });

  it("the video hard ceiling is not overridable", () => {
    // The override exists for "bigger than usual". It must not be a way
    // past the cap that catches picking the wrong file entirely.
    const src = code(SERVICE);
    expect(src, "the hard ceiling must throw").toMatch(
      /videoHardCeilingBytes\)\s*\{[\s\S]{0,400}?TOO_LARGE/,
    );
    // Order is the real invariant: the ceiling is checked FIRST, so no
    // override path can reach past it. Asserting "the branch mentions no
    // override" is brittle — the soft-limit branch that legitimately does
    // sits a few lines below.
    const ceilingAt = src.indexOf("videoHardCeilingBytes)");
    const overrideAt = src.indexOf("!input.overrideSizeLimit");
    expect(ceilingAt, "the hard ceiling must be checked").toBeGreaterThan(-1);
    expect(overrideAt, "the soft limit must offer an override").toBeGreaterThan(-1);
    expect(
      ceilingAt,
      "the hard ceiling must be checked BEFORE the overridable soft limit, " +
        "or an override would let a wrong-file upload through",
    ).toBeLessThan(overrideAt);
  });

  it("deleting an asset checks for references first", () => {
    const src = code(SERVICE);
    const fn = src.slice(src.indexOf("export async function deleteAsset"));
    expect(fn, "deleteAsset must call guidesReferencing").toMatch(/guidesReferencing\(/);
    expect(fn, "and refuse with IN_USE when something still points at it").toMatch(/IN_USE/);
    expect(
      fn.indexOf("guidesReferencing("),
      "the reference check must run BEFORE the delete",
    ).toBeLessThan(fn.indexOf("guideAsset.delete"));
  });
});

describe("guides build gate — destructive paths", () => {
  it("purge snapshots the guide BEFORE destroying it", () => {
    const src = code(SERVICE);
    const fn = src.slice(src.indexOf("export async function purge"));
    const audit = fn.indexOf("AUDIT.GUIDE.PURGED");
    const del = fn.indexOf("guideVersion.deleteMany");
    expect(audit, "purge must write an audit row").toBeGreaterThan(-1);
    expect(del, "purge must delete the versions").toBeGreaterThan(-1);
    expect(audit, "the snapshot must be written before the delete").toBeLessThan(del);
    expect(fn, "the snapshot must include the version bodies").toMatch(/contentMarkdown: v\.contentMarkdown/);
  });

  it("purge refuses on a guide that is not archived", () => {
    const fn = code(SERVICE).slice(code(SERVICE).indexOf("export async function purge"));
    expect(fn, "permanent delete must require an archived guide first").toMatch(/archivedAt[\s\S]{0,200}BAD_STATE/);
  });
});

describe("guides build gate — view-as honesty", () => {
  // This class of bug has now shipped four times in this repo (see
  // docs/VIEW_AS_ENDPOINTS.md). Guides were the fourth: `guideViewer`
  // originally re-read the caller's roles straight out of the database,
  // which meant a Super using "view as Worker" kept every super power on
  // this tab while every other surface correctly demoted them. The
  // impersonation-adjusted roles live on `req.user`, and that is the only
  // place a role decision may read from.
  it("guideViewer resolves roles from req.user, not a fresh DB lookup", () => {
    const src = code(ROUTES);
    const fn = src.slice(src.indexOf("function guideViewer"), src.indexOf("export default"));
    expect(fn, "guideViewer must exist").toContain("GuideViewer");
    expect(fn, "roles must come from req.user (impersonation-adjusted)").toMatch(
      /req\.user/,
    );
    expect(
      fn,
      "guideViewer must not query the database for roles — that bypasses view-as",
    ).not.toMatch(/prisma\./);
  });

  it("the routes file does not reach for roles any other way", () => {
    const src = code(ROUTES);
    expect(
      src,
      "every role decision in guides routes goes through guideViewer",
    ).not.toMatch(/userRole\.|roles:\s*\{\s*select/);
  });
});

describe("guides build gate — confirm dialogs", () => {
  // "Confirm dialogs are mandatory for mutations" is a load-bearing repo
  // rule (CLAUDE.md), and guides shipped violating it: Approve & publish,
  // Submit, Unpublish and Archive all fired on a single tap. On a phone
  // these buttons sit a thumb-width apart, and Approve puts unreviewed
  // copy in front of every worker with no undo.
  //
  // The check is structural rather than a list of button labels: a
  // mutation must not be invoked straight out of an onClick. It has to go
  // through a state setter that opens a ConfirmDialog first.
  const SURFACES = [
    "apps/web/src/ui/tabs/GuidesTab.tsx",
    "apps/web/src/ui/components/GuideApprovalsSection.tsx",
    "apps/web/src/ui/components/GuideMediaLibrary.tsx",
  ];

  // Saving your own draft is the one exception, and it is a real one:
  // it has no effect outside the editor, changes nothing a worker can
  // read, and an accidental tap costs the author nothing. Every other
  // call goes through a dialog. Widen this list only with a reason.
  const ALLOWED_BARE = /await saveDraft\(/;

  it.each(SURFACES)("%s calls no mutation directly from an onClick", (rel) => {
    const src = code(read(rel));
    const offenders = [...src.matchAll(/onClick=\{(?:[^{}]|\{[^{}]*\})*?\bact\((?:[^{}]|\{[^{}]*\})*?\}/g)]
      .map((m) => m[0])
      .filter((m) => !ALLOWED_BARE.test(m));
    expect(
      offenders,
      "a mutation fires on a single tap — route it through a ConfirmDialog",
    ).toEqual([]);
  });

  it.each(SURFACES)("%s imports ConfirmDialog", (rel) => {
    expect(read(rel)).toMatch(/import ConfirmDialog from/);
  });

  it("every guide mutation the UI exposes is reachable only behind a dialog", () => {
    // Named explicitly, so removing a dialog and re-wiring the button to
    // some other helper still fails. A mutation may only be CALLED from a
    // confirm path: a `run:` thunk on the shared confirm state, or a
    // dialog's own `onConfirm`. Merely mentioning it inside the object
    // passed to `setConfirmAction` is fine — that is the confirm path.
    const CONFIRM_CONTEXT = /(run:\s*\(\)\s*=>|onConfirm)/;
    for (const [rel, fns] of [
      [
        "apps/web/src/ui/tabs/GuidesTab.tsx",
        ["approveVersion", "rejectVersion", "submitForApproval", "unpublishGuide", "setGuideArchived", "purgeGuide"],
      ],
      [
        "apps/web/src/ui/components/GuideApprovalsSection.tsx",
        ["approveVersion", "rejectVersion"],
      ],
    ] as const) {
      const src = code(read(rel));
      for (const fn of fns) {
        const calls = [...src.matchAll(new RegExp(`\\b${fn}\\(`, "g"))];
        expect(calls.length, `${fn} is no longer called in ${rel} — did the button move?`)
          .toBeGreaterThan(0);
        for (const m of calls) {
          // Look back far enough to see which construct we are inside.
          const before = src.slice(Math.max(0, m.index! - 400), m.index!);
          expect(
            CONFIRM_CONTEXT.test(before),
            `${fn} in ${rel} is called outside a confirm path`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("guides build gate — cross-reference links", () => {
  // `guide:<slug>` links are resolved server-side, and that resolution is
  // a second door onto the catalog. A published guide may legitimately
  // link to one still in draft; if the resolver forgets to scope itself,
  // a worker following that link learns the draft's title and id — the
  // exact leak the catalog query exists to prevent.
  it("link resolution is scoped by the same visibility clause as the catalog", () => {
    const src = code(SERVICE);
    const fn = src.slice(
      src.indexOf("export async function resolveGuideLinks"),
      src.indexOf("export async function guidesLinkingTo"),
    );
    expect(fn, "resolveGuideLinks must exist").toContain("prisma.guide.findMany");
    expect(
      fn,
      "link resolution must reuse visibilityWhere — a bespoke where clause drifts from the catalog",
    ).toMatch(/\.\.\.visibilityWhere\(viewer\)/);
  });

  it("the resolve route is worker-guarded and takes the caller's own viewer", () => {
    const src = code(ROUTES);
    const route = src.slice(src.indexOf('"/me/guides/resolve"'));
    const head = route.slice(0, 400);
    expect(head, "resolve must be worker-guarded").toContain("workerGuard");
    expect(
      head,
      "resolve must build the viewer from the request, never take a role from the query",
    ).toMatch(/guideViewer\(req\)/);
  });

  it("the renderer never reveals unpublished targets on a worker surface", () => {
    // `showUnpublishedLinkState` is what separates "author sees a broken
    // link and fixes it" from "worker learns a hidden guide exists". It
    // must never be hard-enabled at a read-only callsite.
    const tab = code(read("apps/web/src/ui/tabs/GuidesTab.tsx"));
    const enables = [...tab.matchAll(/showUnpublishedLinkState(?:=\{([^}]*)\})?/g)].map(
      (m) => (m[1] ?? "true").trim(),
    );
    expect(enables.length, "the flag should be passed explicitly at each callsite").toBeGreaterThan(0);
    for (const value of enables) {
      expect(
        value === "true" || value === "showAdminExtras",
        `showUnpublishedLinkState={${value}} — only an author surface may enable this`,
      ).toBe(true);
    }
    // The bare `showUnpublishedLinkState` (=true) is only allowed on the
    // editing preview, which authors alone can reach.
    const bare = tab.split("showUnpublishedLinkState").length - 1;
    expect(bare, "expected exactly the two guide renderer callsites").toBe(2);
  });

  it("the guide: scheme survives markdown URL sanitization, and nothing else does", () => {
    // react-markdown blanks any href outside http/https/mailto/tel, so
    // without an explicit exception every cross-reference silently
    // becomes an empty link. The exception must stay narrow.
    const md = code(read("apps/web/src/ui/components/MarkdownContent.tsx"));
    expect(md, "a urlTransform must be passed to ReactMarkdown").toMatch(/urlTransform=\{/);
    expect(md, "unknown schemes must still fall through to the library default").toMatch(
      /defaultUrlTransform\(/,
    );
    expect(
      md,
      "the exception must be anchored to the guide: scheme alone",
    ).toMatch(/\^guide:\[a-z0-9\]\[a-z0-9-\]\*\$/);
  });
});

describe("guides build gate — derived fields", () => {
  // `isPublished` is derived from `currentVersionId`, and the client type
  // (GuideDetail extends GuideListItem) promises it on BOTH payloads. The
  // detail endpoint shipped returning the raw Prisma row instead, so the
  // field was undefined while TypeScript insisted it existed: the
  // Unpublish button never rendered, the archive confirm silently dropped
  // its "workers are reading this right now" warning, and the author
  // status strip drew an empty box on every guide.
  it("getGuide returns isPublished, like listGuides does", () => {
    const src = code(SERVICE);
    const fn = src.slice(
      src.indexOf("export async function getGuide"),
      src.indexOf("export async function listPendingApprovals"),
    );
    expect(
      fn,
      "getGuide must derive isPublished — the client type says the field is there",
    ).toMatch(/isPublished:\s*!!/);
  });

  it("the web detail type still inherits isPublished from the list type", () => {
    // If these ever stop sharing a shape, the assertion above stops
    // protecting anything.
    const types = code(read("apps/web/src/lib/guides.ts"));
    expect(types).toMatch(/GuideDetail\s*=\s*GuideListItem\s*&/);
    expect(types).toMatch(/isPublished:\s*boolean/);
  });
});

describe("guides build gate — scope vs payload", () => {
  // Role shells (Worker / Admin / Super tabs) are a CLIENT-side view. A
  // Super browsing the Worker tab without activating "view as" still
  // calls the API with Super privileges, so the payload carries drafts
  // and the author-only fields. GuidesTab originally rendered its badges
  // off those fields with a comment asserting "a worker never receives an
  // unpublished row" — true of a real worker, false of the surface — and
  // "Draft" / "Pending approval" / "Sent back" appeared on the Worker
  // tab. Author affordances must gate on SCOPE.
  const AUTHOR_ONLY_FIELDS = ["pendingVersionId", "draftVersionId", "rejectedVersionId"];

  it("author-only list fields are never rendered without a scope check", () => {
    const tab = code(read("apps/web/src/ui/tabs/GuidesTab.tsx"));
    for (const field of AUTHOR_ONLY_FIELDS) {
      for (const m of tab.matchAll(new RegExp(`\\{[^{}]*\\bg\\.${field}\\b`, "g"))) {
        const clause = m[0];
        expect(
          clause,
          `g.${field} is rendered without showAdminExtras — it will show on the Worker tab`,
        ).toMatch(/showAdminExtras/);
      }
    }
  });

  it("the worker surface filters the catalog to published rows", () => {
    // Presentation, not access control — but without it a Super sees
    // drafts on the Worker tab with no badge at all, which is worse than
    // the badge this rule exists to prevent.
    const tab = code(read("apps/web/src/ui/tabs/GuidesTab.tsx"));
    expect(
      tab,
      "the Worker scope must show only published guides",
    ).toMatch(/showAdminExtras \? rows : rows\.filter\(\(r\) => r\.isPublished\)/);
  });

  it("the author status strip is scope-gated too", () => {
    const tab = code(read("apps/web/src/ui/tabs/GuidesTab.tsx"));
    expect(tab).toMatch(/\{showAdminExtras && \(pending \|\| draft \|\| !guide\.isPublished\)/);
  });
});

describe("guides build gate — the editor never starts blank", () => {
  // A guide submitted for approval but never published has NO draft and
  // NO current version. `draft ?? live` therefore resolved to "" and
  // opened an empty textarea on a guide full of content — and saving
  // over it would have destroyed the author's work. The pending version
  // has to be in the fallback chain, and empty strings have to fall
  // THROUGH rather than win (`??` treats "" as a real value).
  it("beginEdit falls back through draft → pending → live, skipping empties", () => {
    const tab = code(read("apps/web/src/ui/tabs/GuidesTab.tsx"));
    const fn = tab.slice(tab.indexOf("function beginEdit"), tab.indexOf("async function act("));
    expect(fn, "beginEdit must exist").toContain("setBody(");
    expect(
      fn,
      "the pending version must be a fallback — otherwise an awaiting-approval guide opens blank",
    ).toMatch(/\[draft, pending, live\]/);
    expect(
      fn,
      "empty markdown must fall through, so a bare draft cannot blank the editor",
    ).toMatch(/contentMarkdown\?\.trim\(\)/);
    expect(
      fn,
      "the old `draft?.contentMarkdown ?? live?.contentMarkdown` chain must not come back",
    ).not.toMatch(/draft\?\.contentMarkdown \?\? live\?\.contentMarkdown/);
  });
});

describe("guides build gate — media library paging", () => {
  // The library is append-mostly. Assets are immutable and outlive the
  // guides that referenced them, so this list only ever grows — an
  // unpaged version means an unbounded payload and an unbounded wall of
  // rows on a phone.
  it("listAssets pages and returns a total", () => {
    const src = code(SERVICE);
    const fn = src.slice(
      src.indexOf("export async function listAssets"),
      src.indexOf("export async function assetUrl"),
    );
    expect(fn, "listAssets must take a page window").toMatch(/skip:\s*\(page - 1\) \* pageSize/);
    expect(fn, "listAssets must take a page window").toMatch(/take:\s*pageSize/);
    expect(
      fn,
      "the count must use the SAME where clause — a pager over a filtered set must count filtered rows",
    ).toMatch(/guideAsset\.count\(\{\s*where\s*\}\)/);
    expect(fn, "callers need the total to render a pager").toMatch(/return \{ items, total/);
  });

  it("the route forwards paging params", () => {
    const src = code(ROUTES);
    const route = src.slice(src.indexOf('"/guides/assets"'), src.indexOf('"/guides/assets/upload-url"'));
    expect(route).toMatch(/page:/);
    expect(route).toMatch(/pageSize:/);
  });

  it("the client asks for a page and reads the paged shape", () => {
    const lib = code(read("apps/web/src/lib/guides.ts"));
    expect(lib, "fetchAssets must return a page, not a bare array").toMatch(
      /apiGet<GuideAssetPage>/,
    );
    const ui = code(read("apps/web/src/ui/components/GuideMediaLibrary.tsx"));
    expect(ui, "the library must render a pager").toMatch(/page \$\{page\} of \$\{totalPages\}/);
    expect(
      ui,
      "page size must come from the server response, not a duplicated constant",
    ).toMatch(/setPageSize\(res\.pageSize\)/);
    expect(
      ui,
      "a new search must reset to page 1 — staying deep in the old result set reads as 'no matches'",
    ).toMatch(/setPage\(1\)/);
  });
});

describe("guides build gate — pre-ship audit findings", () => {
  // ── 1. The :::video directive routes around the markdown sanitizer ──
  // The directive line is lifted OUT of the source before react-markdown
  // parses, so `urlTransform` — the thing that blanks `javascript:` on
  // every ordinary link — never sees it. A target that is not on the
  // embed allowlist fell through to a plain <a href={target}>, so
  // `:::video javascript:alert(1)` rendered a working javascript: href on
  // a page every worker can open.
  it("a non-allowlisted video target is scheme-checked before it becomes a link", () => {
    const md = code(read("apps/web/src/ui/components/GuideMarkdown.tsx"));
    expect(md, "the scheme check must exist").toMatch(/function isSafeHref/);
    expect(md, "only http/https may be rendered as an href").toMatch(
      /protocol === "http:" \|\| u\.protocol === "https:"/,
    );
    // …and it must be consulted on the fallback path, before the <Link>.
    const fallback = md.slice(md.indexOf("const embed = embedUrlFor"));
    const guardAt = fallback.indexOf("isSafeHref(target)");
    const linkAt = fallback.indexOf("<Link href={target}");
    expect(guardAt, "the fallback must call isSafeHref").toBeGreaterThan(-1);
    expect(guardAt, "the scheme check must run BEFORE the link is rendered").toBeLessThan(linkAt);
  });

  // ── 2. Worker asset access was the one unscoped read ──────────────
  // Every other worker-facing read here is a WHERE clause. assetUrl
  // rested on ids being unguessable cuids — but those ids sit in plain
  // sight inside the markdown of any guide the caller can already fetch,
  // so a worker could keep pulling media from a guide that was later
  // unpublished.
  it("assetUrl scopes workers to assets referenced by a published body", () => {
    const src = code(SERVICE);
    const fn = src.slice(
      src.indexOf("export async function assetUrl"),
      src.indexOf("export async function resolveGuideLinks"),
    );
    expect(fn, "assetUrl must take a viewer at all").toMatch(/viewer: GuideViewer/);
    expect(fn, "workers must be scoped by the shared visibility clause").toMatch(
      /viewer\.kind === "worker"[\s\S]*visibilityWhere\(viewer\)/,
    );
    expect(fn, "the scope check must look for the asset inside a published body").toMatch(
      /currentVersion: \{ contentMarkdown: \{ contains: `guide-asset:\$\{assetId\}` \} \}/,
    );
    expect(
      fn,
      "a blocked asset must 404 like a missing one — never reveal that it exists",
    ).toMatch(/NOT_FOUND", "Asset not found\./);
  });

  // ── 3. The edit path was a back door around create-time validation ──
  it("updateGuideMeta validates title and category, like createGuide", () => {
    const src = code(SERVICE);
    const fn = src.slice(
      src.indexOf("export async function updateGuideMeta"),
      src.indexOf("export async function saveDraft"),
    );
    expect(fn, "an empty title must be rejected on edit, not just on create").toMatch(
      /input\.title !== undefined && !input\.title\.trim\(\)/,
    );
    expect(fn, "the category must be validated against the setting on edit too").toMatch(
      /listCategories\(\)[\s\S]*Unknown category/,
    );
  });
});
