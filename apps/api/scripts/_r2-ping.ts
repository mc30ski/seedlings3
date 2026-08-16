import "dotenv/config";
import { getUploadUrl, deleteObject } from "../src/lib/r2";

// Uses the SAME r2 lib the API uses, so a failure here means the API's
// R2 credentials or endpoint config is broken — not that receipts have
// any special bug.

(async () => {
  const key = `receipts/_diag/${Date.now()}-ping.txt`;
  console.log("Requesting presigned PUT for key:", key);
  try {
    const url = await getUploadUrl(key, "text/plain", 300, "receipts");
    console.log("  ok, url length =", url.length);
    console.log("  url starts with:", url.slice(0, 80) + "...");
    console.log("");
    console.log("Attempting PUT with content-type text/plain...");
    const res = await fetch(url, {
      method: "PUT",
      body: "hello world",
      headers: { "Content-Type": "text/plain" },
    });
    console.log("  PUT status:", res.status, res.statusText);
    if (!res.ok) {
      const body = await res.text();
      console.log("  PUT body:", body.slice(0, 500));
    } else {
      console.log("  UPLOAD SUCCEEDED. Cleaning up...");
      await deleteObject(key, "receipts");
      console.log("  cleaned up.");
    }
  } catch (err: any) {
    console.log("  FAILED:", err?.message ?? err);
  }
})();
