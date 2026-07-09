import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression guard for the security posture of client view-as. Runs
 * under the `employee` project (a non-Super storage state).
 *
 * A non-Super sending a forged `X-Impersonate-Client-Contact` header
 * must be silently ignored — the plugin never applies the swap for
 * non-Super callers, and it does not 4xx (so the feature's existence
 * isn't leaked via a status code).
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Same fetch-in-browser pattern as the admin spec, so Clerk's session
 *  token is attached via Bearer automatically. */
async function callApi(
  page: Page,
  opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    impersonateContact?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
  await page.waitForFunction(() => {
    const c = (window as unknown as { Clerk?: { session?: unknown } }).Clerk;
    return !!c?.session;
  }, { timeout: 15_000 });
  return page.evaluate(async (arg) => {
    const clerk = (window as unknown as { Clerk?: { session?: { getToken(): Promise<string | null> } } }).Clerk;
    const token = (await clerk?.session?.getToken?.()) ?? "";
    const base = arg.apiBase;
    const o = arg.opts;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (o.impersonateContact) {
      headers["X-Impersonate-Client-Contact"] = o.impersonateContact;
    }
    const res = await fetch(`${base}${o.path}`, {
      method: o.method,
      headers,
      credentials: "include",
      body: o.method === "GET" ? undefined : JSON.stringify(o.body ?? {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep as text */
    }
    return { status: res.status, body: parsed };
  }, { apiBase, opts });
}

test.describe("Client View-As: non-Super sending the header is silently ignored", () => {
  test("Employee sending X-Impersonate-Client-Contact does NOT gain access to client data", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E Security Scratch Client",
      contacts: [{ firstName: "Test", lastName: "Contact", isPrimary: true }],
    });
    try {
      await page.goto("/");

      // Baseline: without the header, Employee is not a client, so the
      // endpoint returns some non-2xx.
      const baseline = await callApi(page, { method: "GET", path: "/api/client/me" });

      // With the forged header, the response must be identical to the
      // baseline. The impersonation plugin sees a non-SUPER caller and
      // silently ignores the header.
      const forged = await callApi(page, {
        method: "GET",
        path: "/api/client/me",
        impersonateContact: scratch.contactIds[0],
      });
      expect(forged.status).toBe(baseline.status);

      // Whatever body the baseline returned, the forged version must
      // NOT leak the scratch client's displayName.
      const forgedBody = JSON.stringify(forged.body);
      expect(forgedBody).not.toContain("E2E Security Scratch Client");
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });

  test("Employee's non-GET with the forged header is NOT elevated to 403 IMPERSONATION_READONLY", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E Security POST Client",
      contacts: [{ firstName: "Test", lastName: "Contact", isPrimary: true }],
    });
    try {
      await page.goto("/");
      const res = await callApi(page, {
        method: "POST",
        path: "/api/client/link",
        impersonateContact: scratch.contactIds[0],
      });
      // We don't care about the exact status — only that it's NOT
      // the impersonation 403. If the plugin misfired for a non-Super,
      // we'd see code=IMPERSONATION_READONLY.
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain("IMPERSONATION_READONLY");
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});
