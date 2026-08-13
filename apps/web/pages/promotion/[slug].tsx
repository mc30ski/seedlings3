// Public promotion landing page — no auth required. URL: /promotion/<slug>.
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
import { Box, Container, Grid, Heading, HStack, Link as ChakraLink, Text, VStack } from "@chakra-ui/react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

type LandingPageItem = {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
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
  business: BusinessBlock;
};

type Props = {
  slug: string;
  page: LandingPageData | null;
  ogImage: string | null;
  ogTitle: string;
  ogDescription: string;
};

export default function PromotionLandingPage({ slug, page, ogTitle, ogDescription, ogImage }: Props) {
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
          ) : !page.promotionActive ? (
            <Notice title="This offer has ended">
              <Text>
                The promotion for <b>{slug}</b> has ended. Please contact us for current offers.
              </Text>
            </Notice>
          ) : (
            <VStack align="stretch" gap={6}>
              <ContactHeader business={page.business} />
              {page.headline && (
                <Heading size={{ base: "lg", md: "xl" }} color="fg.default">
                  {page.headline}
                </Heading>
              )}
              {page.intro && (
                <Text fontSize={{ base: "md", md: "lg" }} color="fg.muted" whiteSpace="pre-wrap">
                  {page.intro}
                </Text>
              )}
              {page.items.length === 0 ? (
                <Text fontStyle="italic" color="fg.muted">
                  Details coming soon.
                </Text>
              ) : (
                <Grid
                  templateColumns={{
                    base: "1fr",
                    sm: "repeat(2, 1fr)",
                    md: "repeat(2, 1fr)",
                    lg: "repeat(3, 1fr)",
                  }}
                  gap={{ base: 4, md: 6 }}
                >
                  {page.items.map((item) => (
                    <ItemCard key={item.id} item={item} />
                  ))}
                </Grid>
              )}
            </VStack>
          )}
        </Container>
      </Box>
    </>
  );
}

function ItemCard({ item }: { item: LandingPageItem }) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      rounded="lg"
      overflow="hidden"
      shadow="sm"
    >
      <Box
        w="100%"
        style={{ aspectRatio: "1" }}
        bg="gray.100"
        overflow="hidden"
      >
        {item.imageUrl ? (
          // Direct <img> — Next.js's Image component would require
          // configuring remotePatterns for the R2 presigned domain,
          // and presigned URLs rotate every 6 hours making the optimization
          // cache thrash. Plain <img> is fine for this use case.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.title}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
            loading="lazy"
          />
        ) : (
          <MissingPhotoPlaceholder />
        )}
      </Box>
      <Box p={4}>
        <Text fontWeight="bold" fontSize="md" mb={1}>
          {item.title}
        </Text>
        <Text fontSize="sm" color="fg.muted" whiteSpace="pre-wrap">
          {item.description}
        </Text>
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
      <Text color="fg.muted">{children}</Text>
    </Box>
  );
}

// Server-side render so link-preview crawlers (iMessage, Facebook,
// Slack, etc.) get real OG tags. Also lets us 404 cleanly before any
// client bundle ships when the slug doesn't exist.
export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const slug = String(ctx.params?.slug ?? "");
  const url = `${API_BASE || `http://${ctx.req.headers.host}`}/api/public/promotion/${encodeURIComponent(slug)}`;
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
  const ogDescription =
    page?.intro?.slice(0, 200) ||
    page?.items[0]?.description?.slice(0, 200) ||
    "See our latest offers.";
  const ogImage = page?.items[0]?.imageUrl ?? null;
  return {
    props: { slug, page, ogTitle, ogDescription, ogImage },
  };
};
