"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTIONS — the public offers tab.
//
// Sits beside Community and Services, and like them it has NO sign-in gate:
// the people most worth showing an offer to are the ones who are not clients
// yet. Everything here comes from /public/promotions, which is unauthenticated
// and returns only what a stranger may read.
//
// WHY THIS TAB EXISTS AT ALL, rather than a page per campaign.
//
// A printed QR code is permanent and a campaign is not. Point a code at one
// promotion's landing page and the sign is wrong the week that promo ends;
// point it at this tab — `?tab=client-promotions`, an address that never
// changes — and campaigns rotate behind it with nothing to reprint. That
// indirection is the whole design, so the URL is load-bearing: renaming this
// tab's label breaks every code already on a wall or a truck door.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, Image, Spinner, Text, VStack } from "@chakra-ui/react";
import { ExternalLink } from "lucide-react";
import { apiGet } from "@/src/lib/api";

type PublicPromo = {
  id: string;
  headline: string;
  body: string;
  ctaText: string | null;
  url: string | null;
  imageUrls: string[];
};

/** Operator CTA text, minus any arrow they typed at the end of it.
 *
 *  The button already carries an external-link glyph, because it opens a new
 *  tab and that is what says so. An operator writing "See the offers →" is
 *  doing the natural thing, and the two together render as two arrows
 *  pointing different directions — which reads as a mistake, and is.
 *
 *  Trimmed here rather than on save: what they typed is theirs, other
 *  surfaces render it their own way, and a destructive edit to stored copy to
 *  satisfy one button's layout is the wrong trade. */
function ctaLabel(text: string | null): string {
  const trimmed = (text ?? "").replace(/[\s\u2190-\u21FF\u27A1\u279C\u279E\u27F6>»]+$/u, "").trim();
  return trimmed || "See the offers";
}

export default function ClientPromotionsTab() {
  const [promos, setPromos] = useState<PublicPromo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<{ promotions: PublicPromo[] }>("/api/public/promotions");
        setPromos(res?.promotions ?? []);
      } catch {
        // Leave the empty state. A visitor who scanned a code off a wall gets
        // "nothing running right now", which is true and recoverable, rather
        // than an error page they have no way to act on.
      }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <VStack py={10}>
        <Spinner />
      </VStack>
    );
  }

  if (promos.length === 0) {
    return (
      <Card.Root variant="outline">
        <Card.Body>
          <VStack align="center" gap={2} py={6} textAlign="center">
            <Text fontWeight="semibold">No current offers</Text>
            <Text fontSize="sm" color="fg.muted" maxW="md">
              Nothing is running just now. Check back soon, or get in touch and we will let you
              know what is coming up.
            </Text>
          </VStack>
        </Card.Body>
      </Card.Root>
    );
  }

  // The first campaign that actually has somewhere to send people. Its
  // landing page is what the top action opens.
  const primary = promos.find((p) => p.url) ?? null;

  return (
    <VStack align="stretch" gap={4}>
      {/* THE ACTION COMES FIRST, BEFORE ANY CARD.
          This tab is reached by scanning a code off a wall or a truck, on a
          phone. Whatever is at the top is the only thing a good share of
          visitors will ever see, so the way in cannot be something they have
          to scroll to find. It opens the newest campaign that has a landing
          page; the cards below still carry their own links, because with more
          than one offer running no single button can reach them all. */}
      {primary ? (
        // Wrapped, because the VStack around it stretches its children: on a
        // wide screen the button ran the entire width of the page and read as
        // a banner rather than something to press. It hugs its label and sits
        // on the cards' left edge instead.
        <HStack pt={3}>
          <Button
            size="lg"
            colorPalette="green"
            onClick={() => window.open(primary.url!, "_blank", "noopener,noreferrer")}
          >
            {ctaLabel(primary.ctaText)}
            <ExternalLink size={16} />
          </Button>
        </HStack>
      ) : null}

      {promos.map((p) => (
        <Card.Root key={p.id} variant="outline" overflow="hidden">
          {/* WORDS FIRST, PHOTO UNDER THEM. With the image on top, a phone
              screen showed a picture of grass and nothing else — the reader
              had to scroll past it to find out what was being offered. The
              photo illustrates the pitch; it cannot make it. */}
          <Card.Body>
            <VStack align="stretch" gap={3}>
              <Text fontSize="lg" fontWeight="bold">
                {p.headline}
              </Text>
              {/* NO BUTTON HERE. There is exactly one call to action on this
                  tab and it sits at the very top, above every card. A second
                  copy inside the card read as the action having moved back to
                  the bottom — which is the thing the top button exists to
                  fix. The card is the pitch; the button is the way in. */}
              {/* whiteSpace preserves the paragraph breaks an operator typed.
                  Without it the copy collapses into one block and the offer
                  they laid out carefully reads as a wall of text. */}
              <Text color="fg.muted" whiteSpace="pre-wrap">
                {p.body}
              </Text>
            </VStack>
          </Card.Body>
          {/* The cover only. The rest of a campaign's artwork belongs to the
              surfaces that cycle — the wall display walks every image; a tab
              someone is reading should not have to scroll past five photos to
              reach the next offer. */}
          {p.imageUrls[0] ? (
            <Box
              // Fixed ratio rather than the image's own: campaign artwork
              // arrives in whatever shape the operator had, and a column of
              // cards that each jump to a different height reads as broken.
              aspectRatio="16 / 9"
              overflow="hidden"
              bg="bg.muted"
            >
              <Image
                src={p.imageUrls[0]}
                alt=""
                w="full"
                h="full"
                objectFit="cover"
                loading="lazy"
              />
            </Box>
          ) : null}
        </Card.Root>
      ))}
    </VStack>
  );
}
