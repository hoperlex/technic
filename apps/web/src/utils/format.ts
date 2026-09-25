import { formatDate, formatDateTime, errorMessage as sharedErrorMessage } from '@shared/lib';

/*
 * What is left of a directory that stands outside the FSD layers. The four typography helpers have
 * moved to `@shared/lib`; three things stayed, and each stayed for its own reason.
 *
 * `FIELD_LABELS` with `errorMessage` — the labels of screens not yet moved into slices. The rule
 * itself is written in `shared/lib/errors.ts`: the dictionary is domain knowledge and arrives as an
 * argument, one entity labelling its own fields. It is followed only halfway today — some ninety
 * screens, nearly all of them pages, call this wrapper and get labels, while some fifty more call
 * the shared function with no dictionary at all and print `newPassword` where a person expects
 * «Новый пароль». Moving the labels to their owners is what finishes the rule, and the waste ticket
 * has already gone that way (`entities/waste-ticket/model/fieldLabels.ts`): it is the worked example
 * of where the next dictionary belongs and of which keys are deliberately left unlabelled. Until
 * then this dictionary is the half that works.
 *
 * `formatDateTimeMaybe` asks about a request, not about a moment: with `timeUnspecified` only the
 * date is agreed, and printing «00:00» would claim an hour nobody agreed. That makes it a request's
 * knowledge, and it waits for a slice of its own.
 */

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
