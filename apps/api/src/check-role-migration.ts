import { asc, inArray, sql } from 'drizzle-orm';
import {
  isPermission,
  permissionsFor,
  ROLE_MIGRATIONS,
  RETIRING_ROLES,
  roleLabels,
  roleMigrationOf,
  type CounterpartyType,
  type Permission,
  type Role,
  type RoleMigration,
} from '@technic/contracts';
import { closeDb, db } from './db/client';
import { users } from './db/schema';
import { grantCodesExpr, grantPermissionsExpr, systemAddonsOf } from './services/user-scopes';

/**
 * Сверка эквивалентности перевода ролей на живых данных (план реструктуризации §13.2 и §14,
 * переходный тест 1; ADR 0113).
 *
 * Тест эквивалентности в контрактах (`grants-contracts.test.ts`) доказывает равенство **составов**:
 * «старая роль = новая роль + наборы» поимённо по словарю прав. Этого мало, и вот чего он не видит:
 * состав считается по коду, а перевод поедет по данным — по тому, у кого какой набор действительно
 * выдан. Пропущенная учётка, отозванное администратором назначение, набор, собранный под старую
 * роль, — всё это расхождения, которых в коде нет вовсе. Поэтому сверка идёт по учёткам и печатает
 * разницу **поимённо**: «стало на двоих меньше» не подсказывает, у кого именно пропадёт заказ
 * техники, а решать это человеку.
 *
 * Использование (база не меняется: писать сюда нечего):
 *   pnpm --filter @technic/api check:role-migration
 *
 * Место в выкате — дважды, и оба раза обязательны:
 *   1. **после наката prepare** (миграции 0154–0156): между накатом и перезапуском приложения
 *      работает версия, которая старую роль ещё принимает, и заведённая в эти минуты учётка
 *      останется без снимка;
 *   2. **непосредственно перед migrate**, как условие выката: за релиз между шагами администратор
 *      мог отозвать взведённое назначение или сменить кому-то роль руками.
 *
 * Считает сверка два субъекта на одну учётку — сегодняшний и завтрашний — и оба **рабочим кодом**:
 * права наборов берёт то же выражение, которым их считает принципал (`grantPermissionsExpr`), а
 * складывает источники та же матрица (`permissionsFor`). Отличается второй субъект ровно одним —
 * ролью, под которую открывается гейт совместимости. Так и устроен перевод: `UPDATE users SET role`
 * и ничего больше.
 *
 * Виды отказа, и каждый требует своего решения:
 *   1. **учётка на упраздняемой роли без снимка** — перевод пойдёт по снимку и её не увидит, а роль
 *      к тому времени уже никого не пустит: доступ пропадёт молча;
 *   2. **права теряются** — взведённого назначения нет или оно отозвано; перевод отберёт доступ;
 *   3. **права появляются сверх объявленного** — расширение доступа, о котором заказчик не решал.
 *      Объявленное (оргтехника коменданту, решение №1) отказом не считается и печатается отдельно;
 *   4. **снимок разошёлся с учёткой** — роль сменили руками между шагами; такую учётку перевод
 *      пропустит по условию `WHERE u.role = m.role_before`, и разбирать её надо руками.
 *
 * Код возврата ненулевой при любом из четырёх: шаг стоит в чек-листе выката и обязан его
 * останавливать, а не сообщать.
 */

/** Сколько учёток печатать по каждому виду расхождения: разбирают их по одной, полотно не читается. */
const SAMPLE_LIMIT = 20;

/**
 * Права наборов при **целевой** роли — то же выражение, что `grantPermissionsExpr`, с одним
 * изменённым условием соединения.
 *
 * Копия, а не параметр производственного выражения, и это осознанно: то выражение отвечает на
 * вопрос «что учётка может сейчас», и добавлять в него роль-аргумент значило бы завести в рабочем
 * коде ветку, которой пользуется одна сверка. Отличие поэтому выписано здесь и видно целиком:
 * `gr.role` сравнивается не с ролью учётки, а с ролью, в которую её переводит таблица `ROLE_MIGRATIONS`.
 *
 * Соответствие подставляется списком `VALUES` из контрактов — тем же, по которому написаны миграции
 * prepare: три источника (миграция, сверка, форма) обязаны понимать перевод одинаково.
 *
 * **`${users}.role`, а не `${users.role}`** — по причине из `grantCodesExpr`: голый `"role"` в этой
 * области видимости разрешился бы в `gr.role`, и гейт совместимости превратился бы в тавтологию,
 * молча объявив перевод безопасным для всех.
 */
const targetGrantPermissionsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(DISTINCT gp.permission), '{}')
  FROM user_grants ug
  JOIN grants g ON g.id = ug.grant_id
  JOIN (VALUES ${sql.join(
    ROLE_MIGRATIONS.map((m) => sql`(${m.from}, ${m.to})`),
    sql`, `,
  )}) AS t (role_before, role_after) ON t.role_before = ${users}.role::text
  JOIN grant_roles gr ON gr.grant_id = ug.grant_id AND gr.role::text = t.role_after
  JOIN grant_permissions gp ON gp.grant_id = ug.grant_id
  WHERE ug.user_id = ${users}.id AND g.deleted_at IS NULL
)`;

/** Снимок учётки: есть ли он и что в нём записано. Подзапросами — по одному на колонку. */
const snapshotExpr = (column: string) => sql<string | null>`(
  SELECT m.${sql.raw(column)}::text
  FROM user_role_migration m
  WHERE m.user_id = ${users}.id
  ORDER BY m.stage
  LIMIT 1
)`;

interface AccountRow {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  isArchived: boolean;
  counterpartyType: CounterpartyType | null;
  grantCodes: string[];
  nowPermissions: string[];
  afterPermissions: string[];
  snapshotRoleBefore: string | null;
  snapshotRoleAfter: string | null;
  snapshotMigratedAt: string | null;
}

/** Разбор одной учётки: что она потеряет, что приобретёт и почему это отказ (или не отказ). */
interface Verdict {
  row: AccountRow;
  migration: RoleMigration;
  lost: Permission[];
  /** Приобретённое сверх объявленного расширения — то, о чём заказчик не решал. */
  unexpected: Permission[];
  /** Объявленное расширение, которое учётка действительно получит (комендант, решение №1). */
  declared: Permission[];
  /** Снимка нет: перевод её не увидит. */
  noSnapshot: boolean;
  /** Снимок есть, но роль учётки с ним разошлась — роль меняли руками. */
  snapshotMismatch: boolean;
  /** Наборы, которые перевод обязан был выдать и которых у учётки нет. */
  missingGrants: string[];
}

function who(row: AccountRow): string {
  const marks = [row.isActive ? null : 'выключена', row.isArchived ? 'в архиве' : null].filter(
    Boolean,
  );
  const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  return `${row.fullName} <${row.email}>${suffix}`;
}

/** Права из базы — строки; сироту (право, снятое из словаря выкатом) отсеивает граница, как принципал. */
function permissionsOf(raw: string[]): Permission[] {
  return raw.filter(isPermission);
}

function difference(a: readonly Permission[], b: readonly Permission[]): Permission[] {
  const other = new Set(b);
  return a.filter((p) => !other.has(p));
}

async function collect(): Promise<AccountRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      isArchived: sql<boolean>`${users.deletedAt} IS NOT NULL`,
      // Тип контрагента у площадочных и отдельских ролей не читается вовсе (`can`), но субъект
      // собирается полным: сверка не должна отличаться от принципала ничем, кроме роли.
      counterpartyType: sql<CounterpartyType | null>`(
        SELECT c.type FROM counterparties c WHERE c.id = ${users.counterpartyId}
      )`,
      grantCodes: grantCodesExpr,
      nowPermissions: grantPermissionsExpr,
      afterPermissions: targetGrantPermissionsExpr,
      snapshotRoleBefore: snapshotExpr('role_before'),
      snapshotRoleAfter: snapshotExpr('role_after'),
      snapshotMigratedAt: snapshotExpr('migrated_at'),
    })
    .from(users)
    // Архивные и выключенные учётки в отборе намеренно (§13.2): деактивированный комендант
    // вернётся через полгода с ролью, которой в `ROLES` уже нет.
    .where(inArray(users.role, [...RETIRING_ROLES]))
    .orderBy(asc(users.fullName));
  return rows as AccountRow[];
}

function judge(row: AccountRow): Verdict {
  const migration = roleMigrationOf(row.role)!;
  const addons = systemAddonsOf(row.grantCodes);
  const now = permissionsFor({
    role: row.role,
    counterpartyType: row.counterpartyType,
    addons,
    grantPermissions: permissionsOf(row.nowPermissions),
  });
  const after = permissionsFor({
    role: migration.to,
    counterpartyType: row.counterpartyType,
    addons,
    grantPermissions: permissionsOf(row.afterPermissions),
  });
  const gained = difference(after, now);
  const declaredSet = new Set(migration.gains);
  const held = new Set(row.grantCodes);
  return {
    row,
    migration,
    lost: difference(now, after),
    unexpected: gained.filter((p) => !declaredSet.has(p)),
    declared: gained.filter((p) => declaredSet.has(p)),
    noSnapshot: row.snapshotRoleBefore === null,
    // Роль учётки обязана совпадать с записанной в снимке: перевод идёт по ней
    // (`WHERE u.role = m.role_before`), и разошедшаяся строка означает правку руками.
    snapshotMismatch: row.snapshotRoleBefore !== null && row.snapshotRoleBefore !== row.role,
    missingGrants: migration.grants.filter((code) => !held.has(code)),
  };
}

function failed(v: Verdict): boolean {
  return v.noSnapshot || v.snapshotMismatch || v.lost.length > 0 || v.unexpected.length > 0;
}

/** Одна сторона отчёта: список учёток с пояснением, подрезанный со счётчиком остатка. */
function printAccounts(title: string, lines: string[]): void {
  console.error(`  ${title} (${lines.length}):`);
  for (const line of lines.slice(0, SAMPLE_LIMIT)) console.error(`    · ${line}`);
  if (lines.length > SAMPLE_LIMIT) console.error(`    … и ещё ${lines.length - SAMPLE_LIMIT}`);
}

function printStage(stage: 8 | 9, verdicts: Verdict[]): { failed: number } {
  const migrations = ROLE_MIGRATIONS.filter((m) => m.stage === stage);
  const roles = migrations.map((m) => `«${roleLabels[m.from]}»`).join(', ');
  console.log(`\n── Этап ${stage}: ${roles} → «${roleLabels[migrations[0]!.to]}» ──`);
  if (verdicts.length === 0) {
    console.log('  Учёток на этих ролях нет: переводить некого.');
    return { failed: 0 };
  }

  for (const m of migrations) {
    const own = verdicts.filter((v) => v.migration.from === m.from);
    const prepared = own.filter((v) => !v.noSnapshot).length;
    const grants = m.grants.length > 0 ? m.grants.join(', ') : '—';
    console.log(
      `  ${roleLabels[m.from]}: учёток ${own.length}, со снимком ${prepared}, наборы перевода: ${grants}`,
    );
  }

  const migrated = verdicts.filter((v) => v.row.snapshotMigratedAt !== null);
  if (migrated.length > 0) {
    // До шага migrate таких быть не должно вовсе: снимок с отметкой перевода при старой роли
    // означает, что перевод шёл и не довёл до конца.
    printAccounts(
      'ОТМЕТКА ПЕРЕВОДА ПРИ СТАРОЙ РОЛИ — перевод шёл и не завершился',
      migrated.map((v) => `${who(v.row)}: ${v.row.snapshotMigratedAt}`),
    );
  }

  const noSnapshot = verdicts.filter((v) => v.noSnapshot);
  if (noSnapshot.length > 0) {
    printAccounts(
      'ОТКАЗ: снимка нет — перевод пойдёт по снимку и эти учётки пропустит',
      noSnapshot.map((v) => `${who(v.row)}: ${roleLabels[v.row.role]}`),
    );
  }

  const mismatch = verdicts.filter((v) => !v.noSnapshot && v.snapshotMismatch);
  if (mismatch.length > 0) {
    printAccounts(
      'ОТКАЗ: снимок разошёлся с учёткой — роль меняли руками, нужен разбор',
      mismatch.map(
        (v) => `${who(v.row)}: в снимке ${v.row.snapshotRoleBefore}, сейчас ${v.row.role}`,
      ),
    );
  }

  const lost = verdicts.filter((v) => v.lost.length > 0);
  if (lost.length > 0) {
    printAccounts(
      'ОТКАЗ: перевод отберёт права',
      lost.map((v) => {
        const missing =
          v.missingGrants.length > 0 ? `; не выдано: ${v.missingGrants.join(', ')}` : '';
        return `${who(v.row)}: −${v.lost.join(', ')}${missing}`;
      }),
    );
  }

  const unexpected = verdicts.filter((v) => v.unexpected.length > 0);
  if (unexpected.length > 0) {
    printAccounts(
      'ОТКАЗ: перевод добавит права сверх объявленного',
      unexpected.map((v) => `${who(v.row)}: +${v.unexpected.join(', ')}`),
    );
  }

  const declared = verdicts.filter((v) => v.declared.length > 0);
  if (declared.length > 0) {
    // Объявленное расширение — не отказ, но и не молчание: заказчик решал его поимённо (решение
    // №1), и число людей, которых оно коснётся, он вправе видеть до перевода, а не после.
    const sample = declared.slice(0, 3).map((v) => who(v.row));
    console.log(
      `  Объявленное расширение (решение №1): ${declared.length} учёток получат ` +
        `${declared[0]!.declared.join(', ')}\n    например: ${sample.join('; ')}`,
    );
  }

  const bad = verdicts.filter(failed).length;
  if (bad === 0) {
    console.log(`  Права совпали у всех ${verdicts.length} учёток: перевод ничего не меняет.`);
  }
  return { failed: bad };
}

async function main(): Promise<void> {
  const rows = await collect();
  const verdicts = rows.map(judge);
  console.log(
    `Учёток на упраздняемых ролях: ${verdicts.length}. ` +
      'Сверка считает права до перевода и после — по каждой поимённо.',
  );

  let failedTotal = 0;
  for (const stage of [8, 9] as const) {
    failedTotal += printStage(
      stage,
      verdicts.filter((v) => v.migration.stage === stage),
    ).failed;
  }

  if (failedTotal === 0) {
    console.log(
      '\nИтог: перевод эквивалентен — ни одна учётка не теряет и не приобретает лишнего.',
    );
    return;
  }
  console.error(`\nИтог: учёток с отказом — ${failedTotal} из ${verdicts.length}.`);
  console.error(
    'Переводить в таком состоянии нельзя: разберите каждую строку выше. Взведённое назначение\n' +
      'возвращается выдачей набора через реестр либо повторным накатом prepare — он идемпотентен\n' +
      '(`ON CONFLICT DO NOTHING`) и заново создаёт только недостающее.',
  );
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('Сверка перевода ролей не удалась:', e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
