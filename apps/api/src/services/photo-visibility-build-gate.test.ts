import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { guardEntitlement } from "../lib/guardIntrospection";

/**
 * WHO A JOB PHOTO IS HIDDEN FROM, AND WHO IT IS NEVER HIDDEN FROM.
 *
 * `JobOccurrencePhoto.hiddenFromPublicAt` holds a photo back from surfaces
 * that put ONE client's property in front of OTHER people:
 *
 *    • a wall display in the waiting room
 *    • /public/feed, which is unauthenticated
 *
 * It must NEVER hide the photo from the client it belongs to. Their portal and
 * their invoice are not an audience — they are who the work was done for, and
 * a photo quietly missing from an invoice looks like work that was not done.
 *
 * Both halves are load-bearing and both fail silently. A new outward surface
 * that forgets the filter leaks a photo someone deliberately pulled down; a
 * well-meaning filter added to the client's own query hides a client's own
 * property from them and nobody finds out from a stack trace.
 */

const API = join(__dirname, "../..");
const FLAG = "hiddenFromPublicAt";

const read = (rel: string) => readFileSync(join(API, "src", rel), "utf8");

/** Prisma photo QUERIES only.
 *
 *  A naive `photos: {` match also catches TypeScript shapes like
 *  `photos: { id: string; url: string }[]`, which are not queries and can
 *  never carry a filter — the first version of this rule failed on one and
 *  reported a leak that did not exist. A query is recognised by the Prisma
 *  keys it must contain. */
function photoQueryBlocks(src: string): string[] {
  const out: string[] = [];
  const push = (i: number) => {
    const block = src.slice(i, i + 400);
    const isTypeShape = /:\s*(string|number|boolean)\b/.test(block.slice(0, 120));
    const isQuery = /\b(select|where|orderBy|include)\s*:/.test(block);
    if (isQuery && !isTypeShape) out.push(block);
  };
  for (const m of src.matchAll(/photos:\s*\{/g)) push(m.index!);
  for (const m of src.matchAll(/jobOccurrencePhoto\.findMany\(\{/g)) push(m.index!);
  return out;
}

/** Prisma schemas carry prose. This rule is about the FIELD, and the field's
 *  own doc comment explains the rename — matching that would be the rule
 *  failing on its own explanation. */
const stripPrismaComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("///"))
    .join("\n");

describe("[build-gate] job photo visibility", () => {
  it("the flag exists and is named for the RULE, not for one screen", () => {
    const schema = stripPrismaComments(readFileSync(join(API, "prisma/schema.prisma"), "utf8"));
    expect(schema, "the opt-out flag must exist").toContain(FLAG);
    // It started life as `hiddenFromDisplayAt` and was already gating two
    // surfaces by the time the second one was found. A flag named for a screen
    // gets read as "only the TV" by the next person adding a surface.
    expect(schema, "a surface-specific name invites the next surface to miss it")
      .not.toContain("hiddenFromDisplayAt");
  });

  it("every OUTWARD-FACING photo query filters on it", () => {
    // The public activity feed is unauthenticated: anyone with the URL sees
    // one client's property. It draws from the same photos as the wall.
    const pub = read("routes/public.ts");
    const feedAt = pub.indexOf('app.get("/public/feed"');
    expect(feedAt, "the public feed must exist").toBeGreaterThan(-1);
    const feed = pub.slice(feedAt, pub.indexOf("app.get(", feedAt + 10));
    const blocks = photoQueryBlocks(feed);
    expect(blocks.length, "the feed must select photos for this rule to matter").toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b, "a photo query in the PUBLIC feed without the filter leaks a pulled-down photo")
        .toContain(`${FLAG}: null`);
    }

    // The wall display's board.
    const disp = read("services/displays.ts");
    const privAt = disp.indexOf("export async function buildPrivateBoard");
    const pubAt = disp.indexOf("export async function buildPublicBoard");
    expect(privAt, "buildPrivateBoard must exist").toBeGreaterThan(-1);
    expect(pubAt, "buildPublicBoard must come after it").toBeGreaterThan(privAt);

    const pubBoard = disp.slice(pubAt);
    expect(pubBoard, "the public board must filter on it").toContain(`${FLAG}: null`);

    // THE SHARE WALL — `GET /photos`, which feeds the Share Photos
    // workflow: pick job photos, post them to Instagram. That is the
    // furthest out a photo can go, and the route predated this gate, so it
    // was offering pulled-down photos for publication. It is also the one
    // outward surface the caller picks FROM by hand, which makes a quiet
    // leak here likelier to be acted on than one on a screen nobody curates.
    const photosAt = disp.length ? read("routes/displays.ts").indexOf('app.get("/photos"') : -1;
    const routes = read("routes/displays.ts");
    expect(photosAt, "the share wall route must exist").toBeGreaterThan(-1);
    const wall = routes.slice(photosAt, routes.indexOf("app.", photosAt + 10));
    expect(wall, "the share wall must filter on the opt-out — it posts to social media")
      .toContain(`${FLAG}: null`);
    // And it must not hand the whole book to the base rung: `schedule.contribute`
    // is its guard, and without in-handler scoping that is every property's
    // address for every trainee.
    expect(wall, "the share wall must scope to the caller's own visits")
      .toMatch(/callerCan\(req, "schedule\.manage"\)/);

    // The PRIVATE board shows today's photos too. It is a back-office screen,
    // not a client-facing one, so the instinct is to let it see everything —
    // but that instinct produces a broken panel, not a more informative one.
    // /public/display/photo/:photoId refuses a hidden photo, and one whose
    // visit is not finished, for EVERY token regardless of mode. A board that
    // selected more broadly would emit URLs that 404 and render as a row of
    // dead tiles.
    const privBoard = disp.slice(privAt, pubAt);
    expect(
      privBoard,
      "the private board selects photos, so it must filter on the flag — the photo route will 404 them anyway",
    ).toContain(`${FLAG}: null`);
    expect(
      privBoard,
      "the private board's photos must be scoped to FINISHED visits, for the same reason",
    ).toMatch(/status:\s*\{\s*in:\s*\[\.\.\.DONE_STATUSES\]/);

    // And the single-photo route a display fetches each image through.
    expect(pub, "the display photo route must refuse a hidden photo")
      .toMatch(/photo\.hiddenFromPublicAt\)?\s*\)?\s*return reply\.code\(404\)/);
  });

  it("a presigned photo URL never reaches a wall display", () => {
    // The signed-in Now board gets direct R2 thumbnails, because its caller
    // can fetch R2 and the display photo route 401s for them. A paired
    // screen must keep going through that route instead, and the difference
    // is not stylistic.
    //
    // /public/display/photo/:photoId re-checks five things on EVERY image:
    // the token, the screen's mode, whether it has been revoked, the photo's
    // opt-out, and whether the visit is finished. A presigned URL answers to
    // none of them. It is a bearer credential, good for an hour to anyone
    // who reads it, and unpairing the screen does not invalidate it — so
    // sending one to a TV in a shop trades five live checks for a link that
    // outlives the device's authorisation.
    const disp = read("services/displays.ts");

    // OFF unless asked for. A default-on flag would put the display on the
    // signing path the moment someone constructed a scope without thinking.
    const scopeAt = disp.indexOf("export type BoardScope");
    expect(scopeAt, "BoardScope must exist").toBeGreaterThan(-1);
    const scope = disp.slice(scopeAt, disp.indexOf("};", scopeAt));
    expect(scope, "the opt-in flag must exist and be optional")
      .toMatch(/signedPhotoUrls\?:\s*boolean/);

    // Signing must be REACHED only through the flag, not merely selected by
    // it afterwards — a presign that always runs and is then discarded still
    // puts the URL in the payload the moment someone widens the mapping.
    const privAt = disp.indexOf("export async function buildPrivateBoard");
    const pubAt = disp.indexOf("export async function buildPublicBoard");
    const priv = disp.slice(privAt, pubAt);
    const signAt = priv.indexOf("getDownloadUrl(");
    expect(signAt, "the private board must presign somewhere").toBeGreaterThan(-1);
    expect(
      priv.slice(0, signAt),
      "presigning must sit behind `if (scope.signedPhotoUrls)` — otherwise " +
        "every caller signs, including the wall display",
    ).toMatch(/if \(scope\.signedPhotoUrls\)/);

    // And the two callers must stay on the right side of it.
    const routes = read("routes/occurrences.ts");
    const nowAt = routes.indexOf('app.get("/board/now"');
    expect(nowAt, "the Now route must exist").toBeGreaterThan(-1);
    expect(
      routes.slice(nowAt, nowAt + 900),
      "the signed-in board is the one caller that may ask for presigned URLs",
    ).toMatch(/signedPhotoUrls:\s*true/);

    const pubRoutes = read("routes/public.ts");
    const boardAt = pubRoutes.indexOf("buildPrivateBoard");
    expect(boardAt, "the display route must still build a private board").toBeGreaterThan(-1);
    expect(
      pubRoutes.slice(Math.max(0, boardAt - 200), boardAt + 200),
      "the DISPLAY's board must not ask for presigned URLs — it has a photo " +
        "route that re-checks the token, the mode, revocation and the opt-out",
    ).not.toMatch(/signedPhotoUrls/);
  });

  it("the CLIENT'S OWN views never filter on it", () => {
    // The whole point of the opt-out is that it is about other people's eyes.
    // A client missing a photo of their own lawn on their own invoice reads as
    // work that was not done.
    const client = read("routes/client.ts");
    expect(
      client,
      "routes/client.ts is the signed-in client's own portal — it must NOT hide their own photos",
    ).not.toContain(FLAG);

    const invoices = read("services/paymentRequests.ts");
    expect(
      invoices,
      "an invoice must show every photo of the work it is billing for",
    ).not.toContain(FLAG);
  });

  it("only someone with settings authority can change it", () => {
    // Photo visibility sits with the wall screens it governs.
    const admin = read("routes/displays.ts");
    const at = admin.indexOf('app.post("/photos/:photoId/visibility"');
    expect(at, "the visibility route must exist").toBeGreaterThan(-1);
    // Asserts the CAPABILITY, not a role. Phrased in roles this gate would
    // have had to be relaxed the moment somebody delegated display
    // management without handing over everything else.
    const guard = /,\s*([A-Za-z][A-Za-z0-9_]*)\s*,/.exec(admin.slice(at, at + 160))?.[1];
    expect(guard, "could not read the guard off the visibility route").toBeTruthy();
    expect(
      guardEntitlement(admin, guard!),
      "changing what the outside world sees belongs with managing the screens it shows on",
    ).toBe("displays.manage");
  });

  it("no route is named for a single surface any more", () => {
    // The `super`-prefixed displays-photos route was the original home, and
    // honest the moment the public feed turned out to show the same photos.
    const files = readdirSync(join(API, "src/routes")).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      expect(
        read(`routes/${f}`),
        `${f} still routes photo visibility under /displays, which reads as TV-only`,
      ).not.toContain("/super/displays/photos");
    }
  });
});
