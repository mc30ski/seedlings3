"use client";

import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  size?: string;
  min?: string;
  max?: string;
  css?: Record<string, unknown>;
};

/**
 * Thin wrapper around a native <input type="date"> that imperatively
 * syncs the DOM value, which fixes Safari ignoring React controlled updates.
 */
export default function DateInput({ value, onChange, min, max, css: cssProp }: Props) {
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
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: "0.875rem",
        padding: "0 0.5rem",
        height: "2rem",
        borderRadius: "0.375rem",
        border: "1px solid var(--chakra-colors-border)",
        background: "var(--chakra-colors-bg)",
        color: "var(--chakra-colors-fg)",
        outline: "none",
        ...(cssProp as React.CSSProperties),
      }}
    />
  );
}
