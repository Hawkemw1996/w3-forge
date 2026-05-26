// Typed fetch client for the Forge Admin API.
// All endpoints live under /api/admin/* and return ApiEnvelope<T>:
//   { success: true, data: T } | { success: false, error: { code, message } }

const ADMIN_BASE = '/api/admin';

export interface ApiEnvelopeSuccess<T> {
  success: true;
  data: T;
}
export interface ApiEnvelopeFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
}
export type ApiEnvelope<T> = ApiEnvelopeSuccess<T> | ApiEnvelopeFailure;

export class AdminApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function adminUrl(p: string): string {
  return p.startsWith('/') ? `${ADMIN_BASE}${p}` : `${ADMIN_BASE}/${p}`;
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: ApiEnvelope<T> | undefined;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = undefined;
  }
  if (!res.ok || !body || body.success !== true) {
    const code = (body && !body.success && body.error?.code) || 'HTTP_ERROR';
    const message =
      (body && !body.success && body.error?.message) ||
      `HTTP ${res.status} ${res.statusText}`;
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

export async function adminPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(adminUrl(path), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseEnvelope<T>(res);
}
