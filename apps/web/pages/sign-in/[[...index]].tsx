"use client";

import { useEffect, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/clerk-react";
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
 *
 * Pages-Router SSR note: `useSignIn` / `useSignUp` assert ClerkProvider
 * context at call time. During Next's static export the assertion fails
 * (the provider hasn't initialized server-side), which breaks the build.
 * We wrap the actual form in a mounted-gate component so the hook calls
 * only happen after the client hydrates.
 */
export default function SignInPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center" bg="gray.50" p={4}>
      <VStack gap={4} maxW="md" w="full">
        <Heading size="lg" textAlign="center">Welcome to Seedlings</Heading>
        {mounted ? <SignInForm /> : <SignInPlaceholder />}
      </VStack>
    </Box>
  );
}

function SignInPlaceholder() {
  return (
    <Text fontSize="sm" color="fg.muted" textAlign="center">
      Loading…
    </Text>
  );
}

function SignInForm() {
  const { signIn, setActive: setActiveSignIn, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setActiveSignUp, isLoaded: signUpLoaded } = useSignUp();

  // Steps:
  //   email → user enters email; we send a code via sign-in or sign-up
  //   code  → user enters the code; if signup completes, redirect; if Clerk
  //           returns missing_requirements (e.g. first_name/last_name we
  //           couldn't prefill), advance to the `name` step
  //   name  → collect first/last name and call signUp.update to complete
  const [step, setStep] = useState<"email" | "code" | "name">("email");
  const [mode, setMode] = useState<"signin" | "signup" | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill email + name from the /pay/[token] AccountNudge — stashed in
  // sessionStorage right before the redirect, consumed here once. The
  // name fields satisfy Clerk's User-model requirements without prompting
  // the client to re-enter info we already have on the ClientContact.
  useEffect(() => {
    try {
      const e = sessionStorage.getItem("seedlings_prefill_email");
      const fn = sessionStorage.getItem("seedlings_prefill_firstName");
      const ln = sessionStorage.getItem("seedlings_prefill_lastName");
      if (e) {
        setEmail(e);
        sessionStorage.removeItem("seedlings_prefill_email");
      }
      if (fn) {
        setFirstName(fn);
        sessionStorage.removeItem("seedlings_prefill_firstName");
      }
      if (ln) {
        setLastName(ln);
        sessionStorage.removeItem("seedlings_prefill_lastName");
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
    // Fall back to sign-up for a brand-new email. Pass first/last name
    // upfront when we have them (typically prefilled from the /pay nudge)
    // so the signup completes in one step. Clerk silently ignores fields
    // it doesn't need.
    try {
      const createPayload: any = { emailAddress: cleanEmail };
      if (firstName.trim()) createPayload.firstName = firstName.trim();
      if (lastName.trim()) createPayload.lastName = lastName.trim();
      await signUp!.create(createPayload);
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
        // Sign-in only has email_code as a factor here; anything other
        // than "complete" usually means a second factor or unexpected
        // gate is configured in the Clerk dashboard.
        setError(
          `Sign-in needs an extra step that isn't configured here (status: ${result.status}). ` +
            `Contact an admin.`,
        );
      } else if (mode === "signup") {
        const result = await signUp!.attemptEmailAddressVerification({
          code: code.trim(),
        });
        if (result.status === "complete") {
          await setActiveSignUp!({ session: result.createdSessionId });
          window.location.href = "/";
          return;
        }
        // Email verified but the signup isn't complete — almost always
        // because Clerk requires first_name / last_name on the User
        // model. Two paths:
        //   a) We have prefilled names (most clients arrive from /pay
        //      with these set): apply them via signUp.update and finish
        //      without a second prompt.
        //   b) No prefill (worker self-signup, direct visit): advance to
        //      the `name` step to collect them in the UI.
        const missingFields: string[] = (result as any).missingFields ?? [];
        const needsName =
          missingFields.includes("first_name") || missingFields.includes("last_name");
        if (needsName && firstName.trim() && lastName.trim()) {
          try {
            const updated = await signUp!.update({
              firstName: firstName.trim(),
              lastName: lastName.trim(),
            });
            if (updated.status === "complete") {
              await setActiveSignUp!({ session: updated.createdSessionId });
              window.location.href = "/";
              return;
            }
            // Still incomplete — fall through to the name step in case
            // Clerk surfaced new missingFields we didn't anticipate.
          } catch (err: any) {
            setError(
              err?.errors?.[0]?.message ?? err?.message ?? "Couldn't finalize signup.",
            );
            return;
          }
        }
        if (needsName) {
          setStep("name");
          return;
        }
        // Some other requirement we don't handle — surface it verbatim.
        const unverifiedFields: string[] = (result as any).unverifiedFields ?? [];
        const detail =
          missingFields.length > 0
            ? `Missing fields: ${missingFields.join(", ")}. `
            : unverifiedFields.length > 0
              ? `Unverified fields: ${unverifiedFields.join(", ")}. `
              : "";
        setError(
          `Sign-up needs more information than this page collects (status: ${result.status}). ${detail}` +
            `Contact the admin.`,
        );
      }
    } catch (err: any) {
      // Distinguish a network failure (transient — retry helps) from a
      // bad code (user-actionable).
      const clerkMsg = err?.errors?.[0]?.message;
      const isNetwork =
        err?.message === "Load failed" ||
        /network/i.test(err?.message ?? "") ||
        err?.name === "ClerkNetworkError";
      if (isNetwork) {
        setError("Network hiccup talking to the auth service. Tap the button again.");
      } else {
        setError(clerkMsg ?? err?.message ?? "Invalid code. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await signUp!.update({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });
      if (updated.status === "complete") {
        await setActiveSignUp!({ session: updated.createdSessionId });
        window.location.href = "/";
        return;
      }
      const missingFields: string[] = (updated as any).missingFields ?? [];
      setError(
        missingFields.length > 0
          ? `Still missing: ${missingFields.join(", ")}. Contact the admin.`
          : `Sign-up didn't complete (status: ${updated.status}). Contact the admin.`,
      );
    } catch (err: any) {
      setError(err?.errors?.[0]?.message ?? err?.message ?? "Couldn't finalize signup.");
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
    <>
      {step === "email" && (
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
      )}
      {step === "code" && (
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
      {step === "name" && (
        <>
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            One last thing — what should we call you?
          </Text>
          <Box
            as="form"
            onSubmit={handleNameSubmit}
            w="full"
            bg="white"
            p={6}
            rounded="lg"
            boxShadow="0 4px 24px rgba(0,0,0,0.06)"
          >
            <VStack gap={3} align="stretch">
              <Input
                type="text"
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                size="lg"
                autoFocus
                autoComplete="given-name"
              />
              <Input
                type="text"
                placeholder="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                size="lg"
                autoComplete="family-name"
              />
              {error && (
                <Text fontSize="xs" color="red.600">{error}</Text>
              )}
              <Button
                type="submit"
                loading={busy}
                disabled={!firstName.trim() || !lastName.trim()}
                colorPalette="teal"
                size="lg"
                w="full"
              >
                Finish signing up
              </Button>
            </VStack>
          </Box>
        </>
      )}
    </>
  );
}
