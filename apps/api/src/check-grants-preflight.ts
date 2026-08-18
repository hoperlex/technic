import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { MAX_ASSIGNED_GRANTS, roleLabels, type Role } from '@technic/contracts';
import { closeDb, db } from './db/client';
import { grants, userGrants, users } from './db/schema';

/**
 * Preflight перед этапом 1б фичи «полномочия назначаются в окне учётки»
 * (`docs/account-form-grants-plan.md` §7.1) — две выборки по проду, обе до выката, и каждая решает
 * свой вопрос.
 *
 * **1. Кого задевает ограничение молчания** (§4.2). С этапа 1б запрос без поля `grants` перестаёт
 * быть безусловно законным: если смена роли переключает действие уже выданного назначения, сервер
 * отвечает 400 «откройте карточку заново». Поля `grants` старый портал не шлёт и выслать не может,
 * поэтому в окне между этапами 1б и 2 держателю набора роль формой не меняют вовсе — только отзывом
 * набора в реестре выдач и повторной выдачей после смены. Список таких людей администраторам
 * показывают заранее, и он же — ответ на вопрос «насколько ограничение задевает живые данные»:
 * рассуждение о трёх ролевых наборах поставочного каталога ответом не является, потому что
 * конструктор заводит наборы прямо в проде.
 *
 * Строка здесь — на учётку, а не на набор: считать надо держателей, а не назначения. Мягко
 * удалённый набор из отбора исключён — он не действует ни у кого (`grantCodesExpr`), и высказаться
 * о нём форме нечем: она его не показывает. Архивные учётки, наоборот, оставлены намеренно —
 * восстановление возвращает их назначения в действие, и попасть под ограничение они могут в тот же
 * день; признак вынесен отдельной пометкой, чтобы их было видно.
 *
 * Печатаются `id` и ФИО, а не один адрес: индекс `users_email_unique` частичный
 * (`WHERE deleted_at IS NULL`, ADR 0063), поэтому две архивные строки с одинаковым адресом —
 * законное состояние, и различить их можно только `id`.
 *
 * **2. Чему равен предел назначений** (§4, §4.2). `MAX_ASSIGNED_GRANTS` — граница итога операции,
 * общая у обоих путей выдачи. Поставленная ниже факта, она запрещает сохранить карточку человека,
 * которому ничего не добавляли: правка телефона упёрлась бы в предел полномочий. Поэтому значение
 * из контрактов сверяется не с ожиданием, а с самой нагруженной учёткой прода — топ-5 печатается
 * целиком, чтобы был виден и запас, а не только вердикт. Архивные учётки считаются и здесь, и по
 * той же причине.
 *
 * Использование (база не меняется: писать сюда нечего):
 *   pnpm --filter @technic/api check:grants-preflight
 *
 * **Код возврата ненулевой ровно в одном случае — факт выше предела.** Список держателей сам по
 * себе не отказ: он не чинится выкатом и правится не кодом, а порядком работы администраторов —
 * смена роли такому человеку до этапа 2 идёт через реестр выдач. Останавливать выкат обязано
 * другое: предел, который окажется ниже факта, сделает карточки самых нагруженных учёток
 * несохраняемыми, и лечится это снятием лишних назначений реестром **до** выката, а не после.
 */

/** Сколько самых нагруженных учёток печатать: §7.1 просит пять — запас виден, полотна нет. */
const TOP_LIMIT = 5;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читателю транзакция не нужна, но db-тест гоняет обе выборки в откатываемой — как и в проде. */
export type Reader = Tx | typeof db;

/** Держатель живых назначений: строка на учётку с перечнем кодов её наборов. */
export interface GrantHolder {
  id: string;
  fullName: string;
  email: string;
  role: Role | null;
  /** Учётка в архиве: восстановление вернёт её назначения в действие. */
  archived: boolean;
  /** Коды наборов по алфавиту — порядок не должен зависеть от того, в каком их выдавали. */
  codes: string[];
}

/** Нагрузка одной учётки: сколько назначений считает сервер и сколько лежит строк. */
export interface GrantLoad {
  id: string;
  fullName: string;
  email: string;
  archived: boolean;
  /** Назначения живых наборов — то самое число, которое сервер сравнит с пределом. */
  live: number;
  /** Все строки `user_grants` учётки, включая назначения на мягко удалённые наборы. */
  total: number;
}

export interface Preflight {
  holders: GrantHolder[];
  /** Топ по нагрузке, по убыванию живых назначений. */
  load: GrantLoad[];
  /** Факт: сколько живых назначений у самой нагруженной учётки. */
  maxAssigned: number;
  /** Значение из контрактов, с которым факт и сверяется. */
  limit: number;
  /** Единственный вид отказа: предел ниже факта. */
  limitExceeded: boolean;
  /**
   * Назначения на мягко удалённые наборы во всей базе. В норме их нет вовсе: удалить набор можно
   * только после отзыва у всех держателей (409 со списком). Ненулевое число — не отказ, но оно
   * объясняет расхождение двух выборок и стоит разбора.
   */
  staleAssignments: number;
}

/** Учётка в архиве — выражением, а не колонкой: `deleted_at` хранит момент, а нужен признак. */
const archivedExpr = sql<boolean>`${users.deletedAt} IS NOT NULL`;

/**
 * Держатели живых назначений (§7.1, первый запрос).
 *
 * Группировка идёт по `users.id` одному: остальные колонки учётки функционально зависят от
 * первичного ключа, и Postgres их отдаёт без перечисления в `GROUP BY`.
 *
 * Отбирать «переключаемые» наборы отдельным условием нельзя, и это решение плана, а не упрощение:
 * роль `driver` по инварианту каталога не входит в `grant_roles` ни одного набора, поэтому условие
 * «покрывает все роли» не выполняется ни для кого — попытка сузить отбор вернула бы попросту всех
 * держателей, но выглядела бы точной.
 */
export async function collectHolders(reader: Reader): Promise<GrantHolder[]> {
  return (
    reader
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
        archived: archivedExpr,
        codes: sql<string[]>`array_agg(${grants.code} ORDER BY ${grants.code})`,
      })
      .from(userGrants)
      .innerJoin(grants, and(eq(grants.id, userGrants.grantId), isNull(grants.deletedAt)))
      .innerJoin(users, eq(users.id, userGrants.userId))
      .groupBy(users.id)
      // Сначала живые, потом архив — список читают сверху и разбирают действующие учётки.
      .orderBy(archivedExpr, asc(users.fullName))
  );
}

/**
 * Самые нагруженные учётки (§7.1, второй запрос).
 *
 * Считаются две величины, и различие между ними существенно. `live` — назначения живых наборов,
 * ровно то, что складывает итог операции сервер (`assignmentsOfUser` отсеивает мягко удалённые), и
 * именно с ним сверяется предел. `total` — все строки `user_grants`, как в запросе плана; в норме
 * числа равны, а разойтись они могут только на аномалии, которую стоит увидеть, а не спрятать.
 */
export async function collectLoad(reader: Reader): Promise<GrantLoad[]> {
  const live = sql<number>`count(*) FILTER (WHERE ${grants.deletedAt} IS NULL)::int`;
  const total = sql<number>`count(*)::int`;
  return reader
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      archived: archivedExpr,
      live,
      total,
    })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .innerJoin(users, eq(users.id, userGrants.userId))
    .groupBy(users.id)
    .orderBy(desc(live), desc(total))
    .limit(TOP_LIMIT);
}

/** Назначения на мягко удалённые наборы — одним числом на всю базу. */
async function countStale(reader: Reader): Promise<number> {
  const [row] = await reader
    .select({ count: sql<number>`count(*)::int` })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .where(sql`${grants.deletedAt} IS NOT NULL`);
  return row?.count ?? 0;
}

/** Обе выборки и вердикт по ним. Ничего не печатает и ничего не пишет в базу. */
export async function collectPreflight(reader: Reader = db): Promise<Preflight> {
  const holders = await collectHolders(reader);
  const load = await collectLoad(reader);
  const staleAssignments = await countStale(reader);
  const maxAssigned = load.reduce((max, row) => Math.max(max, row.live), 0);
  return {
    holders,
    load,
    maxAssigned,
    limit: MAX_ASSIGNED_GRANTS,
    limitExceeded: maxAssigned > MAX_ASSIGNED_GRANTS,
    staleAssignments,
  };
}

function who(row: { fullName: string; email: string; id: string }): string {
  return `${row.fullName} <${row.email}> [${row.id}]`;
}

function roleOf(role: Role | null): string {
  return role ? roleLabels[role] : 'без роли';
}

function printHolders(holders: GrantHolder[]): void {
  console.log(`\n── Кого задевает ограничение молчания (§4.2): держателей ${holders.length} ──`);
  if (holders.length === 0) {
    console.log(
      '  Держателей нет: живых назначений в базе не выдано никому, и окно перехода между\n' +
        '  этапами 1б и 2 безопасно целиком — смену роли формой ни у кого не отберёт.',
    );
    return;
  }
  // Список печатается целиком, без подрезки: он и есть ответ выборки, а не образец расхождения, —
  // администраторам раздают именно его, и «… и ещё 12» означало бы двенадцать человек, которым
  // смену роли запретят молча.
  for (const holder of holders) {
    const marks = [roleOf(holder.role), holder.archived ? 'в архиве' : null].filter(Boolean);
    console.log(`  · ${who(holder)}`);
    console.log(
      `      ${marks.join(', ')}; наборов ${holder.codes.length}: ${holder.codes.join(', ')}`,
    );
  }
  const archived = holders.filter((holder) => holder.archived).length;
  if (archived > 0) {
    console.log(
      `  Из них в архиве: ${archived}. Из отбора они не выброшены намеренно — восстановление\n` +
        '  возвращает их назначения в действие, и под ограничение они попадут в тот же день.',
    );
  }
  console.log(
    '  Что с этим делать: до выката портальной части (этап 2) роль перечисленным формой не\n' +
      '  меняется — сервер ответит 400 «откройте карточку заново». Такая смена идёт через реестр\n' +
      '  выдач: отозвать набор, сменить роль, выдать заново.',
  );
}

function printLoad(preflight: Preflight): void {
  console.log(`\n── Предел назначений (§4): MAX_ASSIGNED_GRANTS = ${preflight.limit} ──`);
  if (preflight.load.length === 0) {
    console.log('  Назначений нет ни у кого: факт равен нулю, предел заведомо выше.');
    return;
  }
  preflight.load.forEach((row, index) => {
    const stale = row.total > row.live ? `, строк всего ${row.total}` : '';
    const archived = row.archived ? ', в архиве' : '';
    console.log(`  ${index + 1}. ${who(row)} — назначений ${row.live}${stale}${archived}`);
  });
  if (preflight.staleAssignments > 0) {
    console.log(
      `  Назначений на мягко удалённые наборы: ${preflight.staleAssignments}. Права они не дают и\n` +
        '  в итог операции не входят, но появиться не должны были: удаление набора требует\n' +
        '  отзыва у всех держателей — строки стоит разобрать реестром.',
    );
  }
}

export function printReport(preflight: Preflight): void {
  console.log(
    'Preflight перед этапом 1б (план §7.1): две выборки по живым данным — держатели полномочий\n' +
      'и нагрузка самой заполненной учётки. База не меняется.',
  );
  printHolders(preflight.holders);
  printLoad(preflight);

  if (preflight.limitExceeded) {
    console.error(
      `\nИтог: ОТКАЗ — предел ниже факта. MAX_ASSIGNED_GRANTS = ${preflight.limit}, а у самой\n` +
        `нагруженной учётки назначений ${preflight.maxAssigned}. Выкатывать этап 1б в таком виде\n` +
        'нельзя: карточка такого человека перестанет сохраняться вовсе, включая правку телефона.\n' +
        'Лишние назначения снимаются реестром выдач до выката — либо константа поднимается выше\n' +
        'факта с запасом на рост.',
    );
    return;
  }
  console.log(
    `\nИтог: предел годится — MAX_ASSIGNED_GRANTS = ${preflight.limit} при факте ` +
      `${preflight.maxAssigned} (запас ${preflight.limit - preflight.maxAssigned}).`,
  );
  console.log(
    preflight.holders.length === 0
      ? 'Под ограничение молчания (§4.2) не попадает никто: держателей полномочий нет.'
      : `Под ограничение молчания (§4.2) попадает учёток: ${preflight.holders.length} — ` +
          'список выше,\nотдайте его администраторам до выката этапа 1б.',
  );
}

async function main(): Promise<void> {
  const preflight = await collectPreflight();
  printReport(preflight);
  if (preflight.limitExceeded) process.exitCode = 1;
}

// Запуск только из командной строки — в отличие от соседних сверок, которые вызывают `main` при
// импорте безусловно. Здесь выборки и вердикт импортирует db-тест, и запуск при импорте означал бы
// отчёт по чужой базе с закрытым следом пулом, из которого тест читает.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  main()
    .catch((e) => {
      console.error('Preflight полномочий не удался:', e);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
