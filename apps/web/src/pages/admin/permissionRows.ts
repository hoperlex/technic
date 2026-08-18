import {
  ACCESS_PROFILES,
  accessProfileLabel,
  PERMISSION_CATALOG,
  PERMISSIONS,
  permissionsFor,
  profilesWith,
  type Permission,
  type PermissionAction,
  type PermissionModule,
  type UserAccountDto,
} from '@technic/contracts';
import {
  activeUsers,
  grantOnlyPermissions,
  hasAllPermissions,
  permissionHolders,
} from './accessOverview';

/**
 * Модель строки среза «Права»: право словаря вместе с ответом, кто им сегодня владеет.
 *
 * Отдельно от таблицы, потому что это не вёрстка, а вывод, и цена ошибки в нём другая. Пометка
 * «заперто у полного доступа» держится сразу на двух половинах модели — матрице и фактических
 * правах живых учёток, — и держателей приходится раскладывать одним проходом по списку, а не
 * искать в ячейке: иначе тот же перебор повторяется на каждую перерисовку полсотни раз. Оба эти
 * рассуждения объясняются здесь один раз и целиком; в описании колонок они разошлись бы по
 * комментариям к `render`, где их читают последними.
 *
 * Своего представления о правах модель не заводит: перечень и профили приходят вызовами
 * контрактов, права людей — ответом сервера.
 */

/**
 * Профили матрицы, которым открыто всё, — сегодня это один администратор.
 *
 * Выводятся из матрицы, а не задаются именем роли. Пометка отвечает на «право заперто у того, кому
 * и так можно всё», и держаться она должна на самой модели: сравнение с `'admin'` строкой было бы
 * второй копией знания о ролях на витрине — ровно тем, чего вкладка избегает. Заведут вторую
 * всесильную роль или сузят администратора — пометка ответит правильно без правки этого файла.
 *
 * Одной матрицы для пометки, однако, **уже недостаточно**: живая учётка получает права набором, и
 * профиль «Штаб» с выданным «Аудитором» в этот список не попадёт никогда. Поэтому матрица здесь
 * отвечает только за подпись и за первую половину условия, а вторую — «нет ли держателя за пределами
 * полного доступа» — считает `buildRows` по фактическим правам живых учёток.
 */
const FULL_ACCESS_LABELS = ACCESS_PROFILES.filter(
  (subject) => permissionsFor(subject).length === PERMISSIONS.length,
).map(accessProfileLabel);
export const FULL_ACCESS = new Set(FULL_ACCESS_LABELS);

/** Пометки строки: то, ради чего таблицу и читают. */
export type Mark = 'locked' | 'granted' | 'unused';

export const markLabels: Record<Mark, string> = {
  // Подпись собирается из самих профилей полного доступа: имя администратора в ней — вывод из
  // матрицы, а не слово, набранное в вёрстке.
  locked: `Только ${FULL_ACCESS_LABELS.map((label) => `«${label}»`).join(' и ')}`,
  // Право, которое кому-то дала не должность, а набор. Пометка не предупреждение, а ответ на вопрос
  // пересмотра «что уже раздают полномочиями»: с §10.1 плана этот срез — единственное место, где
  // такую выдачу видно, потому что перебирать субъектов статически больше нельзя.
  granted: 'Выдано набором',
  unused: 'Ни у кого из живых',
};

export const markColors: Record<Mark, string> = {
  locked: 'orange',
  granted: 'blue',
  unused: 'red',
};
/**
 * Держатель права: учётка и ответ на «должность ли это». Признак считается один раз на всю таблицу
 * (`grantOnlyPermissions` перебирает права учётки), а не в ячейке на каждую перерисовку.
 */
export interface PermissionHolder {
  user: UserAccountDto;
  /** Право у него есть, а должность его не даёт: единственный доказуемо наборный случай. */
  byGrant: boolean;
}

export interface PermissionRow {
  permission: Permission;
  label: string;
  module: PermissionModule;
  action: PermissionAction;
  /** Субъекты матрицы с этим правом — подписями. */
  profiles: string[];
  /** Живые учётки с этим правом — по списку прав, который посчитал сервер. */
  holders: PermissionHolder[];
  locked: boolean;
  /** Хотя бы одному держателю право дала не должность, а набор. */
  byGrant: boolean;
}

export interface PermissionTable {
  rows: PermissionRow[];
  locked: number;
  granted: number;
  unused: number;
}

/**
 * Разбор всего словаря разом: держатели раскладываются одним проходом по учёткам
 * (`permissionHolders`), и делать это в ячейке значило бы пересобирать всю раскладку на каждую
 * перерисовку.
 */
export function buildRows(users: readonly UserAccountDto[]): PermissionTable {
  // Держатели — только живые учётки: срез отвечает на «кто сейчас владеет правом», выключенная
  // учётка права не занимает, а удалённых пакетные читатели сервера не отсекают вовсе.
  const live = activeUsers(users);
  const holders = permissionHolders(live);
  /*
   * Учётки, которым открыто всё, — по их правам, а не по имени роли. Ради этого множества пометка и
   * переписана: «второй всесильный субъект», собранный наборами, в `ACCESS_PROFILES` не появится
   * никогда, и матрица про него промолчала бы — то есть инвариант защищённых прав (§8, инвариант 5)
   * остался бы без единственного экрана, который его проверяет.
   */
  const omnipotent = new Set(live.filter(hasAllPermissions).map((user) => user.id));
  // Доказуемо наборные права каждой учётки — один раз на список, а не на каждую строку словаря:
  // иначе тот же перебор повторялся бы пятьдесят семь раз.
  const byGrant = new Map(live.map((user) => [user.id, new Set(grantOnlyPermissions(user))]));

  const rows = PERMISSIONS.map((permission) => {
    const profiles = profilesWith(permission).map(accessProfileLabel);
    const held = (holders.get(permission) ?? []).map((user) => ({
      user,
      byGrant: byGrant.get(user.id)?.has(permission) ?? false,
    }));
    return {
      permission,
      ...PERMISSION_CATALOG[permission],
      profiles,
      holders: held,
      byGrant: held.some((holder) => holder.byGrant),
      /*
       * «Заперто у полного доступа» — утверждение о двух половинах модели сразу, и обе обязаны его
       * подтвердить: право положено только всесильным профилям **и** ни одна живая учётка за
       * пределами полного доступа им не владеет. Проверь одну матрицу — и пометка промолчит о
       * держателе от набора, ровно там, ради чего заведена; проверь одних держателей — и она
       * пропадёт на праве, которого пока ни у кого нет, хотя матрица уже заперла его в
       * администраторе.
       *
       * Пустой список профилей пометкой не считается: право без единого профиля — это не «заперто у
       * администратора», а строка, до которой не дотянулась ни одна роль.
       */
      locked:
        profiles.length > 0 &&
        profiles.every((label) => FULL_ACCESS.has(label)) &&
        held.every((holder) => omnipotent.has(holder.user.id)),
    };
  });

  return {
    rows,
    locked: rows.filter((row) => row.locked).length,
    granted: rows.filter((row) => row.byGrant).length,
    unused: rows.filter((row) => row.holders.length === 0).length,
  };
}

/** Пометки строки. Пока список учёток не приехал, «ни у кого» означало бы загрузку, а не вывод. */
export function marksOf(row: PermissionRow, pending: boolean): Mark[] {
  const marks: Mark[] = [];
  if (row.locked) marks.push('locked');
  if (row.byGrant) marks.push('granted');
  if (!pending && row.holders.length === 0) marks.push('unused');
  return marks;
}
