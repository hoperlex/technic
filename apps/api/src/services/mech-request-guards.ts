import { and, eq } from 'drizzle-orm';
import {
  type CounterpartyType,
  isDepartmentScopedRole,
  isObjectScopedRole,
  roleLabels,
} from '@technic/contracts';
import {
  constructionObjects,
  counterparties,
  departmentConstructionObjects,
  departments,
  mechRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { assertArchiveVisible, assertPlaceObjectScope, MECH_SCOPE_LABEL } from '../lib/access';
import type { Principal } from '../auth/principal';
import type { MechTx } from './mech-request-dto';

// Общие проверки всех мутаций механизации (план `docs/mechanization-module-plan.md`): протокол Р21,
// назначаемость арендодателя Р6 и пара «отдел — площадка» Р17.
//
// Отдельным файлом, потому что зовутся они из девяти ручек в одном и том же порядке, и порядок этот
// и есть содержание протокола: перепиши его в одной ручке иначе — и барьер там перестанет быть
// барьером, а прогон этого не покажет.

// ── Протокол мутаций (Р21) ──

/**
 * Шаг 2 протокола: строка заявки берётся `SELECT ... FOR UPDATE` **первым** действием транзакции —
 * до чтения файлов, истории и вообще чего бы то ни было связанного.
 *
 * «Первым действием» — не педантизм. Проверка, сделанная по прочитанной раньше строке, барьером не
 * является: между чтением и записью состояние меняет соседний запрос, и каждая такая гонка снимает
 * ровно тот запрет, ради которого барьер заводился — «удалить» прочитало «выдачи нет», параллельно
 * отметили выдачу, и в архиве оказалась действующая аренда.
 *
 * Замок и версия друг друга НЕ заменяют: замок держит состояние от параллельного писателя внутри
 * транзакции, версия отвечает на другой вопрос — «карточку открыли час назад, за это время её
 * поменял кто-то ещё».
 */
export async function lockMechRequest(tx: MechTx, id: string) {
  const [row] = await tx.select().from(mechRequests).where(eq(mechRequests.id, id)).for('update');
  return row;
}

export type LockedMechRequest = NonNullable<Awaited<ReturnType<typeof lockMechRequest>>>;

/**
 * Шаги 3 и 4 протокола разом: существование, видимость архива, область — и **сразу** после них
 * сверка версии, до всех предметных проверок.
 *
 * Порядок здесь и есть смысл функции. Поставь барьеры раньше версии, и обещанный 409 не наступил бы
 * никогда: правка срока, дождавшаяся замка после чужого перевода в работу, увидела бы `confirmed` и
 * получила предметный 422 «срок здесь не правят», не дойдя до сравнения версий. Ответ был бы про
 * правило, а человек столкнулся с гонкой — и повторил бы то же действие, получив тот же отказ.
 *
 * Читается это так: **409 — «данные под тобой изменились, перечитай карточку»; 422 — «правило
 * запрещает это действие»**.
 */
export function assertMechRequestOpenable(
  p: Principal,
  row: LockedMechRequest | undefined,
  version: number,
): LockedMechRequest {
  if (!row) throw err.notFound('Заявка не найдена');
  assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
  assertPlaceObjectScope(p, row.objectId, MECH_SCOPE_LABEL);
  if (row.version !== version) throw err.conflict();
  return row;
}

/**
 * Б3 — удалённая запись: у неё нет ни правки, ни повторного удаления, только восстановление и
 * удаление насовсем.
 *
 * Отдельным барьером, а не строкой в таблице состояний, потому что удаление не заменяет статус:
 * архивная заявка сохраняет свой, и без Б3 «Новая» в архиве осталась бы полностью правимой.
 */
export function assertMechRequestLive(row: LockedMechRequest, action: string): void {
  if (row.deletedAt) {
    throw err.unprocessable(`Заявка в архиве — сначала восстановите её, чтобы ${action}`);
  }
}

// ── Назначаемость арендодателя (Р6) ──

/**
 * Арендодателем может быть контрагент типа «Арендодатель механизации» **или** «Арендодатель (ТС)».
 * Тип у контрагента ровно один, ИНН уникален — значит компания, уже заведённая арендодателем ТС,
 * сдаёт механизацию под своим типом: смена типа сломала бы права её учёток и её технику. Права при
 * этом не размываются — у `mech_lessor` их нет вовсе.
 *
 * Проверка сервисная и стоит **сверх** составного внешнего ключа, а не вместо него: ключ отвечает
 * «такое сочетание существует», сервис — «его можно выбрать сегодня» (не удалён, активен). Приём и
 * порядок отказов те же, что у `assertOperatorAssignable` в вывозе мусора.
 *
 * Возвращает служебные колонки ключа: тип и активность пишет ПРИЛОЖЕНИЕ, значения берутся из строки
 * контрагента, а дальше `ON UPDATE CASCADE` держит копию активности в синхронности сам.
 */
export async function assertMechLessorAssignable(
  tx: MechTx,
  lessorId: string,
): Promise<{ lessorType: CounterpartyType; lessorIsActive: boolean; lessorName: string }> {
  const [cp] = await tx
    .select({
      name: counterparties.name,
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, lessorId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (cp.type !== 'mech_lessor' && cp.type !== 'vehicle_lessor') {
    throw err.badRequest(
      'Арендодателем может быть контрагент типа «Арендодатель механизации» или «Арендодатель (ТС)»',
      { lessorId: 'Нужен контрагент-арендодатель' },
    );
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  return { lessorType: cp.type, lessorIsActive: cp.isActive, lessorName: cp.name };
}

// ── Пара «отдел — площадка» (Р17) ──

/**
 * Площадка обязана быть закреплена за отделом-заявителем, а обе половины пары — активны.
 *
 * **Почему это не сводится к области.** `placeObjectScopeIds` возвращает ОБЪЕДИНЕНИЕ площадок всех
 * отделов учётки, и совпадение с ним доказывает лишь, что площадка своя хоть какому-то отделу.
 * Заявку же заводят на пару: отдел A и площадка отдела B у сотрудника, состоящего в обоих, прошли
 * бы проверку области и создали заявку, за которую платит не тот отдел. Поэтому связь спрашивается
 * отдельно и **для всех**, включая офис, который заводит заявку за отдел: у офиса области нет
 * вовсе, а правило про пару к ней не сводится.
 *
 * **Почему активность спрашивается здесь же.** Ни область, ни связь её не учитывают:
 * `departmentObjectIdsExpr` собирает площадки без оглядки на `is_active`, карточка отдела отдаёт их
 * так же, а список объектов на фронте предлагает только активные — то есть прямым запросом заявку
 * можно завести на неактивную связанную площадку, и портал этого не заметит. Активность площадки
 * проверяется и у заявки без отдела: заявитель-площадка бывает погашен ровно так же.
 *
 * Зовётся ровно в трёх местах — заведение, смена любой половины пары у «Новой», дублирование, — и
 * НЕ при правке соседнего поля: площадку могли снять с отдела уже после заведения, и перепроверка
 * неизменённой пары запретила бы офису поправить комментарий старой заявки. Пару стережём в момент,
 * когда её назначают.
 */
export async function assertMechPairAssignable(
  tx: MechTx,
  objectId: string,
  departmentId: string | null,
): Promise<void> {
  const [object] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!object) throw err.badRequest('Площадка не найдена');
  if (!object.isActive) {
    throw err.badRequest('Площадка неактивна', { objectId: 'Площадка неактивна' });
  }
  if (!departmentId) return;

  const [department] = await tx
    .select({ isActive: departments.isActive })
    .from(departments)
    .where(eq(departments.id, departmentId));
  if (!department) throw err.badRequest('Отдел не найден');
  if (!department.isActive) {
    throw err.badRequest('Отдел неактивен', { departmentId: 'Отдел неактивен' });
  }

  const [link] = await tx
    .select({ objectId: departmentConstructionObjects.constructionObjectId })
    .from(departmentConstructionObjects)
    .where(
      and(
        eq(departmentConstructionObjects.departmentId, departmentId),
        eq(departmentConstructionObjects.constructionObjectId, objectId),
      ),
    );
  if (!link) {
    throw err.forbidden(
      'Площадка не закреплена за этим отделом: техника едет на стройку отдела, а не на чужую',
    );
  }
}

/**
 * Кем разрешено назвать заявителя (Р17). Роль отдела заводит заявку **своим** отделом: пара «чужой
 * отдел + общая площадка» прошла бы и область, и связь — обе отвечают про площадку, а не про то, на
 * кого лягут расходы. Офис (менеджер, диспетчер, администратор) заводит за любого, но правило
 * состава пары для него то же.
 *
 * Объектная роль отдел не называет вовсе: у неё заявитель — её собственная площадка.
 */
export function assertMechRequesterAllowed(p: Principal, departmentId: string | null): void {
  if (isDepartmentScopedRole(p.role)) {
    // Пустой отдел у отдельской роли — не «заявка площадки», а заявка ЗА чужой счёт: заявитель
    // выводится (отдел, если заполнен, иначе объект), и молча опущенная половина пары относит
    // расходы на площадку. Портал такого не предлагает — группы «Объекты» у отдельской роли в
    // подборе заявителя нет вовсе, — но правило держит сервер, а не форма: прямой запрос обошёл бы
    // её ровно так же, как пару «чужой отдел + общая площадка». Тем же отвечает и «Заказ ТС»
    // (`assertRequestScope`): у роли отдела заказчик — её отдел, и заявки без него у неё не бывает.
    if (!departmentId || !p.departmentIds.includes(departmentId)) {
      throw err.forbidden(`${roleLabels[p.role!]} заводит заявку только от своего отдела`);
    }
    return;
  }
  if (!departmentId) return;
  // У объектной роли отдельской оси нет вовсе: назвать заявителем отдел ей нечем, и заявка ушла бы
  // в расходы подразделения, к которому она отношения не имеет.
  if (isObjectScopedRole(p.role)) {
    throw err.forbidden(`${roleLabels[p.role!]} заводит заявку от своей площадки, а не от отдела`);
  }
}
