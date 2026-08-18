import {
  ACCESS_PROFILES,
  accessProfileLabel,
  moduleAccess,
  PERMISSION_MODULES,
  permissionsFor,
  type AccessSubject,
  type Permission,
  type UserAccountDto,
} from '@technic/contracts';
import { accessGroups, accessKey, activeUsers } from './accessOverview';

/**
 * Модель строки среза «Профили»: сопоставление матрицы с живыми учётками.
 *
 * Отдельно от таблицы, потому что таблица здесь — самая простая часть, а сопоставление — самая
 * спорная. Строка берётся из двух источников сразу: из перечня профилей матрицы и из живых групп,
 * которым в матрице соответствия нет по построению (доступ собран наборами, ADR 0106). Что считать
 * одной строкой, чем считать совпадение и почему «профиль не занят» больше не значит «роль
 * пустует» — рассуждения не про вёрстку, и место им там, где считается сама раскладка.
 *
 * Своего представления о правах модель не заводит: права должности приходят вызовом матрицы, права
 * людей — ответом сервера.
 */

/** Чем профиль отличается от голой роли — оси субъекта (ADR 0038, 0086, 0106). */
export type ProfileAxis = 'role' | 'counterparty' | 'addon' | 'grant';

export const axisLabels: Record<ProfileAxis, string> = {
  role: 'роль',
  counterparty: 'роль + тип контрагента',
  addon: 'роль + надстройка',
  // Четвёртая ось строки: доступ собран из роли и назначенных наборов. Профиля матрицы за ней нет —
  // и не будет, пока наборы заводят в проде.
  grant: 'роль + набор',
};

/**
 * Ось выводится из самого субъекта, а не из списка ролей: заведут вторую надстройку или откроют
 * учётки ещё одному типу контрагента — строка ответит правильно без правки витрины.
 */
function axisOf(subject: AccessSubject): ProfileAxis | null {
  if (!subject.role) return null;
  if (subject.counterpartyType) return 'counterparty';
  if ((subject.addons ?? []).length > 0) return 'addon';
  return 'role';
}

/**
 * Производная часть строки. Права передаются, а не выводятся из субъекта: у профиля матрицы их
 * считает `permissionsFor`, у живой группы они пришли с сервера, и второй расчёт по роли вернул бы
 * группе не её права.
 */
function describeAccess(subject: AccessSubject, permissions: readonly Permission[]) {
  return {
    permissions,
    openModules: PERMISSION_MODULES.filter((module) => moduleAccess(subject, module) !== 'none')
      .length,
  };
}

export interface ProfileRow {
  key: string;
  /**
   * Субъект строки. У профиля матрицы — он сам; у живой группы — её матричная тройка плюс
   * фактические права в `grantPermissions`: `moduleAccess` и `describeAccessScope` спрашивают права
   * через `can`, и на голой тройке они рассказали бы про группу не то, что она может.
   */
  subject: AccessSubject;
  label: string;
  axis: ProfileAxis | null;
  permissions: readonly Permission[];
  openModules: number;
  users: UserAccountDto[];
  /** Строки с ровно тем же набором прав — подписями. */
  twins: string[];
  /** Строки в матрице нет: доступ собран наборами (норма) либо у учётки нет роли (поломка). */
  offMatrix: boolean;
  /** Наборы, которые есть у учёток группы, — объяснение, откуда взялась строка вне матрицы. */
  grantCodes: string[];
  /**
   * Сколько живых учёток носит эту роль — с любым набором прав. Стоит рядом с «не занят» и держит
   * его от неверного чтения: незанятый профиль больше не значит «роль пустует», потому что учётки
   * этой роли могли уйти в собранные строки выше.
   */
  roleUsers: number;
}

export interface ProfileTable {
  rows: ProfileRow[];
  /** Профилей матрицы без единой живой учётки. */
  unused: number;
  /** Строк, собранных наборами: профиля матрицы у них нет по построению. */
  assembled: number;
  /** Групп строк, совпадающих по набору прав; в группе всегда больше одного. */
  twinGroups: number;
}

export function buildRows(users: readonly UserAccountDto[]): ProfileTable {
  /*
   * Занятость — по живым учёткам и по их фактическим правам: срез отвечает на «кто сейчас может
   * ровно это». Выключенная учётка профиль не занимает; удалённых пакетные читатели сервера не
   * отсекают, поэтому отбор делает витрина.
   *
   * Ключ у обеих сторон сопоставления один (`accessKey`) — роль, тип контрагента и отпечаток прав.
   * Прежняя тройка «роль + контрагент + надстройки» здесь стала бы ложью: два штаба с одним ключом
   * получают разные права, если одному выдали набор.
   */
  const live = activeUsers(users);
  const usage = new Map(accessGroups(live).map((group) => [group.key, group]));
  // Учётки по ролям — знаменатель для «не занят»: роль, ушедшая в собранные строки, не пустует.
  const roleCounts = new Map<string, number>();
  for (const user of live) {
    const role = user.role ?? 'none';
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }

  const profiles = ACCESS_PROFILES.map((subject) => {
    const permissions = permissionsFor(subject);
    return {
      subject,
      // Ключ профиля считается по правам, которые даёт матрица: попадёт в него живая группа или
      // нет — вопрос совпадения прав, а не совпадения надстроек.
      key: accessKey({ ...subject, permissions }),
      label: accessProfileLabel(subject),
      axis: axisOf(subject),
      ...describeAccess(subject, permissions),
    };
  });

  /**
   * Живые группы, которым в матрице соответствия нет. Их два вида, и путать их нельзя: доступ,
   * собранный наборами, — обычное дело (профиля матрицы у него нет по построению), а активная
   * учётка без роли — поломка, о которой витрина обязана сказать. Смысл среза в том, чтобы
   * показывать и то и другое, а не подтверждать, что расхождений не бывает.
   */
  const known = new Set(profiles.map((profile) => profile.key));
  const strays = [...usage.values()]
    .filter((group) => !known.has(group.key))
    .map((group) => {
      // Права группы — в субъекте: только с ними `moduleAccess` покажет модуль, открытый набором, а
      // `describeAccessScope` не соврёт про доступ к удалённым записям.
      const subject: AccessSubject = { ...group.subject, grantPermissions: group.permissions };
      const grantCodes = [...new Set(group.users.flatMap((user) => user.grantCodes))].sort();
      return {
        key: group.key,
        subject,
        label: group.label,
        users: group.users,
        // Ось строки: наборы объясняют её появление здесь, и называть её «ролью» значило бы
        // умолчать о единственной причине, по которой она не сошлась с матрицей.
        axis: grantCodes.length > 0 ? ('grant' as const) : axisOf(subject),
        offMatrix: true,
        grantCodes,
        ...describeAccess(subject, group.permissions),
      };
    });

  /*
   * Совпадения ищутся группировкой по отпечатку прав, а не сравнением каждой строки с каждой:
   * перебор пар в рендере пересчитывался бы на каждую перерисовку и рос бы квадратом от их числа.
   *
   * В группировку входят и живые строки: «у штаба с набором ровно права диспетчера» — тот же вывод
   * пересмотра, что «Менеджер и Диспетчер совпадают», и добывается он только так. Отпечаток берётся
   * от прав без роли: роль в ключе строки стоит ради области, а совпадение — про сами права.
   */
  const labelsBySignature = new Map<string, string[]>();
  for (const row of [...profiles, ...strays]) {
    const signature = row.permissions.join('|');
    labelsBySignature.set(signature, [...(labelsBySignature.get(signature) ?? []), row.label]);
  }
  const twinsOf = (row: { label: string; permissions: readonly Permission[] }) =>
    // Подпись у каждой строки своя (роль, роль — контрагент, роль + надстройка), поэтому себя из
    // группы довольно отсечь по ней.
    (labelsBySignature.get(row.permissions.join('|')) ?? []).filter((label) => label !== row.label);

  const matrixRows: ProfileRow[] = profiles.map((profile) => ({
    ...profile,
    users: usage.get(profile.key)?.users ?? [],
    twins: twinsOf(profile),
    offMatrix: false,
    // Наборы профиля матрицы — не его свойство: он описывает должность, а наборы выдают людям.
    grantCodes: [],
    roleUsers: roleCounts.get(profile.subject.role ?? 'none') ?? 0,
  }));
  const strayRows: ProfileRow[] = strays.map((stray) => ({
    ...stray,
    twins: twinsOf(stray),
    // У собранной строки знаменатель не нужен: её учётки — вот они, в самой строке.
    roleUsers: stray.users.length,
  }));

  return {
    // Строки вне матрицы — первыми: они про живых людей, а профили матрицы никуда не денутся.
    rows: [...strayRows, ...matrixRows],
    unused: matrixRows.filter((row) => row.users.length === 0).length,
    assembled: strayRows.filter((row) => row.grantCodes.length > 0).length,
    twinGroups: [...labelsBySignature.values()].filter((group) => group.length > 1).length,
  };
}
