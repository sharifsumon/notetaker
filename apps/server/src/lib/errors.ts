/**
 * Application errors with a stable `code` and HTTP status. The central error handler
 * converts these into the consistent error envelope `{ error: { code, message, requestId } }`.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  badRequest: (message = "Invalid request", details?: unknown) =>
    new AppError(400, "bad_request", message, details),
  validation: (details: unknown) => new AppError(400, "validation_error", "Request validation failed", details),
  unauthenticated: () => new AppError(401, "unauthenticated", "Authentication required"),
  forbidden: (message = "You do not have permission to perform this action") =>
    new AppError(403, "forbidden", message),
  csrf: () => new AppError(403, "csrf_failed", "CSRF validation failed"),
  /** Same response for "missing" and "belongs to someone else" to avoid existence leaks. */
  notFound: (what = "Resource") => new AppError(404, "not_found", `${what} not found`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  unprocessable: (code: string, message: string) => new AppError(422, code, message),
  rateLimited: () => new AppError(429, "rate_limited", "Too many requests, please try again later"),
  notConfigured: (what: string) => new AppError(503, "not_configured", `${what} is not configured on this server`),
  unavailable: (message = "Service temporarily unavailable") => new AppError(503, "unavailable", message),
};

/** Error raised by external providers. `retryable` drives job retry decisions. */
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Errors that must not be retried (bad input, unsupported media, etc.). */
export class PermanentJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentJobError";
  }
}
