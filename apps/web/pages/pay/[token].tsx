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

import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Check, CheckCircle, ExternalLink, Loader } from "lucide-react";

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

export default function PaymentPage() {
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<MethodKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reportedJustNow, setReportedJustNow] = useState(false);

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

  async function selfReport(method: MethodKey) {
    if (!token || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/public/pay/${token}/self-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        <SelfReportedView data={data} method={reportedKey} methodLabel={reportedLabel} />
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
          <HStack gap={1.5} overflowX="auto" pb={1}>
            {data.photos.map((p, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={p.url}
                alt=""
                style={{
                  flexShrink: 0,
                  width: "84px",
                  height: "84px",
                  objectFit: "cover",
                  borderRadius: "6px",
                  border: "1px solid var(--chakra-colors-gray-200)",
                }}
              />
            ))}
          </HStack>
        )}

        <Box>
          <Text fontSize="sm" fontWeight="semibold" mb={1}>How would you like to pay?</Text>
          <Text fontSize="xs" color="fg.muted" mb={2}>
            Pick a method, send your payment, then tap the button below to let us know. We&apos;ll confirm and email a receipt.
          </Text>
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
                />
              ))
            )}
          </VStack>
          <Button
            mt={3}
            w="full"
            colorPalette="teal"
            loading={submitting}
            disabled={!selectedMethod}
            onClick={() => selectedMethod && selfReport(selectedMethod)}
          >
            <Check size={14} />
            {selectedLabel
              ? `I've sent the ${selectedLabel.toLowerCase()} payment`
              : "Pick a method above first"}
          </Button>
        </Box>
      </VStack>
    </PageShell>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Head>
        <title>Pay your invoice — Seedlings Lawn Care</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Box minH="100vh" bg="gray.50">
        <Box maxW="md" mx="auto" px={3} py={4}>
          <Text fontSize="md" fontWeight="bold" color="teal.700" mb={3}>
            🌱 Seedlings Lawn Care
          </Text>
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
}: {
  config: ResolvedPaymentMethod;
  /** Business-flagged preferred method — shows the "Preferred" badge. */
  preferred: boolean;
  /** This client paid with this method last time — shows the "Used last time" badge. */
  usedLastTime: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  // Deep-link buttons typically use mobile-only schemes (e.g. venmo://). On
  // desktop those open nothing, so we fall back to a hint to use the phone.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setIsMobile(/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);

  return (
    <Card.Root
      variant="outline"
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
                <Badge size="xs" colorPalette="green" variant="solid" px="2" borderRadius="full">
                  Preferred
                </Badge>
              )}
              {usedLastTime && (
                <Badge size="xs" colorPalette="teal" variant="subtle" px="2" borderRadius="full">
                  Used last time
                </Badge>
              )}
            </HStack>
          </HStack>

          {config.instructions && (
            <Text fontSize="xs" color="fg.muted">{config.instructions}</Text>
          )}

          {config.deepLink && (
            isMobile ? (
              <Button
                size="xs"
                variant="outline"
                colorPalette="teal"
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = config.deepLink!;
                }}
              >
                <ExternalLink size={12} /> Open {config.label}
              </Button>
            ) : (
              <Text fontSize="2xs" color="fg.muted">
                Open {config.label} on your phone to send.
              </Text>
            )
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}


function SelfReportedView({ data, method, methodLabel }: { data: ResolveResponse; method: MethodKey | null; methodLabel: string | null }) {
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <VStack gap={3} align="stretch">
          <HStack gap={2}>
            <Box color="teal.500"><CheckCircle size={20} /></Box>
            <Text fontSize="md" fontWeight="semibold">Thank you.</Text>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Your{methodLabel ? ` ${methodLabel.toLowerCase()}` : ""} payment of {dollar(data.amountDue)} for {data.propertyLabel} is being confirmed. We&apos;ll send a receipt once it lands.
            {/* method key reserved for future per-method receipt copy */}
            {method ? "" : ""}
          </Text>
          {data.photos.length > 0 && (
            <HStack gap={1.5} overflowX="auto" pb={1}>
              {data.photos.map((p, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={p.url}
                  alt=""
                  style={{
                    flexShrink: 0,
                    width: "72px",
                    height: "72px",
                    objectFit: "cover",
                    borderRadius: "6px",
                    border: "1px solid var(--chakra-colors-gray-200)",
                  }}
                />
              ))}
            </HStack>
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
    // Tag the source so future discount logic can apply credits.
    try {
      await fetch(`${API_BASE}/api/public/pay/${token}/signup-from-page`, { method: "POST" });
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
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Photos from visits</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Upcoming services</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Reschedule from your phone</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Receipts (coming soon)</Text></HStack>
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
