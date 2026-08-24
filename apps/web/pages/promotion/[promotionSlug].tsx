// Public promotion landing page — no auth required. URL: /promotion/<promotionSlug>.
// Referenced by the wrapper redirect when a Promotion has
// linkKind=LANDING_PAGE. Also directly shareable (though the wrapper
// is the canonical entry so click analytics work).
//
// Server-side render is intentional so Open Graph tags for
// SMS/iMessage/Facebook link previews resolve to real content
// (headline, first item image + description).
//
// Bumps PromotionLandingPage.viewCount on every hit (fire-and-forget).

import { GetServerSideProps } from "next";
import Head from "next/head";
import { useEffect, useState } from "react";
import PhotoLightbox from "@/src/ui/components/PhotoLightbox";
import MarkdownContent from "@/src/ui/components/MarkdownContent";
import { Box, Container, Grid, Heading, HStack, Link as ChakraLink, SimpleGrid, Text, VStack } from "@chakra-ui/react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

type LandingPageItem = {
  id: string;
  title: string;
  description: string;
  /** All photos in display order; first is the cover / og:image. */
  photos: { id: string; url: string }[];
};

type BusinessBlock = {
  name: string;
  phone: string;
  email: string;
  address: string;
  socialLinks: { label: string; url: string; iconDataUrl: string }[];
};

type LandingPageData = {
  headline: string | null;
  intro: string | null;
  items: LandingPageItem[];
  promotionActive: boolean;
  /** Why the page isn't live. Coarse by design — see
   *  loadLandingPageForPublic. Older responses may omit it, hence the
   *  optional type and the fallback in the copy map below. */
  inactiveReason?: "not_started" | "ended" | "unavailable" | null;
  /** True when the content is only visible via an operator preview token.
   *  Drives the "not live yet" banner. */
  preview?: boolean;
  /** Button label from "The offer". Null when unset. */
  ctaText?: string | null;
  business: BusinessBlock;
};

type Props = {
  promotionSlug: string;
  /** True when this visit began on a client's invoice (?from=invoice,
   *  forwarded by the click handler). Drives the "back to your invoice"
   *  header — someone who opened this link straight from a text has no
   *  invoice to return to, so they get no header. */
  cameFromInvoice: boolean;
  page: LandingPageData | null;
  ogImage: string | null;
  ogTitle: string;
  ogDescription: string;
};

export default function PromotionLandingPage({ promotionSlug, page, ogTitle, ogDescription, ogImage, cameFromInvoice }: Props) {
  // Carousel state. Scoped to ONE item — a client browsing "Clean yard
  // debris" should page through that entry's photos, not slide into the
  // next service's. Null = closed.
  const [lightbox, setLightbox] = useState<{ itemId: string; index: number } | null>(null);
  const lightboxPhotos =
    (lightbox && page?.items.find((i) => i.id === lightbox.itemId)?.photos) || [];
  return (
    <>
      <Head>
        <title>{ogTitle}</title>
        <meta name="description" content={ogDescription} />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:type" content="website" />
        {ogImage && <meta property="og:image" content={ogImage} />}
        <meta name="twitter:card" content={ogImage ? "summary_large_image" : "summary"} />
      </Head>
      <Box minH="100vh" bg="gray.50" py={{ base: 6, md: 10 }}>
        <Container maxW="4xl">
          {!page ? (
            <Notice title="Page not found">
              <Text>
                This promotion link doesn&apos;t exist. It may have been removed.
              </Text>
            </Notice>
          ) : !page.promotionActive && !page.preview ? (
            // `preview` deliberately leaves promotionActive false — the page
            // is NOT live, and nothing downstream should treat it as such
            // (no view-count bump, banner shown). But the operator still
            // needs to SEE it, so preview takes the content branch.
            // A draft campaign, or one whose window hasn't opened, has NOT
            // ended — saying so misleads clients and misleads the operator
            // previewing their own unpublished page. The server sends a
            // coarse reason; content stays withheld either way.
            (() => {
              const notice = {
                not_started: {
                  title: "This offer isn't available yet",
                  body: "This promotion hasn't started. Please check back soon, or contact us for current offers.",
                },
                ended: {
                  title: "This offer has ended",
                  body: "This promotion has ended. Please contact us for current offers.",
                },
                unavailable: {
                  title: "This offer isn't available right now",
                  body: "This promotion isn't running at the moment. Please contact us for current offers.",
                },
                // Pre-`inactiveReason` responses: keep the old wording
                // rather than guessing at a state the server didn't send.
                unknown: {
                  title: "This offer has ended",
                  body: "This promotion has ended. Please contact us for current offers.",
                },
              }[page.inactiveReason ?? "unknown"];
              return (
                <Notice title={notice.title}>
                  <Text>{notice.body}</Text>
                </Notice>
              );
            })()
          ) : (
            <VStack align="stretch" gap={6}>
              {/* Way back to the invoice.
                  Shown ONLY for clicks that started on one (?from=invoice,
                  forwarded by the click handler). A client who opened this
                  from a text has no invoice behind them, and a back control
                  that goes nowhere is worse than none.
                  Uses history.back() rather than a URL: the invoice address
                  contains its payment token, which IS its auth, and that
                  must never be embedded in a shareable marketing link. */}
              {cameFromInvoice && <BackToInvoiceBar />}
              {/* Preview banner. Unmissable on purpose — this page looks
                  exactly like the live one, and mistaking a draft for
                  published is the failure mode worth designing against. */}
              {page.preview && (
                <Box
                  bg="orange.100"
                  borderWidth="1px"
                  borderColor="orange.300"
                  borderLeftWidth="4px"
                  borderLeftColor="orange.500"
                  rounded="md"
                  px={4}
                  py={3}
                >
                  <Text fontWeight="bold" color="orange.900" fontSize="sm">
                    Preview — not live
                  </Text>
                  <Text color="orange.900" fontSize="xs" mt={1}>
                    Only you can see this. Clients visiting this link get
                    &ldquo;not available yet&rdquo; until you start the campaign.
                    This preview link expires shortly.
                  </Text>
                </Box>
              )}
              <ContactHeader business={page.business} />
              {page.headline && (
                <Heading size={{ base: "lg", md: "xl" }} color="fg.default">
                  {page.headline}
                </Heading>
              )}
              {page.intro && (
                // The editor labels this "Intro paragraph (Markdown OK)".
                <Box fontSize={{ base: "md", md: "lg" }} color="fg.muted">
                  <MarkdownContent>{page.intro}</MarkdownContent>
                </Box>
              )}
              {/* The offer's Button label. Collected in the editor and
                  promised on this page, but never rendered — so an
                  operator's call-to-action silently vanished. Scrolls to
                  the contact header, which is the action on this page. */}
              {page.ctaText && (
                <Box>
                  <ChakraLink
                    href={`mailto:${page.business.email || ""}`}
                    display="inline-flex"
                    alignItems="center"
                    px={5}
                    py={3}
                    bg="green.600"
                    color="white"
                    fontWeight="semibold"
                    rounded="md"
                    _hover={{ bg: "green.700", textDecoration: "none" }}
                  >
                    {page.ctaText}
                  </ChakraLink>
                </Box>
              )}
              {page.items.length === 0 ? (
                <Text fontStyle="italic" color="fg.muted">
                  Details coming soon.
                </Text>
              ) : (
                <Grid
                  // auto-fit + a max track width, rather than a fixed
                  // column count. A fixed count left a single item pinned
                  // to a third of the width with dead space beside it, and
                  // the 1fr max let a lone card balloon. auto-fit collapses
                  // the empty tracks, the 320px cap keeps every card the
                  // same size whether there's one or nine, and centering
                  // means a short row sits in the middle instead of
                  // hugging the left edge.
                  // Tracks are `1fr`, so cards FILL the container width
                  // instead of sitting capped at 320px with dead space on
                  // both sides. auto-fit still wraps them onto new rows as
                  // the viewport narrows.
                  //
                  // The one exception is a single item: at full container
                  // width one card becomes a banner, so it gets a sane max
                  // and centers. That was the original reason for the cap —
                  // it just shouldn't have applied to every count.
                  templateColumns={
                    page.items.length === 1
                      ? "minmax(260px, 420px)"
                      : { base: "repeat(auto-fit, minmax(240px, 1fr))", sm: "repeat(auto-fit, minmax(260px, 1fr))" }
                  }
                  justifyContent={page.items.length === 1 ? "center" : "stretch"}
                  // Each card ends where its text ends.
                  //
                  // This was "stretch", on the theory that ragged bottoms
                  // look worse than trailing space. They don't: description
                  // lengths vary a lot (one line vs four), so a short entry
                  // next to a long one grew a tall column of dead white
                  // inside its border — the emptiness reads as a rendering
                  // bug, not as alignment.
                  //
                  // The photo frame above is a fixed 4:3 block, so card TOPS
                  // still line up across the row; only the bottoms differ,
                  // and only by the height of the text itself.
                  alignItems="start"
                  gap={{ base: 4, md: 6 }}
                >
                  {page.items.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      onOpenPhoto={(i) => setLightbox({ itemId: item.id, index: i })}
                    />
                  ))}
                </Grid>
              )}
            </VStack>
          )}
        </Container>
      </Box>
      {lightbox && lightboxPhotos.length > 0 && (
        <PhotoLightbox
          photos={lightboxPhotos}
          index={Math.min(lightbox.index, lightboxPhotos.length - 1)}
          onClose={() => setLightbox(null)}
          onPrev={() =>
            setLightbox((l) => (l && l.index > 0 ? { ...l, index: l.index - 1 } : l))
          }
          onNext={() =>
            setLightbox((l) =>
              l && l.index < lightboxPhotos.length - 1 ? { ...l, index: l.index + 1 } : l,
            )
          }
        />
      )}
    </>
  );
}

function ItemCard({
  item,
  onOpenPhoto,
}: {
  item: LandingPageItem;
  /** Opens the shared carousel at this photo's index within the item. */
  onOpenPhoto: (index: number) => void;
}) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      rounded="lg"
      overflow="hidden"
      shadow="sm"
      display="flex"
      flexDirection="column"
      // NOT h="100%". A percentage height resolves against the PARENT's
      // height, and the grid track is now auto-sized (alignItems="start"),
      // so there is no definite height to resolve against. The spec leaves
      // that case undefined and browsers split on it: Chrome falls back to
      // auto and looks right, Safari does not — which is exactly why this
      // card showed a tall column of dead white in Safari while rendering
      // correctly in Chrome. `auto` states the result Chrome was reaching
      // by accident, so both browsers agree.
      h="auto"
    >
      {/* Photo grid. One photo fills the card's width; several tile into
          squares. Tapping any opens the carousel at that photo, so the
          grid stays compact no matter how many photos an entry has.

          Direct <img> — Next.js's Image component would need
          remotePatterns for the R2 presigned domain, and presigned URLs
          rotate every 6 hours, so the optimization cache would thrash. */}
      {/* Photo block — ALWAYS the same height, whatever the photo count.
          It used to size itself from the tiles: one photo became a
          full-width square, two became half-width squares side by side and
          therefore half as tall, so cards in the same row came out wildly
          different heights. Now the block is a fixed 4:3 frame and the
          photos tile INSIDE it, so every card matches. */}
      <Box
        w="100%"
        style={{ aspectRatio: "4 / 3" }}
        bg="gray.100"
        overflow="hidden"
        display="grid"
        gap="2px"
        gridTemplateColumns={
          item.photos.length <= 1 ? "1fr"
            : item.photos.length === 3 ? "repeat(3, 1fr)"
            : "repeat(2, 1fr)"
        }
        gridTemplateRows={item.photos.length > 4 ? "repeat(2, 1fr)" : "1fr"}
      >
        {item.photos.length === 0 ? (
          <MissingPhotoPlaceholder />
        ) : (
          // Cap at 4 tiles; the 4th carries a "+N" when there are more, and
          // the carousel still holds every photo.
          item.photos.slice(0, 4).map((ph, i) => {
            const overflow = i === 3 && item.photos.length > 4;
            return (
              <Box
                key={ph.id}
                position="relative"
                overflow="hidden"
                cursor="pointer"
                minH={0}
                onClick={() => onOpenPhoto(i)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ph.url}
                  alt={i === 0 ? item.title : ""}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  loading="lazy"
                />
                {overflow && (
                  <Box
                    position="absolute"
                    inset="0"
                    bg="blackAlpha.600"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Text color="white" fontWeight="bold" fontSize="lg">
                      +{item.photos.length - 3}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
      <Box p={4}>
        <Text fontWeight="bold" fontSize="md" mb={1}>
          {item.title}
        </Text>
        {/* Editor labels this field "Description (Markdown)". */}
        <Box fontSize="sm" color="fg.muted">
          <MarkdownContent>{item.description}</MarkdownContent>
        </Box>
      </Box>
    </Box>
  );
}

// Compact contact bar rendered ABOVE the headline. Mobile-first —
// phone/email as tap-target icon buttons on the right; business name on
// the left. Address deliberately excluded from this compact view
// (it's still in the CAN-SPAM email footer for legal purposes; few
// clients tap an address on a promo page).
// Social icons appear inline if configured. Whole bar hides if no
// contact fields are set.
function ContactHeader({ business }: { business: BusinessBlock }) {
  const hasAnyContact = !!(business.phone || business.email);
  const hasSocial = business.socialLinks.length > 0;
  if (!hasAnyContact && !hasSocial && !business.name) return null;

  // tel: strips punctuation for iOS reliability; mailto is passthrough.
  const telHref = business.phone ? `tel:${business.phone.replace(/[^\d+]/g, "")}` : null;
  const mailHref = business.email ? `mailto:${business.email}` : null;

  return (
    <Box
      py={2}
      px={3}
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      rounded="md"
      shadow="sm"
    >
      <HStack justify="space-between" gap={2} wrap="wrap">
        {business.name ? (
          <Text fontWeight="semibold" fontSize="sm" truncate>
            {business.name}
          </Text>
        ) : (
          <Box />
        )}
        <HStack gap={2}>
          {telHref && (
            <ChakraLink
              href={telHref}
              display="inline-flex"
              alignItems="center"
              gap={1.5}
              px={3}
              h="40px"
              rounded="full"
              bg="green.600"
              color="white"
              fontWeight="semibold"
              fontSize="sm"
              _hover={{ bg: "green.700", textDecoration: "none" }}
              aria-label={`Call ${business.phone}`}
              title={`Call ${business.phone}`}
            >
              {/* Solid brand-color pill with icon + label — mobile-first
                  tap target ~40px tall, thumb-friendly. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              <Text as="span">Call</Text>
            </ChakraLink>
          )}
          {mailHref && (
            <ChakraLink
              href={mailHref}
              display="inline-flex"
              alignItems="center"
              gap={1.5}
              px={3}
              h="40px"
              rounded="full"
              bg="green.600"
              color="white"
              fontWeight="semibold"
              fontSize="sm"
              _hover={{ bg: "green.700", textDecoration: "none" }}
              aria-label={`Email ${business.email}`}
              title={`Email ${business.email}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              <Text as="span">Email</Text>
            </ChakraLink>
          )}
          {hasSocial && business.socialLinks.map((l) => (
            <ChakraLink
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={l.label}
              title={l.label}
              display="inline-block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={l.iconDataUrl}
                alt={l.label}
                style={{ width: 36, height: 36, borderRadius: 8, display: "block" }}
              />
            </ChakraLink>
          ))}
        </HStack>
      </HStack>
    </Box>
  );
}

// "Back to your invoice" bar.
//
// Rendered only when the visit began on an invoice — see cameFromInvoice.
//
// WHY history.back() AND NOT A LINK
// The invoice URL is /pay/<token>, and that token is the invoice's ONLY
// auth: anyone holding it can read the amount and address and self-report
// a payment. Promotion pages get forwarded and shared, so embedding the
// token here would turn a marketing link into a credential leak. Browser
// history knows where the client came from without us ever handling it.
//
// The bar hides itself if there is genuinely nothing to go back to (a
// forged ?from=invoice, or a restored tab). Better to show nothing than a
// button that does nothing.
function BackToInvoiceBar() {
  // Start hidden and reveal after mount: history length is a client-only
  // fact, and rendering it server-side would flash a control that may then
  // vanish. SSR emits nothing, so no hydration mismatch either.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    try {
      setCanGoBack(window.history.length > 1);
    } catch {
      setCanGoBack(false);
    }
  }, []);
  if (!canGoBack) return null;
  return (
    // STICKY, not just top-of-page. This page can run long — several
    // services, each with a photo grid — and the person we are rescuing
    // already felt trapped once. A control that scrolls away recreates
    // exactly that feeling halfway down. It stays put instead.
    <Box
      position="sticky"
      top={0}
      zIndex={10}
      // Full-bleed background so content scrolling underneath never shows
      // through the bar. mx/px cancel the Container's gutter so the bar
      // spans edge to edge on a phone.
      mx={{ base: -4, md: -6 }}
      px={{ base: 4, md: 6 }}
      py={3}
      bg="white"
      borderBottomWidth="1px"
      borderColor="gray.200"
      shadow="sm"
    >
      <Box
        as="button"
        onClick={() => {
          try {
            window.history.back();
          } catch {
            /* no history to return to — the bar simply does nothing */
          }
        }}
        w="full"
        display="flex"
        alignItems="center"
        justifyContent="center"
        gap={2}
        // Full-width, filled, 44px min height: this is the phone-first
        // escape hatch, so it gets a real button's weight and a tap
        // target that meets the platform minimum.
        minH="44px"
        px={4}
        // Blue to match the offer's own CTA on the invoice — the client
        // just tapped a blue button to get here, so the way back reads as
        // part of the same flow rather than a different site's chrome.
        bg="blue.600"
        color="white"
        fontSize="md"
        fontWeight="semibold"
        rounded="md"
        _hover={{ bg: "blue.700" }}
        _active={{ bg: "blue.800" }}
      >
        <span aria-hidden="true">←</span> Back to your invoice
      </Box>
    </Box>
  );
}

// Subtle end-user-facing placeholder for items that don't yet have an
// image. Reads as a deliberate "photo coming soon" tile — not a broken
// image icon. Uses a light diagonal stripe pattern to distinguish it
// clearly from a real photo while staying visually calm.
function MissingPhotoPlaceholder() {
  return (
    <Box
      w="100%"
      h="100%"
      position="relative"
      display="flex"
      alignItems="center"
      justifyContent="center"
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, #f7f7f7, #f7f7f7 10px, #efefef 10px, #efefef 20px)",
      }}
    >
      <VStack gap={1} color="fg.muted">
        {/* Inline camera-with-x SVG — no icon-lib import needed for a
            one-off placeholder. 32×32, centered inside the square tile. */}
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        <Text fontSize="2xs">Photo coming soon</Text>
      </VStack>
    </Box>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      rounded="lg"
      p={{ base: 6, md: 8 }}
      textAlign="center"
    >
      <Heading size="md" mb={2}>{title}</Heading>
      {/* Box, not Text. Chakra's Text renders a <p>, and every caller here
          passes its own <Text> as children — nesting <p> inside <p> is
          invalid HTML, so the browser reparents it during parsing and the
          client tree no longer matches the server's. That surfaced as
          "Expected server HTML to contain a matching <p> in <p>" and took
          the whole page down with a hydration error. A div wrapper accepts
          block children of any shape. */}
      <Box color="fg.muted">{children}</Box>
    </Box>
  );
}

// Server-side render so link-preview crawlers (iMessage, Facebook,
// Slack, etc.) get real OG tags. Also lets us 404 cleanly before any
// client bundle ships when the promotion doesn't exist.
export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const promotionSlug = String(ctx.params?.promotionSlug ?? "");
  // Base URL must be ABSOLUTE — server-side fetch() rejects relative
  // URLs with a TypeError. In prod NEXT_PUBLIC_API_BASE_URL is set to
  // "/api/_proxy" (relative) so callers on the CLIENT can hit the
  // proxy path directly; SSR has to swap that for an absolute URL
  // derived from the request Host + Proto.
  const isAbsoluteApiBase = /^https?:\/\//i.test(API_BASE);
  const proto = String(ctx.req.headers["x-forwarded-proto"] ?? "https").split(",")[0];
  const origin = isAbsoluteApiBase ? API_BASE : `${proto}://${ctx.req.headers.host}${API_BASE}`;
  // Forward the operator's preview token when present. The API verifies
  // it (slug-scoped, short-lived HMAC); this layer just passes it along.
  const previewToken = typeof ctx.query.preview === "string" ? ctx.query.preview : "";
  const url =
    `${origin}/api/public/promotion/${encodeURIComponent(promotionSlug)}` +
    (previewToken ? `?preview=${encodeURIComponent(previewToken)}` : "");
  let page: LandingPageData | null = null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) {
      page = (await res.json()) as LandingPageData;
    } else if (res.status === 404) {
      page = null;
    }
  } catch {
    page = null;
  }

  const ogTitle = page?.headline || "Promotion";
  // og:description is plain text in a social card — it can't render
  // markdown, so raw `#` and `**` would show verbatim in every shared
  // link preview. Strip the syntax rather than the content.
  const plain = (md: string) =>
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // links → their text
      .replace(/^#{1,6}\s+/gm, "")                   // headings
      .replace(/^\s*[-*+]\s+/gm, "")                 // bullets
      .replace(/^\s*>\s?/gm, "")                     // blockquotes
      .replace(/(\*\*|__)(.*?)\1/g, "$2")            // bold
      .replace(/(\*|_)(.*?)\1/g, "$2")                // italics
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")          // code
      .replace(/\s+/g, " ")
      .trim();
  const ogDescription =
    plain(page?.intro ?? "").slice(0, 200) ||
    plain(page?.items[0]?.description ?? "").slice(0, 200) ||
    "See our latest offers.";
  // First available photo across items — an item without photos shouldn't
  // cost the page its link preview.
  const ogImage = page?.items.flatMap((i) => i.photos)[0]?.url ?? null;
  // Did this visit start on an invoice? Set by the invoice CTA. A link
  // opened straight from a text, or a shared URL, has no invoice behind
  // it — and must not be shown a back control that leads nowhere.
  const cameFromInvoice = ctx.query.from === "invoice";

  // Log the promotion click HERE rather than via a redirect endpoint.
  //
  // The CTA used to bounce through /promotion/click/..., which occupied
  // its own history entry on mobile Safari — back landed on it and fired
  // forward again, so the promo page appeared to reload and only a rapid
  // double-press escaped. Linking straight here removes the hop entirely;
  // recording moves into this render.
  //
  // Fire-and-forget on purpose: a tracking failure must never cost the
  // client the page they asked for. `record=1` makes the endpoint log and
  // return 204 instead of redirecting.
  const clickToken = typeof ctx.query.t === "string" ? ctx.query.t : "";
  const clickPromoId = typeof ctx.query.p === "string" ? ctx.query.p : "";
  if (clickToken && clickPromoId) {
    const qs = new URLSearchParams({ t: clickToken, record: "1" });
    if (typeof ctx.query.c === "string" && ctx.query.c) qs.set("c", ctx.query.c);
    try {
      await fetch(
        `${origin}/api/public/promotion/click/p/${encodeURIComponent(clickPromoId)}?${qs.toString()}`,
        {
          // Pass the visitor's host through so the click is attributed to
          // the domain they actually used, matching the wrapper's old
          // sticky-domain behavior.
          headers: { "x-original-host": String(ctx.req.headers.host ?? "") },
        },
      );
    } catch {
      /* tracking is best-effort — never block the render */
    }
  }
  return {
    props: { promotionSlug, page, ogTitle, ogDescription, ogImage, cameFromInvoice },
  };
};
