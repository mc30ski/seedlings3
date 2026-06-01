import { sleep } from "@/src/lib/lib";

// Introduce delay for debugging
const DELAY = 0;
//const DELAY = 1500;

// Introduce error for any API call for debuggin
const ERROR = false;
//const ERROR = true;

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

// Super-only "View as another role" header. Read on every API call so a
// toggle from the View-as menu takes effect immediately for subsequent
// requests. The backend silently ignores the header unless the underlying
// user is actually SUPER, so a non-Super browser sending a forged value is
// a no-op — but we still only emit it when we have a value stored locally.
const IMPERSONATE_STORAGE_KEY = "seedlings_impersonateAs";
function attachImpersonateHeader(h: Headers) {
  if (!IS_BROWSER) return;
  try {
    const val = localStorage.getItem(IMPERSONATE_STORAGE_KEY);
    if (val) h.set("X-Impersonate-As", val);
  } catch {
    // localStorage can throw in private mode / disabled storage; just skip.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Super-only "Reveal Pre-Cutoff" header — transient session-only override of
// the Business Start Date filter. Intentionally NOT persisted in localStorage:
// a page reload always reverts to the filtered view so the operator can't
// forget the toggle is on. See apps/api/src/lib/businessStartCutoff.ts.
//
// The server gates on the caller's REAL role (post-impersonation Super) so a
// non-Super browser sending a forged value is a no-op. The module-level
// boolean is set by setRevealPreCutoff() from the React Context provider.
// ─────────────────────────────────────────────────────────────────────────────
let revealPreCutoff = false;
const revealListeners = new Set<(v: boolean) => void>();

export function setRevealPreCutoff(v: boolean) {
  if (revealPreCutoff === v) return;
  revealPreCutoff = v;
  // Notify any context provider so React state can update too.
  for (const l of revealListeners) l(v);
}

export function getRevealPreCutoff(): boolean {
  return revealPreCutoff;
}

export function subscribeRevealPreCutoff(fn: (v: boolean) => void): () => void {
  revealListeners.add(fn);
  return () => revealListeners.delete(fn);
}

function attachRevealPreCutoffHeader(h: Headers) {
  // Only emit when the toggle is on. Browsers running a non-Super session
  // can still set this true; the server ignores it for non-Super callers.
  if (revealPreCutoff) h.set("X-Reveal-Pre-Cutoff", "true");
}

// Bypass is used to avoid the blocking (401) of Preview requests.
// Vercel’s preview deployments require a valid _vercel_jwt cookie or the x-vercel-protection-bypass header on every request.

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

export async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  if (DELAY) {
    await sleep(DELAY);
  }
  if (!path.endsWith("/me") && ERROR) {
    throw new Error("This is a DEBUG error.");
  }

  const headers = new Headers();
  await authHeaders(headers); // your existing auth (e.g., Authorization)
  attachImpersonateHeader(headers);
  attachRevealPreCutoffHeader(headers);

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
export const apiPut = <T>(p: string, b?: unknown) => request<T>("PUT", p, b);
export const apiPatch = <T>(p: string, b?: unknown) =>
  request<T>("PATCH", p, b);
export const apiDelete = <T>(p: string) => request<T>("DELETE", p);

/**
 * Authenticated download helper for non-JSON responses (CSV, files).
 * Fetches the URL with the same auth/credentials as request(), then triggers
 * a browser download via an anchor click. Throws on HTTP error.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  await authHeaders(headers);
  attachImpersonateHeader(headers);
  attachRevealPreCutoffHeader(headers);
  const url = makeAbsolute(`${API_BASE}${path}`);
  const cross = isCrossOrigin(url);
  if (IS_BROWSER && IS_PREVIEW && BYPASS) {
    headers.set("x-vercel-protection-bypass", BYPASS);
    headers.set("x-vercel-set-bypass-cookie", cross ? "samesitenone" : "true");
  }
  const res = await fetch(url, {
    method: "GET",
    headers,
    credentials: cross ? "include" : "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json())?.message || message; } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}
