---
name: reference-local-env-is-test-clerk
description: "apps/api/.env holds sk_test_ Clerk keys, so any script run locally mutates the TEST Clerk instance even when DATABASE_URL points at production. Prod Clerk keys live only in Vercel."
metadata:
  type: reference
---

# Local `.env` is TEST Clerk — even when the DB is production

`apps/api/.env` has `CLERK_SECRET_KEY="sk_test_…"` and `apps/web/.env` has
`pk_test_…`. The **production** Clerk keys exist only in Vercel's
environment variables.

**The trap:** a one-off script can point `DATABASE_URL` at production
(which is the normal way to query prod) while `createClerkClient()`
silently picks up the *test* secret from `.env`. Any Clerk call then hits
the wrong instance.

This bit during the Mark Baliff purge (2026-09-01): the script reported
`Clerk account … was already gone` because it asked the TEST instance
about a **production** Clerk id, which 404s trivially. The production
account was still live.

**How to check before trusting any Clerk result:**

```ts
console.log(process.env.CLERK_SECRET_KEY?.slice(0, 8)); // sk_test_ vs sk_live_
const list = await clerk.users.getUserList({ limit: 1 }); // prove the key works
```

A 404 only means something when you have first proven the key reaches the
instance you meant. Same reasoning applies to any external service
configured per-environment (R2 buckets, Twilio).

Related: [[project-mark-baliff-purge]], [[feedback-check-current-docs-before-diagnosing]].
