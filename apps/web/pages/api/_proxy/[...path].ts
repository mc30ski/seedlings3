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

  // Build target URL from /api/_proxy/<...path>?<query>
  const parts = ([] as string[]).concat(
    (req.query.path as string[] | string | undefined) ?? []
  );
  const target = new URL(parts.join("/"), base);
  const qIdx = req.url?.indexOf("?") ?? -1;
  if (qIdx >= 0) target.search = req.url!.slice(qIdx);

  // Copy headers (minus hop-by-hop), add bypass header
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
    redirect: "manual",
    cache: "no-store",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    (init as any).body = Buffer.concat(chunks);
  }

  // 1st attempt: header
  let r = await fetch(target.toString(), init);

  // If Vercel still blocks (401 HTML), retry with query-param bypass
  const isVercel401Html =
    r.status === 401 &&
    (r.headers.get("set-cookie")?.includes("_vercel_sso_nonce") ||
      (r.headers.get("content-type") || "").includes("text/html"));

  if (isVercel401Html) {
    const retry = new URL(target.toString());
    retry.searchParams.set("x-vercel-protection-bypass", secret);
    retry.searchParams.set("x-vercel-set-bypass-cookie", "true");
    r = await fetch(retry.toString(), init);
    res.setHeader("x-proxy-retried", "query-bypass");
  }

  // Pass status and headers through (avoid double compression)
  res.status(r.status);
  r.headers.forEach((value: string, key: string): void => {
    if (key.toLowerCase() === "content-encoding") return;
    res.setHeader(key, value);
  });
  res.setHeader("x-proxy-target", target.toString());

  const body = Buffer.from(await r.arrayBuffer());
  res.end(body);
}
