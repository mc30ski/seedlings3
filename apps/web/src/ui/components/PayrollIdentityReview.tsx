"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PayrollIdentityReview — Super-only queue for names the import couldn't
// attribute to an app user.
//
// Canonical spec: docs/features/payroll.md.
//
// WHY THIS EXISTS AT ALL. The Gusto CSV carries no employee identifier —
// only a first and last name. Matching a name to a User is fuzzy, and a
// wrong match shows one person another person's net pay. So names are
// NEVER auto-matched: a human confirms once, and the mapping persists.
//
// Confirming back-fills every past row with that name, so a worker sees
// their whole history rather than only future uploads. Unlinking is
// equally deliberate — a wrong link means someone saw pay that wasn't
// theirs, so it must be fully reversible.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  HStack,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { FiAlertTriangle, FiLink } from "react-icons/fi";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import {
  fetchUnmatchedPayrollNames,
  linkPayrollIdentity,
  type UnmatchedName,
} from "@/src/lib/payroll";

type WorkerOption = { id: string; displayName: string };

export default function PayrollIdentityReview({
  onChanged,
  onReady,
}: {
  onChanged: () => void;
  /**
   * Reports refresh / busy / count to the frame. Content-only, like the
   * other queue sections — the host supplies the title bar, stripe,
   * count badge, refresh and dim.
   */
  onReady?: (api: { refresh: () => void; loading: boolean; count: number }) => void;
}) {
  const [names, setNames] = useState<UnmatchedName[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirmFor, setConfirmFor] = useState<{ name: UnmatchedName; userId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const key = (n: UnmatchedName) => `${n.lastName}|${n.firstName}`;

  const load = useCallback(async () => {
    try {
      const [u, w] = await Promise.all([
        fetchUnmatchedPayrollNames(),
        apiGet<WorkerOption[]>("/api/workers").catch(() => [] as WorkerOption[]),
      ]);
      setNames(Array.isArray(u) ? u : []);
      setWorkers(Array.isArray(w) ? w : []);
    } catch {
      setNames([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onReady?.({ refresh: () => void load(), loading: busy, count: names.length });
  }, [onReady, load, busy, names]);

  if (names.length === 0) return null;

  const collection = createListCollection({
    items: workers.map((w) => ({ label: w.displayName, value: w.id })),
  });

  return (
    // Content only — the Dashboard frame at the host supplies the title
    // bar, orange stripe, count badge, refresh and dim. The count and the
    // "N names need matching" heading moved there; the explanation below
    // stays, because it is the part that says WHY it matters.
    <Box>
      <Text fontSize="xs" color="orange.900" mb={3}>
        Gusto&apos;s export doesn&apos;t identify people beyond their name. Until you confirm who
        each one is, <strong>that worker can&apos;t see their pay</strong>. Confirming applies to
        their whole history, not just the latest period.
      </Text>

      <VStack align="stretch" gap={2}>
        {names.map((n) => {
          const k = key(n);
          const sel = picked[k] ?? "";
          return (
            <HStack
              key={k}
              // Test hook. The row's name, the worker picker and the Match
              // button are siblings, so a locator anchored on the text alone
              // matches a stack of ancestors — this gives e2e one stable
              // handle per pending name.
              data-testid="payroll-unmatched-row"
              data-name={`${n.firstName} ${n.lastName}`}
              gap={2}
              wrap="wrap"
              bg="white"
              borderWidth="1px"
              borderColor="orange.200"
              rounded="md"
              p={2}
            >
              <VStack align="start" gap={0} minW="120px" flex={1}>
                <Text fontSize="sm" fontWeight="semibold">
                  {n.firstName} {n.lastName}
                </Text>
                <Badge size="sm" colorPalette="gray" variant="subtle">
                  {n.entryCount} {n.entryCount === 1 ? "period" : "periods"}
                </Badge>
              </VStack>

              <Box flex={1} minW="160px">
                <Select.Root
                  collection={collection}
                  value={sel ? [sel] : []}
                  onValueChange={(e) => {
                    const v = e.value?.[0];
                    if (v) setPicked((p) => ({ ...p, [k]: v }));
                  }}
                  size="sm"
                  positioning={{ strategy: "fixed", hideWhenDetached: true }}
                >
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Choose worker" />
                      <Select.Indicator />
                    </Select.Trigger>
                  </Select.Control>
                  <Select.Positioner>
                    <Select.Content>
                      {collection.items.map((item) => (
                        <Select.Item key={item.value} item={item.value}>
                          <Select.ItemText>{item.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Select.Root>
              </Box>

              <Button
                size="xs"
                colorPalette="green"
                disabled={!sel || busy}
                flexShrink={0}
                onClick={() => setConfirmFor({ name: n, userId: sel })}
              >
                <FiLink /> Match
              </Button>
            </HStack>
          );
        })}
      </VStack>

      {/* Mandatory confirm — this decides who can see someone's pay. */}
      <ConfirmDialog
        open={!!confirmFor}
        title="Confirm this match?"
        message={
          confirmFor
            ? `Link payroll rows for "${confirmFor.name.firstName} ${confirmFor.name.lastName}" to ` +
              `${workers.find((w) => w.id === confirmFor.userId)?.displayName ?? "this worker"}. ` +
              `They will immediately be able to see all ${confirmFor.name.entryCount} pay ` +
              `period(s) under that name, including tax detail. Only confirm if you are certain ` +
              `these are the same person.`
            : ""
        }
        confirmLabel="Confirm match"
        confirmColorPalette="green"
        onCancel={() => setConfirmFor(null)}
        onConfirm={async () => {
          const target = confirmFor;
          setConfirmFor(null);
          if (!target) return;
          setBusy(true);
          try {
            const res = await linkPayrollIdentity({
              lastName: target.name.lastName,
              firstName: target.name.firstName,
              userId: target.userId,
            });
            publishInlineMessage({
              type: "SUCCESS",
              text: `Matched — ${res.entriesRelinked} payroll row(s) linked.`,
            });
            await load();
            onChanged();
          } catch (err) {
            publishInlineMessage({
              type: "ERROR",
              text: getErrorMessage("Couldn't confirm that match.", err),
            });
          } finally {
            setBusy(false);
          }
        }}
      />
    </Box>
  );
}
