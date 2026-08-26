/** Request and stream error shapes shared by the chat UI. */

export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

// Read the status off the error shape rather than with `instanceof`: the class
// identity does not survive a module reload, and a stale identity would
// silently downgrade an auth failure to a generic error banner.
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

// A streamed failure arrives inside an HTTP 200, so its status travels in the
// frame body instead of the response line. Keep it on the resulting error so
// callers can still tell an expired key from a transient stream fault.
export function errorFromData(data: string, fallback: string): Error {
  if (!data) return new Error(fallback);
  try {
    const parsed = JSON.parse(data) as { error?: { message?: string; status?: number }; message?: string };
    const message = parsed.error?.message || parsed.message || data;
    const status = parsed.error?.status;
    return typeof status === "number" ? new RequestError(message, status) : new Error(message);
  } catch {
    return new Error(data);
  }
}
