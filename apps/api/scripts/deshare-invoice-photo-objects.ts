/**
 * One-off: give every invoice photo its OWN R2 object.
 *
 * WHY
 * The `add_promotion_invoice_photos` migration backfilled invoice photos by
 * copying each promo's derived cover key:
 *
 *     INSERT INTO "PromotionInvoicePhoto" (..., "r2Key", ...)
 *     SELECT ..., ph."r2Key", ... FROM "PromotionLandingPageItemPhoto" ph ...
 *
 * `r2Key` is a POINTER, not the bytes. So a backfilled invoice photo and the
 * landing-item photo it came from address the SAME stored object. Deleting
 * either row used to destroy that object, breaking the other surface — an
 * operator removed an invoice cover and their landing-page photos turned
 * into broken-image icons. Real, unrecoverable data loss.
 *
 * `deleteR2ObjectIfUnreferenced` in services/promotions.ts now refuses to
 * delete bytes that another row still points at, so the damage is stopped.
 * But shared ownership is still a latent trap: it makes "delete this photo"
 * quietly not free the storage, and it means any future code path that
 * deletes by key can resurrect the bug. This script removes the sharing
 * itself so the invariant becomes "one row, one object".
 *
 * WHY NOT FIX THE MIGRATION
 * It has already been applied. Editing an applied migration produces
 * checksum drift that breaks dev and can strand prod — see
 * memory/feedback_never_edit_applied_migrations.md. A SQL migration also
 * cannot copy object bytes; that needs an S3 CopyObject call. Hence a
 * script.
 *
 * WHAT IT DOES
 * For every PromotionInvoicePhoto whose r2Key is also referenced by a
 * PromotionLandingPageItemPhoto:
 *   1. copy the object to a fresh invoice-namespaced key
 *   2. point the invoice row at the copy
 * The landing item keeps the original. Nothing is deleted.
 *
 * SAFE TO RE-RUN. Once a row has its own object it is no longer shared, so
 * a second run finds nothing. Sources that no longer exist in R2 (already
 * destroyed by the original bug) are reported and skipped, never deleted.
 *
 * USAGE
 *   cd apps/api
 *   npx tsx scripts/deshare-invoice-photo-objects.ts --dry-run
 *   npx tsx scripts/deshare-invoice-photo-objects.ts
 *
 * Run once per environment, AFTER the migration is applied there.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { copyObject, getObjectBuffer } from "../src/lib/r2";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry-run");

async function main() {
  const invoicePhotos = await prisma.promotionInvoicePhoto.findMany({
    select: { id: true, promotionId: true, r2Key: true, sortOrder: true },
    orderBy: [{ promotionId: "asc" }, { sortOrder: "asc" }],
  });
  if (invoicePhotos.length === 0) {
    console.log("No invoice photos. Nothing to do.");
    return;
  }

  // Which of those keys are also owned by a landing item? Query by the
  // exact key set rather than loading every landing photo — the invoice
  // table is the small one.
  const keys = [...new Set(invoicePhotos.map((p) => p.r2Key))];
  const landingRefs = await prisma.promotionLandingPageItemPhoto.findMany({
    where: { r2Key: { in: keys } },
    select: { r2Key: true },
  });
  const sharedKeys = new Set(landingRefs.map((r) => r.r2Key));

  const shared = invoicePhotos.filter((p) => sharedKeys.has(p.r2Key));
  console.log(
    `${invoicePhotos.length} invoice photo(s); ${shared.length} share an ` +
      `object with a landing item${DRY ? "  [DRY RUN]" : ""}`,
  );
  if (shared.length === 0) {
    console.log("Every invoice photo already owns its object. Nothing to do.");
    return;
  }

  let copied = 0;
  const missing: string[] = [];
  const failed: string[] = [];

  for (const photo of shared) {
    const destKey = `promotions/${photo.promotionId}/invoice/${randomUUID()}`;
    // Verify the source still exists before rewriting the row. If the bytes
    // are already gone (destroyed by the original bug), repointing the row
    // at a copy that was never made would swap one broken image for
    // another AND lose the forensic trail of which key it used to be.
    try {
      await getObjectBuffer(photo.r2Key, "promotion-images", 50_000_000);
    } catch {
      missing.push(`${photo.id}  ${photo.r2Key}`);
      continue;
    }
    if (DRY) {
      console.log(`  would copy ${photo.r2Key}\n           -> ${destKey}`);
      copied++;
      continue;
    }
    try {
      await copyObject(photo.r2Key, destKey, "promotion-images");
      await prisma.promotionInvoicePhoto.update({
        where: { id: photo.id },
        data: { r2Key: destKey },
      });
      console.log(`  copied ${photo.id} -> ${destKey}`);
      copied++;
    } catch (err: any) {
      // Copy failed, or the row update failed after a successful copy. The
      // row still points at the original either way, so the surface keeps
      // working and a re-run retries it. Worst case: one stranded object.
      failed.push(`${photo.id}  ${err?.message ?? String(err)}`);
    }
  }

  console.log(`\n${DRY ? "Would copy" : "Copied"}: ${copied}`);
  if (missing.length > 0) {
    console.log(
      `\nSource object GONE for ${missing.length} row(s) — left untouched:\n  ` +
        missing.join("\n  ") +
        `\n\nThese images were destroyed before the delete fix landed. The\n` +
        `bytes are unrecoverable; delete the photo in the Invoice photos\n` +
        `panel and re-upload it.`,
    );
  }
  if (failed.length > 0) {
    console.log(`\nFAILED (safe to re-run) for ${failed.length}:\n  ` + failed.join("\n  "));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
