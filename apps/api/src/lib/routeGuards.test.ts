/**
 * THE ONLY PATH.
 *
 * This file used to test a switch: `requires(entitlement, legacyRole)` ran
 * either the role check or the entitlement check depending on
 * `ENTITLEMENTS_ENABLED`, and both directions needed exercising so the
 * unused one could not rot before the day it was turned on.
 *
 * That day came and the flag is gone. What matters now is narrower and
 * sharper: the guard asks `can()` and nothing else, it resolves approval
 * FIRST (because that is what populates the principal), and it fails closed
 * on anything missing.
 */
import { describe, it, expect } from "vitest";
import type { Principal } from "@repo/permissions";
import { makeGuards } from "./routeGuards";

type Call = { approved?: boolean };

/** Minimal Fastify stand-in: records what ran, in order. */
function fakeApp(calls: Call[]) {
  return {
    requireApproved: async () => {
      calls.push({ approved: true });
    },
    httpErrors: {
      forbidden: (msg: string) => Object.assign(new Error(msg), { statusCode: 403 }),
    },
  } as never;
}

const holder = (...entitlements: string[]): Principal => ({
  kind: "user",
  workerType: "EMPLOYEE",
  roles: [{ roleId: "r1", name: "Test", entitlements: entitlements as never }],
  perspective: null,
});

/**
 * Every refusal must carry BOTH the machine code and the entitlement that
 * was missing. Asserting on the message is what these used to do, and it
 * silently passed when the message WAS the machine word — which is exactly
 * what the web app then showed the user.
 */
async function expectRefusal(
  run: Promise<unknown>,
  entitlement: string,
): Promise<void> {
  const err = await run.then(
    () => null,
    (e) => e as { code?: string; statusCode?: number; details?: { entitlement?: string } },
  );
  expect({
    code: err?.code,
    status: err?.statusCode,
    entitlement: err?.details?.entitlement,
  }).toEqual({ code: "NOT_AUTHORIZED", status: 403, entitlement });
}

describe("requires(entitlement)", () => {
  it("resolves approval, then allows a holder", async () => {
    const calls: Call[] = [];
    const g = makeGuards(fakeApp(calls));
    const req = { principal: holder("notify.send") } as never;

    await g.requires("notify.send").preHandler(req, {} as never);

    // Approval ran, and nothing else was consulted.
    expect(calls).toEqual([{ approved: true }]);
  });

  it("refuses someone who does not hold it", async () => {
    const g = makeGuards(fakeApp([]));
    const req = { principal: holder("schedule.view") } as never;
    await expectRefusal(
      g.requires("books.manage").preHandler(req, {} as never),
      "books.manage",
    );
  });

  it("fails closed when no principal was attached", async () => {
    // A route reachable without the rbac plugin having run must refuse, not
    // wave the request through on a missing object.
    const g = makeGuards(fakeApp([]));
    await expectRefusal(
      g.requires("schedule.view").preHandler({} as never, {} as never),
      "schedule.view",
    );
  });

  it("refuses a user with no worker type, however many roles they hold", async () => {
    // The payroll gate, reached through the guard rather than can() directly:
    // being in the system is not being cleared to act in it.
    const g = makeGuards(fakeApp([]));
    const pending: Principal = {
      kind: "user",
      workerType: null,
      roles: [{ roleId: "r1", name: "Owner", entitlements: ["books.manage"] as never }],
      perspective: null,
    };
    await expectRefusal(
      g.requires("books.manage").preHandler({ principal: pending } as never, {} as never),
      "books.manage",
    );
  });

  it("honours an active perspective — a narrowed perspective cannot act widely", async () => {
    const g = makeGuards(fakeApp([]));
    const narrowed: Principal = {
      ...(holder("books.manage", "schedule.view") as Extract<Principal, { kind: "user" }>),
      perspective: { roleId: "r-field", entitlements: ["schedule.view"] as never },
    };
    await expectRefusal(
      g.requires("books.manage").preHandler({ principal: narrowed } as never, {} as never),
      "books.manage",
    );
    // ...and still permits what the perspective does include.
    await g.requires("schedule.view").preHandler({ principal: narrowed } as never, {} as never);
  });

  it("the SYSTEM principal passes — cron and pay links hold no roles", async () => {
    const g = makeGuards(fakeApp([]));
    const sys: Principal = { kind: "system", name: "cron:chain-rollover" };
    await g.requires("money.approve").preHandler({ principal: sys } as never, {} as never);
  });
});

describe("approvedUser", () => {
  it("requires approval and asks for no capability", async () => {
    // OWNERSHIP routes: signed in and approved, then the handler scopes its
    // own query to the caller. There is no entitlement to hold, which is why
    // this is not expressed as one.
    const calls: Call[] = [];
    const g = makeGuards(fakeApp(calls));
    await g.approvedUser.preHandler({} as never, {} as never);
    expect(calls).toEqual([{ approved: true }]);
  });
});
