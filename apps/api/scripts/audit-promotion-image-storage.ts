/**
 * Report on promotion-image storage: orphaned objects, dangling rows, and
 * oversized images.
 *
 * READ-ONLY BY DEFAULT. Deleting anything requires --delete-orphans, and
 * even then only objects that NO row references.
 *
 * WHY THIS EXISTS
 * Every R2 cleanup path in promotions.ts is best-effort fire-and-forget:
 *
 *     void deleteObject(key, "promotion-images").catch(() => {});
 *
 * That's the right call at request time — a failed storage delete
 * shouldn't fail the operator's edit — but it means a failure leaves no
 * trace anywhere. Objects outlive their rows silently and nothing ever
 * looks for them. This is the reconciliation pass that closes that loop.
 *
 * It reports three things:
 *
 *   ORPHANED OBJECTS  bytes in R2 that no DB row points at. Wasted spend.
 *                     Caused by a failed delete, or a crash between the
 *                     R2 upload and the confirm call.
 *
 *   DANGLING ROWS     rows pointing at objects that no longer exist. These
 *                     render as broken images to CLIENTS, so they matter
 *                     more than orphans. Fix by deleting the photo in the
 *                     UI and re-uploading.
 *
 *   OVERSIZED         objects far larger than their render size. Uploads
 *                     now run through compressOnly() client-side, but
 *                     anything uploaded before that fix is still full
 *                     size — a phone original served to a client on cell
 *                     data to be drawn as an 80px thumbnail.
 *
 * USAGE
 *   cd apps/api
 *   npx tsx scripts/audit-promotion-image-storage.ts
 *   npx tsx scripts/audit-promotion-image-storage.ts --delete-orphans
 */
import { PrismaClient } from "@prisma/client";
import { listObjects, deleteObject } from "../src/lib/r2";

const prisma = new PrismaClient();
const DELETE_ORPHANS = process.argv.includes("--delete-orphans");
/** Anything above this is far past what these surfaces render. */
const OVERSIZE_BYTES = 1_000_000;

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

async function main() {
  const [invoice, landing, objects] = await Promise.all([
    prisma.promotionInvoicePhoto.findMany({
      select: {
        id: true, r2Key: true, promotionId: true, sortOrder: true,
        promotion: { select: { title: true } },
      },
    }),
    prisma.promotionLandingPageItemPhoto.findMany({
      select: {
        id: true, r2Key: true, itemId: true, sortOrder: true,
        item: {
          select: {
            title: true,
            page: { select: { promotion: { select: { title: true } } } },
          },
        },
      },
    }),
    listObjects("promotions/", "promotion-images"),
  ]);

  // Raw R2 keys don't tell an operator where to click. Map every key to the
  // surface that owns it so the report is actionable: which promotion,
  // which landing entry, whether it's the cover.
  const whereUsed = new Map<string, string[]>();
  const note = (key: string, label: string) => {
    const list = whereUsed.get(key) ?? [];
    list.push(label);
    whereUsed.set(key, list);
  };
  for (const r of invoice) {
    note(
      r.r2Key,
      `"${r.promotion?.title ?? r.promotionId}" → Invoice photos` +
        (r.sortOrder === 0 ? " (COVER)" : ` (#${r.sortOrder + 1})`),
    );
  }
  for (const r of landing) {
    const promo = r.item?.page?.promotion?.title ?? "(unknown promo)";
    note(
      r.r2Key,
      `"${promo}" → Landing page → "${r.item?.title ?? r.itemId}"` +
        (r.sortOrder === 0 ? " (first photo)" : ` (#${r.sortOrder + 1})`),
    );
  }

  // The deprecated single-image column still holds keys on pre-migration
  // rows, and the delete paths still clean them up — so a key living only
  // there is referenced, not orphaned.
  const legacy = await prisma.promotionLandingPageItem.findMany({
    where: { imageR2Key: { not: null } },
    select: { id: true, imageR2Key: true },
  });

  const referenced = new Set<string>([
    ...invoice.map((r) => r.r2Key),
    ...landing.map((r) => r.r2Key),
    ...legacy.map((r) => r.imageR2Key as string),
  ]);
  const present = new Map(objects.map((o) => [o.key, o.size]));

  const orphans = objects.filter((o) => !referenced.has(o.key));
  const dangling = [
    ...invoice
      .filter((r) => !present.has(r.r2Key))
      .map((r) => `invoice  ${r.id}  promo=${r.promotionId}  ${r.r2Key}`),
    ...landing
      .filter((r) => !present.has(r.r2Key))
      .map((r) => `landing  ${r.id}  item=${r.itemId}  ${r.r2Key}`),
  ];
  const oversized = objects
    .filter((o) => referenced.has(o.key) && o.size > OVERSIZE_BYTES)
    .sort((a, b) => b.size - a.size);

  const totalBytes = objects.reduce((n, o) => n + o.size, 0);
  console.log(
    `objects: ${objects.length}   rows referencing: ${referenced.size}   ` +
      `total: ${mb(totalBytes)}\n`,
  );

  console.log(`ORPHANED OBJECTS (no row points at them): ${orphans.length}`);
  for (const o of orphans) console.log(`   ${mb(o.size).padStart(9)}  ${o.key}`);
  if (orphans.length > 0) {
    console.log(`   reclaimable: ${mb(orphans.reduce((n, o) => n + o.size, 0))}`);
  }

  console.log(`\nDANGLING ROWS (object missing — CLIENTS SEE A BROKEN IMAGE): ${dangling.length}`);
  for (const d of dangling) console.log(`   ${d}`);
  if (dangling.length > 0) {
    console.log(
      `   These render broken on live surfaces. Delete the photo in the UI\n` +
        `   and re-upload — the bytes are not recoverable from here.`,
    );
  }

  console.log(`\nOVERSIZED (> ${mb(OVERSIZE_BYTES)}, still referenced): ${oversized.length}`);
  for (const o of oversized) {
    console.log(`   ${mb(o.size).padStart(9)}  ${o.key}`);
    // One object can be referenced from several places (the invoice-photo
    // backfill shared keys), so re-uploading it in ONE spot won't shrink
    // the others — list every surface that serves these bytes.
    for (const label of whereUsed.get(o.key) ?? []) {
      console.log(`               ↳ ${label}`);
    }
  }
  if (oversized.length > 0) {
    console.log(
      `   total: ${mb(oversized.reduce((n, o) => n + o.size, 0))} served to clients.\n` +
        `   Uploads compress now; these predate that. Re-upload them through\n` +
        `   the UI to shrink them.`,
    );
  }

  if (DELETE_ORPHANS && orphans.length > 0) {
    console.log(`\nDeleting ${orphans.length} orphaned object(s)...`);
    let ok = 0;
    for (const o of orphans) {
      try {
        // Awaited, unlike the request-time paths: this is a maintenance
        // run, so a failure should be reported rather than swallowed.
        await deleteObject(o.key, "promotion-images");
        ok++;
      } catch (err: any) {
        console.log(`   FAILED  ${o.key}  ${err?.message ?? String(err)}`);
      }
    }
    console.log(`Deleted ${ok}/${orphans.length}.`);
  } else if (orphans.length > 0) {
    console.log(`\nRe-run with --delete-orphans to reclaim that space.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
