const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

/*
 * Адрес API наружу не отдаётся намеренно. Ссылка на защищённый маршрут, собранная в разметке,
 * не работает и работать не может: access-токен живёт в памяти вкладки, а переход по `href`
 * браузер делает сам и без заголовка `Authorization` — сервер отвечает 401 «Требуется
 * авторизация» прямо в новой вкладке, вместо файла. Скачивание идёт через `apiDownload`.
 */

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

let sessionExpired: (() => void) | null = null;

/**
 * Кого звать, когда refresh-токен уже не обменивается на access: истёк, отозван reuse detection
 * или учётку выключили. Ставит `AuthProvider` — клиент API не знает про роутер и не должен.
 */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpired = handler;
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

/** Запрос с обновлением токена и разбором ошибки; тело читают уже вызывающие. */
async function request(path: string, options: RequestOptions): Promise<Response> {
  const url = buildUrl(path, options.query);
  let res = await doFetch(url, options);

  if (res.status === 401 && !options.noRefresh) {
    const ok = await refreshSession();
    if (ok) res = await doFetch(url, options);
    // Обновить не удалось — сессии больше нет. Без этого страница остаётся на экране как
    // вошедшая, а каждое действие отвечает «Требуется авторизация»: сообщение верное, но
    // читается как поломка печати или выгрузки, а не как «войдите заново».
    else sessionExpired?.();
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
  return res;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Ответ файлом, а не JSON. Нужен печати путевого листа (ADR 0041): бланк приходит PDF-ом, и
 * показать его фрейму надо из памяти вкладки (`blob:`), а не по адресу API. Адрес API в разработке
 * лежит на другом порту, и фрейм с чужого источника печатать нельзя — своя же копия печатается
 * везде одинаково и на диск при этом не ложится.
 */
export async function apiFetchBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const res = await request(path, options);
  return res.blob();
}

/** Имя файла из `Content-Disposition`: серверу виднее, как называется документ. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  // `filename*=UTF-8''...` — им сервер и отдаёт кириллицу; простой `filename=` разбирается следом.
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* битую кодировку игнорируем — ниже есть запасное имя */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

/**
 * Скачивание защищённого файла. Не ссылкой: переход по `href` уходит без заголовка
 * `Authorization` (access-токен живёт в памяти вкладки, а не в cookie), и вместо файла браузер
 * показывает 401 «Требуется авторизация» в новой вкладке. Поэтому файл забирается обычным
 * запросом API — с токеном и с обновлением сессии, как всё остальное, — и уже из памяти
 * отдаётся на диск.
 *
 * Вложения заявок так не качаются: там сервер отдаёт presigned-ссылку на S3, которая
 * авторизуется сама и живёт минуты. Здесь отдавать нечего — бланк собирается на лету.
 */
export async function apiDownload(
  path: string,
  fallbackName: string,
  options: RequestOptions = {},
): Promise<void> {
  const res = await request(path, options);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Отпускаем копию не сразу: Safari успевает начать сохранение только после возврата в цикл.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
