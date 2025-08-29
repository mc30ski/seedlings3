const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

// Treat Vercel/Next production builds as prod
const IS_PROD = process.env.NODE_ENV === "production";

// Attach dev/mock headers ONLY in development
function authHeaders(h: Headers) {
  if (IS_PROD) return; // ⬅️ hard stop in prod

  if (typeof window !== "undefined") {
    // (optional) dev mock auth id
    const id = localStorage.getItem("dev_clerkUserId");
    if (id) h.set("Authorization", `Bearer dev-mock:${id}`);

    // dev-only role override
    const role = localStorage.getItem("seedlings3.devRole");
    if (role === "ADMIN" || role === "WORKER") {
      h.set("X-Dev-Role", role);
    }
  }
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  authHeaders(headers);

  const init: RequestInit = {
    method,
    headers,
    credentials: "include",
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

  return res.json() as Promise<T>;
}

export const apiGet = <T>(p: string) => request<T>("GET", p);
export const apiPost = <T>(p: string, b?: unknown) => request<T>("POST", p, b);
export const apiPatch = <T>(p: string, b?: unknown) =>
  request<T>("PATCH", p, b);
export const apiDelete = <T>(p: string) => request<T>("DELETE", p);
