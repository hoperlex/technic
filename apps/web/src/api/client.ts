const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'code' in e && 'status' in e;
}

let refreshing: Promise<boolean> | null = null;

/** Обновление access-токена по refresh-cookie (одна попытка на несколько 401 сразу). */
export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          setAccessToken(null);
          return false;
        }
        const data = (await res.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
        return true;
      })
      .catch(() => {
        setAccessToken(null);
        return false;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  /** не пытаться обновлять токен при 401 (для auth-эндпоинтов) */
  noRefresh?: boolean;
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function doFetch(url: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);
  let res = await doFetch(url, options);

  if (res.status === 401 && !options.noRefresh) {
    const ok = await refreshSession();
    if (ok) res = await doFetch(url, options);
  }

  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as Partial<ApiError>;
    } catch {
      body = { code: 'error', message: res.statusText };
    }
    throw {
      code: body.code ?? 'error',
      message: body.message ?? 'Ошибка запроса',
      fields: body.fields,
      requestId: body.requestId,
      status: res.status,
    } as ApiError;
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
