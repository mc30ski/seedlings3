import type { Page } from "@playwright/test";

/**
 * Call the API from inside the page with the SAME auth the app uses.
 *
 * A bare fetch() gets 401: apps/web/src/lib/api.ts attaches a Clerk bearer
 * token rather than relying on cookies. Reading the ACTUAL response is
 * usually the point of these tests — a DOM-only assertion would still
 * pass if the server sent content it shouldn't and the client merely
 * declined to render it.
 *
 * WHY THE TOKEN WAIT: `waitForLoadState("networkidle")` can settle before
 * Clerk has finished hydrating `window.Clerk.session`. When it does,
 * `getToken()` returns undefined, the request goes out anonymous, and the
 * assertion fails with a 401 that reads exactly like an access-control
 * bug. That was an intermittent failure across all three guides specs —
 * each of which had its own copy of this function, so the fix had to be
 * made three times or not at all. Hence one shared helper.
 */
export async function apiAs(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ({ m, p, b }: { m: string; p: string; b?: unknown }) => {
      const deadline = Date.now() + 15_000;
      let token: string | undefined;
      for (;;) {
        token = await (window as any).Clerk?.session?.getToken?.();
        if (token || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const r = await fetch(p, {
        method: m,
        credentials: "include",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(b ? { "Content-Type": "application/json" } : {}),
        },
        ...(b ? { body: JSON.stringify(b) } : {}),
      });
      let json: any = null;
      try {
        json = await r.json();
      } catch {
        /* non-JSON error body */
      }
      return { status: r.status, json };
    },
    { m: method, p: path, b: body },
  );
}
