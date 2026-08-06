import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DIRECTORY_DATA_SHEET, DIRECTORY_KEYS, directoryTitles } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';

/**
 * Обмен справочниками (ADR 0073) на живой схеме и настоящих данных.
 *
 * Юнит-тесты описаний проверяют правила по одной строке, но главное свойство обмена они поймать не
 * могут: **выгруженный файл обязан загружаться без единой правки**. Оно держится не на одном
 * модуле, а на совпадении трёх вещей — как строка справочника превращается в модель, как модель
 * печатается в ячейку и как ячейка разбирается обратно. Разойтись им достаточно в одном знаке:
 * лишний ноль в цене, «C1E» вместо «c1e», дата в другом порядке — и человек, ничего не менявший,
 * видит отчёт «изменим 240 строк» и не понимает, чему верить.
 *
 * Справочники здесь настоящие — те, что наполнили миграции: типы ТС, ТТХ, категории, парк,
 * прайс. Заводить их руками бессмысленно: проверяется как раз согласие описаний с тем, что
 * реально лежит в проде.
 *
 * Запуск (база пустая или уже промигрированная — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test directory-transfer.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  directories: (typeof import('../src/services/directory-transfer/registry'))['directories'];
  engine: typeof import('../src/services/directory-transfer/engine');
  xlsx: typeof import('../src/lib/xlsx');
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  // Ключи подписи конфиг требует при импорте, хотя обмену они не нужны: вход в портал здесь не
  // участвует — файл собирает и разбирает сервис, а не маршрут.
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  if (!DB_URL) return;
  prepareEnv(DB_URL);
  await migrate(DB_URL);
  const { db } = await import('../src/db/client');
  ctx = {
    db,
    directories: (await import('../src/services/directory-transfer/registry')).directories,
    engine: await import('../src/services/directory-transfer/engine'),
    xlsx: await import('../src/lib/xlsx'),
  };
}, 60_000);

const suite = DB_URL ? describe : describe.skip;

suite('обмен справочниками на живой схеме', () => {
  it('обменом охвачены все справочники, объявленные порталу', () => {
    expect(ctx.directories.map((d) => d.key)).toEqual([...DIRECTORY_KEYS]);
  });

  it.each(DIRECTORY_KEYS)(
    '«%s»: выгруженный файл загружается без единой правки',
    /**
     * Повтор — не борьба с плавающим дефектом, а различение двух разных вещей. База у db-тестов
     * общая, файлы vitest идут параллельно, и соседний тест вправе завести и удалить человека
     * ровно между выгрузкой и загрузкой — тогда строка файла ссылается на исчезнувшую запись.
     * Настоящее расхождение описаний с базой воспроизводится каждый раз и переживёт любой повтор,
     * а гонка со вставкой соседа — нет.
     */
    { timeout: 30_000, retry: 2 },
    async (key) => {
      const def = ctx.directories.find((d) => d.key === key);
      expect(def, `нет описания справочника ${key}`).toBeDefined();

      const { bytes, rows } = await ctx.engine.exportDirectory(def!);
      const report = await ctx.engine.importDirectory(def!, bytes, {
        dryRun: true,
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });

      // Отчёт печатается в сообщение теста целиком: «изменим 12 строк» без перечня правок
      // заставило бы искать расхождение руками по всему справочнику.
      const detail = JSON.stringify(
        { created: report.created, updated: report.updated, problems: report.problems },
        null,
        2,
      );
      expect(report.problems, detail).toEqual([]);
      expect(report.created, detail).toEqual([]);
      expect(report.updated, detail).toEqual([]);
      expect(report.unchanged).toBe(rows);
    },
  );

  it(
    'правка ячейки доезжает до базы, а неизменённые строки остаются нетронутыми',
    { timeout: 30_000 },
    async () => {
      const def = ctx.directories.find((d) => d.key === 'objects')!;
      const { bytes } = await ctx.engine.exportDirectory(def);
      const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;

      const nameAt = sheet.rows[0]!.indexOf('Наименование');
      const idAt = 0;
      const target = sheet.rows[1];
      expect(target, 'в справочнике объектов нет ни одной записи — проверять нечего').toBeDefined();
      const objectId = target![idAt]!;
      const before = target![nameAt]!;
      const after = `${before} (сверка обмена)`;

      const edited = sheet.rows.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? after : cell)) : row,
      );
      const editedBytes = ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows: edited }]);

      const preview = await ctx.engine.importDirectory(def, editedBytes, {
        dryRun: true,
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });
      expect(preview.updated).toHaveLength(1);
      expect(preview.updated[0]!.changes).toEqual([
        { column: 'Наименование', from: before, to: after },
      ]);

      try {
        await ctx.engine.importDirectory(def, editedBytes, {
          dryRun: false,
          actorUserId: '00000000-0000-0000-0000-000000000000',
        });
        const res = await ctx.db.execute<{ name: string }>(
          sql`SELECT name FROM construction_objects WHERE id = ${objectId}::uuid`,
        );
        expect(res.rows[0]?.name).toBe(after);
      } finally {
        // Справочник возвращается в исходное состояние: база у db-тестов общая, и следующий прогон
        // не должен находить в ней следы предыдущего.
        await ctx.db.execute(
          sql`UPDATE construction_objects SET name = ${before} WHERE id = ${objectId}::uuid`,
        );
      }
    },
  );

  it(
    'негодная строка отменяет весь файл — в базе не остаётся половины загрузки',
    { timeout: 30_000 },
    async () => {
      const def = ctx.directories.find((d) => d.key === 'objects')!;
      const { bytes } = await ctx.engine.exportDirectory(def);
      const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;
      const nameAt = sheet.rows[0]!.indexOf('Наименование');

      // Первая строка меняется законно, вторая — с пустым обязательным наименованием у новой записи.
      const rows = sheet.rows.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? `${cell} (сверка)` : cell)) : row,
      );
      rows.push(
        ['', ...sheet.rows[0]!.slice(1).map(() => '')].map((c, at) => (at === 1 ? 'zz_new' : c)),
      );
      const broken = ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]);

      await expect(
        ctx.engine.importDirectory(def, broken, {
          dryRun: false,
          actorUserId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow();

      const check = await ctx.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM construction_objects WHERE code = 'zz_new'`,
      );
      expect(check.rows[0]?.n).toBe('0');
      expect(directoryTitles.objects).toBe('Объекты');
    },
  );
});
