"use client";

import { Box, Input } from "@chakra-ui/react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md" | "lg" | "xs";
  disabled?: boolean;
};

export default function CurrencyInput({
  value,
  onChange,
  placeholder = "0.00",
  size,
  disabled,
}: Props) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    // Allow digits with an optional single decimal point and up to 2 decimal places
    if (/^\d*\.?\d{0,2}$/.test(raw)) {
      onChange(raw);
    }
  }

  function handleBlur() {
    if (value === "" || value === ".") {
      onChange("");
      return;
    }
    const n = parseFloat(value);
    if (isNaN(n) || n < 0) {
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
