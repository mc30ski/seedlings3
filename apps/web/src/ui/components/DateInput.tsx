"use client";

import { useEffect, useRef } from "react";
import type { EtDateKey } from "@/src/lib/lib";

type Props = {
  /** Current value — YYYY-MM-DD ET calendar key. `EtDateKey | string`
   *  so callers can pass an empty-string "no value" without branding it. */
  value: EtDateKey | string;
  /** Fired with the new value. Brands as EtDateKey since a native
   *  `<input type="date">` guarantees YYYY-MM-DD output. Callers can
   *  store the result directly in an EtDateKey-typed state. */
  onChange: (value: EtDateKey) => void;
  size?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  css?: Record<string, unknown>;
};

/**
 * Thin wrapper around a native <input type="date"> that imperatively
 * syncs the DOM value, which fixes Safari ignoring React controlled updates.
 *
 * onChange is typed to emit `EtDateKey` — the browser's `<input type="date">`
 * always outputs a YYYY-MM-DD ET calendar-day string (independent of the
 * viewer's timezone), so branding here is a safe boundary cast that lets
 * downstream state stay strictly-typed without every consumer casting.
 */
export default function DateInput({ value, onChange, min, max, disabled, css: cssProp }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current && ref.current.value !== value) {
      ref.current.value = value;
    }
  }, [value]);

  return (
    <input
      ref={ref}
      type="date"
      defaultValue={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as EtDateKey)}
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: "0.875rem",
        padding: "0 0.5rem",
        height: "2rem",
        borderRadius: "0.375rem",
        border: "1px solid var(--chakra-colors-border)",
        background: disabled ? "var(--chakra-colors-bg-muted, var(--chakra-colors-gray-100))" : "var(--chakra-colors-bg)",
        color: disabled ? "var(--chakra-colors-fg-muted, var(--chakra-colors-gray-500))" : "var(--chakra-colors-fg)",
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "auto",
        outline: "none",
        ...(cssProp as React.CSSProperties),
      }}
    />
  );
}
