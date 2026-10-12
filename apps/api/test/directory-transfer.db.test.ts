import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DIRECTORY_DATA_SHEET,
  DIRECTORY_KEYS,
  type DirectoryKey,
  directoryTitles,
  isValidInn,
  isValidSnils,
  normalizeSnils,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as XlsxNs from '../src/lib/xlsx';
import type * as DirectoryEngineNs from '../src/services/directory-transfer/engine';
import type * as DirectoryRegistryNs from '../src/services/directory-transfer/registry';
import type { AnyDirectory } from '../src/services/directory-transfer/types';

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
 * **Чего файл не проверяет.** База у db-тестов общая и живёт между прогонами, а соседние файлы
 * заводят своих людей и контрагентов прямым SQL — минуя и форму, и загрузку справочника. Так в
 * ней накопились водители без СНИЛС и контрагенты с ИНН, не сходящимся по контрольной сумме:
 * порталом такую строку не завести (`createDriverSchema`, `routes/counterparties.ts`), а прямая
 * вставка её пропускает — CHECK таблицы смотрит только на длину. Обмен о них говорит верно: строка
 * негодна, файл не принят. Но сказано это о чужом мусоре, а не о согласии описаний с базой, и
 * поэтому такие строки из файла убираются до загрузки (`unfitIds`). Убираются поимённо — тем же
 * `isValidInn`/`isValidSnils`, которым проверяет их загрузка, — а не «замечания разрешены»: сломай
 * кто-нибудь печать ИНН, замечание придёт на каждую годную строку, и файл упадёт, как и должен.
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
  directories: (typeof DirectoryRegistryNs)['directories'];
  engine: typeof DirectoryEngineNs;
  xlsx: typeof XlsxNs;
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

/**
 * Идентификаторы строк, негодных ещё в базе, — тех, что положены туда мимо портала.
 *
 * Проверка ровно та же, какой их встретит загрузка: у контрагента ключ — ИНН (`parseInn`), у
 * водителя — СНИЛС (`check()` описания). Второго мнения о том, какой номер верен, здесь нет и быть
 * не должно: разойдись эта выборка с загрузкой хоть на одну строку — файл либо унесёт негодную,
 * либо потеряет годную, и обе беды тест обязан показать, а не спрятать.
 *
 * Справочники, где такого мусора не встречалось, отдают пустой набор: появится — придёт замечание
 * загрузки с номером строки, и разбираться будут по нему, а не гадать, что тест молча выкинул.
 */
async function unfitIds(key: DirectoryKey): Promise<ReadonlySet<string>> {
  if (key === 'counterparties') {
    const rows = await ctx.db.execute<{ id: string; inn: string }>(
      sql`SELECT id, inn FROM counterparties WHERE deleted_at IS NULL`,
    );
    return new Set(rows.rows.filter((r) => !isValidInn(r.inn)).map((r) => r.id));
  }
  if (key === 'drivers') {
    // Строка водителя — это человек: `id(row)` у описания возвращает `persons.id`.
    const rows = await ctx.db.execute<{ id: string; snils: string }>(
      sql`SELECT id, coalesce(snils, '') AS snils FROM persons WHERE deleted_at IS NULL`,
    );
    return new Set(rows.rows.filter((r) => !isValidSnils(r.snils)).map((r) => r.id));
  }
  return new Set();
}

/** Лист «Данные» выгрузки без строк, негодных ещё в базе, и сколько их выкинуто. */
async function exportFit(
  def: AnyDirectory,
): Promise<{ rows: string[][]; kept: number; dropped: number }> {
  const { bytes } = await ctx.engine.exportDirectory(def);
  const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;
  const unfit = await unfitIds(def.key);
  // Служебная колонка идентификатора у выгрузки всегда первая (`engine.exportDirectory`).
  const rows = sheet.rows.filter((row, index) => index === 0 || !unfit.has((row[0] ?? '').trim()));
  return { rows, kept: rows.length - 1, dropped: sheet.rows.length - rows.length };
}

/** Книга из одного листа данных: загрузка читает только его, «Справку» она и не открывает. */
function bookOf(rows: string[][]): Uint8Array {
  return ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]);
}

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

      const { rows, kept, dropped } = await exportFit(def!);
      const report = await ctx.engine.importDirectory(def!, bookOf(rows), {
        dryRun: true,
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });

      // Отчёт печатается в сообщение теста целиком: «изменим 12 строк» без перечня правок
      // заставило бы искать расхождение руками по всему справочнику. Рядом — сколько строк
      // выкинуто негодными: без этого числа «сверено 40 строк из 58» выглядело бы как сверка всего.
      const detail = [
        `строк в файле: ${kept}, выкинуто негодными в базе: ${dropped}`,
        JSON.stringify(
          { created: report.created, updated: report.updated, problems: report.problems },
          null,
          2,
        ),
      ].join('\n');
      expect(report.problems, detail).toEqual([]);
      expect(report.created, detail).toEqual([]);
      expect(report.updated, detail).toEqual([]);
      expect(report.unchanged, detail).toBe(kept);
    },
  );

  /**
   * Нормы расхода топлива (план `docs/fuel-norms-plan.md`, §6). Страж выше проверяет их наравне со
   * всеми, но у этого описания два свойства, которых нет больше ни у кого, и оба легко потерять:
   *
   * 1. **Файл возит срез, а правка заводит НОВУЮ версию.** Страж идёт сухим прогоном и `update()`
   *    не зовёт вовсе — значит «ничего не изменилось» он доказывает только на бумаге. Здесь
   *    загрузка идёт настоящей, и число строк таблицы до и после обязано совпасть.
   * 2. **Пустая строка законна, частично заполненная — нет.** У большинства парка нормы нет, и
   *    отвергни описание пустую строку — нетронутый файл не загрузился бы целиком.
   */
  it('«Нормы расхода»: настоящая загрузка нетронутого файла не заводит версий', async () => {
    const def = ctx.directories.find((d) => d.key === 'fuel-norms')!;
    const { rows, kept } = await exportFit(def);
    const before = await ctx.db.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM vehicle_fuel_norms`,
    );
    const report = await ctx.engine.importDirectory(def, bookOf(rows), {
      dryRun: false,
      actorUserId: '00000000-0000-0000-0000-000000000000',
    });
    const after = await ctx.db.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM vehicle_fuel_norms`,
    );

    expect(report.problems).toEqual([]);
    expect(report.unchanged).toBe(kept);
    expect(after.rows[0]!.c, 'загрузка нетронутого файла завела версии').toBe(before.rows[0]!.c);
  });

  it('«Нормы расхода»: половина нормы отвергается до записи', async () => {
    const def = ctx.directories.find((d) => d.key === 'fuel-norms')!;
    const { rows } = await exportFit(def);
    const header = rows[0]!;
    const winterAt = header.indexOf('Зимняя ставка');
    expect(winterAt, 'в выгрузке норм нет колонки зимней ставки').toBeGreaterThan(0);

    // Ставка без единицы и без летней ставки: строка заполнена наполовину, и запись с пустыми
    // числами ушла бы нарушением NOT NULL — то есть пятисоткой вместо человеческих слов.
    const broken = rows.map((row, index) =>
      index === 1 ? row.map((cell, at) => (at === winterAt ? '42' : cell)) : row,
    );
    const report = await ctx.engine.importDirectory(def, bookOf(broken), {
      dryRun: true,
      actorUserId: '00000000-0000-0000-0000-000000000000',
    });
    expect(report.problems.join(' ')).toContain('Норма заполняется целиком');
  });

  it('«Контрагенты»: общий email выгружается и принимается обратно', async () => {
    const def = ctx.directories.find((d) => d.key === 'counterparties')!;
    const { rows } = await exportFit(def);
    const header = rows[0]!;
    const emailAt = header.indexOf('Email для заявок');
    expect(emailAt, 'в выгрузке контрагентов нет общего email').toBeGreaterThan(0);

    const target = rows[1];
    expect(target, 'в справочнике нет годного контрагента для проверки email').toBeDefined();
    const nextEmail = `directory-${randomUUID()}@example.invalid`;
    const edited = rows.map((row, index) =>
      index === 1 ? row.map((cell, at) => (at === emailAt ? nextEmail : cell)) : row,
    );

    const report = await ctx.engine.importDirectory(def, bookOf(edited), {
      dryRun: true,
      actorUserId: '00000000-0000-0000-0000-000000000000',
    });
    expect(report.problems).toEqual([]);
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]!.changes).toContainEqual({
      column: 'Email для заявок',
      from: target![emailAt] ?? '',
      to: nextEmail,
    });
  });

  it(
    'правка ячейки доезжает до базы, а неизменённые строки остаются нетронутыми',
    { timeout: 30_000 },
    async () => {
      const def = ctx.directories.find((d) => d.key === 'objects')!;
      const { rows } = await exportFit(def);

      const nameAt = rows[0]!.indexOf('Наименование');
      const idAt = 0;
      const target = rows[1];
      expect(target, 'в справочнике объектов нет ни одной записи — проверять нечего').toBeDefined();
      const objectId = target![idAt]!;
      const before = target![nameAt]!;
      const after = `${before} (сверка обмена)`;

      const edited = rows.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? after : cell)) : row,
      );
      const editedBytes = bookOf(edited);

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
      const { rows: fit } = await exportFit(def);
      const nameAt = fit[0]!.indexOf('Наименование');

      // Первая строка меняется законно, вторая — с пустым обязательным наименованием у новой записи.
      const rows = fit.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? `${cell} (сверка)` : cell)) : row,
      );
      rows.push(['', ...fit[0]!.slice(1).map(() => '')].map((c, at) => (at === 1 ? 'zz_new' : c)));
      const broken = bookOf(rows);

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

  it(
    'удостоверение тракториста по одним реквизитам, без категорий, доезжает до базы',
    { timeout: 30_000 },
    async () => {
      /**
       * Синтетический СНИЛС: блок «9xx» ПФР не выдаёт, и живому человеку такой номер не
       * принадлежит. Контрольная сумма у него при этом настоящая — иначе строку отвергнет
       * `check()`: девять цифр 900 000 000 на позициях 9…1 дают 9×9 = 81, и последние две цифры
       * номера её повторяют.
       */
      const snils = '900-000-000 81';
      const snilsDigits = '90000000081';
      /** Номер удостоверения — единственный реквизит, по которому документ обязан завестись. */
      const number = '112233';

      const def = ctx.directories.find((d) => d.key === 'drivers')!;
      // Загрузка здесь настоящая, и негодная строка отменила бы весь файл — включая ту, ради
      // которой тест и написан: справочник берётся без строк, испорченных в базе мимо портала.
      const { rows } = await exportFit(def);
      const header = rows[0]!;
      const at = (column: string): number => {
        const index = header.indexOf(column);
        expect(index, `в выгрузке водителей нет колонки «${column}»`).toBeGreaterThan(0);
        return index;
      };

      // Строка дописывается новой: колонка идентификатора пуста, по СНИЛС человек в справочнике не
      // найдётся — загрузка заведёт его. Ячейки ставятся по именам колонок, а не по местам: блоки
      // документов собираются перечнем видов, и порядок колонок меняется вместе с ним.
      const added = header.map(() => '');
      added[at('ФИО')] = 'Тестовый Обмен Механизаторович';
      added[at('СНИЛС')] = snils;
      added[at('Должность')] = 'Машинист экскаватора';
      added[at('Номер УТМ')] = number;
      added[at('Выдано УТМ')] = '05.04.2023';
      // «Категории УТМ» остаются пустыми: ровно эту строку файл прежде и терял — документ по ней
      // не заводился вовсе, и загруженные реквизиты удостоверения молча пропадали.
      const editedBytes = bookOf([...rows, added]);

      // Автор записи проставляется и человеку, и документу, а `persons.created_by` смотрит в
      // `users`: вымышленный ноль-UUID соседних тестов внешний ключ не пропустит. Учётка заводится
      // ради одного этого поля — войти по ней нельзя — и убирается вместе с человеком.
      const actor = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, password_hash)
        VALUES (${`directory-transfer-${randomUUID()}@example.invalid`},
                'Обменов', 'Тест', 'не пароль: учётка нужна только как автор записи')
        RETURNING id`);
      const actorUserId = actor.rows[0]!.id;

      try {
        const report = await ctx.engine.importDirectory(def, editedBytes, {
          dryRun: false,
          actorUserId,
        });
        expect(report.created, JSON.stringify(report.problems)).toHaveLength(1);

        const document = await ctx.db.execute<{
          id: string;
          number: string;
          issued_on: string;
        }>(sql`
          SELECT pc.id, pc.number, pc.issued_on::text AS issued_on
            FROM person_credentials pc
            JOIN credential_types ct ON ct.id = pc.credential_type_id
            JOIN persons p ON p.id = pc.person_id
           WHERE p.snils = ${snilsDigits} AND ct.code = 'tractor_license'`);
        expect(document.rows, 'документ УТМ по одним реквизитам до базы не доехал').toHaveLength(1);
        expect(document.rows[0]!.number).toBe(number);
        expect(document.rows[0]!.issued_on).toBe('2023-04-05');

        const categories = await ctx.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM person_credential_categories
               WHERE credential_id = ${document.rows[0]!.id}::uuid`,
        );
        expect(categories.rows[0]?.n).toBe('0');

        // Обратная половина того же правила: пустой блок ВУ документа не заводит — иначе первая же
        // загрузка выдала бы каждому машинисту по пустому водительскому удостоверению.
        const empty = await ctx.db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n
            FROM person_credentials pc
            JOIN credential_types ct ON ct.id = pc.credential_type_id
            JOIN persons p ON p.id = pc.person_id
           WHERE p.snils = ${snilsDigits} AND ct.code = 'driver_license'`);
        expect(empty.rows[0]?.n).toBe('0');
      } finally {
        // База у db-тестов общая, и человек с персональными данными в ней не остаётся ни в каком
        // виде: удаляется всё, что завела строка, — снизу вверх по внешним ключам.
        const person = sql`(SELECT id FROM persons WHERE snils = ${snilsDigits})`;
        await ctx.db.execute(
          sql`DELETE FROM person_credential_categories WHERE credential_id IN
                (SELECT id FROM person_credentials WHERE person_id IN ${person})`,
        );
        await ctx.db.execute(sql`DELETE FROM person_credentials WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM person_employments WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM person_specializations WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM persons WHERE snils = ${snilsDigits}`);
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${actorUserId}::uuid`);
      }
    },
  );

  /**
   * A driver's e-mail on the live schema. It took over from the e-mail test of the JSON import,
   * deleted together with it (ADR 0073, decision 14). The trip assignment is sent to this address,
   * and the parts of its rule only a write can show are: a new person gets the address from the
   * row; a changed address reaches `persons` and raises the card version — otherwise a card form
   * open elsewhere would save over it and bring the old address back; an empty cell does not erase
   * it; the preview writes nothing.
   *
   * The file holds only the header and this test's rows. The engine leaves alone what the file
   * omits, and a full export would race with neighbour files adding and removing people in the
   * shared database.
   */
  it(
    'driver e-mail: set on creation, changed with a version bump, never erased by an empty cell',
    { timeout: 30_000 },
    async () => {
      /**
       * Generated, not fixed: an aborted run leaves its person behind, and a fixed number would turn
       * the next run's creation into an update. The «9xx» block is never issued by the pension fund,
       * so no living person owns such a number; the checksum is real, or `check()` rejects the row.
       */
      const syntheticSnils = (): string => {
        const body = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
        const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (9 - i), 0);
        const rest = sum < 100 ? sum : sum % 101;
        return `${body}${String(rest === 100 ? 0 : rest).padStart(2, '0')}`;
      };
      const withEmail = syntheticSnils();
      let withoutEmail = syntheticSnils();
      while (withoutEmail === withEmail) withoutEmail = syntheticSnils();
      expect(isValidSnils(withEmail) && isValidSnils(withoutEmail)).toBe(true);
      const firstAddress = `driver-${randomUUID()}@example.invalid`;
      const nextAddress = `driver-${randomUUID()}@example.invalid`;

      const def = ctx.directories.find((d) => d.key === 'drivers')!;
      const header = (await exportFit(def)).rows[0]!;
      const at = (column: string): number => {
        const index = header.indexOf(column);
        expect(index, `the drivers export has no «${column}» column`).toBeGreaterThan(0);
        return index;
      };
      const newRow = (fullName: string, snils: string, email: string): string[] => {
        const row = header.map(() => '');
        row[at('ФИО')] = fullName;
        row[at('СНИЛС')] = snils;
        row[at('Email')] = email;
        return row;
      };
      const withEmailCell = (row: string[], email: string): string[] =>
        row.map((cell, index) => (index === at('Email') ? email : cell));
      const personOf = async (snils: string) =>
        (
          await ctx.db.execute<{ email: string; version: number }>(
            sql`SELECT email, version FROM persons WHERE snils = ${snils} AND deleted_at IS NULL`,
          )
        ).rows[0];

      // `persons.created_by` and `updated_by` point at `users`, so the author is a real account
      // that cannot sign in and goes away with the people it created.
      const actor = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, password_hash)
        VALUES (${`directory-transfer-${randomUUID()}@example.invalid`},
                'Обменов', 'Тест', 'не пароль: учётка нужна только как автор записи')
        RETURNING id`);
      const actorUserId = actor.rows[0]!.id;
      const apply = (rows: string[][], dryRun: boolean) =>
        ctx.engine.importDirectory(def, bookOf([header, ...rows]), { dryRun, actorUserId });

      try {
        const created = await apply(
          [
            newRow('Почтов Иван Иванович', withEmail, firstAddress),
            newRow('Безадресов Пётр Петрович', withoutEmail, ''),
          ],
          false,
        );
        expect(created.problems).toEqual([]);
        expect(created.created).toHaveLength(2);
        expect((await personOf(withEmail))?.email).toBe(firstAddress);
        expect((await personOf(withoutEmail))?.email).toBe('');
        const createdVersion = (await personOf(withEmail))!.version;

        // The row as the portal exports it, with the id column filled in: this is the file a person
        // downloads, edits and loads back.
        const exported = (await exportFit(def)).rows.find(
          (row) => normalizeSnils(row[at('СНИЛС')] ?? '') === withEmail,
        );
        expect(exported, 'the created driver is missing from the export').toBeDefined();
        const changed = withEmailCell(exported!, nextAddress);

        const preview = await apply([changed], true);
        expect(preview.updated).toHaveLength(1);
        expect(preview.updated[0]!.changes).toEqual([
          { column: 'Email', from: firstAddress, to: nextAddress },
        ]);
        expect(await personOf(withEmail)).toMatchObject({
          email: firstAddress,
          version: createdVersion,
        });

        const applied = await apply([changed], false);
        expect(applied.updated).toHaveLength(1);
        expect(await personOf(withEmail)).toMatchObject({
          email: nextAddress,
          version: createdVersion + 1,
        });

        // The same address again and an empty cell are both «no change»: nothing is written and
        // the version stays, so an open card form is not invalidated by a no-op load.
        for (const row of [changed, withEmailCell(changed, '')]) {
          const again = await apply([row], false);
          expect(again.problems).toEqual([]);
          expect(again.updated).toEqual([]);
          expect(again.unchanged).toBe(1);
        }
        expect(await personOf(withEmail)).toMatchObject({
          email: nextAddress,
          version: createdVersion + 1,
        });
      } finally {
        // The database is shared, and no person with personal data stays in it in any form:
        // everything the rows created is deleted bottom-up along the foreign keys.
        const people = sql`(SELECT id FROM persons WHERE snils IN (${withEmail}, ${withoutEmail}))`;
        await ctx.db.execute(
          sql`DELETE FROM person_credential_categories WHERE credential_id IN
                (SELECT id FROM person_credentials WHERE person_id IN ${people})`,
        );
        await ctx.db.execute(sql`DELETE FROM person_credentials WHERE person_id IN ${people}`);
        await ctx.db.execute(sql`DELETE FROM person_employments WHERE person_id IN ${people}`);
        await ctx.db.execute(sql`DELETE FROM person_specializations WHERE person_id IN ${people}`);
        await ctx.db.execute(
          sql`DELETE FROM persons WHERE snils IN (${withEmail}, ${withoutEmail})`,
        );
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${actorUserId}::uuid`);
      }
    },
  );
});
