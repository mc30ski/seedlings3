import { Button } from "@chakra-ui/react";

export default function ActionButton({
  key,
  label,
  action,
  itemId,
  busyId,
  variant = "solid",
  disabled = false,
}: {
  key: string;
  label: string;
  action: any;
  itemId: string;
  busyId: string;
  variant?: any;
  disabled?: boolean;
}) {
  return (
    <Button
      key={key}
      variant={variant}
      onClick={action}
      disabled={!!busyId || disabled}
      loading={busyId === itemId}
    >
      {label}
    </Button>
  );
}
