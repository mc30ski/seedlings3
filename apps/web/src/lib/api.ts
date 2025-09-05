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

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  await authHeaders(headers);

  const init: RequestInit = {
    method,
    headers,
    // we use header auth; no cookies needed
    credentials: "omit",
    cache: "no-store",
  };

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, init);

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

  // some endpoints may 204/no-content; guard that
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const apiGet = <T>(p: string) => request<T>("GET", p);
export const apiPost = <T>(p: string, b?: unknown) => request<T>("POST", p, b);
export const apiPatch = <T>(p: string, b?: unknown) =>
  request<T>("PATCH", p, b);
export const apiDelete = <T>(p: string) => request<T>("DELETE", p);
