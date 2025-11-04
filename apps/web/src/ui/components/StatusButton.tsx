"use client";

import { useState } from "react";
import { Button } from "@chakra-ui/react";

export default function StatusButton({
  id,
  itemId,
  label,
  onClick,
  variant = "solid",
  colorPalette = undefined,
  disabled = false,
  busyId,
  setBusyId,
}: {
  id: string;
  itemId: string;
  label: string;
  onClick: () => Promise<void>;
  variant?: string;
  colorPalette?: string | undefined;
  disabled?: boolean;
  busyId: string;
  setBusyId: (id: string) => void;
}) {
  return (
    <Button
      key={id + itemId}
      variant={variant as any}
      colorPalette={colorPalette}
      onClick={async () => {
        setBusyId(id + itemId);
        await onClick();
        setBusyId("");
      }}
      disabled={disabled || busyId !== ""}
      loading={busyId === id + itemId}
      size="sm"
    >
      {label}
    </Button>
  );
}
