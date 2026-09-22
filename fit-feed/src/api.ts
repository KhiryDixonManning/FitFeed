import { auth } from '../firebase';
import { PYTHON_API } from './config';

// Single entry point for calls to the Flask service. Every protected endpoint
// expects a Firebase ID token, so the token is attached here rather than being
// re-derived (and forgotten) at each call site.

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  /** Set false for endpoints that do not require a signed-in user. */
  authenticated?: boolean;
  /** Caller-owned cancellation, e.g. when a stale page is superseded. */
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'POST', body, timeoutMs = 30000, authenticated = true, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (authenticated) {
    const user = auth.currentUser;
    if (!user) {
      throw new ApiError(401, 'not_signed_in', 'You need to be signed in for this.');
    }
    // getIdToken refreshes automatically when the cached token is near expiry.
    headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
  }

  // Without a timeout a hung backend leaves the UI waiting indefinitely.
  // A caller-supplied signal is chained in so either can cancel the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(`${PYTHON_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const detail = (payload ?? {}) as { error?: string; message?: string };
      throw new ApiError(
        response.status,
        detail.error ?? 'request_failed',
        detail.message ?? `Request failed with status ${response.status}.`
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      // A caller-initiated cancellation is not a failure to report.
      if (signal?.aborted) throw new ApiError(0, 'cancelled', 'Request cancelled.');
      throw new ApiError(504, 'timeout', 'The request timed out.');
    }
    throw new ApiError(0, 'network_error', 'Could not reach the service.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Ask the backend to analyse a post the current user owns. */
export async function requestAnalysis(postId: string): Promise<{ status: string }> {
  return apiFetch<{ status: string }>('/analyze', { body: { postId } });
}
