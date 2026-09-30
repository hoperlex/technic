import { errorMessage } from '@shared/lib';

/**
 * Labels for fields accepted by the session API. They stay with the API owner so a validation
 * response is translated without a page-wide registry or an import made only for side effects.
 */
const SESSION_ERROR_LABELS: Record<string, string> = {
  email: 'Email',
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  phone: 'Телефон',
  password: 'Пароль',
  currentPassword: 'Текущий пароль',
  newPassword: 'Новый пароль',
  requestedRole: 'Кем вы работаете',
  requestedObject: 'Подразделение',
  requestedCompany: 'Компания',
  requestedComment: 'Комментарий',
  captchaToken: 'Проверка',
  token: 'Ссылка из письма',
};

export function sessionErrorMessage(error: unknown): string {
  return errorMessage(error, SESSION_ERROR_LABELS);
}
