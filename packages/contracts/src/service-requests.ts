import { z } from 'zod';
import { archiveFilterSchema, baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { contactNameSchema, contactPhoneSchema } from './common';
import { actsForCounterparty, can, type AccessSubject, type Permission } from './permissions';
import type { ModuleMailOutcome } from './module-mail';

// ── Заявки на обслуживание оргтехники (ADR 0085) ──
// Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
// которую подписывают ИТ-служба и «Ведение», а после работ — приёмка. Здесь живут вид заявки,
// статусы, коридоры переходов и схемы всех ручек модуля; кто и что может — в permissions.ts,
// область — в lib/access.ts на сервере.
//
// Выпуск 1 плана `office-equipment-requests-rework-plan.md` свёл оба вида заявок к одному
// словарю статусов (Н2) и увёл визу ИТ со входа на смету (Н3). Два значения статуса —
// `it_approved` и `diagnostics` — МЁРТВЫЕ значения: заявок в этих статусах больше не существует,
// их запретил `CHECK` выпуска 2 (`0197`), а остаток перевела та же миграция. В типе они остались по
// двум причинам, и обе внешние: `ALTER TYPE … DROP VALUE` в Postgres нет вовсе, а история переходов
// их ХРАНИТ — строка «Новая → Согласована ИТ» от 12.08 правдива, и портал обязан её подписать.
// Поэтому подписи и цвета у них есть, а ходов нет: в каждом коридоре ниже стоит пустой список, и
// это не пропуск, а утверждение «из этого статуса не ходят, потому что в нём не бывают».

// ── Вид заявки ──

/**
 * Ремонт и расходники — один модуль и один цикл (Н1): та же техника, та же область видимости,
 * та же история, те же письма. Вид отвечает за две вещи — какие дуги доступны (заход в смету
 * только у ремонта) и что показывает форма. Вторым модулем это стоило бы второго списка,
 * второй истории и второго набора прав ради одной таблицы строк.
 *
 * Схема базы разрешает `consumable` с выпуска 1, а API — нет (план §7.3): до выпуска 3 у
 * такой заявки нет ни строк номенклатуры, ни формы, ни списания, и заведённая раньше времени
 * она была бы заявкой без предмета.
 */
export const SERVICE_REQUEST_KINDS = ['repair', 'consumable'] as const;
export const serviceRequestKindSchema = z.enum(SERVICE_REQUEST_KINDS);
export type ServiceRequestKind = (typeof SERVICE_REQUEST_KINDS)[number];

export const serviceRequestKindLabels: Record<ServiceRequestKind, string> = {
  repair: 'Ремонт',
  consumable: 'Расходники',
};

// ── Статусы ──

export const SERVICE_REQUEST_STATUSES = [
  'new',
  'it_approved',
  'assigned',
  'diagnostics',
  'estimate_review',
  'in_work',
  // Заморозка стоит среди рабочих статусов, а не последней: список сортируется порядком значений
  // enum в БД (миграция добавляет значение `AFTER 'in_work'`), и порядок этого массива обязан ему
  // совпадать — иначе сортировка по статусу в портале и на сервере разъедутся.
  'on_hold',
  'done',
  'accepted',
  'cancelled',
] as const;
export const serviceRequestStatusSchema = z.enum(SERVICE_REQUEST_STATUSES);
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export const serviceRequestStatusLabels: Record<ServiceRequestStatus, string> = {
  new: 'Новая',
  // Мёртвый статус (`0197`): заявок в нём нет, но подпись нужна ИСТОРИИ — строка «Новая →
  // Согласована ИТ» от 12.08 правдива, и портал обязан её назвать. Прежней она оставлена по той же
  // причине: переименуй мы её в «Новая», два разных состояния слились бы в ленте истории.
  it_approved: 'Согласована ИТ',
  // Не «Назначен сервис» (Н2): исполнителем бывает и свой сотрудник, и название, называющее
  // подрядчика, перестало описывать состояние.
  assigned: 'Назначена',
  diagnostics: 'Диагностика', // мёртвый статус (0197): подпись нужна истории
  estimate_review: 'Смета на согласовании',
  in_work: 'В работе',
  // Заморозка — состояние, а не флаг рядом со статусом (Р103): «В работе, но не в работе»
  // пришлось бы читать вместе с каждым коридором.
  on_hold: 'Отложена',
  // «Решена», а не «Ожидает приёмки» (Н2, постановка заказчика): словарь один на оба вида заявок, и
  // подпись обязана одинаково читаться у ремонта и у привезённого картриджа.
  done: 'Решена',
  accepted: 'Закрыта',
  cancelled: 'Отменена',
};

export const serviceRequestStatusColors: Record<ServiceRequestStatus, string> = {
  new: 'blue',
  it_approved: 'purple',
  assigned: 'cyan',
  diagnostics: 'geekblue',
  estimate_review: 'gold',
  in_work: 'orange',
  // Серый: заявка не движется, и в списке она не должна спорить цветом с теми, за которые взялись.
  on_hold: 'default',
  done: 'lime',
  accepted: 'green',
  cancelled: 'red',
};

/**
 * Что за шаг ждут в этом статусе (Р101). Строка нижним регистром и без лица: портал приписывает
 * лицо сам — «Вам: согласовать смету» тому, за кем ход, и «ждёт оператора» остальным. Словарь один
 * на все стороны, потому что два («что делать сервису» и «кого ждут») разъезжаются на первом же
 * новом статусе: так и вышло с заморозкой — прежний `serviceTodoLabel` знал три статуса из девяти.
 *
 * У статусов без хода — отложенной, закрытой и отменённой — подписи нет: ждать в них нечего.
 *
 * У «Сметы на согласовании» подпись одна на обе очереди (`serviceRequestWaitingOn` их различает):
 * «согласовать смету» верно и для визы ИТ, и для суммы. Развести их значило бы завести второй
 * словарь по строке заявки рядом с этим — ровно то, чем разошлись прежние два.
 */
export const serviceStepLabels: Record<ServiceRequestStatus, string> = {
  new: 'назначить исполнителей',
  it_approved: 'назначить исполнителей', // мёртвый статус (0197)
  assigned: 'принять в работу',
  diagnostics: 'выполнить и закрыть работы', // мёртвый статус (0197)
  estimate_review: 'согласовать смету',
  in_work: 'выполнить и закрыть работы',
  on_hold: '',
  done: 'принять работу',
  accepted: '',
  cancelled: '',
};

/**
 * Шаг, которого ждут **от конкретной стороны** в этом статусе. Нужен там, где одного статуса
 * недостаточно: в «Смете на согласовании» сперва ждут визу ИТ, потом деньги, и подпись «Вам:
 * согласовать смету», показанная согласующему от ИТ, звала бы его не туда.
 *
 * Словарь `serviceStepLabels` остаётся: он отвечает на вопрос «что за шаг ждут в этом статусе»
 * вообще — им подписывают чужой ход («Ждёт исполнителя»), где сторона уже названа. Эта функция
 * отвечает на «что делать **мне**», и различает она ровно то, что различает
 * `serviceRequestWaitingOn`.
 */
export function serviceStepLabelFor(
  status: ServiceRequestStatus,
  waiting: ServiceWaitingOn,
): string {
  if (status === 'estimate_review' && waiting === 'it') return 'решить: чинить или менять аппарат';
  return serviceStepLabels[status];
}

/**
 * Закрытая заявка: ни ход, ни правка ей больше не положены. Отложенная закрытой не считается
 * (Р109): движение остановлено, но заявка жива — техника ждёт этого же ремонта, и вторую на ту же
 * единицу заводить нельзя.
 */
export function isServiceRequestClosed(status: ServiceRequestStatus): boolean {
  return status === 'accepted' || status === 'cancelled';
}

// ── Коридоры переходов ──
// Их шесть, а не один общий, и разведены они не по ролям, а по трём основаниям матрицы (план §6):
// что субъекту позволено правом, назначен ли он на эту заявку и из какого статуса ход. Общая
// таблица склеила бы первые два: право `serviceRequests.status` есть и у «Ведения», и у оператора
// сервисной компании — по ней подрядчик принимал бы собственную работу, а «Ведение» закрывало бы
// работы, которых не делало. Портал такие кнопки не рисует, но портал и не защита: отказывает
// сервер, и обе стороны спрашивают одну функцию.

/**
 * Ход исполнителя: то, что делает сам взявшийся за заявку. Открывает его **факт назначения**, а не
 * право (план §6, п. 2), — поэтому свой сисадмин и подрядчик ходят одними и теми же ручками.
 */
export const SERVICE_EXECUTOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  it_approved: [], // мёртвый статус (0197): заявок в нём не бывает
  // Отказ возвращает заявку в «Новую», а не к визе ИТ: визы на входе больше нет (Н3). Дуга одна на
  // весь отказ, а кого снимать — строку отказавшегося или всю компанию — решает ручка (§4.2):
  // коридор отвечает на «бывает ли такой ход», а не на «остался ли кто-то ещё».
  assigned: ['in_work', 'new'], // принять в работу · отказаться (причина)
  diagnostics: [], // мёртвый статус (0197): заявок в нём не бывает
  estimate_review: [],
  // Смета предъявляется из «В работе» и возвращает заявку туда же: «Диагностика» слилась с ней
  // (Н2), и повторное предъявление — та же дуга с ревизией +1, а не откат в отдельный статус.
  // Второго пути к смете нет намеренно: он сделал бы необязательным подъём ревизии, на котором
  // держится обесценивание обеих подписей (Н3).
  in_work: ['estimate_review', 'done'], // предъявить смету · закрыть работы
  // Заморозку исполнитель не двигает (Р105): о задержке он сообщает примечанием, а откладывает и
  // возобновляет тот, кто ведёт заявку, — иначе «ждём запчасть» становилось бы решением подрядчика.
  on_hold: [],
  done: [],
  accepted: [],
  cancelled: [],
};

/**
 * Отдел ИТ (Н3): решение переехало со входа на смету — «чинить за эти деньги или менять аппарат».
 * Первого исхода в таблице нет, и это не пропуск: виза статуса не меняет, она подписывает текущую
 * ревизию сметы. Второй — отмена с причиной и пометкой «рекомендована замена» (В21), и приходит он
 * тем же правом `serviceRequests.approveIt`: это второй исход одной ручки, а не общее право
 * отменять заявки (§6.3).
 */
export const SERVICE_IT_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  // «Новую» распределяют, а не визируют: на распределении согласовывать нечего — предмет решения
  // (счёт инженера) появляется позже.
  new: [],
  it_approved: [], // мёртвый статус (0197)
  assigned: [],
  diagnostics: [], // мёртвый статус (0197)
  estimate_review: ['cancelled'], // «менять аппарат»: причина обязательна, пометку ставит ручка
  in_work: [],
  on_hold: [],
  done: [],
  accepted: [],
  cancelled: [],
};

/**
 * Распределение (право `serviceRequests.assign`): кто делает заявку. Своей таблицей, а не строкой в
 * операторской, потому что назначают двое — «Ведение» и ИТ-служба, — а права хода
 * (`serviceRequests.status`) у второй нет и быть не должно (§7.2): слитые в одно, назначение
 * пришлось бы выдавать вместе с приёмкой работы, отменой и согласованием сметы.
 */
export const SERVICE_ASSIGNER_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: ['assigned'],
  it_approved: [], // мёртвый статус (0197)
  // Переназначение — тот же статус, другой исполнитель: заявка не откатывается назад, но её
  // возраст в статусе обнуляется, иначе новый исполнитель наследовал бы чужое ожидание.
  assigned: ['assigned'],
  diagnostics: [], // мёртвый статус (0197)
  // Пока смета на подписи, менять исполнителя нечем: цифры в ней его, и переназначение оставило бы
  // новому чужой счёт. Сперва решают по смете — из «В работе» переназначение снова открыто.
  estimate_review: [],
  in_work: ['assigned'],
  on_hold: [],
  done: [],
  accepted: [],
  cancelled: [],
};

/**
 * Заморозка (§6.2): из любого рабочего статуса и ничего из закрытых. «Решена» в перечне нет
 * намеренно — работа предъявлена, ход за приёмкой, и откладывать там нечего: заявка и так стоит,
 * пока её не примут.
 *
 * Отдельной таблицей, потому что держателей двое — «Ведение» и ИТ-служба, — и приходит заморозка
 * своим правом `serviceRequests.hold`: дай мы её через `serviceRequests.status`, ИТ-служба
 * получила бы вместе с ней весь операторский коридор (§7.1).
 */
export const SERVICE_HOLD_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: ['on_hold'],
  it_approved: [], // мёртвый статус (0197)
  assigned: ['on_hold'],
  diagnostics: [], // мёртвый статус (0197)
  estimate_review: ['on_hold'],
  in_work: ['on_hold'],
  // В себя заморозка не вкладывается: вторая причина поверх первой потеряла бы `held_from_status`,
  // и заявке некуда стало бы возвращаться.
  on_hold: [],
  /*
   * «Решена» откладывается, и это не недосмотр (правка после В3). Р106 ADR 0125 разрешил заморозку
   * этого статуса прямо — «ждём акт от сервиса», — и закрыть её значило бы сузить сегодняшнее
   * поведение без просьбы заказчика.
   *
   * Второй довод появился вместе с автозакрытием: отложенная заявка стоит в `on_hold`, а отбор
   * берёт только `done`, — заморозка и есть единственный ручной способ снять заявку с очереди на
   * автоматическое закрытие, пока идёт разбирательство.
   */
  done: ['on_hold'],
  accepted: [],
  cancelled: [],
};

/**
 * «Ведение» (право `serviceRequests.status`): решения заказчика — согласование сметы, приёмка,
 * возврат на доработку и отмена. Ни одного шага исполнителя здесь нет и быть не должно.
 *
 * Согласование и отклонение сметы ведут в один статус — «В работе» (Н2): «Диагностики», куда
 * возвращалась отклонённая смета, больше не существует. Различает их не дуга, а тело ручки
 * (`approveServiceEstimateSchema`), там же требуется и причина отказа. Заводить ради этого
 * различия отдельный статус значило бы вернуть «Диагностику» под другим именем.
 */
export const SERVICE_OPERATOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  // Отменить «Новую» можно: заявку, которую отзывает сам заказчик, незачем гонять по циклу. Сам
  // заказчик статусов не двигает (§6.3) — он просит отменить, а ход делает «Ведение».
  new: ['cancelled'],
  it_approved: [], // мёртвый статус (0197)
  assigned: ['cancelled'],
  diagnostics: [], // мёртвый статус (0197)
  estimate_review: ['in_work', 'cancelled'], // согласовать сумму · отклонить смету (причина)
  in_work: ['cancelled'],
  on_hold: ['cancelled'],
  done: ['accepted', 'in_work'], // принять · вернуть на доработку
  accepted: [],
  cancelled: [],
};

/**
 * Откаты администратора. Дуги `in_work → estimate_review` здесь намеренно нет: смету меняют
 * повторным предъявлением из «В работе» с подъёмом ревизии, и второй путь назад сделал бы этот
 * подъём необязательным — а на нём держится обесценивание обеих подписей (Н3).
 *
 * Откат назначения ведёт в «Новую»: промежуточного статуса между заведением и назначением больше
 * нет — виза уехала на смету.
 */
export const SERVICE_ADMIN_ROLLBACKS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  it_approved: [], // мёртвый статус (0197)
  assigned: ['new'],
  diagnostics: [], // мёртвый статус (0197)
  // Предъявление сметы отматывает не откат, а дуга «Ведения» (`estimate_review → in_work`): два
  // способа пройти один переход разошлись бы на первой же правке.
  estimate_review: [],
  // Откат «принял в работу»: заявка возвращается к назначенным, не теряя их. Прежде эта дуга
  // называлась `diagnostics → assigned` — статус слился с «В работе», а откат остался.
  in_work: ['assigned'],
  // Из заморозки не откатывают (Р110): цель пришлось бы считать от `held_from_status` вторым путём
  // рядом с возвратом, и два способа выйти в тот же статус разошлись бы на первой же правке. И
  // откатов **в** `on_hold` нет ни у одного статуса: заморозка — решение оператора, а не ошибка
  // хода, которую администратор отматывает.
  on_hold: [],
  done: ['in_work'],
  accepted: ['done'],
  cancelled: ['new'],
};

// ── Ход исполнителя: назначение вместо права ──

/**
 * Признаки назначения — то, чего матрица прав не знает и знать не может: они читаются из самой
 * заявки. Предикат принимает их **готовыми**, а не ходит за ними сам, потому что спрашивают его
 * двое — сервер по строке заявки и портал по карточке, — и «сходить в базу» умеет только первый.
 */
export interface ServiceExecutorAssignment {
  /** Заявка назначена контрагенту, оператором которого работает субъект (Н5). */
  actsForAssignedCounterparty: boolean;
  /** Субъект значится в `service_request_executors` этой заявки (Н5). */
  isNamedExecutor: boolean;
}

/** Заявка, про которую признаков не спрашивали: ни компании субъекта, ни его строки в ней нет. */
const NOT_ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: false,
};

/**
 * Исполнитель ли субъект на этой заявке — дизъюнкция двух признаков (план §7.1), записанная один
 * раз на все действия исполнителя: статусные ходы, смету, закрытие работ и правку факта выдачи.
 *
 * У сервисной компании назначена компания целиком, поэтому права ей не требуется: поимённых строк
 * у неё нет, и требовать `serviceRequests.execute` от учётки подрядчика значило бы либо отобрать у
 * него сегодняшние ходы, либо дописать право ради проверки, которая для него не выполняется ни при
 * каком назначении. У своего сотрудника назначение работает **в паре** с правом — снятие набора у
 * переведённого сисадмина закрывает ходы, не трогая историю назначений.
 */
export function isServiceExecutor(
  subject: AccessSubject | null | undefined,
  assignment: ServiceExecutorAssignment,
): boolean {
  if (!subject) return false;
  if (assignment.actsForAssignedCounterparty && actsForCounterparty(subject, 'service')) {
    return true;
  }
  return assignment.isNamedExecutor && can(subject, 'serviceRequests.execute');
}

/**
 * Что субъекту доступно из текущего статуса. Одна функция на сервер и портал: разойдись они —
 * кнопка вела бы в 403 либо действие оставалось бы недоступным при разрешающем сервере.
 *
 * Признаки назначения необязательны, и это не послабление: до волн В3/В6 их не передаёт ни один
 * зовущий, а ответ «ходов нет» отобрал бы у подрядчика весь цикл в тот же день, когда контракты
 * уехали, а маршруты — ещё нет. Поэтому без признаков сторона исполнителя считается по
 * сегодняшнему правилу: оператор контрагента-сервиса. Заявок чужого контрагента он не видит вовсе,
 * и на вопрос «назначена ли она моей компании» за него уже ответила область видимости.
 *
 * Администратор получает **объединение** коридоров: он разбирает ошибки и доводит заявку за любую
 * сторону. Ход исполнителя открывает ему право сметы, а не назначение, — вне контрагента-сервиса
 * оно есть только у него, и без этой ветки зависшую заявку было бы нечем довести.
 */
export function allowedServiceStatusTransitions(
  from: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
  assignment?: ServiceExecutorAssignment | null,
): ServiceRequestStatus[] {
  if (!subject) return [];
  // Сторона подрядчика отвечает **вместо** остальных, а не вместе с ними: право
  // `serviceRequests.status` у оператора сервисной компании есть, и по сумме коридоров он принял
  // бы собственную работу и отменил бы заявку заказчика.
  if (actsForCounterparty(subject, 'service')) {
    const assigned = assignment?.actsForAssignedCounterparty ?? true;
    return assigned ? [...SERVICE_EXECUTOR_TRANSITIONS[from]] : [];
  }
  const allowed = new Set<ServiceRequestStatus>();
  if (
    isServiceExecutor(subject, assignment ?? NOT_ASSIGNED) ||
    can(subject, 'serviceRequests.estimate')
  ) {
    for (const to of SERVICE_EXECUTOR_TRANSITIONS[from]) allowed.add(to);
  }
  // Виза ИТ не требует права хода: согласующий заявки не ведёт, он отвечает на один вопрос.
  // Требуй мы здесь `serviceRequests.status`, полномочие пришлось бы выдавать вместе с правом
  // двигать заявку по всему циклу.
  if (can(subject, 'serviceRequests.approveIt')) {
    for (const to of SERVICE_IT_TRANSITIONS[from]) allowed.add(to);
  }
  if (can(subject, 'serviceRequests.assign')) {
    for (const to of SERVICE_ASSIGNER_TRANSITIONS[from]) allowed.add(to);
  }
  if (canHoldService(subject)) {
    for (const to of SERVICE_HOLD_TRANSITIONS[from]) allowed.add(to);
  }
  if (can(subject, 'serviceRequests.status')) {
    for (const to of SERVICE_OPERATOR_TRANSITIONS[from]) allowed.add(to);
  }
  // Откаты спрашиваются парой прав, а не одним `requests.rollbackStatus`: оно есть и у диспетчера,
  // который заявок оргтехники не ведёт вовсе, — а «отмотать статус назад» это всё-таки ход по
  // модулю, и без права хода в нём он означал бы стороннее вмешательство в чужой цикл.
  if (can(subject, 'requests.rollbackStatus') && can(subject, 'serviceRequests.status')) {
    for (const to of SERVICE_ADMIN_ROLLBACKS[from]) allowed.add(to);
  }
  return [...allowed];
}

export function canTransitionServiceStatus(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
  assignment?: ServiceExecutorAssignment | null,
): boolean {
  return allowedServiceStatusTransitions(from, subject, assignment).includes(to);
}

/**
 * Кто держит и отпускает заявку. Право `serviceRequests.hold` — своё (§7.1), но `status` остаётся
 * вторым источником: заморозка сегодня приходит вместе с ним, и учётка, у которой набор ещё не
 * выдан, а надстройка ADR 0086 жива, иначе потеряла бы её в день выката. Правило выпуска 1 ничего
 * не запрещает из того, что делает старый код (план §3, п. 1).
 *
 * Исполнителю заморозка закрыта при любом праве (Р105): о задержке он сообщает примечанием, а
 * держит и отпускает заявку тот, кто её ведёт, — иначе «ждём запчасть» становилось бы решением
 * подрядчика.
 */
export function canHoldService(subject: AccessSubject | null | undefined): boolean {
  if (!subject) return false;
  if (actsForCounterparty(subject, 'service')) return false;
  return can(subject, 'serviceRequests.hold') || can(subject, 'serviceRequests.status');
}

/**
 * Вправе ли субъект вернуть отложенную заявку в работу. Отдельным именем, а не строкой в коридоре:
 * цель возврата динамическая (`held_from_status`), и таблицей `Record<status, status[]>` она не
 * выражается — а спрашивают это и портал (показать пункт меню), и сервер (ручка `/resume`).
 *
 * Условие то же, что у заморозки, и считается той же функцией: заморозка, из которой возвращает не
 * тот, кто её ставил, означала бы заявку, отпущенную мимо человека, знающего причину.
 */
export function canResumeService(subject: AccessSubject | null | undefined): boolean {
  return canHoldService(subject);
}

/**
 * Куда вернётся отложенная заявка; `null` — она не отложена, и возвращать нечего. Дуга назад одна
 * (Р104): разреши мы выбирать целевой статус, «Отложена» стала бы вторым входом в цикл — в обход
 * виз, сметы и назначения.
 */
export function serviceResumeTarget(row: {
  status: ServiceRequestStatus;
  heldFromStatus: ServiceRequestStatus | null;
}): ServiceRequestStatus | null {
  return row.status === 'on_hold' ? row.heldFromStatus : null;
}

/**
 * Переход, отменяющий чужую работу, требует объяснения: без него в истории останется пара строк, по
 * которой не понять, ошиблись исполнителем, отказался он сам или смета оказалась вдвое дороже.
 *
 * Отклонения сметы в этом перечне нет, и это следствие единого цикла (Н2): согласие и отказ ведут
 * в один статус, и пара «откуда → куда» их больше не различает. Причину отказа требует тело ручки
 * (`approveServiceEstimateSchema`) — там, где известен сам исход.
 */
export function serviceStatusChangeRequiresReason(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): boolean {
  if (to === 'cancelled') return true;
  // Заморозка (Р107): даты «отложена до» у неё нет, и когда ждать — говорит только причина. Без
  // неё в списке стоит «Отложена · 12 дней», по которым не понять, ждут запчасть или решение.
  if (to === 'on_hold') return true;
  // Отказ исполнителя и откат назначения: у заявки отбирают того, кто за неё взялся.
  if (from === 'assigned' && to === 'new') return true;
  if (from === 'done' && to === 'in_work') return true; // возврат на доработку
  return false;
}

/**
 * Что заявка теряет, возвращаясь назад. Заявка после возврата не должна выглядеть так, будто её и
 * не двигали: снимок согласования под чужой ревизией сметы или факт закрытия у заявки «в работе»
 * означали бы решение, которого никто не принимал.
 *
 * Гарантия при возврате снимается целиком — и посчитанная, и введённая руками. Причина в том, что
 * возврат отменяет само выполнение: гарантия не начиналась, отсчитывать её не от чего, а строка без
 * выполнения гарантии и не держит (CHECK в БД). Талон при этом никуда не делся — дату введут заново
 * при повторном закрытии, той же ручкой; `warranty_until_manual` отличает её от посчитанной, чтобы
 * повторное закрытие не перетёрло дату из талона своим расчётом.
 */
export interface ServiceTransitionReset {
  /** Снять визу отдела ИТ (кто и когда). */
  itApproval: boolean;
  /** Снять назначенного исполнителя — и контрагента, и поимённые строки. */
  executor: boolean;
  /** Стереть смету целиком вместе с её ревизией и снимком предъявления. */
  estimate: boolean;
  /** Стереть снимок согласования (кто, когда, какая ревизия). */
  approval: boolean;
  /** Стереть факт закрытия: дату, итог, корректировку и отметки выполнения по строкам. */
  completion: boolean;
  /** Стереть снимок приёмки. */
  acceptance: boolean;
  /**
   * Снять пометку «рекомендована замена» (М5 плана). Она существует только у отменённой заявки —
   * объясняет, почему её закрыли без ремонта (Н3), — и возврат отменённой в «Новую» обязан её
   * снять: иначе откат упрётся в `service_requests_replacement_check` ошибкой БД.
   */
  replacement: boolean;
  /**
   * Очистить поля заморозки: `held_from_status` и `hold_reason` (Р118). Поднимается на **любом**
   * выходе из `on_hold` — и при возобновлении, и при отмене отложенной, и на пути, заведённом
   * позже. Иначе `service_requests_hold_check` поймает отмену отложенной ошибкой БД: остальные
   * поля этой структуры про исполнителя и согласование, про заморозку они не знают.
   */
  hold: boolean;
}

const NO_RESET: ServiceTransitionReset = {
  itApproval: false,
  executor: false,
  estimate: false,
  approval: false,
  completion: false,
  acceptance: false,
  replacement: false,
  hold: false,
};

/**
 * Р118. Флаг заморозки **дополняет** обычный сброс, а не подменяет его: напрашивающаяся ветка
 * `if (from === 'on_hold') return { ...NO_RESET, hold: true }` в цепочке ниже была бы ошибкой —
 * отмена отложенной заявки обязана снять исполнителя и снимок согласования ровно так же, как
 * отмена из любого другого статуса, иначе у отменённой останутся и сервис, и согласие со сметой.
 * Поэтому базовый сброс считается по паре `(from → to)` отдельной функцией, а `hold` приписывается
 * сверху, каким бы этот сброс ни оказался.
 *
 * Вход в заморозку не сбрасывает ничего: она ничего не отменяет — ни одна ветка `to` про `on_hold`
 * не знает, и это верно.
 */
export function serviceResetOnTransition(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): ServiceTransitionReset {
  return { ...baseServiceReset(from, to), hold: from === 'on_hold' };
}

/**
 * Сброс по паре статусов, без заморозки. Возврат из `on_hold` попадает в ту же ветку, что и
 * обычный переход в тот же статус: два правила на один переход разошлись бы на первой же правке.
 */
function baseServiceReset(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): ServiceTransitionReset {
  // Отказ исполнителя и откат назначения: заявка снова ничья и ждёт распределения. Виза ИТ здесь
  // ни при чём — она теперь стоит на смете, а не на входе (Н3).
  if (from === 'assigned' && to === 'new') return { ...NO_RESET, executor: true };
  // Отмена возвращает заявку в состояние «ничего не делали»: она остаётся историей того, что
  // собирались чинить, но ни исполнителя, ни согласованной сметы у неё больше нет.
  if (to === 'cancelled') return { ...NO_RESET, executor: true, approval: true };
  if (from === 'cancelled' && to === 'new') {
    // Возвращённая отменённая заявка проходит цикл заново — в том числе визу ИТ: отклонить её мог
    // как раз он, и сохранённая подпись означала бы согласие, которого не было. Пометка «менять
    // аппарат» снимается тем же ходом: она относилась к отмене, которой больше нет.
    return {
      ...NO_RESET,
      itApproval: true,
      executor: true,
      estimate: true,
      approval: true,
      replacement: true,
    };
  }
  // Возврат на доработку и одноимённый откат: факт закрытия предъявлен заново.
  if (from === 'done' && to === 'in_work') return { ...NO_RESET, completion: true };
  if (from === 'accepted' && to === 'done') return { ...NO_RESET, acceptance: true };
  // Согласование и отклонение сметы (`estimate_review → in_work`) не стирают ничего, и это не
  // пропуск: обе подписи обесценивает подъём ревизии на следующем предъявлении (Н3). Стирай мы
  // снимок здесь — согласие стирало бы собственный снимок, потому что дуга у согласия и отказа
  // одна, и различать их пришлось бы вторым правилом рядом с ручкой.
  return NO_RESET;
}

// ── Кого ждут ──

/**
 * От кого сейчас ждут шага. Значения только те, у кого шаг в цикле есть: заказчик решений не
 * принимает — приёмку делает «Ведение», — поэтому `customer` здесь не заводится. Появится шаг
 * заказчика (например, подтверждение стоимости площадкой) — появится и значение вместе с веткой
 * предиката.
 */
export const SERVICE_WAITING_ON = ['it', 'operator', 'service', 'hold', 'nobody'] as const;
export type ServiceWaitingOn = (typeof SERVICE_WAITING_ON)[number];

export const serviceWaitingOnLabels: Record<ServiceWaitingOn, string> = {
  it: 'Ждёт ИТ',
  operator: 'Ждёт оператора',
  service: 'Ждёт исполнителя',
  // Не «Никого»: отложенную заявку ждёт решение оператора, но не шаг цикла — очередь и бейдж её не
  // считают (Р111), а человеку в списке нужна причина остановки, а не пустая клетка.
  hold: 'Отложена',
  nobody: 'Закрыта',
};

/**
 * Строка заявки, по которой считается очередь. Три поля, а не один статус: в «Смете на
 * согласовании» ждут двоих по очереди — сперва ИТ («чинить или менять»), потом «Ведение»
 * («согласны на эту сумму»), — и различает их только ревизионная виза (Н3).
 *
 * Подстатуса для этого не заводится: третьего состояния «обе подписи есть» не существует во
 * времени — вторая подпись тем же действием двигает заявку в «В работе». Остаются два, и оба
 * однозначно читаются по данным.
 */
export interface ServiceWaitingRequest {
  status: ServiceRequestStatus;
  /** Текущая ревизия сметы: растёт с каждым предъявлением. */
  estimateRevision: number;
  /**
   * Ревизия, на которой стоит виза ИТ. `null` — визы нет вовсе либо она входная, старого образца:
   * такая визой сметы не считается, и граница проходит ровно по этому полю (Н3).
   */
  itApprovedEstimateRevision: number | null;
}

/**
 * Стоит ли виза ИТ на **текущей** ревизии сметы. Единственное место правила: по нему сервер решает,
 * можно ли согласовывать сумму (`approveEstimate` — только после визы), портал — какую кнопку
 * показать, а очередь — кого ждут.
 *
 * Равенство, а не «не меньше»: подпись под позапрошлой ревизией означала бы согласие с ценами,
 * которых в смете уже нет, — а новое предъявление поднимает ревизию именно затем, чтобы обе
 * подписи перестали относиться к делу.
 */
export function hasCurrentItApproval(
  row: Pick<ServiceWaitingRequest, 'estimateRevision' | 'itApprovedEstimateRevision'>,
): boolean {
  return (
    row.itApprovedEstimateRevision !== null &&
    row.itApprovedEstimateRevision === row.estimateRevision
  );
}

export function serviceRequestWaitingOn(row: ServiceWaitingRequest): ServiceWaitingOn {
  switch (row.status) {
    // «Новую» ждёт тот, кто распределяет: визы на входе больше нет (Н3), и до назначения с заявкой
    // ничего не происходит.
    case 'new':
    // Мёртвые статусы (0197) в `switch` остаются: заявок в них нет, но функцию зовут и на
    // строках истории, где они встречаются законно, — а `switch` обязан покрыть весь тип.
    case 'it_approved':
    case 'done':
      return 'operator';
    // Порядок подписей жёсткий: сперва ИТ, потом деньги. Наоборот — значило бы согласовывать сумму
    // ремонта, который через минуту признают ненужным.
    case 'estimate_review':
      return hasCurrentItApproval(row) ? 'operator' : 'it';
    case 'assigned':
    case 'diagnostics':
    case 'in_work':
      return 'service';
    // Заморозка снимает заявку со всех очередей: ход не за исполнителем и не за оператором — она
    // просто стоит (Р111).
    case 'on_hold':
      return 'hold';
    case 'accepted':
    case 'cancelled':
      return 'nobody';
  }
}

/**
 * @deprecated Отвечает по одному статусу и потому не различает две очереди «Сметы на согласовании»
 * (Н3): без ревизионной визы «Ждёт ИТ» стоит и там, где ИТ уже подписал. Пользуйтесь
 * `serviceRequestWaitingOn` — переключение вызовов идёт волнами В3 и В6, там же эта функция и
 * снимается.
 */
export function serviceWaitingOn(status: ServiceRequestStatus): ServiceWaitingOn {
  return serviceRequestWaitingOn({ status, estimateRevision: 0, itApprovedEstimateRevision: null });
}

/**
 * Ждут ли сейчас этого субъекта. Сравнивать `waitingOn` с ролью напрямую нельзя: у оператора
 * оргтехники роль — «Штаб» или «Отдел» (сторону задаёт надстройка), а у сервиса роль — «Оператор
 * (внешний исполнитель)» (сторону задаёт тип контрагента). Поэтому сторона определяется правами.
 */
export function isWaitingOn(
  subject: AccessSubject | null | undefined,
  waiting: ServiceWaitingOn,
): boolean {
  // Отложенная не в очереди «Ждут меня» и не в бейдже раздела (Р111): оператор вернётся к ней
  // сам, когда решится причина, а до тех пор она стояла бы первой строкой у всех, кого «ждёт».
  if (!subject || waiting === 'nobody' || waiting === 'hold') return false;
  // Поимённый исполнитель в эту ветку не попадает и попасть не может: «я в списке назначенных» —
  // свойство заявки, а не субъекта, и очередь отбирает такие заявки соединением с
  // `service_request_executors` (волна В3). Здесь остаётся сторона подрядчика, которую видно по
  // самому субъекту.
  if (waiting === 'service') return actsForCounterparty(subject, 'service');
  if (waiting === 'it') return can(subject, 'serviceRequests.approveIt');
  return can(subject, 'serviceRequests.assign');
}

// ── Номер заявки ──

/** Префикс сквозного номера: «М-» у мусора, «ТС-» у техники, «СО-» у сервисного обслуживания. */
export const SERVICE_REQUEST_NUMBER_PREFIX = 'СО-';

export function formatServiceRequestNumber(num: number): string {
  return `${SERVICE_REQUEST_NUMBER_PREFIX}${num}`;
}

/**
 * Номер из строки поиска: человек ищет и «СО-14», и «со-14», и просто «14». Возвращает `null`,
 * если это не номер, — тогда поиск идёт обычным текстом по модели и номерам техники.
 */
export function parseServiceRequestNumberSearch(search: string): number | null {
  const trimmed = search.trim().replace(/^со-?/i, '');
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return num > 0 ? num : null;
}

// ── Смета ──

export const SERVICE_ITEM_KINDS = ['part', 'service'] as const;
export const serviceItemKindSchema = z.enum(SERVICE_ITEM_KINDS);
export type ServiceItemKind = (typeof SERVICE_ITEM_KINDS)[number];

export const serviceItemKindLabels: Record<ServiceItemKind, string> = {
  part: 'Запчасть',
  service: 'Услуга',
};

/** Служебная строка гарантийного ремонта (Р27): её не набирают руками, но она должна быть узнаваема. */
export const WARRANTY_REPAIR_ITEM_NAME = 'Гарантийный ремонт';

const itemNameSchema = z.string().trim().min(2, 'Укажите наименование').max(255);
const quantitySchema = z.number().positive('Количество больше нуля').max(9999);
const priceSchema = z.number().min(0, 'Цена не может быть отрицательной').max(99_999_999);

export const serviceEstimateItemSchema = z.object({
  kind: serviceItemKindSchema,
  name: itemNameSchema,
  quantity: quantitySchema.default(1),
  unitPrice: priceSchema,
  /** Что обещали: срок гарантии в месяцах. Дата считается при закрытии от даты выполнения работ. */
  warrantyMonths: z.number().int().min(1).max(120).nullish(),
});
export type ServiceEstimateItemInput = z.infer<typeof serviceEstimateItemSchema>;

/**
 * Состав сметы передаётся целиком, а не построчно: смета — документ, и «добавить строку» без
 * остальных строк не имеет смысла. Пустой список разрешён (черновик), а вот предъявить пустую
 * смету нельзя — это проверяет сервер при переходе.
 */
export const putServiceEstimateSchema = z.object({
  items: z.array(serviceEstimateItemSchema).max(200),
  version: z.number().int().nonnegative(),
});
export type PutServiceEstimateInput = z.infer<typeof putServiceEstimateSchema>;

// ── Строки заявки на расходники (Н9, выпуск 3) ──
//
// Своим набором схем, а не расширением сметы: у строки расходника нет ни цены, ни суммы, ни
// гарантии — картридж берут со своего склада, и согласовывать по нему нечего. Общего у двух
// списков ровно одно слово «строка», и склеенная схема заставляла бы каждую половину объяснять,
// почему у неё пустует чужая половина полей.

/**
 * Сколько штук просят и сколько выдали. Верхняя граница — не учётное правило, а защита от опечатки
 * (тот же приём, что у остатка в справочнике): заявок на тысячу картриджей у ИТ-службы не бывает, а
 * «120» вместо «12» в поле ввода от правды ничем не отличается.
 */
const consumableQuantitySchema = z
  .number()
  .int('Количество — целое число')
  .max(1000, 'Проверьте количество: слишком большое число');

/**
 * Причина расхождения факта с запрошенным. Живёт в самой строке заявки, а не только в событии
 * журнала: её читают в карточке заявки и в отчёте по расходу, а событие журнала — это склад.
 */
const issueNoteSchema = z.string().trim().max(500);

/** Строка запроса: позиция справочника и сколько её просят. */
export const serviceConsumableLineSchema = z.object({
  consumableId: uuidSchema,
  requestedQuantity: consumableQuantitySchema.positive('Количество больше нуля'),
});
export type ServiceConsumableLineInput = z.infer<typeof serviceConsumableLineSchema>;

/**
 * Состав строк передаётся целиком (`PUT /:id/consumables`), как и смета: это список того, что
 * просят, и «добавить одну позицию» без остальных заставляло бы сервер угадывать, снимали ли
 * что-то.
 *
 * Пустой список запрещён, в отличие от черновика сметы: заявка на расходники без строк — это заявка
 * без предмета, и ни одного состояния, в котором она законно пуста, у неё нет.
 *
 * Повторы позиции отбиваются здесь, а не уникальным ключом БД: две строки «Тонер Ricoh 201» — это
 * не два расходника, а ошибка формы, и человек обязан прочитать про неё словами, а не получить
 * `23505`.
 */
export function addConsumableDuplicateIssues(
  items: readonly { consumableId: string }[],
  ctx: z.RefinementCtx,
  basePath: (string | number)[] = [],
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.consumableId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Позиция уже есть в заявке — измените количество в её строке',
        path: [...basePath, index, 'consumableId'],
      });
    }
    seen.add(item.consumableId);
  });
}

export const putServiceConsumablesSchema = z.object({
  items: z
    .array(serviceConsumableLineSchema)
    .min(1, 'Добавьте хотя бы одну позицию')
    .max(50)
    .superRefine((items, ctx) => addConsumableDuplicateIssues(items, ctx)),
  version: z.number().int().nonnegative(),
});
export type PutServiceConsumablesInput = z.infer<typeof putServiceConsumablesSchema>;

/**
 * Факт по одной строке: сколько выдали и почему это не то, что просили.
 *
 * `issuedQuantity` присылается всегда, в том числе нулём: ноль — это «съездили, тонер оказался цел»
 * (В9б), законный исход закрытия, а не «поле не заполнили». Пустого значения у ручки нет вовсе —
 * незаполненный факт означает «работу не закрывали», и вернуть строку в это состояние правкой
 * нельзя: событие журнала уже случилось.
 */
export const serviceConsumableIssueSchema = z.object({
  /** Идентификатор СТРОКИ заявки, а не позиции справочника: правят конкретную строку. */
  id: uuidSchema,
  issuedQuantity: consumableQuantitySchema.min(0, 'Выдано не может быть отрицательным'),
  issueNote: issueNoteSchema.optional().default(''),
});
export type ServiceConsumableIssueInput = z.infer<typeof serviceConsumableIssueSchema>;

/**
 * Правка факта выдачи (`PATCH /:id/consumables/issued`, Р6). Приходят только те строки, которые
 * меняют, — отсюда и `PATCH`: состав заявки эта ручка не трогает, она двигает склад событием на
 * разницу по каждой названной строке.
 */
export const setServiceConsumablesIssuedSchema = z.object({
  items: z.array(serviceConsumableIssueSchema).min(1).max(50),
  version: z.number().int().nonnegative(),
});
export type SetServiceConsumablesIssuedInput = z.infer<typeof setServiceConsumablesIssuedSchema>;

/**
 * Причина обязательна при ЛЮБОМ расхождении факта с запрошенным — и когда выдали больше (В9а), и
 * когда меньше, и когда ноль (В9б). Совпал факт с заявкой — объяснять нечего, и требовать текст
 * значило бы заставлять писать «всё как просили» две тысячи раз в год.
 *
 * Функцией, а не схемой на месте, по той же причине, что `urgencyIssue`: в теле запроса лежит
 * половина пары — сколько выдали, — а вторая половина, сколько просили, живёт в строке заявки.
 * Считать условие можно только по склеенному состоянию, и делает это сервер. Тот же ответ обязан
 * получаться у портала, который считает его до отправки формы, — поэтому правило одно и лежит здесь,
 * а `CHECK` `service_request_consumables_note_check` в базе повторяет его последним рубежом.
 */
export function serviceConsumableIssueIssue(line: {
  requestedQuantity: number;
  issuedQuantity: number;
  issueNote: string;
}): string | null {
  if (line.issuedQuantity === line.requestedQuantity) return null;
  if (line.issueNote.trim()) return null;
  if (line.issuedQuantity === 0) return 'Объясните, почему ничего не выдали';
  return line.issuedQuantity > line.requestedQuantity
    ? 'Объясните, почему выдали больше, чем просили'
    : 'Объясните, почему выдали меньше, чем просили';
}

// ── Гарантийное обращение ──

export const WARRANTY_CLAIM_SOURCES = ['equipment', 'item'] as const;
export const warrantyClaimSourceSchema = z.enum(WARRANTY_CLAIM_SOURCES);
export type WarrantyClaimSource = (typeof WARRANTY_CLAIM_SOURCES)[number];

export const warrantyClaimSourceLabels: Record<WarrantyClaimSource, string> = {
  equipment: 'Гарантия на технику',
  item: 'Гарантия на прошлый ремонт',
};

/**
 * Источник гарантийного обращения: не флаг «гарантийная», а ответ на вопрос, по чьей гарантии
 * обращаются. Без него спор с сервисом не разрешить — «гарантийная заявка» ничего не подтверждает.
 *
 * У источника `item` обязательна ссылка на строку сметы прошлой заявки, у `equipment` её быть не
 * должно: гарантия поставщика висит на самой единице.
 */
export const warrantyClaimSchema = z
  .object({
    source: warrantyClaimSourceSchema.nullish(),
    itemId: uuidSchema.nullish(),
  })
  .refine((v) => v.source !== 'item' || !!v.itemId, {
    message: 'Укажите, по какой позиции прошлого ремонта обращаетесь',
    path: ['itemId'],
  })
  .refine((v) => v.source !== 'equipment' || !v.itemId, {
    message: 'У гарантии на технику позиции ремонта не бывает',
    path: ['itemId'],
  });

// ── Заявка ──

export const SERVICE_REQUEST_SORT_FIELDS = [
  'num',
  'status',
  'equipment',
  'object',
  'service',
  'statusChangedAt',
  'createdAt',
] as const;

const descriptionSchema = z.string().trim().min(5, 'Опишите неисправность').max(4000);

export const serviceRequestListQuerySchema = baseListQuery(SERVICE_REQUEST_SORT_FIELDS).extend({
  status: serviceRequestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  equipmentId: uuidSchema.optional(),
  equipmentTypeId: uuidSchema.optional(),
  serviceCounterpartyId: uuidSchema.optional(),
  /** «Ждёт меня» — очередь, из которой оператор и сервис начинают работу. */
  waitingOnMe: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Заявки, заведённые самим пользователем: «где мои». */
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Предъявлена или принята, а закрывающих документов нет — планка приёмки (Р112, Р114). */
  awaitingDocuments: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  warrantyClaim: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Только срочные: очередь, с которой начинают день оператор и ИТ. */
  urgent: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  archive: archiveFilterSchema,
});

/**
 * Срочность: флаг и объяснение неразрывны (то же CHECK держит и БД). Чекбокс без причины через
 * месяц стоит у всех заявок — отбирать им становится нечего, а очередь, отсортированная по
 * признаку, который есть у каждого, ничем не отличается от несортированной.
 *
 * Проверка вынесена функцией, а не написана схемой на месте: срочность ставят в трёх местах
 * (заведение, правка, своя ручка), и в правке пара приходит наполовину — `PATCH` присылает только
 * изменившееся. Там условие считается по «склеенному» состоянию на сервере, а не по телу запроса.
 */
export const urgencyReasonSchema = z.string().trim().max(500);

export function urgencyIssue(value: { isUrgent: boolean; urgencyReason: string }): string | null {
  const reason = value.urgencyReason.trim();
  if (value.isUrgent && !reason) return 'Объясните, почему заявка срочная';
  if (!value.isUrgent && reason) return 'Причина без отметки «Срочная» ничего не объявляет';
  return null;
}

/** Схема с полной парой: заведение и своя ручка присылают оба поля разом. */
const withUrgency = <T extends z.ZodType<{ isUrgent: boolean; urgencyReason: string }>>(
  schema: T,
): T =>
  schema.superRefine((value, ctx) => {
    const issue = urgencyIssue(value);
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ['urgencyReason'] });
    }
  }) as unknown as T;

export const createServiceRequestSchema = withUrgency(
  z.object({
    officeEquipmentId: uuidSchema,
    /**
     * Вид заявки (Н1). До выпуска 3 контракт заведения этого поля не имел вовсе, и заявка на
     * расходники была незаводима — не запретом, а отсутствием поля (§7.3 плана): без строк
     * номенклатуры, формы и списания она была бы заявкой без предмета. Поле появляется вместе с
     * M12, то есть вместе со строками, формой и списанием.
     *
     * `optional()` БЕЗ `default('repair')`, и это не небрежность. `default` в zod делает поле
     * обязательным в РАЗОБРАННОМ теле, а его строит портал объектным литералом — то есть каждый
     * существующий вызов заведения пришлось бы дописать полем, которого он не знает. Умолчание при
     * этом никуда не девается: оно стоит колонкой в базе (`DEFAULT 'repair'`, M3) и останется там
     * навсегда. «Поля нет» читается как «ремонт» — ровно так, как читает его старый код в окне
     * выката.
     */
    kind: serviceRequestKindSchema.optional(),
    /**
     * Строки номенклатуры — у заявки на расходники и только у неё (§6.2). Приходят ЗАВЕДЕНИЕМ, а не
     * отдельным `PUT` следом: заявка без строк запрещена постановкой, и разложенное на два запроса
     * заведение оставляло бы её в этом состоянии всякий раз, когда второй запрос не дошёл.
     *
     * Правку состава делает уже `PUT /:id/consumables` — там та же строка и та же проверка повторов.
     *
     * `optional()` без `default([])` по той же причине, что у вида выше: пустой список и
     * отсутствие поля означают здесь одно и то же — «строк нет», — и платить за их различение
     * правкой каждого существующего вызова заведения не за что.
     */
    consumables: z.array(serviceConsumableLineSchema).max(50).optional(),
    description: descriptionSchema,
    /**
     * Отдел, от имени которого заявка (ADR 0085 §8). Подсказывается владельцем техники либо
     * единственным отделом автора, но выбирается человеком: сотрудник соседнего отдела чинит «чужой»
     * принтер чаще, чем кажется.
     *
     * `null` и «поля нет» — разные ответы, и разница здесь важнее самого поля: `null` означает
     * **заявка от площадки, подсказку не применять** — так отвечает форма, где заказчик обязателен
     * и пустого состояния у него нет; `undefined` означает «клиент про поле не знает», и только
     * тогда сервер подставляет подсказку (Р12, Р12а).
     */
    customerDepartmentId: uuidSchema.nullish(),
    /**
     * Подразделение **заявителя** (Н11) — не заказчик выше: заказчика выбирает человек («чужой»
     * принтер соседнего отдела), а здесь записано, где числится он сам.
     *
     * Присылают эти два поля **только чтобы выбрать одно из своих**: сервер берёт привязки учётки
     * `created_by` и на чужое отвечает 422. Единственная привязка подставляется без вопроса, и
     * тогда полей в теле нет вовсе; выбор требуется лишь у учётки с двумя отделами (или двумя
     * площадками). Прислать оба сразу нельзя — подразделение либо отдел, либо площадка.
     */
    requesterDepartmentId: uuidSchema.nullish(),
    requesterObjectId: uuidSchema.nullish(),
    /**
     * Заявитель и его телефон — обязательны (план модернизации, Р49). До этого обязательность жила
     * только в форме портала (`ResponsibleFields`), а схема принимала пустые строки: заявка без
     * контакта заводилась любым клиентом мимо формы, и именно её сервис получал первой — ехать по
     * адресу, не зная, к кому.
     */
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    warrantyClaim: warrantyClaimSchema.optional(),
    isUrgent: z.boolean().optional().default(false),
    urgencyReason: urgencyReasonSchema.optional().default(''),
    fileIds: z.array(uuidSchema).max(20).optional().default([]),
  }),
).superRefine((value, ctx) => {
  // Вид и строки — одно утверждение, а не два соседних поля: «заявка на расходники» без строк это
  // заявка без предмета, а строки номенклатуры у ремонта — состав, который никто не выдаст и не
  // спишет, потому что формы у него нет.
  const lines = value.consumables ?? [];
  if (value.kind === 'consumable' && lines.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Добавьте хотя бы одну позицию номенклатуры',
      path: ['consumables'],
    });
  }
  if (value.kind !== 'consumable' && lines.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Строки номенклатуры бывают только у заявки на расходники',
      path: ['consumables'],
    });
  }
  addConsumableDuplicateIssues(lines, ctx, ['consumables']);
});
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;

/**
 * Правка присылает только изменившееся, поэтому у срочности здесь **нет значения по умолчанию**:
 * `default(false)` означал бы, что правка телефона молча снимает срочность — тот же подвох, из-за
 * которого поля со значением по умолчанию переобъявляются в `updateOfficeEquipmentTypeSchema`.
 * Пару сверяет сервер по склеенному состоянию (`urgencyIssue`), потому что схема видит половину.
 */
export const updateServiceRequestSchema = z.object({
  description: descriptionSchema.optional(),
  /**
   * Смысл значений тот же, что при заведении, но сервер сверяет присланное **со строкой заявки**:
   * форма шлёт заказчика всегда, и «поле пришло» не означает «человек его менял» (Р12б).
   */
  customerDepartmentId: uuidSchema.nullish(),
  responsibleName: contactNameSchema.optional(),
  responsiblePhone: contactPhoneSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  warrantyClaim: warrantyClaimSchema.optional(),
  isUrgent: z.boolean().optional(),
  urgencyReason: urgencyReasonSchema.optional(),
  version: z.number().int().nonnegative(),
});
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;

/**
 * Срочность отдельной ручкой: её ставят и снимают не только при правке заявки. Заказчик правит
 * только «Новую» (ADR 0085 §8), а «сломался единственный принтер на площадке» выясняется и когда
 * заявка уже у сервиса, — поэтому оператор меняет признак в любой момент до закрытия.
 */
export const setServiceUrgencySchema = withUrgency(
  z.object({
    isUrgent: z.boolean(),
    urgencyReason: urgencyReasonSchema.default(''),
    version: z.number().int().nonnegative(),
  }),
);
export type SetServiceUrgencyInput = z.infer<typeof setServiceUrgencySchema>;

// ── Ход заявки ──
// Каждый переход с содержанием — своя ручка со своей схемой (ADR 0085 §18): так проверка условия
// перехода не может разъехаться с проверкой данных этого перехода. `/status` остаётся отмене и
// административным откатам, у которых из данных только причина.

const reasonSchema = z.string().trim().min(3, 'Укажите причину').max(1000);

export const assignServiceSchema = z.object({
  serviceCounterpartyId: uuidSchema,
  /** Причина обязательна при переназначении: у прежнего сервиса отбирают работу. */
  reason: reasonSchema.optional(),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type AssignServiceInput = z.infer<typeof assignServiceSchema>;

/**
 * Назначение исполнителей одним действием (Н5, Н6): список своих сотрудников **и**
 * исполнитель-контрагент. Одно тело, а не две ручки, потому что «наш сисадмин + КопиЛайт» —
 * обычный случай постановки, и разложенный на два запроса он давал бы промежуточное состояние,
 * в котором заявка уже переназначена, но ещё наполовину.
 *
 * Оба поля передаются **целиком**: список — это состав, и «добавить одного» без остальных
 * означало бы, что сервер должен угадывать, снимали ли кого-то. Пустой список вместе с
 * `null`-контрагентом — не «снять всех», а ошибка: заявка в рабочем статусе без исполнителя
 * запрещена триггером (M4), и отвечает на неё маршрут словами, а не ошибкой БД.
 *
 * Причина обязательна при переназначении: у прежнего исполнителя отбирают работу. Проверяет её
 * сервер по строке заявки — из тела не видно, первое это назначение или второе.
 */
export const putServiceExecutorsSchema = z.object({
  /** Поимённые исполнители — учётки с правом `serviceRequests.execute` (сервер проверяет). */
  userIds: z.array(uuidSchema).max(20),
  /** Исполнитель-контрагент; `null` — заявку ведут только свои. */
  serviceCounterpartyId: uuidSchema.nullable(),
  reason: reasonSchema.optional(),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type PutServiceExecutorsInput = z.infer<typeof putServiceExecutorsSchema>;

export const declineServiceRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});
export type DeclineServiceRequestInput = z.infer<typeof declineServiceRequestSchema>;

/**
 * «Принять в работу»: исполнитель берётся за заявку сам (В3). Данных у хода нет — есть только
 * версия, — но своя ручка нужна, потому что очередь «назначено, но никто не взялся» должна
 * оставаться видимой: сделай мы переход побочным следствием первой же правки сметы, эта очередь
 * исчезла бы вместе с ним.
 */
export const startServiceRequestSchema = z.object({
  version: z.number().int().nonnegative(),
});

/**
 * Предъявление сметы. `warrantyRepair` — отдельный режим (Р27): смета из одной служебной строки с
 * нулевой суммой. Он не «пустая смета», а осознанное «чиним по гарантии, денег нет», и требует
 * источника гарантии в самой заявке.
 */
export const submitServiceEstimateSchema = z.object({
  warrantyRepair: z.boolean().optional().default(false),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type SubmitServiceEstimateInput = z.infer<typeof submitServiceEstimateSchema>;

/** Согласование сметы: одна ручка на «да» и «нет» — у них одно право, одна область и один момент. */
export const approveServiceEstimateSchema = z
  .object({
    approved: z.boolean(),
    reason: reasonSchema.optional(),
    version: z.number().int().nonnegative(),
  })
  .refine((v) => v.approved || !!v.reason, {
    message: 'Укажите причину отклонения',
    path: ['reason'],
  });
export type ApproveServiceEstimateInput = z.infer<typeof approveServiceEstimateSchema>;

/**
 * Виза отдела ИТ по смете (Н3): одна ручка на два исхода — «чинить за эти деньги» и «менять
 * аппарат». Право одно (`serviceRequests.approveIt`), область одна и момент решения один, тот же
 * приём, что у согласования сметы.
 *
 * Первый исход статуса не меняет: он подписывает **текущую ревизию** сметы, и следующее
 * предъявление подпись обесценивает. Второй закрывает заявку отменой с пометкой «рекомендована
 * замена» (В21) — своего терминального статуса у него нет, потому что «закрыта без результата» в
 * модуле уже есть (Р53), а второе имя для того же состояния делило бы отчёты пополам. Причина
 * обязательна в обоих случаях отказа: «ИТ отказал» без объяснения заказчик прочитает как молчание,
 * а из пометки собирается список «что пора менять» — аппарат, сумма отвергнутого ремонта, дата.
 */
export const approveServiceItSchema = z
  .object({
    approved: z.boolean(),
    reason: reasonSchema.optional(),
    version: z.number().int().nonnegative(),
  })
  .refine((v) => v.approved || !!v.reason, {
    message: 'Укажите причину отказа',
    path: ['reason'],
  });
export type ApproveServiceItInput = z.infer<typeof approveServiceItSchema>;

export const reopenServiceEstimateSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});

/**
 * Закрытие работ. Итог **не принимается**: его считает сервер из строк, иначе сумма строк и итог
 * разошлись бы молча. Клиент присылает отметки факта по каждой строке и, если нужно, скидку акта.
 */
export const completeServiceRequestSchema = z.object({
  completedOn: dateOnlySchema,
  items: z
    .array(
      z.object({
        id: uuidSchema,
        performed: z.boolean(),
        /** Фактическое количество; больше согласованного не бывает — это удорожание. */
        actualQuantity: quantitySchema.nullish(),
        /** Дата гарантии из талона; пусто — сервер посчитает её от даты выполнения. */
        warrantyUntil: dateOnlySchema.nullish(),
      }),
    )
    .max(200),
  /**
   * Факт выдачи по строкам расходников — у заявки на расходники и только у неё (Р3). Приходит
   * закрытием, а не отдельной ручкой следом, потому что списание со склада идёт ТОЙ ЖЕ
   * транзакцией, что и переход в «Решена» (Р5): блокировка позиций, проверка остатков, события
   * журнала и смена статуса неразделимы — иначе заявка успевала бы стать решённой при неудавшемся
   * списании.
   *
   * Пустой список у заявки на расходники законен ровно в одном случае: факт уже проставлен правкой
   * (`PATCH /:id/consumables/issued`) и на закрытии не менялся. Умолчание строк — «сколько
   * просили» — подставляет форма, а не схема: сервер не должен списывать со склада по молчанию
   * клиента.
   *
   * `optional()` без `default([])` — тот же приём, что у строк заведения: окно закрытия ремонта
   * строит тело литералом и про расходники ничего не знает, а «поля нет» и «пустой список» здесь
   * означают одно и то же.
   */
  consumables: z.array(serviceConsumableIssueSchema).max(50).optional(),
  /** Скидка по акту: строго отрицательная сумма и обязательная причина — порознь не бывают. */
  adjustmentAmount: z.number().negative('Скидка — отрицательная сумма').nullish(),
  adjustmentReason: z.string().trim().max(500).optional().default(''),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type CompleteServiceRequestInput = z.infer<typeof completeServiceRequestSchema>;

export const acceptServiceRequestSchema = z.object({
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});

export const reworkServiceRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});

/**
 * Заморозка. Причина обязательна (Р107) — тем же `reasonSchema`, что у отмены и отказа: даты
 * «отложена до» у заморозки нет, и на вопрос «когда ждать» отвечает только она. Куда вернуть,
 * клиент не присылает: исходный статус сервер берёт из самой заявки (Р104).
 */
export const serviceHoldSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});
export type ServiceHoldInput = z.infer<typeof serviceHoldSchema>;

/** Возврат в работу: цель берётся из `held_from_status`, от человека нужно лишь слово вдогонку. */
export const serviceResumeSchema = z.object({
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type ServiceResumeInput = z.infer<typeof serviceResumeSchema>;

/** Отмена и административные откаты: причина — единственное содержание такого перехода. */
export const serviceStatusChangeSchema = z.object({
  status: serviceRequestStatusSchema,
  reason: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type ServiceStatusChangeInput = z.infer<typeof serviceStatusChangeSchema>;

export const serviceCommentSchema = z.object({
  serviceComment: z.string().trim().max(2000),
  version: z.number().int().nonnegative(),
});

// ── Файлы ──

export const SERVICE_FILE_KINDS = [
  'attachment',
  'estimate',
  'act',
  'invoice',
  'warranty_card',
] as const;
export const serviceFileKindSchema = z.enum(SERVICE_FILE_KINDS);
export type ServiceFileKind = (typeof SERVICE_FILE_KINDS)[number];

export const serviceFileKindLabels: Record<ServiceFileKind, string> = {
  attachment: 'Вложение',
  estimate: 'Смета',
  act: 'Акт',
  invoice: 'Счёт',
  warranty_card: 'Гарантийный талон',
};

/**
 * Виды документов, которыми подтверждают работу. Их можно подшивать и после приёмки — «акт пришлю
 * завтра» иначе означало бы потерянную бумагу (Р16, Р29); удалять их после приёмки нельзя.
 */
export const SERVICE_CLOSING_DOCUMENT_KINDS: readonly ServiceFileKind[] = [
  'act',
  'invoice',
  'warranty_card',
];

export function isServiceClosingDocument(kind: ServiceFileKind): boolean {
  return SERVICE_CLOSING_DOCUMENT_KINDS.includes(kind);
}

/**
 * Планка приёмки (Р112): хватает **любого** закрывающего документа — акта, счёта или гарантийного
 * талона. Ответ булев, а не перечень недостающих видов: перечисление читалось бы как «нужны все
 * три», хотя запирает приёмку отсутствие всех сразу.
 *
 * Функция живёт в контрактах, потому что спрашивают её оба: сервер — отказом в приёмке, портал —
 * неактивной кнопкой. Разойдись они, кнопка вела бы в 422.
 */
export function hasServiceClosingDocument(request: Pick<ServiceRequestDto, 'files'>): boolean {
  return request.files.some((file) => isServiceClosingDocument(file.kind));
}

/**
 * Кому закрывающий документ обязателен (Н8). Одно место правила на весь модуль: до этой правки оно
 * было сформулировано трижды и по-разному, а спрашивают его четверо — переход в «Решена», отбор
 * пачки автозакрытия, портал неактивной кнопкой и текст отказа.
 *
 * Планка стоит **только внешнему сервису**: за его работу платят, и бумага — основание платежа
 * (В7). Свой сисадмин и замена картриджа закрываются без неё.
 *
 * Вид в условии не лишний, хотя заявка на расходники сервису сегодня не назначается: правило,
 * опирающееся на одного исполнителя, начнёт требовать акт в тот день, когда картриджи повезёт
 * подрядчик, — и никто не вспомнит, что это было не задумано. Условие обязано отказывать по той
 * причине, по которой его писали.
 *
 * Вход — пара «вид + исполнитель-контрагент», а не `ServiceRequestDto`: тот же вопрос задают по
 * строке БД (сервер — до того, как карточка собрана, и в отборе пачки) и по карточке (портал), и
 * общего типа у них нет.
 */
export function serviceRequestNeedsClosingDocument(request: {
  kind: ServiceRequestKind;
  /** Исполнитель-контрагент; `null` — заявку ведёт свой сотрудник, и платить по ней некому. */
  serviceCounterpartyId: string | null;
}): boolean {
  return request.kind === 'repair' && request.serviceCounterpartyId !== null;
}

export const attachServiceFilesSchema = z.object({
  fileIds: z.array(uuidSchema).min(1).max(20),
  kind: serviceFileKindSchema.optional().default('attachment'),
});

// ── DTO ──

export interface ServiceRequestEquipmentDto {
  id: string;
  /** Реквизиты — снимок на момент заведения: карточку могли переименовать и перезакрепить. */
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  typeName: string;
  /** Место внутри объекта на момент заведения: «Корпус 3, каб. 214». Тот же снимок (Р57). */
  location: string;
}

export interface ServiceRequestObjectDto {
  id: string;
  code: string;
  name: string;
}

export interface ServiceRequestDepartmentDto {
  id: string;
  code: string;
  name: string;
}

export interface ServiceRequestCounterpartyDto {
  id: string;
  name: string;
}

/**
 * Подразделение заявителя (Н11): откуда человек, заведший заявку. Ссылка **и** снимок названия —
 * отдел переименуют, и прошлогодняя заявка обязана показать имя того времени, а не сегодняшнее.
 *
 * Одним полем, а не парой «отдел / площадка»: заполнена всегда ровно одна из двух связей (CHECK в
 * БД), и две ветки в карточке означали бы состояние «и то и другое», которого не бывает. `null` —
 * привязок у учётки нет вовсе (администратор портала) либо заявка заведена до выпуска 1.
 */
export interface ServiceRequestRequesterPlaceDto {
  kind: 'department' | 'object';
  id: string;
  /** Снимок названия на момент заведения. */
  name: string;
}

/**
 * Поимённый исполнитель заявки (Н5). Сотрудники сервисной компании сюда не попадают: назначается
 * контрагент целиком, и кто из инженеров поедет, портал не знает (`service` в карточке).
 */
export interface ServiceRequestExecutorDto {
  userId: string;
  name: string;
  assignedAt: string;
}

export interface ServiceRequestItemDto {
  id: string;
  kind: ServiceItemKind;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** Факт: `null` — работы ещё не закрывали, и у строки нет ни выполнения, ни суммы факта. */
  performed: boolean | null;
  actualQuantity: number | null;
  actualAmount: number | null;
  warrantyMonths: number | null;
  warrantyUntil: string | null;
  warrantyUntilManual: boolean;
}

/**
 * Строка заявки на расходники (Н9): позиция справочника, сколько просили, сколько выдали и почему
 * разошлось.
 *
 * Реквизиты позиции — снимком поля не являются, в отличие от реквизитов техники: строка ссылается на
 * живую карточку справочника (`ON DELETE RESTRICT`), и переименование позиции обязано читаться в
 * заявке новым именем. Склад — не история заявки, а действующий перечень, и «Тонер Ricoh 201»,
 * переименованный вчера в «Тонер Ricoh 201 (шт)», — это та же полка.
 *
 * ПОЛЕ `consumables` В `ServiceRequestDto` ЗАВЕДЕНО ВОЛНОЙ МАРШРУТА, а не вместе с этим типом, —
 * ровно по той причине, по которой `kind` ждал своей волны (§7.3 плана): обязательное поле DTO
 * уронило бы компиляцию API и портала раньше, чем сервер научился бы его отдавать. Тип был объявлен
 * заранее, чтобы волне маршрута осталось дописать одну строку, а не придумывать состав.
 */
export interface ServiceRequestConsumableDto {
  /** Идентификатор СТРОКИ заявки: им адресуется правка факта и на него ссылается журнал склада. */
  id: string;
  consumableId: string;
  /** Код номенклатуры учётной системы: по нему сверяют со счётом. */
  code: string;
  name: string;
  /** Цвет позиции или `null` у чёрно-белой (Р5): у цветной серии по позиции на цвет. */
  color: string | null;
  requestedQuantity: number;
  /**
   * Сколько выдали. `null` — работу ещё не закрывали, и факта у строки нет вовсе; `0` — закрыли, но
   * не выдали («съездили, тонер оказался цел», В9б). Это разные состояния, и показывать их одинаково
   * нельзя: первое ждёт исполнителя, второе — законченная работа.
   */
  issuedQuantity: number | null;
  /** Причина расхождения; пусто у совпавшего факта и у незаполненного (`serviceConsumableIssueIssue`). */
  issueNote: string;
}

export interface ServiceRequestFileDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  kind: ServiceFileKind;
  attachedAt: string;
}

/**
 * Виза отдела ИТ: кто и когда решил, что внешний ремонт нужен (Р51). Имя — снимком, как у
 * согласования сметы: подпись должна читаться и после того, как учётку закрыли.
 */
export interface ServiceRequestItApprovalDto {
  by: string | null;
  byName: string;
  at: string;
  /** Виза проставлена самим заведением: заявку завёл обладатель права (Р52). */
  auto: boolean;
}

export interface ServiceRequestApprovalDto {
  by: string | null;
  byName: string;
  at: string;
  /** Какая именно ревизия согласована: по ней сервер и пускает работы к закрытию. */
  revision: number;
}

export interface ServiceRequestCompletionDto {
  completedAt: string;
  /** Итог по акту: сумма выполненных строк плюс скидка. Считает сервер. */
  totalAmount: number | null;
  adjustmentAmount: number | null;
  adjustmentReason: string;
}

export interface ServiceRequestWarrantyClaimDto {
  source: WarrantyClaimSource;
  /** Позиция прошлого ремонта — только у источника `item`. */
  itemId: string | null;
  itemName: string;
  /** Номер заявки, по гарантии которой обращаются: спор ведут именно по нему. */
  sourceRequestNum: number | null;
}

export interface ServiceRequestDto {
  id: string;
  num: number;
  displayNumber: string;
  /**
   * Вид заявки (Н1). Поле заводится волной В3 вместе с маршрутом, а не контрактами В1: обязательное
   * поле DTO уронило бы компиляцию API и портала раньше, чем сервер научился бы его отдавать.
   * Без него портал не может позвать `serviceRequestNeedsClosingDocument` — предикат требует пару
   * «вид + исполнитель-контрагент».
   */
  kind: ServiceRequestKind;
  status: ServiceRequestStatus;
  statusChangedAt: string;
  waitingOn: ServiceWaitingOn;
  /**
   * Заморозка: куда заявка вернётся и почему её остановили (Р104, Р107). Поля ходят парой — при
   * `on_hold` они непусты, в остальных статусах пусты оба (CHECK в БД). По `heldFromStatus`
   * считается и эффективный статус: виды файлов отложенной «Диагностики» — те же, что у неё
   * (Р110).
   */
  heldFromStatus: ServiceRequestStatus | null;
  holdReason: string;
  equipment: ServiceRequestEquipmentDto;
  object: ServiceRequestObjectDto;
  /** Отдел-заказчик и отдел-владелец: по ним считается область роли отдела. */
  customerDepartment: ServiceRequestDepartmentDto | null;
  equipmentDepartment: ServiceRequestDepartmentDto | null;
  /** Откуда сам заявитель (Н11). Областью видимости не является — это реквизит карточки. */
  requesterPlace: ServiceRequestRequesterPlaceDto | null;
  description: string;
  /** Заявитель: кто обратился и по какому номеру с ним связываться (Р49). */
  responsibleName: string;
  responsiblePhone: string;
  /** Срочность и её объяснение: без второго первое не показывается — их и не бывает порознь. */
  isUrgent: boolean;
  urgencyReason: string;
  service: ServiceRequestCounterpartyDto | null;
  /**
   * Поимённые исполнители (Н5) — второй слой рядом с `service`. Пустой список при непустом
   * контрагенте — обычное дело: сервисная компания назначается целиком.
   */
  executors: ServiceRequestExecutorDto[];
  /** Виза ИТ; `null` — заявка ещё ждёт решения отдела (Р51). */
  itApproval: ServiceRequestItApprovalDto | null;
  warrantyClaim: ServiceRequestWarrantyClaimDto | null;
  /** Смета: текущая ревизия и её строки. */
  estimateRevision: number;
  estimateSubmittedAt: string | null;
  estimatedTotalAmount: number | null;
  approval: ServiceRequestApprovalDto | null;
  items: ServiceRequestItemDto[];
  /**
   * Строки заявки на расходники (Н9). У ремонта список пуст всегда — предмет заявки там смета, и
   * двух списков предмета у одной заявки не бывает.
   *
   * Поле заведено волной маршрута, а не контрактами В1, и по той же причине, что `kind`:
   * обязательное поле DTO уронило бы компиляцию API и портала раньше, чем сервер научился бы его
   * отдавать. Тип `ServiceRequestConsumableDto` объявлен заранее — волне маршрута оставалось
   * дописать одну строку.
   */
  consumables: ServiceRequestConsumableDto[];
  completion: ServiceRequestCompletionDto | null;
  acceptedByName: string;
  acceptedAt: string | null;
  /**
   * Кто закрыл заявку (Н7): `human` — человек, `auto` — портал по истечении суток молчания.
   *
   * `null` читается **как `human`**, а не как ошибку, и это не мягкость: заявка, принятая старым
   * кодом между накатом M2 и перезапуском, живёт с датой приёмки и пустым источником до M9 — то
   * есть неделю (план §5, M2). У непринятой заявки поле пусто всегда.
   */
  acceptanceSource: 'human' | 'auto' | null;
  /**
   * «Ремонт нецелесообразен, аппарат под замену» (Н3, В21) — второй исход визы ИТ. Стоит только у
   * отменённой заявки: пометка объясняет, почему её закрыли без ремонта, и возврат в «Новую» её
   * снимает (`serviceResetOnTransition`).
   */
  replacementRecommended: boolean;
  comment: string;
  serviceComment: string;
  /**
   * Обсуждение заявки (ADR 0141): всё, что порталу нужно знать о переписке, не открывая её.
   *
   * Обязательное поле, а не `?`, и приезжает оно тем же этапом, что и серверный счёт. Необязательным
   * оно означало бы «переписки может не быть» — а её не бывает только у заявки, у которой ленту не
   * посчитали: ноль реплик — это `total: 0`, а не отсутствие блока. Портал по нему рисует кнопку со
   * счётчиком и обе метки строки, и `undefined` там читался бы как «непрочитанного нет».
   */
  chat: ServiceRequestChatSummaryDto;
  files: ServiceRequestFileDto[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}

/**
 * Ответ действия, которое сопровождается письмом службе (план
 * `office-equipment-mail-and-history-plan.md`, Р67): заявка плюс исход почтовой части.
 *
 * Отдельный тип, а не поле карточки: исход относится к **действию**, а не к заявке — в списке и
 * при повторном открытии его нет и быть не может. И он обязан дойти до человека сразу: «заявка
 * заведена, но служба не оповещена» узнаётся в момент заведения, а не когда за ней не приехали.
 */
export interface ServiceRequestWithMailDto {
  request: ServiceRequestDto;
  mail: ModuleMailOutcome;
}

/**
 * Повторная отправка письма службе (Р70). Ключ идемпотентности генерирует портал — один на открытие
 * диалога, а не на нажатие: два одновременных клика и повтор HTTP обязаны дать одно письмо.
 *
 * Порядкового номера попытки здесь нет намеренно: его пришлось бы считать чтением, а между чтением
 * и вставкой помещается второе нажатие.
 */
export const notifyServiceRequestSchema = z.object({ idempotencyKey: uuidSchema }).strict();
export type NotifyServiceRequestInput = z.infer<typeof notifyServiceRequestSchema>;

export interface ServiceRequestNotifyResultDto {
  mail: ModuleMailOutcome;
  /** Куда ушло письмо — адреса без секретов: по ним видно, что настройка та самая. */
  recipients: string[];
}

/**
 * Есть ли у статуса письмо, которое можно повторить. Одна функция на сервер и портал: разойдись
 * они — кнопка вела бы в 422 либо повтор оставался бы недоступным там, где сервер его позволяет.
 *
 * Событие письма привязано к **входу в статус**, поэтому повторяются ровно два: «Новая» (заявка
 * ждёт визы ИТ) и «Отменена» (чтобы не выезжали зря).
 */
export function serviceMailRepeatable(status: ServiceRequestStatus): boolean {
  return status === 'new' || status === 'cancelled';
}

/**
 * Правит ли субъект саму заявку: заказчик — пока её никому не отдали (§6.1). После назначения за
 * заявкой стоят договорённости с исполнителем, и менять её предмет задним числом нельзя.
 *
 * `it_approved` из списка ушёл вместе с самим статусом (`0197`): заявок в нём больше не бывает, и
 * ветка под него отвечала бы на вопрос, которого никто не задаёт.
 *
 * `on_hold` в список не входит (Р110): заморозка останавливает ход заявки, и правка её предмета
 * была бы ходом мимо остановки. Отложенную из «Новой» правят, вернув в работу.
 */
export function isServiceRequestEditable(status: ServiceRequestStatus): boolean {
  return status === 'new';
}

/**
 * Удаляет ли субъект заявку — в архив. Своё правило, а не «то же, что правка» (В20): удалять можно
 * и «Назначенную» — работа по ней не начиналась, исполнителя ей просто назначили, — а править её
 * уже нельзя: предмет заявки исполнитель прочитал и по нему договорился. Переиспользуй мы
 * `isServiceRequestEditable`, два разных решения заказчика держались бы на одном списке статусов и
 * разъехались бы на первой же правке любого из них.
 *
 * Дальше «Назначенной» удаление не идёт ни при каких условиях: с «В работе» по заявке уже могли
 * списать расходники (Р6), и архивная заявка означала бы списание без основания.
 */
export function isServiceRequestDeletable(status: ServiceRequestStatus): boolean {
  return status === 'new' || status === 'assigned';
}

/** Права модуля — одним списком: он нужен и матрице, и проверке «открыт ли раздел». */
export const SERVICE_REQUEST_PERMISSIONS: readonly Permission[] = [
  'serviceRequests.read',
  'serviceRequests.create',
  'serviceRequests.update',
  'serviceRequests.delete',
  'serviceRequests.assign',
  'serviceRequests.estimate',
  'serviceRequests.approveEstimate',
  'serviceRequests.approveIt',
  'serviceRequests.status',
  'serviceRequests.hold',
  'serviceRequests.urgency',
  'serviceRequests.execute',
  'serviceRequests.files',
];

/**
 * Подписи полей в истории заявки; ключи проставляет сервер при вычислении изменений
 * (`service-request-diff.ts`). Словарь один на правку заявки, правку сметы и закрытие: читателю
 * истории всё равно, какая ручка породила строку, — ему важно, что именно изменилось.
 */
export const serviceRequestChangeLabels: Record<string, string> = {
  description: 'Неисправность',
  // Поле убрано отовсюду (Р115), а подпись осталась (Р121): история строится из событий аудита, и
  // записи прошлых месяцев несут ключ `dueDate`. Без строки словаря `RequestHistory` показывает
  // `labels[field] ?? field` — то есть сырое имя поля в строке, которую читает человек.
  dueDate: 'Желаемый срок',
  customerDepartment: 'Отдел-заказчик',
  responsibleName: 'Заявитель',
  responsiblePhone: 'Телефон',
  isUrgent: 'Срочная',
  urgencyReason: 'Причина срочности',
  itApproval: 'Виза ИТ',
  comment: 'Комментарий',
  warrantyClaim: 'Обращение по гарантии',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Удалены файлы',
  estimateItemsAdded: 'Добавлено в смету',
  estimateItemsRemoved: 'Убрано из сметы',
  // Что предъявил исполнитель при закрытии: без этих двух строк «закрыли дешевле» осталось бы
  // необъяснённым, а гарантию на неустановленную деталь искали бы годом позже.
  itemsNotPerformed: 'Не выполнено',
  itemsPartial: 'Выполнено частично',
  /*
   * Движение склада по заявке на расходники (Р10). Две подписи, а не одна со знаком: «−2» в
   * истории читается как опечатка, а «Списано со склада» и «Возвращено на склад» — это два разных
   * события для того, кто разбирает, куда делись картриджи.
   *
   * Ключи проставляет не дифф, а сборка истории (`service-request-history.ts`): движения приезжают
   * в аудите своим полем `movements`, потому что складом двигает не правка полей заявки, а отметка
   * факта выдачи.
   */
  consumablesIssued: 'Списано со склада',
  consumablesReturned: 'Возвращено на склад',
  /** Состав номенклатуры до и после правки: спорят о том, что именно просили и в каком количестве. */
  consumables: 'Состав номенклатуры',
};

// ── Обсуждение заявки (office-equipment-chat-plan.md, ADR 0141) ──
//
// Лента реплик с пометкой «кому адресовано». Пометка, а не ограничение видимости (решение опроса
// 28.08.2026): текст видят все, кому видна заявка, — адресат управляет подсветкой и будущим
// письмом. Чат заменяет «Примечание исполнителя» (`serviceCommentSchema` выше), которое было одним
// полем на всю заявку и затиралось следующей записью.
//
// Правила живут здесь, а факты приходят аргументом (§3.2 плана), и это не украшение.
// `AccessSubject` не несёт ни id учётки, ни областей, ни назначения, а `ServiceRequestDto` не
// отдаёт `createdBy`, — значит общая функция «субъект + DTO → стороны» на портале неисполнима.
// Написав её всё-таки, мы получили бы второе правило, расходящееся с серверным МОЛЧА: подсветка
// показывала бы одно, а ручка отвечала бы другое. Поэтому портал этих функций не зовёт вовсе — ему
// приходит готовый `ServiceRequestChatSummaryDto`, посчитанный сервером ими же.

/**
 * Стороны разговора. `all` — не сторона человека, а адресат «всем участникам»: им можно адресовать,
 * но им нельзя БЫТЬ. Поэтому значение стоит в словаре (его пишут строкой в базу, его рисуют
 * ярлыком в ленте), а из `participantSidesOf` не возвращается никогда.
 */
export const SERVICE_CHAT_SIDES = ['all', 'customer', 'operator', 'it', 'service'] as const;
export const serviceChatSideSchema = z.enum(SERVICE_CHAT_SIDES);
export type ServiceChatSide = (typeof SERVICE_CHAT_SIDES)[number];

export const serviceChatSideLabels: Record<ServiceChatSide, string> = {
  all: 'Всем участникам',
  customer: 'Заявителю',
  // «Оргтехнике (ведение)», а не «Оператору»: оператором в портале зовут внешнего исполнителя
  // (роль `operator`, ADR 0038), и ярлык «Оператору» читался бы ровно наоборот — как реплика,
  // адресованная сервисной компании.
  operator: 'Оргтехнике (ведение)',
  it: 'Системному администратору',
  service: 'Сервисному центру',
};

/**
 * Откуда взялась реплика. `import` — перенесённое «Примечание исполнителя» (§3.9): у неё бывает
 * пустой автор и приблизительное время, и портал обязан подписать её иначе, чем написанную
 * человеком, — «перенесено из примечания исполнителя», без имени. Словарь закрыт `CHECK`'ом схемы,
 * а не соглашением: третье значение здесь означало бы реплику, о происхождении которой никто
 * ничего не знает.
 */
export const SERVICE_CHAT_ORIGINS = ['chat', 'import'] as const;
export type ServiceChatOrigin = (typeof SERVICE_CHAT_ORIGINS)[number];

/**
 * Что сервер знает о паре «этот человек ↔ эта заявка»: считается из принципала (id, роль, области,
 * коды наборов) и строк самой заявки — из того, чего в `AccessSubject` нет и не появится.
 *
 * Правовая половина субъекта сюда НЕ копируется булевыми полями, и это осознанно: права
 * спрашиваются у самого `AccessSubject`, который передаётся отдельным аргументом. Разложи мы `can`
 * по фактам — у матрицы прав завелось бы второе представление, и первый же новый набор полномочий
 * (ADR 0106) пришлось бы вписывать в оба, а разъехались бы они молча.
 */
export interface ServiceChatFacts {
  /** Id учётки читателя: с ним сравнивается поимённый адресат реплики. */
  userId: string;
  /** Он завёл эту заявку. */
  isAuthor: boolean;
  /**
   * Заявка видна ему со стороны заказчика — ролью отдела или площадки. Признак отдельный от
   * авторства намеренно (§3.1): адресат «Заявителю» бьёт по всей стороне заказчика, чтобы вопрос
   * не завис, пока автор в отпуске, — а вот участником разговора коллега по отделу не становится.
   */
  inCustomerScope: boolean;
  /** Он работает от контрагента, назначенного исполнителем ИМЕННО этой заявки, а не любого сервиса. */
  actsForAssignedService: boolean;
  /** Он назначен поимённо — строкой в `service_request_executors` этой заявки. */
  isNamedExecutor: boolean;
}

/**
 * Совпадает ли человек со стороной. Одна функция на оба вопроса — «я участник?» и «эта реплика мне?»
 * — потому что различие между ними ровно одно и оно параметром: у `customer` аудитория шире
 * участия (§3.1). Две отдельные копии формул `operator`, `it` и `service` разъехались бы на первой
 * же правке модели сторон, и разъехались бы незаметно: обе выглядели бы правдоподобно.
 *
 * `wideCustomer` — та самая разница. С ним считается аудитория адресата «Заявителю» (автор ∪ вся
 * сторона заказчика), без него — участие (только автор): заказчик решил обе вещи явно и
 * по-разному, «пишут стороны цикла и автор заявки».
 */
function matchesServiceChatSide(
  side: ServiceChatSide,
  subject: AccessSubject | null | undefined,
  facts: ServiceChatFacts,
  wideCustomer: boolean,
): boolean {
  switch (side) {
    // «Всем участникам» подходит каждому, кому заявка видна: это отказ от адресации, а не адресация
    // множеству, — сужать его до состава сторон значило бы прятать реплику от того, кому её и
    // писали «на всякий случай».
    case 'all':
      return true;
    case 'customer':
      return facts.isAuthor || (wideCustomer && facts.inCustomerScope);
    /*
     * Конъюнкция двух прав И явное исключение подрядчика — обе половины по делу.
     *
     * `serviceRequests.status` есть у типа контрагента `service`: оно открывает подрядчику ЕГО
     * половину цикла. Одного этого права хватило бы, чтобы сервисная компания стала «Ведением» и
     * увидела яркими реплики, адресованные администратору модуля. `assign` у подрядчика нет, у
     * «Ведения» и ИТ-службы есть; `status` у ИТ-службы нет намеренно (переработка заявок §7.2).
     * Конъюнкция даёт ровно «Ведение» и `admin`.
     *
     * Исключение по типу контрагента стоит вторым рубежом — на случай, если кому-то из подрядчиков
     * выдадут набор «Ведение» руками: тогда человек останется исполнителем, а не станет заказчиком
     * собственной работы.
     *
     * `admin` в `operator` попадает, и это тоже осознанно: администратор обладает всеми правами и
     * золотой бейдж «ждёт меня» получает по той же причине (`isWaitingOn` спрашивает `assign`).
     * Исключение здесь завело бы ВТОРОЕ правило про админа, расходящееся с первым.
     */
    case 'operator':
      return (
        can(subject, 'serviceRequests.status') &&
        can(subject, 'serviceRequests.assign') &&
        !actsForCounterparty(subject, 'service')
      );
    // Виза ИТ — единственное, чем ИТ-служба отличается от прочих держателей `assign`: право
    // `serviceRequests.approveIt` есть только у её набора и у админа.
    case 'it':
      return can(subject, 'serviceRequests.approveIt');
    // Дизъюнкция, а не одно условие: сторону исполнителя держат двое — назначенный контрагент
    // целиком и поимённо назначенный сотрудник (инхаус-ремонт ИТ-службы). Проверить это по субъекту
    // нельзя ни в одном из двух случаев: назначение — свойство заявки, а не учётки.
    case 'service':
      return facts.actsForAssignedService || facts.isNamedExecutor;
  }
}

/**
 * Мои стороны в этой заявке: «я участник разговора?». Отсюда берутся право писать, состав поля
 * «Кому» и блёклая точка непрочитанного.
 *
 * `all` в ответе не бывает: участником «всех» быть нельзя, и попади оно сюда — блёклая точка
 * загорелась бы у каждого, кому видна заявка, то есть ровно у тех, кто разговора не ведёт.
 *
 * Пустой список — наблюдатель: заявка ему видна, реплики он читает, но ни писать, ни быть
 * помеченным чужой перепиской не должен (§3.11 — граница названа до выката, а не после).
 */
export function participantSidesOf(
  subject: AccessSubject | null | undefined,
  facts: ServiceChatFacts,
): ServiceChatSide[] {
  return SERVICE_CHAT_SIDES.filter(
    (side) => side !== 'all' && matchesServiceChatSide(side, subject, facts, false),
  );
}

/** Адресат реплики: сторона ИЛИ учётка — ровно как `CHECK ((side IS NULL) <> (user_id IS NULL))`. */
export type ServiceChatAddressee =
  | { readonly side: ServiceChatSide; readonly userId?: null }
  | { readonly side?: null; readonly userId: string };

/**
 * Адресована ли реплика этому человеку — вопрос яркой метки, счёта в бейдже и будущего письма
 * (§3.12). Спрашивается у каждого, кому видна заявка, а не только у участников: коллега по отделу
 * получает яркую метку на реплику «Заявителю», не становясь при этом участником разговора.
 *
 * Поимённый адресат сравнивается с id учётки, а не выводится из прав: он и заведён затем, чтобы
 * написать ОДНОМУ из двух назначенных инженеров, — вывести такое из субъекта нечем.
 */
export function audienceMatches(
  addressee: ServiceChatAddressee,
  subject: AccessSubject | null | undefined,
  facts: ServiceChatFacts,
): boolean {
  if (addressee.side) return matchesServiceChatSide(addressee.side, subject, facts, true);
  return addressee.userId === facts.userId;
}

/**
 * Можно ли отправить реплику прямо сейчас: страж ручки и условие кнопки отправки.
 *
 * Два сомножителя, и второй — не «статус вообще», а именно закрытость: `isServiceRequestClosed`
 * тот же, что запрещает ход и правку. Своим списком статусов здесь было бы два ответа на вопрос
 * «заявка ещё жива», и «Отложенная» рано или поздно попала бы в один список и не попала в другой —
 * а она как раз тот случай, когда написать особенно нужно: она стоит и ждёт объяснения.
 */
export function canWriteChat(
  subject: AccessSubject | null | undefined,
  facts: ServiceChatFacts,
  status: ServiceRequestStatus,
): boolean {
  return participantSidesOf(subject, facts).length > 0 && !isServiceRequestClosed(status);
}

/**
 * Отправка реплики. Текст обязателен и ограничен теми же 2000 символами, что и снятое примечание
 * исполнителя: длиннее — это уже документ, и его подшивают вложением.
 *
 * Адресаты приходят двумя списками — сторонами и учётками, — потому что двумя списками они и
 * хранятся (§3.3): сторона это слово словаря, поимённый адресат — ссылка на учётку с проверкой «он
 * назначен на эту заявку». Склеенный список строк пришлось бы разбирать угадыванием «uuid это или
 * сторона», и первый же контрагент с именем-uuid оказался бы стороной.
 */
export const sendServiceChatMessageSchema = z
  .object({
    body: z.string().trim().min(1, 'Напишите текст сообщения').max(2000),
    addressees: z.object({
      sides: z.array(serviceChatSideSchema).max(SERVICE_CHAT_SIDES.length).default([]),
      /**
       * Верхняя граница — защита от тела с тысячей идентификаторов, а не учётное правило:
       * назначенных исполнителей у заявки единицы, и каждого из них сервер всё равно сверяет со
       * строками `service_request_executors` (§3.3).
       */
      users: z.array(uuidSchema).max(50).default([]),
    }),
  })
  .superRefine((value, ctx) => {
    const { sides, users } = value.addressees;
    // Реплика без адресата не бывает: у ленты нет «просто сообщений» — на пометке держатся и
    // подсветка, и состав получателей будущего письма. Умолчание портала — «Всем участникам».
    if (sides.length === 0 && users.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Выберите хотя бы одного адресата',
        path: ['addressees'],
      });
      return;
    }
    // «Всем» и «ещё вот этому» — противоречие: `all` уже включает любого, а при подсчёте яркости
    // такая пара давала бы двойной учёт одной реплики. Портал гасит остальные пункты при выборе
    // «Всем участникам», но верить в это нельзя — проверка серверная.
    if (sides.includes('all') && (sides.length > 1 || users.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '«Всем участникам» не сочетается с другими адресатами',
        path: ['addressees', 'sides'],
      });
    }
  });
export type SendServiceChatMessageInput = z.infer<typeof sendServiceChatMessageSchema>;

/**
 * Подтверждение прочтения: курсор, а не отметка времени (§3.4). Клиент присылает его ПОСЛЕ
 * успешного показа ленты, поэтому номер здесь — «докуда человек действительно дочитал», а не
 * «когда открыл окно».
 *
 * Верхней границы в схеме нет и быть не может: `throughSeq` сверяется с `lastSeq` самой заявки, а
 * его знает только сервер. Клиент, приславший миллион, гасил бы весь будущий разговор — ответ на
 * это 422, и он приходит от ручки (§3.4, п. 4). Ноль разрешён: это «не прочитано ничего».
 */
export const markServiceChatReadSchema = z.object({
  throughSeq: z.number().int().min(0),
});
export type MarkServiceChatReadInput = z.infer<typeof markServiceChatReadSchema>;

/**
 * Страница ленты. Курсорная, а не по номеру страницы: лента только растёт, и смещение съезжало бы
 * на каждую пришедшую реплику. `beforeSeq` — подгрузка вверх (история), `afterSeq` —
 * инкрементальный опрос открытого окна; без обоих отдаются последние `limit` реплик.
 *
 * Границы `seq` начинаются с единицы (`CHECK seq > 0`), поэтому `min(1)`: ноль здесь означал бы
 * не «с начала», а ошибку клиента, и молча принятый он вернул бы пустую страницу вместо истории.
 */
export const serviceChatPageQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().min(1).optional(),
  afterSeq: z.coerce.number().int().min(1).optional(),
  // Потолок — стоимость опроса: ленту спрашивает каждое открытое окно, и страница в тысячу реплик
  // умножалась бы на число клиентов. Умолчание — те же 50, что показывает окно при открытии.
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ServiceChatPageQuery = z.infer<typeof serviceChatPageQuerySchema>;

/**
 * Реплика в ленте. Автор пустой только у перенесённых (§3.9) — там его действительно не
 * восстановить; `authorName` при этом непустой всегда: имя показывает лента, а «—» вместо имени
 * решает портал, а не сервер.
 */
export interface ServiceChatMessageDto {
  id: string;
  /** Номер внутри заявки: им идёт пагинация, по нему же считается непрочитанное (§3.4). */
  seq: number;
  authorId: string | null;
  authorName: string;
  origin: ServiceChatOrigin;
  body: string;
  /** У перенесённых — приблизительное (§3.9), и портал обязан пометить это словами. */
  createdAt: string;
  addressees: {
    sides: ServiceChatSide[];
    /** Поимённые адресаты с именами: ярлык в ленте рисуется без второго запроса за учётками. */
    users: { id: string; fullName: string }[];
  };
}

/**
 * Страница ленты. `lastSeq` и `readThroughSeq` приходят вместе с содержимым, а не отдельной
 * ручкой: полосу «Новые» рисуют по ним же, и запрошенные порознь они разъехались бы ровно на те
 * реплики, что пришли между двумя запросами.
 */
export interface ServiceChatPageDto {
  items: ServiceChatMessageDto[];
  /** Есть ли что подгружать дальше в запрошенную сторону. */
  hasMore: boolean;
  lastSeq: number;
  readThroughSeq: number;
}

/**
 * Блок `chat` карточки и строки списка — всё, что порталу нужно знать о переписке, не открывая её.
 * Считает сервер функциями выше; портал правил сторон не воспроизводит (§3.2).
 */
export interface ServiceRequestChatSummaryDto {
  /** Писать сейчас: участник и заявка не закрыта (`canWriteChat`). */
  canWrite: boolean;
  participantSides: ServiceChatSide[];
  total: number;
  /** Адресованные мне непрочитанные — яркая метка со счётом; её видят все, кому видна заявка. */
  unreadMine: number;
  /**
   * Есть ли чужие непрочитанные — блёклая точка без счёта, и только участнику. Булево, а не число,
   * намеренно: точка не считает, а число потребовало бы честного `COUNT` там, где ответ «да» даёт
   * первое же совпадение.
   */
  unreadOthers: boolean;
  lastSeq: number;
  readThroughSeq: number;
}
