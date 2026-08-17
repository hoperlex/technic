import { asc, eq, inArray } from 'drizzle-orm';
import { isPermission, PERMISSIONS, type Permission, type Role } from '@technic/contracts';
import { closeDb, db } from './db/client';
import {
  mailingSchedulePermissions,
  mailingScheduleRoles,
  mailingSchedules,
  mailingScheduleScopes,
  users,
} from './db/schema';
import {
  type DigestRecipient,
  digestRecipientsBy,
  permissionAudienceWhere,
} from './services/mailings/role-digest';

/**
 * Сверка аудитории ролевых сводок до и после переезда адресации с роли на право (ADR 0111; план
 * реструктуризации §15, этап 7).
 *
 * Критерий готовности этапа сформулирован заказчиком одной фразой: **список получателей каждого
 * расписания до и после совпадает поимённо**. Скрипт и есть проверка этой фразы — он считает обе
 * стороны и печатает разницу фамилиями, а не числами: «стало на двоих больше» не подсказывает, кому
 * начали писать, а именно это и нужно решать человеку.
 *
 * Использование (база не меняется ни при каких флагах — писать сюда нечего):
 *   pnpm --filter @technic/api check:mailing-audience
 *
 * Место в выкате — сразу после миграции `0151` (runbook). Идёт он ПОСЛЕ, а не до, потому что
 * подбирает адресацию сама миграция: она считает то же равенство на живых данных, а скрипт
 * пересчитывает его **рабочим кодом рассылки** — тем самым `digestRecipientsBy`, которым письма и
 * отбираются. Два независимых счёта одного множества и есть смысл шага: совпади они, перенос
 * доказан; разойдись — доказано, что SQL миграции разошёлся с `can`, и это надо чинить до первой
 * вечерней рассылки.
 *
 * Три вида отказа, и каждый требует своего решения:
 *   1. **расписание без адресации** — эквивалентного права не нашлось, и рассылка по нему не уйдёт
 *      никому; право выбирает человек в форме, скрипт печатает ближайших кандидатов с ценой каждого;
 *   2. **аудитория разошлась** — право подобрано не то, и письма пойдут не тем;
 *   3. **право-сирота** — в таблице лежит право, которого нет в словаре кода (снято выкатом);
 *      адресация по нему молча не сработает.
 *
 * Код возврата ненулевой при любом из трёх: шаг стоит в чек-листе выката и обязан его
 * останавливать, а не сообщать.
 */

/** Сколько имён печатать по каждой стороне расхождения: разбирают их по одному, полотно не читается. */
const SAMPLE_LIMIT = 20;

/** Сколько ближайших кандидатов предлагать расписанию, которому право не подобралось. */
const CANDIDATE_LIMIT = 5;

/**
 * Право, без которого сводка не собирается вовсе (`buildRoleDigestMail`): модуль заказов техники.
 *
 * Им же считается «адресат» в отличие от «получателя отбора», и на этом различии держится вся
 * сверка. Комендант, механик и водитель проходили прежний отбор по роли и не получали ничего —
 * письмо им не составлялось. Сравнивай мы множества до этого гейта, расписание, где отмечены такие
 * роли, разошлось бы «по вине» людей, которым и раньше не приходило ни строчки.
 */
const DIGEST_MODULE_PERMISSION: Permission = 'vehicleRequests.read';

interface ScheduleAudit {
  id: string;
  name: string;
  isEnabled: boolean;
  roles: Role[];
  permissions: Permission[];
  /** Строки таблицы, которых нет в словаре кода: адресация по ним не сработает. */
  orphanPermissions: string[];
  /** Получатели отбора: кого вернёт запрос рассылки. */
  before: DigestRecipient[];
  after: DigestRecipient[];
  /** Из них те, кому письмо вообще может составиться, — по ним и сверяется переезд. */
  beforeAddressed: DigestRecipient[];
  afterAddressed: DigestRecipient[];
  /** Права, которые дали бы на сегодняшних данных ту же аудиторию; первое из них и выбрано. */
  equivalents: Permission[];
  /** Ближайшие промахи для расписания без адресации: право и цена его выбора. */
  candidates: { permission: Permission; lost: number; gained: number }[];
}

function who(r: DigestRecipient): string {
  return `${r.fullName} <${r.email}>`;
}

/** Множество получателей ключом «id»: сравнивать надо учётки, а печатать — имена. */
function idsOf(list: DigestRecipient[]): Set<string> {
  return new Set(list.map((r) => r.userId));
}

function difference(a: DigestRecipient[], b: DigestRecipient[]): DigestRecipient[] {
  const other = idsOf(b);
  return a
    .filter((r) => !other.has(r.userId))
    .sort((x, y) => x.fullName.localeCompare(y.fullName, 'ru'));
}

/**
 * Аудитория расписания при заданном адресе — тем же кодом, каким её считает рассылка.
 *
 * Область и поимённый перечень берутся из самого расписания: они одинаковы по обе стороны, но
 * применяются после адреса, и считать «до» без них, а «после» с ними значило бы сравнивать разное.
 */
async function audienceOf(
  schedule: { id: string; scopeMode: 'all' | 'selected'; recipientMode: 'all' | 'selected' },
  scopes: { objectIds: string[]; departmentIds: string[] },
  permissions: readonly Permission[],
): Promise<DigestRecipient[]> {
  return digestRecipientsBy(
    schedule.id,
    {
      scopeMode: schedule.scopeMode,
      objectIds: scopes.objectIds,
      departmentIds: scopes.departmentIds,
      recipientMode: schedule.recipientMode,
    },
    permissionAudienceWhere(permissions),
  );
}

async function collect(): Promise<ScheduleAudit[]> {
  const schedules = await db
    .select()
    .from(mailingSchedules)
    .where(eq(mailingSchedules.type, 'role_digest'))
    .orderBy(asc(mailingSchedules.name));
  if (schedules.length === 0) return [];

  const ids = schedules.map((s) => s.id);
  const roleRows = await db
    .select({ scheduleId: mailingScheduleRoles.scheduleId, role: mailingScheduleRoles.role })
    .from(mailingScheduleRoles)
    .where(inArray(mailingScheduleRoles.scheduleId, ids));
  const permissionRows = await db
    .select({
      scheduleId: mailingSchedulePermissions.scheduleId,
      permission: mailingSchedulePermissions.permission,
    })
    .from(mailingSchedulePermissions)
    .where(inArray(mailingSchedulePermissions.scheduleId, ids));
  const scopeRows = await db
    .select({
      scheduleId: mailingScheduleScopes.scheduleId,
      objectId: mailingScheduleScopes.objectId,
      departmentId: mailingScheduleScopes.departmentId,
    })
    .from(mailingScheduleScopes)
    .where(inArray(mailingScheduleScopes.scheduleId, ids));

  const result: ScheduleAudit[] = [];
  for (const schedule of schedules) {
    const roles = roleRows.filter((r) => r.scheduleId === schedule.id).map((r) => r.role);
    const own = permissionRows.filter((r) => r.scheduleId === schedule.id).map((r) => r.permission);
    const permissions = PERMISSIONS.filter((p) => own.includes(p));
    const scopes = {
      objectIds: scopeRows.flatMap((r) =>
        r.scheduleId === schedule.id && r.objectId ? [r.objectId] : [],
      ),
      departmentIds: scopeRows.flatMap((r) =>
        r.scheduleId === schedule.id && r.departmentId ? [r.departmentId] : [],
      ),
    };

    // «До» считается прежним адресом — именами ролей. Условие собирается здесь, а не в сервисе:
    // рассылка ролей больше не знает, и заводить ради сверки второй живой путь адресации незачем.
    const before =
      roles.length === 0
        ? []
        : await digestRecipientsBy(
            schedule.id,
            {
              scopeMode: schedule.scopeMode,
              objectIds: scopes.objectIds,
              departmentIds: scopes.departmentIds,
              recipientMode: schedule.recipientMode,
            },
            inArray(users.role, roles),
          );
    const after = await audienceOf(schedule, scopes, permissions);
    const addressable = idsOf(await audienceOf(schedule, scopes, [DIGEST_MODULE_PERMISSION]));

    const beforeAddressed = before.filter((r) => addressable.has(r.userId));
    const afterAddressed = after.filter((r) => addressable.has(r.userId));

    // Все права, дающие сегодня ту же аудиторию: миграция выбрала одно из них, и знать остальные
    // полезно — на живых данных они неразличимы, а завтра разойдутся.
    const equivalents: Permission[] = [];
    const candidates: { permission: Permission; lost: number; gained: number }[] = [];
    for (const permission of PERMISSIONS) {
      const audience = (await audienceOf(schedule, scopes, [permission])).filter((r) =>
        addressable.has(r.userId),
      );
      const lost = difference(beforeAddressed, audience).length;
      const gained = difference(audience, beforeAddressed).length;
      if (lost === 0 && gained === 0 && audience.length > 0) equivalents.push(permission);
      else if (audience.length > 0) candidates.push({ permission, lost, gained });
    }
    // Сперва те, кто никого не теряет: расширение аудитории человек хотя бы видит в форме, а
    // потерянный получатель молчит — он просто перестаёт получать письма.
    candidates.sort((a, b) => a.lost - b.lost || a.gained - b.gained);

    result.push({
      id: schedule.id,
      name: schedule.name,
      isEnabled: schedule.isEnabled,
      roles,
      permissions,
      orphanPermissions: own.filter((p) => !isPermission(p)),
      before,
      after,
      beforeAddressed,
      afterAddressed,
      equivalents,
      candidates: candidates.slice(0, CANDIDATE_LIMIT),
    });
  }
  return result;
}

/** Одна сторона расхождения списком имён; длинный список подрезается со счётчиком остатка. */
function printNames(title: string, rows: DigestRecipient[]): void {
  console.log(`    ${title} (${rows.length}):`);
  for (const row of rows.slice(0, SAMPLE_LIMIT)) console.log(`      · ${who(row)}`);
  if (rows.length > SAMPLE_LIMIT) console.log(`      … и ещё ${rows.length - SAMPLE_LIMIT}`);
}

function printSchedule(a: ScheduleAudit): { failed: boolean } {
  const state = a.isEnabled ? 'включено' : 'выключено';
  console.log(`\n· «${a.name}» (${state}, ${a.id})`);
  console.log(`    роли до: ${a.roles.join(', ') || '—'}`);
  console.log(`    права после: ${a.permissions.join(', ') || '—'}`);

  if (a.orphanPermissions.length > 0) {
    console.error(
      `    ОТКАЗ: в таблице право вне словаря кода: ${a.orphanPermissions.join(', ')}. ` +
        'Адресация по нему не сработает — снимите строку или верните право в словарь.',
    );
    return { failed: true };
  }

  if (a.permissions.length === 0) {
    console.error(
      '    ОТКАЗ: адресация не подобрана — эквивалентного права нет, рассылка не уйдёт никому.',
    );
    printNames('кому уходило до переезда', a.beforeAddressed);
    if (a.beforeAddressed.length === 0) {
      console.log(
        '    Аудитория была пуста и до переезда: роли расписания не дают доступа к модулю\n' +
          '    заказов техники, и письма по нему не составлялись. Решать нечего — расписание\n' +
          '    надо либо перенастроить, либо выключить.',
      );
    }
    if (a.candidates.length > 0) {
      console.log('    Ближайшие права и цена каждого:');
      for (const c of a.candidates) {
        console.log(`      · ${c.permission}: потеряется ${c.lost}, добавится ${c.gained}`);
      }
      console.log(
        '    Выбор — за заказчиком: приближение здесь означало бы менять аудиторию молча.',
      );
    }
    return { failed: true };
  }

  const lost = difference(a.beforeAddressed, a.afterAddressed);
  const gained = difference(a.afterAddressed, a.beforeAddressed);
  if (lost.length === 0 && gained.length === 0) {
    console.log(`    адресаты совпали поимённо: ${a.beforeAddressed.length}`);
    // Отбор шире адресатов: в него попадают те, кому письмо всё равно не составится. Разница по
    // нему — не отказ, но она объясняет, почему в форме расписания счётчик изменился.
    const wideLost = difference(a.before, a.after).length;
    const wideGained = difference(a.after, a.before).length;
    if (wideLost > 0 || wideGained > 0) {
      console.log(
        `    отбор без гейта модуля изменился: −${wideLost} / +${wideGained} ` +
          '(этим людям письмо не составлялось и не составится — у них нет vehicleRequests.read)',
      );
    }
    if (a.equivalents.length > 1) {
      const others = a.equivalents.filter((p) => !a.permissions.includes(p));
      if (others.length > 0) {
        console.log(`    ту же аудиторию дают также: ${others.join(', ')}`);
      }
    }
    return { failed: false };
  }

  console.error('    ОТКАЗ: аудитория разошлась.');
  if (lost.length > 0) printNames('перестанут получать', lost);
  if (gained.length > 0) printNames('начнут получать', gained);
  return { failed: true };
}

async function main(): Promise<void> {
  const audits = await collect();
  if (audits.length === 0) {
    console.log('Расписаний-сводок нет: сверять нечего.');
    return;
  }
  console.log(`Расписаний-сводок: ${audits.length}. Сверка «до» — по ролям, «после» — по правам.`);

  let failed = 0;
  for (const audit of audits) {
    if (printSchedule(audit).failed) failed += 1;
  }

  if (failed === 0) {
    console.log('\nИтог: аудитория каждого расписания совпала поимённо, переезд подтверждён.');
    return;
  }
  console.error(`\nИтог: расписаний с отказом — ${failed} из ${audits.length}.`);
  console.error(
    'Разобрать их надо до ближайшей вечерней рассылки: расписание без адресации молчит,\n' +
      'а расписание с не тем правом пишет не тем.',
  );
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('Сверка аудитории не удалась:', e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
