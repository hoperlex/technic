import {
  InboxOutlined,
  MessageOutlined,
  ProfileOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  actsAsServiceExecutor,
  actsForCounterparty,
  isServiceExecutor,
  isServiceRequestEditable,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ActionSheetItem } from '@shared/ui';
import type { ServiceMenuContext } from './serviceRequestModals';

/**
 * Действия **вокруг** заявки: те, что заявку не двигают.
 *
 * Состав номенклатуры, отметка выдачи, срочность, обсуждение и перемещение техники — это не ход по
 * циклу, а обстоятельства, при которых он идёт. Отдельным модулем от хода
 * (`serviceRequestMenu`) именно поэтому: ход меняется вместе с циклом заявки — и переделка цикла
 * трогает его целиком, — а обстоятельства живут своей жизнью и переживают такие переделки без
 * единой правки. Разрез по этой границе, а не по номеру строки.
 *
 * Признаки заявки (`row`), назначения и области действий приходят готовыми: их считает вызывающий,
 * и второй разбор тех же полей здесь разошёлся бы с ходом молча.
 */

export function serviceRequestExtraItems(
  request: ServiceRequestDto,
  ctx: ServiceMenuContext,
  assignment: ServiceExecutorAssignment,
  row: ServiceActionRequest,
  /**
   * Область действий (план `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р11).
   * Первый сомножитель у всего, что МЕНЯЕТ ЗАЯВКУ: состав расходников, отметка выдачи и срочность
   * — такие же изменяющие ручки, как переходы, и сервер закрывает их тем же общим входом.
   *
   * ДВА ПУНКТА ЕЮ НЕ ЗАКРЫВАЮТСЯ, и оба намеренно. «Обсуждение» — не мутация заявки вовсе: текст
   * реплик видят все, кому видна заявка, а писать или молчать решает уже окно своим предикатом
   * (`canWriteChat`); ответ В11 заказчика от 09.09.2026 прямо оставляет снятому исполнителю
   * «смотреть и писать в чат», и спрятанный вход отнял бы у него и то и другое. «Записать
   * перемещение техники» правит СПРАВОЧНИК, а не заявку: его дверь — право `officeEquipment.move`
   * и область парка, заявка же тут только повод; спрячь мы пункт вместе с прочими, сисадмин,
   * приехавший по заявке и увидевший аппарат своими глазами, снова остался бы без единственного
   * входа — ровно то, ради чего пункт сюда и переносили.
   */
  mayAct: boolean,
): ActionSheetItem[] {
  const items: ActionSheetItem[] = [];
  /*
   * «Смотрит подрядчик» — вопрос о СУБЪЕКТЕ, а не о его назначении на эту заявку, и спрашивается он
   * поэтому типом контрагента. Три пункта ниже прячутся именно от стороны подрядчика: срочность и
   * перемещение техники — дело заказывающей стороны, а повтор служебного письма зовёт разобрать
   * заявку тех, кому её и адресуют.
   *
   * Прежде здесь стоял признак назначения (`assignment.actsForAssignedCounterparty`), и совпадал он
   * с типом контрагента лишь потому, что портал считал сторону подрядчика приближённо. С точным
   * ответом (Р8) признак означает уже другое — «эта заявка отдана моей компании», — и на чужой
   * заявке подрядчика он ложен: пункты, спрятанные от него, вернулись бы ровно там, где им быть
   * особенно незачем.
   */
  const executor = actsForCounterparty(ctx.user, 'service');
  const held = request.status === 'on_hold';
  const closed = request.status === 'accepted' || request.status === 'cancelled';

  /*
   * The consumables list (R15) is filled in by the executor — the block left the create form
   * entirely: the requester does not know the item codes, his job is to say in words what is
   * missing. The item is the same «button and window» pair by which a repair's estimate is edited:
   * in both kinds of request the executor answers one question — «what goes into it», — and two
   * different windows for one question would drift apart at the first edit.
   *
   * The permission has one boundary with the server: until an issue is marked on the request. After
   * that the list is frozen — it became the basis of a stock record, and the server answers 409.
   *
   * The executor side is asked of the CONTRACT `actsAsServiceExecutor`, the one the R11 predicates
   * and the corridor read it by, and its permissions come from `ctx.can` (ADR 0223). This action has
   * no predicate of its own: its permission is the pair `estimate` + `execute`, and the assignment
   * to THIS request is checked by the handler's body (`assertExecutorSide`). A copy of the rule here
   * would drift from the server silently — as a button leading to a 403.
   *
   * THE LABEL says «расходники», not «номенклатура» (plan
   * `docs/office-equipment-card-and-list-cleanup-plan.md`, R13): the item names the request's
   * subject with the same words as the card tab and the title of the window it opens — had they
   * differed, a person would look in the card for a tab named after the item. Only the name of THIS
   * REQUEST'S LIST changes: the domain term «номенклатура» (the accounting system's code, the item
   * directory, the grant) stays — replaced everywhere, it would rename what is printed on stock
   * papers too.
   */
  if (
    mayAct &&
    request.kind === 'consumable' &&
    !request.consumables.some((line) => line.issuedQuantity !== null) &&
    actsAsServiceExecutor(ctx.user, assignment, ctx.can)
  ) {
    items.push({
      key: 'consumables',
      label: request.consumables.length === 0 ? 'Заполнить расходники' : 'Изменить расходники',
      icon: <ProfileOutlined />,
      // Главный шаг взятой в работу заявки на расходники: пока состава нет, выдавать нечего.
      primary: request.status === 'in_work' && request.consumables.length === 0,
      onClick: () => ctx.modals.consumables(request),
    });
  }

  /*
   * The consumables issue mark (R6) moves the stock, not a status change — so the item stands next
   * to the moves, not among them, and lives in two statuses at once. In «В работе» it marks the
   * issue before closing, in «Решена» it corrects what was already written off.
   *
   * After «Закрыта» there is no item: the request's rows freeze, and anything further is a manual
   * correction of the balance with a reason and its own permission (R8). The server answers such an
   * edit with 422, and a button leading to it would be a promise it does not keep.
   *
   * Who may is the same predicate as on the server (`assertConsumableIssuer`): the assigned
   * executor (named with `execute`, or by his company) **or** the one who leads requests and fixes
   * mistakes for any side. Both permissions are asked of `ctx.can`.
   */
  if (
    mayAct &&
    request.kind === 'consumable' &&
    (request.status === 'in_work' || request.status === 'done') &&
    (isServiceExecutor(ctx.user, assignment, ctx.can) || ctx.can('serviceRequests.status'))
  ) {
    const marked = request.consumables.some((line) => line.issuedQuantity !== null);
    items.push({
      key: 'consumables-issued',
      label: marked ? 'Изменить выданное' : 'Отметить выдачу',
      icon: <InboxOutlined />,
      onClick: () => ctx.modals.issue(request),
    });
  }

  /*
   * Urgency (R56) is not a transition, so the corridor does not have it: it is set and removed up
   * to closing. Who may is decided by the permission, not the role: the office equipment operator
   * is the same «Штаб» or «Отдел», and a «edits only Новая» rule would take the flag from him along
   * with the customer.
   *
   * EXACTLY `serviceRequests.urgency` IS ASKED, and that is a fix, not a style. It used to be
   * `serviceRequests.update` — the right to EDIT the request, which every requester has on his own
   * «Новая», — while `PATCH /:id/urgency` is closed by a separate urgency permission that the `site`
   * and `department` roles lack. The item was shown to the customer and led to a 403. The check must
   * be the permission the handler is closed by.
   *
   * Editing the request is asked by a predicate over the ROW, not the status (R14): a «Новая» after
   * assignment is no longer editable, and the urgency flag is closed to the customer there too.
   *
   * A held request's urgency is not changed (R119): the server answers 422 — the request stands
   * still, and the urgent queue does not show it. The flag is not cleared, it waits for resumption.
   */
  const mayUrgency =
    mayAct &&
    !executor &&
    !closed &&
    !held &&
    ctx.can('serviceRequests.urgency') &&
    (ctx.can('serviceRequests.assign') || isServiceRequestEditable(row));
  if (mayUrgency) {
    items.push({
      key: 'urgency',
      label: request.isUrgent ? 'Снять срочность' : 'Отметить срочной',
      icon: <ThunderboltOutlined />,
      onClick: () => ctx.modals.urgency(request),
    });
  }

  /*
   * Обсуждение (ADR 0141) — вместо «Примечания исполнителя», которое оно заменяет, а не дополняет:
   * два места для одного текста означали бы вопрос «а где написать» у каждого, кто открыл заявку, и
   * два расходящихся ответа на «что сказал сервис».
   *
   * Пункт стоит у ВСЕХ и во всех статусах, включая закрытые: текст реплик видят все, кому видна
   * заявка (решение 2 ADR), — адресат управляет подсветкой, а не видимостью. Писать может не
   * всякий, но это вопрос кнопки отправки внутри окна, а не входа в него: спрятанную переписку
   * читателю нечем и заменить — колонки с текстом реплик в списке нет.
   */
  items.push({
    key: 'chat',
    label: 'Обсуждение',
    icon: <MessageOutlined />,
    onClick: () => ctx.modals.chat(request),
  });

  /*
   * Moving the equipment because of a repair (R61): «taken to the service» and «came back». The
   * request's move does not change the unit's state by itself — repairs happen on site too, — but
   * the move is learned of here, and it must be recorded where it was learned of. The contractor's
   * side has no such action at all (R7).
   *
   * THE PERMISSION IS ITS OWN, NOT THE DIRECTORY ONE (plan
   * `docs/office-equipment-move-from-request-plan.md`, R1). `officeEquipment.write` opens creating
   * cards, types, models and the archive at once, and confirming a location went along with them: a
   * system administrator who came by the request and sees the device with his own eyes could not
   * move it at all. Now exactly the permission that closes `POST /office-equipment/:id/move` is
   * asked, of `ctx.can` — otherwise the item would either lead to a 403 or disappear for someone
   * allowed to move.
   *
   * THE STATUS WAS REMOVED FROM THE CONDITION (R6, finding N3). «The device came back from the
   * service» is recorded exactly on an accepted request, and a cancelled one keeps the item by the
   * same measure: «repair is not worthwhile» is a usual reason to take a device to storage. The
   * only workaround was going to the directory, exactly where the action was moved away from
   * (ADR 0162).
   *
   * An archived request is not concerned: its action set is empty as a whole
   * (`serviceRequestMenuItems` returns an empty list by `deletedAt`), and a second such condition
   * here would argue with it. A request without a device has no item at all (R8): there is nothing
   * to move. Nor does a request whose subject is still under review (R11): `equipment` is empty
   * until the candidate is confirmed, and after confirmation the item appears with the device.
   * Hidden here, at the item itself, and not by a check inside the window: an action in the menu
   * that cannot happen is a promise with nothing behind it.
   *
   * THE REQUEST'S ACTION SCOPE (`mayAct`, R11) DOES NOT APPLY TO THIS ITEM — the only one, and that
   * is an exception, not an omission. The mutation here is not of the request: the DIRECTORY CARD is
   * written, through its own door `POST /office-equipment/:id/move`, guarded by
   * `officeEquipment.move` and the FLEET scope (`assertOfficeEquipmentScope`); of the request it
   * asks only whether the viewer sees it and whether it is the same unit
   * (`serviceRequestVisibilityWhere`) — the READING scope, which a removed executor keeps (answer
   * V6). Multiplied by the action scope, the portal would hide the button where the server answers
   * 200. Checked by reading the handler: if the server door is ever closed by the request's action
   * scope, the factor must appear here as well.
   */
  if (request.equipment && !executor && ctx.can('officeEquipment.move')) {
    items.push({
      key: 'move-equipment',
      label: 'Записать перемещение техники',
      icon: <SwapOutlined />,
      onClick: () => ctx.modals.moveEquipment(request),
    });
  }

  return items;
}
