import type { DriverAssignmentDto, DriverReportDto, ReportSubmitBody } from '@technic/contracts';
import { apiFetch, createQueryKeys } from '@shared/api';

/**
 * Запросы кабинета водителя и его локальный черновик (ADR 0102, ADR 0103).
 *
 * Кабинет — второй контур портала: у роли `driver` нет ни одного права основного портала, поэтому
 * своих справочников он не спрашивает вовсе — все подписи приходят готовыми в задании. Отсюда
 * четыре ручки и ни одной больше.
 *
 * `personId` в запросах не встречается намеренно: область видимости роли — «свой человек», и
 * держится она не предикатом, а отсутствием параметра — сервер берёт человека из принципала.
 */

// ── Запросы ──

export const driverKeys = createQueryKeys('driver-cabinet', {
  /** Задание на дату: ключ по дате — переключение стрелками не перезапрашивает уже показанный день. */
  assignment: (date: string) => ['assignment', date],
  /** Отчёт дня: им шапка рисует состояние кнопки, поэтому он живёт отдельно от задания. */
  report: (date: string) => ['report', date],
});

export const driverCabinetApi = {
  assignment: (date: string) =>
    apiFetch<DriverAssignmentDto>('/driver/assignment', { query: { date } }),
  /** Отчёта может не быть вовсе: день, за который ещё не открывали оверлей, — законное состояние. */
  report: (date: string) => apiFetch<DriverReportDto | null>(`/driver/reports/${date}`),
  /**
   * Открытие отчёта: сервер заводит черновик и строки ожидания по источникам дня и возвращает их
   * с идентификаторами. До этого записывать некуда — `itemId` появляется только здесь.
   */
  open: (date: string) =>
    apiFetch<DriverReportDto>(`/driver/reports/${date}/open`, { method: 'POST' }),
  /**
   * Отправка. Ключ идемпотентности — заголовком: плохая связь не должна порождать ни дублей, ни
   * потерянных отправок, а повтор того же ключа с другим телом сервер обязан отличить от повтора
   * той же попытки (Р25).
   */
  submit: (date: string, body: ReportSubmitBody, idempotencyKey: string) =>
    apiFetch<DriverReportDto>(`/driver/reports/${date}/submit`, {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};

// ── Черновик отправки ──

/**
 * Черновик живёт здесь, рядом с отправкой, а не отдельным модулем: это и есть тело будущего
 * запроса вместе с его ключом идемпотентности — то же самое, что уедет на сервер, только ещё не
 * уехавшее. Разведи их по файлам — и «ключ живёт вместе с черновиком» (Р14) стало бы правилом,
 * которое держится памятью.
 */

/** Файл, уже загруженный в хранилище и ещё ни к чему не привязанный. */
export interface DraftFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Введённое по одной строке ожидания. Числа хранятся строками, а не числами: черновик обязан
 * пережить «145 3» — недонабранное значение, которое числом не является, но потерять его при
 * сворачивании браузера человек не простит.
 *
 * Вида `no_data` здесь нет: строку без показаний закрывает персонал с причиной (план кабинета,
 * Р4), а у водителя поля, которым можно отписаться от ввода, больше нет. Старые черновики с этими
 * ключами читаются как обычные — лишние поля просто не смотрят.
 */
export interface DraftItem {
  odometerKm: string;
  engineHours: string;
  fuelFilledLiters: string;
  comment: string;
  files: DraftFile[];
  /**
   * Подтверждение аномалии, показанной порталом по прошлой отправке (Р20). Живёт вместе с
   * введённым, а не отдельным состоянием: аномалию показывают над теми же числами, и решение
   * «цифра верная» относится к ним же.
   */
  confirmAnomaly: boolean;
}

export interface ReportDraft {
  /** Генерируется на открытие оверлея и живёт вместе с черновиком (Р14, Р25). */
  idempotencyKey: string;
  /** Когда сохранён: по нему и уходит по TTL. */
  savedAt: number;
  /** Строка ожидания → введённое по ней. */
  items: Record<string, DraftItem>;
}

/**
 * Ключ хранилища — «учётка + дата», именно учётка, а не человек: телефон в бригаде бывает общим, и
 * два водителя, входящие по очереди, не должны видеть черновики друг друга.
 */
const PREFIX = 'technic:driver-draft:';
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function draftKey(userId: string, date: string): string {
  return `${PREFIX}${userId}:${date}`;
}

/** Чтение с проверкой формы: чужая или испорченная запись читается как «черновика нет». */
function parseDraft(raw: string | null): ReportDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const draft = value as Partial<ReportDraft>;
    if (typeof draft.idempotencyKey !== 'string' || typeof draft.savedAt !== 'number') return null;
    if (typeof draft.items !== 'object' || draft.items === null) return null;
    return { idempotencyKey: draft.idempotencyKey, savedAt: draft.savedAt, items: draft.items };
  } catch {
    return null;
  }
}

export function loadDraft(userId: string, date: string): ReportDraft | null {
  const draft = parseDraft(localStorage.getItem(draftKey(userId, date)));
  if (!draft) return null;
  // Просроченный черновик не показывается даже до уборки: неделю назад введённые показания уже
  // относятся не к тому счётчику, что человек видит перед собой.
  if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
    localStorage.removeItem(draftKey(userId, date));
    return null;
  }
  return draft;
}

export function saveDraft(userId: string, date: string, draft: ReportDraft): void {
  try {
    localStorage.setItem(draftKey(userId, date), JSON.stringify(draft));
  } catch {
    /* Хранилище переполнено или закрыто настройками — работать это не мешает, теряется только
       восстановление после закрытия вкладки. Отказывать в вводе из-за этого нельзя. */
  }
}

export function clearDraft(userId: string, date: string): void {
  localStorage.removeItem(draftKey(userId, date));
}

/** Все черновики учётки — вычищаются при выходе: на общем телефоне они достались бы следующему. */
export function clearUserDrafts(userId: string): void {
  const prefix = `${PREFIX}${userId}:`;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key);
  }
}

/**
 * Уборка по TTL: черновики дней, до которых никто не вернулся. Зовётся при входе в кабинет — своего
 * фонового процесса у портала нет, а «когда-нибудь потом» для чужих показаний на общем телефоне
 * означает «никогда».
 */
export function pruneDrafts(): void {
  const now = Date.now();
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    const draft = parseDraft(localStorage.getItem(key));
    if (!draft || now - draft.savedAt > DRAFT_TTL_MS) localStorage.removeItem(key);
  }
}

/**
 * Ключ идемпотентности. `crypto.randomUUID` есть только в защищённом контексте, а кабинет открывают
 * и по адресу в локальной сети — запасной путь нужен не для красоты: без ключа отправка перестала
 * бы быть повторяемой ровно там, где связь и рвётся.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes]
    // Версия 4 и вариант 10x — иначе сервер не примет строку как uuid.
    .map((b, i) => (i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
