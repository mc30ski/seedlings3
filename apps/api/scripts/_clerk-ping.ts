import "dotenv/config";
import { verifyToken, createClerkClient } from "@clerk/backend";

// This exercises the EXACT same two Clerk API calls that /api/me makes:
//   1. verifyToken(...) — validates a JWT (network round-trip to Clerk)
//   2. clerk.users.getUser(...) — fetches user profile (network round-trip)
//
// We use an obviously-invalid token so verifyToken will REJECT — but the
// rejection still goes through a full network round-trip to Clerk. That
// round-trip latency is what /api/me pays on every request.
//
// For getUser we hit a bogus user id — Clerk returns 404, but again after
// a real round-trip that measures its API responsiveness.

const CLERK_SECRET = process.env.CLERK_SECRET_KEY!;
const clerk = createClerkClient({ secretKey: CLERK_SECRET });

async function pingVerify(label: string) {
  const start = Date.now();
  try {
    await verifyToken("this.is.not.a.real.token", { secretKey: CLERK_SECRET });
    console.log(`  ${label.padEnd(14)}  ${Date.now() - start}ms  (unexpectedly succeeded)`);
  } catch (err: any) {
    console.log(`  ${label.padEnd(14)}  ${Date.now() - start}ms  rejected: ${err?.reason ?? err?.message?.slice(0, 60)}`);
  }
}

async function pingGetUser(label: string) {
  const start = Date.now();
  try {
    await clerk.users.getUser("user_notarealclerkid");
    console.log(`  ${label.padEnd(14)}  ${Date.now() - start}ms  (unexpectedly succeeded)`);
  } catch (err: any) {
    console.log(`  ${label.padEnd(14)}  ${Date.now() - start}ms  rejected: ${(err?.errors?.[0]?.message ?? err?.message ?? "").slice(0, 80)}`);
  }
}

(async () => {
  console.log("Pinging Clerk API. Each call is one network round-trip.");
  console.log("Healthy = <200ms. If any of these hang or take seconds, that's the culprit.");
  console.log("");
  console.log("verifyToken:");
  for (let i = 1; i <= 10; i++) {
    await pingVerify(`verifyToken ${i}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("");
  console.log("clerk.users.getUser:");
  for (let i = 1; i <= 10; i++) {
    await pingGetUser(`getUser ${i}`);
    await new Promise((r) => setTimeout(r, 500));
  }
})();
