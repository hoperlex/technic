import type { FormInstance } from 'antd';
import { errorFields } from './format';

/**
 * Переносит ошибки валидации с сервера на поля формы: без этого пользователь видит только
 * тост и не знает, какое поле править. Имена полей в ответе совпадают с именами `Form.Item`;
 * расхождения (например, `deliveryAt` — это пара «дата + время») задаются через `alias`.
 *
 * Возвращает true, если хоть одна ошибка легла на форму — тогда тост можно не показывать.
 */
export function applyApiFieldErrors(
  form: FormInstance,
  error: unknown,
  alias: Record<string, string> = {},
): boolean {
  const fields = errorFields(error);
  if (!fields) return false;
  const known = new Set(
    form.getFieldsValue(true) && Object.keys(form.getFieldsValue(true) as object),
  );
  const entries = Object.entries(fields)
    // zod присылает путь вида `vehicles.0.volumeM3`; поле формы — верхний сегмент.
    .map(([path, message]) => [alias[path] ?? path.split('.')[0]!, message] as const)
    .filter(([name]) => known.has(name));
  if (entries.length === 0) return false;
  form.setFields(entries.map(([name, errors]) => ({ name, errors: [errors] })));
  return true;
}
