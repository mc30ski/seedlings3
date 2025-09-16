// apps/web/pages/api/_proxy/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const base = process.env.API_BASE_URL;
  const rawSecret = process.env.API_BYPASS_SECRET;
  const secret = rawSecret?.trim();
  if (!base || !secret) {
    res.status(500).json({ ok: false, error: "proxy_misconfigured" });
    return;
  }

  // Build target URL: API_BASE_URL + /<joined path> + original ?query
  const parts = ([] as string[]).concat(
    (req.query.path as string[] | string | undefined) ?? []
  );
  const target = new URL(parts.join("/"), base);
  const qIdx = req.url?.indexOf("?") ?? -1;
  if (qIdx >= 0) target.search = req.url!.slice(qIdx);

  // Hop-by-hop header filter
  const fwdHeaders = new Headers();
  const drop = new Set(["host", "connection", "content-length"]);
  for (const [k, v] of Object.entries(req.headers) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (drop.has(k.toLowerCase()) || v == null) continue;
    fwdHeaders.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  const init: RequestInit = {
    method: req.method,
    headers: fwdHeaders,
    redirect: "manual",
    cache: "no-store",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    (init as any).body = Buffer.concat(chunks);
  }

  // 1) First request: add bypass as QUERY PARAMS (no header), ask Vercel to set cookie
  const withBypass = new URL(target.toString());
  withBypass.searchParams.set("x-vercel-protection-bypass", secret);
  withBypass.searchParams.set("x-vercel-set-bypass-cookie", "true");

  let r = await fetch(withBypass.toString(), init);

  // 2) If Vercel returns a redirect with Set-Cookie, follow-up with the cookie to the ORIGINAL target
  const setCookie = r.headers.get("set-cookie");
  const isRedirect = r.status >= 300 && r.status < 400;
  const looksLikeVercelAuth =
    r.status === 401 ||
    (setCookie?.includes("_vercel_") ?? false) ||
    (r.headers.get("content-type") || "").includes("text/html");

  if ((isRedirect || looksLikeVercelAuth) && setCookie) {
    // Extract cookie pair (up to first ';') and retry to the original target
    const cookiePair = setCookie.split(";")[0];
    const retryHeaders = new Headers(fwdHeaders);
    retryHeaders.set("cookie", cookiePair);
    const retryInit: RequestInit = {
      ...init,
      headers: retryHeaders,
      redirect: "manual",
    };
    r = await fetch(target.toString(), retryInit);
    res.setHeader("x-proxy-retried", "cookie");
  }

  // 3) Pass status and headers through (avoid double compression)
  res.status(r.status);
  r.headers.forEach((value: string, key: string): void => {
    if (key.toLowerCase() === "content-encoding") return;
    res.setHeader(key, value);
  });
  res.setHeader("x-proxy-target", target.toString());

  const body = Buffer.from(await r.arrayBuffer());
  res.end(body);
}
