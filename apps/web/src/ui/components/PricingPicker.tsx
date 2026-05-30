"use client";

import { Select } from "@chakra-ui/react";
import { type PricingPickerItem, type PricingPickerResult } from "@/src/lib/usePricingPicker";

type Props = {
  /** Items array from usePricingPicker(). */
  items: PricingPickerItem[];
  /** Collection from usePricingPicker(). */
  collection: PricingPickerResult["collection"];
  /** Currently picked option key (or null). */
  selectedKey: string | null;
  /** Fires when the operator picks a different option (or clears). */
  onChange: (key: string | null) => void;
  /** Trigger placeholder shown when no option is picked. */
  placeholder?: string;
  /** Chakra Select size. Defaults to "sm" so it slots into estimator
   *  bodies cleanly. */
  size?: "xs" | "sm" | "md" | "lg";
};

/**
 * Thin wrapper around Chakra's Select tuned for the estimator tools'
 * "pick a base pricing entry" UX. Owns the trigger / positioning /
 * size defaults so every estimator's picker feels identical regardless
 * of which tool you're in. Pair with usePricingPicker() — pass through
 * its `items`, `collection`, `selectedKey`, and a setter for `onChange`.
 */
export default function PricingPicker({
  items,
  collection,
  selectedKey,
  onChange,
  placeholder = "Pick an option",
  size = "sm",
}: Props) {
  return (
    <Select.Root
      collection={collection}
      value={selectedKey ? [selectedKey] : []}
      onValueChange={(e) => onChange(e.value[0] ?? null)}
      size={size}
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
    >
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder={placeholder} />
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content>
          {items.map((it) => (
            <Select.Item key={it.value} item={it.value}>
              <Select.ItemText>{it.label}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  );
}
