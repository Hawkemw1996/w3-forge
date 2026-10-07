// Lightweight typed fetch client for the Admin API.
// All endpoints live under /api/admin/* (see backend/src/admin/routes/*).
//
// v0.5.0 was strictly read-only (GET only). v0.5.3 introduces the first
// admin write surface — the dashboard tile layout API — so adminPut and
// adminPost helpers are added here. The rest of the admin surface remains
// read-only and continues to use adminGet.

const ADMIN_BASE = '/api/admin';

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class AdminApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function adminUrl(path: string): string {
  return path.startsWith('/') ? `${ADMIN_BASE}${path}` : `${ADMIN_BASE}/${path}`;
}

// v0.5.38 (regression fix): when the backend returns a non-2xx status but the
// body is still the well-formed envelope { success:true, data:{...} } that
// carries a structured refusal (controls routes do this for 409 lock
// contention, validation failures, and pipeline input rejection), surface
// the refusal's `reason` (and `runStatus`) in the thrown error message
// instead of falling back to a bare `HTTP 409 Conflict`. The AdminApiError
// shape (status / code / Error message) is unchanged; only the message
// text gets richer so the UI no longer renders an opaque "HTTP 409"
// banner when the backend has already told us why.
interface StructuredRefusalBody {
  controlId?: string;
  accepted?: boolean;
  runStatus?: string;
  reason?: string;
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: ApiEnvelope<T> | undefined;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = undefined;
  }
  if (!res.ok || !body || body.success !== true) {
    const code = body?.error?.code ?? 'HTTP_ERROR';
    // v0.5.38 (regression fix): some routes — notably
    // GET /packages/installed/:version — emit a plain string `error`
    // field ("no installed metadata for vX.Y.Z") instead of the
    // typed `{ code, message }` object envelope. Surface that string
    // when the typed message is missing, so the UI shows the
    // backend's intent instead of a bare "HTTP 404 Not Found".
    const rawErr = (body as ApiEnvelope<T> | undefined)?.error as
      | { code?: string; message?: string }
      | string
      | undefined;
    let message =
      body?.error?.message
      ?? (typeof rawErr === 'string' ? rawErr : undefined)
      ?? `HTTP ${res.status} ${res.statusText}`;
    // If the body is a structured refusal envelope (success=true + data with
    // runStatus/reason) carried on a non-OK HTTP status, prefer that reason
    // text. This is the controls-routes pattern for 409 refusals
    // (already_running, blocked, needs_confirmation, disabled).
    if (body && body.success === true && body.data) {
      const refusal = body.data as StructuredRefusalBody;
      if (typeof refusal.reason === 'string' && refusal.reason.length > 0) {
        const statusPart =
          typeof refusal.runStatus === 'string' && refusal.runStatus.length > 0
            ? `${refusal.runStatus}: `
            : '';
        message = `${statusPart}${refusal.reason}`;
      }
    }
    if (typeof window !== 'undefined' && (res.status === 401 || ['ACCESS_DENIED', 'APP_ADMIN_REQUIRED', 'CORE_UNAVAILABLE', 'CORE_NOT_CONFIGURED'].includes(code))) {
      window.dispatchEvent(new Event('w3-auth-problem'));
    }
    throw new AdminApiError(res.status, code, message);
  }
  return body.data as T;
}

export async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(adminUrl(path), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  });
  return parseEnvelope<T>(res);
}

export async function adminPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(adminUrl(path), {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {})
  });
  return parseEnvelope<T>(res);
}

export async function adminPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(adminUrl(path), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseEnvelope<T>(res);
}
