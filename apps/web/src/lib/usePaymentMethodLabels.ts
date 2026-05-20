import { useEffect, useState } from "react";
import { apiGet } from "@/src/lib/api";
import { prettyStatus } from "@/src/lib/lib";

// Loads the PAYMENT_METHODS taxonomy once and exposes both a label lookup
// and the raw configs. Use everywhere the UI renders or selects a payment
// method so changing the taxonomy in Settings flows through with no code
// edits.
//
//   const { labelFor, methods } = usePaymentMethodLabels();
//   <Badge>{labelFor(payment.method)}</Badge>
//
// labelFor falls back to prettyStatus(key) (a generic title-caser) for any
// method key not in the taxonomy — keeps historical rows readable after a
// method is renamed or removed.

export type PaymentMethodConfig = {
  key: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  supportsClientRequest: boolean;
  supportsOnSite: boolean;
  deepLinkTemplate: string | null;
  instructions: string | null;
  active: boolean;
};

let cachedMethods: PaymentMethodConfig[] | null = null;
let inflight: Promise<PaymentMethodConfig[]> | null = null;

function normalize(raw: any): PaymentMethodConfig {
  return {
    key: String(raw?.key ?? ""),
    label: String(raw?.label ?? "") || prettyStatus(String(raw?.key ?? "")),
    feePercent: Number(raw?.feePercent ?? 0) || 0,
    feeFixed: Number(raw?.feeFixed ?? 0) || 0,
    supportsClientRequest: !!raw?.supportsClientRequest,
    supportsOnSite: !!raw?.supportsOnSite,
    deepLinkTemplate: raw?.deepLinkTemplate == null ? null : String(raw.deepLinkTemplate),
    instructions: raw?.instructions == null ? null : String(raw.instructions),
    active: raw?.active !== false,
  };
}

function loadOnce(): Promise<PaymentMethodConfig[]> {
  if (cachedMethods) return Promise.resolve(cachedMethods);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await apiGet<Array<{ key: string; value: string }>>("/api/settings");
      const row = Array.isArray(rows) ? rows.find((r) => r.key === "PAYMENT_METHODS") : null;
      if (!row?.value) {
        cachedMethods = [];
        return cachedMethods;
      }
      const parsed = JSON.parse(row.value);
      cachedMethods = Array.isArray(parsed)
        ? parsed.filter((m: any) => m && m.key).map(normalize)
        : [];
      return cachedMethods;
    } catch {
      cachedMethods = [];
      return cachedMethods;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Invalidate the in-memory cache (call after the taxonomy is edited so the
 *  next read picks up new values without a full page reload). */
export function invalidatePaymentMethodLabels() {
  cachedMethods = null;
  inflight = null;
}

export function usePaymentMethodLabels() {
  const [methods, setMethods] = useState<PaymentMethodConfig[]>(() => cachedMethods ?? []);
  useEffect(() => {
    let cancelled = false;
    loadOnce().then((m) => {
      if (!cancelled) setMethods([...m]);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  function labelFor(key: string | null | undefined): string {
    if (!key) return "—";
    const found = methods.find((m) => m.key === key);
    if (found) return found.label;
    return prettyStatus(key);
  }
  return { labelFor, methods };
}
