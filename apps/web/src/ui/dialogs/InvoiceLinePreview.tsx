"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";

/**
 * The line as the CLIENT will see it, rendered live while it is typed.
 *
 * Both money dialogs already label which fields reach the invoice, but a label
 * is a claim the operator has to take on trust — and the two things most often
 * got confused are exactly the ones a label cannot settle: whether the DETAIL
 * shows at all when left blank, and whether the internal cost leaks onto the
 * invoice. Showing the rendered line answers both without anyone reading a
 * word of explanation.
 *
 * Deliberately dumb: name, amount, optional detail. It takes no `actualCost`
 * and has no prop for one, so the internal figure cannot appear here by a
 * later edit — the omission is structural rather than a rule someone has to
 * remember.
 *
 * Shared by the charges and the services dialogs so the two previews cannot
 * drift into showing the invoice differently for a line the client sees
 * identically.
 */
export default function InvoiceLinePreview({
  name,
  amount,
  detail,
  /** Services are billed on top as their own line, same as a charge — the
   *  wording differs only so the empty state can name the right thing. */
  emptyLabel = "this line",
}: {
  name: string;
  amount: string | number;
  detail?: string;
  emptyLabel?: string;
}) {
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  const money = Number.isFinite(n) ? `$${n.toFixed(2)}` : "$0.00";
  const shownName = name.trim();
  const shownDetail = (detail ?? "").trim();

  return (
    <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" bg="bg" p={2}>
      <Text
        fontSize="2xs"
        fontWeight="bold"
        letterSpacing="0.04em"
        textTransform="uppercase"
        color="fg.muted"
        mb={1.5}
      >
        As the client will see it
      </Text>
      <VStack align="stretch" gap={0.5}>
        <HStack justify="space-between" align="baseline" gap={3}>
          <Text
            fontSize="sm"
            fontWeight="medium"
            color={shownName ? undefined : "fg.muted"}
            fontStyle={shownName ? undefined : "italic"}
          >
            {shownName || `(name ${emptyLabel})`}
          </Text>
          <Text fontSize="sm" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
            {money}
          </Text>
        </HStack>
        {/* Absent, not blank, when there is no detail — that IS what the
            invoice does, and seeing the row vanish is what tells the operator
            the field is optional. */}
        {shownDetail && (
          <Text fontSize="xs" color="fg.muted" whiteSpace="pre-wrap">
            {shownDetail}
          </Text>
        )}
      </VStack>
    </Box>
  );
}
