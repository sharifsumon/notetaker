/**
 * API client. Same-origin cookie session; state-changing requests carry the CSRF token
 * obtained from GET /api/v1/me. Errors are normalized from the server's error envelope.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request returns 401 so the app can route to sign-in. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; requestId?: string } }
    | null;
  if (!res.ok) {
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    throw new ApiError(
      res.status,
      data?.error?.code ?? "http_error",
      data?.error?.message ?? `Request failed (${res.status})`,
      data?.error?.requestId,
    );
  }
  return data as T;
}
