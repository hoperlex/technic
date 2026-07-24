export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const err = {
  unauthorized: (m = 'Требуется авторизация') => new AppError(401, 'unauthorized', m),
  forbidden: (m = 'Доступ запрещён') => new AppError(403, 'forbidden', m),
  notFound: (m = 'Не найдено') => new AppError(404, 'not_found', m),
  conflict: (m = 'Конфликт версий — обновите данные и повторите') =>
    new AppError(409, 'version_conflict', m),
  badRequest: (m = 'Некорректный запрос', fields?: Record<string, string>) =>
    new AppError(400, 'bad_request', m, fields),
  unprocessable: (m = 'Некорректная структура запроса', fields?: Record<string, string>) =>
    new AppError(422, 'unprocessable_entity', m, fields),
  validation: (fields: Record<string, string>) =>
    new AppError(400, 'validation_error', 'Ошибка валидации', fields),
  inactive: (m = 'Аккаунт не активирован') => new AppError(403, 'account_inactive', m),
  invalidCredentials: (m = 'Неверный логин или пароль') =>
    new AppError(401, 'invalid_credentials', m),
};
