import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Super client "View as" e2e tests. Runs under the `super` project so we
 * have Michael's storage state (SUPER + ADMIN + WORKER roles).
 *
 * Fetches run inside the browser via page.evaluate so Clerk's session
 * token is attached as Bearer automatically — plain `page.request.get`
 * doesn't have access to Clerk's token generator from a Node context.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Invoke a real API call from inside the browser page. Attaches the
 *  Clerk session token as Bearer, and optionally sets the client-
 *  impersonation header. Returns { status, body } (body JSON-parsed when
 *  possible). */
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
  // Wait for Clerk to hydrate — otherwise session.getToken() returns
  // null and the API call goes out with an empty Bearer, causing a 401.
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

test.describe("Client View-As: positive path", () => {
  test("Super's GET /api/client/me returns the impersonated contact's client data", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs Positive Client",
      contacts: [{ firstName: "Primary", lastName: "Contact", isPrimary: true }],
    });
    try {
      await page.goto("/");
      const res = await callApi(page, {
        method: "GET",
        path: "/api/client/me",
        impersonateContact: scratch.contactIds[0],
      });
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).toContain("E2E ViewAs Positive Client");
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});

test.describe("Client View-As: read-only enforcement", () => {
  test("POST while impersonating returns 403 with IMPERSONATION_READONLY", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs Readonly Client",
      contacts: [{ firstName: "Readonly", lastName: "Contact", isPrimary: true }],
    });
    try {
      await page.goto("/");
      const res = await callApi(page, {
        method: "POST",
        path: "/api/client/link",
        impersonateContact: scratch.contactIds[0],
      });
      expect(res.status).toBe(403);
      const body = res.body as { code?: string; message?: string } | null;
      expect(body?.code ?? body?.message ?? "").toContain("IMPERSONATION_READONLY");
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});

test.describe("Client View-As: impersonatable-contacts endpoint", () => {
  test("returns clerk-linked and non-clerk contacts with correct hasClerkAccount flags", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs Multi Contact",
      contacts: [
        { firstName: "Primary", lastName: "Person", isPrimary: true },
        { firstName: "Secondary", lastName: "Person" },
        { firstName: "NoLogin", lastName: "Person", clerkUserId: null },
      ],
    });
    try {
      await page.goto("/");
      const res = await callApi(page, {
        method: "GET",
        path: `/api/admin/clients/${scratch.clientId}/impersonatable-contacts`,
      });
      expect(res.status).toBe(200);
      const body = res.body as { clientId: string; contacts: Array<{ firstName: string; isPrimary: boolean; hasClerkAccount: boolean }> };
      expect(body.clientId).toBe(scratch.clientId);
      expect(Array.isArray(body.contacts)).toBe(true);
      expect(body.contacts.length).toBe(3);

      // Primary sorted first.
      expect(body.contacts[0].isPrimary).toBe(true);
      expect(body.contacts[0].firstName).toBe("Primary");
      expect(body.contacts[0].hasClerkAccount).toBe(true);

      // Non-clerk contact still returned but flag reflects that.
      const noLogin = body.contacts.find((c) => c.firstName === "NoLogin");
      expect(noLogin).toBeTruthy();
      expect(noLogin?.hasClerkAccount).toBe(false);
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});

test.describe("Client View-As: invalid target", () => {
  test("impersonating a contact ID that doesn't exist returns 400 IMPERSONATION_TARGET_INVALID", async ({ page }) => {
    await page.goto("/");
    const res = await callApi(page, {
      method: "GET",
      path: "/api/client/me",
      impersonateContact: "bogusnonexistentcontactid",
    });
    expect(res.status).toBe(400);
    const body = res.body as { code?: string; message?: string } | null;
    expect(body?.code ?? body?.message ?? "").toContain("IMPERSONATION_TARGET_INVALID");
  });

  test("impersonating a contact without a Clerk account returns 400 IMPERSONATION_TARGET_INVALID", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs No Account",
      contacts: [{ firstName: "NoLogin", lastName: "OnlyContact", clerkUserId: null }],
    });
    try {
      await page.goto("/");
      const res = await callApi(page, {
        method: "GET",
        path: "/api/client/me",
        impersonateContact: scratch.contactIds[0],
      });
      expect(res.status).toBe(400);
      const body = res.body as { code?: string; message?: string } | null;
      expect(body?.code ?? body?.message ?? "").toContain("IMPERSONATION_TARGET_INVALID");
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});
