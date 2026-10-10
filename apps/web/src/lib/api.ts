const TOKEN_KEY = 'nio.accessToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * How a request obtains its bearer token. The dev provider mints a long-lived token that is kept
 * in localStorage, but Auth0 access tokens expire and are refreshed by the SDK, which holds them
 * in memory so a stolen localStorage entry cannot outlive the tab. Resolving the token per request
 * rather than reading it synchronously is what lets both live behind the same call sites.
 */
type TokenResolver = () => Promise<string | null>;

let resolveToken: TokenResolver = async () => getToken();

export function setTokenResolver(resolver: TokenResolver | null): void {
  resolveToken = resolver ?? (async () => getToken());
}

type ActAsResolver = (path: string) => string | null;

let resolveActAs: ActAsResolver = () => null;

export function setActAsResolver(resolver: ActAsResolver | null): void {
  resolveActAs = resolver ?? (() => null);
}

async function authHeaders(path: string): Promise<Record<string, string>> {
  const token = await resolveToken();
  const actAs = resolveActAs(path);
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(actAs ? { 'x-qinio-act-as': actAs } : {}),
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toError(response: Response): Promise<ApiError> {
  let message = response.statusText || 'Request failed';
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') message = body.error;
    if (typeof body?.code === 'string') code = body.code;
    if (body?.details && typeof body.details === 'object') details = body.details;
  } catch {
    // Response had no JSON body; the status text is the best we have.
  }
  return new ApiError(response.status, message, code, details);
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const isFormData = options.body instanceof FormData;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(await authHeaders(path)),
      ...(options.body !== undefined && !isFormData ? { 'content-type': 'application/json' } : {}),
    },
    body: isFormData
      ? (options.body as FormData)
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
  });

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Authenticated file fetch for PHI documents, which are never linkable directly. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const response = await fetch(path, { headers: await authHeaders(path) });
  if (!response.ok) throw await toError(response);
  return URL.createObjectURL(await response.blob());
}
