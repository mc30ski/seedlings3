"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { DollarSign, Search } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { jobTagLabel } from "@/src/ui/components/JobTagPicker";

type PricingEntry = {
  key: string;
  parsedValue: {
    label: string;
    description: string;
    unit: string;
    amount: number;
    sortOrder: number;
    jobTag?: string | null;
  } | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Endpoint to fetch from. Admin/Super pass /api/admin/pricing; workers
   *  pass /api/pricing. Defaults to the worker route since the dialog is
   *  most often consumed in worker flows. */
  endpoint?: string;
  /** Pre-filled search query on open (e.g. the jobTag label or service
   *  name from the calling form). */
  initialSearch?: string;
  /** When provided, each row becomes tappable and calls onPick with the
   *  selected entry's amount — useful for inline "use as price" flows. */
  onPick?: (amount: number, entry: PricingEntry) => void;
};

export default function PricingGuideDialog({ open, onOpenChange, endpoint = "/api/pricing", initialSearch, onPick }: Props) {
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setSearch(initialSearch ?? "");
    setLoading(true);
    apiGet<PricingEntry[]>(endpoint)
      .then((list) => {
        const sorted = (Array.isArray(list) ? list : []).sort((a, b) => {
          const sa = a.parsedValue?.sortOrder ?? 100;
          const sb = b.parsedValue?.sortOrder ?? 100;
          if (sa !== sb) return sa - sb;
          return (a.parsedValue?.label ?? "").localeCompare(b.parsedValue?.label ?? "");
        });
        setEntries(sorted);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open, endpoint, initialSearch]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const v = e.parsedValue;
      if (!v) return false;
      const haystack = [
        v.label,
        v.description,
        v.unit,
        v.jobTag ? jobTagLabel(v.jobTag) : "",
        v.jobTag ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, search]);

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg" maxH="85vh" overflowY="auto">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Pricing Guide</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <HStack gap={2}>
                  <Search size={16} />
                  <Input
                    size="sm"
                    placeholder="Search…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                  />
                </HStack>
                {onPick && (
                  <Text fontSize="xs" color="fg.muted">
                    Tap a row to use its price.
                  </Text>
                )}
                {loading ? (
                  <Box py={6} textAlign="center"><Spinner /></Box>
                ) : filtered.length === 0 ? (
                  <Box textAlign="center" py={6}>
                    <Text fontSize="sm" color="fg.muted">
                      {search ? "No entries match." : "No pricing entries yet."}
                    </Text>
                  </Box>
                ) : (
                  <VStack align="stretch" gap={2}>
                    {filtered.map((entry) => {
                      const v = entry.parsedValue;
                      if (!v) return null;
                      return (
                        <Card.Root
                          key={entry.key}
                          variant="outline"
                          cursor={onPick ? "pointer" : undefined}
                          _hover={onPick ? { borderColor: "blue.300", bg: "blue.50" } : undefined}
                          onClick={onPick ? () => {
                            onPick(v.amount, entry);
                            onOpenChange(false);
                          } : undefined}
                        >
                          <Card.Body py="2" px="3">
                            <VStack align="start" gap={1}>
                              <HStack gap={2} wrap="wrap">
                                <Text fontSize="sm" fontWeight="semibold">{v.label}</Text>
                                <Badge colorPalette="green" variant="solid" fontSize="sm" px="2" borderRadius="full">
                                  <DollarSign size={12} />{v.amount.toFixed(2)}
                                </Badge>
                                <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                  {v.unit}
                                </Badge>
                                {v.jobTag && (
                                  <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                    {jobTagLabel(v.jobTag)}
                                  </Badge>
                                )}
                              </HStack>
                              {v.description && (
                                <Text fontSize="xs" color="fg.muted">{v.description}</Text>
                              )}
                            </VStack>
                          </Card.Body>
                        </Card.Root>
                      );
                    })}
                  </VStack>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="center" w="full">
                <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
