import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
// Только типы: значения каркаса берутся через `await import` уже после того, как выставлено
// окружение, — он транзитивно тянет клиент базы, а клиент читает конфиг при импорте.
import type * as AssignmentCommand from '../src/services/assignment-command';
import {
  assignmentCommandEffects,
  type AssignmentMutation,
} from '../src/services/assignment-effects';
import type { AssignmentTerm } from '../src/services/assignment-history';

/**
 * Критерий шага 7 канона: у кого каркас спрашивает подтверждённый предпросмотр
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р17, этап Э4а).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ И ПОЧЕМУ ЧИСТЫЙ. До этого этапа критерий был один — «у команды непустая
 * история назначения», — и дверь правки срока его обходила своей сверкой отпечатка: у продления
 * строк истории нет вовсе, а листы при этом сгорают и выписываются. Обход убран, критерий
 * переехал в каркас признаком `requiresPreview`, и теперь у общего на пять дверей правила есть
 * две ветви: умолчание и объявленный признак. Доказывать их сценами дверей дорого и неполно —
 * ветвь «признак снимает вопрос» ни одна сегодняшняя дверь не занимает вовсе, а завтра её займёт
 * закрытие заказа арендодателем.
 *
 * ЧТО ЗДЕСЬ ЛОВИТСЯ. Ошибка в этом месте не падает и не пишет в лог: слишком мягкий критерий
 * пропускает боевую команду без подтверждения — человек видел одни последствия, применились
 * другие; слишком строгий отвечает 409 там, где подтверждать нечего, и дверь перестаёт работать
 * вовсе. Поэтому здесь же закреплены **код и текст отказа**: портал разбирает 409 по коду
 * `assignment_preview_stale`, и смена текста или кода была бы для него другой ошибкой на том же
 * месте.
 */

let command: typeof AssignmentCommand;

/*
 * Базы этому файлу не нужно ни строки, но каркас тянет схему и клиент базы, а клиент читает
 * конфиг при импорте. Поэтому окружение выставляется до импорта, а сам импорт отложен — тот же
 * приём и по той же причине, что у `assignment-shorten-term.test.ts`. Адрес базы заведомо
 * нерабочий: соединения не будет, пул `pg` при создании никуда не ходит.
 */
beforeAll(async () => {
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  command = await import('../src/services/assignment-command');
});

const TERM: AssignmentTerm = { dateFrom: '2026-03-01', dateTo: '2026-03-31' };
/** День расчёта — календарный ключ, один на всю команду (Р32). */
const AS_OF = '2026-03-10';
/** Отпечаток, который дверь посчитала и показала человеку в предпросмотре. */
const FINGERPRINT = 'отпечаток-предпросмотра';
/** Текст и код отказа шага 7 — ровно те, что портал разбирает сегодня. */
const STALE_MESSAGE =
  'Последствия изменились с момента предпросмотра — посмотрите их заново и подтвердите';
const STALE_CODE = 'assignment_preview_stale';

/** Посчитанное дверью: последствия, отпечаток и предметный план (этому файлу план не нужен). */
function planned(mutations: AssignmentMutation[]): AssignmentCommand.AssignmentPlanned<null> {
  return {
    effects: assignmentCommandEffects({ changes: [], term: TERM, asOf: AS_OF, mutations }),
    fingerprint: FINGERPRINT,
    plan: null,
  };
}

/** Команда без единой строки истории: так выглядит продление срока и закрытие ровно по `date_to`. */
const emptyHistory = () => planned([]);

/** Команда со строкой истории: обычная смена машины — она непуста по прежнему критерию. */
const withHistory = () =>
  planned([{ kind: 'insert', dimension: 'vehicle', effectiveDate: AS_OF, origin: 'assignment' }]);

/** Отказ как объект: `toThrow` не даёт посмотреть ни код, ни статус, а проверяются именно они. */
function refusalOf(run: () => void): Error & { statusCode?: number; code?: string } {
  try {
    run();
  } catch (e) {
    return e as Error & { statusCode?: number; code?: string };
  }
  throw new Error('ожидался отказ, а критерий пропустил команду');
}

describe('шаг 7: критерий подтверждённого предпросмотра (Р17)', () => {
  it('дверь без `requiresPreview` ведёт себя по старому критерию: пустая история — вопроса нет', () => {
    // Ни машинист, ни ремонт, ни коррекция признака не объявляют, и для них ничего не изменилось:
    // при пустых `effects.mutations` отпечаток не спрашивается — ни отсутствующий, ни вчерашний.
    expect(() => command.requireFingerprint({}, emptyHistory())).not.toThrow();
    expect(() =>
      command.requireFingerprint({ previewFingerprint: 'вчерашний' }, emptyHistory()),
    ).not.toThrow();
  });

  it('дверь без `requiresPreview`: непустая история требует совпавший отпечаток', () => {
    expect(() =>
      command.requireFingerprint({ previewFingerprint: FINGERPRINT }, withHistory()),
    ).not.toThrow();

    const stale = refusalOf(() =>
      command.requireFingerprint({ previewFingerprint: 'вчерашний' }, withHistory()),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.code).toBe(STALE_CODE);
    expect(stale.message).toBe(STALE_MESSAGE);

    // Не присланный отпечаток — тот же 409, а не 400: пуста команда или нет, видно только после
    // расчёта под блокировкой.
    expect(refusalOf(() => command.requireFingerprint({}, withHistory())).statusCode).toBe(409);
  });

  it('`requiresPreview: () => true` спрашивает отпечаток и при пустой истории — как дверь срока', () => {
    const door = { requiresPreview: () => true };

    const stale = refusalOf(() =>
      command.requireFingerprint({ ...door, previewFingerprint: 'вчерашний' }, emptyHistory()),
    );
    // Тот же код и тот же текст, каким до Э4а отвечало собственное рукопожатие двери срока: для
    // портала это обязано остаться одной и той же ошибкой на одном и том же месте.
    expect(stale.statusCode).toBe(409);
    expect(stale.code).toBe(STALE_CODE);
    expect(stale.message).toBe(STALE_MESSAGE);

    expect(() =>
      command.requireFingerprint({ ...door, previewFingerprint: FINGERPRINT }, emptyHistory()),
    ).not.toThrow();
  });

  it('признак считается по рассчитанному плану и сильнее умолчания в обе стороны', () => {
    // Дверь видит именно то, что посчитал её шаг 6: раньше расчёта ответа на вопрос «нужен ли
    // предпросмотр» не существует — у закрытия он зависит от выбранной ветви (Р16).
    const seen: AssignmentCommand.AssignmentPlanned<null>[] = [];
    const calculated = withHistory();
    command.requireFingerprint(
      {
        previewFingerprint: FINGERPRINT,
        requiresPreview: (p) => {
          seen.push(p);
          return true;
        },
      },
      calculated,
    );
    expect(seen).toEqual([calculated]);

    // И обратная сторона: сказавшая «нет» дверь отпечатка не спрашивает даже при непустой истории.
    // Эту ветвь займёт закрытие заказа арендодателем, которое не трогает ни срока, ни бумаги.
    expect(() =>
      command.requireFingerprint({ requiresPreview: () => false }, withHistory()),
    ).not.toThrow();
  });
});
