import { useEffect, useState } from "react";

// Branding (business name, etc.) is non-sensitive and read from the
// /public/branding endpoint with no auth required. Used wherever the
// app renders the business name to a user — receipts, the public
// payment page, and so on — so renaming the business in Settings
// flows through everywhere without code edits.
//
// Loaded once per page lifetime and cached. The hook returns the
// current value (which is the fallback until the network response
// lands), so callers can render without showing a flicker:
//
//   const { businessName } = useBranding();
//   <Text>{businessName}</Text>

const FALLBACK_BUSINESS_NAME = "Seedlings Lawn Care";

type Branding = {
  businessName: string;
};

let cached: Branding | null = null;
let inflight: Promise<Branding> | null = null;

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function loadOnce(): Promise<Branding> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/public/branding`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      cached = {
        businessName:
          typeof json?.businessName === "string" && json.businessName.trim()
            ? json.businessName.trim()
            : FALLBACK_BUSINESS_NAME,
      };
      return cached;
    } catch {
      cached = { businessName: FALLBACK_BUSINESS_NAME };
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(
    () => cached ?? { businessName: FALLBACK_BUSINESS_NAME },
  );
  useEffect(() => {
    let cancelled = false;
    loadOnce().then((b) => {
      if (!cancelled) setBranding(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return branding;
}
