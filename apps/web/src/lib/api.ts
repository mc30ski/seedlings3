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
    !!process.env.NEXT_PUBLIC_VERCEL_BYPASS_TOKEN
  );
}

function addBypassHeadersOnce(headers: Headers) {
  if (!shouldBypass() || vercelBypassTried) return;
  headers.set(
    "x-vercel-protection-bypass",
    process.env.NEXT_PUBLIC_VERCEL_BYPASS_TOKEN!
  );
  headers.set("x-vercel-set-bypass-cookie", "true");
  vercelBypassTried = true;
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  await authHeaders(headers); // your existing auth header(s)

  // Add the bypass headers on the first request in preview (only once)
  addBypassHeadersOnce(headers);

  const init: RequestInit = {
    method,
    headers,
    // you’re sending Authorization headers already
    credentials: "omit",
    cache: "no-store",
  };

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }

  // Build URL (if API_BASE is same-origin, good; if it’s a different preview domain,
  // you’ll also need to mint the cookie on that other domain once).
  const url = `${API_BASE}${path}`;

  // First attempt
  let res = await fetch(url, init);

  // If we got a 401 on preview, try once more *forcing* the bypass headers
  if (res.status === 401 && shouldBypass()) {
    // Add headers again in case first call didn’t include them yet
    headers.set(
      "x-vercel-protection-bypass",
      process.env.NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS!
    );
    headers.set("x-vercel-set-bypass-cookie", "true");

    // Optional cache-buster helps avoid any cached 401 page in front of the edge
    const retryUrl =
      url + (url.includes("?") ? "&" : "?") + `_cb=${Date.now()}`;

    res = await fetch(retryUrl, { ...init, headers });
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
