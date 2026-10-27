/**
 * Upload the dev placeholder objects `prisma/seed.ts` expects to already be
 * in R2 under `seed/landscaping/NN.jpg`.
 *
 * The seed comment says these keys "OUTLIVE a reseed", so it only recreates
 * the ROWS. When the bucket is empty the rows point at nothing: the public
 * wall display renders broken frames and `display-stale-links-owner.spec.ts`
 * fails on its first `expect(200)` — four security assertions about revoked
 * screens and hidden photos that never get to run.
 *
 * DEV ONLY, and it refuses to run against anything else: it writes to
 * whatever `R2_BUCKET_NAME` points at, and the guard below is the only thing
 * standing between that and a production bucket.
 *
 *   npx tsx scripts/seed-photo-objects.ts <dir-of-jpegs>
 *
 * Files are matched by basename: `00.jpg` lands at `seed/landscaping/00.jpg`.
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { putObjectBuffer, headObject } from "../src/lib/r2";

const BUCKET = process.env.R2_BUCKET_NAME ?? "";
const KEYS = ["00", "01", "02", "03", "04", "05", "07"];

async function main() {
  if (!/-dev$/.test(BUCKET)) {
    throw new Error(
      `Refusing to write: R2_BUCKET_NAME is "${BUCKET}", which is not a -dev bucket.`,
    );
  }
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: tsx scripts/seed-photo-objects.ts <dir-of-jpegs>");

  const available = new Map(
    readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === ".jpg")
      .map((f) => [basename(f, ".jpg"), join(dir, f)]),
  );

  console.log(`Bucket: ${BUCKET}`);
  for (const n of KEYS) {
    const src = available.get(n);
    const key = `seed/landscaping/${n}.jpg`;
    if (!src) {
      console.log(`  skip   ${key} — no ${n}.jpg in ${dir}`);
      continue;
    }
    const bytes = readFileSync(src);
    await putObjectBuffer(key, bytes, "image/jpeg");
    const head = await headObject(key, "photos");
    console.log(`  put    ${key}  ${head?.sizeBytes ?? "?"} bytes`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
