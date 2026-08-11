import {
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  OPERATOR_STATUS_TRANSITIONS,
  requestStatusRollbacks,
  requestStatusTransitions,
  roleLabels,
  ROLES,
  VEHICLE_REQUEST_TYPES,
  type RequestStatus,
  type Role,
  type VehicleRequestType,
} from './enums';
import {
  COUNTERPARTY_TYPES,
  counterpartyTypeLabels,
  type CounterpartyType,
} from './counterparties';
import {
  canAttachAddon,
  ROLE_ADDON_BASE_ROLES,
  ROLE_ADDONS,
  roleAddonLabels,
  type RoleAddon,
} from './role-addons';

/**
 * Единая модель прав портала (ADR 0021, дополнена ADR 0038).
 *
 * Право — это «что учётка может делать», область видимости («над какими строками») задаётся
 * отдельно: штаб работает со своим объектом, внешний исполнитель — с заявками своего
 * контрагента. Смешивать их в одном списке нельзя: право проверяется до запроса в БД
 * (preHandler), а область — по конкретной строке, и ошибка тут даёт либо 403 на своей же
 * заявке, либо доступ к чужой.
 *
 * Права выдаются не роли, а **субъекту доступа** — паре «роль + тип контрагента учётки»
 * (ADR 0038). У всех ролей, кроме внешнего исполнителя, контрагента нет и субъект совпадает с
 * ролью; у исполнителя тип контрагента решает, в каком модуле он работает: оператор вывоза
 * ведёт заявки вывоза, арендодатель ТС — заявки на технику. Роль отвечает «кем человек работает
 * в портале», тип контрагента — «по какому предмету»; вторая роль-близнец на каждый модуль
 * дублировала бы первое ради второго.
 *
 * Матрица живёт в общем пакете, потому что источник правды должен быть один: API проверяет
 * права на каждом маршруте, портал по той же матрице решает, показывать ли пункт меню и
 * кнопку. Разъехавшиеся списки ролей — это либо кнопка, ведущая в 403, либо действие,
 * которое видно, но запрещено на сервере (или, что хуже, наоборот).
 */
export const PERMISSIONS = [
  // Справочники — единый модуль: доступ выдаётся на весь раздел, а не на отдельную вкладку.
  // Чтение нужно всем ролям: без него не заполнить форму заявки (объект, тип ТС, тип контейнера).
  'directories.read',
  'directories.write',
  /**
   * Обмен справочником файлом Excel (ADR 0073). Отдельно от `directories.write`, потому что это
   * не заведение записи, а действие над справочником целиком: выгрузка уносит из портала все его
   * строки разом (у водителей — с ФИО и СНИЛС), загрузка меняет сотни строк одним нажатием.
   *
   * Права два, а не одно: риск у них разный, и разведёнными их можно раздать по отдельности —
   * выгрузку когда-нибудь откроют тому, кто ведёт справочник, а загрузку не откроют никому,
   * кроме администратора. Одно право такой возможности не оставило бы.
   */
  'directories.export',
  'directories.import',

  // Вывоз мусора
  'wasteRequests.read',
  'wasteRequests.create',
  'wasteRequests.update',
  'wasteRequests.delete',
  'wasteRequests.status',
  'wasteRequests.assignOperator',
  /**
   * Примечание исполнителя в заявке (ADR 0053): вторая сторона комментария. Своё право, а не
   * часть `wasteRequests.update`: исполнитель заявку не редактирует (ADR 0038), а сказать
   * площадке «будем после 15:00» должен.
   */
  'wasteRequests.operatorComment',

  // Заказ ТС
  'vehicleRequests.read',
  'vehicleRequests.create',
  'vehicleRequests.update',
  'vehicleRequests.delete',
  'vehicleRequests.status',
  /** Виза руководителя строительства: без неё заявку не берут в работу (ADR 0025). */
  'vehicleRequests.approve',

  /**
   * Недельная заявка на технику: документ-основание над заказами ТС — площадка недельным пакетом
   * решает, что остаётся, что уезжает и что нужно добавить, а виза руководителя строительства
   * этот пакет применяет (продлевает сроки и порождает заказы).
   *
   * Права свои, а не `vehicleRequests.*`, и причина не в аккуратности, а в области видимости.
   * `vehicleRequests.read` есть у наблюдателя, у оператора вывоза и у арендодателя через тип
   * контрагента, а `vehicleRequestVisibilityWhere` для ролей без объектной и отдельской оси
   * возвращает «ограничений нет». Переиспользуй мы его — наблюдатель, задуманный как «только
   * просмотр», получил бы полный список недельных планов всех площадок, а арендодатель — чужие
   * планы работ. Своя группа даёт свой предикат области, у которого последняя ветка не «видит
   * всё», а «не видит ничего».
   *
   * Виза отдельным правом по той же причине, что у заявок ТС: согласование — решение заказчика со
   * стороны объекта, а не того, кто заявку обрабатывает. Здесь оно к тому же необратимо
   * (применение идёт той же транзакцией), и раздавать его вместе с ведением состава нельзя.
   */
  'weeklyRequests.read',
  'weeklyRequests.create',
  'weeklyRequests.update',
  'weeklyRequests.approve',

  // Водители (ADR 0037). Отдельно от справочников: в карточке водителя лежат персональные
  // данные — СНИЛС, номер удостоверения, — и открывать их каждому, кому нужен список типов ТС,
  // нельзя. По той же причине права нет ни у наблюдателя, ни у объектных ролей.
  'drivers.read',
  'drivers.write',

  // Путевые листы (ADR 0037). Журнал учёта и аннулирование — своими правами: в листе те же
  // персональные данные, что в карточке водителя, а испорченный бланк списывает не всякий, кто
  // берёт заявки в работу. Выдача отдельного права не имеет: лист рождается переводом заявки в
  // работу, и разрешает его `vehicleRequests.status`.
  'waybills.read',
  'waybills.cancel',
  /**
   * Подшить к бланку скан: заполненный заказчиком оборот ЭСМ-2, отметки 4-П, акт. Своё право, а
   * не `waybills.read`: смотреть журнал может и тот, кто документы к нему не подшивает.
   */
  'waybills.files',
  /**
   * Выписать лист по рейсу без заявок — бланк с реквизитами машины, водителя и даты, но с пустым
   * заданием (ADR 0071). Своё право у одного этого случая: обычная выписка так и остаётся частью
   * работы по заявке, а пустой бланк расходует номер строгой отчётности ни на что — задание в нём
   * появится от руки, и портал уже не отвечает за то, что в нём напишут.
   */
  'waybills.issueBlank',

  /**
   * Заявки на обслуживание оргтехники (ADR 0085). Прав девять, и дробность у них не от
   * аккуратности, а от того, что заявку ведут три разные стороны.
   *
   * `assign` и `approveEstimate` — решения заказчика: кого позвать чинить и согласны ли мы на эти
   * деньги. `estimate` — работа исполнителя: собрать смету, предъявить её и закрыть работы.
   * `status` — движение по остальным дугам (приёмка, возврат на доработку, отмена); что именно
   * доступно, решает не матрица, а коридор субъекта, потому что одно и то же право у сервиса и у
   * оператора открывает разные переходы.
   *
   * `files` отдельно от `update` по той же причине, что `waybills.files`: исполнитель заявку не
   * редактирует, но акт и счёт подшивает — и подшивает даже после приёмки, когда правки закрыты.
   */
  'serviceRequests.read',
  'serviceRequests.create',
  'serviceRequests.update',
  'serviceRequests.delete',
  'serviceRequests.assign',
  'serviceRequests.estimate',
  'serviceRequests.approveEstimate',
  /**
   * Виза отдела ИТ: нужен ли внешний ремонт вообще (план модернизации, Р51). Отдельно от
   * `approveEstimate` — это разные решения и разные люди: ИТ отвечает «зовём ли сервис», оператор
   * — «согласны ли на эти деньги». Слитые в одно право, они превратили бы двухступенчатое
   * согласование в одну подпись.
   */
  'serviceRequests.approveIt',
  'serviceRequests.status',
  'serviceRequests.files',

  /**
   * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам.
   *
   * Своя пара прав, а не общие справочниковые. Чтение отдельно от `directories.read`, потому что то
   * есть у всех ролей — включая коменданта и исполнителя чужого модуля, — а карточка единицы
   * рассказывает и про её обслуживание. Ведение отдельно от `directories.write`, потому что то
   * открывает **весь** раздел (объекты, контрагенты, прайс, техника), а ответственному за
   * оргтехнику нужен один справочник: иначе он либо получит лишнее, либо не сможет завести только
   * что купленный принтер.
   */
  'officeEquipment.read',
  'officeEquipment.write',

  /**
   * Гараж (ADR 0076): срез дня — чем заняты собственная техника и водители на выбранную дату.
   *
   * Своё право, а не сумма прав тех списков, из которых срез собран. Причина та же, по которой
   * отдельно стоят `drivers.read` и `waybills.read`: в строке гаража видно, кто за рулём, и это те
   * же персональные данные, что в карточке водителя. Связка «`drivers.read` и `vehicleRequests.read`»
   * ответила бы на вопрос «есть ли из чего собрать», а не «положен ли человеку раздел» — и
   * закрыть гараж, оставив справочник водителей, стало бы нечем.
   *
   * Право одно и только на чтение: действий в разделе нет вовсе, заявки и рейсы ведут в своих
   * модулях со своими правами.
   */
  'garage.read',

  // Действия над удалёнными и закрытыми записями — общие для заявок и справочников
  /** Видеть удалённые записи (архив): списки с includeDeleted, карточка удалённой заявки. */
  'archive.read',
  'archive.restore',
  /** Вернуть закрытую («Выполнена»/«Отменена») заявку в предыдущий статус. */
  'requests.rollbackStatus',
  /** Удаление записи насовсем, минуя пометку «удалена»: восстановить её уже нечем. */
  'records.purge',

  // Файлы: удаление чужого файла, не привязанного к заявке (свой удаляет и автор загрузки).
  'files.manageAny',

  // Администрирование
  'users.manage',
  'audit.read',
  /**
   * Рассылки: расписания, история запусков и отладочная отправка письма себе или другому
   * администратору. Право своё, а не `users.manage`: рассылку настраивает тот, кто отвечает за
   * оповещения, и это не обязательно тот же человек, который выдаёт доступы. Пока оба права есть
   * только у администратора, но разъехаться им ничто не мешает.
   */
  'mailings.read',
  'mailings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const DIRECTORY_PERMISSIONS = ['directories.read', 'directories.write'] as const;

/**
 * Ведение водителей (ADR 0037). Идёт вместе со справочниками у тех, кто обрабатывает заявки:
 * водителя выбирают при переводе заявки в работу, и заводит его тот же человек, который
 * выписывает путевой лист.
 */
const DRIVER_PERMISSIONS = ['drivers.read', 'drivers.write'] as const;

/**
 * Журнал путевых листов ведут те же, кто выписывает листы и ведёт водителей (ADR 0037).
 *
 * Пустого бланка (`waybills.issueBlank`) здесь нет намеренно: на начальном этапе его выписывает
 * только администратор (ADR 0071). Лист без задания — расход номера строгой отчётности ни на что,
 * и пока не видно, как часто он нужен, право не раздаётся вместе с журналом.
 */
const WAYBILL_PERMISSIONS = ['waybills.read', 'waybills.cancel', 'waybills.files'] as const;

/**
 * Что делает с заявкой на обслуживание оргтехники её заказчик (ADR 0085): заводит, правит и
 * удаляет. Ход заявки — назначение сервиса, согласование сметы, приёмка — сюда не входит: это
 * работа ответственного за оргтехнику, и приходит она надстройкой роли (ADR 0086).
 */
const SERVICE_REQUEST_CUSTOMER_PERMISSIONS = [
  'serviceRequests.read',
  'serviceRequests.create',
  'serviceRequests.update',
  'serviceRequests.delete',
  // Фотография поломки — половина заявки: без неё сервис едет смотреть, вместо того чтобы везти
  // запчасть. Поэтому вложения заказчик подшивает наравне с исполнителем.
  'serviceRequests.files',
] as const;

const WASTE_REQUEST_PERMISSIONS = [
  'wasteRequests.read',
  'wasteRequests.create',
  'wasteRequests.update',
  'wasteRequests.delete',
  'wasteRequests.status',
  'wasteRequests.assignOperator',
  // Примечание исполнителя пишет и тот, кто ведёт заявку: об «будем после 15:00» диспетчер чаще
  // узнаёт звонком, а не из портала, и записывает сам (ADR 0053).
  'wasteRequests.operatorComment',
] as const;

/**
 * Ведение заявок на технику. Визы (`vehicleRequests.approve`) здесь нет намеренно: согласование —
 * решение заказчика со стороны объекта, а не того, кто заявку обрабатывает (ADR 0025).
 */
const VEHICLE_REQUEST_PERMISSIONS = [
  'vehicleRequests.read',
  'vehicleRequests.create',
  'vehicleRequests.update',
  'vehicleRequests.delete',
  'vehicleRequests.status',
] as const;

/**
 * **Ведение** недельных заявок — набор тех, кто неделю собирает: чтение вместе с правкой состава.
 * Общим списком, а не построчно у каждой роли, потому что у всех пяти он совпадает буквально:
 * кто ведёт модуль, тот и правит состав — и это осознанно. Развести чтение и правку внутри этого
 * набора значило бы отрезать от черновика второго штабиста и руководителя строительства той же
 * площадки, а частичный `UNIQUE (object_id, week_start)` не дал бы им завести свою заявку:
 * получился бы тупик, из которого выходят через администратора.
 *
 * Одно только `weeklyRequests.read` при этом стоит **шире** набора и выдаётся поимённо: наблюдатель,
 * обе роли отдела и арендодатель неделю читают, но не ведут. Причина в том, что документ переехал
 * в общий список «Заказ автотехники» и объясняет продления заказов, которые эти субъекты и так
 * видят; область им считает предикат видимости, а не право (у отдела — площадка отдела, у
 * арендодателя — наличие его машины в составе).
 *
 * Визы (`weeklyRequests.approve`) здесь нет намеренно — как и у заявок ТС: её раздают поимённо.
 * Удаления нет вовсе: до применения заявка снимается отменой с причиной, после — она история,
 * которую не стирают (архива у недельной заявки тоже нет).
 */
const WEEKLY_REQUEST_PERMISSIONS = [
  'weeklyRequests.read',
  'weeklyRequests.create',
  'weeklyRequests.update',
] as const;

/**
 * Права ролей. Перечислены полностью и явно, без наследования «роль X = роль Y плюс N прав»:
 * при наследовании новое право у базовой роли расходится по производным незаметно, а здесь
 * каждое расширение доступа видно в диффе строкой.
 *
 * «Менеджер» и «Диспетчер» сейчас совпадают по правам: по решению заказчика диспетчер ведёт
 * справочники наравне с менеджером, а заявки они и раньше вели одинаково. Роли оставлены
 * раздельными — они различаются организационно, и расходятся при первом же новом праве.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Администратор — единственный, кто работает с архивом, откатами и учётками.
  admin: [...PERMISSIONS],

  manager: [
    ...DIRECTORY_PERMISSIONS,
    ...DRIVER_PERMISSIONS,
    ...WAYBILL_PERMISSIONS,
    ...WASTE_REQUEST_PERMISSIONS,
    ...VEHICLE_REQUEST_PERMISSIONS,
    // Недельные заявки менеджер и диспетчер заводят за площадку и правят состав: половина недель
    // собирается звонком на диспетчерскую, и оформлять их должен тот, кому позвонили. Визы у них
    // нет — она остаётся решением объекта.
    ...WEEKLY_REQUEST_PERMISSIONS,
    // Гараж (ADR 0076) идёт вместе с водителями и листами: день парка распределяет тот же
    // человек, который заводит рейсы и выписывает бланки.
    'garage.read',
    // Справочник оргтехники (ADR 0085) — та же работа со справочниками; модуль заявок по нему
    // менеджер не ведёт: ремонтом занимается ответственный за оргтехнику, а не диспетчер вывоза.
    'officeEquipment.read',
    'officeEquipment.write',
    'files.manageAny',
  ],

  dispatcher: [
    ...DIRECTORY_PERMISSIONS,
    ...DRIVER_PERMISSIONS,
    ...WAYBILL_PERMISSIONS,
    ...WASTE_REQUEST_PERMISSIONS,
    ...VEHICLE_REQUEST_PERMISSIONS,
    ...WEEKLY_REQUEST_PERMISSIONS,
    'garage.read',
    'officeEquipment.read',
    'officeEquipment.write',
    'files.manageAny',
  ],

  // Штаб — заказчик со стороны объекта: заявки заводит и правит (в пределах своего объекта),
  // но их ход — «в работе», «выполнена» — решают те, кто исполняет.
  shtab: [
    'directories.read',
    // Справочник оргтехники (ADR 0085) — только чтение: заявку заводят по конкретной единице, и
    // без карточек её не выбрать. Ведение справочника — у ответственного за оргтехнику.
    'officeEquipment.read',
    ...SERVICE_REQUEST_CUSTOMER_PERMISSIONS,
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    // Недельная заявка — рабочий инструмент штаба: он и решает каждую неделю, что из стоящей на
    // площадке техники остаётся. Продление, которое даёт применение, обходит запрет объектным
    // ролям править работающий заказ — и это осознанное исключение: продлевает не тот, кто просил,
    // а виза руководителя строительства.
    ...WEEKLY_REQUEST_PERMISSIONS,
  ],

  // Руководитель строительства (ADR 0025, 0031): вторая роль заказчика на объекте. Заявки обоих
  // модулей заводит и правит наравне со штабом — и вывоз мусора, и технику; ход заявок, как и у
  // штаба, решают те, кто их исполняет. Своё у него одно — виза: без неё заявку на технику не
  // берут в работу.
  rukstroy: [
    'directories.read',
    'officeEquipment.read',
    ...SERVICE_REQUEST_CUSTOMER_PERMISSIONS,
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    'vehicleRequests.approve',
    // Неделю руководитель строительства собирает наравне со штабом и визирует один: его подпись —
    // единственное согласование на весь пакет, и она же двигает сроки. Своя заявка применяется в
    // момент подачи (правилом автовизы объектной роли); администратор под него не подпадает —
    // право визы у него есть, но действует он не за объект (ADR 0032).
    ...WEEKLY_REQUEST_PERMISSIONS,
    'weeklyRequests.approve',
  ],

  // Комендант — третий заказчик на объекте, но только по мусору: контейнеры и вывоз на площадке
  // ведёт он, а техника заказывается через штаб и руководителя строительства. Устроен как штаб
  // без модуля «Заказ ТС» — так же ограничен своими объектами и так же не ведёт ход заявок.
  // Отдельная роль, а не «штаб, которому не показали вкладку»: модуль закрывается правом на
  // чтение, и иначе комендант видел бы чужой заказ техники по прямой ссылке.
  commandant: [
    'directories.read',
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
  ],

  // Отдел (ADR 0040) — заказчик со стороны офиса: заявки на технику заводит от отдела, а не от
  // площадки. Вывоз мусора у роли есть (ADR 0062), но заказчиком там всегда объект — значит
  // работает право только у отдела с площадкой, а у остального офиса раздел закрыт пустой
  // областью (`canUse`), а не отсутствием строки в матрице: право отвечает «что учётка делает»,
  // и состояние справочника в него не заводят.
  department: [
    'directories.read',
    'officeEquipment.read',
    ...SERVICE_REQUEST_CUSTOMER_PERMISSIONS,
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    // Только чтение недели, и только своей площадки (ADR 0062): отдел с площадкой работает на ней
    // наравне со штабом и должен понимать, чем она занята на неделе вперёд. Ведения и визы у него
    // нет — неделю собирает и подписывает площадка.
    'weeklyRequests.read',
  ],

  // Руководитель отдела (ADR 0040): та же пара «заказчик и визирующий», что «Штаб» и
  // «Руководитель строительства» на объекте. Отличается от сотрудника отдела ровно одним правом —
  // визой, — и совпадение остального закреплено тестом-сравнением, а не перечислением. По вывозу
  // мусора роли равны намеренно (ADR 0062): виза — право модуля «Заказ ТС», и на площадке штаб с
  // руководителем строительства по мусору тоже совпадают.
  //
  // Недельную заявку обе роли отдела **читают** — площадку своего отдела (ADR 0062), не более
  // того. Ведения и визы у них нет: неделя описывает занятость площадки, решает по ней штаб, а
  // виза руководителя строительства двигает сроки заказов объекта — это не «такое же
  // согласование, только от офиса». Отдел без площадки не видит ни одной недели: область пуста.
  department_head: [
    'directories.read',
    'officeEquipment.read',
    ...SERVICE_REQUEST_CUSTOMER_PERMISSIONS,
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    'vehicleRequests.approve',
    'weeklyRequests.read',
  ],

  // Внешний исполнитель (ADR 0010, ADR 0038) — единственная роль, чьи права роль задаёт не
  // целиком: модульные права приходят из типа его контрагента (COUNTERPARTY_TYPE_PERMISSIONS).
  // Здесь остаётся только общее для любого исполнителя: без чтения справочников не отрисовать
  // ни фильтр, ни название типа ТС в списке.
  operator: ['directories.read'],

  // Наблюдатель (ADR 0033) — сквозной просмотр обоих модулей без единого действия: заявки всех
  // объектов видны, но ни завести, ни изменить, ни продвинуть по статусу их нельзя. Объекта у
  // роли нет намеренно: она заводится ради общей картины по компании, а не работы на площадке.
  observer: [
    'directories.read',
    'officeEquipment.read',
    'wasteRequests.read',
    'vehicleRequests.read',
    // Третий модуль заявок — той же сквозной картиной по компании, без единого действия.
    'serviceRequests.read',
    // Недельная заявка живёт в общем списке «Заказ автотехники» и объясняет, откуда взялись
    // продления заказов, которые наблюдатель и так видит целиком. Одно право чтения, без набора
    // `WEEKLY_REQUEST_PERMISSIONS`: заводить и править неделю роль не может ничего.
    'weeklyRequests.read',
  ],
};

/**
 * Права, которые даёт тип контрагента учётки внешнего исполнителя (ADR 0038). Каждый тип —
 * один модуль портала, и основа набора в нём одна и та же: видеть свои заявки и закрывать
 * выполненное. Заводить, править и удалять заявки исполнитель не может ни в одном модуле —
 * заказчик и исполнитель разведены, и это граница модели, а не особенность вывоза мусора.
 * Примечание оператора (ADR 0053) её не двигает: оно не меняет ни предмет заявки, ни её ход —
 * это строка исполнителя в комментарии, и своё право у неё именно поэтому.
 *
 * Record по всем типам, а не по тем, у кого учётки есть: новый тип контрагента обязан здесь
 * появиться строкой и ответить на вопрос «а этот что исполняет». Пустой список — «учёток у
 * такого контрагента не бывает»: генподрядчик и подрядчик живут в справочнике как реквизиты
 * договора, работают в портале их сотрудники под собственными ролями.
 */
export const COUNTERPARTY_TYPE_PERMISSIONS: Record<CounterpartyType, readonly Permission[]> = {
  general_contractor: [],
  contractor: [],
  // Оператор вывоза (ADR 0010): видит заявки, назначенные его контрагенту, закрывает их и пишет
  // в них своё примечание (ADR 0053) — заявку это не редактирует, границу исполнителя не двигает.
  operator: ['wasteRequests.read', 'wasteRequests.status', 'wasteRequests.operatorComment'],
  // Арендодатель ТС (ADR 0038): видит заявки, на которые вышла его техника, и закрывает их.
  //
  // Недельная заявка открывается ему тем же и единственным фактором — наличием его машины в
  // составе; область считает предикат, а не это право. Заводить и визировать неделю он не может:
  // площадка решает за себя сама, а состав документа он видит только своими строками.
  vehicle_lessor: ['vehicleRequests.read', 'vehicleRequests.status', 'weeklyRequests.read'],
  // Поставщик (ADR 0051) — сторона договора поставки: в портале за него никто не работает, его
  // склады ведут изнутри. Пустой список, как у генподрядчика и подрядчика; появится у поставщика
  // свой модуль — он будет строкой здесь, а не новой ролью.
  supplier: [],
  // Сервисная компания (ADR 0085) — исполнитель заявок на обслуживание оргтехники: видит
  // назначенные ему заявки, ведёт смету, двигает свою часть цикла и подшивает акт со счётом.
  //
  // Справочника оргтехники у сервиса нет намеренно: «его» техника в справочнике ничем не отмечена,
  // и право означало бы доступ ко всему парку компании — реквизиты нужной единицы приходят
  // снимком в самой заявке. Заводить и править заявки он тоже не может: заказчик и исполнитель
  // разведены во всех трёх модулях, и это граница модели (ADR 0038).
  service: [
    'serviceRequests.read',
    'serviceRequests.estimate',
    'serviceRequests.status',
    'serviceRequests.files',
  ],
};

/**
 * Права, которые даёт надстройка роли (ADR 0086) — третья ось субъекта доступа.
 *
 * `Record` по всем надстройкам, как и у типов контрагента: новая надстройка обязана появиться
 * строкой и ответить на вопрос «что именно она добавляет». Пустой список означал бы надстройку,
 * которую можно выдать, ничего при этом не выдав, — такой в матрице быть не должно.
 *
 * У «Оператора (оргтехника)» здесь пока одно право: справочник оргтехники ведёт он, а не общий
 * держатель справочников (ADR 0085 §3). Права модуля заявок на обслуживание придут сюда вместе с
 * самим модулем — заранее выданное право открывало бы маршруты, которых ещё нет.
 */
export const ROLE_ADDON_PERMISSIONS: Record<RoleAddon, readonly Permission[]> = {
  office_equipment_operator: [
    // Справочник ведёт он, а не общий держатель справочников (ADR 0085 §3).
    'officeEquipment.write',
    // Решения по заявке: кого позвать, согласны ли на эти деньги, принята ли работа. Права сметы
    // здесь нет намеренно — смету пишет исполнитель, а оператор её согласует; выданные одному
    // субъекту, эти два права превратили бы согласование в подпись под собственной работой.
    'serviceRequests.assign',
    'serviceRequests.approveEstimate',
    'serviceRequests.status',
  ],
  /**
   * Согласование ИТ (Р51, Р54). Право ровно одно: чтение модуля и справочника приходит от базовой
   * роли — надстройка расширяет не набор действий, а **область** (`ADDON_MODULE_WIDE_SCOPE`).
   *
   * Права сметы здесь нет и быть не может (Р55): подтверждать необходимость работы, которую сам же
   * и продаёшь, — не согласование. По той же причине его нет у сервисной компании.
   */
  office_equipment_it_approver: ['serviceRequests.approveIt'],
};

/**
 * Типы контрагентов, к которым можно привязать учётку. Выводятся из матрицы, а не
 * перечисляются вторым списком: тип без прав — контрагент, за который в портале никто не
 * работает, и учётка на нём означала бы вход без единого действия.
 */
export const COUNTERPARTY_TYPES_WITH_ACCOUNTS = COUNTERPARTY_TYPES.filter(
  (type) => COUNTERPARTY_TYPE_PERMISSIONS[type].length > 0,
);

export function counterpartyTypeHasAccounts(
  type: CounterpartyType | null | undefined,
): type is CounterpartyType {
  return !!type && COUNTERPARTY_TYPE_PERMISSIONS[type].length > 0;
}

/**
 * Кому проверяется право: роль плюс тип контрагента учётки. Принимать сюда одну роль нельзя —
 * у внешнего исполнителя роль без контрагента отвечает только за общую часть прав, и вызов
 * `can(role, ...)` молча возвращал бы «нет» на его собственный модуль. Поэтому субъект —
 * объект: и принципал на сервере, и текущий пользователь на портале подходят под него как есть.
 */
export interface AccessSubject {
  role: Role | null;
  /** Тип контрагента учётки; у ролей вне `COUNTERPARTY_SCOPED_ROLES` не читается. */
  counterpartyType?: CounterpartyType | null;
  /**
   * Надстройки роли (ADR 0086): набор дополнительных прав поверх роли. Необязателен — учёток без
   * надстроек большинство, и требовать пустой массив от каждого вызова `can` значило бы менять
   * все места, где субъектом служит роль как есть.
   */
  addons?: readonly RoleAddon[] | null;
}

// Проверка прав идёт на каждом запросе, поэтому списки сразу разложены по множествам.
const ROLE_PERMISSION_SETS = new Map<Role, ReadonlySet<Permission>>(
  ROLES.map((role) => [role, new Set(ROLE_PERMISSIONS[role])]),
);

const COUNTERPARTY_PERMISSION_SETS = new Map<CounterpartyType, ReadonlySet<Permission>>(
  COUNTERPARTY_TYPES.map((type) => [type, new Set(COUNTERPARTY_TYPE_PERMISSIONS[type])]),
);

const ROLE_ADDON_PERMISSION_SETS = new Map<RoleAddon, ReadonlySet<Permission>>(
  ROLE_ADDONS.map((addon) => [addon, new Set(ROLE_ADDON_PERMISSIONS[addon])]),
);

/**
 * Есть ли у субъекта право. Учётка без роли не может ничего: доступ выдаётся ролью, и пока её
 * не назначили, пользователь для портала — никто (активировать такую учётку API не даёт).
 * Исполнитель без контрагента — то же самое в своём модуле: без контрагента неизвестно ни что
 * он исполняет, ни чьи заявки видит, поэтому модульных прав у него нет (активировать такую
 * учётку API тоже не даёт).
 */
export function can(subject: AccessSubject | null | undefined, permission: Permission): boolean {
  const role = subject?.role;
  if (!role) return false;
  if (ROLE_PERMISSION_SETS.get(role)?.has(permission)) return true;
  // Надстройки роли (ADR 0086) — третий источник прав, и спрашивается он до контрагента:
  // надстройка бывает у любой базовой роли, а тип контрагента читается только у исполнителя.
  // Несовместимую с ролью надстройку сюда не пропускает API учёток, но проверка стоит и здесь:
  // матрица обязана отвечать одинаково на любой субъект, откуда бы он ни пришёл.
  for (const addon of subject?.addons ?? []) {
    if (canAttachAddon(role, addon) && ROLE_ADDON_PERMISSION_SETS.get(addon)?.has(permission)) {
      return true;
    }
  }
  if (!isCounterpartyScopedRole(role)) return false;
  const type = subject?.counterpartyType;
  return !!type && (COUNTERPARTY_PERMISSION_SETS.get(type)?.has(permission) ?? false);
}

/**
 * Откуда у субъекта право: роль, тип контрагента или надстройка. Нужно витрине прав
 * (`docs/permissions-tab-plan.md`): «право есть» и «право пришло надстройкой, а не должностью» —
 * разные ответы, и при пересмотре ролей важен второй.
 *
 * Живёт рядом с `can` и повторяет его порядок источников намеренно: вторая копия этого порядка на
 * портале разъехалась бы с первой при первой же правке модели, и витрина начала бы объяснять
 * доступ неправильно — то есть ровно тогда, когда по ней принимают решение.
 */
export interface PermissionOrigin {
  kind: 'role' | 'addon' | 'counterparty';
  /** Надстройка, давшая право; заполнена только при `kind: 'addon'`. */
  addon?: RoleAddon;
}

export function permissionSource(
  subject: AccessSubject | null | undefined,
  permission: Permission,
): PermissionOrigin | null {
  const role = subject?.role;
  if (!role) return null;
  if (ROLE_PERMISSION_SETS.get(role)?.has(permission)) return { kind: 'role' };
  for (const addon of subject?.addons ?? []) {
    if (canAttachAddon(role, addon) && ROLE_ADDON_PERMISSION_SETS.get(addon)?.has(permission)) {
      return { kind: 'addon', addon };
    }
  }
  if (!isCounterpartyScopedRole(role)) return null;
  const type = subject?.counterpartyType;
  return type && COUNTERPARTY_PERMISSION_SETS.get(type)?.has(permission)
    ? { kind: 'counterparty' }
    : null;
}

/**
 * Субъект вместе с его областью — то, чем открывается раздел портала (`canUse`). Наборы
 * необязательны: под него подходят как есть и принципал на сервере, и текущий пользователь на
 * портале, а роль без области их и не читает.
 */
export interface ScopedSubject extends AccessSubject {
  /** Прямая привязка объектной роли (ADR 0039). */
  constructionObjectIds?: readonly string[];
  /** Производная привязка роли отдела (ADR 0062): объекты её отделов. */
  departmentObjectIds?: readonly string[];
}

/**
 * Объекты, в пределах которых субъект работает в модуле «Вывоз мусора» (ADR 0062): у объектной
 * роли — свои, у роли отдела — площадки её отделов. `null` означает «областью не ограничен» и
 * отличается от пустого набора, как «видит всё» отличается от «не видит ничего».
 *
 * Только этот модуль: в «Заказе ТС» у роли отдела заказчик — отдел, и объектной области у неё
 * там нет вовсе (ADR 0062 п. 3).
 */
export function wasteObjectScopeIds(
  subject: ScopedSubject | null | undefined,
): readonly string[] | null {
  const role = subject?.role;
  if (isObjectScopedRole(role)) return subject?.constructionObjectIds ?? [];
  if (isDepartmentScopedRole(role)) return subject?.departmentObjectIds ?? [];
  return null;
}

function hasWasteObjectScope(subject: ScopedSubject): boolean {
  const ids = wasteObjectScopeIds(subject);
  return ids === null || ids.length > 0;
}

/**
 * Права, применимость которых зависит от области (ADR 0062). Права, которого здесь нет, область
 * не сужает — тот же приём, что в `ROLE_VEHICLE_REQUEST_TYPES`: новое право открыто всем, у кого
 * оно есть, кроме тех, кому его сузили осознанно, строкой здесь.
 */
const MODULE_SCOPE = new Map<Permission, (subject: ScopedSubject) => boolean>(
  WASTE_REQUEST_PERMISSIONS.map((permission) => [permission, hasWasteObjectScope]),
);

/**
 * Открыт ли субъекту раздел: право **и** непустая область, в которой это право применимо
 * (ADR 0062). Отделу без площадки вывоз мусора закрыт именно так — право у роли есть, работать
 * им не над чем.
 *
 * Спрашивается там, где решается «показывать ли раздел»: пункт меню, маршрут портала, стартовая
 * страница. Действия внутри раздела спрашивают `can`: область по конкретной строке всё равно
 * проверяет сервер, а пустой она к этому моменту уже не бывает.
 */
export function canUse(subject: ScopedSubject | null | undefined, permission: Permission): boolean {
  if (!subject || !can(subject, permission)) return false;
  const hasScope = MODULE_SCOPE.get(permission);
  return !hasScope || hasScope(subject);
}

/**
 * Работает ли учётка от контрагента указанного типа (ADR 0038) — то есть исполняет ли она
 * заявки этого модуля. Предикат, а не сравнение с ролью: «оператор вывоза» — это роль
 * исполнителя плюс контрагент-оператор, и одна роль без типа означает уже не то же самое.
 */
export function actsForCounterparty(
  subject: AccessSubject | null | undefined,
  type: CounterpartyType,
): boolean {
  return isCounterpartyScopedRole(subject?.role) && subject?.counterpartyType === type;
}

/** Все права субъекта — для отладки и для страницы учёток. */
export function permissionsFor(subject: AccessSubject | null | undefined): readonly Permission[] {
  const role = subject?.role;
  if (!role) return [];
  return PERMISSIONS.filter((permission) => can(subject, permission));
}

/**
 * Все различимые субъекты доступа: роли без контрагента как есть, роль от контрагента —
 * по разу на каждый тип контрагента с учётками. Список нужен там, где перебирают «всех, кто
 * бывает в портале»: тесты матрицы, обратный поиск по праву.
 */
export const ACCESS_PROFILES: readonly AccessSubject[] = [
  ...ROLES.flatMap((role) =>
    isCounterpartyScopedRole(role)
      ? COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((counterpartyType) => ({ role, counterpartyType }))
      : [{ role }],
  ),
  // Надстройка (ADR 0086) даёт свой различимый субъект: «штаб» и «штаб с надстройкой» отвечают
  // на `can` по-разному, и тесты доступа обязаны перебирать оба. По разу на каждую пару
  // «базовая роль × надстройка» — сочетания надстроек друг с другом прав не меняют.
  ...ROLE_ADDONS.flatMap((addon) =>
    ROLE_ADDON_BASE_ROLES[addon].map((role) => ({ role, addons: [addon] as const })),
  ),
];

/** Субъекты, у которых есть указанное право (обратный поиск: подсказки интерфейса и тесты). */
export function profilesWith(permission: Permission): AccessSubject[] {
  return ACCESS_PROFILES.filter((subject) => can(subject, permission));
}

/** Человекочитаемое имя субъекта: у исполнителя оно называет предмет работы, а не роль. */
export function accessProfileLabel(subject: AccessSubject): string {
  if (subject.role && isCounterpartyScopedRole(subject.role) && subject.counterpartyType) {
    return `${roleLabels[subject.role]} — ${counterpartyTypeLabels[subject.counterpartyType]}`;
  }
  if (!subject.role) return 'Без роли';
  // Надстройки (ADR 0086) дописываются к роли, а не заменяют её: человек остаётся штабом своего
  // объекта, и в списке учёток это должно читаться именно так — «Штаб + Оператор (оргтехника)».
  const addons = (subject.addons ?? []).map((addon) => roleAddonLabels[addon]);
  return [roleLabels[subject.role], ...addons].join(' + ');
}

/**
 * Роли, которым в модуле «Заказ ТС» доступны не все типы заявки (ADR 0040). Отдел заказывает
 * только грузоперевозки: спецтехника выходит на площадку, а площадки у отдела нет.
 *
 * Таблица, а не право `vehicleRequests.freight` и не `if` по имени роли. Право отвечает «что
 * учётка делает», а здесь ограничение по признаку самой строки — это область; в матрице оно
 * завело бы колонку-исключение, которую пришлось бы читать при каждом новом типе заявки.
 * Отсутствие роли в таблице означает «доступны все типы» — так новый тип заявки открывается
 * всем, кроме тех, кому его закрыли осознанно, строкой здесь.
 */
const ROLE_VEHICLE_REQUEST_TYPES: Partial<Record<Role, readonly VehicleRequestType[]>> = {
  department: ['freight_transport'],
  department_head: ['freight_transport'],
};

/** Типы заявки на технику, доступные субъекту (пустой список невозможен: роли без модуля сюда не доходят). */
export function allowedVehicleRequestTypes(
  subject: AccessSubject | null | undefined,
): readonly VehicleRequestType[] {
  const own = subject?.role ? ROLE_VEHICLE_REQUEST_TYPES[subject.role] : undefined;
  return own ?? VEHICLE_REQUEST_TYPES;
}

export function canOrderVehicleRequestType(
  subject: AccessSubject | null | undefined,
  requestType: VehicleRequestType,
): boolean {
  return allowedVehicleRequestTypes(subject).includes(requestType);
}

/**
 * Роли с собственным коридором статусов: право «менять статус» у них есть, но не на весь
 * рабочий цикл. Таблица, а не исключение в коде: следующая такая роль добавляется строкой.
 */
const ROLE_STATUS_TRANSITIONS: Partial<Record<Role, Record<RequestStatus, RequestStatus[]>>> = {
  // Внешний исполнитель закрывает то, что сам выполнил; подтверждать и отменять — решения
  // заказчика (ADR 0010). Коридор один на оба модуля: закрытие выполненного — это одно и то же
  // действие, что у вывоза мусора, что у аренды техники, поэтому таблица по роли, а не по типу
  // контрагента.
  operator: OPERATOR_STATUS_TRANSITIONS,
};

/** Смена статуса хотя бы в одном модуле — общий предикат для правил перехода. */
function canChangeAnyStatus(subject: AccessSubject): boolean {
  return can(subject, 'wasteRequests.status') || can(subject, 'vehicleRequests.status');
}

/**
 * Статусы, доступные субъекту из текущего статуса (пустой список — смена статуса запрещена).
 * Живёт рядом с матрицей, а не с таблицами переходов: «кто может» — это право, а таблицы
 * переходов описывают только «что за чем идёт».
 */
export function allowedStatusTransitions(
  from: RequestStatus,
  subject: AccessSubject,
): RequestStatus[] {
  if (!canChangeAnyStatus(subject)) return [];
  const ownCorridor = subject.role ? ROLE_STATUS_TRANSITIONS[subject.role] : undefined;
  if (ownCorridor) return ownCorridor[from];
  return can(subject, 'requests.rollbackStatus')
    ? [...requestStatusTransitions[from], ...requestStatusRollbacks[from]]
    : requestStatusTransitions[from];
}

export function canTransitionStatus(
  from: RequestStatus,
  to: RequestStatus,
  subject: AccessSubject,
): boolean {
  return allowedStatusTransitions(from, subject).includes(to);
}
