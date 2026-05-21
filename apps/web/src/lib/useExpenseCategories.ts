import { useEffect, useState } from "react";
import { apiGet } from "@/src/lib/api";

// Loads the EXPENSE_CATEGORIES taxonomy once and exposes the category configs,
// a selectable-only list for pickers, and a label→Schedule C line lookup. Use
// everywhere the UI renders or selects an expense category so changing the
// taxonomy in Settings flows through with no code edits.
//
//   const { selectableCategories, lineFor } = useExpenseCategories();

export type ExpenseCategoryConfig = {
  label: string;
  scheduleCLine: string;
  selectable: boolean;
};

let cached: ExpenseCategoryConfig[] | null = null;
let inflight: Promise<ExpenseCategoryConfig[]> | null = null;

function normalize(raw: any): ExpenseCategoryConfig {
  return {
    label: String(raw?.label ?? ""),
    scheduleCLine: String(raw?.scheduleCLine ?? ""),
    selectable: raw?.selectable !== false,
  };
}

function loadOnce(): Promise<ExpenseCategoryConfig[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await apiGet<Array<{ key: string; value: string }>>("/api/settings");
      const row = Array.isArray(rows) ? rows.find((r) => r.key === "EXPENSE_CATEGORIES") : null;
      if (!row?.value) {
        cached = [];
        return cached;
      }
      const parsed = JSON.parse(row.value);
      cached = Array.isArray(parsed)
        ? parsed.filter((c: any) => c && c.label).map(normalize)
        : [];
      return cached;
    } catch {
      cached = [];
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Invalidate the in-memory cache (call after the taxonomy is edited). */
export function invalidateExpenseCategories() {
  cached = null;
  inflight = null;
}

export function useExpenseCategories() {
  const [categories, setCategories] = useState<ExpenseCategoryConfig[]>(() => cached ?? []);
  useEffect(() => {
    let cancelled = false;
    loadOnce().then((c) => {
      if (!cancelled) setCategories([...c]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Categories an expense can be hand-logged under (excludes synthetic ones). */
  const selectableCategories = categories.filter((c) => c.selectable);

  /** Schedule C line for a category label; "" if unknown. */
  function lineFor(label: string | null | undefined): string {
    if (!label) return "";
    return categories.find((c) => c.label === label)?.scheduleCLine ?? "";
  }

  return { categories, selectableCategories, lineFor, loaded: categories.length > 0 };
}
