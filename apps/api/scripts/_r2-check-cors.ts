import "dotenv/config";
import { S3Client, GetBucketCorsCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});

const BUCKETS = [
  "seedlings-receipts",
  "seedlings-receipts-dev",
  "seedlings-photos",
  "seedlings-photos-dev",
  "seedlings-documents",
  "seedlings-documents-dev",
  "seedlings-property-photos",
  "seedlings-property-photos-dev",
  "seedlings-equipment-photos",
  "seedlings-equipment-photos-dev",
  "seedlings-promotions",
  "seedlings-promotions-dev",
  "seedlings-guides",
  "seedlings-guides-dev",
];

(async () => {
  for (const bucket of BUCKETS) {
    console.log(`\n=== ${bucket} ===`);
    try {
      const res = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const rules = res.CORSRules ?? [];
      if (rules.length === 0) {
        console.log("  NO CORS RULES SET");
        continue;
      }
      for (const [i, r] of rules.entries()) {
        console.log(`  rule ${i}:`);
        console.log(`    AllowedOrigins: ${JSON.stringify(r.AllowedOrigins ?? [])}`);
        console.log(`    AllowedMethods: ${JSON.stringify(r.AllowedMethods ?? [])}`);
        console.log(`    AllowedHeaders: ${JSON.stringify(r.AllowedHeaders ?? [])}`);
        console.log(`    ExposeHeaders:  ${JSON.stringify(r.ExposeHeaders ?? [])}`);
        console.log(`    MaxAgeSeconds:  ${r.MaxAgeSeconds ?? "-"}`);
      }
    } catch (err: any) {
      const code = err?.Code || err?.name || "unknown";
      console.log(`  ERROR ${code}: ${err?.message ?? err}`);
    }
  }
})();
