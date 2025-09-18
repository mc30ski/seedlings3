// apps/web/src/lib/api.ts
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

/** We let _app.tsx inject a function that returns a fresh Clerk token */
let fetchAuthToken: null | (() => Promise<string | null | undefined>) = null;
export function setAuthTokenFetcher(
  fn: () => Promise<string | null | undefined>
) {
  fetchAuthToken = fn;
}

/** Attach Authorization header if we have a token */
async function authHeaders(h: Headers) {
  if (fetchAuthToken) {
    try {
      const token = await fetchAuthToken();
      if (token) h.set("Authorization", `Bearer ${token}`);
    } catch {
      // ignore; we'll just call without auth
    }
  }
}

const IS_BROWSER = typeof window !== "undefined";
const IS_PREVIEW = process.env.NEXT_PUBLIC_VERCEL_ENV === "preview";
const BYPASS = process.env.NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS || "";

function makeAbsolute(url: string) {
  // Works both client and server
  if (!IS_BROWSER) return url; // assume absolute on server
  return new URL(url, window.location.origin).toString();
}
function isCrossOrigin(absUrl: string) {
  if (!IS_BROWSER) return false;
  return new URL(absUrl).origin !== window.location.origin;
}

// Put these at module scope so they persist across calls in the same session
let vercelBypassTried = false;

function isBrowser() {
  return typeof window !== "undefined";
}

function shouldBypass() {
  // Only in Preview, only in browser (cookies), and only if you have a token configured
  return (
    isBrowser() &&
    process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" &&
    !!process.env.NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS
  );
}

function addBypassHeadersOnce(headers: Headers) {
  if (!shouldBypass() || vercelBypassTried) return;
  headers.set(
    "x-vercel-protection-bypass",
    process.env.NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS!
  );
  headers.set("x-vercel-set-bypass-cookie", "true");
  vercelBypassTried = true;
}

export async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  await authHeaders(headers); // your existing auth (e.g., Authorization)

  // Build the absolute URL we’ll call
  const url = makeAbsolute(`${API_BASE}${path}`);
  const cross = isCrossOrigin(url);

  // IMPORTANT: let the browser send/receive cookies for Vercel preview protection
  // - same-origin for same host
  // - include for cross-origin (another preview domain)
  const init: RequestInit = {
    method,
    headers,
    credentials: cross ? "include" : "same-origin", // ← change from "omit"
    cache: "no-store",
  };

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }

  // Add Vercel preview-bypass headers (recommended by Vercel)
  // These are harmless in prod and ensure the cookie gets minted if missing.
  if (IS_BROWSER && IS_PREVIEW && BYPASS) {
    headers.set("x-vercel-protection-bypass", BYPASS);
    // If the API is on a different preview domain, instruct Vercel to set SameSite=None
    headers.set("x-vercel-set-bypass-cookie", cross ? "samesitenone" : "true");
  }

  // First attempt
  let res = await fetch(url, init);

  // If protection still blocked us (e.g., cached edge page), retry once with a cache buster
  if (res.status === 401 && IS_BROWSER && IS_PREVIEW && BYPASS) {
    const retryUrl =
      url + (url.includes("?") ? "&" : "?") + `_cb=${Date.now()}`;
    res = await fetch(retryUrl, init);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const data = await res.clone().json();
      message = data?.message || message;
      code = data?.code;
    } catch {
      try {
        message = await res.text();
      } catch {}
    }
    const err = new Error(message) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    if (code) err.code = code;
    throw err;
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const apiGet = <T>(p: string) => request<T>("GET", p);
export const apiPost = <T>(p: string, b?: unknown) => request<T>("POST", p, b);
export const apiPatch = <T>(p: string, b?: unknown) =>
  request<T>("PATCH", p, b);
export const apiDelete = <T>(p: string) => request<T>("DELETE", p);
