import { buildMigrationClient } from '../src/db/migration-client';
import { listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * Отчёт по моделям парка оргтехники — этап 0 плана `docs/office-equipment-consumables-plan.md`.
 *
 * ЗАЧЕМ. Следующим выпуском модель аппарата перестаёт быть строкой в карточке и становится записью
 * справочника `office_equipment_models` (Р1), а разбор парка делает сама миграция: группирует
 * карточки по паре «тип + ключ написания» и выбирает канон — самое частое написание в группе, при
 * равенстве частот лексикографически первое (Р4). Выбор детерминированный, но никем не виденный:
 * оператор выката узнаёт, что «RICOH IM 350» победило «Ricoh IM 350», уже из готового справочника.
 * Отчёт показывает этот выбор ЗАРАНЕЕ — пока модель это ещё текст в карточке и правка стоит одного
 * нажатия в портале. После наката двойники разводятся дольше: карточки перецепляют на верную модель
 * по одной, лишнюю модель гасят, а ручки «слить модели» в плане нет (§10).
 *
 * ПРАВИЛО НАПИСАНИЯ ЗДЕСЬ НЕ ЖИВЁТ. Ни ключ, ни нормализация в этом файле не записаны выражением:
 * зовутся `office_equipment_model_key` и `office_equipment_model_name_normalize` — те самые функции,
 * по которым построен уникальный индекс справочника и которыми считает разбор миграции. Копия
 * правила в отчёте — не экономия, а ловушка: за время работы над планом оно менялось дважды (сначала
 * ключ стал схлопывать любые пробелы, а не только края, потом поменялись порядок операций и класс
 * символов), и отчёт, считающий по вчерашнему правилу, показывает две модели там, где накат заведёт
 * одну, — то есть просит ИТ-службу свести руками то, что сводится само, и расходится с пунктом 1
 * сверки §12, где число моделей сравнивают с этим отчётом.
 *
 * ОТКУДА ФУНКЦИИ ДО НАКАТА. Отчёт нужен РАНЬШЕ миграции — в этом весь смысл этапа 0, — а функции
 * появляются вместе с ней. Отказ «сначала накатите миграцию» обессмыслил бы отчёт, поэтому развилка
 * решена так: если функции в базе уже есть, зовутся они; если нет — их текст **вычитывается из
 * файла самой миграции** (`drizzle/*_office_equipment_models.sql`) и объявляется в `pg_temp`, во
 * временной схеме сессии. Правило и в этом случае берётся из единственного места, где оно записано,
 * а не из копии в скрипте: поменяется миграция — поменяется и отчёт, сам, без правки этого файла.
 *
 * ЧТО ДЕЛАЕТ С БАЗОЙ. **Данных не меняет.** Ни одного INSERT, UPDATE, DELETE, ни одной DDL-команды
 * по таблицам, индексам или триггерам. Единственная запись, которую отчёт вообще делает, — те самые
 * `CREATE OR REPLACE FUNCTION pg_temp.…` до наката: временная схема принадлежит сессии, не видна
 * никому другому и исчезает вместе с отключением, а данных функция не касается — она принимает
 * текст и возвращает текст. Прочих запросов ровно три `SELECT` (наличие функций, итоги по парку,
 * разбор написаний) по `office_equipment` и `office_equipment_types`. Правки в парк вносит человек
 * через портал: там они попадут в журнал изменений и пройдут проверки маршрута.
 *
 * ЧТО ОТЧЁТ НЕ РЕШАЕТ. Правило разводит регистр и любые пробелы, включая неразрывные. Смысловые
 * двойники — «Ricoh MP W6700SP» против «Ricoh Aficio MP W6700SP» — для базы две разные строки, и
 * никакой эвристикой их не развести наверняка: «Aficio MP 301SP» и «Aficio MP 301SPF» похожи ровно
 * так же, но это разные аппараты (§7, п. 5). Поэтому раздел 3 — не список к исполнению, а список к
 * вычитке: скрипт печатает пару с числом карточек с обеих сторон, решает человек. Ничего он не
 * правит и не предлагает править автоматически.
 *
 * Удалённые карточки считаются наравне с живыми — `deleted_at` не фильтруется. Так же поступает
 * разбор миграции, и иначе быть не может: у архивной карточки имя остаётся, зеркало `name` держится
 * и для неё (Р3), а модель, которой не нашлось живых карточек, всё равно должна попасть в
 * справочник — иначе восстановление карточки упёрлось бы в отсутствующую модель. Архивные при этом
 * показываются отдельным числом: группа из одних архивных — повод не править написание, а спросить,
 * нужна ли такая модель вовсе.
 *
 * ГДЕ ЗАПУСКАТЬ. Смысл у отчёта только на БОЕВЫХ данных: вычитывать предстоит настоящие написания
 * настоящего парка. Локальная база разработки почти пуста, и зелёный прогон на ней означает лишь
 * то, что скрипт работает, — но не то, что в парке нет двойников. Поэтому запуск делается с боевым
 * (или снятым с боевого) `DATABASE_URL`, и прав нужно ровно два: чтение парка и временная схема.
 *
 * Подключение — `buildMigrationClient()`, тот же, которым ходят раннер миграций, `db:cutover-down`
 * и проверка `backfill:trips --check`. Не ради DDL-прав, которые отчёту не нужны, а ради
 * единственной в проекте настройки TLS к Managed PostgreSQL (`sslmode` из URL вычищается, CA
 * берётся из `PGSSLROOTCERT`): своя копия этой настройки — это путь, где `verify-full` существует
 * только на бумаге. Клиент берёт `DATABASE_MIGRATION_URL`, а при его отсутствии `DATABASE_URL`.
 *
 * Использование:
 *
 *   DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_archive_test \
 *     pnpm --silent --filter @technic/api report:equipment-models
 *
 *   # боевые данные: с копии базы или прямо с неё, читающей ролью
 *   DATABASE_URL='postgres://...' pnpm --silent --filter @technic/api report:equipment-models \
 *     > models-report.txt
 */

const EXIT_FAILURE = 1;

/** Как модель ПИШЕТСЯ: края обрезаны, любая череда пробельных символов свёрнута в один пробел. */
const NORMALIZE_FN = 'office_equipment_model_name_normalize';
/** По чему модель ОПОЗНАЁТСЯ: то же написание в верхнем регистре. Половина ключа группы. */
const KEY_FN = 'office_equipment_model_key';

/**
 * Миграция ищется по хвосту имени, а не по номеру: номера занимают параллельные потоки, и
 * `0171` уже дважды могло стать другим числом. Единственность файла проверяется — два файла с таким
 * хвостом означали бы, что правило переписано второй миграцией, и молча взять первый попавшийся
 * значило бы считать по одному правилу, а накатить другое.
 */
const MODELS_MIGRATION_SUFFIX = '_office_equipment_models.sql';

/**
 * Есть ли правило в самой базе. `to_regprocedure` возвращает NULL, а не ошибку, если функции нет, —
 * и ищет по `search_path`, где `pg_temp` для функций не участвует НИКОГДА (Postgres смотрит во
 * временную схему только имена отношений и типов). Поэтому свои же временные копии этот запрос
 * найти не может, и повторный вызов не соврёт «функции появились».
 */
const RULE_PRESENT_SQL = `
  SELECT to_regprocedure('${KEY_FN}(text)') IS NOT NULL
     AND to_regprocedure('${NORMALIZE_FN}(text)') IS NOT NULL AS present`;

/** Итоги по парку считаются отдельным запросом: сумма по группам не увидела бы пустой таблицы. */
const TOTALS_SQL = `
  SELECT count(*) AS cards,
         count(*) FILTER (WHERE deleted_at IS NOT NULL) AS archived
    FROM office_equipment`;

/**
 * Разбор парка ровно тем запросом, которым его сделает миграция (Р4): группировка по паре «тип +
 * ключ», канон — `DISTINCT ON` по `cards DESC, spelling`. Порядок повторён дословно, включая
 * сортировку по написанию: она идёт коллацией базы, и переписать её на сравнение строк в TypeScript
 * значило бы получить отчёт, который иногда называет каноном не то, что выберет накат. Ради этого
 * же канон считается здесь, а не в коде: единственный способ показать выбор миграции — сделать её
 * выбор.
 *
 * `schema` — пусто, когда функции уже в базе, и `pg_temp.`, когда они объявлены на время сессии.
 * Больше правило нигде не упоминается: имена функций подставляются, тела не копируются.
 */
function variantsSql(schema: string): string {
  return `
  WITH variants AS (
    SELECT e.equipment_type_id,
           ${schema}${KEY_FN}(e.name) AS key,
           ${schema}${NORMALIZE_FN}(e.name) AS spelling,
           count(*) AS cards,
           count(*) FILTER (WHERE e.deleted_at IS NOT NULL) AS archived
      FROM office_equipment e
     GROUP BY 1, 2, 3
  ), canon AS (
    SELECT DISTINCT ON (equipment_type_id, key) equipment_type_id, key, spelling
      FROM variants
     ORDER BY equipment_type_id, key, cards DESC, spelling
  )
  SELECT t.name AS type_name,
         t.sort_order AS type_sort,
         v.key,
         v.spelling,
         v.cards,
         v.archived,
         (v.spelling = c.spelling) AS is_canon
    FROM variants v
    JOIN canon c ON c.equipment_type_id = v.equipment_type_id AND c.key = v.key
    JOIN office_equipment_types t ON t.id = v.equipment_type_id
   ORDER BY t.sort_order, t.name, v.key, v.cards DESC, v.spelling`;
}

interface VariantRow {
  type_name: string;
  type_sort: number;
  key: string;
  spelling: string;
  /** `count(*)` — bigint, и pg отдаёт его строкой: приводится в `num()`. */
  cards: string;
  archived: string;
  is_canon: boolean;
}

interface TotalsRow {
  cards: string;
  archived: string;
}

/** Одно написание внутри группы. */
interface Variant {
  spelling: string;
  cards: number;
  archived: number;
  isCanon: boolean;
}

/** Группа — будущая запись справочника моделей: пара «тип + ключ написания». */
interface Model {
  typeName: string;
  typeSort: number;
  key: string;
  canon: string;
  cards: number;
  archived: number;
  /** Написания по убыванию частоты; их больше одного — группа попадает в раздел 2 отчёта. */
  variants: Variant[];
}

// Правило: взять из базы или объявить на время сессии.

/** Откуда взялось правило — печатается в шапке отчёта: читающий обязан знать, чем это считано. */
interface Rule {
  /** Префикс схемы для вызовов: `''` или `'pg_temp.'`. */
  schema: string;
  source: string;
}

/**
 * Текст `CREATE FUNCTION` из миграции. Разбирается регулярным выражением по единственной форме, в
 * которой правило там записано, — `(t text) RETURNS text … AS $$ … $$;`. Не найдено — отказ, а не
 * запасное выражение в коде: молчаливый откат к собственной копии правила и есть та ошибка, ради
 * которой всё это затеяно.
 */
function extractFunction(sql: string, name: string, file: string): string {
  const re = new RegExp(
    `CREATE FUNCTION\\s+${name}\\s*\\(\\s*t\\s+text\\s*\\)\\s+RETURNS\\s+text\\s+([\\s\\S]*?)AS\\s+\\$\\$([\\s\\S]*?)\\$\\$;`,
  );
  const found = re.exec(sql);
  const options = found?.[1];
  const body = found?.[2];
  if (options === undefined || body === undefined) {
    throw new Error(
      `В миграции ${file} не нашлось определения ${name}(text): правило написания изменило форму. ` +
        'Отчёт не станет считать по своей копии правила — поправьте разбор в этом скрипте.',
    );
  }
  /*
   * Вызов соседней функции внутри тела дописывается схемой намеренно. Postgres ищет функции по
   * `search_path`, а `pg_temp` в этом поиске не участвует: временная копия ключа звала бы
   * `office_equipment_model_name_normalize` из `public` — то есть ту самую, которой ещё нет.
   */
  const qualified = body.replaceAll(`${NORMALIZE_FN}(`, `pg_temp.${NORMALIZE_FN}(`);
  return `CREATE OR REPLACE FUNCTION pg_temp.${name}(t text) RETURNS text\n${options}AS $$${qualified}$$;`;
}

function findModelsMigration(): string {
  const files = listMigrationFiles().filter((f) => f.endsWith(MODELS_MIGRATION_SUFFIX));
  const only = files[0];
  if (files.length !== 1 || only === undefined) {
    throw new Error(
      `Ожидался ровно один файл миграции моделей (*${MODELS_MIGRATION_SUFFIX}), найдено ${files.length}: ` +
        `${files.join(', ') || 'ничего'}. Без него правило написания брать неоткуда.`,
    );
  }
  return only;
}

interface Queryable {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

async function ensureRule(client: Queryable): Promise<Rule> {
  const present = await client.query<{ present: boolean }>(RULE_PRESENT_SQL);
  if (present.rows[0]?.present === true) {
    return { schema: '', source: `функции базы ${KEY_FN} / ${NORMALIZE_FN} (миграция накатана)` };
  }
  const file = findModelsMigration();
  const sql = readMigration(file);
  // Нормализация объявляется первой: тело ключа зовёт её, и при `check_function_bodies` (умолчание)
  // обратный порядок не прошёл бы проверку самого `CREATE`.
  const statements = [NORMALIZE_FN, KEY_FN].map((name) => extractFunction(sql, name, file));
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (e) {
      throw new Error(
        `Не удалось объявить правило написания во временной схеме: ${(e as Error).message}. ` +
          'Отчёту нужна либо накатанная миграция моделей, либо право на временную схему (TEMPORARY).',
      );
    }
  }
  return {
    schema: 'pg_temp.',
    source: `правило вычитано из ${file} во временную схему сессии (миграция ещё не накатана)`,
  };
}

// Смысловые двойники: то, чего правило написания не ловит.

/**
 * Слова, которыми одна и та же модель отличается сама от себя: линейки производителей и родовые
 * слова, которые в карточку то вписывают, то нет. Список нарочно короткий и состоит из имён линеек,
 * а не из кусков обозначений: «MP», «SP», «DN» — часть модели, и, попади они сюда, отчёт объявил бы
 * двойниками половину парка. Пополнять его стоит по факту находки в разделе 3, а не впрок.
 */
const BRAND_WORDS = new Set([
  // Ricoh
  'AFICIO',
  'GESTETNER',
  // HP
  'LASERJET',
  'OFFICEJET',
  'DESKJET',
  'NEVERSTOP',
  'ENTERPRISE',
  'PRO',
  'MFP',
  // Kyocera
  'ECOSYS',
  'TASKALFA',
  // Canon
  'I-SENSYS',
  'ISENSYS',
  'IMAGERUNNER',
  'IMAGECLASS',
  'PIXMA',
  // Xerox
  'PHASER',
  'WORKCENTRE',
  'VERSALINK',
  // Samsung
  'XPRESS',
  // Epson
  'EXPRESSION',
  'WORKFORCE',
  'ECOTANK',
  'STYLUS',
  'PREMIUM',
  // Родовые слова: их пишут в имени модели, хотя для этого есть тип техники.
  'МФУ',
  'ПРИНТЕР',
  'СКАНЕР',
  'КОПИР',
  'ПЛОТТЕР',
  'PRINTER',
  'SCANNER',
  'SERIES',
]);

/**
 * Короче этого порога вхождение одной строки в другую ничего не значит: «HP» найдётся везде.
 * Четыре символа — минимальное осмысленное обозначение вроде «M428».
 */
const MIN_CONTAINED_LENGTH = 4;

type CandidateReason = 'хвост' | 'вставка' | 'вхождение';

interface Candidate {
  typeName: string;
  /** Короткая сторона пары: та, что вошла в длинную. */
  shorter: Model;
  longer: Model;
  reason: CandidateReason;
  /** Чем именно длинная сторона отличается — для причин «вставка» и «хвост». */
  detail: string;
}

function num(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Слова ключа. Ключ приходит уже нормализованным — пробелы схлопнуты правилом базы, — поэтому
 * делить достаточно по одному пробелу; `\s+` оставлен на случай, если правило когда-нибудь пустит
 * внутрь ключа что-то ещё.
 */
function words(key: string): string[] {
  return key.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Лишние слова длинной строки, если короткая — её подпоследовательность; иначе `null`. Жадный
 * проход слева: для вопроса «является ли подпоследовательностью» этого достаточно.
 */
function extraWords(shorter: readonly string[], longer: readonly string[]): string[] | null {
  const extra: string[] = [];
  let i = 0;
  for (const word of longer) {
    if (i < shorter.length && shorter[i] === word) i += 1;
    else extra.push(word);
  }
  return i === shorter.length ? extra : null;
}

/** Слова короткой строки — хвост длинной: «MP 301SP» в «Ricoh Aficio MP 301SP». */
function isTail(shorter: readonly string[], longer: readonly string[]): boolean {
  const offset = longer.length - shorter.length;
  return shorter.every((word, i) => word === longer[offset + i]);
}

/**
 * Короткая строка входит в длинную, начинаясь с границы слова. Правая граница нарочно не
 * проверяется: ради неё правило и заведено — «Aficio MP 2000» против «Aficio MP 2000SP»
 * различаются дописанным к последнему слову хвостом, и требование границы справа отбросило бы
 * ровно тот случай, который надо показать. Левая граница обязательна: без неё «MP 2000» нашлось бы
 * в «AMP 2000».
 */
function isContained(shorter: string, longer: string): boolean {
  if (shorter.length < MIN_CONTAINED_LENGTH) return false;
  let from = 0;
  for (;;) {
    const at = longer.indexOf(shorter, from);
    if (at < 0) return false;
    if (at === 0 || longer[at - 1] === ' ') return true;
    from = at + 1;
  }
}

/**
 * Пара моделей одного типа, похожих настолько, что стоит спросить человека. Правило написания таких
 * не сводит: для него это разные ключи, и накат разведёт их в две записи справочника.
 *
 * Пар, различающихся только регистром или пробелами, здесь не бывает вовсе: у них один ключ, они
 * пришли одной группой и видны в разделе 2 как разные написания ОДНОЙ модели. Раздел 3 — только про
 * то, чего накат не сводит и не сведёт.
 */
function candidateOf(a: Model, b: Model): Candidate | null {
  const [shorter, longer] = a.key.length <= b.key.length ? [a, b] : [b, a];
  const shortWords = words(shorter.key);
  const longWords = words(longer.key);

  if (shortWords.length < longWords.length && isTail(shortWords, longWords)) {
    const head = longWords.slice(0, longWords.length - shortWords.length).join(' ');
    return { typeName: a.typeName, shorter, longer, reason: 'хвост', detail: head };
  }
  const extra = shortWords.length < longWords.length ? extraWords(shortWords, longWords) : null;
  if (extra && extra.length > 0 && extra.every((word) => BRAND_WORDS.has(word))) {
    return { typeName: a.typeName, shorter, longer, reason: 'вставка', detail: extra.join(' ') };
  }
  if (isContained(shortWords.join(' '), longWords.join(' '))) {
    return { typeName: a.typeName, shorter, longer, reason: 'вхождение', detail: '' };
  }
  return null;
}

/**
 * Кандидаты ищутся попарно и только внутри одного типа техники: одинаково названные принтер и МФУ
 * — разные модели по решению Р1, и сводить их отчёт не предлагает. Квадрат по числу моделей внутри
 * типа: парк — сотни моделей, а не сотни тысяч.
 */
function findCandidates(models: readonly Model[]): Candidate[] {
  const byType = new Map<string, Model[]>();
  for (const model of models) {
    const list = byType.get(model.typeName);
    if (list) list.push(model);
    else byType.set(model.typeName, [model]);
  }
  const found: Candidate[] = [];
  for (const list of byType.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const left = list[i];
      if (!left) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const right = list[j];
        if (!right) continue;
        const candidate = candidateOf(left, right);
        if (candidate) found.push(candidate);
      }
    }
  }
  // Сначала пары, где карточек больше: с них вычитка и начнётся.
  return found.sort(
    (x, y) =>
      y.shorter.cards + y.longer.cards - (x.shorter.cards + x.longer.cards) ||
      x.typeName.localeCompare(y.typeName, 'ru') ||
      x.shorter.canon.localeCompare(y.shorter.canon, 'ru'),
  );
}

function groupModels(rows: readonly VariantRow[]): Model[] {
  const models = new Map<string, Model>();
  for (const row of rows) {
    // Разделитель — таб: в наименовании модели его быть не может, правило написания схлопнуло бы
    // его в пробел ещё до группировки.
    const id = `${row.type_name}\t${row.key}`;
    const variant: Variant = {
      spelling: row.spelling,
      cards: num(row.cards),
      archived: num(row.archived),
      isCanon: row.is_canon,
    };
    const model = models.get(id);
    if (model) {
      model.cards += variant.cards;
      model.archived += variant.archived;
      model.variants.push(variant);
      if (variant.isCanon) model.canon = variant.spelling;
    } else {
      models.set(id, {
        typeName: row.type_name,
        typeSort: num(row.type_sort),
        key: row.key,
        canon: variant.spelling,
        cards: variant.cards,
        archived: variant.archived,
        variants: [variant],
      });
    }
  }
  return [...models.values()];
}

// Печать.

/** «1 карточка», «2 карточки», «5 карточек» — отчёт читают люди, а не grep. */
function cardsWord(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} карточек`;
  if (ones === 1) return `${n} карточка`;
  if (ones >= 2 && ones <= 4) return `${n} карточки`;
  return `${n} карточек`;
}

/** Хвост про архив дописывается только там, где архивные есть: иначе он шумит в каждой строке. */
function withArchived(cards: number, archived: number): string {
  return archived > 0 ? `${cardsWord(cards)}, из них в архиве ${archived}` : cardsWord(cards);
}

const RULE_WIDTH = 92;

function section(title: string): void {
  console.log('');
  console.log(`-- ${title} ${'-'.repeat(Math.max(3, RULE_WIDTH - title.length))}`);
  console.log('');
}

function printSummary(totalCards: number, archived: number, models: readonly Model[]): void {
  const spelled = models.filter((m) => m.variants.length > 1);
  const types = new Set(models.map((m) => m.typeName));
  section('1. Сводка');
  console.log(
    `Карточек в office_equipment: ${totalCards} (живых ${totalCards - archived}, в архиве ${archived})`,
  );
  console.log(`Типов техники в парке:       ${types.size}`);
  console.log(`Моделей после разбора:       ${models.length}`);
  console.log(`Групп с разнописанием:       ${spelled.length}`);
  console.log('');
  console.log('Столько же строк должно оказаться в office_equipment_models после наката — это и');
  console.log(
    'сверяет пункт 1 §12 плана. Разошлось — значит парк успели поправить между отчётом и',
  );
  console.log('накатом, и сверять надо со свежим отчётом, а не с этим.');
}

function printSpellings(models: readonly Model[]): void {
  section('2. Разное написание одной модели (сводит сам накат)');
  const spelled = models
    .filter((m) => m.variants.length > 1)
    .sort((a, b) => b.cards - a.cards || a.typeName.localeCompare(b.typeName, 'ru'));
  if (spelled.length === 0) {
    console.log('Не найдено: у каждой модели парка одно написание. Правка до наката не требуется.');
    return;
  }
  console.log('Канон — самое частое написание, при равенстве частот лексикографически первое.');
  console.log('Именно оно уедет в справочник, остальные написания карточек исчезнут. Различаются');
  console.log(
    'эти написания только регистром: пробелы правило уже свело, и в группе они не видны.',
  );
  console.log('');
  for (const model of spelled) {
    console.log(
      `[${model.typeName}] ${model.key} — написаний ${model.variants.length}, ${withArchived(model.cards, model.archived)}`,
    );
    for (const variant of model.variants) {
      const mark = variant.isCanon ? 'канон ->' : '        ';
      console.log(
        `   ${mark} «${variant.spelling}» — ${withArchived(variant.cards, variant.archived)}`,
      );
    }
  }
}

const REASON_TEXT: Record<CandidateReason, string> = {
  хвост: 'общий хвост модели при разном начале',
  вставка: 'отличается вставкой слова-марки',
  вхождение: 'одно обозначение целиком входит в другое',
};

function printCandidates(candidates: readonly Candidate[]): void {
  section('3. Кандидаты в смысловые двойники (их накат НЕ сводит)');
  if (candidates.length === 0) {
    console.log('Не найдено. Это не гарантия: эвристика ловит только похожие написания,');
    console.log('а «Ricon» вместо «Ricoh» или другое торговое имя того же аппарата — не ловит.');
    return;
  }
  console.log('Решает человек, не скрипт: похожие обозначения бывают и у РАЗНЫХ аппаратов');
  console.log(
    '(«Aficio MP 301SP» и «Aficio MP 301SPF» — две разные модели). Пары показаны с числом',
  );
  console.log('карточек с обеих сторон, правят написание в портале и до наката.');
  console.log('');
  for (const c of candidates) {
    const detail = c.detail ? ` («${c.detail}»)` : '';
    console.log(`[${c.typeName}] «${c.shorter.canon}» — ${cardsWord(c.shorter.cards)}`);
    console.log(`         <-> «${c.longer.canon}» — ${cardsWord(c.longer.cards)}`);
    console.log(`             причина: ${REASON_TEXT[c.reason]}${detail}`);
  }
}

function printDistribution(models: readonly Model[], totalCards: number, archived: number): void {
  section('4. Карточки по моделям');
  if (models.length === 0) {
    console.log('Парк пуст: в office_equipment нет ни одной карточки. Разбирать нечего.');
    return;
  }
  const sorted = [...models].sort(
    (a, b) =>
      b.cards - a.cards ||
      a.typeSort - b.typeSort ||
      a.typeName.localeCompare(b.typeName, 'ru') ||
      a.canon.localeCompare(b.canon, 'ru'),
  );
  const width = Math.max(...sorted.map((m) => String(m.cards).length));
  const typeWidth = Math.max(...sorted.map((m) => m.typeName.length));
  for (const model of sorted) {
    const arch = model.archived > 0 ? `   (в архиве ${model.archived})` : '';
    const type = model.typeName.padEnd(typeWidth);
    console.log(`  ${String(model.cards).padStart(width)}  ${type}  ${model.canon}${arch}`);
  }
  console.log('');
  console.log(`Итого: моделей ${models.length}, карточек ${totalCards} (в архиве ${archived}).`);
}

async function main(): Promise<void> {
  const client = buildMigrationClient();
  await client.connect();
  let rows: VariantRow[];
  let totals: TotalsRow;
  let rule: Rule;
  try {
    rule = await ensureRule(client);
    const totalsResult = await client.query<TotalsRow>(TOTALS_SQL);
    totals = totalsResult.rows[0] ?? { cards: '0', archived: '0' };
    const variantsResult = await client.query<VariantRow>(variantsSql(rule.schema));
    rows = variantsResult.rows;
  } finally {
    await client.end();
  }

  const models = groupModels(rows);
  const totalCards = num(totals.cards);
  const archived = num(totals.archived);

  console.log(
    'ОТЧЁТ ПО МОДЕЛЯМ ОРГТЕХНИКИ — этап 0 плана docs/office-equipment-consumables-plan.md',
  );
  console.log(`Снят: ${new Date().toISOString()}. Данных в базе отчёт не меняет.`);
  console.log(`Правило написания: ${rule.source}.`);
  printSummary(totalCards, archived, models);
  printSpellings(models);
  printCandidates(findCandidates(models));
  printDistribution(models, totalCards, archived);
  console.log('');
  console.log(
    'Что дальше: ИТ-служба вычитывает разделы 2 и 3 и правит написания В ПОРТАЛЕ до наката',
  );
  console.log('миграции моделей. После наката двойники разводятся по одной карточке.');
}

main().catch((e) => {
  console.error('Ошибка отчёта по моделям оргтехники:', e);
  process.exit(EXIT_FAILURE);
});
