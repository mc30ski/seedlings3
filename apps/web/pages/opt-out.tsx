// Public opt-out landing page. No auth. Linked from every promotional
// email + SMS footer. Client types their own email or phone; server
// finds matching ClientContacts and flips both channel opt-out flags.
//
// Silent-success semantic — same "we've noted your request" message
// whether we matched a customer or not, so a bad actor can't probe
// customer status.

import Head from "next/head";
import { useState } from "react";
import { Box, Button, Container, Heading, Input, Stack, Text } from "@chakra-ui/react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export default function OptOutPage() {
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/api/public/promo/opt-out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim() }),
      });
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      setDone(true);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Head>
        <title>Opt out of promotional messages</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Box minH="100vh" bg="gray.50" py={{ base: 8, md: 16 }}>
        <Container maxW="md">
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            rounded="lg"
            p={{ base: 6, md: 8 }}
            shadow="sm"
          >
            {done ? (
              <>
                <Heading size="md" mb={3}>You&apos;ve been unsubscribed.</Heading>
                <Text color="fg.muted">
                  We&apos;ve stopped sending promotional messages to that
                  address. You&apos;ll still receive transactional messages
                  (invoices, receipts, appointment confirmations) as usual.
                </Text>
                <Text color="fg.muted" fontSize="sm" mt={4}>
                  Changed your mind? Contact us directly and we&apos;ll opt you
                  back in.
                </Text>
              </>
            ) : (
              <>
                <Heading size="md" mb={2}>Opt out of promotional messages</Heading>
                <Text color="fg.muted" fontSize="sm" mb={4}>
                  Enter the email address or phone number you&apos;re receiving
                  our promotional messages on. We&apos;ll stop sending
                  promotions to that address. Transactional messages (invoices,
                  receipts, appointment confirmations) will keep working
                  normally.
                </Text>
                <form onSubmit={submit}>
                  <Stack gap={3}>
                    <Input
                      size="md"
                      autoFocus
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="you@example.com or 864-555-1234"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={submitting}
                    />
                    <Button
                      type="submit"
                      colorPalette="blue"
                      loading={submitting}
                      disabled={!identifier.trim() || submitting}
                    >
                      Stop promotional messages
                    </Button>
                    {err && (
                      <Text color="red.600" fontSize="sm">
                        Couldn&apos;t submit — {err}. Please try again.
                      </Text>
                    )}
                  </Stack>
                </form>
              </>
            )}
          </Box>
        </Container>
      </Box>
    </>
  );
}
