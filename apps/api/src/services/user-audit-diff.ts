import {
  formatPhone,
  roleAddonLabels,
  roleLabels,
  userAuditActiveTitles,
  type AuditChangeDto,
  type Role,
  type RoleAddon,
  type UserAccountDto,
  type UserDepartmentRefDto,
  type UserObjectRefDto,
} from '@technic/contracts';
import { changeSet, EMPTY } from './request-diff';

// Что правка изменила в учётной записи (ADR 0109) — то, из чего складывается журнал изменений в
// подвкладке «Аудит». Сравниваются карточки «до» и «после» (`UserAccountDto`), а не колонки: в
// журнал идут названия объектов и отделов, ФИО работника и подпись роли — то, что администратор
// видел в форме, а не идентификаторы, по которым потом ничего не восстановить.
//
// Модуль намеренно не знает о БД — так его считает и проверяет тест без поднятого приложения. Тем
// же приёмом устроены диффы заявок (`request-diff.ts`), и общая механика пары «было → стало»
// берётся оттуда же.

/** Роль словами; учётка без роли — это заявка, и «—» вместо неё скрыло бы, чем она была. */
function roleTitle(role: Role | null): string {
  return role === null ? 'без роли' : roleLabels[role];
}

/** Область видимости в журнале — по названиям: коды справочников читателю ничего не говорят. */
function scopeTitles(items: readonly UserObjectRefDto[]): Map<string, string> {
  return new Map(items.map((i) => [i.id, i.name]));
}

/**
 * Отдел в журнале — с ответом «руководил ли он им» (`user_departments.is_head`, миграция 0149).
 *
 * Признак идёт подписью отдела, а не отдельной парой «было → стало», потому что из карточки учётки
 * он меняется ровно одним способом: уходит вместе с отделом, убранным из набора
 * (`replaceUserDepartments`) — в том числе когда набор обнуляет смена роли на объектную. «ПТО» и
 * «ПТО (руководитель)» в снятых — разные события: во втором отдел остался без руководителя, и
 * узнавать об этом из справочника через неделю поздно.
 *
 * Смены признака у отдела, который в наборе остался, здесь не бывает: ставят и снимают его только
 * из карточки справочника, и она пишет своё событие (`department.update`). Поэтому сравнения
 * «признак был → стал» тут нет — оно молчало бы всегда.
 */
function departmentTitles(items: readonly UserDepartmentRefDto[]): Map<string, string> {
  return new Map(items.map((d) => [d.id, d.isHead ? `${d.name} (руководитель)` : d.name]));
}

/** Что в наборе появилось и что из него ушло: вопрос к журналу всегда про разницу, а не про состав. */
function setDelta(
  before: Map<string, string>,
  after: Map<string, string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...after].filter(([id]) => !before.has(id)).map(([, name]) => name),
    removed: [...before].filter(([id]) => !after.has(id)).map(([, name]) => name),
  };
}

function addonTitles(addons: readonly RoleAddon[]): Map<string, string> {
  return new Map(addons.map((a) => [a, roleAddonLabels[a]]));
}

/**
 * Изменения учётной записи парами «было → стало».
 *
 * `before === null` — учётку только что завели: слева показывать нечего, и все значения уходят
 * событиями-списками («назначена роль Диспетчер», «объекты: СУ-10»). Пустые поля новой учётки при
 * этом молчат: «Телефон: —» в момент заведения — не событие, а отсутствие данных.
 *
 * Телефон сравнивается уже отформатированным: в базе лежат десять цифр, а в журнале должно стоять
 * то, что человек читает в карточке.
 */
export function userAuditChanges(
  before: UserAccountDto | null,
  after: UserAccountDto,
): AuditChangeDto[] {
  const set = changeSet();
  const nothing = new Map<string, string>();

  if (before) {
    set.changed('lastName', before.lastName, after.lastName);
    set.changed('firstName', before.firstName, after.firstName);
    set.changed('middleName', before.middleName || EMPTY, after.middleName || EMPTY);
    set.changed('email', before.email, after.email);
    set.changed(
      'phone',
      before.phone ? formatPhone(before.phone) : EMPTY,
      after.phone ? formatPhone(after.phone) : EMPTY,
    );
    set.changed('role', roleTitle(before.role), roleTitle(after.role));
    set.changed(
      'isActive',
      before.isActive ? userAuditActiveTitles.on : userAuditActiveTitles.off,
      after.isActive ? userAuditActiveTitles.on : userAuditActiveTitles.off,
    );
    set.changed('counterparty', before.counterpartyName ?? EMPTY, after.counterpartyName ?? EMPTY);
    set.changed('person', before.person?.fullName ?? EMPTY, after.person?.fullName ?? EMPTY);
  } else {
    set.listed('role', [roleTitle(after.role)]);
    // Заведённая сразу активной учётка и заготовка «на потом» — разные события, и по одной роли
    // они неразличимы: доступ записывается всегда, даже когда он закрыт.
    set.listed('isActive', [after.isActive ? userAuditActiveTitles.on : userAuditActiveTitles.off]);
    if (after.counterpartyName) set.listed('counterparty', [after.counterpartyName]);
    if (after.person) set.listed('person', [after.person.fullName]);
  }

  const objects = setDelta(
    before === null ? nothing : scopeTitles(before.constructionObjects),
    scopeTitles(after.constructionObjects),
  );
  set.listed('objectsAdded', objects.added);
  set.listed('objectsRemoved', objects.removed);

  const departments = setDelta(
    before === null ? nothing : departmentTitles(before.departments),
    departmentTitles(after.departments),
  );
  set.listed('departmentsAdded', departments.added);
  set.listed('departmentsRemoved', departments.removed);

  const addons = setDelta(
    before === null ? nothing : addonTitles(before.addons),
    addonTitles(after.addons),
  );
  set.listed('addonsGranted', addons.added);
  set.listed('addonsRevoked', addons.removed);

  return set.changes;
}
