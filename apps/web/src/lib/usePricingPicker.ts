"use client";

import { useEffect, useMemo, useState } from "react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet } from "@/src/lib/api";
import { pricingJobTags } from "@/src/ui/components/JobTagPicker";

/**
 * Shape of a single pricing entry as returned by /api/admin/pricing (or
 * the worker-scoped /api/pricing mirror). Mirrors what each estimator
 * tool reads off `r.parsedValue` — extra fields on the JSON payload are
 * ignored. Legacy single-string `jobTag` is preserved so old un-migrated
 * rows still resolve via the shared `pricingJobTags()` helper.
 */
export type PricingRow = {
  key: string;
  parsedValue: {
    label?: string;
    description?: string;
    unit?: string;
    amount?: number;
    sortOrder?: number;
    jobTags?: string[] | null;
    jobTag?: string | null;
  } | null;
};

/** Item shape consumed by PricingPicker and Chakra's createListCollection. */
export type PricingPickerItem = { value: string; label: string };

export type PricingPickerResult = {
  /** False until the initial API fetch settles (success or error). */
  pricingLoaded: boolean;
  /** Every pricing entry returned by the API, unfiltered. Exposed so a
   *  consumer that also needs broader lookups (key-based lookups, add-on
   *  catalogs over the whole list) doesn't have to re-fetch on its own. */
  allPricing: PricingRow[];
  /** Candidate pricing entries whose only tag is the requested exclusive tag. */
  options: PricingRow[];
  /** Currently picked option key (or null when nothing is picked). */
  selectedKey: string | null;
  /** Imperative setter for external callers. */
  setSelectedKey: (k: string | null) => void;
  /** Currently picked PricingRow, or null. */
  selected: PricingRow | null;
  /** Pre-built items array — pass into <Select.Content>'s map. */
  items: PricingPickerItem[];
  /** Pre-built Chakra collection — pass to <Select.Root collection={...}/>. */
  collection: ReturnType<typeof createListCollection<PricingPickerItem>>;
};

/**
 * Generic "pick a base pricing entry" hook used by every estimator tool.
 * Loads /api/admin/pricing (or the supplied endpoint) once, filters down
 * to entries whose only tag is the requested base tag, default-picks the
 * first, and exposes everything PricingPicker needs to render the
 * Select. The operator's deliberate pick survives re-fetches; the
 * default-pick only kicks in when the current pick disappears from the
 * options list (or on first load).
 *
 * Multi-tag entries (e.g. "Bagged clippings" tagged MOW + LEAF_CLEANUP)
 * are deliberately excluded — those are add-ons, not bases.
 */
export function usePricingPicker(args: {
  /** Tag that must be the ONLY tag bound on a row for it to qualify. */
  exclusiveTag: string;
  /** Fallback unit string when an entry's `unit` field is missing/empty. */
  fallbackUnit?: string;
  /** Pricing API path. Defaults to /api/admin/pricing. */
  endpoint?: string;
}): PricingPickerResult {
  const { exclusiveTag, fallbackUnit = "per visit", endpoint = "/api/admin/pricing" } = args;
  const [allPricing, setAllPricing] = useState<PricingRow[]>([]);
  const [pricingLoaded, setPricingLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    apiGet<PricingRow[]>(endpoint)
      .then((rows) => { if (Array.isArray(rows)) setAllPricing(rows); })
      .catch(() => { /* options stays empty; the UI shows the missing-config notice */ })
      .finally(() => setPricingLoaded(true));
  }, [endpoint]);

  const options = useMemo(
    () => allPricing.filter((r) => {
      const tags = pricingJobTags(r.parsedValue);
      return tags.length === 1 && tags[0] === exclusiveTag;
    }),
    [allPricing, exclusiveTag],
  );

  // Default-pick the first option; preserve the operator's deliberate
  // pick across re-fetches by only resetting when the current pick has
  // dropped out of the options list.
  useEffect(() => {
    if (options.length === 0) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    const stillValid = selectedKey != null && options.some((r) => r.key === selectedKey);
    if (!stillValid) setSelectedKey(options[0].key);
  }, [options, selectedKey]);

  const selected = useMemo(
    () => options.find((r) => r.key === selectedKey) ?? null,
    [options, selectedKey],
  );

  const items = useMemo<PricingPickerItem[]>(
    () => options.map((r) => ({
      value: r.key,
      label: `${r.parsedValue?.label ?? r.key} — $${Number(r.parsedValue?.amount ?? 0).toFixed(2)} ${r.parsedValue?.unit ?? fallbackUnit}`,
    })),
    [options, fallbackUnit],
  );

  const collection = useMemo(
    () => createListCollection({ items }),
    [items],
  );

  return { pricingLoaded, allPricing, options, selectedKey, setSelectedKey, selected, items, collection };
}
