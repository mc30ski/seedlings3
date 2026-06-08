import { useEffect, useState } from "react";
import { apiGet } from "@/src/lib/api";

/**
 * Read the EQUIPMENT_BILLING_ENABLED setting from /api/settings.
 *
 * Default `true` so the chip + reserve text render the real rate on
 * first mount (before the fetch resolves) — matches the historical UX
 * for instances where the toggle has never been touched.
 *
 * Mirrors `loadEquipmentBillingEnabled()` in
 * apps/api/src/services/equipment.ts. Keep parser logic in sync if
 * either side changes.
 */
export function useEquipmentBillingEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const row = rows.find((r) => r.key === "EQUIPMENT_BILLING_ENABLED");
        if (row?.value == null) return;
        const v = String(row.value).toLowerCase().trim();
        setEnabled(!(v === "false" || v === "0" || v === "off" || v === "no"));
      })
      .catch(() => {
        /* keep default true */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}
