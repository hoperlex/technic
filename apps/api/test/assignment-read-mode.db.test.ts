import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentMode from '../src/services/assignment-mode';
import {
  ASSIGNMENT_READ_MODES,
  byReadMode,
  describeReadModes,
  useReadModeDatabase,
} from './assignment-read-mode';

/**
 * Круговая проверка самой механики двух прогонов
 * ([assignment-read-mode.ts](assignment-read-mode.ts); план
 * `docs/assignment-periods-plan.md`, подэтап 4b, У1).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. На эту механику волной 4b.2 садится два десятка файлов, и её отказ выглядит
 * не падением, а **зелёным набором**: не встань режим — прогон с именем `[read_mode = history]`
 * прошёл бы в `legacy` и подтвердил бы ровно то, что и первый. Это тот же класс беды, ради
 * которого весь подэтап и затеян: тест проходит, проверяя несуществующий мир. Поэтому механика
 * проверяется не тем, что «тесты зелёные», а прямыми вопросами к строке и к сервису.
 *
 * Четыре предмета:
 *
 * 1. **режим действительно стоит** — управляющая строка отвечает тем, чем назван прогон;
 * 2. **его видит сервис, а не только строка** — `historyIsAuthoritative` согласен с именем прогона;
 * 3. **база своя** — файл не сидит на `TEST_DATABASE_URL` и потому не топит соседей;
 * 4. **после `history` возвращается `legacy`** — остальной файл и все, кто прочтёт базу следом,
 *    видят состояние по умолчанию, а не хвост чужого прогона.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-read-mode.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const readMode = useReadModeDatabase('selftest');

/** Адрес, с которого запущен набор: своя база обязана быть **не им**. */
const SOURCE_URL = process.env.TEST_DATABASE_URL ?? '';

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  mode: typeof AssignmentMode;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  ctx = { db, closeDb, mode: await import('../src/services/assignment-mode') };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

describeReadModes(readMode, 'механика двух прогонов', (mode) => {
  it('режим стоит в управляющей строке и его видит сервис', async () => {
    // 1. Строка. Спрашивается своим соединением механики — тем, которым режим и ставился.
    expect(await readMode.currentReadMode()).toBe(mode);

    // 2. Сервис. Тот же вопрос, но глазами читателей: между строкой и `historyIsAuthoritative`
    // стоит `readAssignmentMode`, и разойдись они — параметризация проверяла бы не то.
    const snapshot = await ctx.mode.readAssignmentMode(ctx.db);
    expect(snapshot.readMode).toBe(mode);
    expect(ctx.mode.historyIsAuthoritative(snapshot)).toBe(
      byReadMode(mode, { legacy: false, history: true }),
    );

    // 3. Ссылка на поколение сверки: `history` без неё не поставить вовсе
    // (`assignment_periods_control_cutover_check`, миграция `0167`), и её наличие — доказательство,
    // что режим встал не в обход ограничения.
    expect(snapshot.cutoverRunId === null).toBe(byReadMode(mode, { legacy: true, history: false }));
  });

  it('база своя: соседей по `TEST_DATABASE_URL` файл не трогает', async () => {
    expect(readMode.url).not.toBe(SOURCE_URL);
    const [row] = (await ctx.db.execute<{ name: string }>(sql`SELECT current_database() AS name`))
      .rows;
    expect(readMode.url).toContain(`/${row!.name}`);
    expect(new URL(SOURCE_URL).pathname.slice(1)).not.toBe(row!.name);
  });
});

describe.skipIf(!readMode.enabled)('после прогонов', () => {
  it('режим вернулся в `legacy`', async () => {
    // Блок объявлен после `describeReadModes` намеренно: его `beforeAll` идёт после `afterAll`
    // последнего прогона, и именно здесь видно, что механика убрала за собой. Не убери — файл,
    // у которого параметризована только часть случаев, доигрывал бы остаток в `history`.
    expect(await readMode.currentReadMode()).toBe('legacy');
    expect(ctx.mode.historyIsAuthoritative(await ctx.mode.readAssignmentMode(ctx.db))).toBe(false);
  });

  /*
   * Окружение, которое ставит механика, обязано годиться **работающему порталу**, а не только
   * прямым вызовам сервисов. Механика однажды генерировала ключ подписи не той кривой (P-256 при
   * `EdDSA` у портала), и на файлах, зовущих сервисы напрямую, это не проявлялось вовсе — дефект
   * ждал первого, кто поднимет приложение и войдёт по логину. Такая ошибка стоит дорого: она даёт
   * `500 Invalid key type` в середине чужого случая, и ищут её в этом случае, а не в механике.
   *
   * Поэтому проверяется самое дешёвое, что покрывает весь класс: ключ из окружения принимается тем
   * же кодом, которым портал подписывает и проверяет токен.
   */
  it('ключ подписи из окружения годится порталу, а не только сервисам', async () => {
    if (!readMode.enabled) return;
    const tokens = await import('../src/auth/tokens');
    const token = await tokens.signAccessToken({
      sub: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      av: 1,
    });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims.role).toBe('admin');
  });

  it('режимов ровно два и они те же, что у управляющей строки', () => {
    // Появись третий — механика обязана узнать об этом падением, а не молча гонять два прогона из
    // трёх возможных.
    expect([...ASSIGNMENT_READ_MODES]).toEqual(['legacy', 'history']);
  });
});
