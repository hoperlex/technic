import { isApiError } from '@shared/api';
import { formatDate, formatDateTime, errorMessage as sharedErrorMessage } from '@shared/lib';

/*
 * Времянка волны «неразмеченный слой» (docs/frontend-unmarked-layer-plan.md, узел У1).
 *
 * Четыре форматтера уехали в `@shared/lib` и здесь только перевыставлены, чтобы экраны переходили
 * на новый адрес партиями по каталогам, а не все сразу. Реэкспорт, а не копия: копия развела бы
 * два поведения, и разошлись бы они молча.
 *
 * Снимается вместе с последней партией. Всё, что ниже реэкспорта, — работа других узлов: подписи
 * полей ждут раскладки по владельцам (У3), а `formatDateTimeMaybe` — слайса заявок (У8).
 */
export { formatBytes, formatDate, formatDateTime, formatMoney } from '@shared/lib';

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

/**
 * Человекочитаемое сообщение об ошибке: механизм общий (`shared/lib`), здесь — только словарь
 * подписей экранов, не переехавших в слайсы.
 *
 * Своей сборки текста тут больше нет намеренно: она уже разошлась бы с общей — номер обращения у
 * пятисотки печатает только одна из двух копий, и половина портала показывала бы ошибку без него.
 */
export function errorMessage(e: unknown): string {
  return sharedErrorMessage(e, FIELD_LABELS);
}
