"use client";

import { Box, Input } from "@chakra-ui/react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md" | "lg" | "xs";
  disabled?: boolean;
  /** Permit a leading minus. OFF by default — a negative price, payment or
   *  wage is a data-entry error everywhere except the Ledger, where a
   *  negative expense is how a refund is recorded. Opt in per call site
   *  rather than loosening the mask for the whole app. */
  allowNegative?: boolean;
};

export default function CurrencyInput({
  value,
  onChange,
  placeholder = "0.00",
  size,
  disabled,
  allowNegative = false,
}: Props) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    // Digits, an optional single decimal point, up to 2 decimal places — and
    // a leading minus only where the call site asked for one.
    const mask = allowNegative ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/;
    if (mask.test(raw)) {
      onChange(raw);
    }
  }

  function handleBlur() {
    if (value === "" || value === "." || value === "-") {
      onChange("");
      return;
    }
    const n = parseFloat(value);
    if (isNaN(n) || (n < 0 && !allowNegative)) {
      onChange("");
      return;
    }
    onChange(n.toFixed(2));
  }

  return (
    <Box position="relative">
      <Box
        as="span"
        position="absolute"
        left="3"
        top="50%"
        transform="translateY(-50%)"
        fontSize="sm"
        color="fg.muted"
        pointerEvents="none"
        zIndex={1}
        userSelect="none"
      >
        $
      </Box>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        pl="7"
        size={size}
        disabled={disabled}
      />
    </Box>
  );
}
