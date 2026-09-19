"use client";

import { Button } from "@chakra-ui/react";

export default function StatusButton({
  id,
  itemId,
  label,
  onClick,
  variant = "solid",
  colorPalette = undefined,
  disabled = false,
  title,
  busyId,
  setBusyId,
  /** Defaults to "sm" — the size every existing caller was getting
   *  implicitly. Pass "xs" for dense card action rows. */
  size = "sm",
}: {
  id: string;
  itemId: string;
  label: string;
  onClick: () => Promise<void>;
  variant?: string;
  colorPalette?: string | undefined;
  disabled?: boolean;
  title?: string;
  busyId: string;
  setBusyId: (id: string) => void;
  size?: "xs" | "sm" | "md";
}) {
  return (
    <Button
      key={id + itemId}
      variant={variant as any}
      colorPalette={colorPalette}
      title={title}
      onClick={async () => {
        setBusyId(id + itemId);
        await onClick();
        setBusyId("");
      }}
      disabled={disabled || busyId !== ""}
      loading={busyId === id + itemId}
      size={size}
    >
      {label}
    </Button>
  );
}
