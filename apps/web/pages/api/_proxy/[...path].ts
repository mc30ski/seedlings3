// pages/api/_proxy/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const base = process.env.API_BASE_URL;
  const bypass = (process.env.API_BYPASS_SECRET || "").trim();

  if (!base) {
    res.status(500).json({ ok: false, error: "proxy_misconfigured_base" });
    return;
  }

  // Build target URL: API_BASE_URL + /<joined path> + original search
  const parts = ([] as string[]).concat(
    (req.query.path as string[] | string | undefined) ?? []
  );
  const target = new URL(parts.join("/"), base);
  const qIdx = req.url?.indexOf("?") ?? -1;
  if (qIdx >= 0) target.search = req.url!.slice(qIdx);

  // Forward headers, minus hop-by-hop and anything you don't want to leak
  const fwd = new Headers();
  const drop = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding", // avoid compressed upstream body piping issues
    "cookie", // don't forward browser cookies to your API project
  ]);
  for (const [k, v] of Object.entries(req.headers) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (drop.has(k.toLowerCase()) || v == null) continue;
    fwd.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  // Add bypass header for preview-protected API deployments (safe to send always;
  // in Production you can just not define API_BYPASS_SECRET)
  if (bypass) fwd.set("x-vercel-protection-bypass", bypass);

  const init: RequestInit = {
    method: req.method,
    headers: fwd,
    redirect: "manual",
    cache: "no-store",
  };

  // Stream body for non-GET/HEAD
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    (init as any).body = Buffer.concat(chunks);
  }

  // Single, straightforward fetch
  const upstream = await fetch(target.toString(), init);

  // Mirror status/headers (avoid double compression)
  res.status(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    if (key.toLowerCase() === "content-encoding") continue;
    res.setHeader(key, value);
  }

  // Optional: debugging
  res.setHeader("x-proxy-target", target.toString());
  res.setHeader("x-proxy-bypass", bypass ? "header" : "none");

  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
}
