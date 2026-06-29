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
import { fmtDateOpts, bizMonth } from "@/src/lib/lib";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Portal,
  SimpleGrid,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, Check, CheckCircle, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Loader, X } from "lucide-react";

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
  /** Where to send the payment, for methods without a deep link (e.g.
   *  Zelle address, Cash App tag). Shown in large text in a modal when
   *  the client taps the orange button. Server resolves placeholders. */
  payToTarget: string | null;
  /** Optional QR-code image (data URL). When present, the manual-pay
   *  modal renders it inline + offers a Download button so a sender
   *  whose bank app can't paste a tag can scan the code on their
   *  phone instead. Currently used for Zelle. */
  payToTargetQrUrl: string | null;
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
    return fmtDateOpts(iso, {
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
  // Surfaced inline (not an alert) so the user can see exactly why
  // self-report failed — silent failures looked like "the button does
  // nothing" and led to the infinite-tap loop.
  const [selfReportError, setSelfReportError] = useState<string | null>(null);
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
        // Super is the owner role and overrides every other role — when
        // present we DON'T treat this as a worker session, even if the
        // same user also has WORKER/ADMIN rows. Worker + Admin without
        // Super still get the warning banner instead of the methods list.
        const isSuper = roles.includes("SUPER");
        setIsWorkerSession(
          !isSuper && (roles.includes("WORKER") || roles.includes("ADMIN")),
        );
      } catch {
        if (!cancelled) setIsWorkerSession(false);
      }
    })();
    return () => { cancelled = true; };
    // `getToken` is intentionally excluded — Clerk's useAuth doesn't
    // guarantee a stable reference across renders, so including it causes
    // this effect to re-fire on every render → setIsWorkerSession → another
    // render → infinite loop. We only need to re-run when auth state
    // actually changes (loaded/signed-in), and we use whatever getToken is
    // current at the time of the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoaded, isSignedIn]);

  // Order the taxonomy-driven methods: business-preferred methods first, then
  // the order the server returned them in. Array.sort is stable, so config
  // order is preserved within each group. The taxonomy is the single source
  // of truth — adding/removing/flagging methods is a Settings edit.
  const orderedMethods: ResolvedPaymentMethod[] = useMemo(() => {
    const list = data?.paymentMethods ?? [];
    return [...list].sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  }, [data?.paymentMethods]);

  // Seed the selection once data loads. Honor the client's saved preference
  // ONLY when it's still on the business's preferred list — otherwise default
  // to the first business-preferred method, falling back to the first
  // available method when nothing is flagged preferred. This prevents a prior
  // "Other" self-report from sticking forever as the auto-selected choice
  // and overriding the business's actual preferred methods.
  useEffect(() => {
    if (selectedMethod) return;
    const list = data?.paymentMethods ?? [];
    if (list.length === 0) return;
    const preferred = data?.preferredMethod;
    const savedIsBusinessPreferred =
      preferred && list.some((m) => m.key === preferred && m.preferred);
    const target = savedIsBusinessPreferred
      ? preferred
      : (list.find((m) => m.preferred) ?? list[0]).key;
    if (target) setSelectedMethod(target);
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
      setSelfReportError("This page is for the client. Use the worker app's Accept Payment dialog to record payments — don't submit on the client's behalf.");
      return;
    }
    setSelfReportError(null);
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
      if (!res.ok) {
        // Read the server's error payload so we can surface the actual
        // reason instead of swallowing it into a generic alert. The pay
        // page used to `catch {}` the failure, which left the user in the
        // same state after every tap — looked like the button did nothing.
        let serverMessage = "";
        try {
          const errBody = await res.json();
          serverMessage = errBody?.message || errBody?.error || "";
        } catch {
          try { serverMessage = await res.text(); } catch { /* ignore */ }
        }
        throw new Error(`Server returned ${res.status}${serverMessage ? `: ${serverMessage}` : ""}`);
      }
      setSelectedMethod(method);
      setReportedJustNow(true);
      // Refresh the data so the page shows the new payment state.
      const refreshed = await fetch(`${API_BASE}/api/public/pay/${token}`);
      if (refreshed.ok) setData(await refreshed.json());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[pay] self-report failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setSelfReportError(msg);
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
            <VStack gap={3} align="stretch">
              <Box>
                <Text fontSize="md" fontWeight="semibold">Payment link not valid</Text>
                <Text fontSize="xs" color="fg.muted">
                  It may have expired or the link is mistyped.
                </Text>
              </Box>
              <Box borderTopWidth="1px" borderColor="gray.200" pt={3}>
                <Text fontSize="sm" fontWeight="semibold" mb={1}>
                  Looking for previous receipts?
                </Text>
                <Text fontSize="xs" color="fg.muted" mb={2}>
                  Sign in (or create a free account) to see your service history, receipts, photos, and upcoming visits.
                </Text>
                <AccountNudge token="" />
              </Box>
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
            <Text fontSize="sm" fontWeight="semibold" mb={2}>How do you intend to pay?</Text>
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
                Selecting a payment method below does NOT pay your bill automatically. It just helps us find your payment.
              </Text>
            </Box>
            {selfReportError && (
              <Box
                mb={3}
                p={3}
                bg="red.50"
                borderWidth="1px"
                borderColor="red.300"
                borderLeftWidth="4px"
                borderLeftColor="red.500"
                borderRadius="md"
              >
                <Text fontSize="sm" fontWeight="bold" color="red.900" mb={1}>
                  Could not record your payment
                </Text>
                <Text fontSize="xs" color="red.800">
                  {selfReportError}
                </Text>
                <Text fontSize="xs" color="red.700" mt={1}>
                  Please send us a text or email so we can sort this out.
                </Text>
              </Box>
            )}
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
  // ET-anchored month — mirrors lib/season.ts.
  const month = bizMonth();
  return (month >= 3 && month <= 8) ? "/seedlings-icon.png" : "/seedlings-icon-fall.png";
}

function PageShell({ children }: { children: React.ReactNode }) {
  const { businessName } = useBranding();
  const [iconSrc, setIconSrc] = useState("/seedlings-icon.png");
  useEffect(() => { setIconSrc(resolveBrandIcon()); }, []);
  return (
    <>
      <Head>
        {/* Title is built as a single template-literal string so React
            doesn't render it as multiple text nodes with comment-marker
            separators ("<!-- -->") between them. Apple's iMessage link
            preview fetches the HTML <title> and would otherwise display
            those marker comments verbatim in the preview card. Also use
            a plain ASCII hyphen instead of an em-dash so SMS carriers
            never mangle the character on top of the React issue. */}
        <title>{`Pay your invoice - ${businessName}`}</title>
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
  // Manual-pay modal state. Only meaningful for methods that have
  // `payToTarget` but no `deepLink` (e.g. Zelle, where there's no
  // universal app deep link but we want the same prominent CTA as
  // Venmo). Tapping the orange button opens the modal; the modal shows
  // the target in large text with a copy button + the instructions.
  const [manualPayOpen, setManualPayOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasDeepLink = !!config.deepLink;
  const hasManualPay = !hasDeepLink && !!config.payToTarget;
  async function copyTarget() {
    if (!config.payToTarget) return;
    try {
      await navigator.clipboard.writeText(config.payToTarget);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — copy button stays "Copy", user can long-press the text instead */
    }
  }
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

          {/* Big orange CTA — same button for two flavors:
              (1) `deepLink` set → open the app (Venmo / Cash App).
              (2) `payToTarget` set but no deep link → open the manual-pay
                  modal (Zelle / mailing a check). Both flavors look
                  identical to the client; the difference is what happens
                  on tap. Methods with neither hide the button. */}
          {(hasDeepLink || hasManualPay) && (
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
                if (hasDeepLink) {
                  window.location.href = config.deepLink!;
                } else {
                  setManualPayOpen(true);
                }
              }}
            >
              <ExternalLink size={18} />{" "}
              {hasDeepLink
                ? `Open ${config.label}`
                : `Pay with ${config.label}`}
            </Button>
          )}

          {/* Manual-pay modal — only mounted when this method has
              `payToTarget`. Shows the target in big text with a copy
              button, plus the instructions as the smaller explainer. */}
          {hasManualPay && (
            <Dialog.Root
              open={manualPayOpen}
              onOpenChange={(e) => setManualPayOpen(e.open)}
              placement="center"
            >
              <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                  <Dialog.Content
                    mx="4"
                    maxW="md"
                    w="full"
                    rounded="2xl"
                    p="0"
                    shadow="xl"
                  >
                    <Dialog.Header pt="4" px="4" pb="0">
                      <Dialog.Title fontSize="lg" fontWeight="bold">
                        Send via {config.label}
                      </Dialog.Title>
                    </Dialog.Header>
                    <Dialog.Body p="4">
                      <VStack align="stretch" gap={3}>
                        {/* Informational callout — leads with the QR
                            because most personal bank accounts can't
                            send to a Zelle tag directly, so the QR is
                            the path that works for almost everyone. Tag
                            kept as a secondary fallback below for the
                            small subset of senders whose bank supports
                            tag-paste. Blue palette to signal info, not
                            warning. */}
                        <Box
                          p={2.5}
                          bg="blue.50"
                          borderWidth="1px"
                          borderColor="blue.200"
                          rounded="md"
                        >
                          <Text fontSize="xs" color="blue.900">
                            {config.label} can&apos;t open automatically like Venmo.{" "}
                            {config.payToTargetQrUrl ? (
                              <>
                                If your bank&apos;s {config.label} lets you send straight to a username, copy the recipient at the bottom. Otherwise, tap <b>Download QR</b> below to save the code, then open it from your phone&apos;s Photos app — your camera will read the QR and open {config.label} to send <b>${amountDue.toFixed(2)}</b>.
                              </>
                            ) : (
                              <>
                                Open your bank&apos;s {config.label} feature, paste the recipient below, and send <b>${amountDue.toFixed(2)}</b>.
                              </>
                            )}
                          </Text>
                        </Box>
                        {/* QR code — primary path. Renders only when the
                            method has a QR configured (currently Zelle).
                            Methods without one (Cash App tag, etc.) skip
                            this entirely and fall through to the tag
                            section below. */}
                        {config.payToTargetQrUrl && (
                          <VStack align="stretch" gap={2}>
                            <Box
                              p={3}
                              bg="white"
                              borderWidth="1px"
                              borderColor="gray.300"
                              rounded="lg"
                              display="flex"
                              justifyContent="center"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={config.payToTargetQrUrl}
                                alt={`${config.label} QR code`}
                                style={{ maxWidth: "240px", width: "100%", height: "auto" }}
                              />
                            </Box>
                            <Button
                              size="md"
                              colorPalette="green"
                              variant="solid"
                              onClick={() => {
                                if (!config.payToTargetQrUrl) return;
                                const a = document.createElement("a");
                                a.href = config.payToTargetQrUrl;
                                a.download = `${config.label.toLowerCase().replace(/\s+/g, "-")}-qr.png`;
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                              }}
                            >
                              <Download size={16} />
                              Download QR
                            </Button>
                          </VStack>
                        )}
                        {/* Tag/handle fallback — kept below the QR because
                            most senders can't actually use it from a
                            personal bank account; only the small subset
                            whose bank supports tag-paste benefits from
                            it. The label uses muted styling to signal
                            "alternative" rather than "primary action". */}
                        <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" fontWeight="semibold" mt={1}>
                          {config.payToTargetQrUrl ? "Or send to:" : `Send $${amountDue.toFixed(2)} to:`}
                        </Text>
                        {/* Tag + Copy merged into a single click target.
                            The recipient text reads as the big label;
                            tapping anywhere on the row triggers the copy
                            and flips the trailing icon/label to "Copied!".
                            When a QR is configured the tag is the
                            de-emphasized fallback (gray outline); without
                            a QR it's the primary action (teal solid). */}
                        <Box
                          as="button"
                          w="full"
                          px={3}
                          py={3}
                          rounded="lg"
                          borderWidth="1px"
                          textAlign="left"
                          cursor="pointer"
                          bg={config.payToTargetQrUrl ? "white" : "teal.500"}
                          color={config.payToTargetQrUrl ? "gray.900" : "white"}
                          borderColor={config.payToTargetQrUrl ? "gray.300" : "teal.500"}
                          _hover={{
                            bg: config.payToTargetQrUrl ? "gray.50" : "teal.600",
                            borderColor: config.payToTargetQrUrl ? "gray.400" : "teal.600",
                          }}
                          onClick={copyTarget}
                          aria-label={`Copy ${config.label} recipient ${config.payToTarget}`}
                        >
                          <HStack justify="space-between" align="center" gap={3}>
                            <Text
                              fontSize="xl"
                              fontWeight="bold"
                              wordBreak="break-all"
                              userSelect="all"
                              lineHeight="1.3"
                              flex={1}
                              textAlign="center"
                            >
                              {config.payToTarget}
                            </Text>
                            <HStack
                              gap={1}
                              flexShrink={0}
                              fontSize="xs"
                              fontWeight="semibold"
                              opacity={0.85}
                            >
                              {copied ? <Check size={14} /> : <Copy size={14} />}
                              <Text>{copied ? "Copied!" : "Copy"}</Text>
                            </HStack>
                          </HStack>
                        </Box>
                      </VStack>
                    </Dialog.Body>
                    <Dialog.Footer px="4" pb="4" pt="0">
                      <Button
                        w="full"
                        variant="outline"
                        onClick={() => setManualPayOpen(false)}
                      >
                        Close
                      </Button>
                    </Dialog.Footer>
                  </Dialog.Content>
                </Dialog.Positioner>
              </Portal>
            </Dialog.Root>
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
                Come back here and tap the button below so we know where to find it.
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
  const { businessName } = useBranding();
  // Resolve the method's display label so the headline names the channel
  // ("Zelle", "Venmo", etc.) instead of just "Payment received". Falls
  // back to the raw key, then to a generic phrasing if neither's set.
  const methodLabel =
    (data.paymentMethods ?? []).find((m) => m.key === data.payment?.method)?.label
      ?? data.payment?.method
      ?? null;
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <VStack gap={3} align="stretch">
          <HStack gap={2}>
            <Box color="green.500"><CheckCircle size={22} /></Box>
            <Text fontSize="md" fontWeight="bold">
              {businessName} confirmed your {dollar(data.payment!.amountPaid)}{methodLabel ? ` ${methodLabel}` : ""} payment.
            </Text>
          </HStack>
          <Text fontSize="sm" color="fg.default">
            We saw it land on our end. Your account is up to date for <Text as="span" fontWeight="semibold">{data.propertyLabel}</Text>. Thank you!
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
