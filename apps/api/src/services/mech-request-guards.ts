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
  mechModels,
  mechRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { assertArchiveVisible, assertMechScope } from '../lib/access';
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
  /**
   * The words of the version 409 when the door knows better than the generic «reread»: the lessor
   * receipt's visa says the receipt was replaced while the window was open (lessor receipt plan,
   * P5). Only the words change — the order of the checks and the status code stay the protocol's.
   */
  staleMessage?: string,
): LockedMechRequest {
  if (!row) throw err.notFound('Заявка не найдена');
  assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
  // Both axes (lessor receipt plan, P11): the site, and the lessor's counterparty for an executor.
  assertMechScope(p, row);
  if (row.version !== version) throw err.conflict(staleMessage);
  return row;
}

/**
 * CAS on the request after a write to its child rows (the extension, the lessor receipt): the
 * version was matched under the lock, and only it is bumped here, with the request columns the door
 * changes alongside. Every such door bumps the version even when only `updated_at` changes in the
 * request: the card shows the child, and a CAS on a child table without its own version does not
 * exist — the request's version is the one etag of the whole card.
 */
export async function bumpRequest(
  tx: MechTx,
  p: Principal,
  row: LockedMechRequest,
  version: number,
  set: { plannedTo?: string; lessorReceiptRequired?: boolean } = {},
): Promise<void> {
  const [updated] = await tx
    .update(mechRequests)
    .set({ ...set, updatedBy: p.id, version: row.version + 1, updatedAt: new Date() })
    .where(and(eq(mechRequests.id, row.id), eq(mechRequests.version, version)))
    .returning({ id: mechRequests.id });
  if (!updated) throw err.conflict();
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

// ── Who may be the lessor (R6) ──

/**
 * The lessor of a rental is a counterparty of type «Арендодатель механизации», and only that type is
 * assigned (ADR 0152 decision 6). The type also decides access: since ADR 0248 such a counterparty
 * has accounts, and the lessor axis gives them exactly the rentals whose deal names it.
 *
 * The check is a service one and stands **on top of** the composite foreign key, not instead of it:
 * the key answers "such a combination exists", the service "it can be chosen today" (not deleted,
 * active). The approach and the order of refusals are those of `assertOperatorAssignable` in waste
 * removal.
 *
 * Returns the key's service columns: the APPLICATION writes the type and the activity, the values
 * come from the counterparty row, and from then on `ON UPDATE CASCADE` keeps the activity copy in
 * sync by itself.
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
  // Only its own type. «Арендодатель (ТС)» was accepted here too, on the reasoning that one company
  // rents out both vehicles and machinery while a counterparty has one type. The customer rejected it
  // on seeing vehicle lessors in the list: the choice turned into a search among strangers. The
  // server must ask exactly what the form offers, or the door accepts what the list does not show.
  //
  // The base constraint (`mech_requests_lessor_type_check`) is left tolerant of both types on
  // purpose: going back is an edit here and in the portal's picker, without a migration.
  if (cp.type !== 'mech_lessor') {
    throw err.badRequest('Арендодателем может быть контрагент типа «Арендодатель механизации»', {
      lessorId: 'Нужен арендодатель механизации',
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  return { lessorType: cp.type, lessorIsActive: cp.isActive, lessorName: cp.name };
}

// ── Назначаемость модели (Р5, ADR 0156) ──

/**
 * Предмет аренды выбирается **строго из справочника** (ADR 0156, решение 2), и «выбрать» значит
 * ровно две вещи: строка существует и она не погашена. Проверка та же по устройству, что
 * `assertMechLessorAssignable` рядом, и по той же причине: внешний ключ отвечает «такая строка
 * есть», а «её можно выбрать сегодня» — вопрос к сервису. Погашенная модель ключом прошла бы, и
 * заявка завелась бы на то, чего портал в подборе не предлагает.
 *
 * Возвращает НАИМЕНОВАНИЕ, хотя записывать его после уборки Э3 некуда: снимка написания у заявки
 * больше нет, предмет аренды хранится одной ссылкой. Имя остаётся ради отказов — «Модель „…“
 * погашена» без имени не сказать, — и берётся здесь же, под тем же чтением, что и проверка:
 * спрошенное вторым запросом относилось бы к состоянию после чужой правки.
 */
export async function assertMechModelAssignable(tx: MechTx, modelId: string): Promise<string> {
  const [model] = await tx
    .select({ name: mechModels.name, isActive: mechModels.isActive })
    .from(mechModels)
    .where(eq(mechModels.id, modelId));
  if (!model) {
    throw err.badRequest('Модель не найдена в справочнике', { mechModelId: 'Модель не найдена' });
  }
  if (!model.isActive) {
    // Погашенная модель — не ошибка ввода, а снятая с аренды позиция: отказ обязан сказать, что
    // делать дальше, иначе человек ищет её в том же списке, где её уже нет.
    throw err.badRequest(`Модель «${model.name}» погашена — выберите другую`, {
      mechModelId: 'Модель погашена',
    });
  }
  return model.name;
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
    // её ровно так же, как пару «чужой отдел + общая площадка».
    //
    // «Заказ ТС» опорой этому правилу больше не служит — с ADR 0201 он отвечает иначе: там у роли
    // отдела заказчиков два рода, свой отдел и своя площадка, и заявка без отдела у неё бывает.
    // Разница в устройстве документа: там заказчик один и он же платит, здесь место эксплуатации
    // спрашивается отдельно от заявителя, и пустая половина пары означает не «заявку площадки», а
    // молча перенесённые расходы.
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
