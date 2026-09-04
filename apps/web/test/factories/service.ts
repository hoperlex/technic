import {
  type AuthUser,
  type Role,
  type ServiceFileKind,
  type ServiceRequestDto,
  type ServiceRequestFileDto,
  serviceHasExecutors,
  serviceRequestWaitingOn,
} from '@technic/contracts';
import { authUser } from './auth';

/**
 * Сервисная компания фикстур: один и тот же контрагент у учётки подрядчика и у отданной ему заявки.
 *
 * Константа, а не два совпадающих литерала: портал сверяет назначение ИДЕНТИФИКАТОРОМ (Р8 аудита
 * исполнителей), и разойдись эти два места — учётка подрядчика перестала бы быть исполнителем на
 * собственной заявке, а тесты рассказывали бы про состояние, которого на сервере не бывает
 * (заявку чужого контрагента подрядчик не видит вовсе).
 */
export const SERVICE_COUNTERPARTY = { id: 'cp-1', name: 'КопиЛайт' };

/**
 * Заявка на обслуживание оргтехники (ADR 0085) для сценарных тестов.
 *
 * Фабрика общая на весь модуль намеренно: своя копия из сорока полей в каждом файле означает, что
 * очередная правка DTO чинится в четырёх местах, — так и вышло с уходом «Желаемого срока» и
 * приходом полей заморозки (Р115, Р104).
 *
 * `waitingOn` не задаётся руками, а считается тем же `serviceRequestWaitingOn`, которым отвечает
 * сервер: подпись состояния (`serviceStatusLine`) читает именно это поле, и фикстура «статус
 * „Диагностика“, ждут оператора» описывала бы заявку, которой в портале не бывает. Сценарию,
 * который проверяет расхождение, никто не мешает передать `waitingOn` явно.
 *
 * Считается он ПОСЛЕ применения overrides и по трём полям, а не по одному статусу (Р2): после
 * снятия «Назначенной» и «Сметы на согласовании» ответ на «кого ждут» держат состав исполнителей и
 * непогашенное предъявление. Прежний `serviceWaitingOn(status)` дал бы «Новой» с назначенным
 * исполнителем ответ нетронутой заявки — то есть фикстуру, которой на сервере не бывает, и весь
 * столбец состояния проверялся бы по ней вхолостую.
 */
export function serviceRequest(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  const status = overrides.status ?? 'new';
  const request: ServiceRequestDto = {
    id: 'sr-1',
    num: 14,
    displayNumber: 'СО-14',
    // Вид заявки (Н1): умолчание — ремонт, как и в базе. Заявки на расходники API не заводит до
    // выпуска 3, но фикстура обязана уметь их описать — предикат закрывающего документа читает
    // именно это поле.
    kind: 'repair',
    /*
     * Аудитория ответа (ADR 0160, решение 4): в каком объёме сервер собрал ЭТУ строку. Умолчание —
     * `finance`, то есть «карточка полная», и выбрано оно ради смысла существующих сценариев: до
     * разграничения все они описывали читателя, которому видно всё, и умолчание `requester` тихо
     * переписало бы половину проверок — исчезли бы вкладка объёма работ, столбец «Сумма» и плашка
     * закрывающего документа, а тесты остались бы зелёными, проверяя уже не то.
     *
     * Сценарий заявителя задаёт `audience: 'requester'` явно — тем он и читается как сценарий про
     * заявителя, а не про случайное умолчание фикстуры.
     */
    audience: 'finance',
    status,
    statusChangedAt: '2026-08-05T09:00:00.000Z',
    // Значение-заглушка: настоящее считается ниже, когда overrides уже применены.
    waitingOn: 'nobody',
    // Заморозка (Р104, Р107): поля ходят парой и в обычных статусах пусты оба — это и есть CHECK
    // базы, перенесённый в фикстуру.
    heldFromStatus: null,
    holdReason: '',
    equipment: {
      id: 'oe-1',
      name: 'Kyocera M3145',
      serialNumber: 'SN-1',
      inventoryNumber: '0012345',
      typeName: 'МФУ',
      location: 'Корпус 3, каб. 214',
    },
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    // Объект подставила карточка техники, и расхождения нет (Р16). Пара ходит вместе: заявленный
    // факт хранится, а расхождение сервер вычисляет соединением с карточкой — «спокойная» заявка
    // это `false` в обоих полях, и сценарий про плашку обязан поднимать оба, а не одно.
    objectOverridden: false,
    objectMismatch: false,
    customerDepartment: null,
    equipmentDepartment: null,
    // Подразделение заявителя (Н11): у учётки без отделов и площадок его нет вовсе — законное
    // состояние, а не пробел в фикстуре.
    requesterPlace: null,
    description: 'Не захватывает бумагу',
    responsibleName: 'Иванов И. И.',
    responsiblePhone: '9000000000',
    isUrgent: false,
    urgencyReason: '',
    service: null,
    // Поимённых исполнителей у «Новой» заявки нет: их назначают, а не заводят вместе с заявкой.
    executors: [],
    itApproval: null,
    warrantyClaim: null,
    estimateRevision: 0,
    // Висящего предъявления нет (Р2): `null` — «ответа ждать нечего». Именно это поле, а не статус,
    // делает заявку «ждущей подписи» после снятия `estimate_review` (Р1), поэтому умолчание тут
    // молчаливое: сценарий про согласование обязан назвать ревизию сам.
    estimatePendingRevision: null,
    estimateSubmittedAt: null,
    estimatedTotalAmount: null,
    approval: null,
    items: [],
    // Строки расходников: у ремонта их не бывает, и пустой список здесь — не пробел фикстуры, а
    // само правило («предмет заявки либо смета, либо номенклатура»).
    consumables: [],
    completion: null,
    acceptedByName: '',
    acceptedAt: null,
    // Источник приёмки пуст, пока заявку не приняли (Н7); у принятой пустой источник читается как
    // «человек» — таким его оставляет старый код в окне выката.
    acceptanceSource: null,
    replacementRecommended: false,
    // Решение при отказе (Р12): непустым оно бывает только у отменённой заявки — это `CHECK` базы,
    // и пустая строка здесь означает «отказа не было», а не незаполненную фикстуру.
    rejectionResolution: '',
    comment: '',
    serviceComment: '',
    // Обсуждение (ADR 0141): у заявки, по которой не сказано ни слова, блок не отсутствует — он
    // пуст. Сценарию про подсветку никто не мешает передать свои числа.
    chat: {
      canWrite: false,
      participantSides: [],
      total: 0,
      unreadMine: 0,
      unreadOthers: false,
      lastSeq: 0,
      readThroughSeq: 0,
    },
    files: [],
    createdByName: 'Штабов С. И.',
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T09:00:00.000Z',
    deletedAt: null,
    version: 3,
    ...overrides,
  };
  return {
    ...request,
    waitingOn:
      overrides.waitingOn ??
      serviceRequestWaitingOn({
        status,
        hasExecutors: serviceHasExecutors({
          serviceCounterpartyId: request.service?.id ?? null,
          executorCount: request.executors.length,
        }),
        estimatePendingRevision: request.estimatePendingRevision,
      }),
  };
}

/**
 * Заявка, за которую уже кто-то отвечает, — то, что до Р1 называлось статусом «Назначена».
 *
 * Статус у неё «Новая»: назначение перестало быть переходом, и «назначенность» держит СОСТАВ
 * исполнителей (Р2, Р5). Фикстура отдельная, потому что пара «`new` + непустые исполнители» —
 * основание доброго десятка сценариев (быстрая кнопка «Принять в работу», отказ, очередь «ждёт
 * исполнителя»), и написанная в каждом заново она разъехалась бы на первой же правке.
 */
export function assignedServiceRequest(
  overrides: Partial<ServiceRequestDto> = {},
): ServiceRequestDto {
  return serviceRequest({
    status: 'new',
    executors: [
      { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
    ],
    /*
     * Назначены оба слоя сразу (Н5): компания строкой и свой сотрудник поимённо. Компания здесь не
     * для полноты картины — без неё фикстура описывала бы заявку, которой подрядчик НЕ ВИДИТ:
     * портал сверяет назначение идентификатором контрагента (Р8), и сценарии исполнителя на
     * нераспределённой заявке проверяли бы состояние, невозможное на сервере.
     */
    service: { ...SERVICE_COUNTERPARTY },
    ...overrides,
  });
}

/**
 * Заявка с висящим предъявлением объёма работ — то, что до Р1 называлось «Сметой на согласовании».
 *
 * Статус «В работе», а состояние держит `estimatePendingRevision` (Р2, Р8): предъявление ревизии
 * есть, ответа на неё нет. Ревизия и снимок предъявления идут вместе — предъявленной без даты
 * заявки не бывает.
 */
export function estimatePendingServiceRequest(
  overrides: Partial<ServiceRequestDto> = {},
): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    estimateRevision: 1,
    estimatePendingRevision: 1,
    estimateSubmittedAt: '2026-08-06T09:00:00.000Z',
    ...overrides,
  });
}

/**
 * Отложенная заявка: статус, исходный статус и причина — три факта, которые не бывают порознь.
 *
 * Умолчание исходного статуса — «В работе», а не «Диагностика»: последняя мёртвая с 0197, и
 * отложить оттуда нечего — заявок в этом статусе не бывает.
 */
export function heldServiceRequest(
  heldFrom: ServiceRequestDto['status'] = 'in_work',
  overrides: Partial<ServiceRequestDto> = {},
): ServiceRequestDto {
  return serviceRequest({
    status: 'on_hold',
    heldFromStatus: heldFrom,
    holdReason: 'ждём запчасть от поставщика',
    ...overrides,
  });
}

/** Подшитый документ: вид — единственное, чем они различаются для планки приёмки (Р112). */
export function serviceRequestFile(
  kind: ServiceFileKind = 'act',
  overrides: Partial<ServiceRequestFileDto> = {},
): ServiceRequestFileDto {
  return {
    id: `file-${kind}`,
    filename: `${kind}.pdf`,
    contentType: 'application/pdf',
    size: 1024,
    kind,
    attachedAt: '2026-08-06T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Оператор оргтехники: штаб своего объекта плюс надстройка — она и даёт решения по заявкам
 * (ADR 0086). Именно надстройка, а не роль: списком ролей эту сторону не описать.
 */
export function serviceOperator(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    role: 'shtab' as Role,
    constructionObjectIds: ['obj-1'],
    addons: ['office_equipment_operator'],
    ...overrides,
  });
}

/** Исполнитель: роль «оператор» плюс контрагент типа `service` — второго коридора без него нет. */
export function serviceExecutor(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    role: 'operator' as Role,
    counterpartyType: 'service',
    // Тип отвечает «в каком модуле», идентификатор — «чья это заявка»: без второго учётка
    // подрядчика не исполнитель ни на одной строке.
    counterpartyId: SERVICE_COUNTERPARTY.id,
    ...overrides,
  });
}

/**
 * Свой сисадмин ИТ-службы: та же надстройка `office_equipment_it_approver`, но описывает она уже
 * не согласующего — виза упразднена целиком вместе с ручкой `it-approval` (Р10), и подпись под
 * объёмом работ теперь одна. Право `serviceRequests.approveIt` в наборе осталось (его снятие —
 * отдельная уборка) и ходов не даёт ни одного.
 *
 * Фикстура нужна ровно для ОДНОГО: показать, что ходы исполнителя открывает **поимённое
 * назначение**, а не право. `execute` у надстройки есть всегда, и заявка без его строки в
 * исполнителях обязана оставлять его ни с чем — у оператора контрагента-сервиса эта разница не
 * видна, портал считает его назначенным по типу контрагента.
 */
export function serviceInHouseExecutor(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    id: 'user-9',
    role: 'shtab' as Role,
    constructionObjectIds: ['obj-1'],
    addons: ['office_equipment_it_approver'],
    ...overrides,
  });
}

/** Заказчик: тот же штаб, но без надстройки — заявки заводит, решений по ним не принимает. */
export function serviceCustomer(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({ role: 'shtab' as Role, constructionObjectIds: ['obj-1'], ...overrides });
}
