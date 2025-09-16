// apps/web/pages/api/_proxy/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const base = process.env.API_BASE_URL;
  const secret = process.env.API_BYPASS_SECRET;
  if (!base || !secret) {
    res.status(500).json({ ok: false, error: "proxy_misconfigured" });
    return;
  }

  const parts = ([] as string[]).concat(
    (req.query.path as string[] | string | undefined) ?? []
  );
  const url = new URL(parts.join("/"), base);
  const qIndex = req.url?.indexOf("?") ?? -1;
  if (qIndex >= 0) url.search = req.url!.slice(qIndex);

  // Copy headers, drop hop-by-hop, add bypass header
  const headers = new Headers();
  const drop = new Set(["host", "connection", "content-length"]);
  for (const [k, v] of Object.entries(req.headers) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (drop.has(k.toLowerCase()) || v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(",") : v);
  }
  headers.set("x-vercel-protection-bypass", secret);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual", // type: RequestRedirect
    cache: "no-store",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    init.body = Buffer.concat(chunks);
  }

  const r = await fetch(url.toString(), init);

  // Pass status and headers through
  res.status(r.status);
  r.headers.forEach((value: string, key: string): void => {
    if (key.toLowerCase() === "content-encoding") return;
    res.setHeader(key, value);
  });

  const body = Buffer.from(await r.arrayBuffer());
  res.end(body);
}
