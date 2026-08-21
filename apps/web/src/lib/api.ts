const TOKEN_KEY = 'nio.accessToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toError(response: Response): Promise<ApiError> {
  let message = response.statusText || 'Request failed';
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') message = body.error;
  } catch {
    // Response had no JSON body; the status text is the best we have.
  }
  return new ApiError(response.status, message);
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const token = getToken();
  const isFormData = options.body instanceof FormData;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined && !isFormData ? { 'content-type': 'application/json' } : {}),
    },
    body: isFormData ? (options.body as FormData) : options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Authenticated file fetch for PHI documents, which are never linkable directly. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const response = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw await toError(response);
  return URL.createObjectURL(await response.blob());
}
