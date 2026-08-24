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

/**
 * Is this proxied path a LINK WRAPPER — an endpoint whose only job is to
 * bounce the visitor's browser somewhere else?
 *
 * Only these get their 3xx handed to the browser. Everything else keeps
 * following redirects server-side, which is what an XHR caller wants.
 *
 * DELIBERATELY NARROW. Anything matching here stops following redirects,
 * so a caller expecting final JSON would receive a bare 3xx instead. The
 * payment endpoints (api/public/pay/...) must NEVER match — the
 * proxy-link-wrapper build gate asserts exactly that, because this file
 * sits in front of the invoice and self-report calls.
 */
export function isBrowserLinkWrapper(parts: string[]): boolean {
  return /^api\/public\/(promotion\/click|mo)\//.test(parts.join("/"));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
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
    "accept-encoding", // avoid compressed body issues
    "x-forwarded-host", // can trigger canonical host redirects
    "x-forwarded-proto",
    "x-real-ip",
    // Hop-by-hop headers (RFC 7230 §6.1): they describe a single transport
    // hop and must NOT be forwarded to the next one. undici's fetch() throws
    // `invalid transfer-encoding header` (UND_ERR_INVALID_ARG) if any of
    // these — `transfer-encoding` especially — are passed through. Vercel's
    // edge attaches `transfer-encoding: chunked` to some requests, so this
    // strip is required, not optional.
    "connection",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
  ]);
  for (const [k, v] of Object.entries(req.headers) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (drop.has(k.toLowerCase()) || v == null) continue;
    fwd.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  // Preserve the ORIGINAL visitor host + protocol under custom header
  // names that no framework auto-acts on (unlike x-forwarded-host,
  // which the API framework or downstream libs might interpret as a
  // canonical-redirect hint — that's why the drop list above nukes it).
  //
  // Used by endpoints that need to know which of our multi-domain
  // hostnames the visitor actually typed — the promo short URL
  // route (`/mo/:slug/:code?`) uses this to build a sticky-domain
  // 302 destination so a visitor who clicked seedlings.pro/mo/… lands
  // back on seedlings.pro rather than the API's internal vercel.app URL.
  //
  // The incoming Host header on THIS proxy handler is the visitor's
  // domain (Vercel edge sets it that way when routing to our function),
  // so we can safely mirror it. x-forwarded-proto has already been set
  // by Vercel edge for us.
  const originalHost = req.headers["host"];
  if (originalHost) {
    fwd.set("x-original-host", Array.isArray(originalHost) ? originalHost[0] : originalHost);
  }
  const originalProto = req.headers["x-forwarded-proto"];
  if (originalProto) {
    fwd.set("x-original-proto", Array.isArray(originalProto) ? originalProto[0] : originalProto);
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

  // Stream body for non-GET/HEAD. We attach the body — even an empty
  // Buffer — for write methods, because skipping the attachment on empty
  // bodies broke parameterless POSTs in prod: undici defaults to
  // `Transfer-Encoding: chunked` when no body is attached to a POST,
  // which makes upstream Fastify look for a Content-Type parser, find
  // none (parameterless POSTs send no Content-Type), and throw
  // `FST_ERR_CTP_INVALID_MEDIA_TYPE: Unsupported Media Type: undefined`.
  // Attaching `Buffer.alloc(0)` causes undici to send `Content-Length: 0`
  // explicitly instead, and Fastify skips the parser entirely.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    (init as any).body = Buffer.concat(chunks);
  }

  // ── Redirect-following: transparent for APIs, NOT for link wrappers ──
  //
  // Most proxied calls are XHR from our own app, where following redirects
  // server-side is exactly right — the caller wants the final JSON.
  //
  // Promotion click wrappers and /mo/ short links are the opposite. Their
  // ENTIRE purpose is to bounce the visitor's browser somewhere else. When
  // the proxy swallowed that redirect, the browser stayed parked on the
  // wrapper URL while being served HTML rendered for the landing route.
  // Next.js then hydrated, found the address bar didn't match the page it
  // was handed, and reconciled — churning history entries. On a phone the
  // back button landed on those entries and appeared to reload the promo
  // page; only hammering it escaped. The address bar also showed an ugly
  // tracker URL instead of the real landing page.
  //
  // Handing the 3xx to the browser is what these endpoints always meant:
  // the visitor lands on the true URL, history is invoice → landing, and
  // back behaves normally on every device.
  const isLinkWrapper = isBrowserLinkWrapper(parts);
  const upstream = isLinkWrapper
    ? await fetch(target.toString(), { ...init, headers: fwd, redirect: "manual" })
    : await fetchFollowWithCookie(target.toString(), {
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

  res.end(body);
  } catch (err: any) {
    // Never crash into Next's static /500 HTML page — return a legible JSON
    // error so the failure shows up readably in the client and in logs.
    console.error("[_proxy] unhandled error:", err?.stack || err, "| cause:", err?.cause);
    if (!res.headersSent) {
      const cause = err?.cause ? ` (${String(err.cause?.message ?? err.cause)})` : "";
      res
        .status(502)
        .json({ ok: false, error: "proxy_failed", message: String(err?.message ?? err) + cause });
    } else {
      res.end();
    }
  }
}
