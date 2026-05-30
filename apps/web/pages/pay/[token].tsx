// Public payment page — no Clerk auth required. The URL token IS the auth.
// Linked from SMS/email sent when a job transitions to PENDING_PAYMENT.
//
// Renders:
//   - Job summary (property, service date, tags, photos)
//   - Amount due (full job price, no expense subtraction)
//   - Payment options in priority order (Zelle, Cash, Check, Venmo)
//   - Client self-report buttons → POST /public/pay/[token]/self-report
//   - Post-self-report confirmation with account signup nudge
//
// If a Payment row already exists and is confirmed, shows a "Payment received"
// screen instead. If selfReported but not yet confirmed, shows "We've got your
// note — admin is verifying" so the client doesn't think nothing happened.

import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "@clerk/nextjs";
import { useBranding } from "@/src/lib/useBranding";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  SimpleGrid,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, Check, CheckCircle, ChevronLeft, ChevronRight, ExternalLink, Loader, X } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

// A resolved payment method from the server — instructions + deep link
// already have all {SETTING_KEY} and {{runtimeValue}} placeholders filled in.
type ResolvedPaymentMethod = {
  key: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  /** Business-flagged preferred method (PAYMENT_METHODS taxonomy). */
  preferred: boolean;
  instructions: string | null;
  deepLink: string | null;
};

type ResolveResponse = {
  occurrenceId: string;
  amountDue: number;
  propertyLabel: string;
  propertyAddress: string | null;
  serviceDate: string | null;
  jobTags: string | null;
  photos: { url: string; contentType: string | null }[];
  payment: {
    id: string;
    method: string;
    amountPaid: number;
    confirmed: boolean;
    selfReported: boolean;
    createdAt: string;
  } | null;
  preferredMethod: string | null;
  paymentOptions: { venmoHandle: string | null; zelleAddress: string | null };
  paymentMethods?: ResolvedPaymentMethod[];
  expiresAt: string | null;
};

// MethodKey is now any string — the taxonomy decides the universe. We keep
// the type for clarity but no longer constrain it to a fixed set.
type MethodKey = string;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function dollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Mounted-gate: `useAuth` asserts ClerkProvider context at call time, and
// during Next.js static export the assertion fails (provider hasn't
// initialized server-side) — breaks the build. By gating the actual page
// behind a mount flag we ensure Clerk hooks only fire after client
// hydration. SSR just sees the placeholder.
export default function PaymentPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <PageShell>
        <HStack justify="center" py={12}>
          <Loader size={20} />
          <Text>Loading…</Text>
        </HStack>
      </PageShell>
    );
  }
  return <PaymentPageInner />;
}

function PaymentPageInner() {
  const router = useRouter();
  const { isSignedIn, getToken, isLoaded: isAuthLoaded } = useAuth();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<MethodKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reportedJustNow, setReportedJustNow] = useState(false);
  // Two-stage confirm. Tapping the bottom "I've sent the …" button opens
  // this modal first; the modal's Yes button is what actually fires
  // selfReport(). Older clients tap-and-go too easily without this gate.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Ref on the currently-selected method card so "Not yet — show me how"
  // can scroll back to the inline steps panel.
  const selectedCardRef = useRef<HTMLDivElement | null>(null);
  // A signed-in worker (or admin/super) opening their own invoice link
  // should not be able to "pay" on behalf of the client — that would
  // shortcut the actual payment received and queue an unverified
  // approval. We detect the worker role on /api/me and surface a clear
  // warning instead of the submit UI. Anonymous visitors (the actual
  // client) see the normal page.
  const [isWorkerSession, setIsWorkerSession] = useState(false);
  // Lightbox index for the property-photo grid. null = closed. Tapping any
  // thumbnail opens at that index; the overlay supports left/right arrow
  // keys, swipe, and a close button — same UX as OccurrencePhotos.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/public/pay/${token}`);
        if (!res.ok) {
          if (cancelled) return;
          setError(res.status === 404 ? "expired" : "load_failed");
          setLoading(false);
          return;
        }
        const json: ResolveResponse = await res.json();
        if (cancelled) return;
        setData(json);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("load_failed");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Detect a worker/admin/super Clerk session. /api/me returns the user's
  // roles when authenticated; a missing or unauthorized response means we
  // treat the visitor as the client.
  useEffect(() => {
    if (!isAuthLoaded) return;
    if (!isSignedIn) { setIsWorkerSession(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const t = await getToken();
        if (!t) { if (!cancelled) setIsWorkerSession(false); return; }
        const res = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) { if (!cancelled) setIsWorkerSession(false); return; }
        const me: any = await res.json();
        const roles: string[] = Array.isArray(me?.roles)
          ? me.roles.map((r: any) => r?.role).filter(Boolean)
          : [];
        if (cancelled) return;
        setIsWorkerSession(
          roles.includes("WORKER") || roles.includes("ADMIN") || roles.includes("SUPER"),
        );
      } catch {
        if (!cancelled) setIsWorkerSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthLoaded, isSignedIn, getToken]);

  // Order the taxonomy-driven methods: business-preferred methods first, then
  // the order the server returned them in. Array.sort is stable, so config
  // order is preserved within each group. The taxonomy is the single source
  // of truth — adding/removing/flagging methods is a Settings edit.
  const orderedMethods: ResolvedPaymentMethod[] = useMemo(() => {
    const list = data?.paymentMethods ?? [];
    return [...list].sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  }, [data?.paymentMethods]);

  // Seed the selection with the client's preferred method once data loads,
  // so they don't have to re-pick if they're a returning customer.
  useEffect(() => {
    if (selectedMethod) return;
    const preferred = data?.preferredMethod;
    if (preferred && (data?.paymentMethods ?? []).some((m) => m.key === preferred)) {
      setSelectedMethod(preferred);
    }
  }, [data?.preferredMethod, data?.paymentMethods, selectedMethod]);

  const selectedLabel = useMemo(
    () => orderedMethods.find((m) => m.key === selectedMethod)?.label ?? null,
    [orderedMethods, selectedMethod],
  );

  // Single source of truth for the "I've sent the …" button label, used
  // both on the bottom CTA and in the inline step 2 callout so the wording
  // matches verbatim. Falls back to a generic phrase when no method is
  // picked yet (which also disables the button).
  const confirmButtonLabel = selectedLabel
    ? `I've sent the ${selectedLabel.toLowerCase()} payment`
    : "Pick a method above first";

  async function selfReport(method: MethodKey) {
    if (!token || submitting) return;
    // Client-side guard. The backend also rejects this path for a worker
    // session — see public.ts /public/pay/:token/self-report — but
    // catching it here gives a clearer message and skips the network call.
    if (isWorkerSession) {
      alert("This page is for the client. Use the worker app's Accept Payment dialog to record payments — don't submit on the client's behalf.");
      return;
    }
    setSubmitting(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Pass the Clerk token along when the visitor happens to be signed
      // in. The backend uses this purely to refuse worker self-reports;
      // anonymous visitors (the typical client) still go through.
      if (isSignedIn) {
        try {
          const t = await getToken();
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch { /* fall through — backend will accept as anonymous */ }
      }
      const res = await fetch(`${API_BASE}/api/public/pay/${token}/self-report`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method }),
      });
      if (!res.ok) throw new Error("Failed to record");
      setSelectedMethod(method);
      setReportedJustNow(true);
      // Refresh the data so the page shows the new payment state.
      const refreshed = await fetch(`${API_BASE}/api/public/pay/${token}`);
      if (refreshed.ok) setData(await refreshed.json());
    } catch {
      // Soft error — user can retry.
      alert("Couldn't record that just now. Please try again, or text us.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render branches ────────────────────────────────────────────────────

  if (loading) {
    return (
      <PageShell>
        <HStack justify="center" py={12}>
          <Loader size={20} />
          <Text>Loading…</Text>
        </HStack>
      </PageShell>
    );
  }

  if (error === "expired" || !data) {
    return (
      <PageShell>
        <Card.Root variant="outline">
          <Card.Body p={4}>
            <VStack gap={2} align="stretch">
              <Text fontSize="md" fontWeight="semibold">Payment link not valid</Text>
              <Text fontSize="xs" color="fg.muted">
                It may have expired or the link is mistyped. Please call or text us.
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      </PageShell>
    );
  }

  // Confirmed payment — already done; show a thank-you and the signup nudge.
  if (data.payment?.confirmed) {
    return (
      <PageShell>
        <ConfirmedView data={data} />
      </PageShell>
    );
  }

  // Just-self-reported in this session — show the confirmation screen with
  // signup nudge. (Server returns payment.confirmed=false but selfReported.)
  if (reportedJustNow || (data.payment?.selfReported && !data.payment?.confirmed)) {
    const reportedKey = (selectedMethod ?? data.payment?.method) as MethodKey | null;
    const reportedLabel =
      (data.paymentMethods ?? []).find((m) => m.key === reportedKey)?.label ?? reportedKey ?? null;
    return (
      <PageShell>
        <SelfReportedView data={data} method={reportedKey} methodLabel={reportedLabel} onOpenPhoto={setLightboxIdx} />
        {lightboxIdx != null && (
          <PhotoLightbox
            photos={data.photos}
            index={lightboxIdx}
            onClose={() => setLightboxIdx(null)}
            onPrev={() => setLightboxIdx((i) => (i != null && i > 0 ? i - 1 : i))}
            onNext={() => setLightboxIdx((i) => (i != null && i < data.photos.length - 1 ? i + 1 : i))}
          />
        )}
      </PageShell>
    );
  }

  // ── Payment options ─────────────────────────────────────────────────────

  return (
    <PageShell>
      <VStack gap={3} align="stretch">
        <Card.Root variant="outline">
          <Card.Body p={3}>
            <VStack gap={1} align="stretch">
              <Text fontSize="xs" color="fg.muted">Invoice for</Text>
              <Text fontSize="md" fontWeight="semibold" lineClamp={2}>{data.propertyLabel}</Text>
              {data.propertyAddress && data.propertyAddress !== data.propertyLabel && (
                <Text fontSize="xs" color="fg.muted">{data.propertyAddress}</Text>
              )}
              {data.serviceDate && (
                <Text fontSize="xs" color="fg.muted">Service: {fmtDate(data.serviceDate)}</Text>
              )}
              <HStack mt={2} align="baseline" justify="space-between">
                <Text fontSize="xs" color="fg.muted">Total due</Text>
                <Text fontSize="2xl" fontWeight="bold" color="teal.700">{dollar(data.amountDue)}</Text>
              </HStack>
            </VStack>
          </Card.Body>
        </Card.Root>

        {data.photos.length > 0 && (
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1.5}>What was done:</Text>
            <SimpleGrid columns={{ base: 3, md: 4 }} gap={2}>
              {data.photos.map((p, i) => (
                <Box
                  key={i}
                  onClick={() => setLightboxIdx(i)}
                  cursor="pointer"
                  borderRadius="md"
                  overflow="hidden"
                  borderWidth="1px"
                  borderColor="gray.200"
                  css={{ aspectRatio: "1" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                </Box>
              ))}
            </SimpleGrid>
          </Box>
        )}

        {isWorkerSession ? (
          <Box
            p={3}
            bg="orange.50"
            borderWidth="1px"
            borderColor="orange.300"
            borderLeftWidth="4px"
            borderLeftColor="orange.500"
            rounded="md"
          >
            <HStack gap={2} mb={1}>
              <AlertTriangle size={16} color="var(--chakra-colors-orange-700)" />
              <Text fontSize="sm" fontWeight="semibold" color="orange.800">
                You&apos;re signed in as a worker
              </Text>
            </HStack>
            <Text fontSize="xs" color="orange.800">
              This page is for the client to self-report their payment. As a worker, you
              shouldn&apos;t submit on the client&apos;s behalf — that creates a payment
              record without actual money received.
            </Text>
            <Text fontSize="xs" color="orange.800" mt={2}>
              To record a payment you collected yourself, open the job in the worker app
              and use <b>Accept Payment</b>. To send the client this link to pay
              themselves, use <b>Request Payment</b>.
            </Text>
          </Box>
        ) : (
          <Box>
            <Text fontSize="sm" fontWeight="semibold" mb={2}>How would you like to pay?</Text>
            <Box
              mb={3}
              p={3}
              bg="orange.50"
              borderWidth="1px"
              borderColor="orange.300"
              borderLeftWidth="4px"
              borderLeftColor="orange.500"
              borderRadius="md"
            >
              <Text fontSize="md" fontWeight="bold" color="orange.900">
                Selecting below does NOT pay your bill, it just informs us how you intend to pay.
              </Text>
            </Box>
            <VStack gap={2} align="stretch">
              {orderedMethods.length === 0 ? (
                <Text fontSize="xs" color="fg.muted">
                  No payment methods are configured. Please call or text us.
                </Text>
              ) : (
                orderedMethods.map((m) => (
                  <PaymentMethodCard
                    key={m.key}
                    config={m}
                    preferred={m.preferred}
                    usedLastTime={data.preferredMethod === m.key}
                    selected={selectedMethod === m.key}
                    onSelect={() => setSelectedMethod(m.key)}
                    amountDue={data.amountDue}
                    confirmButtonLabel={confirmButtonLabel}
                    cardRef={selectedMethod === m.key ? selectedCardRef : undefined}
                    submitting={submitting}
                    onSent={() => setConfirmOpen(true)}
                  />
                ))
              )}
            </VStack>
          </Box>
        )}
      </VStack>
      {confirmOpen && selectedMethod && (
        <SentConfirmModal
          methodLabel={selectedLabel ?? selectedMethod}
          amountDue={data.amountDue}
          submitting={submitting}
          onConfirm={() => {
            setConfirmOpen(false);
            void selfReport(selectedMethod);
          }}
          onCancel={() => {
            setConfirmOpen(false);
            // Scroll the selected card's inline steps back into view so the
            // client can re-read what they need to do outside this page.
            selectedCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        />
      )}
      {/* Photo lightbox — same UX (overlay, swipe, arrow keys, close on
          backdrop) used by OccurrencePhotos elsewhere in the app. Mounts
          via portal so it overlays everything regardless of where the
          PaymentPage sits in the tree. */}
      {lightboxIdx != null && data && (
        <PhotoLightbox
          photos={data.photos}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onPrev={() => setLightboxIdx((i) => (i != null && i > 0 ? i - 1 : i))}
          onNext={() => setLightboxIdx((i) => (i != null && data && i < data.photos.length - 1 ? i + 1 : i))}
        />
      )}
    </PageShell>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

/** Fullscreen photo viewer for the public payment page. Matches the
 *  OccurrencePhotos PhotoViewer behavior — keyboard arrows, swipe gestures,
 *  click-backdrop-to-close — without the worker-only delete/uploadedBy bits. */
function PhotoLightbox({
  photos,
  index,
  onClose,
  onPrev,
  onNext,
}: {
  photos: { url: string }[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const touchXRef = useRef<number | null>(null);
  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;
  const current = photos[index];

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onNext(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onPrev, onNext, onClose]);

  if (!current) return null;

  return (
    <Box
      position="fixed"
      inset="0"
      zIndex="9999"
      bg="blackAlpha.800"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={(e) => { touchXRef.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchXRef.current === null) return;
        const dx = e.changedTouches[0].clientX - touchXRef.current;
        touchXRef.current = null;
        if (Math.abs(dx) > 50) {
          if (dx < 0) onNext();
          else onPrev();
        }
      }}
    >
      {hasPrev && (
        <Box
          position="absolute"
          left="3"
          top="50%"
          transform="translateY(-50%)"
          color="white"
          cursor="pointer"
          p={2}
          zIndex={1}
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          userSelect="none"
        >
          <ChevronLeft size={28} />
        </Box>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.url}
        alt=""
        style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain", borderRadius: "8px" }}
        onClick={(e) => e.stopPropagation()}
      />
      {hasNext && (
        <Box
          position="absolute"
          right="3"
          top="50%"
          transform="translateY(-50%)"
          color="white"
          cursor="pointer"
          p={2}
          zIndex={1}
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          userSelect="none"
        >
          <ChevronRight size={28} />
        </Box>
      )}
      <Box
        position="absolute"
        top="3"
        right="3"
        color="white"
        cursor="pointer"
        p={2}
        zIndex={1}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        userSelect="none"
        aria-label="Close"
      >
        <X size={24} />
      </Box>
      <Text
        position="absolute"
        bottom="4"
        left="0"
        right="0"
        textAlign="center"
        color="whiteAlpha.700"
        fontSize="sm"
      >
        {index + 1} / {photos.length}
      </Text>
    </Box>
  );
}

// Season-aware brand icon resolver — mirrors BrandLabel.tsx so the pay
// page uses the same seasonal swap (spring/summer vs. fall) as the rest
// of the app. SSR-safe: returns the default spring icon when no window.
function resolveBrandIcon(): string {
  if (typeof window === "undefined") return "/seedlings-icon.png";
  try {
    const override = localStorage.getItem("seedlings_seasonOverride");
    if (override === "fall") return "/seedlings-icon-fall.png";
    if (override === "spring") return "/seedlings-icon.png";
  } catch { /* ignore — fall through to month-based default */ }
  const month = new Date().getMonth();
  return (month >= 2 && month <= 7) ? "/seedlings-icon.png" : "/seedlings-icon-fall.png";
}

function PageShell({ children }: { children: React.ReactNode }) {
  const { businessName } = useBranding();
  const [iconSrc, setIconSrc] = useState("/seedlings-icon.png");
  useEffect(() => { setIconSrc(resolveBrandIcon()); }, []);
  return (
    <>
      <Head>
        <title>Pay your invoice — {businessName}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Box minH="100vh" bg="gray.50">
        <Box maxW="md" mx="auto" px={3} py={4}>
          <HStack gap={2} align="center" mb={3}>
            <img
              src={iconSrc}
              alt={businessName}
              style={{ height: "28px", width: "auto", display: "block" }}
            />
            <Text fontSize="md" fontWeight="bold" color="teal.700">
              {businessName}
            </Text>
          </HStack>
          {children}
          <Text fontSize="xs" color="fg.muted" mt={5} textAlign="center">
            Questions? Reply to the text or email we sent you.
          </Text>
        </Box>
      </Box>
    </>
  );
}

// Generic, taxonomy-driven card. Reads pre-resolved `instructions` and
// `deepLink` from the server (placeholders already filled in). Adding a new
// payment method = adding a JSON entry in PAYMENT_METHODS, no card edits.
function PaymentMethodCard({
  config,
  preferred,
  usedLastTime,
  selected,
  onSelect,
  amountDue,
  confirmButtonLabel,
  cardRef,
  submitting,
  onSent,
}: {
  config: ResolvedPaymentMethod;
  /** Business-flagged preferred method — shows the "Preferred" badge. */
  preferred: boolean;
  /** This client paid with this method last time — shows the "Used last time" badge. */
  usedLastTime: boolean;
  selected: boolean;
  onSelect: () => void;
  /** Invoice total — fed into the fallback step-1 copy when neither
   *  `instructions` nor `deepLink` is configured on the method. */
  amountDue: number;
  /** Exact label of the in-card CTA shown when the card is selected. */
  confirmButtonLabel: string;
  /** Optional ref forwarded to the outer card so the parent can scroll it
   *  back into view from the "Not yet — show me how" path. */
  cardRef?: React.Ref<HTMLDivElement>;
  /** Loading flag while the self-report request is in flight. */
  submitting: boolean;
  /** Fires when the client taps the "I've sent the …" button — opens the
   *  parent's confirm modal. */
  onSent: () => void;
}) {
  return (
    <Card.Root
      variant="outline"
      ref={cardRef}
      onClick={onSelect}
      cursor="pointer"
      borderColor={selected ? "teal.500" : usedLastTime ? "teal.300" : undefined}
      borderWidth={selected ? "2px" : "1px"}
      bg={selected ? "teal.50" : undefined}
      _hover={{ borderColor: "teal.400" }}
    >
      <Card.Body p={3}>
        <VStack align="stretch" gap={1.5}>
          <HStack justify="space-between" align="center">
            <HStack gap={2}>
              <Box
                w="14px"
                h="14px"
                borderRadius="full"
                borderWidth="2px"
                borderColor={selected ? "teal.500" : "gray.300"}
                bg={selected ? "teal.500" : "transparent"}
                flexShrink={0}
              />
              <Text fontSize="sm" fontWeight="semibold">{config.label}</Text>
            </HStack>
            <HStack gap={1}>
              {preferred && (
                <Badge size="xs" colorPalette="green" variant="solid" px="2" py="0.5" borderRadius="full" fontSize="xs" lineHeight="1.2">
                  Preferred
                </Badge>
              )}
              {usedLastTime && (
                <Badge size="xs" colorPalette="teal" variant="subtle" px="2" py="0.5" borderRadius="full" fontSize="xs" lineHeight="1.2">
                  Used last time
                </Badge>
              )}
            </HStack>
          </HStack>

          {/* Instructions text — taxonomy-driven, always shown so the client
              can compare methods before committing. Falls back to a generic
              hint when the method has none configured. */}
          <Text fontSize="xs" color="fg.muted">
            {config.instructions ?? `Pay $${amountDue.toFixed(2)} via ${config.label}.`}
          </Text>

          {/* Deep-link button — always rendered when the method has one
              configured. We used to gate on a UA sniff for mobile, but it
              misfired on iPadOS desktop-mode Safari and devtools emulators,
              hiding the button for clients who could actually use it. On a
              real desktop browser tapping a venmo:// link is a no-op (or
              the browser asks once); harmless. Better to always offer the
              tap-through than gate it behind brittle device detection. */}
          {config.deepLink && (
            <Button
              size="md"
              variant={selected ? "solid" : "outline"}
              colorPalette="teal"
              w="full"
              h="11"
              fontSize="md"
              fontWeight="bold"
              boxShadow={selected ? "md" : undefined}
              bg={selected ? "#F97316" : undefined}
              color={selected ? "white" : undefined}
              _hover={selected ? { bg: "#EA580C" } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (!selected) onSelect();
                window.location.href = config.deepLink!;
              }}
            >
              <ExternalLink size={18} /> Open {config.label}
            </Button>
          )}

          {/* Step-2 reminder — only when selected. The deep-link button +
              instructions above ARE step 1; this callout pins down the
              second step (return + confirm) that older clients miss. */}
          {selected && (
            <Box
              mt={1}
              p={2}
              bg="white"
              borderWidth="1px"
              borderColor="teal.200"
              borderRadius="md"
            >
              <Text fontSize="xs" fontWeight="bold" color="teal.700" mb={0.5}>
                Don&apos;t forget — once you&apos;ve sent it:
              </Text>
              <Text fontSize="xs" color="fg.default">
                Come back here and tap the button below so we know to mark it received.
              </Text>
            </Box>
          )}

          {/* In-card confirm CTA — only on the selected card. Tapping opens
              the parent's "Have you sent $X via {method}?" confirm modal. */}
          {selected && (
            <Button
              mt={1}
              w="full"
              colorPalette="teal"
              loading={submitting}
              onClick={(e) => {
                e.stopPropagation();
                onSent();
              }}
            >
              <Check size={14} />
              {confirmButtonLabel}
            </Button>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * Two-stage confirm before submitting the self-report. Older clients tap
 * the bottom CTA expecting it's part of "picking" the method; this gate
 * forces them to confirm they actually sent money outside the page. "Not
 * yet — show me how" scrolls the selected card back into view so they can
 * re-read the steps.
 */
function SentConfirmModal({
  methodLabel,
  amountDue,
  submitting,
  onConfirm,
  onCancel,
}: {
  methodLabel: string;
  amountDue: number;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Box
      position="fixed"
      inset="0"
      bg="blackAlpha.700"
      zIndex={10000}
      display="flex"
      alignItems="center"
      justifyContent="center"
      px={4}
      onClick={onCancel}
    >
      <Box
        bg="white"
        borderRadius="lg"
        maxW="sm"
        w="full"
        p={5}
        boxShadow="2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <VStack align="stretch" gap={3}>
          <Text fontSize="md" fontWeight="bold">
            Have you sent ${amountDue.toFixed(2)} via {methodLabel}?
          </Text>
          <Text fontSize="xs" color="fg.muted">
            Tapping a payment method on this page doesn&apos;t send the money — you have
            to send it through {methodLabel} first, then come back here and confirm.
          </Text>
          <VStack align="stretch" gap={2} mt={1}>
            <Button
              colorPalette="teal"
              loading={submitting}
              onClick={onConfirm}
            >
              <Check size={14} /> Yes — mark it sent
            </Button>
            <Button
              variant="outline"
              colorPalette="gray"
              onClick={onCancel}
              disabled={submitting}
            >
              Not yet
            </Button>
          </VStack>
        </VStack>
      </Box>
    </Box>
  );
}


function SelfReportedView({ data, method, methodLabel, onOpenPhoto }: { data: ResolveResponse; method: MethodKey | null; methodLabel: string | null; onOpenPhoto: (idx: number) => void }) {
  const { businessName } = useBranding();
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <VStack gap={3} align="stretch">
          <HStack gap={2}>
            <Box color="orange.500"><AlertTriangle size={20} /></Box>
            <Text fontSize="md" fontWeight="bold">
              One last step — did your {dollar(data.amountDue)}{methodLabel ? ` ${methodLabel}` : ""} payment go through?
            </Text>
          </HStack>
          <Text fontSize="sm" color="fg.default">
            Please make sure you actually sent it to <Text as="span" fontWeight="semibold">{businessName}</Text>. We&apos;ll watch for it on our end and confirm once it arrives.
          </Text>
          <Text fontSize="sm" color="fg.default">
            Want to check the status yourself anytime? <Text as="span" fontWeight="semibold">Sign in (or create a free account) below.</Text>
          </Text>
          {/* method key reserved for future per-method copy */}
          {method ? "" : ""}
          {data.photos.length > 0 && (
            <SimpleGrid columns={{ base: 3, md: 4 }} gap={2}>
              {data.photos.map((p, i) => (
                <Box
                  key={i}
                  onClick={() => onOpenPhoto(i)}
                  cursor="pointer"
                  borderRadius="md"
                  overflow="hidden"
                  borderWidth="1px"
                  borderColor="gray.200"
                  css={{ aspectRatio: "1" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                </Box>
              ))}
            </SimpleGrid>
          )}
          <AccountNudge token={typeof window !== "undefined" ? new URL(window.location.href).pathname.split("/").pop() ?? "" : ""} />
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function ConfirmedView({ data }: { data: ResolveResponse }) {
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <VStack gap={3} align="stretch">
          <HStack gap={2}>
            <Box color="green.500"><CheckCircle size={22} /></Box>
            <Text fontSize="md" fontWeight="semibold">Payment received — thank you!</Text>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {dollar(data.payment!.amountPaid)} for {data.propertyLabel}.
          </Text>
          <AccountNudge token={typeof window !== "undefined" ? new URL(window.location.href).pathname.split("/").pop() ?? "" : ""} />
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function AccountNudge({ token }: { token: string }) {
  const onSignup = async () => {
    // Tag the source so future discount logic can apply credits AND grab the
    // on-file primary contact email + name so we can prefill them on the
    // sign-in form. Clerk's User model requires first/last name on signup;
    // since we already addressed the client by their name on the invoice,
    // re-typing it here would be terrible UX — we ship those values along
    // so the signup completes in one step.
    try {
      const res = await fetch(`${API_BASE}/api/public/pay/${token}/signup-from-page`, { method: "POST" });
      const data = await res.json().catch(() => null);
      const suggested: string | null = data?.suggestedEmail ?? null;
      const suggestedFirst: string | null = data?.suggestedFirstName ?? null;
      const suggestedLast: string | null = data?.suggestedLastName ?? null;
      try {
        if (suggested) sessionStorage.setItem("seedlings_prefill_email", suggested);
        if (suggestedFirst) sessionStorage.setItem("seedlings_prefill_firstName", suggestedFirst);
        if (suggestedLast) sessionStorage.setItem("seedlings_prefill_lastName", suggestedLast);
      } catch {}
    } catch {}
    // Send to Clerk sign-up. The /sign-in route handles new accounts too.
    window.location.href = "/sign-in";
  };
  return (
    <Box borderTopWidth="1px" borderColor="gray.200" pt={3}>
      <Text fontSize="sm" fontWeight="semibold" mb={1}>
        See your full service history
      </Text>
      <Text fontSize="xs" color="fg.muted" mb={2}>
        Your free account lets you see:
      </Text>
      <VStack align="start" gap={0.5} fontSize="xs" mb={3}>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Track payment status</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Photos from visits</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Upcoming services</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Reschedule your services</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Receipts</Text></HStack>
      </VStack>
      {/* Single CTA — passwordless auth means new and returning clients do
          the identical step (enter email → verification code), so a separate
          "Sign in" link would just present two doors to the same room. */}
      <Button size="sm" colorPalette="teal" w="full" onClick={onSignup}>
        Access your account →
      </Button>
      <Text fontSize="2xs" color="fg.muted" textAlign="center" mt={1.5}>
        Just enter your email — new or returning, it's the same step.
      </Text>
    </Box>
  );
}
