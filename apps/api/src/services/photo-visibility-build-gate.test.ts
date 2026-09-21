import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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
    const pubBoard = disp.slice(disp.indexOf("buildPublicBoard"));
    expect(pubBoard, "the public board must filter on it").toContain(`${FLAG}: null`);

    // And the single-photo route a display fetches each image through.
    expect(pub, "the display photo route must refuse a hidden photo")
      .toMatch(/photo\.hiddenFromPublicAt\)?\s*\)?\s*return reply\.code\(404\)/);
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

  it("only a Super can change it", () => {
    const admin = read("routes/admin.ts");
    const at = admin.indexOf('app.post("/super/photos/:photoId/visibility"');
    expect(at, "the visibility route must exist").toBeGreaterThan(-1);
    expect(
      admin.slice(at, at + 120),
      "changing what the outside world sees is a Super decision, like pairing a screen",
    ).toContain("superGuard");
  });

  it("no route is named for a single surface any more", () => {
    // `/super/displays/photos` was the original home, and it stopped being
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
