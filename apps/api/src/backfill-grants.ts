import { sql } from 'drizzle-orm';
import { SYSTEM_GRANT_CODES } from '@technic/contracts';
import { closeDb, db } from './db/client';

/**
 * Перенос назначений из надстроек роли в назначаемые полномочия — шаг 1b перехода expand/contract
 * (ADR 0106, решение 9; `docs/permissions-restructure-plan.md` §13).
 *
 * Запускается между релизами, ровно как `backfill:routes` (runbook, ADR 0050). Порядок шагов
 * обязателен и обратен привычному: миграция 0145 завела таблицы рядом и **не** переносила
 * назначения, потому что деплой накатывает миграции ДО перезапуска приложения — между копированием
 * и стартом новой версии продолжал бы работать старый код, пишущий только в `user_role_addons`, и
 * всё, что случилось в эти минуты, потерялось бы навсегда. Сначала релиз с двойной записью
 * (`services/user-scopes.ts`, шаг 1a), и только потом этот перенос.
 *
 * Использование:
 *   pnpm --filter @technic/api backfill:grants --check   — только сверка, база не меняется
 *   pnpm --filter @technic/api backfill:grants           — перенос и следом сверка
 *
 * Повторный запуск безопасен: перенесённое гасит `ON CONFLICT (user_id, grant_id) DO NOTHING`, и
 * прежняя строка остаётся со своим `id`, автором и временем выдачи.
 *
 * Сверок три, и они отвечают на разные вопросы. Две стороны diff'а — «совпадает ли доступ»:
 * надстройка без назначения и назначение без надстройки. Третья — «совпадает ли история»: у пары,
 * которая есть в обеих таблицах, могли разойтись `granted_by` и `granted_at` (см. `run`). Нулевой
 * diff про историю не говорит ничего: пара существует, а кто и когда выдал — разное.
 *
 * Код возврата ненулевой при ненулевом diff — шаг ставится в чек-лист выката и обязан падать, а не
 * сообщать: переключение чтения (шаг 1c) разрешено только при нулевой двусторонней сверке. При
 * разошедшейся истории и нулевом diff код ненулевой **только в `--check`** — обоснование в `main`.
 */

/**
 * Сколько строк расхождения печатать по каждой стороне. Разбирают их по одной, а полотно в
 * терминале не читается; полное число называется рядом.
 */
const SAMPLE_LIMIT = 20;

/**
 * Коды системных наборов для `IN (...)` — те и только те, что переезжают из надстроек.
 *
 * Нужны они ровно одной стороне сверки — обратной («есть в `user_grants`, нет в
 * `user_role_addons`»), и вот почему. Прямая сторона идёт **от** `user_role_addons`, где ничего,
 * кроме кодов надстроек, не лежит и лежать не может, а обратная идёт от `user_grants`, куда с
 * этапа 3 начнут попадать наборы, собранные администратором. У пользовательского набора надстройки
 * нет и никогда не будет — старая таблица о нём не знает, — поэтому без этого ограничения первая же
 * законная выдача «Аудитора» встала бы в отчёт расхождением и уронила бы прогон, требуя разбирать
 * состояние, которое разбору не подлежит. Сверка обязана говорить только о переезде и только о том,
 * что переезжает; всё прочее содержимое `user_grants` — не её дело.
 *
 * Список берётся из контрактов, а не переписывается сюда строками: тот же `SYSTEM_GRANT_CODES`
 * связывает код надстройки с кодом набора в двойной записи и в переносе ниже.
 */
const SYSTEM_CODES = sql.join(
  SYSTEM_GRANT_CODES.map((code) => sql`${code}`),
  sql`, `,
);

/**
 * Счётчики после переноса. Псевдоним, а не `interface`: `execute` требует от параметра типа
 * индексную сигнатуру, а её TypeScript выводит только у объектных псевдонимов.
 */
type CountsRow = {
  /** Всего строк в старой таблице — включая те, набора под код которых в каталоге нет. */
  total: number;
  /** Из них с заведённым набором: только они вообще могут быть перенесены. */
  with_grant: number;
  /** Из них уже отражённых в `user_grants` — считается ПОСЛЕ вставки. */
  mirrored: number;
};

/** «Есть в `user_role_addons`, нет в `user_grants`» — недобравшая или не сработавшая запись. */
type MissingRow = {
  email: string;
  full_name: string;
  code: string;
  /** Набора с таким кодом нет в `grants` вовсе: каталог накатан не полностью. */
  grant_missing: boolean;
};

/** «Есть в `user_grants`, нет в `user_role_addons`» — обратная сторона, см. `run`. */
type ExtraRow = {
  email: string;
  full_name: string;
  code: string;
  /** Происхождение: `migration` здесь означает, что назначение приехало из кода будущего этапа. */
  origin: string;
};

/** Пара есть в обеих таблицах, но автор или время выдачи разошлись — третья сверка, см. `run`. */
type HistoryRow = {
  email: string;
  full_name: string;
  code: string;
  /** Почта автора выдачи с каждой стороны; `null` — учётку автора удалили (`ON DELETE SET NULL`). */
  addon_by: string | null;
  grant_by: string | null;
  /** Время выдачи текстом: сравнивает его база, а печатать надо ровно то, что лежит в строке. */
  addon_at: string;
  grant_at: string;
  /** Что именно разошлось: строка отчёта называет только это, а не обе пары значений подряд. */
  by_differs: boolean;
  at_differs: boolean;
};

interface Report {
  total: number;
  withGrant: number;
  mirrored: number;
  /** Вставлено этим прогоном; `null` — режим `--check`, вставки не было вовсе. */
  inserted: number | null;
  missing: MissingRow[];
  extra: ExtraRow[];
  history: HistoryRow[];
}

/**
 * Перенос и сверка — одной транзакцией под табличной блокировкой.
 *
 * Почему блокировка именно табличная и именно `SHARE`. Без сериализации с отзывом перенос
 * воскрешает снятое: перенос прочитал назначение → параллельная транзакция удалила его из обеих
 * таблиц → перенос вставил прочитанное в `user_grants`, и отозванное полномочие вернулось — только
 * в новой таблице, где его никто не ищет. Блокировка существующих строк (`SELECT ... FOR SHARE`)
 * этого не закрывает: она держит то, что уже есть, а расхождение создаёт **новая** выдача между
 * чтением и фиксацией — параллельный `INSERT` строковый замок не останавливает. `SHARE`
 * конфликтует с `ROW EXCLUSIVE`, то есть с любой записью в таблицу, и не конфликтует с чтением:
 * портал продолжает отвечать, встаёт только выдача и отзыв надстроек, и встаёт на секунды.
 *
 * Отсюда же и главное свойство момента, в котором мы оказываемся, получив блокировку: двойная
 * запись атомарна и всегда трогает `user_role_addons`, поэтому любая правка надстроек, начатая до
 * нас, к этой секунде уже зафиксировала **обе** стороны, а начатая после — ждёт. Сверка говорит о
 * состоянии, которое под ней не меняется, — иначе «diff нулевой» относилось бы к моменту, которого
 * не было.
 *
 * Блокировка берётся и в `--check`: это та же сверка и то же требование к её моменту. Записи режим
 * не делает — `LOCK TABLE` не пишет ни строки.
 *
 * Сам перенос — `INSERT ... SELECT`, а не «прочитать в приложение и записать обратно». Данные не
 * покидают базу, между чтением и вставкой нет ни одного окна, а идемпотентность держится
 * ограничением `UNIQUE (user_id, grant_id)`, а не памятью скрипта о прошлом прогоне.
 */
async function run(checkOnly: boolean): Promise<Report> {
  return db.transaction(async (tx) => {
    /*
     * Ждать блокировку бесконечно нельзя: пока запрос `SHARE` стоит в очереди, за ним копятся
     * выдачи и отзывы надстроек — зависший администраторский запрос превратился бы в зависший
     * портал. Скрипт идемпотентен, поэтому отказ и повтор через минуту дешевле ожидания.
     */
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    try {
      await tx.execute(sql`LOCK TABLE user_role_addons IN SHARE MODE`);
    } catch (e) {
      // Единственный ожидаемый отказ здесь — истёкшее ожидание, и голая ошибка драйвера про него
      // не рассказывает ничего: человеку нужно знать, что делать, а делать надо ровно одно.
      throw new Error(
        'Блокировку user_role_addons не удалось взять за 10 с — таблицу держит чужая правка ' +
          'надстроек. Повторите прогон: он идемпотентен и ничего не успел изменить.',
        { cause: e },
      );
    }

    let inserted: number | null = null;
    if (!checkOnly) {
      /*
       * Соединение по коду: код надстройки и код системного набора совпадают, и держится это не
       * соглашением, а `SYSTEM_GRANT_CODES ... satisfies readonly RoleAddon[]` в контрактах.
       * `deleted_at` не фильтруется — код уникален по всей таблице, значит строка находится одна, а
       * системный набор не удаляется вовсе; фильтр только создал бы вечное расхождение по первой
       * стороне сверки.
       *
       * `granted_by` и `granted_at` берутся ИЗ СТАРОЙ ТАБЛИЦЫ: миграция меняет способ хранения, а
       * не бизнес-причину выдачи, и момент переноса на месте времени выдачи стёр бы историю.
       * `origin = 'manual'` — перевод ролей ещё не начинался, всё выданное здесь выдала рука
       * администратора; `migration` зарезервирован за ним и ставится только им. `migration_id` в
       * списке колонок отсутствует намеренно: писателя у неё пока нет вовсе, и заполнять её здесь
       * означало бы соврать про происхождение.
       */
      const result = await tx.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, granted_at, origin)
        SELECT ura.user_id, g.id, ura.granted_by, ura.granted_at, 'manual'
          FROM user_role_addons ura
          JOIN grants g ON g.code = ura.addon::text
        ON CONFLICT (user_id, grant_id) DO NOTHING
      `);
      inserted = result.rowCount ?? 0;
    }

    // Счётчики считаются ПОСЛЕ вставки — «уже было» выводится вычитанием, а не вторым запросом до
    // неё: два запроса до и после разошлись бы ровно в том случае, ради которого взята блокировка.
    const counts = await tx.execute<CountsRow>(sql`
      SELECT count(*)::int      AS total,
             count(g.id)::int   AS with_grant,
             count(ug.id)::int  AS mirrored
        FROM user_role_addons ura
        LEFT JOIN grants g       ON g.code = ura.addon::text
        LEFT JOIN user_grants ug ON ug.user_id = ura.user_id AND ug.grant_id = g.id
    `);

    /*
     * Первая сторона: надстройка есть, назначения нет. Сюда же попадает надстройка, набора под код
     * которой в каталоге не нашлось (`grant_missing`), — вставке она недоступна, и молча пропасть
     * из отчёта не должна: это сломанный накат каталога, а не «нечего переносить».
     */
    const missing = await tx.execute<MissingRow>(sql`
      SELECT u.email,
             u.full_name,
             ura.addon::text AS code,
             (g.id IS NULL)  AS grant_missing
        FROM user_role_addons ura
        JOIN users u             ON u.id = ura.user_id
        LEFT JOIN grants g       ON g.code = ura.addon::text
        LEFT JOIN user_grants ug ON ug.user_id = ura.user_id AND ug.grant_id = g.id
       WHERE ug.id IS NULL
       ORDER BY u.full_name, code
    `);

    /*
     * Вторая сторона: назначение есть, надстройки нет. Она важна не меньше первой и не выводится из
     * неё. Так выглядит назначение, приехавшее из кода будущего шага (`origin = 'migration'` до
     * этапа перевода ролей — это уже расхождение), и назначение, уцелевшее после отзыва надстройки:
     * отзыв обязан снимать строку в обеих таблицах одной транзакцией, и лишняя строка здесь
     * означает, что где-то он этого не сделал. Такое право не видно ни в одном интерфейсе — до
     * шага 1c его никто не читает, — и обнаружить его можно только сверкой.
     *
     * Ограничение по системным кодам (`SYSTEM_CODES`) — граница предмета сверки, а не оптимизация:
     * пользовательские наборы этапа 3 в старой таблице не отражаются никогда, и без него законная
     * выдача собранного набора выглядела бы расхождением переезда.
     */
    const extra = await tx.execute<ExtraRow>(sql`
      SELECT u.email,
             u.full_name,
             g.code,
             ug.origin
        FROM user_grants ug
        JOIN grants g ON g.id = ug.grant_id
        JOIN users u  ON u.id = ug.user_id
        LEFT JOIN user_role_addons ura
               ON ura.user_id = ug.user_id AND ura.addon::text = g.code
       WHERE ura.user_id IS NULL
         AND g.code IN (${SYSTEM_CODES})
       ORDER BY u.full_name, g.code
    `);

    /*
     * Третья сверка: пара есть в обеих таблицах, а `granted_by` или `granted_at` разошлись. Первые
     * две про неё не знают вовсе — они спрашивают только о существовании пары, — и без неё нулевой
     * diff означал бы «доступ совпал», выдавая себя за «таблицы совпали».
     *
     * Состояние достижимо, и достижимо оно через объявленный безопасным откат (`1b → 1a` в плане
     * реструктуризации, §15): откат до версии без двойной записи → отзыв надстройки (уходит только
     * из старой таблицы) → возврат вперёд → повторная выдача. Двойная запись вставляет назначение
     * с новым автором и временем, `ON CONFLICT DO NOTHING` оставляет прежнюю строку — и в
     * `user_grants` навсегда остаётся история той выдачи, которую администратор отозвал. ADR 0106
     * при этом требует, чтобы перенос сохранял `granted_by` и `granted_at`, а реестр объяснял
     * каждое назначение; объяснение, разошедшееся с фактом, — это и есть предмет проверки.
     *
     * Чинить это переносом нельзя, и `DO UPDATE` здесь не решение, а вторая ошибка: с шага 1d
     * запись в `user_role_addons` прекращается, старая таблица начинает отставать, и копирование
     * истории из неё затёрло бы верную — то есть скрипт, запущенный не в свой шаг, уничтожал бы
     * ровно то, что должен сохранять. Поэтому расхождение печатается, а правится руками.
     */
    const history = await tx.execute<HistoryRow>(sql`
      SELECT u.email,
             u.full_name,
             g.code,
             ab.email             AS addon_by,
             gb.email             AS grant_by,
             ura.granted_at::text AS addon_at,
             ug.granted_at::text  AS grant_at,
             (ug.granted_by IS DISTINCT FROM ura.granted_by) AS by_differs,
             (ug.granted_at IS DISTINCT FROM ura.granted_at) AS at_differs
        FROM user_role_addons ura
        JOIN grants g       ON g.code = ura.addon::text
        JOIN user_grants ug ON ug.user_id = ura.user_id AND ug.grant_id = g.id
        JOIN users u        ON u.id = ura.user_id
        LEFT JOIN users ab  ON ab.id = ura.granted_by
        LEFT JOIN users gb  ON gb.id = ug.granted_by
       WHERE ug.granted_by IS DISTINCT FROM ura.granted_by
          OR ug.granted_at IS DISTINCT FROM ura.granted_at
       ORDER BY u.full_name, g.code
    `);

    const row = counts.rows[0]!;
    return {
      total: row.total,
      withGrant: row.with_grant,
      mirrored: row.mirrored,
      inserted,
      // Строки берутся целиком, а не `LIMIT`: надстроек в системе десятки — две на учётку, — и
      // полное число расхождений нужно вердикту. Печать ограничивает `SAMPLE_LIMIT`.
      missing: [...missing.rows],
      extra: [...extra.rows],
      history: [...history.rows],
    };
  });
}

/** Учётка в отчёте: набор без человека нечитаем, а почта — то, по чему его находят в портале. */
function who(row: { full_name: string; email: string }): string {
  return `${row.full_name} <${row.email}>`;
}

function printReport(report: Report, checkOnly: boolean): void {
  console.log(`Надстроек в user_role_addons: ${report.total}`);
  console.log(`Из них с заведённым набором: ${report.withGrant}`);
  if (report.inserted === null) {
    console.log(`Уже перенесено: ${report.mirrored}`);
    console.log('\n--check: база не менялась.');
  } else {
    console.log(`Перенесено сейчас: ${report.inserted}`);
    console.log(`Уже было: ${report.mirrored - report.inserted}`);
  }

  if (report.missing.length > 0) {
    console.log(`\nЕсть в user_role_addons, нет в user_grants (${report.missing.length}):`);
    for (const row of report.missing.slice(0, SAMPLE_LIMIT)) {
      const note = row.grant_missing ? ' — набора с таким кодом нет в grants' : '';
      console.log(`  · ${who(row)}: ${row.code}${note}`);
    }
    if (report.missing.length > SAMPLE_LIMIT) {
      console.log(`  … и ещё ${report.missing.length - SAMPLE_LIMIT}`);
    }
    if (report.missing.some((row) => row.grant_missing)) {
      console.log(
        '  Системные наборы заводит миграция 0145 — без них переносить некуда: проверьте накат.',
      );
    } else if (checkOnly) {
      console.log('  Это и переносит прогон без `--check`.');
    }
  }

  if (report.extra.length > 0) {
    console.log(`\nЕсть в user_grants, нет в user_role_addons (${report.extra.length}):`);
    for (const row of report.extra.slice(0, SAMPLE_LIMIT)) {
      console.log(`  · ${who(row)}: ${row.code} (origin: ${row.origin})`);
    }
    if (report.extra.length > SAMPLE_LIMIT) {
      console.log(`  … и ещё ${report.extra.length - SAMPLE_LIMIT}`);
    }
    // Переносом это не чинится: лишнее назначение — след отзыва, который не дошёл до второй
    // таблицы, либо записи кода, которого на этом шаге ещё не должно быть.
    console.log(
      '  Перенос такое не снимает: разберите руками — либо надстройка была снята мимо второй\n' +
        '  таблицы, либо назначение записал код следующего шага.',
    );
  }

  if (report.history.length > 0) {
    console.log(`\nПрава совпали, история выдачи разошлась (${report.history.length}):`);
    for (const row of report.history.slice(0, SAMPLE_LIMIT)) {
      // Называется только разошедшееся: строка с обеими парами значений подряд читается вдвое
      // дольше, а вторая пара в ней совпадает сама с собой.
      const parts: string[] = [];
      if (row.by_differs) {
        parts.push(`автор: надстройка ${row.addon_by ?? '—'}, назначение ${row.grant_by ?? '—'}`);
      }
      if (row.at_differs) {
        parts.push(`выдано: надстройка ${row.addon_at}, назначение ${row.grant_at}`);
      }
      console.log(`  · ${who(row)}: ${row.code} — ${parts.join('; ')}`);
    }
    if (report.history.length > SAMPLE_LIMIT) {
      console.log(`  … и ещё ${report.history.length - SAMPLE_LIMIT}`);
    }
    console.log(
      '  Доступ от этого не меняется — пара есть в обеих таблицах, — расходится объяснение\n' +
        '  выдачи. Перенос это не чинит и чинить не берётся (`DO NOTHING` бережёт прежнюю строку,\n' +
        '  а после шага 1d копирование из отставшей таблицы затирало бы верную историю): правится\n' +
        '  руками, `UPDATE user_grants ... FROM user_role_addons` (запрос — в runbook), и только\n' +
        '  пока работает двойная запись, то есть до шага 1d.',
    );
  }

  const diff = report.missing.length + report.extra.length;
  if (diff === 0) {
    console.log('\nИтог: diff нулевой, переключение чтения разрешено.');
  } else {
    console.error(
      `\nИтог: расхождение: ${report.missing.length} + ${report.extra.length}, ` +
        'переключать чтение нельзя.',
    );
  }
  if (report.history.length > 0) {
    console.error(
      `Предупреждение: история выдачи разошлась в ${report.history.length} назначениях — ` +
        'переключению чтения это не мешает' +
        (checkOnly ? ', но код возврата ненулевой: решение принимает человек.' : '.'),
    );
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const report = await run(checkOnly);
  printReport(report, checkOnly);
  // Ненулевой diff — отказ, а не сообщение: шаг стоит в чек-листе выката и обязан его останавливать.
  const diff = report.missing.length + report.extra.length > 0;
  /*
   * Разошедшаяся история переключение чтения не блокирует, но `--check` возвращает из-за неё 1.
   *
   * Почему не блокирует. Шаг 1c отвечает на один вопрос — «даст ли чтение новых таблиц тот же
   * доступ», — и на него расхождение по автору и времени отвечает «да»: пара есть в обеих
   * таблицах, права у держателя те же и до, и после. Запрет идти дальше означал бы остановку
   * выката ради поля, которое переключением чтения не исправляется и от него не портится, — а
   * повтор переноса, единственное действие, которое чек-лист предлагает при отказе, тут не делает
   * ничего вовсе (`DO NOTHING`). Гейт, который нечем удовлетворить, учит обходить гейт.
   *
   * Почему всё-таки не ноль. Молчаливый ноль — это ровно тот дефект, ради которого третья сверка и
   * заведена: «diff нулевой» перестал бы отличать совпавшие таблицы от совпавшего доступа. У
   * расхождения есть срок годности: верную историю знает только `user_role_addons`, и знает она её,
   * пока в неё пишут, — с шага 1d таблица отстаёт, с 1e её нет вовсе, и восстанавливать историю
   * будет уже не из чего. Поэтому режим сверки — тот, которым и решают, идти ли дальше, — обязан
   * вернуть ненулевой код и заставить человека посмотреть отчёт; режим переноса возвращает ноль,
   * потому что перенос сделал всё, что мог, и повторять его незачем.
   */
  if (diff || (checkOnly && report.history.length > 0)) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('Перенос назначений не удался:', e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
