import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  allowedServiceStatusTransitions,
  can,
  canApproveServiceEstimate,
  canAssignServiceExecutors,
  canDeclineServiceRequest,
  canStartServiceWork,
  canHoldService,
  canReopenServiceEstimate,
  canResumeService,
  canSubmitServiceEstimate,
  canTransitionServiceStatus,
  hasCurrentItApproval,
  isServiceExecutor,
  isWaitingOn,
  SERVICE_ADMIN_ROLLBACKS,
  SERVICE_ASSIGNER_TRANSITIONS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  serviceEstimatePending,
  serviceHasExecutors,
  serviceIsFirstAssignment,
  serviceRequestWaitingOn,
  serviceResetOnTransition,
  serviceResumeTarget,
  serviceStatusChangeRequiresReason,
  serviceStepLabelFor,
  serviceStepLabels,
  serviceWaitingOn,
  type AccessSubject,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestStatus,
  type ServiceTransitionReset,
  type ServiceWaitingOn,
  type ServiceWaitingRequest,
} from '@technic/contracts';

/**
 * Коридоры заявки на обслуживание оргтехники (ADR 0085, Р17; переделка цикла — план
 * `office-equipment-requests-rework-plan.md`, §6).
 *
 * Главный тест модуля: цикл ведут четыре стороны, право `serviceRequests.status` у двух из них одно
 * и то же, а доступные им дуги — разные. По общей таблице переходов «Ведение» смогло бы выполнить
 * шаги исполнителя — принять заявку в работу, предъявить смету, закрыть работы, — а подрядчик
 * принял бы собственную работу. Портал такие кнопки не рисует, но портал и не является защитой:
 * отказывает сервер, и проверяется здесь именно он — одна функция `allowedServiceStatusTransitions`
 * отвечает обоим.
 *
 * Второе, что проверяется здесь: ход исполнителя открывает **факт назначения**, а не право (§6,
 * п. 2). Признаки назначения приходят третьим доводом, и обе половины дизъюнкции проверяются
 * порознь.
 *
 * Наборы сравниваются отсортированными: коридор — это множество доступных дуг, а не
 * последовательность, и порядок в нём не значит ничего.
 */

/** Сервис: роль исполнителя плюс контрагент типа `service` — сторону задаёт тип, а не роль. */
const service: AccessSubject = { role: 'operator', counterpartyType: 'service' };

/**
 * Свой исполнитель: базовая роль заказчика плюс право `serviceRequests.execute` из набора
 * «Оргтехника: ИТ-служба». Ходов оператора у него нет и не появится — он именно исполнитель.
 */
const namedExecutor: AccessSubject = {
  role: 'shtab',
  grantPermissions: ['serviceRequests.execute'],
};

/** Оператор оргтехники: базовая роль плюс надстройка (ADR 0086). Их две, и ведут они одинаково. */
const shtabOperator: AccessSubject = { role: 'shtab', addons: ['office_equipment_operator'] };
const departmentOperator: AccessSubject = {
  role: 'department',
  addons: ['office_equipment_operator'],
};
const OPERATORS: AccessSubject[] = [shtabOperator, departmentOperator];

const admin: AccessSubject = { role: 'admin' };

/** Согласующий от ИТ (Р51): базовая роль плюс своя надстройка — она даёт визу и сквозную область. */
const shtabIt: AccessSubject = { role: 'shtab', addons: ['office_equipment_it_approver'] };
const departmentIt: AccessSubject = {
  role: 'department',
  addons: ['office_equipment_it_approver'],
};
const IT_APPROVERS: AccessSubject[] = [shtabIt, departmentIt];

/** Заказчик без надстройки — тот, кто заявку завёл: он её не двигает вовсе. */
const CUSTOMERS: AccessSubject[] = [
  { role: 'shtab' },
  { role: 'rukstroy' },
  { role: 'department' },
  { role: 'department_head' },
];

const observer: AccessSubject = { role: 'observer' };

/** Исполнитель чужого модуля: роль та же, что у сервиса, а коридор пустой — решает тип контрагента. */
const wasteOperator: AccessSubject = { role: 'operator', counterpartyType: 'operator' };

/** Заявка назначена компании субъекта: у сервиса поимённых строк не бывает (§4.2). */
const BY_COUNTERPARTY: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: true,
  isNamedExecutor: false,
};
/** Субъект назначен поимённо — своя строка в `service_request_executors` (Н5). */
const BY_NAME: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: true,
};
/** Заявка не назначена субъекту ни одним из двух способов. */
const NOT_ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: false,
};

/** Контрагент-исполнитель в строке заявки: им считается признак «исполнители есть» (Р2). */
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Мёртвые статусы: заявок в них не бывает, а подписи и цвета остались ИСТОРИИ (Р1). Двоих закрыл
 * `CHECK` выпуска 2 (`0197`) — виза на входе и «Диагностика», — ещё двоих `0224` вместе с упрощением
 * цикла: назначение и предъявление объёма работ перестали быть переходами, и «Назначена» со «Сметой
 * на согласовании» стали называться признаками строки, а не статусами.
 *
 * Перечень нужен целым списком, а не по одному в каждом случае: из мёртвого статуса не ходят и в
 * мёртвый статус не приходят — оба утверждения проверяются перебором, и новое снятое значение
 * обязано попасть сюда строкой.
 */
const DEAD_STATUSES: ServiceRequestStatus[] = [
  'it_approved',
  'assigned',
  'diagnostics',
  'estimate_review',
];

const from = (
  status: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
  assignment?: ServiceExecutorAssignment,
) => [...allowedServiceStatusTransitions(status, subject, assignment)].sort();

describe('коридор исполнителя: ход открывает назначение, а не право', () => {
  /**
   * Ходов у исполнителя осталось два (Р5–Р9): «принять в работу» из «Новой» и «закрыть работы» из
   * «В работе». Отказ, предъявление объёма работ и возврат его в правку переходами быть перестали —
   * они правят состав исполнителей и колонку предъявления, статуса не трогая, — и доступность
   * каждого спрашивает свой предикат Р11 (блок в конце файла), а не коридор.
   */
  it('принимает «Новую» в работу и закрывает работы — и больше ничего', () => {
    // Промежуточной «Назначенной» между заведением и работой больше нет (Р6): «принять в работу»
    // ведёт прямо из «Новой», и открывает его всё тот же факт назначения. У нераспределённой заявки
    // назначенных нет, и `isServiceExecutor` при любом праве ложен — см. случай ниже.
    expect(from('new', service, BY_COUNTERPARTY)).toEqual(['in_work']);
    // Предъявление объёма работ ушло из перечня вместе со статусом (Р8): оно поднимает ревизию и
    // ставит `estimate_pending_revision`, оставляя заявку в «В работе».
    expect(from('in_work', service, BY_COUNTERPARTY)).toEqual(['done']);
  });

  /**
   * Мёртвых статусов теперь четыре. Двоих запретил `CHECK` выпуска 2 (`0197`), ещё двоих — `0224`
   * вместе с упрощением цикла (Р1): назначение и предъявление объёма работ перестали быть
   * переходами, и заявок в «Назначена» и «Смете на согласовании» не бывает. Пустой список здесь не
   * пропуск, а утверждение «из этого статуса не ходят, потому что в нём не бывают».
   */
  it('из мёртвых статусов ходов нет ни у исполнителя, ни у кого-либо ещё', () => {
    for (const status of DEAD_STATUSES) {
      expect(from(status, service, BY_COUNTERPARTY), status).toEqual([]);
      expect(from(status, admin), status).toEqual([]);
      for (const operator of [...OPERATORS, ...IT_APPROVERS]) {
        expect(from(status, operator), `${accessProfileLabel(operator)}: ${status}`).toEqual([]);
      }
    }
  });

  it('в остальных статусах ход заявки не его: ждут не исполнителя', () => {
    // Объём работ согласует не он, приёмку делает «Ведение», а из терминальных статусов заявку не
    // двигает никто, кроме администратора. Отложенную он не двигает тоже: заморозку ставит и
    // снимает тот, кто ведёт заявку (Р105).
    for (const status of ['on_hold', 'done', 'accepted', 'cancelled'] as const) {
      expect(from(status, service, BY_COUNTERPARTY), status).toEqual([]);
    }
  });

  /**
   * Обе половины предиката хода — порознь (§7.1). У подрядчика назначена компания целиком, и права
   * ему не требуется; у своего сотрудника назначение работает в паре с `serviceRequests.execute`:
   * снятие набора у переведённого сисадмина закрывает ходы, не трогая историю назначений.
   */
  it('назначенный поимённо ходит теми же ручками, что подрядчик', () => {
    expect(from('new', namedExecutor, BY_NAME)).toEqual(['in_work']);
    expect(from('in_work', namedExecutor, BY_NAME)).toEqual(['done']);
    // Ходов оператора у него не появляется: он исполнитель, а не тот, кто заявку ведёт.
    expect(canTransitionServiceStatus('done', 'accepted', namedExecutor, BY_NAME)).toBe(false);
    expect(canTransitionServiceStatus('done', 'in_work', namedExecutor, BY_NAME)).toBe(false);
    expect(canTransitionServiceStatus('in_work', 'cancelled', namedExecutor, BY_NAME)).toBe(false);
    // Переназначение — тоже не его: единственная дуга распределения приходит правом `assign`.
    expect(canTransitionServiceStatus('in_work', 'new', namedExecutor, BY_NAME)).toBe(false);
  });

  it('без назначения ходов нет ни у подрядчика, ни у своего', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, service, NOT_ASSIGNED), status).toEqual([]);
      expect(from(status, namedExecutor, NOT_ASSIGNED), status).toEqual([]);
    }
  });

  /**
   * Половины не смешиваются. Поимённая строка у оператора подрядчика ходов не открывает — их
   * открывает назначение его компании; а учётка без `serviceRequests.execute`, оставшаяся в списке
   * назначенных, перестаёт ходить сразу после отзыва набора.
   */
  it('поимённая строка без права ходов не даёт, а право без строки — тем более', () => {
    expect(isServiceExecutor(namedExecutor, BY_NAME)).toBe(true);
    expect(isServiceExecutor({ role: 'shtab' }, BY_NAME)).toBe(false);
    expect(isServiceExecutor(namedExecutor, NOT_ASSIGNED)).toBe(false);
    expect(isServiceExecutor(service, BY_COUNTERPARTY)).toBe(true);
    expect(isServiceExecutor(service, BY_NAME)).toBe(false);
    // Тип контрагента решает и здесь: исполнитель чужого модуля «своей» заявки не ведёт.
    expect(isServiceExecutor(wasteOperator, BY_COUNTERPARTY)).toBe(false);
    expect(isServiceExecutor(null, BY_COUNTERPARTY)).toBe(false);
    expect(isServiceExecutor(undefined, BY_NAME)).toBe(false);
  });

  /**
   * Признаков не передали — зовущий ещё не переключён. Тогда сторона подрядчика считается по
   * сегодняшнему правилу: заявок чужого контрагента он не видит вовсе, и на вопрос «назначена ли
   * она моей компании» за него уже ответила область видимости. У своего сотрудника обратное: без
   * признаков он не исполнитель, и молчаливых ходов у него не появляется.
   */
  it('без признаков подрядчик ходит как сегодня, а поимённый исполнитель — нет', () => {
    expect(from('new', service)).toEqual(['in_work']);
    expect(from('in_work', service)).toEqual(['done']);
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, namedExecutor), status).toEqual([]);
    }
  });

  it('не принимает работу, не переназначает, не отменяет и не откатывает', () => {
    // Решения заказчика: приёмка и возврат на доработку.
    expect(canTransitionServiceStatus('done', 'accepted', service, BY_COUNTERPARTY)).toBe(false);
    expect(canTransitionServiceStatus('done', 'in_work', service, BY_COUNTERPARTY)).toBe(false);
    // Отмена — в том числе исход «не согласовано» по объёму работ (Р8): решает её тот, кто платит,
    // а не тот, кому платят. «Менять аппарат» стало исходом того же согласования, а не отказом
    // исполнителя от невыгодной работы.
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(
        canTransitionServiceStatus(status, 'cancelled', service, BY_COUNTERPARTY),
        status,
      ).toBe(false);
    }
    // Переназначение и административные откаты. Дуга `in_work → new` стоит в перечне одна за оба:
    // ходят по ней «Ведение» (переназначение) и администратор (откат «принял в работу»), и
    // исполнителю она закрыта в обоих смыслах.
    for (const [a, b] of [
      ['in_work', 'new'],
      ['done', 'in_work'],
      ['accepted', 'done'],
      ['cancelled', 'new'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(canTransitionServiceStatus(a, b, service, BY_COUNTERPARTY), `${a} → ${b}`).toBe(false);
    }
  });

  it('коридор задаёт тип контрагента, а не роль: исполнитель чужого модуля не двигает ничего', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, wasteOperator, BY_COUNTERPARTY), status).toEqual([]);
      expect(
        from(status, { role: 'operator', counterpartyType: 'vehicle_lessor' }, BY_COUNTERPARTY),
        status,
      ).toEqual([]);
      // Исполнитель без контрагента — то же самое: неизвестно, что он исполняет.
      expect(
        from(status, { role: 'operator', counterpartyType: null }, BY_COUNTERPARTY),
        status,
      ).toEqual([]);
    }
  });
});

/**
 * Распределение — своя таблица и своё право (`serviceRequests.assign`): назначают двое, «Ведение» и
 * ИТ-служба, а права хода у второй нет и быть не должно (§7.2). Слитые в одно, назначение
 * пришлось бы выдавать вместе с приёмкой работы и отменой.
 *
 * Дуга у таблицы осталась ровно одна (Р5): само назначение статуса не меняет — состав исполнителей
 * пишет `PUT /:id/executors`, а видно ли действие, отвечает предикат `canAssignServiceExecutors`
 * (блок предикатов Р11 в конце файла).
 */
describe('коридор распределения: кто делает заявку', () => {
  /**
   * Переназначение из «В работе» возвращает заявку в «Новую», и это единственная дуга: иначе новый
   * исполнитель унаследовал бы чужое «взялся» и никогда не нажал бы «Принять в работу» — заявка
   * стояла бы в «В работе» у человека, который её ещё не открывал.
   */
  it('переназначает из «В работе» в «Новую» — и это вся его таблица', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(canTransitionServiceStatus('in_work', 'new', operator), who).toBe(true);
    }
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(SERVICE_ASSIGNER_TRANSITIONS[status], status).toEqual(
        status === 'in_work' ? ['new'] : [],
      );
    }
  });

  it('без права назначения дуги нет ни у кого, включая заказчика и исполнителя', () => {
    for (const subject of [...CUSTOMERS, observer, service, namedExecutor]) {
      expect(
        canTransitionServiceStatus('in_work', 'new', subject, BY_COUNTERPARTY),
        accessProfileLabel(subject),
      ).toBe(false);
    }
  });
});

describe('коридор «Ведения»: решения заказчика и ни одного шага исполнителя', () => {
  it('принимает, возвращает на доработку, отменяет и откладывает', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      // Назначения в перечне больше нет (Р5): оно не переход. Переназначение есть, но приходит
      // правом распределения и ведёт в «Новую».
      expect(from('new', operator), who).toEqual(['cancelled', 'on_hold']);
      // Согласования объёма работ нет вовсе (Р8): «согласовано» статуса не меняет, а «не
      // согласовано» — та же отмена, которой отменяют по любому другому основанию. Различает исходы
      // тело ручки, а доступность действия — предикат `canApproveServiceEstimate`.
      expect(from('in_work', operator), who).toEqual(['cancelled', 'new', 'on_hold']);
      // Из «Решена» — приёмка, возврат на доработку и заморозка (Р106 ADR 0125).
      expect(from('done', operator), who).toEqual(['accepted', 'in_work', 'on_hold']);
      // Из самой заморозки обычная дуга одна — отмена: возврат ведёт в `held_from_status`, и
      // таблицей `Record<status, status[]>` он не выражается (Р104, своя ручка `/resume`).
      expect(from('on_hold', operator), who).toEqual(['cancelled']);
      // Терминальные статусы: вернуть заявку из них может только администратор.
      expect(from('accepted', operator), who).toEqual([]);
      expect(from('cancelled', operator), who).toEqual([]);
      for (const status of DEAD_STATUSES) {
        expect(from(status, operator), `${who}: ${status}`).toEqual([]);
      }
    }
  });

  /**
   * Ключевая проверка модуля. Право `serviceRequests.status` у «Ведения» и у подрядчика одно и то
   * же, и по общей таблице переходов «Ведение» выполнило бы работу исполнителя: приняло бы заявку в
   * работу за него и закрыло бы работы, которых не делало. Коридоры на то и разведены — сервер
   * обязан отказать, независимо от того, нарисовал ли портал кнопку.
   */
  it('не принимает заявку в работу и не закрывает работы', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(canTransitionServiceStatus('new', 'in_work', operator), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'done', operator), who).toBe(false);
      // Отменить заявку из работы он может — в том числе как исход «не согласовано» (Р8).
      expect(canTransitionServiceStatus('in_work', 'cancelled', operator), who).toBe(true);
      // Откаты остаются администратору: у оператора нет `requests.rollbackStatus`.
      expect(canTransitionServiceStatus('accepted', 'done', operator), who).toBe(false);
      expect(canTransitionServiceStatus('cancelled', 'new', operator), who).toBe(false);
    }
  });

  /*
   * СНЯТО из этого случая: «отказаться от заявки за исполнителя он тоже не может». Отказ переходом
   * быть перестал (Р7) — дуги `assigned → new` больше нет, и спрашивать о ней коридор бессмысленно.
   * Что «Ведение» не отказывается за исполнителя, проверяет теперь предикат
   * `canDeclineServiceRequest` (блок предикатов Р11 в конце файла).
   */

  it('надстройка и есть источник коридора: без неё та же роль не двигает ничего', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, { role: 'shtab' }), status).toEqual([]);
      expect(from(status, { role: 'department' }), status).toEqual([]);
    }
  });
});

/**
 * Виза ИТ упразднена (Р10, ответ В2): двух подписей по порядку больше нет — вопрос «чинить за эти
 * деньги или менять аппарат» задаёт себе тот же человек, что смотрит на объём работ. Ручка
 * `PATCH /:id/it-approval` снята, и прежние случаи про её исходы удалены вместе с ней: проверять
 * «из «Сметы на согласовании» отменяет заявку под замену» стало нечего — ни ручки, ни статуса, ни
 * дуги.
 *
 * СЛУЧАЙ ПРО ПУСТУЮ ТАБЛИЦУ СНЯТ ВМЕСТЕ С САМОЙ ТАБЛИЦЕЙ (план профилей оргтехники, Э9, миграция
 * E): `SERVICE_IT_TRANSITIONS` держали ровно до тех пор, пока `serviceRequests.approveIt` лежало в
 * наборе ИТ-службы и требовало ответа «право есть, ходов по нему нет». Право из набора убрано,
 * таблица и её чтение в `allowedServiceStatusTransitions` — тоже.
 *
 * А случай ниже остался и стал строже: теперь он доказывает не пустоту перечня, а ОТСУТСТВИЕ
 * ветки — субъект с одним лишь мёртвым правом не получает ни одной дуги ни из одного статуса. Верни
 * кто-нибудь коридор визы обратно, упадёт именно он.
 */
describe('виза ИТ упразднена: ни таблицы, ни ветки, ни одного хода', () => {
  it('одна виза не открывает ни одной дуги', () => {
    const itOnly: AccessSubject = {
      role: 'shtab',
      grantPermissions: ['serviceRequests.approveIt'],
    };
    expect(can(itOnly, 'serviceRequests.approveIt')).toBe(true);
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, itOnly), status).toEqual([]);
      expect(from(status, itOnly, BY_COUNTERPARTY), status).toEqual([]);
    }
  });

  /**
   * У ИТ-службы дуги остались, но приходят они другими правами — распределением и заморозкой
   * (волна В5): «взять чужую заявку, назначив себя» и «придержать её, пока ждут запчасть». Ходов
   * «Ведения» у неё по-прежнему нет: ни приёмки, ни отмены.
   */
  it('у ИТ-службы остаются переназначение и заморозка — и ни приёмки, ни отмены', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(from('new', approver), who).toEqual(['on_hold']);
      expect(from('in_work', approver), who).toEqual(['new', 'on_hold']);
      // Приёмка и возврат на доработку — не её: «Решена» она может только придержать.
      expect(from('done', approver), who).toEqual(['on_hold']);
      for (const status of ['accepted', 'cancelled'] as const) {
        expect(from(status, approver), `${who}: ${status}`).toEqual([]);
      }
      expect(canTransitionServiceStatus('done', 'accepted', approver), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'cancelled', approver), who).toBe(false);
      expect(canTransitionServiceStatus('new', 'cancelled', approver), who).toBe(false);
    }
  });

  /**
   * Снимок старой визы читается по-прежнему — и только читается (Р10): решать по нему нечего, поля
   * `it_approved_*` никуда не делись, подпись от 22.08 правдива, и карточка обязана показать, к той
   * же ревизии она относится или к позапрошлой. Равенство, а не «не меньше»: подпись под
   * позапрошлой ревизией означала бы согласие с ценами, которых в смете уже нет.
   */
  it('снимок старой визы читается по ревизии — и ни на что больше не влияет', () => {
    expect(hasCurrentItApproval({ estimateRevision: 1, itApprovedEstimateRevision: 1 })).toBe(true);
    expect(hasCurrentItApproval({ estimateRevision: 2, itApprovedEstimateRevision: 1 })).toBe(
      false,
    );
    expect(hasCurrentItApproval({ estimateRevision: 1, itApprovedEstimateRevision: null })).toBe(
      false,
    );
  });
});

/**
 * Администратор получает **объединение** коридоров: он разбирает ошибки и доводит заявку за любую
 * сторону. Перебор положительный — каждая дуга всех коридоров плюс откаты: запрещающий тест
 * пропустил бы зависшую заявку, разобрать которую администратору оказалось бы нечем.
 */
describe('администратор проходит каждую дугу всех коридоров', () => {
  const ADMIN_ARCS: [ServiceRequestStatus, ServiceRequestStatus, string][] = [
    // Коридор «Ведения»
    ['new', 'cancelled', 'отменить новую'],
    ['in_work', 'cancelled', 'отменить работы — она же исход «не согласовано» (Р8)'],
    ['done', 'accepted', 'принять работу'],
    ['done', 'in_work', 'вернуть на доработку'],
    ['on_hold', 'cancelled', 'отменить отложенную'],
    // Заморозка
    ['new', 'on_hold', 'отложить новую'],
    ['in_work', 'on_hold', 'отложить работы'],
    ['done', 'on_hold', 'отложить решённую'],
    // Коридор исполнителя
    ['new', 'in_work', 'принять в работу'],
    ['in_work', 'done', 'закрыть работы'],
    // Распределение и откаты сошлись на одной дуге (Р5, Р13): переназначение из «В работе» и откат
    // «принял в работу» ведут в «Новую» одним и тем же ходом.
    ['in_work', 'new', 'переназначить · откатить «принял в работу»'],
    ['accepted', 'done', 'откатить приёмку'],
    ['cancelled', 'new', 'вернуть отменённую в работу'],
  ];

  it('каждая дуга проходима', () => {
    for (const [a, b, what] of ADMIN_ARCS) {
      expect(canTransitionServiceStatus(a, b, admin), `${what} (${a} → ${b})`).toBe(true);
    }
  });

  it('набор из каждого статуса — объединение шести таблиц', () => {
    expect(from('new', admin)).toEqual(['cancelled', 'in_work', 'on_hold']);
    expect(from('in_work', admin)).toEqual(['cancelled', 'done', 'new', 'on_hold']);
    // Из заморозки у администратора то же, что у «Ведения»: откатов отсюда нет (Р110), а возврат —
    // не дуга таблицы, а своя ручка.
    expect(from('on_hold', admin)).toEqual(['cancelled']);
    expect(from('done', admin)).toEqual(['accepted', 'in_work', 'on_hold']);
    expect(from('accepted', admin)).toEqual(['done']);
    expect(from('cancelled', admin)).toEqual(['new']);
    // Мёртвые статусы: ходов нет и у администратора — заявок в них не бывает.
    for (const status of DEAD_STATUSES) expect(from(status, admin), status).toEqual([]);
  });

  /**
   * Чего нет и у администратора. Отмена из «Решена» стёрла бы предъявленный факт вместо возврата на
   * доработку, а второй путь назад к объёму работ сделал бы необязательным подъём ревизии, на
   * котором держится обесценивание подписи (Р9): отматывает предъявление не откат, а возврат в
   * правку (`estimate/reopen`).
   */
  it('запертых дуг нет и у него: отмена предъявленной работы и второй путь к объёму работ', () => {
    expect(SERVICE_ADMIN_ROLLBACKS.in_work).toEqual(['new']);
    expect(canTransitionServiceStatus('done', 'cancelled', admin)).toBe(false);
    // Из «Закрыта» — только откат приёмки: заново отменить принятую работу нечем.
    expect(canTransitionServiceStatus('accepted', 'cancelled', admin)).toBe(false);
    // «Решена», наоборот, откладывается — и это единственный ручной способ снять заявку с
    // автозакрытия, пока идёт разбирательство (Р106 ADR 0125).
    expect(canTransitionServiceStatus('done', 'on_hold', admin)).toBe(true);
  });

  /**
   * В мёртвый статус не ходит НИКТО и ниоткуда, и это не украшение перечней: на том, что снятых
   * значений код больше не пишет, держится безопасность `CHECK` миграции `0225`. Перебор идёт по
   * всем субъектам портала и по всем парам — запись «Назначена», приехавшая с чьей-нибудь правкой
   * коридора, обязана уронить прогон, а не встретиться в проде ошибкой ограничения.
   */
  it('целью перехода мёртвый статус не бывает ни у кого', () => {
    for (const subject of ACCESS_PROFILES) {
      for (const dead of DEAD_STATUSES) {
        for (const status of SERVICE_REQUEST_STATUSES) {
          expect(
            canTransitionServiceStatus(status, dead, subject, BY_COUNTERPARTY),
            `${accessProfileLabel(subject)}: ${status} → ${dead}`,
          ).toBe(false);
        }
      }
    }
  });
});

/**
 * Заморозка (Р103–Р110, §6.2). Она — значение статуса, а не флаг рядом с ним, и держится тремя
 * утверждениями: откладывает только тот, кто ведёт заявку; из самой заморозки обычный ход один —
 * отмена; возврат выражен не таблицей, а предикатом с целью из `held_from_status`. Разъедься любое
 * из трёх с сервером — «Отложена» стала бы вторым входом в цикл в обход виз, сметы и назначения.
 */
describe('заморозка: кто откладывает, кто возвращает и чего из неё нельзя', () => {
  /**
   * Рабочие статусы (§6.2, Р1): «Новая» (ждём решения заказчика либо исполнителя) и «В работе».
   * Прежние «Назначена» и «Смета на согласовании» из перечня ушли вместе с самими статусами — не
   * потому, что откладывать их запретили: оба состояния теперь зовутся «Новой» и «В работе», и
   * заморозка их не различает, как и раньше. Перечень явный, а не вычисленный из закрытых статусов:
   * новый статус цикла обязан появиться здесь строкой и ответить «его-то откладывать можно?».
   */
  const HOLDABLE: ServiceRequestStatus[] = [
    'new',
    'in_work',
    // «Решена» — тоже: Р106 ADR 0125 её откладывал («ждём акт от сервиса»), и она же снимается
    // заморозкой с автозакрытия.
    'done',
  ];

  it('«Ведение» и администратор откладывают из рабочих статусов и «Решена» — и только из них', () => {
    expect(HOLDABLE).toHaveLength(3);
    for (const operator of [...OPERATORS, admin]) {
      const who = accessProfileLabel(operator);
      for (const status of SERVICE_REQUEST_STATUSES) {
        expect(
          canTransitionServiceStatus(status, 'on_hold', operator),
          `${who}: ${status} → on_hold`,
        ).toBe(HOLDABLE.includes(status));
      }
    }
    // «Решена» откладывается наравне с рабочими статусами (Р106 ADR 0125): у сервиса ждут акт, а у
    // портала это единственный способ придержать автозакрытие. Закрытые — нет, и в себя заморозка
    // не вкладывается: `on_hold → on_hold` означало бы вторую причину поверх первой и потерянный
    // `held_from_status`. Мёртвые статусы — тоже нет: заявок в них не бывает.
    expect(HOLDABLE).toContain('done');
    for (const status of ['accepted', 'cancelled', 'on_hold', ...DEAD_STATUSES] as const) {
      expect(HOLDABLE).not.toContain(status);
    }
  });

  /**
   * Исполнитель о задержке сообщает примечанием, а решает тот, кто ведёт заявку (Р105): дай мы
   * подрядчику дугу в заморозку — «ждём запчасть» стало бы его решением, и заявка стояла бы месяц
   * без того, кто за это отвечает.
   */
  it('исполнитель в заморозку не ходит и из неё не выходит', () => {
    for (const subject of [service, namedExecutor]) {
      const who = accessProfileLabel(subject);
      for (const status of SERVICE_REQUEST_STATUSES) {
        expect(
          canTransitionServiceStatus(status, 'on_hold', subject, BY_COUNTERPARTY),
          `${who}: ${status} → on_hold`,
        ).toBe(false);
      }
      expect(from('on_hold', subject, BY_COUNTERPARTY), who).toEqual([]);
      expect(canHoldService(subject), who).toBe(false);
    }
  });

  /**
   * Откатов у заморозки нет ни в одну сторону (Р110). Таблица откатов читается здесь напрямую,
   * потому что через `canTransitionServiceStatus` этого не увидеть: у администратора дуга в
   * `on_hold` приходит из коридора заморозки и замаскировала бы лишний откат, а он означал бы
   * второй способ заморозить заявку — мимо ручки, которая пишет причину и `held_from_status`.
   */
  it('откатов из заморозки нет, и откатов в заморозку нет ни у одного статуса', () => {
    expect(SERVICE_ADMIN_ROLLBACKS.on_hold).toEqual([]);
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(SERVICE_ADMIN_ROLLBACKS[status], status).not.toContain('on_hold');
    }
  });

  it('из отложенной заявки нет ни одного хода, кроме отмены «Ведением»', () => {
    for (const subject of [...ACCESS_PROFILES, { role: null }, null, undefined]) {
      const allowed = from('on_hold', subject, BY_COUNTERPARTY);
      const who = subject ? accessProfileLabel(subject) : String(subject);
      expect(
        allowed.filter((to) => to !== 'cancelled'),
        who,
      ).toEqual([]);
    }
  });

  /**
   * Кто держит и отпускает заявку — перебором по всем субъектам портала. Право
   * `serviceRequests.hold` заведено своим (§7.1), и волной В5 оно попало в оба набора оргтехники:
   * «Ведению» вернулось то, что раньше приходило внутри `serviceRequests.status`, ИТ-служба
   * получила его впервые — «ждём запчасть» решает тот, кто ведёт ремонт, а не тот, кто принимает
   * работу. Субъект, получивший заморозку молча, обязан уронить этот перечень.
   */
  it('откладывают и возвращают одни и те же — «Ведение», ИТ-служба и администратор', () => {
    const holders = ACCESS_PROFILES.filter((subject) =>
      SERVICE_REQUEST_STATUSES.some((status) =>
        canTransitionServiceStatus(status, 'on_hold', subject),
      ),
    );
    expect(holders.map(accessProfileLabel)).toEqual([
      'Администратор',
      'Штаб + Оргтехника: ведение',
      // Площадка — базовая роль надстройки с шага prepare этапа 8 (ADR 0113).
      'Площадка + Оргтехника: ведение',
      'Отдел + Оргтехника: ведение',
      // Офисная пара «Ведения» — этап Э7 плана профилей (Р5, миграция B).
      'Менеджер + Оргтехника: ведение',
      'Диспетчер + Оргтехника: ведение',
      'Штаб + Оргтехника: ИТ-служба',
      'Площадка + Оргтехника: ИТ-служба',
      'Отдел + Оргтехника: ИТ-служба',
    ]);
    // Право возврата — то же самое и считается той же функцией: заморозка, из которой возвращает
    // не тот, кто её поставил, означала бы заявку, отпущенную мимо человека, знающего причину.
    expect(ACCESS_PROFILES.filter(canResumeService).map(accessProfileLabel)).toEqual(
      holders.map(accessProfileLabel),
    );
  });

  it('возврат закрыт исполнителю, заказчику и наблюдателю — и субъекта может не быть вовсе', () => {
    for (const operator of [...OPERATORS, admin]) {
      expect(canResumeService(operator), accessProfileLabel(operator)).toBe(true);
    }
    // У подрядчика право хода есть, но сторона исполнительская: держит и отпускает тот, кто ведёт.
    expect(canResumeService(service)).toBe(false);
    // ИТ-служба возвращает наравне с «Ведением» с волны В5: у неё своё право `serviceRequests.hold`,
    // и заморозка без возврата означала бы заявку, отпустить которую может только соседняя
    // должность.
    for (const approver of IT_APPROVERS) {
      expect(canResumeService(approver), accessProfileLabel(approver)).toBe(true);
    }
    for (const subject of [...CUSTOMERS, observer, wasteOperator, namedExecutor, { role: null }]) {
      expect(canResumeService(subject), accessProfileLabel(subject)).toBe(false);
    }
    expect(canResumeService(null)).toBe(false);
    expect(canResumeService(undefined)).toBe(false);
  });

  /**
   * Куда вернётся заявка: дуга назад одна (Р104) — в тот самый статус, из которого её отложили.
   * `null` у незамороженной — не мелочь: ручка возврата решает по этому ответу, и «вернуть»
   * заявку, которую никто не откладывал, значило бы двинуть её по статусу из прошлого.
   */
  it('цель возврата — запомненный статус, у незамороженной заявки её нет', () => {
    for (const held of HOLDABLE) {
      expect(serviceResumeTarget({ status: 'on_hold', heldFromStatus: held }), held).toBe(held);
    }
    // Заявка не отложена — возвращать нечего, чем бы ни было заполнено поле: пара полей ходит
    // вместе (CHECK в БД), и старое значение в `held_from_status` не должно открывать ход назад.
    expect(serviceResumeTarget({ status: 'in_work', heldFromStatus: null })).toBe(null);
    // Живой статус в поле — тоже не повод: мёртвого («Назначена») там больше не бывает вовсе, а
    // оставшийся от прошлой заморозки живой ход назад открывать не должен.
    expect(serviceResumeTarget({ status: 'in_work', heldFromStatus: 'new' })).toBe(null);
    expect(serviceResumeTarget({ status: 'accepted', heldFromStatus: null })).toBe(null);
    // И у отложенной без запомненного статуса возврата нет: ручка обязана ответить отказом, а не
    // отправить заявку в `undefined`.
    expect(serviceResumeTarget({ status: 'on_hold', heldFromStatus: null })).toBe(null);
  });
});

describe('кому ход заявки закрыт целиком', () => {
  it('заказчик без надстройки и наблюдатель не двигают ничего', () => {
    for (const subject of [...CUSTOMERS, observer]) {
      for (const status of SERVICE_REQUEST_STATUSES) {
        expect(from(status, subject), `${accessProfileLabel(subject)}: ${status}`).toEqual([]);
        for (const to of SERVICE_REQUEST_STATUSES) {
          expect(
            canTransitionServiceStatus(status, to, subject),
            `${accessProfileLabel(subject)}: ${status} → ${to}`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * Право отката (`requests.rollbackStatus`) есть и у диспетчера — заявок оргтехники он не ведёт
   * вовсе, и отматывать их статусы ему нечем: откат спрашивается парой прав вместе с
   * `serviceRequests.status`. Иначе «отмотать назад» стало бы сторонним вмешательством в чужой
   * цикл — правом, которого ни один набор модуля не выдаёт.
   */
  it('право откатов без права хода в модуле ничего не открывает', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, { role: 'dispatcher' }), status).toEqual([]);
    }
  });

  it('субъекта нет — хода нет: без роли и без субъекта вовсе', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, { role: null }), status).toEqual([]);
      expect(from(status, null), status).toEqual([]);
      expect(from(status, undefined), status).toEqual([]);
    }
  });

  /**
   * Перебором по всем субъектам портала: непустой коридор бывает ровно у четырёх — подрядчик,
   * «Ведение» (обе базовые роли), ИТ-служба и администратор. Новый субъект, получивший ход заявки
   * молча, обязан уронить этот перечень.
   */
  it('ход заявки есть только у исполнителя, «Ведения», ИТ-службы и администратора', () => {
    const movers = ACCESS_PROFILES.filter((subject) =>
      SERVICE_REQUEST_STATUSES.some(
        (status) => allowedServiceStatusTransitions(status, subject).length > 0,
      ),
    );
    expect(movers.map(accessProfileLabel)).toEqual([
      'Администратор',
      'Оператор (внешний исполнитель) — Сервисная компания',
      'Штаб + Оргтехника: ведение',
      // Площадка — базовая роль обеих надстроек с шага prepare этапа 8 (ADR 0113): роль, на
      // которую переведут штаб, обязана двигать заявку так же, как он.
      'Площадка + Оргтехника: ведение',
      'Отдел + Оргтехника: ведение',
      // Офисная пара «Ведения» — этап Э7 плана профилей (Р5, миграция B): ход заявки открылся ей
      // тем же набором, что и площадочным ролям, и это то самое расширение доступа, о котором
      // §12 плана предупреждает строкой «расширяет доступ: да».
      'Менеджер + Оргтехника: ведение',
      'Диспетчер + Оргтехника: ведение',
      'Штаб + Оргтехника: ИТ-служба',
      'Площадка + Оргтехника: ИТ-служба',
      'Отдел + Оргтехника: ИТ-служба',
    ]);
  });

  /**
   * Отмена из «Решена» запрещена всем без исключения: работа предъявлена, и «отменить» вместо
   * «вернуть на доработку» стёрло бы предъявленный факт. Перебором по всем субъектам, потому что
   * запрет здесь не ролевой, а свойство самой дуги.
   */
  it('отмена из «Решена» закрыта каждому', () => {
    for (const subject of ACCESS_PROFILES) {
      expect(
        canTransitionServiceStatus('done', 'cancelled', subject, BY_COUNTERPARTY),
        accessProfileLabel(subject),
      ).toBe(false);
    }
  });
});

/**
 * Причина обязательна там, где переход отменяет чужую работу: без неё в истории останется пара
 * строк, по которой не понять, ошиблись исполнителем, отказался он сам или смета оказалась вдвое
 * дороже. Проверяется полной таблицей — предикат отвечает на любую пару статусов, и «требует» здесь
 * определяется дугой, а не тем, кто по ней идёт.
 */
describe('причина перехода', () => {
  /*
   * Пар, требующих объяснения помимо отмены и заморозки, осталась одна. Прежняя `assigned → new`
   * ушла вместе со статусом, и заменять её на `in_work → new` НЕ НАДО (Р5, Р13): требовала она
   * объяснения потому, что СНИМАЛА исполнителя, а по новой дуге ходят откат «принял в работу»
   * (исполнителя не трогает) и переназначение (спрашивает причину само, у себя в ручке, и там она
   * обязательна ровно тогда, когда исполнители у заявки уже были).
   */
  const REQUIRE_REASON = new Set([
    'done→in_work', // возврат на доработку
  ]);

  it('обязательна на отмене, заморозке и возврате на доработку', () => {
    for (const a of SERVICE_REQUEST_STATUSES) {
      for (const b of SERVICE_REQUEST_STATUSES) {
        // Отмена — из любого статуса: она всегда закрывает заявку без результата, и «не
        // согласовано» по объёму работ приходит той же дугой (Р8). Заморозка — тоже из любого
        // (Р107): даты «отложена до» у неё нет, и на вопрос «когда ждать» отвечает только причина.
        const expected = b === 'cancelled' || b === 'on_hold' || REQUIRE_REASON.has(`${a}→${b}`);
        expect(serviceStatusChangeRequiresReason(a, b), `${a} → ${b}`).toBe(expected);
      }
    }
  });

  /**
   * Дуга `in_work → new` объяснения не требует ни у одного из двух своих ходов, и это утверждение,
   * а не следствие таблицы выше: требуй мы причину здесь, откат «принял в работу» молча стал бы
   * строже, чем был (как `in_work → assigned` он не требовал её вовсе), а переназначение спрашивало
   * бы её дважды — и второй раз там, где у заявки исполнителей ещё не было.
   */
  it('возврат в «Новую» объяснения не требует: его спрашивает ручка переназначения', () => {
    expect(serviceStatusChangeRequiresReason('in_work', 'new')).toBe(false);
  });

  /*
   * СНЯТО: «дуга согласования сметы объяснения не требует». Согласование перестало быть переходом
   * (Р8) — пары `estimate_review → in_work` не существует, и спрашивать о ней предикат бессмысленно.
   * Причину и решение при отказе требует тело ручки (`approveServiceEstimateSchema`), там, где
   * известен сам исход; сам же отказ приходит обычной дугой `in_work → cancelled`, которую первая
   * ветка предиката и накрывает.
   */

  /**
   * Причина заморозки — единственное, что стоит в списке вместо срока: «Отложена · 12 дней» без
   * неё не отвечает, ждут запчасть или решение заказчика.
   */
  it('заморозка без причины не проходит ни из одного статуса', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(serviceStatusChangeRequiresReason(status, 'on_hold'), status).toBe(true);
    }
  });

  it('движение вперёд объяснений не требует', () => {
    for (const [a, b] of [
      ['new', 'in_work'],
      ['in_work', 'done'],
      ['done', 'accepted'],
      // Возврат из заморозки — тоже: причину сказали, когда откладывали, и требовать вторую
      // значило бы объяснять, почему заявка снова идёт своим ходом.
      ['on_hold', 'new'],
      ['on_hold', 'in_work'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(serviceStatusChangeRequiresReason(a, b), `${a} → ${b}`).toBe(false);
    }
  });
});

/**
 * Что заявка теряет, возвращаясь назад. Заявка после возврата не должна выглядеть так, будто её и
 * не двигали: снимок согласования под чужой ревизией сметы или факт закрытия у заявки «в работе»
 * означали бы решение, которого никто не принимал.
 */
describe('сброс при возвратах и откатах', () => {
  const resetKeys = (reset: ServiceTransitionReset) =>
    (Object.keys(reset) as (keyof ServiceTransitionReset)[]).filter((key) => reset[key]).sort();

  const keysOf = (a: ServiceRequestStatus, b: ServiceRequestStatus) =>
    resetKeys(serviceResetOnTransition(a, b));

  /**
   * ГЛАВНАЯ ловушка матрицы сброса (Р5, п. 2; Р13). Прежняя ветка `assigned → new` исполнителя
   * СНИМАЛА — её звал отказ, — и напрашивающаяся правка переносит снятие на `in_work → new`.
   * Это ошибка, и она ломает сразу оба хода, которые по этой дуге идут:
   *
   * - **переназначение из «В работе»** пишет новых исполнителей ДО перехода (письмо собирается в
   *   той же транзакции и читает их из таблицы), а сброс — это `DELETE ... WHERE request_id = …` по
   *   всей заявке: переназначение молча оставляло бы заявку ничьей;
   * - **откат «принял в работу»** обязан вернуть заявку назначенным, НЕ ТЕРЯЯ их: прежде эта дуга
   *   звалась `in_work → assigned` и не сбрасывала ничего. Сними мы исполнителя — откат «взялся»
   *   превратился бы в откат «назначил», то есть в другое действие, которого больше нет.
   *
   * Отказ же исполнителя переходом быть перестал (Р7): состав он правит сам, статуса не трогая.
   */
  it('возврат в «Новую» из работы не снимает исполнителя и не стирает ничего', () => {
    expect(keysOf('in_work', 'new')).toEqual([]);
    expect(serviceResetOnTransition('in_work', 'new').executor, 'исполнитель').toBe(false);
    // Вторая половина той же ловушки: причины эта дуга не требует (Р13) — переназначение
    // спрашивает её само, телом своей ручки, и только когда исполнители у заявки уже были.
    expect(serviceStatusChangeRequiresReason('in_work', 'new')).toBe(false);
    // Снять исполнителя по-прежнему есть чему: отмена и возврат отменённой в «Новую».
    expect(serviceResetOnTransition('in_work', 'cancelled').executor).toBe(true);
    expect(serviceResetOnTransition('cancelled', 'new').executor).toBe(true);
  });

  it('отмена из любого статуса снимает исполнителя и согласование', () => {
    // Отменённая заявка остаётся историей того, что собирались чинить, но ни исполнителя, ни
    // согласованной сметы у неё больше нет. Смета при этом сохраняется: по ней и объясняют, почему
    // отменили — в том числе когда исход отмены «менять аппарат». У отложенной к этому добавляется
    // очистка полей заморозки — и только добавляется (Р118), см. следующий тест.
    for (const status of SERVICE_REQUEST_STATUSES) {
      const expected =
        status === 'on_hold' ? ['approval', 'executor', 'hold'] : ['approval', 'executor'];
      expect(keysOf(status, 'cancelled'), status).toEqual(expected);
    }
  });

  /**
   * Р118 — главный тест заморозки. Напрашивающаяся ветка
   * `if (from === 'on_hold') return { ...NO_RESET, hold: true }` выглядит верной и ломает две вещи
   * сразу: у отменённой отложенной заявки остались бы и назначенный исполнитель, и согласие со
   * сметой, которых отмена из любого другого статуса не оставляет. Поэтому проверяются **оба**
   * факта — поля заморозки чистятся **и** обычный сброс отмены выполняется целиком.
   */
  it('отмена отложенной чистит заморозку и снимает исполнителя с согласованием — оба разом', () => {
    expect(keysOf('on_hold', 'cancelled')).toEqual(['approval', 'executor', 'hold']);
    // То же поштучно, чтобы падение читалось без разбора массива: пропажа любого из трёх — либо
    // ошибка БД на `service_requests_hold_check`, либо отменённая заявка с живым исполнителем.
    const reset = serviceResetOnTransition('on_hold', 'cancelled');
    expect(reset.hold, 'поля заморозки').toBe(true);
    expect(reset.executor, 'исполнитель').toBe(true);
    expect(reset.approval, 'согласование сметы').toBe(true);
  });

  it('вход в заморозку не отменяет ничего: она останавливает заявку, а не откатывает её', () => {
    // Перебор по всем источникам, кроме самой заморозки: `on_hold → on_hold` дугой не является, а
    // сброс на нём поднимает `hold` — как на любом другом выходе из заморозки.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'on_hold')) {
      expect(keysOf(status, 'on_hold'), `${status} → on_hold`).toEqual([]);
    }
  });

  it('возобновление чистит поля заморозки — и только их', () => {
    // Цели возврата — только живые статусы: мёртвых в `held_from_status` не бывает, потому что в
    // них не бывает и самих заявок (Р1). Прежний перечень называл их наравне с живыми — это была
    // проверка совместимости выпуска 1, снятая вместе со статусами.
    const RESUME_TARGETS: ServiceRequestStatus[] = ['new', 'in_work', 'done'];
    for (const target of RESUME_TARGETS) {
      expect(keysOf('on_hold', target), `on_hold → ${target}`).toEqual(['hold']);
    }
  });

  /**
   * Откат отменённой — единственная дуга, снимающая пометки отказа: «рекомендована замена» (М5) и
   * решение, принятое вместо ремонта (`rejection_resolution`, Р12). Оба флага слиты в один
   * (`rejection`), и это не сокращение записи: живут и умирают они всегда вместе — обе пометки
   * объясняют, почему заявку закрыли без ремонта, обе относятся к отмене, которой после отката
   * больше нет. Не сними их здесь — возврат упрётся в `service_requests_replacement_check` либо в
   * `service_requests_rejection_resolution_check` ошибкой БД, а не отказом маршрута.
   */
  it('откат отменённой заявки возвращает её в состояние «ничего не делали»', () => {
    expect(keysOf('cancelled', 'new')).toEqual([
      'approval',
      'estimate',
      'executor',
      'itApproval',
      'rejection',
    ]);
    expect(serviceResetOnTransition('cancelled', 'new').rejection).toBe(true);
    // Пометки снимает только этот путь: в остальных переходах их у заявки и не бывает.
    for (const a of SERVICE_REQUEST_STATUSES) {
      for (const b of SERVICE_REQUEST_STATUSES) {
        if (a === 'cancelled' && b === 'new') continue;
        expect(serviceResetOnTransition(a, b).rejection, `${a} → ${b}`).toBe(false);
      }
    }
  });

  /*
   * СНЯТО: «решение по смете снимков не стирает» (пары `estimate_review ↔ in_work`). Согласование
   * и предъявление перестали быть переходами вовсе (Р8), обоих статусов в дугах больше нет, и до
   * матрицы сброса решение по объёму работ не доходит. Что «согласовано» статуса не меняет,
   * доказывает предикат `canApproveServiceEstimate` и db-тест цикла; что «не согласовано» — обычная
   * отмена, накрывает случай «отмена из любого статуса» выше.
   */

  it('возврат на доработку стирает факт закрытия, откат приёмки — только снимок приёмки', () => {
    expect(keysOf('done', 'in_work')).toEqual(['completion']);
    // Факт закрытия при откате приёмки сохраняется целиком: работу предъявляли, её просто не
    // приняли ещё раз.
    expect(keysOf('accepted', 'done')).toEqual(['acceptance']);
  });

  it('движение вперёд не стирает ничего', () => {
    for (const [a, b] of [
      ['new', 'in_work'],
      ['in_work', 'done'],
      ['done', 'accepted'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(keysOf(a, b), `${a} → ${b}`).toEqual([]);
    }
  });

  /*
   * СНЯТО: «переназначение матрицей возвратов не описано» (пары `assigned → assigned` и
   * `in_work → assigned`). Переназначение больше не задерживается в своём статусе — единственная его
   * дуга ведёт из «В работе» в «Новую» (Р5), и матрица возвратов о ней теперь как раз ГОВОРИТ:
   * ничего не сбрасывать. Проверяет это первый случай блока, и он же объясняет почему.
   */
});

/**
 * Кого ждут (Р2, Р3). Сторона считается по СТРОКЕ заявки, а не по одному статусу, и осей у неё две —
 * состав исполнителей и непогашенное предъявление: «Новая» без исполнителей ждёт распределения, с
 * ними — что за неё возьмутся; «В работе» с висящим предъявлением ждёт подписи под объёмом работ,
 * без него — самих работ. Третья ось, виза ИТ, ушла вместе с визой (Р10).
 *
 * Сама сторона определяется правами и типом контрагента, а не именем роли: у «Ведения» роль «Штаб»
 * или «Отдел», у подрядчика роль «Оператор (внешний исполнитель)».
 */
describe('кого ждёт заявка', () => {
  /** Нетронутая заявка: исполнителей нет, предъявления нет — так выглядит всё до распределения. */
  const row = (status: ServiceRequestStatus): ServiceWaitingRequest => ({
    status,
    hasExecutors: false,
    estimatePendingRevision: null,
  });

  it('сторона следует из статуса, а два рабочих статуса — из признаков строки', () => {
    const byStatus: Record<ServiceRequestStatus, ServiceWaitingOn> = {
      // Нетронутую «Новую» ждёт тот, кто распределяет.
      new: 'operator',
      it_approved: 'operator', // мёртвый статус (0197)
      // Мёртвые статусы отвечают тем же, чем ответил бы их живой эквивалент: функцию зовут и на
      // строках истории, где они встречаются законно, — и ничьей такая строка выглядеть не должна.
      assigned: 'service', // мёртвый статус (0224): «назначили, ждём, что возьмутся»
      diagnostics: 'service', // мёртвый статус (0197)
      estimate_review: 'approval', // мёртвый статус (0224): «счёт предъявлен, ждём ответа»
      in_work: 'service',
      // Отложенную не ждёт никто из сторон: ход остановлен, и «ждёт оператора» отправило бы её в
      // очередь, из которой начинают день (Р111).
      on_hold: 'hold',
      done: 'operator',
      accepted: 'nobody',
      cancelled: 'nobody',
    };
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(serviceRequestWaitingOn(row(status)), status).toBe(byStatus[status]);
    }
    // Значение `customer` не заведено: заказчик в цикле решений не участвует — приёмку делает
    // «Ведение». А `hold` — не сторона, а объяснение остановки: в списке у отложенной должна стоять
    // причина, а не пустая клетка, поэтому у неё своё значение, а не `nobody`.
    //
    // `it` в перечне осталось, хотя очередь его не возвращает ни при каком состоянии (Р10) и право
    // `serviceRequests.approveIt` из наборов уже убрано (Э9 плана профилей, миграция E). Значение —
    // часть ответа сервера (`waitingOn` в списке и карточке), и снимать его нужно вместе с подписью,
    // веткой `isWaitingOn` и разбором на портале, то есть отдельной правкой контракта. `approval`
    // стоит рядом своим значением (Р3): согласующий не совпадает ни с одной старой стороной.
    expect([...SERVICE_WAITING_ON]).toEqual([
      'it',
      'operator',
      'approval',
      'service',
      'hold',
      'nobody',
    ]);
  });

  /**
   * «Новая» отвечает СОСТАВОМ ИСПОЛНИТЕЛЕЙ — ровно тем, что означала «Назначена» (Р2). Проверяется
   * основание, а не совпадение ответов со вчерашними: заявка, отданная подрядчику, поимённых строк
   * не имеет вовсе, и признак ей даёт колонка контрагента. Считай мы «есть строки исполнителей» —
   * такая заявка числилась бы вечно нераспределённой: и в очереди оператора, и в письмах, и в
   * правке заказчиком.
   */
  it('«Новая» с исполнителями ждёт исполнителя, без них — оператора', () => {
    expect(serviceRequestWaitingOn({ ...row('new'), hasExecutors: false })).toBe('operator');
    expect(serviceRequestWaitingOn({ ...row('new'), hasExecutors: true })).toBe('service');
    // Сам признак — дизъюнкция: поимённые строки ЛИБО назначенная сервисная компания.
    expect(serviceHasExecutors({ serviceCounterpartyId: null, executorCount: 0 })).toBe(false);
    expect(serviceHasExecutors({ serviceCounterpartyId: null, executorCount: 1 })).toBe(true);
    expect(serviceHasExecutors({ serviceCounterpartyId: COUNTERPARTY_ID, executorCount: 0 })).toBe(
      true,
    );
    // «Первое назначение» — его отрицание, а не статус «Новая» (Р11): по статусу оно спрашивалось
    // и на сервере, и в окне назначения, и оба места после слияния требовали бы причину там, где
    // она не нужна, либо отправляли запрос, на который придёт 422.
    expect(serviceIsFirstAssignment({ serviceCounterpartyId: null, executorCount: 0 })).toBe(true);
    expect(
      serviceIsFirstAssignment({ serviceCounterpartyId: COUNTERPARTY_ID, executorCount: 0 }),
    ).toBe(false);
    expect(serviceIsFirstAssignment({ serviceCounterpartyId: null, executorCount: 2 })).toBe(false);
  });

  /**
   * «В работе» отвечает ПРЕДЪЯВЛЕНИЕМ — своей колонкой (Р2), а не снимком даты: `NULL` значит
   * «ответ получен» (согласовали, отклонили либо исполнитель отозвал предъявление), число — «висит
   * предъявление этой ревизии».
   */
  it('«В работе» с висящим предъявлением ждёт согласования, без него — исполнителя', () => {
    expect(
      serviceRequestWaitingOn({
        status: 'in_work',
        hasExecutors: true,
        estimatePendingRevision: null,
      }),
    ).toBe('service');
    expect(
      serviceRequestWaitingOn({
        status: 'in_work',
        hasExecutors: true,
        estimatePendingRevision: 3,
      }),
    ).toBe('approval');
    // Состав исполнителей на этот ответ не влияет: в «В работе» спрашивают не «есть ли кому
    // делать», а «ответили ли на предъявленный счёт».
    expect(
      serviceRequestWaitingOn({
        status: 'in_work',
        hasExecutors: false,
        estimatePendingRevision: 3,
      }),
    ).toBe('approval');
    // Ноль — такая же ревизия, как любая другая: признак читает `NULL`, а не истинность числа.
    expect(serviceEstimatePending({ estimatePendingRevision: null })).toBe(false);
    expect(serviceEstimatePending({ estimatePendingRevision: 0 })).toBe(true);
    expect(serviceEstimatePending({ estimatePendingRevision: 3 })).toBe(true);
  });

  /**
   * Признаки спрашиваются только там, где заявка движется. Это не мелочь: и висящее предъявление, и
   * назначенные исполнители переживают заморозку, приёмку и закрытие, — спроси их очередь в этих
   * статусах, отменённая заявка встала бы в очередь согласования.
   */
  it('в заморозке, приёмке и закрытых статусах признаки не спрашиваются', () => {
    for (const status of ['on_hold', 'done', 'accepted', 'cancelled'] as const) {
      expect(
        serviceRequestWaitingOn({ status, hasExecutors: true, estimatePendingRevision: 7 }),
        status,
      ).toBe(serviceRequestWaitingOn(row(status)));
    }
  });

  /**
   * Прежняя функция от одного статуса осталась ради зовущих, которых ещё переключают. Отвечать она
   * обязана как НЕТРОНУТАЯ заявка: обеим развилкам Р2 она даёт ответ до распределения и до
   * предъявления, и это её единственное честное поведение.
   */
  it('устаревшая функция от статуса отвечает как нетронутая заявка', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(serviceWaitingOn(status), status).toBe(serviceRequestWaitingOn(row(status)));
    }
    expect(serviceWaitingOn('new')).toBe('operator');
    expect(serviceWaitingOn('in_work')).toBe('service');
  });

  it('сторону задают права, а не роль: у штаба-оператора роль «Штаб», а сторона — оператор', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(isWaitingOn(operator, 'operator'), who).toBe(true);
      expect(isWaitingOn(operator, 'service'), who).toBe(false);
    }
    // У подрядчика роль — «Оператор (внешний исполнитель)», а сторона его — `service`: совпадение
    // имён здесь ровно то, из-за которого сравнивать `waitingOn` с ролью нельзя.
    expect(isWaitingOn(service, 'service')).toBe(true);
    expect(isWaitingOn(service, 'operator')).toBe(false);
    // Та же роль у исполнителя чужого модуля — и ни одной стороны: решает тип контрагента.
    expect(isWaitingOn(wasteOperator, 'service')).toBe(false);
    expect(isWaitingOn(wasteOperator, 'operator')).toBe(false);
    // Администратор стоит на стороне оператора (право назначения у него есть), но исполнителем не
    // становится: заявку он ведёт за компанию, а не за подрядчика.
    expect(isWaitingOn(admin, 'operator')).toBe(true);
    expect(isWaitingOn(admin, 'service')).toBe(false);
  });

  /**
   * Сторона согласования — СВОЯ (Р3), и это главное, что тут проверяется. Строкой в `operator` её
   * оставить было нельзя: `operator` определяется правом РАСПРЕДЕЛЕНИЯ, а согласует по ответу В2
   * назначенный сотрудник, — и ИТ-служба, у которой `assign` есть, а `approveEstimate` нет, видела
   * бы в «Ждут меня» чужие подписи.
   */
  it('сторона согласования отделена от стороны распределения', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(isWaitingOn(operator, 'approval'), who).toBe(true);
    }
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      // Право распределения у неё есть — сторона `operator` отвечает по нему...
      expect(isWaitingOn(approver, 'operator'), who).toBe(true);
      // ...а подписи под объёмом работ у неё нет, и в очередь согласования она не встаёт.
      expect(isWaitingOn(approver, 'approval'), who).toBe(false);
    }
    // Оператор контрагента-сервиса исключён явно: объём работ предъявил он.
    expect(isWaitingOn(service, 'approval')).toBe(false);
  });

  /**
   * Сторона `it` осталась значением, но очередь её больше не возвращает НИ ПРИ КАКОМ состоянии
   * (Р10): виза упразднена. Проверяется это перебором обеих осей по всем статусам — на случай,
   * если ветка вернётся в предикат вместе с чьей-нибудь правкой.
   *
   * А ПО СУБЪЕКТУ сторона теперь отвечает одному администратору, и это прямое следствие Э9
   * (миграция E): `serviceRequests.approveIt` убрано из набора ИТ-службы, в матрице оно осталось
   * только у него. Держатель профиля «Системный администратор» стороной `it` быть не перестал —
   * там, где эта сторона хоть что-то значит (обсуждение), его опознаёт КОД набора (Р9), а не право.
   */
  it('стороны ИТ у заявки не бывает ни в одном состоянии', () => {
    const answers = new Set<ServiceWaitingOn>(
      SERVICE_REQUEST_STATUSES.flatMap((status) =>
        [false, true].flatMap((hasExecutors) =>
          [null, 1].map((estimatePendingRevision) =>
            serviceRequestWaitingOn({ status, hasExecutors, estimatePendingRevision }),
          ),
        ),
      ),
    );
    expect(answers.has('it')).toBe(false);
    // Само значение при этом живо, и по субъекту сторона отвечает — но только администратору:
    // право визы осталось лишь в его матрице.
    expect(isWaitingOn(admin, 'it')).toBe(true);
    for (const approver of IT_APPROVERS) {
      expect(isWaitingOn(approver, 'it'), accessProfileLabel(approver)).toBe(false);
    }
    expect(isWaitingOn(shtabOperator, 'it')).toBe(false);
    expect(isWaitingOn(service, 'it')).toBe(false);
    // Ответ «нет» у держателя ИТ-набора ничего у него не отнимает: заявок, ждущих визы, не бывает
    // (утверждение выше), а стороной обсуждения его делает код набора.
    for (const approver of IT_APPROVERS) {
      expect(can(approver, 'serviceRequests.approveIt'), accessProfileLabel(approver)).toBe(false);
    }
  });

  it('заказчика и наблюдателя не ждут: решений в цикле у них нет', () => {
    for (const subject of [...CUSTOMERS, observer]) {
      for (const waiting of SERVICE_WAITING_ON) {
        expect(isWaitingOn(subject, waiting), `${accessProfileLabel(subject)}: ${waiting}`).toBe(
          false,
        );
      }
    }
  });

  it('закрытая заявка не ждёт никого — ни одного субъекта портала', () => {
    for (const subject of [...ACCESS_PROFILES, { role: null }, null, undefined]) {
      expect(isWaitingOn(subject, 'nobody')).toBe(false);
    }
  });

  /**
   * Отложенная не считается ожидающей никого — иначе она стояла бы первой строкой в очереди «Ждут
   * меня» и накручивала бы бейдж раздела всё время, пока ждут запчасть (Р111). Перебором по всем
   * субъектам портала: это свойство самого состояния, а не чьих-то прав.
   */
  it('отложенная не ждёт никого: ни очереди «ждут меня», ни бейджа', () => {
    for (const subject of [...ACCESS_PROFILES, { role: null }, null, undefined]) {
      expect(isWaitingOn(subject, 'hold')).toBe(false);
    }
    expect(isWaitingOn(shtabOperator, serviceRequestWaitingOn(row('on_hold')))).toBe(false);
    expect(isWaitingOn(admin, serviceRequestWaitingOn(row('on_hold')))).toBe(false);
    expect(isWaitingOn(service, serviceRequestWaitingOn(row('on_hold')))).toBe(false);
  });

  /**
   * Очередь сходится с действием: у того, кого ждут, есть ровно тот шаг, которого ждут. Проверка
   * переписана с «непустого коридора» на ИМЕНОВАННОЕ действие, и иначе теперь нельзя: у двух
   * состояний из пяти ожидаемый шаг дугой не является вовсе — распределение и согласование объёма
   * работ спрашиваются предикатами Р11. Считай мы по-прежнему длину коридора, «Новая» без
   * исполнителей сошлась бы на отмене и заморозке — на чём угодно, только не на распределении.
   */
  it('очередь сходится с действием: ждут того, у кого есть ровно этот шаг', () => {
    const states: {
      label: string;
      row: ServiceWaitingRequest;
      waiting: ServiceWaitingOn;
      step: (subject: AccessSubject) => boolean;
    }[] = [
      {
        label: '«Новая» без исполнителей — распределить',
        row: { status: 'new', hasExecutors: false, estimatePendingRevision: null },
        waiting: 'operator',
        step: (subject) =>
          canAssignServiceExecutors({ status: 'new', estimatePendingRevision: null }, subject),
      },
      {
        label: '«Новая» с исполнителями — принять в работу',
        row: { status: 'new', hasExecutors: true, estimatePendingRevision: null },
        waiting: 'service',
        step: (subject) => canTransitionServiceStatus('new', 'in_work', subject, BY_COUNTERPARTY),
      },
      {
        label: '«В работе» без предъявления — выполнить и закрыть',
        row: { status: 'in_work', hasExecutors: true, estimatePendingRevision: null },
        waiting: 'service',
        step: (subject) => canTransitionServiceStatus('in_work', 'done', subject, BY_COUNTERPARTY),
      },
      {
        label: '«В работе» с предъявлением — согласовать объём работ',
        row: { status: 'in_work', hasExecutors: true, estimatePendingRevision: 2 },
        waiting: 'approval',
        step: (subject) =>
          canApproveServiceEstimate(
            { status: 'in_work', estimatePendingRevision: 2 },
            subject,
            NOT_ASSIGNED,
          ),
      },
      {
        label: '«Решена» — принять работу',
        row: { status: 'done', hasExecutors: true, estimatePendingRevision: null },
        waiting: 'operator',
        step: (subject) => canTransitionServiceStatus('done', 'accepted', subject),
      },
    ];
    for (const state of states) {
      expect(serviceRequestWaitingOn(state.row), state.label).toBe(state.waiting);
      // Сторону берём ту, что видна по субъекту: подрядчик — `service`, «Ведение» — остальные две.
      const subject = state.waiting === 'service' ? service : shtabOperator;
      expect(isWaitingOn(subject, state.waiting), state.label).toBe(true);
      expect(state.step(subject), state.label).toBe(true);
    }
  });
});

/**
 * Подпись шага (Р101, Р2): один словарь на все стороны — портал приписывает лицо сам («Вам:
 * согласовать объём работ» тому, за кем ход, и «ждёт оператора» остальным). Пустая подпись здесь
 * означает «ждать нечего», и статус без хода обязан быть пустым ровно потому, что портал показывает
 * эту строку как призыв к действию.
 *
 * После слияния статусов (Р2) словарь отвечает не на всё, и это осознанная граница: в «Новой» ждут
 * то распределения, то «примите в работу», а в «В работе» — то подписи под объёмом работ, то самих
 * работ. Развилку держит `serviceStepLabelFor` стороной ожидания, и она проверяется тут же.
 */
describe('подпись шага у статуса', () => {
  /** Статусы без хода: у отложенной шага нет (Р110), у закрытой и отменённой — цикл окончен. */
  const NO_STEP: ServiceRequestStatus[] = ['on_hold', 'accepted', 'cancelled'];

  it('у каждого статуса с ходом подпись есть, у остальных — пусто', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      const label = serviceStepLabels[status];
      if (NO_STEP.includes(status)) {
        // «Отложена: ждём запчасть» портал берёт из причины заморозки, а не отсюда: подпись здесь
        // звала бы к шагу, которого в этом статусе нет ни у кого.
        expect(label, status).toBe('');
      } else {
        expect(label?.trim(), status).toBeTruthy();
      }
    }
  });

  /**
   * Мёртвые статусы отвечают подписью того состояния, которым они стали: строка «Новая → Назначена»
   * от 20.08 правдива, её показывает лента истории, и звать она обязана к тому же шагу, к какому
   * зовёт сегодняшняя «Новая» с исполнителями. Сравнением с `serviceStepLabelFor`, а не с готовой
   * строкой: совпадение двух литералов разъехалось бы молча при первом же переименовании.
   */
  it('мёртвые статусы зовут к шагу состояния, которым они стали', () => {
    expect(serviceStepLabels.it_approved).toBe(serviceStepLabels.new);
    expect(serviceStepLabels.diagnostics).toBe(serviceStepLabels.in_work);
    expect(serviceStepLabels.assigned).toBe(serviceStepLabelFor('new', 'service'));
    expect(serviceStepLabels.estimate_review).toBe(serviceStepLabelFor('in_work', 'approval'));
  });

  /**
   * Подпись «что делать МНЕ» различает два состояния каждого рабочего статуса — теми же двумя
   * осями, какими их различает очередь (Р2). Второй разбор признаков здесь разошёлся бы с очередью
   * молча, поэтому сторона приходит уже посчитанной, и проверяется именно эта пара.
   */
  it('у рабочих статусов подпись зависит от стороны, у остальных — нет', () => {
    expect(serviceStepLabelFor('new', 'operator')).toBe('назначить исполнителей');
    expect(serviceStepLabelFor('new', 'service')).toBe('принять в работу');
    expect(serviceStepLabelFor('in_work', 'service')).toBe('выполнить и закрыть работы');
    expect(serviceStepLabelFor('in_work', 'approval')).toBe('согласовать объём работ');
    // Остальным статусам сторона не добавляет ничего: ответ у них один на всех.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new' && s !== 'in_work')) {
      for (const waiting of SERVICE_WAITING_ON) {
        expect(serviceStepLabelFor(status, waiting), `${status}/${waiting}`).toBe(
          serviceStepLabels[status],
        );
      }
    }
  });

  it('словарь отвечает на каждый статус: новый статус обязан получить свою строку', () => {
    expect(Object.keys(serviceStepLabels).sort()).toEqual([...SERVICE_REQUEST_STATUSES].sort());
  });
});

/**
 * Действия, у которых больше нет дуги (Р11). Портал строил меню из коридора: назначение искал по
 * дуге в «Назначенную», отказ — по дуге в «Новую», предъявление — по дуге в «Смету на согласовании».
 * После правки дуг нет у четырёх действий из пяти, и замена им — предикат в контрактах: одна функция
 * на сервер и портал, ровно как коридор. Разойдись они — пункт меню исчез бы с экрана при
 * разрешающем сервере либо кнопка вела бы в отказ.
 *
 * **Перечень статусов внутри каждого предиката — половина условия, а не украшение.** Признаки Р2
 * сами по себе шире допустимых состояний: и назначенные исполнители, и висящее предъявление, и
 * снимок подписи переживают «Решена», «Закрыта», «Отменена» и заморозку. Поэтому у каждого
 * предиката проверяется не только «да» в своём статусе, но и «нет» во всех остальных.
 */
describe('действия, у которых больше нет дуги (Р11)', () => {
  const actionRow = (over: Partial<ServiceActionRequest> = {}): ServiceActionRequest => ({
    kind: 'repair',
    status: 'in_work',
    serviceCounterpartyId: null,
    executorCount: 0,
    estimatePendingRevision: null,
    approvedEstimateRevision: null,
    ...over,
  });

  it('назначают из «Новой» и «В работе» — и только правом распределения', () => {
    for (const subject of [...OPERATORS, ...IT_APPROVERS, admin]) {
      const who = accessProfileLabel(subject);
      expect(canAssignServiceExecutors(actionRow({ status: 'new' }), subject), who).toBe(true);
      expect(canAssignServiceExecutors(actionRow({ status: 'in_work' }), subject), who).toBe(true);
      // Перечень держит признак: назначенные исполнители переживают и «Решена», и «Отменена», и
      // заморозку, — а менять их там нечего (работа предъявлена, ждут приёмки).
      for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new' && s !== 'in_work')) {
        expect(canAssignServiceExecutors(actionRow({ status }), subject), `${who}: ${status}`).toBe(
          false,
        );
      }
    }
    // Без права распределения — никто: ни заказчик, ни исполнитель, ни наблюдатель.
    for (const subject of [...CUSTOMERS, observer, service, namedExecutor, null, undefined]) {
      expect(canAssignServiceExecutors(actionRow({ status: 'new' }), subject)).toBe(false);
    }
  });

  /**
   * Запрет переназначения под висящим предъявлением — то же СЕГОДНЯШНЕЕ правило, а не новое: из
   * «Сметы на согласовании» переназначить было нельзя (`SERVICE_ASSIGNER_TRANSITIONS` там пуст),
   * потому что цифры предъявленного объёма принадлежат прежнему исполнителю и переданная заявка
   * оставила бы новому чужой счёт. После слияния это же состояние зовётся «В работе» +
   * `serviceEstimatePending`, и не войди условие в сам предикат — запрет исчез бы вместе со
   * статусом МОЛЧА: перечня статусов для него мало.
   */
  it('переназначение заперто висящим предъявлением и отпирается ответом на него', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(
        canAssignServiceExecutors(
          actionRow({ status: 'in_work', estimatePendingRevision: 2 }),
          operator,
        ),
        who,
      ).toBe(false);
      // Сперва решают по объёму работ: погашенное предъявление переназначение снова открывает —
      // ровно как сегодня из «В работе» без сметы на подписи.
      expect(
        canAssignServiceExecutors(
          actionRow({
            status: 'in_work',
            estimatePendingRevision: null,
            approvedEstimateRevision: 2,
          }),
          operator,
        ),
        who,
      ).toBe(true);
    }
  });

  /**
   * Отказ (Р7). Право здесь ни при чём: отказывается НАЗНАЧЕННЫЙ, и сторону считает тот же
   * предикат, каким прежняя дуга `assigned → new` открывалась в коридоре.
   *
   * Строка заявки поэтому несёт исполнителей: с ними «Новая» и есть то, что прежде звалось
   * «Назначенной». Пустой состав разбирает отдельный случай ниже.
   */
  const assignedNew = (over: Partial<ServiceActionRequest> = {}) =>
    actionRow({ status: 'new', executorCount: 1, ...over });

  /**
   * Шестой предикат Р11, заведённый по находке db-тестов: `start` перестал спрашивать коридор в
   * одиночку. Прежний довод «ход открывает факт назначения, и он же закрывает его у
   * нераспределённой заявки» верен лишь наполовину — коридор открывает дизъюнкция, и второе её
   * слагаемое (право на объём работ) назначения не спрашивает. Без предиката администратор
   * переводил заявку без исполнителей в «В работе», и ловил это отложенный триггер на `COMMIT`:
   * наружу шло 500 вместо отказа.
   */
  it('в работу берут распределённую «Новую» — и только сторона исполнителя', () => {
    expect(canStartServiceWork(assignedNew(), service, BY_COUNTERPARTY)).toBe(true);
    expect(canStartServiceWork(assignedNew(), namedExecutor, BY_NAME)).toBe(true);
    // Нераспределённую не берёт никто — ровно то, что прежде держал снятый статус.
    for (const subject of [service, namedExecutor, admin]) {
      expect(
        canStartServiceWork(actionRow({ status: 'new' }), subject, BY_COUNTERPARTY),
        accessProfileLabel(subject),
      ).toBe(false);
    }
    // Сторона обязательна и при непустом составе: посторонний держатель набора не берётся.
    expect(canStartServiceWork(assignedNew(), namedExecutor, NOT_ASSIGNED)).toBe(false);
    // Из прочих статусов ход закрыт: «взялся» бывает один раз.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new')) {
      expect(canStartServiceWork(assignedNew({ status }), service, BY_COUNTERPARTY), status).toBe(
        false,
      );
    }
  });

  it('отказывается от «Новой» назначенный, а не тот, у кого право', () => {
    expect(canDeclineServiceRequest(assignedNew(), service, BY_COUNTERPARTY)).toBe(true);
    expect(canDeclineServiceRequest(assignedNew(), namedExecutor, BY_NAME)).toBe(true);
    expect(canDeclineServiceRequest(assignedNew(), namedExecutor, NOT_ASSIGNED)).toBe(false);
    // От нераспределённой «Новой» не отказывается НИКТО, включая держателя права на объём работ
    // (вне контрагента-сервиса это администратор). Прежде запрет держала дуга: отказ ходил
    // `assigned → new`, и нераспределённая до него не доходила. После слияния статусов (Р1) её
    // отбивает `serviceHasExecutors` в самом предикате — иначе отказ по заявке, которую никто не
    // брал, писал бы в ленту «исполнителей стало меньше» и обнулял возраст ожидания.
    for (const subject of [service, namedExecutor, admin]) {
      expect(
        canDeclineServiceRequest(actionRow({ status: 'new' }), subject, BY_COUNTERPARTY),
        accessProfileLabel(subject),
      ).toBe(false);
    }
    // Отказ ВЗЯВШЕГОСЯ (из «В работе») не открыт (Р7): сегодня его нет, и заводить его заодно
    // значило бы расширение, о котором не просили, — такую заявку возвращает переназначение.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new')) {
      expect(
        canDeclineServiceRequest(assignedNew({ status }), service, BY_COUNTERPARTY),
        status,
      ).toBe(false);
    }
    // «Ведение» за исполнителя не отказывается: на этот случай у него переназначение.
    for (const operator of OPERATORS) {
      expect(
        canDeclineServiceRequest(actionRow({ status: 'new' }), operator, NOT_ASSIGNED),
        accessProfileLabel(operator),
      ).toBe(false);
    }
  });

  /**
   * Предъявление (Р8, Р9). «Предъявление не висит» — первый из двух замков Р9: прежде повторное
   * предъявление запирал сам статус (из «Сметы на согласовании» ручка была недоступна), а сняв его,
   * мы позволили бы исполнителю поднять ревизию и подменить снимок суммы под уже открытым окном
   * согласования.
   */
  it('предъявляет объём работ исполнитель: по ремонту, из работы и не поверх висящего', () => {
    expect(canSubmitServiceEstimate(actionRow(), service, BY_COUNTERPARTY)).toBe(true);
    expect(canSubmitServiceEstimate(actionRow(), namedExecutor, BY_NAME)).toBe(true);
    expect(canSubmitServiceEstimate(actionRow(), namedExecutor, NOT_ASSIGNED)).toBe(false);
    expect(
      canSubmitServiceEstimate(actionRow({ estimatePendingRevision: 1 }), service, BY_COUNTERPARTY),
    ).toBe(false);
    // У расходников объёма работ нет вовсе: предмет такой заявки — номенклатура (Р15).
    expect(
      canSubmitServiceEstimate(actionRow({ kind: 'consumable' }), service, BY_COUNTERPARTY),
    ).toBe(false);
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'in_work')) {
      expect(
        canSubmitServiceEstimate(actionRow({ status }), service, BY_COUNTERPARTY),
        status,
      ).toBe(false);
    }
  });

  /**
   * Оператор контрагента-сервиса исключён из согласования ЯВНО и раньше обеих веток (Р3): объём
   * работ предъявил он, и подпись под собственным счётом — не согласование, а его копия. Случай
   * стоит отдельным, потому что правами подрядчик похож на «Ведение»: попади к нему
   * `serviceRequests.approveEstimate` набором, обе стороны достались бы ему разом — и предъявляющая,
   * и подписывающая.
   */
  it('оператор контрагента-сервиса объём работ не согласует ни при каком праве', () => {
    const pending = actionRow({ estimatePendingRevision: 2 });
    expect(canApproveServiceEstimate(pending, service, BY_COUNTERPARTY)).toBe(false);
    const serviceWithApproval: AccessSubject = {
      role: 'operator',
      counterpartyType: 'service',
      grantPermissions: ['serviceRequests.approveEstimate'],
    };
    expect(can(serviceWithApproval, 'serviceRequests.approveEstimate')).toBe(true);
    expect(canApproveServiceEstimate(pending, serviceWithApproval, BY_COUNTERPARTY)).toBe(false);
    // И в очередь «ждут меня» подпись ему тоже не приходит: сторона `approval` отсекает подрядчика
    // той же строкой.
    expect(isWaitingOn(serviceWithApproval, 'approval')).toBe(false);
  });

  it('согласует «Ведение» и назначенный поимённо — по висящему предъявлению из работы', () => {
    const pending = actionRow({ estimatePendingRevision: 2 });
    for (const operator of OPERATORS) {
      expect(
        canApproveServiceEstimate(pending, operator, NOT_ASSIGNED),
        accessProfileLabel(operator),
      ).toBe(true);
    }
    // Назначенный сотрудник (ответ В2): по субъекту он не виден — «я в списке назначенных» это
    // свойство заявки, — и добирается он признаками назначения, а не правом согласования.
    expect(canApproveServiceEstimate(pending, namedExecutor, BY_NAME)).toBe(true);
    expect(canApproveServiceEstimate(pending, namedExecutor, NOT_ASSIGNED)).toBe(false);
    // Без висящего предъявления согласовывать нечего.
    expect(canApproveServiceEstimate(actionRow(), shtabOperator, NOT_ASSIGNED)).toBe(false);
    // Перечень статусов держит признак: он переживает и «Отменена», и заморозку, — и без перечня
    // объём работ согласовывали бы по отменённой заявке.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'in_work')) {
      expect(
        canApproveServiceEstimate(
          actionRow({ status, estimatePendingRevision: 2 }),
          shtabOperator,
          NOT_ASSIGNED,
        ),
        status,
      ).toBe(false);
    }
  });

  /**
   * Возврат в правку — ключ от обоих замков Р9: ручка снимает и снимок согласования, и само
   * предъявление. Отсюда предусловие «есть что снимать» — подпись ЛИБО непогашенное предъявление:
   * прежнего «согласование есть» после Р9 мало, иначе отозвать собственное предъявление было бы
   * нечем.
   */
  it('возврат в правку отпирают обе отметки: предъявление либо подпись', () => {
    expect(
      canReopenServiceEstimate(actionRow({ estimatePendingRevision: 2 }), service, BY_COUNTERPARTY),
    ).toBe(true);
    expect(
      canReopenServiceEstimate(
        actionRow({ approvedEstimateRevision: 2 }),
        service,
        BY_COUNTERPARTY,
      ),
    ).toBe(true);
    // Снимать нечего — ни предъявления, ни подписи.
    expect(canReopenServiceEstimate(actionRow(), service, BY_COUNTERPARTY)).toBe(false);
    // Сторона та же, что у предъявления: возвращает в правку тот, кто предъявлял.
    expect(
      canReopenServiceEstimate(
        actionRow({ estimatePendingRevision: 2 }),
        namedExecutor,
        NOT_ASSIGNED,
      ),
    ).toBe(false);
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'in_work')) {
      expect(
        canReopenServiceEstimate(
          actionRow({ status, estimatePendingRevision: 2, approvedEstimateRevision: 2 }),
          service,
          BY_COUNTERPARTY,
        ),
        status,
      ).toBe(false);
    }
  });
});
