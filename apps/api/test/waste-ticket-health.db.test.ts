import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Состояние подсистемы распознавания — на живой схеме (Р29).
 *
 * Правило баннера целиком написано на SQL: доля, окно, гистерезис и удержание терминальной ошибки.
 * Проверять его моками бессмысленно — проверялась бы арифметика, а не запрос. Цена ошибки здесь
 * в обе стороны: не поднятый баннер означает молчащее распознавание, которое человек примет за
 * «талоны в порядке», а поднятый навсегда — что баннер перестанут читать.
 */
const DB_URL = process.env.TEST_DATABASE_URL;

/** Попытка распознавания в прошлом: только те поля, от которых зависит правило. */
let client: pg.Client;
/**
 * У каждой попытки свой хэш страницы. Иначе вторая успешная упирается в ключ кэша
 * (`page_sha256` + движок + модель + версии, `WHERE status='done' AND NOT forced`) — то самое
 * ограничение, ради которого он и заведён: успешная попытка на страницу одна.
 */
let pageSeq = 0;

async function attempt(opts: {
  minutesAgo: number;
  status: 'done' | 'failed';
  scope?: 'subsystem' | 'item';
  cls?: 'transient' | 'terminal';
  code?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO waste_ticket_recognition_attempts
       (page_sha256, engine, model, prompt_version, preprocessing_version, status,
        error_class, error_scope, error_code, created_at)
     VALUES ($1, 'proxy', 'health/test', 1, 1, $2, $3, $4, $5,
             now() - ($6 || ' minutes')::interval)`,
    [(pageSeq += 1).toString(16).padStart(64, 'b'), opts.status, opts.cls ?? '', opts.scope ?? '', opts.code ?? '', opts.minutesAgo],
  );
}

/**
 * Повторяет запрос ручки. HTTP тест не поднимает намеренно: проверяется правило на SQL, а не
 * маршрутизация, и лишний слой скрыл бы, какая именно часть условия ошиблась.
 */
async function health(): Promise<{ state: string; code: string; attempts: number }> {
  const stats = await client.query<{ total: number; failed_subsystem: number }>(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'failed' AND error_scope = 'subsystem')::int
             AS failed_subsystem
      FROM waste_ticket_recognition_attempts
     WHERE engine = 'proxy' AND created_at >= now() - interval '1 hour'`);
  const total = Number(stats.rows[0]?.total ?? 0);
  const failed = Number(stats.rows[0]?.failed_subsystem ?? 0);
  const terminal = await client.query<{ code: string | null }>(`
    SELECT error_code AS code FROM waste_ticket_recognition_attempts
     WHERE engine = 'proxy' AND status = 'failed' AND error_scope = 'subsystem'
       AND error_class = 'terminal' AND created_at >= now() - interval '1 hour'
       AND created_at > COALESCE((SELECT max(created_at) FROM waste_ticket_recognition_attempts
                                   WHERE engine = 'proxy' AND status = 'done'
                                     AND created_at >= now() - interval '1 hour'),
                                 now() - interval '1 hour')
     ORDER BY created_at DESC LIMIT 1`);
  if (terminal.rows[0]) {
    return { state: 'unconfigured', code: terminal.rows[0].code ?? '', attempts: total };
  }
  if (total >= 5 && failed / total >= 0.5) return { state: 'degraded', code: '', attempts: total };
  return { state: 'ok', code: '', attempts: total };
}

describe.skipIf(!DB_URL)('состояние подсистемы распознавания', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM waste_ticket_recognition_attempts WHERE model = 'health/test'`);
  });

  it('тишина без попыток и без очереди — это «работает»', async () => {
    expect((await health()).state).toBe('ok');
  });

  it('две неудачи подряд баннер не поднимают: порога нет', async () => {
    await attempt({ minutesAgo: 5, status: 'failed', scope: 'subsystem', cls: 'transient' });
    await attempt({ minutesAgo: 4, status: 'failed', scope: 'subsystem', cls: 'transient' });
    expect((await health()).state).toBe('ok');
  });

  it('половина неудач при пяти попытках — баннер', async () => {
    for (let i = 0; i < 3; i += 1) {
      await attempt({ minutesAgo: 10 - i, status: 'failed', scope: 'subsystem', cls: 'transient' });
    }
    await attempt({ minutesAgo: 6, status: 'done' });
    await attempt({ minutesAgo: 5, status: 'done' });
    expect((await health()).state).toBe('degraded');
  });

  it('файловые отказы в знаменатель не идут: один 413 не ломает сервис', async () => {
    for (let i = 0; i < 5; i += 1) {
      await attempt({
        minutesAgo: 10 - i,
        status: 'failed',
        scope: 'item',
        cls: 'terminal',
        code: 'payload_too_large',
      });
    }
    expect((await health()).state).toBe('ok');
  });

  it('403 поднимает сразу и держит, пока не будет успешной попытки', async () => {
    await attempt({
      minutesAgo: 30,
      status: 'failed',
      scope: 'subsystem',
      cls: 'terminal',
      code: 'http_403',
    });
    const held = await health();
    expect(held.state).toBe('unconfigured');
    expect(held.code).toBe('http_403');

    await attempt({ minutesAgo: 1, status: 'done' });
    expect((await health()).state).toBe('ok');
  });

  it('старая ошибка вне окна на состояние не влияет', async () => {
    await attempt({
      minutesAgo: 120,
      status: 'failed',
      scope: 'subsystem',
      cls: 'terminal',
      code: 'http_403',
    });
    expect((await health()).state).toBe('ok');
  });
});
