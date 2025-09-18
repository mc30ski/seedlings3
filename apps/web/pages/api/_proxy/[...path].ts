// pages/api/_proxy/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

async function fetchFollow(
  url: string,
  init: RequestInit,
  opts?: { maxHops?: number }
) {
  const maxHops = opts?.maxHops ?? 5;
  let currentUrl = url;
  let res = await fetch(currentUrl, { ...init, redirect: "manual" });

  for (let i = 0; i < maxHops; i++) {
    const loc = res.headers.get("location");
    const status = res.status;

    // Only follow 301/302/303/307/308 when a Location is present
    if (!loc || status < 300 || status > 399) break;

    // Build absolute next URL
    currentUrl = new URL(loc, currentUrl).toString();

    // Re-issue same method/body for 307/308; for 301/302/303 you may switch to GET.
    // Keeping it simple: preserve method/body for all 3xx
    res = await fetch(currentUrl, { ...init, redirect: "manual" });
  }
  return res;
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

  if (!req.url?.includes("/me")) {
    res.status(200).json({
      ok: true,
      message: "proxy disabled",
      base: base,
      bypass: bypass,
    });
  } else {
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

    console.log("HERE target", target.toString());
    console.log("HERE fwd", fwd);

    // Single, straightforward fetch
    //const upstream = await fetch(target.toString(), init);
    const upstream = await fetchFollow(target.toString(), {
      ...init,
      headers: fwd,
    });

    // optional debug so you can see when redirects happened
    res.setHeader("x-proxy-final-url", upstream.url);

    console.log("HERE2 upstream.status", upstream.status);
    console.log("HERE3 upstream.headers", upstream.headers);

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

    console.log("HERE4 body", utf16Decoder.decode(body));

    res.status(200).send("DONE");

    /*
    
    res.end(body);
    */
  }
}
