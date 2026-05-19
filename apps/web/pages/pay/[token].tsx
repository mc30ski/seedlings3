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
import { Check, CheckCircle, Copy, ExternalLink, Loader } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

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
  expiresAt: string | null;
};

// Display order on the public invoice page. The preferred method (if the
// client has used one before) still floats to the top via prior logic;
// otherwise this baseline order applies.
const METHOD_ORDER = ["CASH", "CHECK", "ZELLE", "VENMO"] as const;
type MethodKey = (typeof METHOD_ORDER)[number];

const METHOD_LABELS: Record<MethodKey, string> = {
  ZELLE: "Zelle",
  CASH: "Cash",
  CHECK: "Check",
  VENMO: "Venmo",
};

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

  // Highlight the client's preferred method first if known; otherwise keep
  // the business priority order. Returns ordered methods.
  const orderedMethods: MethodKey[] = useMemo(() => {
    const preferred = data?.preferredMethod as MethodKey | null;
    if (preferred && METHOD_ORDER.includes(preferred as MethodKey)) {
      return [preferred as MethodKey, ...METHOD_ORDER.filter((m) => m !== preferred)];
    }
    return [...METHOD_ORDER];
  }, [data?.preferredMethod]);

  // Seed the selection with the client's preferred method once data loads,
  // so they don't have to re-pick if they're a returning customer.
  useEffect(() => {
    if (selectedMethod) return;
    const preferred = data?.preferredMethod as MethodKey | null;
    if (preferred && METHOD_ORDER.includes(preferred)) {
      setSelectedMethod(preferred);
    }
  }, [data?.preferredMethod, selectedMethod]);

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
    return (
      <PageShell>
        <SelfReportedView data={data} method={(selectedMethod ?? data.payment?.method) as MethodKey | null} />
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
            {orderedMethods.map((m) => (
              <PaymentMethodCard
                key={m}
                method={m}
                amount={data.amountDue}
                propertyLabel={data.propertyLabel}
                serviceDate={data.serviceDate}
                preferred={data.preferredMethod === m}
                selected={selectedMethod === m}
                paymentOptions={data.paymentOptions}
                onSelect={() => setSelectedMethod(m)}
              />
            ))}
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
            {selectedMethod
              ? `I've sent the ${METHOD_LABELS[selectedMethod].toLowerCase()} payment`
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

function PaymentMethodCard({
  method,
  amount,
  propertyLabel,
  serviceDate,
  preferred,
  selected,
  paymentOptions,
  onSelect,
}: {
  method: MethodKey;
  amount: number;
  propertyLabel: string;
  serviceDate: string | null;
  preferred: boolean;
  selected: boolean;
  paymentOptions: { venmoHandle: string | null; zelleAddress: string | null };
  onSelect: () => void;
}) {
  // Memo used in deep-link / suggested-memo for each method.
  const memo = `${propertyLabel}${serviceDate ? " " + fmtDate(serviceDate) : ""}`;
  // `venmo://` is a mobile-only URL scheme — opening it on desktop does
  // nothing. Detect once on mount so we can show the deep-link button only
  // on phones / tablets and fall back to plain instructions on desktop.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setIsMobile(/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);
  // Tracks which value (if any) was just copied so we can flash a "Copied"
  // indicator next to it. Keyed by an arbitrary string per copy target.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts or older browsers —
      // fall back silently. The value is still visible to copy manually.
    }
  }

  return (
    <Card.Root
      variant="outline"
      onClick={onSelect}
      cursor="pointer"
      borderColor={selected ? "teal.500" : preferred ? "teal.300" : undefined}
      borderWidth={selected ? "2px" : "1px"}
      bg={selected ? "teal.50" : undefined}
      _hover={{ borderColor: "teal.400" }}
    >
      <Card.Body p={3}>
        <VStack align="stretch" gap={1.5}>
          <HStack justify="space-between" align="center">
            <HStack gap={2}>
              {/* Radio-style selection dot */}
              <Box
                w="14px"
                h="14px"
                borderRadius="full"
                borderWidth="2px"
                borderColor={selected ? "teal.500" : "gray.300"}
                bg={selected ? "teal.500" : "transparent"}
                flexShrink={0}
              />
              <Text fontSize="sm" fontWeight="semibold">{METHOD_LABELS[method]}</Text>
            </HStack>
            {preferred && (
              <Badge size="xs" colorPalette="teal" variant="subtle" px="2" borderRadius="full">
                Used last time
              </Badge>
            )}
          </HStack>

          {method === "ZELLE" && (
            paymentOptions.zelleAddress ? (
              <CopyRow
                label="Send to"
                value={paymentOptions.zelleAddress}
                copied={copiedKey === "zelle-addr"}
                onCopy={(e) => {
                  e.stopPropagation();
                  void copyValue("zelle-addr", paymentOptions.zelleAddress!);
                }}
              />
            ) : (
              <Text fontSize="xs" color="fg.muted">Zelle isn&apos;t configured yet — call or text us.</Text>
            )
          )}

          {method === "CASH" && (
            <Text fontSize="xs" color="fg.muted">
              Pay your worker next visit, or leave a sealed envelope at the property.
            </Text>
          )}

          {method === "CHECK" && (
            <Text fontSize="xs" color="fg.muted">
              Payable to <strong>Seedlings Lawn Care LLC</strong>. Leave at the property or mail.
            </Text>
          )}

          {method === "VENMO" && (
            paymentOptions.venmoHandle ? (
              <>
                <CopyRow
                  label="Send to"
                  value={`@${paymentOptions.venmoHandle}`}
                  copied={copiedKey === "venmo-addr"}
                  onCopy={(e) => {
                    e.stopPropagation();
                    void copyValue("venmo-addr", `@${paymentOptions.venmoHandle}`);
                  }}
                />
                {isMobile ? (
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="teal"
                    onClick={(e) => {
                      // Don't toggle the card's selection when launching the
                      // deep link — Venmo opens but selection state stays.
                      e.stopPropagation();
                      const url = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(paymentOptions.venmoHandle!)}&amount=${amount.toFixed(2)}&note=${encodeURIComponent(memo)}`;
                      window.location.href = url;
                    }}
                  >
                    <ExternalLink size={12} /> Open Venmo
                  </Button>
                ) : (
                  <Text fontSize="2xs" color="fg.muted">
                    Open Venmo on your phone and send to the handle above.
                  </Text>
                )}
              </>
            ) : (
              <Text fontSize="xs" color="fg.muted">Venmo isn&apos;t configured yet — call or text us.</Text>
            )
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

// Compact label + copyable value row used inside Zelle / Venmo cards.
// Renders the value in mono and a copy button that flips to a green check
// for 1.5s after a successful clipboard write.
function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: (e: React.MouseEvent) => void;
}) {
  return (
    <Box
      px={2}
      py={1.5}
      borderRadius="md"
      bg="gray.100"
      fontSize="xs"
    >
      <HStack justify="space-between" align="center" gap={2}>
        <Box minW={0} flex="1">
          <Text fontFamily="body" fontSize="2xs" color="fg.muted">{label}</Text>
          <Text fontFamily="mono" fontSize="xs" wordBreak="break-all">{value}</Text>
        </Box>
        <Button
          size="xs"
          variant={copied ? "solid" : "outline"}
          colorPalette={copied ? "green" : "gray"}
          onClick={onCopy}
          flexShrink={0}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </Button>
      </HStack>
    </Box>
  );
}

function SelfReportedView({ data, method }: { data: ResolveResponse; method: MethodKey | null }) {
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <VStack gap={3} align="stretch">
          <HStack gap={2}>
            <Box color="teal.500"><CheckCircle size={20} /></Box>
            <Text fontSize="md" fontWeight="semibold">Thanks — we got it.</Text>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Your{method ? ` ${METHOD_LABELS[method].toLowerCase()}` : ""} payment of {dollar(data.amountDue)} for {data.propertyLabel} is being confirmed. We&apos;ll email a receipt once it lands.
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
        Create a free account to see:
      </Text>
      <VStack align="start" gap={0.5} fontSize="xs" mb={3}>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Photos from every visit</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Upcoming services</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Reschedule from your phone</Text></HStack>
        <HStack gap={2}><Box color="green.500"><Check size={12} /></Box><Text>Receipts (coming soon)</Text></HStack>
      </VStack>
      <Button size="sm" colorPalette="teal" w="full" onClick={onSignup}>
        Create a free account →
      </Button>
      <Text fontSize="2xs" color="fg.muted" textAlign="center" mt={1.5}>
        Already have one? <a href="/sign-in" style={{ color: "var(--chakra-colors-teal-600)", textDecoration: "underline" }}>Sign in</a>
      </Text>
    </Box>
  );
}
