import { errorMessage } from '@shared/lib';

const MAILING_ERROR_LABELS: Record<string, string> = {
  name: 'Название',
  type: 'Тип рассылки',
  isEnabled: 'Рассылка включена',
  sendAt: 'Время отправки',
  runWeekdays: 'Дни выполнения',
  windowFromDays: 'Первый день',
  windowDays: 'На сколько дней',
  excludedRunDates: 'Исключённые дни запуска',
  excludedRouteDates: 'Исключённые дни рейсов',
  excludedPersonIds: 'Исключённые водители',
  permissions: 'Права-адресаты',
  requestScope: 'Состав заявок',
  showTrips: 'Перевозки',
  showOnsite: 'Техника на объектах',
  scopeMode: 'Область',
  objectIds: 'Объекты',
  departmentIds: 'Отделы',
  recipientMode: 'Режим получателей',
  recipientUserIds: 'Получатели',
  kind: 'Тип письма',
  account: 'Почтовый канал',
  toUserId: 'Получатель',
  date: 'Дата письма',
  driverPersonId: 'Водитель',
  sampleUserId: 'Учётка-образец',
};

/** Human-readable validation fields for schedules and test mail. */
export function mailingErrorMessage(error: unknown): string {
  return errorMessage(error, MAILING_ERROR_LABELS);
}
