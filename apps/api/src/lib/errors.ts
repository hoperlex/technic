export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    /**
     * Разбор отказа машиной, а не человеком: список предупреждений выписки с отпечатком (Р21),
     * коды блокеров задания (Р11а). `fields` для этого не годится — там `Record<string, string>`
     * под пометки полей формы, и ни массив, ни вложенный объект в него не кладутся.
     *
     * Тип намеренно широкий: транспорт отдаёт это тело как есть, а форму каждого `details`
     * описывает контракт своей ручки (`WaybillAckRequiredDetails`).
     */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Чем 409 объясняется, если это не расхождение версий: свой код и тело для разбора порталом. */
interface ConflictOptions {
  code?: string;
  details?: unknown;
}

export const err = {
  unauthorized: (m = 'Требуется авторизация') => new AppError(401, 'unauthorized', m),
  forbidden: (m = 'Доступ запрещён') => new AppError(403, 'forbidden', m),
  notFound: (m = 'Не найдено') => new AppError(404, 'not_found', m),
  /**
   * 409. Код по умолчанию `version_conflict` — им портал показывает «откройте заново», и таких
   * отказов подавляющее большинство. Свой код передаётся вторым аргументом ради рукопожатия
   * выписки (`waybill_ack_required`, Р21): исход у него другой — окно подтверждения со свежим
   * списком, — и различить два исхода на один код было бы нечем.
   */
  conflict: (m = 'Конфликт версий — обновите данные и повторите', options?: ConflictOptions) =>
    new AppError(409, options?.code ?? 'version_conflict', m, undefined, options?.details),
  badRequest: (m = 'Некорректный запрос', fields?: Record<string, string>) =>
    new AppError(400, 'bad_request', m, fields),
  unprocessable: (
    m = 'Некорректная структура запроса',
    fields?: Record<string, string>,
    details?: unknown,
  ) => new AppError(422, 'unprocessable_entity', m, fields, details),
  validation: (fields: Record<string, string>) =>
    new AppError(400, 'validation_error', 'Ошибка валидации', fields),
  inactive: (m = 'Аккаунт не активирован') => new AppError(403, 'account_inactive', m),
  /**
   * Операция требует того, что сейчас недоступно, — не по вине запроса. Заведена ради почты:
   * регистрацию, которую невозможно подтвердить письмом, нельзя принять молча, будто всё удалось.
   */
  unavailable: (m = 'Сервис временно недоступен') => new AppError(503, 'service_unavailable', m),
  invalidCredentials: (m = 'Неверный логин или пароль') =>
    new AppError(401, 'invalid_credentials', m),
};
