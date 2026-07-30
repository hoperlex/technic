import dayjs from 'dayjs';
import { MOSCOW_TZ } from '../theme';
import { isApiError } from '../api/client';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).tz(MOSCOW_TZ).format('DD.MM.YYYY HH:mm');
}

/** Только дата, без времени. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).tz(MOSCOW_TZ).format('DD.MM.YYYY');
}

/**
 * Дата со временем, если оно задано. У заявок время необязательно: при `timeUnspecified`
 * в отметке значима только дата, и показывать «00:00» было бы враньём про согласованный час.
 */
export function formatDateTimeMaybe(
  iso: string | null | undefined,
  timeUnspecified: boolean,
): string {
  if (!iso) return '—';
  return timeUnspecified ? formatDate(iso) : formatDateTime(iso);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/** Денежная сумма в рублях: «15 000,00 ₽». */
export function formatMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Подписи полей для ошибок валидации с сервера: он присылает технические имена
 * (`volumeM3`, `deliveryAt`), а человеку нужно название поля из формы.
 */
const FIELD_LABELS: Record<string, string> = {
  objectId: 'Объект строительства',
  requestType: 'Тип заявки',
  containerTypeId: 'Тип машины/контейнера',
  wasteTypeId: 'Тип мусора',
  volumeM3: 'Объём',
  operatorCounterpartyId: 'Оператор вывоза',
  deliveryAt: 'Дата доставки',
  comment: 'Комментарий',
  completion: 'Фактический объём',
  email: 'Email',
  fullName: 'ФИО',
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  captchaAnswer: 'Код с картинки',
  captchaToken: 'Проверка',
  role: 'Роль',
  counterpartyId: 'Контрагент',
  constructionObjectId: 'Объект',
  name: 'Наименование',
  inn: 'ИНН',
  synonyms: 'Синонимы',
  code: 'Код',
  address: 'Адрес',
  password: 'Пароль',
  newPassword: 'Новый пароль',
};

/** Поля с ошибками из ответа сервера (`validation_error` или доменная 400 с `fields`). */
export function errorFields(e: unknown): Record<string, string> | null {
  return isApiError(e) && e.fields && Object.keys(e.fields).length > 0 ? e.fields : null;
}

function fieldLabel(path: string): string {
  // zod присылает путь вида `vehicles.0.volumeM3` — для подписи важен последний сегмент.
  const last =
    path
      .split('.')
      .filter((s) => !/^\d+$/.test(s))
      .pop() ?? path;
  return FIELD_LABELS[last] ?? last;
}

/**
 * Человекочитаемое сообщение об ошибке. У ошибок валидации сервер шлёт общий текст
 * («Ошибка валидации данных») и детали в `fields` — без них человек не понимает, что
 * именно не так, поэтому подписи полей добавляются к сообщению.
 */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    const fields = errorFields(e);
    if (!fields) return e.message;
    const labels = [...new Set(Object.keys(fields).map(fieldLabel))];
    return `${e.message}: ${labels.join(', ')}`;
  }
  if (e instanceof Error) return e.message;
  return 'Произошла ошибка';
}
