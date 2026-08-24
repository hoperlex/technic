/**
 * Приведение локальной базы разработки в рабочее состояние — одной командой (`pnpm dev:db`).
 *
 * ЗАЧЕМ. Сервер отказывается стартовать на схеме, отставшей от кода (`assertMigrationsApplied`), и
 * это правильно: молча работать на чужой схеме хуже, чем не работать вовсе. Но снаружи отказ выглядит
 * как «Bad Gateway» на любой странице портала — веб проксирует к API, которого нет, — и чтобы дойти
 * до настоящей причины, приходится поднимать сервер руками и читать его первую строку. За один день
 * это случилось трижды: миграции приезжают и от соседних потоков, и от своих.
 *
 * ЧТО ДЕЛАЕТ, по порядку:
 *   1. накатывает неприменённые миграции (в них же лежат сиды справочников: МФУ — 0143, картриджи —
 *      0192, поэтому отдельного «донаполнения» не нужно);
 *   2. убирает мусор оборванных прогонов db-тестов — учётки, площадки, отделы и расходники с
 *      узнаваемыми префиксами. Их уборка не отрабатывает, когда прогон убивают по таймауту, и за
 *      неделю база обрастает сотнями строк, неотличимых для человека от настоящих;
 *   3. печатает состояние справочников — чтобы было видно, наполнена ли база или пуста.
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Не удаляет базу и не пересоздаёт её: в `technic_dev` лежит рабочее состояние, на
 * котором проверяют портал руками, и стирать его ради «чистоты» значит каждый раз заводить заново
 * объекты, учётки и заявки. Мусор убирается точечно, по префиксам тестов.
 */
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-journal';

const URL = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!URL) {
  console.error('Не задан ни DATABASE_MIGRATION_URL, ни DATABASE_URL — нечего обновлять.');
  process.exit(1);
}

/**
 * Префиксы, которыми db-тесты метят своё. Уборка идёт только по ним: строка без метки могла быть
 * заведена человеком руками, и снести её значит потерять чужую работу.
 */
const TEST_MARKS = {
  users: ['db-%@example.test', 'db-oec%', 'db-oem%'],
  objects: ['DBTEST-%', 'OEM-%', 'OEC-%'],
  consumables: ['ДOEC%', 'ДFLOW%'],
  models: ['OEC %', '% 30ee27dd', '% 970a86a9', '% a92a67b4', '% 168572ae', '% 01646858'],
} as const;

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    console.log('— миграции');
    await applyMigrations(client, (m) => console.log(`  ${m}`));

    console.log('— уборка следов тестовых прогонов');
    // Порядок важен: сначала то, на что ссылаются, потом сами строки. Журнал остатка неудаляем
    // триггером (Р11), поэтому расходник с движением сносится вместе с ним под снятой защитой —
    // одной транзакцией, чтобы база не осталась без неё ни при каком исходе.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(
      'ALTER TABLE office_equipment_consumable_stock_entries DISABLE TRIGGER office_equipment_consumable_stock_immutable',
    );
    const consumables = await client.query(
      `DELETE FROM office_equipment_consumables WHERE ${TEST_MARKS.consumables.map((_, i) => `code LIKE $${i + 1}`).join(' OR ')} RETURNING 1`,
      [...TEST_MARKS.consumables],
    );
    await client.query(
      'ALTER TABLE office_equipment_consumable_stock_entries ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable',
    );
    await client.query('COMMIT');

    const models = await client.query(
      `DELETE FROM office_equipment_models m
        WHERE (${TEST_MARKS.models.map((_, i) => `m.name LIKE $${i + 1}`).join(' OR ')})
          AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id) RETURNING 1`,
      [...TEST_MARKS.models],
    );
    const users = await client.query(
      `DELETE FROM users WHERE ${TEST_MARKS.users.map((_, i) => `email LIKE $${i + 1}`).join(' OR ')} RETURNING 1`,
      [...TEST_MARKS.users],
    );
    const objects = await client.query(
      `DELETE FROM construction_objects o
        WHERE (${TEST_MARKS.objects.map((_, i) => `o.code LIKE $${i + 1}`).join(' OR ')})
          AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.object_id = o.id) RETURNING 1`,
      [...TEST_MARKS.objects],
    );
    console.log(
      `  расходников ${consumables.rowCount}, моделей ${models.rowCount}, учёток ${users.rowCount}, площадок ${objects.rowCount}`,
    );

    console.log('— состояние справочников');
    const state = await client.query<{ label: string; n: string }>(`
      SELECT 'карточек оргтехники' AS label, count(*)::text AS n FROM office_equipment
      UNION ALL SELECT 'моделей аппаратов', count(*)::text FROM office_equipment_models
      UNION ALL SELECT 'картриджей и тонеров', count(*)::text FROM office_equipment_consumables
      UNION ALL SELECT 'привязок расходник→модель', count(*)::text FROM office_equipment_consumable_models
      UNION ALL SELECT 'учётных записей', count(*)::text FROM users WHERE deleted_at IS NULL
    `);
    for (const r of state.rows) console.log(`  ${r.label}: ${r.n}`);
    console.log('\nГотово. Сервер можно поднимать: схема соответствует коду.');
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error('Не удалось обновить базу разработки:', e);
  process.exit(1);
});
