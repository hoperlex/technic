import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  closingKindsForFormat,
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_DOCUMENT_FORMAT_CLOSING_KINDS,
} from '@technic/contracts';

/**
 * SQL-редакция правила «какая бумага закрывает заявку» (Э3 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р5) — и ИНВАРИАНТ ВОЛНЫ: снаружи
 * поведение не меняется нигде.
 *
 * ЗАЧЕМ ФАЙЛ БЕЗ БАЗЫ, КОГДА ЕСТЬ МАТРИЦА НА ЖИВОЙ БАЗЕ. Матрица эквивалентности (§6 плана) сверяет
 * ОТВЕТЫ двух редакций правила по клеткам и делает это лучше любого разбора текста — но db-тесты
 * пропускаются без `TEST_DATABASE_URL`, то есть в обычном прогоне защиты нет вовсе. Здесь проверяется
 * то, что проверяется без базы: перечни видов в SQL не переписаны словами, а приходят из тех же
 * констант контрактов, и ветка наследия выбрана по умолчанию.
 *
 * ВТОРОЙ ПРЕДМЕТ — КВАЛИФИКАЦИЯ КОРРЕЛЯЦИИ. Условие цепляется за строку внешнего запроса, а drizzle,
 * собирая список столбцов односоставного запроса, переписывает колоночные чанки в голые
 * идентификаторы: `"service_requests"."id"` стало бы `"id"` и разрешилось бы в таблицу подзапроса,
 * то есть условие выродилось бы в тавтологию «закрывающий документ есть всегда». Отказа при этом не
 * бывает (подробнее — `office-equipment-sql-correlation.test.ts`).
 */

/**
 * Конфиг проверяет окружение при импорте, а модуль условия тянет клиента базы — поэтому переменные
 * выставляются до первого `await import`. Адрес базы заведомо нерабочий: этот файл не выполняет
 * запросов вовсе, он читает их текст.
 */
function подготовитьОкружение(): void {
  process.env.DATABASE_URL ??= 'postgres://sql-shape:sql-shape@127.0.0.1:1/none';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

let собранный: { sql: string; params: unknown[] };
let вСпискеСтолбцов: string;

beforeAll(async () => {
  подготовитьОкружение();
  const { generateKeyPairSync } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
  const { db } = await import('../src/db/client');
  const { serviceRequests } = await import('../src/db/schema');
  const { serviceHasClosingDocumentSql } =
    await import('../src/services/service-estimate-revision');
  const условие = serviceHasClosingDocumentSql(serviceRequests.id);
  собранный = db.select({ id: serviceRequests.id }).from(serviceRequests).where(условие).toSQL();
  // Та же форма, в которой ловушка drizzle и срабатывает: одна таблица во `FROM`, условие — в
  // списке столбцов.
  вСпискеСтолбцов = db
    .select({ x: sql`1`, closing: serviceHasClosingDocumentSql(serviceRequests.id) })
    .from(serviceRequests)
    .toSQL().sql;
});

describe('закрывающий документ: SQL-редакция правила', () => {
  it('перечни видов приходят из контрактов, а не переписаны словами', () => {
    // Порядок параметров — порядок ветвей `CASE`: документная сперва, наследие вторым.
    expect(собранный.params).toEqual([
      [...SERVICE_DOCUMENT_FORMAT_CLOSING_KINDS],
      [...SERVICE_CLOSING_DOCUMENT_KINDS],
    ]);
    // Вид документа в тексте не назван ни разу: назови — и перечень разошёлся бы с контрактами молча.
    expect(собранный.sql).not.toContain("'act'");
    expect(собранный.sql).not.toContain("'invoice'");
    expect(собранный.sql).not.toContain("'warranty_card'");
  });

  it('формат спрашивается у ДЕЙСТВУЮЩЕЙ ревизии, и сужает перечень только документный', () => {
    expect(собранный.sql).toContain("scr.state = 'active'");
    expect(собранный.sql).toContain("= 'document'");
    // Ни `items`, ни `warranty` в условии не упомянуты вовсе — и это инвариант волны, а не
    // экономия: у построчной и гарантийной ревизии планка обязана остаться наследственной, то есть
    // отвечать веткой `ELSE`. Появись здесь их имена — значит появилась и ветка, которой снаружи
    // видно не должно быть.
    expect(собранный.sql).not.toContain("'items'");
    expect(собранный.sql).not.toContain("'warranty'");
  });

  it('роль файла — вторая половина правила и спрашивается прямым сравнением', () => {
    expect(собранный.sql).toContain("scf.purpose = 'closing_evidence'");
  });

  it('ссылка на внешнюю строку остаётся квалифицированной даже в списке столбцов', () => {
    expect(собранный.sql).toContain('scf.request_id = "service_requests"."id"');
    expect(вСпискеСтолбцов).toContain('scf.request_id = "service_requests"."id"');
  });
});

describe('инвариант волны: наследственная планка не тронута', () => {
  it('построчная и гарантийная ревизия закрываются тем же, чем заявка без ревизий', () => {
    expect(closingKindsForFormat('items')).toEqual([...SERVICE_CLOSING_DOCUMENT_KINDS]);
    expect(closingKindsForFormat('warranty')).toEqual([...SERVICE_CLOSING_DOCUMENT_KINDS]);
    expect(closingKindsForFormat(null)).toEqual([...SERVICE_CLOSING_DOCUMENT_KINDS]);
    // Сужение — только у документной подачи, которую ручка предъявления этого выпуска не принимает.
    expect(closingKindsForFormat('document')).toEqual(['act']);
  });
});
