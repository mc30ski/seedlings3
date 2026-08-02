"use client";

import { useEffect, useState } from "react";

// Cache the fetched data URL at module scope so multiple mounted tabs
// (My Properties + Statements) don't each refetch the same asset. The
// icon is small (~10KB) and doesn't change per user.
let cached: string | null | undefined;
let inflight: Promise<string | null> | null = null;

async function fetchLogo(): Promise<string | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/seedlings-icon.png");
      if (!res.ok) {
        cached = null;
        return null;
      }
      const blob = await res.blob();
      const url = await new Promise<string | null>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      });
      cached = url;
      return url;
    } catch {
      cached = null;
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Returns the Seedlings logo as a base64 data URL suitable for
 *  passing to jsPDF's `addImage`. Fetched once per session and cached
 *  at module scope. Returns null while loading and on fetch failure —
 *  callers should pass the result straight through to PDF data and let
 *  the sync generator skip the image when it's null. */
export function useLogoDataUrl(): string | null {
  const [url, setUrl] = useState<string | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    fetchLogo().then((u) => setUrl(u));
  }, []);
  return url;
}
