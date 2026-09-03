/**
 * HTTP-клиент портала: адрес, заголовки, разбор ошибки, скачивание.
 *
 * Состояния сессии здесь нет — токен и его обновление живут в `session`: транспорт только
 * спрашивает токен перед запросом и сверяет с сессией результат обновления, а решение «сессия
 * кончилась» принимает сама сессия.
 *
 * Адрес API наружу не отдаётся намеренно. Ссылка на защищённый маршрут, собранная в разметке, не
 * работает и работать не может: access-токен живёт в памяти вкладки, а переход по `href` браузер
 * делает сам и без заголовка `Authorization` — сервер отвечает 401 прямо в новой вкладке, вместо
 * файла. Скачивание идёт через `apiDownload`.
 */
import {
  clientRequestHeaders,
  isClientUpgradeResponse,
  requireClientUpgrade,
} from './clientContract';
import {
  enterMaintenanceMode,
  isMaintenanceModeActive,
  isMaintenanceModeExempt,
  isMaintenanceModeResponse,
  maintenanceModeState,
  readMaintenanceModeNotice,
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_MODE_MESSAGE,
  MAINTENANCE_MODE_STATUS,
} from './maintenance';
import { expireIfCurrent, getToken, refresh } from './session';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
  /**
   * Разбор отказа машиной, а не человеком. Заведено ради рукопожатия выписки (Р21 плана
   * `docs/route-trips-plan.md`): 409 `waybill_ack_required` несёт список предупреждений и свежий
   * отпечаток, и без этого поля до окна подтверждения не доехало бы ни то, ни другое — сообщение
   * читает человек, а отпечаток возвращается серверу нетронутым.
   *
   * Тип широкий намеренно: транспорт не знает ручек, а форму своего `details` описывает контракт
   * каждой из них (`WaybillAckRequiredDetails`). Разбирает его вызывающий — там же, где знает, чего
   * ждал.
   */
  details?: unknown;
  requestId?: string;
  status: number;
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'code' in e && 'status' in e;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  /** не пытаться обновлять токен при 401 (для auth-эндпоинтов) */
  noRefresh?: boolean;
  /**
   * Дополнительные заголовки запроса. Заведены ради `Idempotency-Key` кабинета водителя (ADR 0103):
   * ключ идемпотентности — свойство самой попытки отправки, а не её тела, и повторить его в теле
   * значило бы дать серверу два ответа на вопрос «та же это отправка или новая». `Authorization` и
   * `Content-Type` ставит транспорт и здесь их не ждёт — они перекрываются намеренно последними.
   */
  headers?: Record<string, string>;
  /**
   * Отмена и срок запроса (ADR 0148). Нужен там, где ответа ждут долго, — сегодня это печать
   * путевого листа: вкладка обязана и перестать ждать сама, и прекратить работу сервера, когда
   * человек закрыл окно. Без сигнала запрос продолжает жить после закрытия: браузер держит
   * соединение, сервер дописывает бланк, которого никто не заберёт.
   */
  signal?: AbortSignal;
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
  // Свои заголовки идут первыми: тип тела и токен транспорт ставит сам, и подменять их вызывающему
  // нечем — иначе один экран смог бы отправить запрос от чужого имени или в чужой кодировке.
  // Версия клиента — там же и по той же причине: её объявляет сборка, а не экран.
  const headers: Record<string, string> = { ...options.headers, ...clientRequestHeaders() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

/**
 * Портал закрыт на технические работы — запрос НЕ ОТПРАВЛЯЕТСЯ ВОВСЕ, отказ собирается на месте.
 *
 * Замыкание здесь не оптимизация. Заглушка размонтирует портал, но вкладок у окна много, и каждая
 * до последнего запроса продолжала бы фоновые обновления списков: сервер в окне либо отвечает 503
 * на каждый такой запрос, либо остановлен `--cutover` и не отвечает вовсе — в обоих случаях это
 * работа впустую по закрытому API. Отказ при этом той же формы, что пришёл бы от гейта: вызывающий
 * про режим не знает и знать не должен, а разговор с человеком ведёт заглушка поверх всего.
 *
 * Единственное, что сквозь закрытый портал ходит, — выход; причина у исключения одна и названа в
 * `isMaintenanceModeExempt`.
 */
function refuseWhileClosed(path: string, method: string): void {
  if (!isMaintenanceModeActive()) return;
  if (isMaintenanceModeExempt(method, path)) return;
  const { reason, until } = maintenanceModeState();
  throw {
    code: MAINTENANCE_MODE_CODE,
    message: MAINTENANCE_MODE_MESSAGE,
    details: { reason, until },
    status: MAINTENANCE_MODE_STATUS,
  } as ApiError;
}

/** Запрос с обновлением токена и разбором ошибки; тело читают уже вызывающие. */
async function request(path: string, options: RequestOptions): Promise<Response> {
  refuseWhileClosed(path, options.method ?? 'GET');
  const url = buildUrl(path, options.query);
  let res = await doFetch(url, options);

  if (res.status === 401 && !options.noRefresh) {
    /*
     * Номер сессии снимается ДО обновления: за время запроса человек может выйти и войти заново,
     * и тогда «обновить не удалось» относится к прошлой сессии, а не к текущей. Без этой сверки
     * ответ старого refresh выкидывал бы уже нового пользователя.
     */
    const outcome = await refresh();
    if (outcome.status === 'refreshed') res = await doFetch(url, options);
    // Сессии больше нет — уводим на вход. Без этого страница остаётся на экране как вошедшая, а
    // каждое действие отвечает «Требуется авторизация»: сообщение верное, но читается как поломка
    // печати или выгрузки, а не как конец сессии.
    else if (outcome.status === 'expired') expireIfCurrent(outcome.generation);
  }

  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as Partial<ApiError>;
    } catch {
      body = { code: 'error', message: res.statusText };
    }
    /*
     * Гейт версии клиента (ADR 0146, решение 7): сборка вкладки ниже пола сервера, и дальше она
     * работать не будет — ни этот запрос, ни следующие. Отказ при этом бросается дальше как
     * обычная ошибка: вызывающий про гейт не знает и знать не должен, а разговор с человеком
     * ведёт экран поверх всего (`components/AppUpdateBanner.tsx`).
     */
    if (isClientUpgradeResponse(res.status, body.code)) requireClientUpgrade();
    /*
     * Гейт режима технических работ (план `docs/maintenance-mode-plan.md`, §4.5): портал закрыт
     * целиком. Флаг ставится немедленно, не дожидаясь очередного опроса файла статуса, — ради
     * этого 503 и заведён вторым каналом. Снять его отказ не может: конец работ подтверждает
     * только файл, переживающий остановку api.
     */
    if (isMaintenanceModeResponse(res.status, body.code)) {
      enterMaintenanceMode(readMaintenanceModeNotice(body.details));
    }
    throw {
      code: body.code ?? 'error',
      message: body.message ?? 'Ошибка запроса',
      fields: body.fields,
      details: body.details,
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
