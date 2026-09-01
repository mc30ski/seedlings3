"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Property parcel — public county record + overhead imagery.
//
// Opened from the icon on a job card. Admin/Super only: the county's
// appraised value and the owner of record are public record, but they are not
// something a worker needs, nor something to have on screen mid-conversation
// with a client.
//
// ORDER IS DELIBERATE. Acreage leads because it is the only figure that
// changes how a job is priced or scheduled. The imagery is second because it
// is what tells you how much of that acreage is actually mowable. Value and
// ownership are last and secondary — interesting context, not the reason to
// open this.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { getPropertyParcel, getParcelImageUrl, zillowUrl, mapsUrl, type ParcelResult, type ParcelImage } from "@/src/lib/parcels";
import { getErrorMessage } from "@/src/ui/components/InlineMessage";
import { fmtDateShort } from "@/src/lib/dates";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString()}`;

export default function PropertyParcelDialog({
  propertyId,
  propertyLabel,
  open,
  onClose,
}: {
  propertyId: string | null;
  propertyLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ParcelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [img, setImg] = useState<ParcelImage | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  /** Why the picture didn't arrive, in words the operator can act on. The
   *  old behaviour hid the whole block, so a failure was indistinguishable
   *  from a property that simply has no imagery. */
  const [imgErr, setImgErr] = useState<string | null>(null);
  /** Cleared only when the <img> actually paints. There are TWO blank windows
   *  otherwise — waiting on the signed URL, then waiting on the download —
   *  and during both the dialog looked like a property with no imagery. */
  const [imgReady, setImgReady] = useState(false);

  async function load(refresh = false) {
    if (!propertyId) return;
    setLoading(true);
    setErr(null);
    setImgFailed(false);
    setImgErr(null);
    setImg(null);
    setImgReady(false);
    try {
      const r = await getPropertyParcel(propertyId, refresh);
      setResult(r);
      // Only worth an imagery call once we know where the parcel is.
      if (r.data && !r.error) {
        try {
          setImg(await getParcelImageUrl(propertyId));
        } catch (e) {
          // The record is still useful without the picture — keep it, and say
          // what went wrong rather than silently dropping the panel.
          setImgErr(getErrorMessage("The overhead image couldn't be loaded.", e));
          setImgFailed(true);
        }
      }
    } catch (e) {
      setErr(getErrorMessage("Couldn't look up the parcel.", e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && propertyId) void load(false);
    if (!open) { setResult(null); setErr(null); setImg(null); setImgReady(false); setImgErr(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyId]);

  async function retryImage() {
    if (!propertyId) return;
    setImgFailed(false);
    setImgErr(null);
    setImgReady(false);
    setImg(null);
    try {
      setImg(await getParcelImageUrl(propertyId));
    } catch (e) {
      setImgErr(getErrorMessage("The overhead image couldn't be loaded.", e));
      setImgFailed(true);
    }
  }

  if (!open || !propertyId) return null;
  const d = result?.data ?? null;

  return (
    <Box
      position="fixed"
      inset="0"
      bg="blackAlpha.600"
      zIndex={12000}
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={3}
      onClick={onClose}
    >
      <Box
        bg="white"
        borderRadius="lg"
        shadow="xl"
        maxW="640px"
        w="full"
        maxH="90vh"
        overflowY="auto"
        p={4}
        onClick={(e: any) => e.stopPropagation()}
      >
        <HStack justify="space-between" align="start" mb={1}>
          <VStack align="start" gap={0}>
            <Text fontWeight="bold" fontSize="md">{propertyLabel}</Text>
            <Text fontSize="xs" color="fg.muted">Public county record</Text>
          </VStack>
          <HStack gap={1}>
            <Button size="xs" variant="ghost" onClick={() => void load(true)} loading={loading} title="Re-query the county">
              <RefreshCw size={13} />
            </Button>
            <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
          </HStack>
        </HStack>

        {loading && !result && (
          <HStack py={8} justify="center" gap={2}><Spinner size="sm" /><Text fontSize="sm" color="fg.muted">Looking up the parcel…</Text></HStack>
        )}

        {err && (
          <HStack bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" p={2} gap={2} mt={2}>
            <TriangleAlert size={15} color="var(--chakra-colors-red-600)" />
            <Text fontSize="sm" color="red.700">{err}</Text>
          </HStack>
        )}

        {/* A lookup that ran and found nothing is not an error — it's an
            out-of-state property or an address the geocoder can't place.
            Say which, rather than showing an empty dialog. */}
        {result?.error && (
          <HStack bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={2} gap={2} mt={2}>
            <TriangleAlert size={15} color="var(--chakra-colors-orange-600)" />
            <Text fontSize="sm" color="orange.800">{result.error}</Text>
          </HStack>
        )}

        {d && (
          <VStack align="stretch" gap={3} mt={3}>
            {/* When the county publishes no site addresses there is nothing to
                confirm the match against, and the geocoded point sits in the
                road — so the nearest parcel may be the neighbour's. Say so
                plainly rather than presenting a guess as a record. */}
            {d.confident === false && (
              <HStack bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={2} gap={2} align="start">
                <TriangleAlert size={15} color="var(--chakra-colors-orange-600)" style={{ flexShrink: 0, marginTop: 2 }} />
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="semibold" color="orange.800">Approximate match — verify before relying on it</Text>
                  <Text fontSize="xs" color="orange.800">
                    {d.county ? `${d.county} County` : "This county"} doesn&apos;t publish parcel addresses, so this is the
                    closest parcel to the address rather than a confirmed one. Check the outline below sits on the right property.
                  </Text>
                </VStack>
              </HStack>
            )}

            {/* Acreage first — the number that changes the job. */}
            <HStack gap={3} align="baseline" wrap="wrap">
              <Text fontSize="2xl" fontWeight="bold" lineHeight="1">
                {d.acres != null ? d.acres.toFixed(2) : "—"}
              </Text>
              <Text fontSize="sm" color="fg.muted">acres · whole parcel</Text>
              {/* Which field answered. Orange County leaves `gisacres` at 0
                  while Chatham and Durham populate it, so the number can come
                  from three different places and it's worth saying which. */}
              {d.acresBasis && d.acresBasis !== "county GIS acreage" && (
                <Text fontSize="2xs" color="fg.muted">({d.acresBasis})</Text>
              )}
              {d.county && <Badge size="sm" colorPalette="gray" variant="subtle">{d.county} County</Badge>}
            </HStack>

            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
              Total parcel size, not mowable area — woods, house and drive are all inside this number.
            </Text>

            {/* A failure gets its OWN panel rather than the block vanishing.
                The imagery comes from a free public service whose latency is
                wildly erratic (measured 1.2s to 24.6s on identical requests),
                so a failure here is expected occasionally and is almost
                always fixed by trying again. */}
            {imgFailed && (
              <VStack
                align="start"
                gap={2}
                borderWidth="1px"
                borderColor="orange.200"
                bg="orange.50"
                borderRadius="md"
                p={3}
              >
                <HStack gap={2} align="start">
                  <TriangleAlert size={15} color="var(--chakra-colors-orange-600)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <VStack align="start" gap={0}>
                    <Text fontSize="sm" fontWeight="semibold" color="orange.800">
                      Overhead image unavailable
                    </Text>
                    <Text fontSize="xs" color="orange.800">
                      {imgErr ?? "The imagery service didn't respond."}
                    </Text>
                  </VStack>
                </HStack>
                <Text fontSize="2xs" color="orange.800">
                  The parcel details above are unaffected — they're already cached and don't
                  depend on this service.
                </Text>
                <Button size="xs" variant="outline" colorPalette="orange" onClick={() => void retryImage()}>
                  <RefreshCw size={12} /> Try the image again
                </Button>
              </VStack>
            )}
            {!imgFailed && (
              <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden" bg="gray.50">
                {/* Placeholder holds the space the image will occupy, so the
                    dialog doesn't reflow when it lands and — more importantly
                    — doesn't read as "this property has no imagery" for the
                    several seconds a first, uncached lookup takes. */}
                {!imgReady && (
                  <VStack
                    justify="center"
                    gap={2}
                    minH="220px"
                    bgGradient="linear(to-br, gray.100, gray.200)"
                    color="fg.muted"
                  >
                    <Spinner size="lg" borderWidth="3px" color="blue.400" />
                    <Text fontSize="sm" fontWeight="medium">Fetching overhead imagery…</Text>
                    <Text fontSize="2xs">First look at a property takes a few seconds; after that it's cached.</Text>
                  </VStack>
                )}
                {img && (
                  <Box position="relative" display={imgReady ? "block" : "none"}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={`Overhead view of ${propertyLabel}`}
                      style={{ display: "block", width: "100%", height: "auto" }}
                      onLoad={() => setImgReady(true)}
                      onError={() => {
                        // Distinct from a failed FETCH: the URL resolved but
                        // the bytes behind it aren't a displayable image.
                        setImgErr("The image file couldn't be displayed — it may have been cached incorrectly. Try again to re-fetch it.");
                        setImgFailed(true);
                      }}
                    />
                    {/* Parcel boundary drawn over the imagery.
                        The bbox comes back with the image and the picture is
                        rendered in the same SR as the coordinates, so this
                        linear mapping is exact rather than approximate —
                        see the imageSR note in services/parcels.ts. */}
                    {result?.boundary?.length ? (
                      <Box position="absolute" inset="0" pointerEvents="none">
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
                          {result.boundary.map((ring, i) => {
                            const pts = ring
                              .map(([lon, lat]) =>
                                `${((lon - img.bbox.minX) / (img.bbox.maxX - img.bbox.minX)) * 100},` +
                                `${(1 - (lat - img.bbox.minY) / (img.bbox.maxY - img.bbox.minY)) * 100}`)
                              .join(" ");
                            return (
                              <g key={i}>
                                {/* Drawn TWICE. A single line disappears into
                                    the imagery — dark red vanishes against
                                    tree canopy, light red against a roof or
                                    driveway. The white under-stroke guarantees
                                    contrast on both, the way map borders and
                                    subtitles are outlined.
                                    strokeWidth is in SCREEN PIXELS here because
                                    of non-scaling-stroke, so the old 0.5 was a
                                    literal half-pixel hairline. */}
                                <polygon
                                  points={pts}
                                  fill="none"
                                  stroke="rgba(255,255,255,0.9)"
                                  strokeWidth="5"
                                  strokeLinejoin="round"
                                  vectorEffect="non-scaling-stroke"
                                />
                                <polygon
                                  points={pts}
                                  fill="rgba(153,27,27,0.12)"
                                  stroke="rgb(127,29,29)"
                                  strokeWidth="2.5"
                                  strokeLinejoin="round"
                                  vectorEffect="non-scaling-stroke"
                                />
                              </g>
                            );
                          })}
                        </svg>
                      </Box>
                    ) : null}
                  </Box>
                )}
                {imgReady && (
                <Text fontSize="2xs" color="fg.muted" px={2} py={1}>
                  State orthoimagery, 6 in/pixel. Flown in winter with the leaves off — bare trees
                  read as open ground, so this understates tree cover.
                </Text>
                )}
              </Box>
            )}

            {/* Value + owner only when the server sent them. Workers get a
                redacted payload (routes/me.ts), so these simply aren't in the
                data rather than being hidden by a client-side flag. */}
            {!result?.redacted && (<>
            {/* Labelled as the COUNTY'S ASSESSMENT, not a market valuation.
                The raw field is literally tagged "Market" — North Carolina
                assesses at 100% of market value — but only as of the last
                revaluation, which runs on a multi-year county cycle. Showing
                "Total (Market)" invited reading a figure that can be years
                old as what the place is worth today. */}
            <Box borderTopWidth="1px" borderColor="gray.200" pt={2}>
              <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                County tax assessment
              </Text>
              <HStack justify="space-between"><Text fontSize="sm" color="fg.muted">Land</Text><Text fontSize="sm">{money(d.landValue)}</Text></HStack>
              <HStack justify="space-between"><Text fontSize="sm" color="fg.muted">Improvements</Text><Text fontSize="sm">{money(d.improvementValue)}</Text></HStack>
              <HStack justify="space-between">
                <Text fontSize="sm" fontWeight="semibold">Total assessed</Text>
                <Text fontSize="sm" fontWeight="semibold">{money(d.totalValue)}</Text>
              </HStack>
              {/* The assessed figure is stale by design, so offer the places
                  that carry a current estimate. Deliberately LINKS rather than
                  an integration: Zillow's API has been partner-only since
                  2021, and scraping is against their terms. */}
              {result?.address?.street1 && (
                <HStack gap={2} mt={2} wrap="wrap">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => window.open(zillowUrl(result.address), "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink size={12} /> Market value on Zillow
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => window.open(mapsUrl(result.address), "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink size={12} /> Street View
                  </Button>
                </HStack>
              )}
              <Text fontSize="2xs" color="fg.muted" fontStyle="italic" mt={1}>
                What the county taxes the property on, set at its last revaluation
                {d.county ? ` (${d.county} County reappraises on a multi-year cycle)` : ""} — not a
                current market estimate, and it drifts as the market moves.
              </Text>
            </Box>

            {d.owner && (
              <Box>
                <Text fontSize="xs" color="fg.muted">Owner of record</Text>
                <Text fontSize="sm">{d.owner}</Text>
                {/* Owner of record is not necessarily the client — rentals are
                    common, and the distinction matters before you mention it
                    to anyone. */}
                <Text fontSize="2xs" color="fg.muted" fontStyle="italic">
                  From the county deed record — not necessarily your client.
                </Text>
              </Box>
            )}
            </>)}

            {/* Street View stays for everyone — finding the place and seeing
                the frontage from the road is operational, not financial. */}
            {result?.redacted && result?.address?.street1 && (
              <Button
                size="xs"
                variant="outline"
                alignSelf="start"
                onClick={() => window.open(mapsUrl(result.address), "_blank", "noopener,noreferrer")}
              >
                <ExternalLink size={12} /> Street View
              </Button>
            )}

            <VStack align="start" gap={0} borderTopWidth="1px" borderColor="gray.100" pt={2}>
              <Text fontSize="2xs" color="fg.muted">
                Parcel {d.parcelNumber ?? "—"}{d.siteAddress ? ` · ${d.siteAddress}` : ""}
              </Text>
              <Text fontSize="2xs" color="fg.muted">{d.source}</Text>
              {result?.fetchedAt && (
                <Text fontSize="2xs" color="fg.muted">
                  Looked up {fmtDateShort(new Date(result.fetchedAt))}
                  {result.cached ? " · cached" : ""}
                </Text>
              )}
            </VStack>
          </VStack>
        )}
      </Box>
    </Box>
  );
}
