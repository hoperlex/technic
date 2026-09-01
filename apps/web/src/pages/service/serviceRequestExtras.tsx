import {
  InboxOutlined,
  MailOutlined,
  MessageOutlined,
  ProfileOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  actsAsServiceExecutor,
  can as hasPermission,
  isServiceExecutor,
  isServiceRequestEditable,
  serviceMailRepeatable,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ActionSheetItem } from '@shared/ui';
import type { ServiceMenuContext } from './serviceRequestMenu';

/**
 * Действия **вокруг** заявки: те, что заявку не двигают.
 *
 * Состав номенклатуры, отметка выдачи, срочность, обсуждение, перемещение техники и повтор письма —
 * это не ход по циклу, а обстоятельства, при которых он идёт. Отдельным модулем от хода
 * (`serviceRequestMenu`) именно поэтому: ход меняется вместе с циклом заявки — и переделка цикла
 * трогает его целиком, — а обстоятельства живут своей жизнью и переживают такие переделки без
 * единой правки. Разрез по этой границе, а не по номеру строки.
 *
 * Признаки заявки (`row`) и назначения приходят готовыми: их считает вызывающий, и второй разбор
 * тех же полей здесь разошёлся бы с ходом молча.
 */

export function serviceRequestExtraItems(
  request: ServiceRequestDto,
  ctx: ServiceMenuContext,
  assignment: ServiceExecutorAssignment,
  row: ServiceActionRequest,
): ActionSheetItem[] {
  const items: ActionSheetItem[] = [];
  const executor = assignment.actsForAssignedCounterparty;
  const held = request.status === 'on_hold';
  const closed = request.status === 'accepted' || request.status === 'cancelled';

  /*
   * Состав номенклатуры (Р15) заполняет исполнитель — из формы заведения блок ушёл целиком:
   * заявитель номенклатуры не знает, его дело сказать словами, чего не хватает. Пункт — та же пара
   * «кнопка и окно», какой у ремонта правят объём работ: у обоих видов заявки исполнитель отвечает
   * на один вопрос — «что по ней пойдёт», — и два разных окна для одного вопроса разошлись бы на
   * первой же правке.
   *
   * Граница у права одна и та же с сервером: пока по заявке не отмечена выдача. Дальше состав
   * замер — он стал основанием записи на складе, и сервер отвечает 409.
   *
   * Сторона исполнителя спрашивается КОНТРАКТНЫМ `actsAsServiceExecutor` — тем же, каким её читают
   * предикаты Р11 и коридор. Своего предиката у этого действия нет: право названо парой
   * `estimate` + `execute`, а назначение на ЭТУ заявку проверяет тело ручки (`assertExecutorSide`).
   * Копия правила здесь разошлась бы с сервером молча — кнопкой, ведущей в 403.
   */
  if (
    request.kind === 'consumable' &&
    !request.consumables.some((line) => line.issuedQuantity !== null) &&
    actsAsServiceExecutor(ctx.user, assignment)
  ) {
    items.push({
      key: 'consumables',
      label: request.consumables.length === 0 ? 'Заполнить номенклатуру' : 'Изменить номенклатуру',
      icon: <ProfileOutlined />,
      // Главный шаг взятой в работу заявки на расходники: пока состава нет, выдавать нечего.
      primary: request.status === 'in_work' && request.consumables.length === 0,
      onClick: () => ctx.modals.consumables(request),
    });
  }

  /*
   * Отметка о выдаче расходников (Р6): склад двигает она, а не смена статуса, — поэтому пункт стоит
   * рядом с ходами, а не внутри них, и живёт в двух статусах сразу. В «В работе» им отмечают выдачу
   * до закрытия, в «Решена» — правят то, что уже списано.
   *
   * После «Закрыта» пункта нет: строки заявки замирают, и всё дальнейшее — ручная правка остатка с
   * причиной и своим правом (Р8). Сервер отвечает на такую правку 422, и кнопка, ведущая в него,
   * была бы обещанием, которого он не даёт.
   *
   * Кто вправе — тот же предикат, что и на сервере (`assertConsumableIssuer`): назначенный
   * исполнитель (поимённо с `execute` либо своей компанией) **либо** тот, кто ведёт заявки и
   * разбирает ошибки за любую сторону.
   */
  if (
    request.kind === 'consumable' &&
    (request.status === 'in_work' || request.status === 'done') &&
    (isServiceExecutor(ctx.user, assignment) || hasPermission(ctx.user, 'serviceRequests.status'))
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
   * Срочность (Р56) — не переход, поэтому её нет в коридоре: её ставят и снимают до самого
   * закрытия. Кто вправе, решает право, а не роль: оператор оргтехники — тот же «Штаб» или «Отдел»,
   * и правило «правит только Новую» отобрало бы у него признак вместе с заказчиком.
   *
   * Правку заявки спрашивает предикат по СТРОКЕ, а не по статусу (Р14): «Новая» после назначения
   * правке уже не подлежит, и признак срочности заказчику там тоже закрыт.
   *
   * Отложенной срочность не меняют (Р119): сервер отвечает 422 — заявка стоит, и очередь срочных её
   * не показывает. Признак при этом не гасится, он ждёт возобновления.
   */
  const mayUrgency =
    !executor &&
    !closed &&
    !held &&
    hasPermission(ctx.user, 'serviceRequests.update') &&
    (hasPermission(ctx.user, 'serviceRequests.assign') || isServiceRequestEditable(row));
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
   * Переезд техники, вызванный ремонтом (Р61): «увезли в сервис» и «вернулась». Ход заявки
   * состояние единицы сам не меняет — чинят и на месте, — но узнают о переезде именно здесь, и
   * записать его надо там же, где узнали. Действие видно только тому, кто ведёт справочник:
   * сервисной компании он закрыт целиком (Р7).
   *
   * У заявки без аппарата пункта нет вовсе (Р8): переезжать нечему — карточки единицы, которой
   * записывают перемещение, не существует. Спрятано здесь, у самого пункта, а не проверкой внутри
   * окна: несбывающееся действие в меню — это обещание, за которым пусто.
   */
  if (
    request.equipment &&
    !executor &&
    !closed &&
    hasPermission(ctx.user, 'officeEquipment.write')
  ) {
    items.push({
      key: 'move-equipment',
      label: 'Записать перемещение техники',
      icon: <SwapOutlined />,
      onClick: () => ctx.modals.moveEquipment(request),
    });
  }

  /*
   * Письмо службе уходит на входе в статус, и повторить его можно только там, где событие есть:
   * «Новая» и «Отменена». В остальных статусах сервер отвечает 422, и предлагать кнопку было бы
   * обещанием, которого он не даёт.
   *
   * Предикат читает строку, а не голый статус (Р14): у «Новой» письмо зовёт службу РАЗОБРАТЬ
   * заявку, и после назначения повторять его незачем — задание исполнителю ушло своим письмом,
   * привязанным к действию. Пока «Новая» означала «ещё не назначена», на это отвечал статус; после
   * слияния он половину ответа потерял бы молча.
   */
  if (
    !executor &&
    serviceMailRepeatable(row) &&
    hasPermission(ctx.user, 'serviceRequests.status')
  ) {
    items.push({
      key: 'notify',
      label: 'Отправить письмо службе ещё раз',
      icon: <MailOutlined />,
      onClick: () => ctx.run.notify(request),
    });
  }

  return items;
}
