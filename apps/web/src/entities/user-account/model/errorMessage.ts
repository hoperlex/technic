import { errorMessage } from '@shared/lib';

const USER_ACCOUNT_ERROR_LABELS: Record<string, string> = {
  email: 'Email',
  newEmail: 'Новый email',
  currentPassword: 'Текущий пароль',
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  phone: 'Телефон',
  role: 'Роль',
  password: 'Пароль',
  newPassword: 'Новый пароль',
  isActive: 'Активен',
  constructionObjectIds: 'Объекты',
  departmentIds: 'Отделы',
  addons: 'Надстройки роли',
  grants: 'Полномочия',
  counterpartyId: 'Контрагент',
  personId: 'Работник',
  reason: 'Причина отказа',
  applicantMessage: 'Ответ заявителю',
};

/** Human-readable validation fields for user-account mutations. */
export function userAccountErrorMessage(error: unknown): string {
  return errorMessage(error, USER_ACCOUNT_ERROR_LABELS);
}
