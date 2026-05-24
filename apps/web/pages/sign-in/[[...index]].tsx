"use client";

import { useEffect, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";
import {
  Box,
  Button,
  Heading,
  Input,
  Text,
  VStack,
} from "@chakra-ui/react";

/**
 * Unified passwordless sign-in / sign-up page.
 *
 * The Clerk `<SignIn>` component only handles existing accounts — new
 * emails get "Couldn't find your account". For the client-facing flow
 * linked from /pay/[token], we want a single step: enter email → get
 * code → verify → signed in, whether the user is new or returning.
 *
 * Implementation: try `signIn.create` first; on `form_identifier_not_found`
 * fall back to `signUp.create`. From the user's perspective it's one
 * email + one code prompt either way.
 *
 * Clerk dashboard requirements:
 *   - "Email verification code" enabled for both sign-in and sign-up
 *   - Email-link option OFF (we want the typed-code flow only)
 */
export default function SignInPage() {
  const { signIn, setActive: setActiveSignIn, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setActiveSignUp, isLoaded: signUpLoaded } = useSignUp();

  const [step, setStep] = useState<"email" | "code">("email");
  const [mode, setMode] = useState<"signin" | "signup" | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill email from the /pay/[token] AccountNudge — stashed in
  // sessionStorage right before the redirect, consumed here once. Biases
  // the client toward the on-file email so the post-signup auto-link
  // succeeds without manual reconciliation.
  useEffect(() => {
    try {
      const e = sessionStorage.getItem("seedlings_prefill_email");
      if (e) {
        setEmail(e);
        sessionStorage.removeItem("seedlings_prefill_email");
      }
    } catch {}
  }, []);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !signInLoaded || !signUpLoaded) return;
    setBusy(true);
    setError(null);
    const cleanEmail = email.trim();
    try {
      // Try sign-in first. For an existing account, this returns the list
      // of first-factor strategies; we then prepare email_code to send
      // the verification code to the on-file address.
      const result = await signIn!.create({ identifier: cleanEmail });
      const emailFactor = result.supportedFirstFactors?.find(
        (f: any) => f.strategy === "email_code",
      ) as any;
      if (!emailFactor) {
        throw new Error("Email-code sign-in isn't enabled. Contact the admin.");
      }
      await signIn!.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: emailFactor.emailAddressId,
      });
      setMode("signin");
      setStep("code");
      setBusy(false);
      return;
    } catch (err: any) {
      const code = err?.errors?.[0]?.code;
      const notFound =
        code === "form_identifier_not_found" || code === "form_param_format_invalid";
      if (!notFound) {
        setError(err?.errors?.[0]?.message ?? err?.message ?? "Couldn't send code. Try again.");
        setBusy(false);
        return;
      }
    }
    // Fall back to sign-up for a brand-new email.
    try {
      await signUp!.create({ emailAddress: cleanEmail });
      await signUp!.prepareEmailAddressVerification({ strategy: "email_code" });
      setMode("signup");
      setStep("code");
    } catch (err: any) {
      setError(err?.errors?.[0]?.message ?? err?.message ?? "Couldn't send code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        const result = await signIn!.attemptFirstFactor({
          strategy: "email_code",
          code: code.trim(),
        });
        if (result.status === "complete") {
          await setActiveSignIn!({ session: result.createdSessionId });
          window.location.href = "/";
          return;
        }
        setError("Verification didn't complete. Try the code again or use a different email.");
      } else if (mode === "signup") {
        const result = await signUp!.attemptEmailAddressVerification({
          code: code.trim(),
        });
        if (result.status === "complete") {
          await setActiveSignUp!({ session: result.createdSessionId });
          window.location.href = "/";
          return;
        }
        setError("Verification didn't complete. Try the code again or use a different email.");
      }
    } catch (err: any) {
      setError(err?.errors?.[0]?.message ?? err?.message ?? "Invalid code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function resetToEmail() {
    setStep("email");
    setCode("");
    setError(null);
    setMode(null);
  }

  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center" bg="gray.50" p={4}>
      <VStack gap={4} maxW="md" w="full">
        <Heading size="lg" textAlign="center">Welcome to Seedlings</Heading>
        {step === "email" ? (
          <>
            <Text fontSize="sm" color="fg.muted" textAlign="center">
              Enter your email — we&apos;ll send you a verification code to type in.
              New here or returning, it&apos;s the same step.
            </Text>
            <Box
              as="form"
              onSubmit={handleEmailSubmit}
              w="full"
              bg="white"
              p={6}
              rounded="lg"
              boxShadow="0 4px 24px rgba(0,0,0,0.06)"
            >
              <VStack gap={3} align="stretch">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  size="lg"
                  autoFocus
                  autoComplete="email"
                />
                {error && (
                  <Text fontSize="xs" color="red.600">{error}</Text>
                )}
                <Button
                  type="submit"
                  loading={busy}
                  disabled={!email.trim() || !signInLoaded || !signUpLoaded}
                  colorPalette="teal"
                  size="lg"
                  w="full"
                >
                  Send verification code
                </Button>
              </VStack>
            </Box>
          </>
        ) : (
          <>
            <Text fontSize="sm" color="fg.muted" textAlign="center">
              We sent a 6-digit code to <b>{email}</b>. Enter it below.
            </Text>
            <Box
              as="form"
              onSubmit={handleCodeSubmit}
              w="full"
              bg="white"
              p={6}
              rounded="lg"
              boxShadow="0 4px 24px rgba(0,0,0,0.06)"
            >
              <VStack gap={3} align="stretch">
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  size="lg"
                  autoFocus
                  textAlign="center"
                  fontSize="2xl"
                  letterSpacing="0.4em"
                />
                {error && (
                  <Text fontSize="xs" color="red.600">{error}</Text>
                )}
                <Button
                  type="submit"
                  loading={busy}
                  disabled={!code.trim()}
                  colorPalette="teal"
                  size="lg"
                  w="full"
                >
                  {mode === "signup" ? "Create account" : "Sign in"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={resetToEmail}
                  disabled={busy}
                >
                  Use a different email
                </Button>
              </VStack>
            </Box>
          </>
        )}
      </VStack>
    </Box>
  );
}
