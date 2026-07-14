import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ENDPOINT = process.env.R2_ENDPOINT!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = process.env.R2_BUCKET_NAME!;
const R2_DOCS_BUCKET = process.env.R2_DOCS_BUCKET_NAME!;
const R2_PROPERTY_PHOTOS_BUCKET = process.env.R2_PROPERTY_PHOTOS_BUCKET_NAME!;
const R2_EQUIPMENT_PHOTOS_BUCKET = process.env.R2_EQUIPMENT_PHOTOS_BUCKET_NAME!;
const R2_RECEIPTS_BUCKET = process.env.R2_RECEIPTS_BUCKET_NAME!;

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

type BucketType = "photos" | "docs" | "property-photos" | "equipment-photos" | "receipts";

function bucketName(type: BucketType): string {
  if (type === "docs") return R2_DOCS_BUCKET;
  if (type === "property-photos") return R2_PROPERTY_PHOTOS_BUCKET;
  if (type === "equipment-photos") return R2_EQUIPMENT_PHOTOS_BUCKET;
  if (type === "receipts") return R2_RECEIPTS_BUCKET;
  return R2_BUCKET;
}

/** Generate a presigned PUT URL for direct client upload. */
export async function getUploadUrl(key: string, contentType: string, expiresIn = 300, bucket: BucketType = "photos"): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucketName(bucket),
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, {
    expiresIn,
    signableHeaders: new Set(["content-type"]),
    unhoistableHeaders: new Set(["x-amz-checksum-crc32"]),
  });
}

/** Generate a presigned GET URL for viewing/downloading.
 *  `disposition` controls the response Content-Disposition header that R2
 *  will return: "inline" lets browsers render the file in a tab (PDF, image),
 *  "attachment" forces a download with the suggested filename. If a filename
 *  is provided, it's encoded into the disposition header.
 */
export async function getDownloadUrl(
  key: string,
  expiresIn = 3600,
  bucket: BucketType = "photos",
  disposition?: { mode: "inline" | "attachment"; filename?: string },
): Promise<string> {
  const respHeader = disposition
    ? `${disposition.mode}${disposition.filename ? `; filename="${disposition.filename.replace(/"/g, "")}"` : ""}`
    : undefined;
  const command = new GetObjectCommand({
    Bucket: bucketName(bucket),
    Key: key,
    ResponseContentDisposition: respHeader,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

/** Delete an object from R2. */
export async function deleteObject(key: string, bucket: BucketType = "photos"): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: bucketName(bucket),
    Key: key,
  });
  await s3.send(command);
}

/**
 * Fetch an object's body as a UTF-8 string. For text content only (markdown,
 * plain text) — the caller is responsible for not invoking this on binaries.
 * `maxBytes` guards against streaming an unexpectedly huge object.
 */
export async function getObjectText(
  key: string,
  bucket: BucketType = "photos",
  maxBytes = 2_000_000,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucketName(bucket), Key: key });
  const res = await s3.send(command);
  if (res.ContentLength != null && res.ContentLength > maxBytes) {
    throw new Error(`Object too large to read as text (${res.ContentLength} bytes).`);
  }
  // `transformToString` is provided by the AWS SDK v3 streaming body.
  const body = res.Body as { transformToString?: (enc?: string) => Promise<string> } | undefined;
  if (!body?.transformToString) {
    throw new Error("Object body is not readable as text.");
  }
  return body.transformToString("utf-8");
}

/**
 * Fetch an object's raw bytes as a Buffer. Used by the Google Drive
 * backup worker to stream a version's PDF (or any binary) into Drive.
 * `maxBytes` guards against loading a surprise multi-GB blob into
 * memory — cap defaults to 100MB, well above the CompanyDocument
 * max-size setting (25MB default).
 */
export async function getObjectBuffer(
  key: string,
  bucket: BucketType = "photos",
  maxBytes = 100_000_000,
): Promise<{ bytes: Buffer; contentType: string | undefined }> {
  const command = new GetObjectCommand({ Bucket: bucketName(bucket), Key: key });
  const res = await s3.send(command);
  if (res.ContentLength != null && res.ContentLength > maxBytes) {
    throw new Error(`Object too large to buffer (${res.ContentLength} bytes).`);
  }
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) {
    throw new Error("Object body is not readable as bytes.");
  }
  const arr = await body.transformToByteArray();
  return { bytes: Buffer.from(arr), contentType: res.ContentType };
}
