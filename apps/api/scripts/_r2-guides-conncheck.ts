import "dotenv/config";
import { getUploadUrl, headObject, getDownloadUrl, deleteObject } from "../src/lib/r2";

(async () => {
  console.log("bucket:", process.env.R2_GUIDE_MEDIA_BUCKET_NAME);
  const key = `guides/_conncheck/${Date.now()}.txt`;
  const body = "seedlings guide-media connection check";
  try {
    const put = await getUploadUrl(key, "text/plain", 300, "guide-media");
    console.log("presign: OK");
    const r = await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body });
    console.log("PUT:", r.status, r.statusText);
    if (!r.ok) { console.log(await r.text()); process.exit(1); }
    console.log("HEAD:", JSON.stringify(await headObject(key, "guide-media")));
    const dl = await getDownloadUrl(key, 300, "guide-media");
    const g = await fetch(dl);
    console.log("GET:", g.status, JSON.stringify(await g.text()));
    await deleteObject(key, "guide-media");
    console.log("DELETE: OK");
    console.log("post-delete HEAD:", JSON.stringify(await headObject(key, "guide-media")));
  } catch (e: any) {
    console.log("ERROR", e?.name, e?.message);
    process.exit(1);
  }
  process.exit(0);
})();
