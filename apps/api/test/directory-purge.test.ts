import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';

/**
 * Перевод отказа БД при удалении записи справочника насовсем (ADR 0060).
 *
 * Проверять здесь есть что ровно одно: отказ по внешнему ключу — это не поломка, а ответ «на
 * запись ссылаются», и человек должен прочитать, кто именно ссылается. Без перевода он получил бы
 * 500 с текстом про constraint и не понял бы, что делать дальше.
 */

// Модуль лежит рядом с регистрацией маршрута, а та тянет конфиг и клиент БД. Перевод ошибки
// ни туда, ни туда не ходит — значения ставятся до импорта, чтобы модуль вообще загрузился.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  });
});

const { asReferenceConflict } = await import('../src/services/directory-purge');

/** Ошибка pg при удалении строки, на которую ссылаются: имя ссылающейся таблицы — в `table`. */
function fkViolation(table: string): unknown {
  return Object.assign(new Error('update or delete violates foreign key constraint'), {
    code: '23503',
    table,
  });
}

describe('удаление записи справочника насовсем', () => {
  it('называет, кто ссылается на запись, когда таблица знакома', () => {
    const e = asReferenceConflict(fkViolation('waste_requests'), 'тип контейнера');
    expect(e).toBeInstanceOf(AppError);
    const app = e as AppError;
    expect(app.statusCode).toBe(409);
    expect(app.message).toContain('тип контейнера');
    expect(app.message).toContain('заявки на вывоз мусора');
  });

  it('незнакомая таблица не оставляет человека без ответа', () => {
    const app = asReferenceConflict(fkViolation('some_new_table'), 'объект') as AppError;
    expect(app.statusCode).toBe(409);
    expect(app.message).toContain('другие данные');
  });

  it('чужая ошибка проходит насквозь — её разбирает общий обработчик', () => {
    const other = Object.assign(new Error('дубль'), { code: '23505' });
    expect(asReferenceConflict(other, 'объект')).toBe(other);
    const plain = new Error('связь с БД потеряна');
    expect(asReferenceConflict(plain, 'объект')).toBe(plain);
  });
});
