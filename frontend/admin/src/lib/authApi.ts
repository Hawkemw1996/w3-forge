import { consoleText } from "../../../../shared/consoleApp";
// W3 BuildCost v0.3.0 — browser API client for /api/v1/buildcost and /api/auth.
//
// Every request goes to the BuildCost backend on the same origin with the
// session cookie. There is no mock fallback: a failed request throws an
// ApiError and the caller shows it. The transport is swappable so tests can
// route requests to a real in-process backend.

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: string[];
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: string[];
  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Validation messages when present, otherwise the error message. */
  get messages(): string[] {
    return this.details.length ? this.details : [this.message];
  }
}

export interface TransportRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | Blob;
}

export interface TransportResponse {
  status: number;
  /** Parsed JSON body, or null when the response was not JSON. */
  json: unknown;
  /** Raw bytes for non-JSON responses (document downloads). */
  bytes?: ArrayBuffer;
  headers: Record<string, string>;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

const browserTransport: Transport = async (req) => {
  const res = await fetch(req.path, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  if (ct.includes('application/json')) {
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers };
  }
  return { status: res.status, json: null, bytes: await res.arrayBuffer(), headers };
};

let transport: Transport = browserTransport;

/** Tests only: route requests elsewhere (e.g. to an in-process backend). */
export function setTransport(t: Transport | null): void {
  transport = t ?? browserTransport;
}

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();
/** Called for 401/503 responses so the app can show sign-in / Core-unavailable. */
export function onAuthProblem(l: Listener): () => void {
  authListeners.add(l);
  return () => authListeners.delete(l);
}

function toError(status: number, json: unknown): ApiError {
  const body = (json && typeof json === 'object' ? (json as { error?: ApiErrorBody }).error : undefined) ?? undefined;
  if (body && typeof body.message === 'string') return new ApiError(status, body.code ?? 'ERROR', body.message, Array.isArray(body.details) ? body.details : []);
  if (status === 0) return new ApiError(0, 'NETWORK_ERROR', consoleText('W3 BuildCost could not be reached. Check your connection and try again.'));
  return new ApiError(status, 'UNEXPECTED_RESPONSE', consoleText(`W3 BuildCost returned an unexpected response (HTTP ${status}).`));
}

async function send<T>(req: TransportRequest): Promise<T> {
  let res: TransportResponse;
  try {
    res = await transport(req);
  } catch {
    throw toError(0, null);
  }
  const json = res.json as { success?: boolean; data?: T } | null;
  if (res.status >= 200 && res.status < 300 && json && json.success === true) return json.data as T;
  const err = toError(res.status, res.json);
  if (err.status === 401 || err.code === 'CORE_UNAVAILABLE') authListeners.forEach((l) => l(err));
  throw err;
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-W3-Request': consoleText('buildcost') };

export function apiGet<T>(path: string): Promise<T> {
  return send<T>({ method: 'GET', path, headers: { Accept: 'application/json' } });
}

export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return send<T>({ method: 'POST', path, headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
}

/** Raw upload (documents): bytes in the body, metadata in headers. */
export function apiUpload<T>(path: string, bytes: Uint8Array | ArrayBuffer | Blob, headers: Record<string, string>): Promise<T> {
  return send<T>({ method: 'POST', path, headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-W3-Request': consoleText('buildcost'), ...headers }, body: bytes });
}

/** Binary download; throws ApiError on failure. */
export async function apiDownload(path: string): Promise<{ bytes: ArrayBuffer; headers: Record<string, string> }> {
  let res: TransportResponse;
  try {
    res = await transport({ method: 'GET', path, headers: { Accept: 'application/octet-stream' } });
  } catch {
    throw toError(0, null);
  }
  if (res.status === 200 && res.bytes) return { bytes: res.bytes, headers: res.headers };
  throw toError(res.status, res.json);
}

export const API = consoleText('/api/v1/buildcost');

/** Messages for display from any thrown value. */
export function errorMessages(err: unknown): string[] {
  if (err instanceof ApiError) return err.messages;
  if (err instanceof Error) return [err.message];
  return ['Something went wrong.'];
}
