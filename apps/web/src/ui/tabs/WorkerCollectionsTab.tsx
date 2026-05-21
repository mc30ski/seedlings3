"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type EquipmentBrief = {
  id: string;
  qrSlug?: string | null;
  shortDesc?: string | null;
  type?: string | null;
  brand?: string | null;
  model?: string | null;
  status?: string | null;
  retiredAt?: string | null;
};

type CollectionItem = {
  id: string;
  equipmentId: string;
  equipment: EquipmentBrief;
  heldByMe?: boolean;
};

type Collection = {
  id: string;
  name: string;
  description?: string | null;
  items: CollectionItem[];
};

function equipmentLabel(e: EquipmentBrief): string {
  if (e.shortDesc) return e.shortDesc;
  const parts = [e.brand, e.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (e.type) return e.type;
  return e.id.slice(-6);
}

function statusBadge(e: EquipmentBrief) {
  if (e.retiredAt) return <Badge size="sm" colorPalette="gray">Retired</Badge>;
  if (e.status === "AVAILABLE") return <Badge size="sm" colorPalette="green">Available</Badge>;
  if (e.status === "CHECKED_OUT") return <Badge size="sm" colorPalette="blue">Checked out</Badge>;
  if (e.status === "RESERVED") return <Badge size="sm" colorPalette="yellow">Reserved</Badge>;
  if (e.status === "MAINTENANCE") return <Badge size="sm" colorPalette="orange">Maintenance</Badge>;
  return null;
}

// Read-only worker view of admin-defined equipment collections. Workers can't
// create or edit kits — they just see what's grouped together, and which kits
// they're currently using (any piece in the kit checked out under their name).
export default function WorkerCollectionsTab() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const list = await apiGet<Collection[]>("/api/equipment-collections");
        setCollections(Array.isArray(list) ? list : []);
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Load failed.", err) });
      }
      setLoading(false);
    })();
  }, []);

  function openEquipment(equipmentId: string) {
    try {
      window.sessionStorage.setItem("equipmentHighlightId", equipmentId);
    } catch {}
    window.dispatchEvent(
      new CustomEvent("navigate:workerTab", {
        detail: { tab: "equipment", category: "Equipment" },
      }),
    );
  }

  return (
    <Box w="full">
      <VStack align="stretch" gap={3}>
        <Text fontWeight="semibold">Equipment collections</Text>
        <Text fontSize="xs" color="fg.muted">
          Kits your administrator has grouped together. View only — a green
          check marks kits you're currently using.
        </Text>

        {loading ? (
          <Spinner size="sm" />
        ) : collections.length === 0 ? (
          <Card.Root variant="outline">
            <Card.Body py={6} textAlign="center">
              <Text color="fg.muted" fontSize="sm">
                No collections have been set up yet.
              </Text>
            </Card.Body>
          </Card.Root>
        ) : (
          collections.map((c) => {
            const usingIt = c.items.some((it) => it.heldByMe);
            return (
              <Card.Root
                key={c.id}
                variant="outline"
                borderColor={usingIt ? "green.300" : undefined}
                bg={usingIt ? "green.50" : undefined}
              >
                <Card.Body py="3" px="3">
                  <VStack align="start" gap={1} flex={1} minW={0}>
                    <HStack gap={2} flexWrap="wrap">
                      <Text fontWeight="semibold">{c.name}</Text>
                      <Badge size="sm" colorPalette="gray">
                        {c.items.length} item{c.items.length === 1 ? "" : "s"}
                      </Badge>
                      {usingIt && (
                        <Badge size="sm" colorPalette="green">
                          <HStack gap={1}>
                            <CheckCircle2 size={12} />
                            <Text>You're using this</Text>
                          </HStack>
                        </Badge>
                      )}
                    </HStack>
                    {c.description && (
                      <Text fontSize="xs" color="fg.muted">{c.description}</Text>
                    )}
                    {c.items.length > 0 && (
                      <VStack align="stretch" gap={1} mt={2} w="full">
                        {c.items.map((it) => (
                          <HStack
                            key={it.id}
                            justify="space-between"
                            gap={2}
                            px={2}
                            py={1.5}
                            borderRadius="md"
                            cursor="pointer"
                            bg={it.heldByMe ? "green.100" : "bg.subtle"}
                            _hover={{ bg: it.heldByMe ? "green.200" : "gray.100" }}
                            title={`Open ${equipmentLabel(it.equipment)} on the Equipment tab`}
                            onClick={() => openEquipment(it.equipmentId)}
                          >
                            <HStack gap={1.5} minW={0}>
                              {it.heldByMe && (
                                <Box color="green.600" flexShrink={0}>
                                  <CheckCircle2 size={14} />
                                </Box>
                              )}
                              <Text fontSize="sm" lineHeight="1.2">
                                {equipmentLabel(it.equipment)}
                                {it.equipment.retiredAt && " (retired)"}
                              </Text>
                            </HStack>
                            {statusBadge(it.equipment)}
                          </HStack>
                        ))}
                      </VStack>
                    )}
                  </VStack>
                </Card.Body>
              </Card.Root>
            );
          })
        )}
      </VStack>
    </Box>
  );
}
