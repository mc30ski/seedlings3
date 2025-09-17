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

  // Build target URL: API_BASE_URL + /<joined path> + original search
  const parts = ([] as string[]).concat(
    (req.query.path as string[] | string | undefined) ?? []
  );
  const target = new URL(parts.join("/"), base);
  const qIdx = req.url?.indexOf("?") ?? -1;
  if (qIdx >= 0) target.search = req.url!.slice(qIdx);

  // Copy headers (minus hop-by-hop)
  const fwd = new Headers();
  const drop = new Set(["host", "connection", "content-length"]);
  for (const [k, v] of Object.entries(req.headers) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (drop.has(k.toLowerCase()) || v == null) continue;
    fwd.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  const init: RequestInit = {
    method: req.method,
    headers: fwd,
    redirect: "manual",
    cache: "no-store",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req as any)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    (init as any).body = Buffer.concat(chunks);
  }

  // --- Attempt 1: bypass via HEADER (works per your Step A) ---
  const h1 = new Headers(fwd);
  h1.set("x-vercel-protection-bypass", secret);
  let r = await fetch(target.toString(), { ...init, headers: h1 });
  let stage = "header";

  console.log("MIKEW", "In proxy handler", { base, secret });

  res.status(200).json({
    ok: true,
    error: "got here2",
    target: target,
    qIdx: qIdx,
    r: JSON.stringify(r),
  });
  return;

  /*
  // Detect Vercel protection page
  const isBlocked = (resp: Response) =>
    resp.status === 401 ||
    (resp.headers.get("set-cookie")?.includes("_vercel_") ?? false) ||
    (resp.headers.get("content-type") || "").includes("text/html");


  // --- Attempt 2: bypass via QUERY PARAMS and ask Vercel to set cookie ---
  if (isBlocked(r)) {
    const qp = new URL(target.toString());
    qp.searchParams.set("x-vercel-protection-bypass", secret);
    qp.searchParams.set("x-vercel-set-bypass-cookie", "true");
    r = await fetch(qp.toString(), init);
    stage = "query";
  }

  // --- Attempt 3: if Set-Cookie came back, retry original with that cookie ---
  if (isBlocked(r)) {
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) {
      const cookiePair = setCookie.split(";")[0];
      const h3 = new Headers(fwd);
      h3.set("cookie", cookiePair);
      r = await fetch(target.toString(), { ...init, headers: h3 });
      stage = "cookie";
    }
  }

  // Pass status/headers through, plus debug of what we did
  res.setHeader("x-proxy-target", target.toString());
  res.setHeader("x-proxy-stage", stage);
  res.status(r.status);
  r.headers.forEach((value: string, key: string) => {
    if (key.toLowerCase() === "content-encoding") return;
    res.setHeader(key, value);
  });
  const body = Buffer.from(await r.arrayBuffer());
  res.end(body);
  */
}
