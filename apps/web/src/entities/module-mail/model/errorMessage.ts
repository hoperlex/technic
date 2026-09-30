import { errorMessage } from '@shared/lib';

const MODULE_MAIL_ERROR_LABELS: Record<string, string> = {
  event: 'Событие',
  toEmail: 'Адрес службы',
  isEnabled: 'Рассылка включена',
  replyToMode: 'Куда уйдёт ответ',
  replyToEmail: 'Адрес для ответов',
  comment: 'Комментарий',
  version: 'Версия',
};

/** Human-readable validation fields for module event mail settings. */
export function moduleMailErrorMessage(error: unknown): string {
  return errorMessage(error, MODULE_MAIL_ERROR_LABELS);
}
