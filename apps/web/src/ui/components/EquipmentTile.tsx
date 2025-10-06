import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Button,
} from "@chakra-ui/react";
import { useState } from "react";
import { apiPost } from "../../lib/api";
import { Equipment, StatusColor } from "../../lib/types";
import {
  errorMessage,
  notifyEquipmentUpdated,
  prettyStatus,
} from "../../lib/lib";

type EquipmentTileProps = {
  item: Equipment;
  isMine: boolean;
  filter: string;
  refresh: any;
};

export default function EquipmentTile({
  item,
  isMine,
  filter,
  refresh,
}: EquipmentTileProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});

  const dismissInline = (id: string) =>
    setInlineWarn((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });

  function captureInlineConflict(id: string, err: any) {
    const status =
      err?.status ?? err?.httpStatus ?? err?.response?.status ?? undefined;
    setInlineWarn((m) => ({
      ...m,
      [id]: errorMessage(err),
    }));
  }

  function ActionButton({
    key,
    label,
    action,
    variant = "solid",
  }: {
    key: string;
    label: string;
    action: any;
    variant?: any;
  }) {
    return (
      <Button
        key={key}
        variant={variant}
        onClick={action}
        disabled={!!busyId}
        loading={busyId === item.id}
      >
        {label}
      </Button>
    );
  }

  async function service(id: string, url: string) {
    setBusyId(id);
    try {
      await apiPost(url);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function checkoutItem(id: string) {
    return service(id, `/api/equipment/${id}/checkout`);
  }

  async function reserveItem(id: string) {
    return service(id, `/api/equipment/${id}/reserve`);
  }

  async function cancelItem(id: string) {
    return service(id, `/api/equipment/${id}/reserve/cancel`);
  }

  async function returnItem(id: string) {
    return service(id, `/api/equipment/${id}/return`);
  }

  function unavailableMessage(item: Equipment) {
    if (
      filter !== "claimed" &&
      (item.holder?.state === "CHECKED_OUT" ||
        item.holder?.state === "RESERVED")
    ) {
      let str =
        item.holder.state === "CHECKED_OUT"
          ? "Checked out by "
          : "Reserved by ";
      str +=
        item.holder?.displayName ||
        item.holder?.email ||
        item.holder?.userId.slice(0, 8);

      return (
        <Text fontSize="xs" color="gray.700" mt={1}>
          {str}
        </Text>
      );
    } else {
      return null;
    }
  }

  return (
    <Box
      key={item.id}
      p={4}
      borderWidth="1px"
      borderRadius="lg"
      mb={3}
      w="full"
    >
      <HStack justify="space-between" align="start" w="full">
        <Box flex="1" w="full">
          <Heading size="sm">
            {item.brand ? `${item.brand} ` : ""}
            {item.model ? `${item.model} ` : ""}
            <Badge ml={2} {...StatusColor[item.status]}>
              {prettyStatus(item.status)}
              {isMine &&
              (item.status === "RESERVED" || item.status === "CHECKED_OUT")
                ? " (You)"
                : ""}
            </Badge>
          </Heading>

          {unavailableMessage(item)}

          {item.shortDesc && (
            <Text fontSize="sm" color="gray.600" mt={1}>
              {item.shortDesc}
            </Text>
          )}

          {item.longDesc && (
            <Text fontSize="sm" color="gray.500" mt={1}>
              {item.longDesc}
            </Text>
          )}

          {/* Inline warning banner for this item */}
          {inlineWarn[item.id] && (
            <HStack
              w="full"
              mt={2}
              align="start"
              p={2.5}
              borderRadius="md"
              borderWidth="1px"
              borderColor="orange.300"
              bg="orange.50"
            >
              <Box flex="1">
                <Text fontSize="sm" color="orange.900">
                  {inlineWarn[item.id]}
                </Text>
              </Box>
              <Button
                size="xs"
                variant="ghost"
                ml="auto"
                onClick={() => dismissInline(item.id)}
              >
                Dismiss
              </Button>
            </HStack>
          )}

          <Stack direction="row" gap="2" mt={2}>
            {filter === "claimed" && item.status === "RESERVED" ? (
              <>
                <ActionButton
                  key="worker_checkout"
                  label="Check Out"
                  action={() => void checkoutItem(item.id)}
                />
                <ActionButton
                  key="worker_cancel"
                  label="Cancel Reservation"
                  action={() => void cancelItem(item.id)}
                  variant="outline"
                />
              </>
            ) : filter === "claimed" && item.status === "CHECKED_OUT" ? (
              <ActionButton
                key="worker_return"
                label="Return"
                action={() => void returnItem(item.id)}
              />
            ) : filter === "available" && item.status === "AVAILABLE" ? (
              <ActionButton
                key="worker_reserve"
                label="Reserve"
                action={() => void reserveItem(item.id)}
              />
            ) : null}
          </Stack>
        </Box>
      </HStack>
    </Box>
  );
}
