import type { NextApiRequest, NextApiResponse } from "next";

// Runs on the Next.js server.
// Proxies all network requests.
// Needed because the Vercel preview URLs have protection and need a special API_BYPASS_SECRET token to access.
// Web app (Browser) ->(bypass token)-> Next.js Proxy (Server) ->(bypass token)-> API (separate project)

export const config = { api: { bodyParser: false } };

async function fetchFollowWithCookie(
  url: string,
  init: RequestInit,
  opts: { maxHops?: number } = {}
) {
  const maxHops = opts.maxHops ?? 7;

  // Clone/normalize headers we’ll mutate across hops
  const headers = new Headers(init.headers || {});

  // Build a cookie jar as a Map<string, string> (name -> value)
  const jar = new Map<string, string>();

  // Seed the jar from any incoming Cookie header
  const seedCookie = headers.get("cookie");
  if (seedCookie) {
    for (const pair of seedCookie.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1);
      jar.set(name, value);
    }
  }

  // Helper to apply jar to headers
  const applyJarToHeaders = () => {
    if (jar.size === 0) {
      headers.delete("cookie");
    } else {
      const cookieHeader = Array.from(jar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      headers.set("cookie", cookieHeader);
    }
  };

  // Helper to merge Set-Cookie(s) into jar (keeps only name=value)
  const mergeSetCookie = (setCookieHeader: string | null) => {
    if (!setCookieHeader) return;
    // split multiple Set-Cookie values safely (commas only between cookie records)
    const records = setCookieHeader.split(/,(?=\s*\w+=)/);
    for (const rec of records) {
      const firstPart = rec.split(";")[0].trim(); // "name=value"
      const eq = firstPart.indexOf("=");
      if (eq <= 0) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1);
      if (!name) continue;
      jar.set(name, value);
    }
  };

  // Follow redirects (carry cookies + guard loops)
  let currentUrl = url;
  const seen = new Set<string>();

  for (let i = 0; i <= maxHops; i++) {
    applyJarToHeaders();

    const res = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: "manual",
    });

    // If upstream wants to set cookies (e.g., _vercel_jwt), store them for next hop
    mergeSetCookie(res.headers.get("set-cookie"));

    // Not a redirect? we’re done.
    const loc = res.headers.get("location");
    const is3xx = res.status >= 300 && res.status < 400 && !!loc;
    if (!is3xx) return res;

    // Resolve absolute next URL
    const nextUrl = new URL(loc!, currentUrl).toString();

    // Loop guard (helps with ping-pong)
    const sig = `${res.status} ${currentUrl} -> ${nextUrl}`;
    if (seen.has(sig)) return res;
    seen.add(sig);

    currentUrl = nextUrl;
  }

  // Exceeded max hops: final manual fetch (returns the last 3xx)
  applyJarToHeaders();

  return fetch(currentUrl, { ...init, headers, redirect: "manual" });
}

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
    "accept-encoding", // avoid compressed body issues
    "x-forwarded-host", // can trigger canonical host redirects
    "x-forwarded-proto",
    "x-real-ip",
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

  const upstream = await fetchFollowWithCookie(target.toString(), {
    ...init,
    headers: fwd,
  });

  // optional debug so you can see when redirects happened
  res.setHeader("x-proxy-final-url", upstream.url);

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

  const utf16Decoder = new TextDecoder("UTF-16");

  res.end(body);
}
