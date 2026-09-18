import { DEVICE_MAIL_PAUSE_CODE } from '@technic/contracts';
import {
  DeviceMailPausedError,
  type DeviceMailCursor,
  type DeviceMailIntakeResult,
  type DeviceMailSubmission,
} from './types';

/**
 * Разговор с внутренними ручками приёма. Тот же контур, что у часов рассылок: заголовок
 * `x-internal-token`, база из `INTERNAL_API_URL`.
 *
 * Почему курсор спрашивается у API, а не хранится здесь (Р23): в памяти процесса он не переживает
 * перезапуск, а своей строки состояния у worker нет — в базу он не ходит вовсе.
 */

export interface DeviceMailApi {
  /**
   * Курсор ящика. `mailboxError` — причина, по которой прошлый заход не состоялся вовсе (ящик не
   * открылся, оборвалось скачивание): ручка кладёт её в `last_error` ящика, и очередь §10 может
   * сказать правду «курсор стоит с такого-то времени, потому что ящик не читается». Своей строки
   * состояния у worker нет, и рассказать об этом иначе он не может ничем.
   */
  cursor(account: string, mailboxError?: string): Promise<DeviceMailCursor>;
  submit(message: DeviceMailSubmission): Promise<DeviceMailIntakeResult>;
}

/** Числа курсора приезжают из `bigint`-колонок и могут быть как числом, так и строкой. */
function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function createDeviceMailApi(apiBaseUrl: string, internalToken: string): DeviceMailApi {
  return {
    async cursor(account, mailboxError) {
      const query = new URLSearchParams({ account });
      // Причина недоступности ящика едет следующим запросом курсора, а не своей ручкой: отдельный
      // маршрут для одной строки — это второе место, где приём может разойтись с состоянием, а
      // курсор и так спрашивается первым делом на каждом заходе.
      if (mailboxError) query.set('mailboxError', mailboxError.slice(0, 500));
      const res = await fetch(`${apiBaseUrl}/internal/device-mail/cursor?${query.toString()}`, {
        method: 'GET',
        headers: { 'x-internal-token': internalToken },
      });
      // Курсор — вход в тик: не ответили, и заходить в ящик не с чем. Отдельной паузы здесь не
      // нужно, тик просто не состоялся и повторится следующим.
      if (!res.ok) throw new Error(`API ответил ${res.status} на запрос курсора ящика`);
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        uidValidity: toNumber(raw.uidValidity, 0),
        lastUid: toNumber(raw.lastUid, 0),
        resetUidValidity: toNullableNumber(raw.resetUidValidity),
        resetMaxUid: toNullableNumber(raw.resetMaxUid),
        stuckUidValidity: toNullableNumber(raw.stuckUidValidity),
        stuckUid: toNullableNumber(raw.stuckUid),
        stuckAttempts: toNumber(raw.stuckAttempts, 0),
      };
    },
    async submit(message) {
      const res = await fetch(`${apiBaseUrl}/internal/device-mail/messages`, {
        method: 'POST',
        headers: { 'x-internal-token': internalToken, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) {
        // Тело отказа читается один раз и до разбора: код паузы лежит в нём, а `json()` на пустом
        // теле бросает — и тогда отказ превратился бы в другую ошибку, потеряв свой номер.
        const body = await res.text().catch(() => '');
        let code = '';
        try {
          code = String((JSON.parse(body) as { code?: unknown }).code ?? '');
        } catch {
          // Не JSON — значит отвечал не наш обработчик (шлюз, прокси). Остаётся статус.
        }
        // «Портал целиком не принимает»: рубильник выключен, хранилище недоступно, выкат. Это
        // стоп-граница пачки, а не беда одного письма (§9.1, п. 7). Узнаём её двумя способами —
        // по коду тела и по статусу: код переживает шлюз, подменивший статус, а статус переживает
        // отказ, до тела не дошедший.
        if (res.status === 503 || code === DEVICE_MAIL_PAUSE_CODE) {
          throw new DeviceMailPausedError(`Приём писем приостановлен: API ответил ${res.status}`);
        }
        // Прочий отказ пачку тоже прекращает, и это осознанно: письмо не принято, а продолжить
        // значит увести курсор за него. Терминальный исход ручка закрывает САМА и отвечает
        // успехом — сюда такое письмо не попадает вовсе (§9.1, п. 6).
        throw new Error(`API ответил ${res.status} на сдачу письма UID ${message.uid}`);
      }
      const raw = (await res.json()) as Record<string, unknown>;
      return {
        outcome: raw.outcome === 'existed' ? 'existed' : 'created',
        status: typeof raw.status === 'string' ? raw.status : '',
        lastUid: toNumber(raw.lastUid, message.uid),
      };
    },
  };
}
