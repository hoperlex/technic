import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  allowedServiceStatusTransitions,
  canHoldService,
  canResumeService,
  canTransitionServiceStatus,
  hasCurrentItApproval,
  isServiceExecutor,
  isWaitingOn,
  SERVICE_ADMIN_ROLLBACKS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  serviceRequestWaitingOn,
  serviceResetOnTransition,
  serviceResumeTarget,
  serviceStatusChangeRequiresReason,
  serviceStepLabels,
  serviceWaitingOn,
  type AccessSubject,
  type ServiceExecutorAssignment,
  type ServiceRequestStatus,
  type ServiceTransitionReset,
  type ServiceWaitingOn,
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

const from = (
  status: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
  assignment?: ServiceExecutorAssignment,
) => [...allowedServiceStatusTransitions(status, subject, assignment)].sort();

describe('коридор исполнителя: ход открывает назначение, а не право', () => {
  it('принимает в работу и отказывается, предъявляет смету и закрывает работы', () => {
    // Отказ возвращает заявку в «Новую», а не к визе ИТ: визы на входе больше нет (Н3).
    expect(from('assigned', service, BY_COUNTERPARTY)).toEqual(['in_work', 'new']);
    // Смета предъявляется из «В работе» и туда же возвращается: «Диагностика» слилась с ней (Н2).
    expect(from('in_work', service, BY_COUNTERPARTY)).toEqual(['done', 'estimate_review']);
  });

  /**
   * Выпуск 2 (`0197`) перевёл остаток заявок и запретил мёртвые статусы `CHECK`ом — в них больше не
   * стоят. Ходов у них поэтому нет ни у кого: пустой список здесь не пропуск, а утверждение «из
   * этого статуса не ходят, потому что в нём не бывают». Совместимость выпуска 1, которую проверял
   * прежний случай, снята вместе с самими статусами.
   */
  it('из мёртвых статусов ходов нет ни у исполнителя, ни у кого-либо ещё', () => {
    expect(from('diagnostics', service, BY_COUNTERPARTY)).toEqual([]);
    expect(from('it_approved', service, BY_COUNTERPARTY)).toEqual([]);
  });

  it('в остальных статусах ход заявки не его: ждут не исполнителя', () => {
    // «Новую» заявку сервис не видит вовсе (Р22), смету согласует не он, приёмку делает «Ведение»,
    // а из терминальных статусов заявку не двигает никто, кроме администратора. Отложенную он не
    // двигает тоже: заморозку ставит и снимает тот, кто ведёт заявку (Р105).
    for (const status of [
      'new',
      'it_approved',
      'estimate_review',
      'on_hold',
      'done',
      'accepted',
      'cancelled',
    ] as const) {
      expect(from(status, service, BY_COUNTERPARTY), status).toEqual([]);
    }
  });

  /**
   * Обе половины предиката хода — порознь (§7.1). У подрядчика назначена компания целиком, и права
   * ему не требуется; у своего сотрудника назначение работает в паре с `serviceRequests.execute`:
   * снятие набора у переведённого сисадмина закрывает ходы, не трогая историю назначений.
   */
  it('назначенный поимённо ходит теми же ручками, что подрядчик', () => {
    expect(from('assigned', namedExecutor, BY_NAME)).toEqual(['in_work', 'new']);
    expect(from('in_work', namedExecutor, BY_NAME)).toEqual(['done', 'estimate_review']);
    // Ходов оператора у него не появляется: он исполнитель, а не тот, кто заявку ведёт.
    expect(canTransitionServiceStatus('done', 'accepted', namedExecutor, BY_NAME)).toBe(false);
    expect(canTransitionServiceStatus('estimate_review', 'in_work', namedExecutor, BY_NAME)).toBe(
      false,
    );
    expect(canTransitionServiceStatus('in_work', 'cancelled', namedExecutor, BY_NAME)).toBe(false);
    expect(canTransitionServiceStatus('new', 'assigned', namedExecutor, BY_NAME)).toBe(false);
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
   * Признаков не передали — зовущий ещё не переключён (волны В3/В6). Тогда сторона подрядчика
   * считается по сегодняшнему правилу: иначе выпуск 1 отобрал бы у него весь цикл в тот день,
   * когда контракты уехали, а маршруты — ещё нет. У своего сотрудника обратное: без признаков он
   * не исполнитель, и молчаливых ходов у него не появляется.
   */
  it('без признаков подрядчик ходит как сегодня, а поимённый исполнитель — нет', () => {
    expect(from('assigned', service)).toEqual(['in_work', 'new']);
    expect(from('in_work', service)).toEqual(['done', 'estimate_review']);
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, namedExecutor), status).toEqual([]);
    }
  });

  it('не согласует смету, не принимает работу, не отменяет и не откатывает', () => {
    // Решения заказчика: согласование, отклонение сметы, приёмка и возврат на доработку.
    expect(canTransitionServiceStatus('estimate_review', 'in_work', service, BY_COUNTERPARTY)).toBe(
      false,
    );
    expect(canTransitionServiceStatus('done', 'accepted', service, BY_COUNTERPARTY)).toBe(false);
    expect(canTransitionServiceStatus('done', 'in_work', service, BY_COUNTERPARTY)).toBe(false);
    // Назначение и переназначение — решение заказчика: исполнитель себе работу не выбирает.
    expect(canTransitionServiceStatus('new', 'assigned', service, BY_COUNTERPARTY)).toBe(false);
    expect(canTransitionServiceStatus('assigned', 'assigned', service, BY_COUNTERPARTY)).toBe(
      false,
    );
    expect(canTransitionServiceStatus('in_work', 'assigned', service, BY_COUNTERPARTY)).toBe(false);
    // «Менять аппарат» — исход визы ИТ, а не отказ исполнителя от невыгодной работы.
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(
        canTransitionServiceStatus(status, 'cancelled', service, BY_COUNTERPARTY),
        status,
      ).toBe(false);
    }
    // Административные откаты. `assigned → new` в этот перечень не входит намеренно: у исполнителя
    // это не откат, а собственный отказ от работы (Р20), и дуга у них общая.
    for (const [a, b] of [
      ['in_work', 'assigned'],
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
 * пришлось бы выдавать вместе с приёмкой работы, отменой и согласованием сметы.
 */
describe('коридор распределения: кто делает заявку', () => {
  it('назначает из «Новой» и переназначает из «Назначена» и «В работе»', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(canTransitionServiceStatus('new', 'assigned', operator), who).toBe(true);
      // Переназначение — тот же статус, другой исполнитель (Р20).
      expect(canTransitionServiceStatus('assigned', 'assigned', operator), who).toBe(true);
      expect(canTransitionServiceStatus('in_work', 'assigned', operator), who).toBe(true);
      // Пока смета на подписи, менять исполнителя нечем: цифры в ней его. Сперва решают по смете.
      expect(canTransitionServiceStatus('estimate_review', 'assigned', operator), who).toBe(false);
      // По закрытой и отложенной заявке распределять нечего.
      for (const status of ['on_hold', 'done', 'accepted', 'cancelled'] as const) {
        expect(canTransitionServiceStatus(status, 'assigned', operator), `${who}: ${status}`).toBe(
          false,
        );
      }
    }
  });

  it('без права назначения дуги нет ни у кого, включая заказчика и исполнителя', () => {
    for (const subject of [...CUSTOMERS, observer, service, namedExecutor]) {
      expect(
        canTransitionServiceStatus('new', 'assigned', subject),
        accessProfileLabel(subject),
      ).toBe(false);
    }
  });
});

describe('коридор «Ведения»: решения заказчика и ни одного шага исполнителя', () => {
  it('назначает, согласует и отклоняет, принимает, возвращает и отменяет', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(from('new', operator), who).toEqual(['assigned', 'cancelled', 'on_hold']);
      expect(from('assigned', operator), who).toEqual(['assigned', 'cancelled', 'on_hold']);
      // Согласование и отклонение сметы ведут в один статус: различает их тело ручки, а не дуга.
      expect(from('estimate_review', operator), who).toEqual(['cancelled', 'in_work', 'on_hold']);
      expect(from('in_work', operator), who).toEqual(['assigned', 'cancelled', 'on_hold']);
      // «Решена» не откладывается (§6.2): работа предъявлена, ход за приёмкой.
      // Из «Решена» — приёмка, возврат на доработку и заморозка (Р106 ADR 0125).
      expect(from('done', operator), who).toEqual(['accepted', 'in_work', 'on_hold']);
      // Из самой заморозки обычная дуга одна — отмена: возврат ведёт в `held_from_status`, и
      // таблицей `Record<status, status[]>` он не выражается (Р104, своя ручка `/resume`).
      expect(from('on_hold', operator), who).toEqual(['cancelled']);
      // Терминальные статусы: вернуть заявку из них может только администратор.
      expect(from('accepted', operator), who).toEqual([]);
      expect(from('cancelled', operator), who).toEqual([]);
      // Мёртвые статусы ведутся как их живые двойники (план §3, п. 5).
      // Мёртвые статусы (`0197`): ходов нет и у «Ведения».
      expect(from('it_approved', operator), who).toEqual([]);
      expect(from('diagnostics', operator), who).toEqual([]);
    }
  });

  /**
   * Ключевая проверка модуля. Право `serviceRequests.status` у «Ведения» и у подрядчика одно и то
   * же, и по общей таблице переходов «Ведение» выполнило бы работу исполнителя: приняло бы заявку
   * в работу за него, предъявило бы смету и закрыло бы работы, которых не делало. Коридоры на то и
   * разведены — сервер обязан отказать, независимо от того, нарисовал ли портал кнопку.
   */
  it('не принимает заявку в работу, не предъявляет смету и не закрывает работы', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(canTransitionServiceStatus('assigned', 'in_work', operator), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'estimate_review', operator), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'done', operator), who).toBe(false);
      // Отказаться от заявки за исполнителя он тоже не может: на этот случай есть переназначение.
      expect(canTransitionServiceStatus('assigned', 'new', operator), who).toBe(false);
      // И визы у него нет: решение «чинить или менять» принимает ИТ-служба, а не тот, кто платит.
      expect(canTransitionServiceStatus('estimate_review', 'cancelled', operator), who).toBe(true);
      // Откаты остаются администратору: у оператора нет `requests.rollbackStatus`.
      expect(canTransitionServiceStatus('accepted', 'done', operator), who).toBe(false);
      expect(canTransitionServiceStatus('cancelled', 'new', operator), who).toBe(false);
    }
  });

  it('надстройка и есть источник коридора: без неё та же роль не двигает ничего', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, { role: 'shtab' }), status).toEqual([]);
      expect(from(status, { role: 'department' }), status).toEqual([]);
    }
  });
});

describe('коридор ИТ: один вопрос — чинить за эти деньги или менять аппарат', () => {
  /**
   * Виза уехала со входа на смету (Н3), и статуса она не меняет: подпись ставится на текущую
   * ревизию, а заявка остаётся на согласовании, пока «Ведение» не решит по сумме. Поэтому решение
   * ИТ по смете — ровно одна дуга, второй исход той же ручки.
   *
   * Заморозка стоит рядом с ней с волны В5: набор «Оргтехника: ИТ-служба» несёт
   * `serviceRequests.hold`, потому что «ждём запчасть» решает тот, кто ведёт ремонт, а не тот, кто
   * принимает работу. Она есть из каждого рабочего статуса — и это не про смету, а про заморозку,
   * поэтому перечень ниже сравнивается без неё.
   */
  it('из «Сметы на согласовании» отменяет заявку под замену — и по смете больше ничего', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      // Оставляем только то, что относится к смете: заморозка и назначение приехали волной В5 из
      // своих прав (`hold`, `assign`) и проверяются кейсом ниже.
      const onlyEstimate = (status: ServiceRequestStatus) =>
        from(status, approver).filter((to) => to !== 'on_hold' && to !== 'assigned');
      expect(onlyEstimate('estimate_review'), who).toEqual(['cancelled']);
      for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'estimate_review')) {
        expect(onlyEstimate(status), `${who}: ${status}`).toEqual([]);
      }
    }
  });

  /**
   * Полный набор дуг ИТ-службы после волны В5 — три источника, и ни один не даёт того, что по
   * матрице §6 остаётся за «Ведением»: ни приёмки работы, ни отмены из произвольного статуса.
   *
   * - `approveIt` — второй исход визы: «менять аппарат», то есть отмена **только** со сметы;
   * - `assign` — распределение: взять чужую заявку можно, лишь назначив на неё себя;
   * - `hold` — заморозка из любого рабочего статуса и «Решена».
   */
  it('после В5 у ИТ-службы три источника дуг: виза, назначение и заморозка', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(from('new', approver), who).toEqual(['assigned', 'on_hold']);
      // Пока смета на подписи, исполнителя не меняют (коридор назначения) — остаются исход визы и
      // заморозка.
      expect(from('estimate_review', approver), who).toEqual(['cancelled', 'on_hold']);
      // Приёмка и возврат на доработку — не её: «Решена» она может только придержать.
      expect(from('done', approver), who).toEqual(['on_hold']);
      // Закрытые статусы закрыты и для неё.
      for (const status of ['accepted', 'cancelled'] as const) {
        expect(from(status, approver), `${who}: ${status}`).toEqual([]);
      }
    }
  });

  /**
   * Виза не требует права хода (`serviceRequests.status`): согласующий заявки не ведёт, он
   * отвечает на один вопрос. Требуй мы это право, полномочие пришлось бы выдавать вместе с
   * возможностью двигать заявку по всему циклу — то есть отдавать ИТ работу «Ведения».
   */
  it('шагов «Ведения» у него нет: ни приёмки, ни согласования суммы, ни отмены из работы', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(canTransitionServiceStatus('estimate_review', 'in_work', approver), who).toBe(false);
      expect(canTransitionServiceStatus('done', 'accepted', approver), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'cancelled', approver), who).toBe(false);
      expect(canTransitionServiceStatus('new', 'cancelled', approver), who).toBe(false);
    }
  });

  it('надстройка и есть источник визы: без неё та же роль аппарат под замену не отправляет', () => {
    expect(canTransitionServiceStatus('estimate_review', 'cancelled', { role: 'shtab' })).toBe(
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
    // Распределение
    ['new', 'assigned', 'назначить исполнителей'],
    ['assigned', 'assigned', 'переназначить'],
    ['in_work', 'assigned', 'переназначить из работы'],
    // Коридор «Ведения»
    ['new', 'cancelled', 'отменить новую'],
    ['assigned', 'cancelled', 'отменить назначенную'],
    ['estimate_review', 'in_work', 'согласовать смету'],
    ['estimate_review', 'cancelled', 'отменить на согласовании'],
    ['in_work', 'cancelled', 'отменить работы'],
    ['done', 'accepted', 'принять работу'],
    ['done', 'in_work', 'вернуть на доработку'],
    ['on_hold', 'cancelled', 'отменить отложенную'],
    // Заморозка
    ['new', 'on_hold', 'отложить новую'],
    ['assigned', 'on_hold', 'отложить назначенную'],
    ['estimate_review', 'on_hold', 'отложить согласование'],
    ['in_work', 'on_hold', 'отложить работы'],
    // Коридор исполнителя
    ['assigned', 'in_work', 'принять в работу'],
    ['assigned', 'new', 'отказаться от заявки'],
    ['in_work', 'estimate_review', 'предъявить смету'],
    ['in_work', 'done', 'закрыть работы'],
    // Откаты
    ['accepted', 'done', 'откатить приёмку'],
    ['cancelled', 'new', 'вернуть отменённую в работу'],
    // Мёртвые статусы — до выпуска 2 заявки в них ведутся наравне с живыми
  ];

  it('каждая дуга проходима', () => {
    for (const [a, b, what] of ADMIN_ARCS) {
      expect(canTransitionServiceStatus(a, b, admin), `${what} (${a} → ${b})`).toBe(true);
    }
  });

  it('набор из каждого статуса — объединение шести таблиц', () => {
    expect(from('new', admin)).toEqual(['assigned', 'cancelled', 'on_hold']);
    expect(from('assigned', admin)).toEqual(['assigned', 'cancelled', 'in_work', 'new', 'on_hold']);
    expect(from('estimate_review', admin)).toEqual(['cancelled', 'in_work', 'on_hold']);
    expect(from('in_work', admin)).toEqual([
      'assigned',
      'cancelled',
      'done',
      'estimate_review',
      'on_hold',
    ]);
    // Из заморозки у администратора то же, что у «Ведения»: откатов отсюда нет (Р110), а возврат —
    // не дуга таблицы, а своя ручка.
    expect(from('on_hold', admin)).toEqual(['cancelled']);
    expect(from('done', admin)).toEqual(['accepted', 'in_work', 'on_hold']);
    expect(from('accepted', admin)).toEqual(['done']);
    expect(from('cancelled', admin)).toEqual(['new']);
    // Мёртвые статусы (`0197`): ходов нет и у администратора — заявок в них не бывает.
    expect(from('it_approved', admin)).toEqual([]);
    expect(from('diagnostics', admin)).toEqual([]);
  });

  /**
   * Чего нет и у администратора. Второй путь назад из «В работе» в смету сделал бы необязательным
   * подъём ревизии на повторном предъявлении, а на нём держится обесценивание обеих подписей (Н3).
   * Отмена из «Решена» стёрла бы предъявленный факт вместо возврата на доработку.
   */
  it('запертых дуг нет и у него: откат согласованной сметы и отмена предъявленной работы', () => {
    expect(canTransitionServiceStatus('in_work', 'estimate_review', admin, NOT_ASSIGNED)).toBe(
      true,
    );
    expect(SERVICE_ADMIN_ROLLBACKS.estimate_review).toEqual([]);
    expect(canTransitionServiceStatus('done', 'cancelled', admin)).toBe(false);
    // Из «Закрыта» — только откат приёмки: заново отменить принятую работу нечем.
    expect(canTransitionServiceStatus('accepted', 'cancelled', admin)).toBe(false);
    // «Решена», наоборот, откладывается — и это единственный ручной способ снять заявку с
    // автозакрытия, пока идёт разбирательство (Р106 ADR 0125, §6.2 плана переработки).
    expect(canTransitionServiceStatus('done', 'on_hold', admin)).toBe(true);
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
   * Рабочие статусы (§6.2): «Новая» (ждём решения заказчика), «Назначена» (исполнитель не
   * появится до среды), «Смета на согласовании» (нет денег до квартала) и «В работе». Перечень
   * явный, а не вычисленный из закрытых статусов: новый статус цикла обязан появиться здесь
   * строкой и ответить на вопрос «его-то откладывать можно?». Два мёртвых статуса стоят рядом с
   * живыми двойниками — до выпуска 2 заявка бывает и в них.
   */
  const HOLDABLE: ServiceRequestStatus[] = [
    'new',
    'assigned',
    'estimate_review',
    'in_work',
    // «Решена» — тоже: Р106 ADR 0125 её откладывал («ждём акт от сервиса»), и она же снимается
    // заморозкой с автозакрытия.
    'done',
  ];

  it('«Ведение» и администратор откладывают из рабочих статусов и «Решена» — и только из них', () => {
    expect(HOLDABLE).toHaveLength(5);
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
    // `held_from_status`.
    expect(HOLDABLE).toContain('done');
    for (const status of ['accepted', 'cancelled', 'on_hold'] as const) {
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
    for (const subject of [
      ...CUSTOMERS,
      observer,
      wasteOperator,
      namedExecutor,
      { role: null },
    ]) {
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
    expect(serviceResumeTarget({ status: 'in_work', heldFromStatus: 'assigned' })).toBe(null);
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
  const REQUIRE_REASON = new Set([
    'assigned→new', // отказ исполнителя и откат назначения
    'done→in_work', // возврат на доработку
  ]);

  it('обязательна на отмене, заморозке, отказе и возврате на доработку', () => {
    for (const a of SERVICE_REQUEST_STATUSES) {
      for (const b of SERVICE_REQUEST_STATUSES) {
        // Отмена — из любого статуса: она всегда закрывает заявку без результата. Заморозка — тоже
        // из любого (Р107): даты «отложена до» у неё нет, и на вопрос «когда ждать» отвечает
        // только причина.
        const expected = b === 'cancelled' || b === 'on_hold' || REQUIRE_REASON.has(`${a}→${b}`);
        expect(serviceStatusChangeRequiresReason(a, b), `${a} → ${b}`).toBe(expected);
      }
    }
  });

  /**
   * Отклонения сметы в перечне нет, и это следствие единого цикла (Н2): согласие и отказ ведут в
   * один статус — «В работе», — и пара «откуда → куда» их больше не различает. Причину отказа
   * требует тело ручки (`approveServiceEstimateSchema`), там, где известен сам исход; спрашивай мы
   * её здесь — согласование сметы тоже требовало бы объяснения.
   */
  it('дуга согласования сметы объяснения не требует: исход различает ручка', () => {
    expect(serviceStatusChangeRequiresReason('estimate_review', 'in_work')).toBe(false);
  });

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
      ['new', 'assigned'],
      ['assigned', 'in_work'],
      ['in_work', 'estimate_review'],
      ['estimate_review', 'in_work'],
      ['in_work', 'done'],
      ['done', 'accepted'],
      // Возврат из заморозки — тоже: причину сказали, когда откладывали, и требовать вторую
      // значило бы объяснять, почему заявка снова идёт своим ходом.
      ['on_hold', 'new'],
      ['on_hold', 'assigned'],
      ['on_hold', 'estimate_review'],
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

  it('отказ и откат назначения: заявка снова ничья и ждёт распределения', () => {
    expect(keysOf('assigned', 'new')).toEqual(['executor']);
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
    const RESUME_TARGETS: ServiceRequestStatus[] = [
      'new',
      'it_approved',
      'assigned',
      'diagnostics',
      'estimate_review',
      'in_work',
    ];
    for (const target of RESUME_TARGETS) {
      expect(keysOf('on_hold', target), `on_hold → ${target}`).toEqual(['hold']);
    }
  });

  /**
   * Откат отменённой — единственная дуга, снимающая пометку «рекомендована замена»: она объясняет,
   * почему заявку закрыли без ремонта, и существует только у отменённой (М5). Не сними её здесь —
   * возврат упрётся в `service_requests_replacement_check` ошибкой БД, а не отказом маршрута.
   */
  it('откат отменённой заявки возвращает её в состояние «ничего не делали»', () => {
    expect(keysOf('cancelled', 'new')).toEqual([
      'approval',
      'estimate',
      'executor',
      'itApproval',
      'replacement',
    ]);
    expect(serviceResetOnTransition('cancelled', 'new').replacement).toBe(true);
    // Пометку снимает только этот путь: в остальных переходах её у заявки и не бывает.
    for (const a of SERVICE_REQUEST_STATUSES) {
      for (const b of SERVICE_REQUEST_STATUSES) {
        if (a === 'cancelled' && b === 'new') continue;
        expect(serviceResetOnTransition(a, b).replacement, `${a} → ${b}`).toBe(false);
      }
    }
  });

  /**
   * Согласование и отклонение сметы не стирают ничего, и это не пропуск: обе подписи обесценивает
   * подъём ревизии на следующем предъявлении (Н3). Стирай мы снимок здесь — согласие стирало бы
   * собственный снимок: дуга у согласия и отказа одна.
   */
  it('решение по смете снимков не стирает: их обесценивает ревизия', () => {
    expect(keysOf('estimate_review', 'in_work')).toEqual([]);
    expect(keysOf('in_work', 'estimate_review')).toEqual([]);
  });

  it('возврат на доработку стирает факт закрытия, откат приёмки — только снимок приёмки', () => {
    expect(keysOf('done', 'in_work')).toEqual(['completion']);
    // Факт закрытия при откате приёмки сохраняется целиком: работу предъявляли, её просто не
    // приняли ещё раз.
    expect(keysOf('accepted', 'done')).toEqual(['acceptance']);
  });

  it('движение вперёд не стирает ничего', () => {
    for (const [a, b] of [
      ['new', 'assigned'],
      ['assigned', 'in_work'],
      ['in_work', 'estimate_review'],
      ['in_work', 'done'],
      ['done', 'accepted'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(keysOf(a, b), `${a} → ${b}`).toEqual([]);
    }
  });

  it('переназначение матрицей возвратов не описано: его сброс делает своя ручка', () => {
    // Смену исполнителя (`assigned | in_work → assigned`) выполняет ручка назначения: она стирает
    // незавершённую смету прежнего исполнителя вместе со снимком согласования. Дугой назад
    // переназначение не является, и матрица возвратов о нём молчит намеренно.
    expect(keysOf('assigned', 'assigned')).toEqual([]);
    expect(keysOf('in_work', 'assigned')).toEqual([]);
  });
});

/**
 * Кого ждут (Р35, Н3). Сторона считается по **строке заявки**, а не по одному статусу: в «Смете на
 * согласовании» ждут двоих по очереди — сперва ИТ, потом «Ведение», — и различает их только
 * ревизионная виза. Сама сторона определяется правами и типом контрагента, а не именем роли: у
 * «Ведения» роль «Штаб» или «Отдел», у подрядчика роль «Оператор (внешний исполнитель)».
 */
describe('кого ждёт заявка', () => {
  /** Заявка без сметы: ревизия нулевая, визы нет — так выглядит всё до первого предъявления. */
  const row = (status: ServiceRequestStatus) => ({
    status,
    estimateRevision: 0,
    itApprovedEstimateRevision: null,
  });

  it('сторона следует из статуса, а в смете — из визы', () => {
    const byStatus: Record<ServiceRequestStatus, ServiceWaitingOn> = {
      // «Новую» ждёт тот, кто распределяет: визы на входе больше нет (Н3).
      new: 'operator',
      it_approved: 'operator', // legacy: снимается выпуском 2
      assigned: 'service',
      diagnostics: 'service', // legacy: снимается выпуском 2
      // Без визы текущей ревизии смету ждёт ИТ-служба, а не «Ведение».
      estimate_review: 'it',
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
    // «Ведение». Появится его шаг — появится и значение вместе с веткой предиката. А `hold` — не
    // сторона, а объяснение остановки: в списке у отложенной должна стоять причина, а не пустая
    // клетка, поэтому у неё своё значение, а не `nobody`.
    expect([...SERVICE_WAITING_ON]).toEqual(['it', 'operator', 'service', 'hold', 'nobody']);
  });

  /**
   * Четыре состояния сметы (§8, тест «`serviceWaitingOn` по строке заявки»): визы нет; виза стоит
   * на текущей ревизии; виза осталась от прошлой ревизии; виза входная, старого образца. Три из
   * четырёх ждут ИТ, и только второе — «Ведение».
   */
  it('в смете ждут ИТ, пока нет визы текущей ревизии, и «Ведение» — после неё', () => {
    const review = (estimateRevision: number, itApprovedEstimateRevision: number | null) =>
      serviceRequestWaitingOn({
        status: 'estimate_review',
        estimateRevision,
        itApprovedEstimateRevision,
      });
    expect(review(1, null), 'визы нет').toBe('it');
    expect(review(1, 1), 'виза на текущей ревизии').toBe('operator');
    // Смету предъявили заново — подпись осталась от прошлой ревизии и к делу не относится.
    expect(review(2, 1), 'виза от прошлой ревизии').toBe('it');
    // Заявка с входной визой старого образца: ревизия пуста, и визой сметы она не считается (Н3).
    expect(review(1, null), 'входная виза старого образца').toBe('it');
    expect(hasCurrentItApproval({ estimateRevision: 1, itApprovedEstimateRevision: 1 })).toBe(true);
    expect(hasCurrentItApproval({ estimateRevision: 2, itApprovedEstimateRevision: 1 })).toBe(
      false,
    );
    expect(hasCurrentItApproval({ estimateRevision: 1, itApprovedEstimateRevision: null })).toBe(
      false,
    );
  });

  /**
   * Прежняя функция от одного статуса осталась ради зовущих, которых переключают волны В3 и В6.
   * Отвечать она обязана как строка без визы — то есть «Ждёт ИТ» на смете: соврать в другую
   * сторону значило бы убрать заявку из очереди ИТ до того, как он её подписал.
   */
  it('устаревшая функция от статуса отвечает как заявка без визы', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(serviceWaitingOn(status), status).toBe(serviceRequestWaitingOn(row(status)));
    }
    expect(serviceWaitingOn('estimate_review')).toBe('it');
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
    // Сторона ИТ — тоже по праву, а не по надстройке: у администратора виза есть, и смета без
    // подписи ждёт в том числе его.
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(isWaitingOn(approver, 'it'), who).toBe(true);
      expect(isWaitingOn(approver, 'service'), who).toBe(false);
    }
    expect(isWaitingOn(admin, 'it')).toBe(true);
    // У «Ведения» визы нет: очередь ИТ — не его работа.
    expect(isWaitingOn(shtabOperator, 'it')).toBe(false);
    expect(isWaitingOn(service, 'it')).toBe(false);
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

  it('очередь «ждёт меня» сходится со статусом: ждут того, чей сейчас шаг', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      const waiting = serviceRequestWaitingOn(row(status));
      expect(isWaitingOn(shtabOperator, waiting), status).toBe(waiting === 'operator');
      expect(isWaitingOn(service, waiting), status).toBe(waiting === 'service');
      // У того, кого ждут, в этом статусе есть и что сделать: пустой коридор в своей очереди
      // означал бы заявку, которая ждёт человека без единой доступной ему кнопки. Закрытая и
      // отложенная из правила выпадают: у первой шага нет вовсе, у второй он не в цикле — заявку
      // возвращают своей ручкой (`canResumeService`), а не дугой коридора.
      const subject = waiting === 'service' ? service : shtabOperator;
      // Мёртвые статусы (`0197`) из правила выпадают третьими: `waitingOn` отвечает за них по
      // живому двойнику — функцию зовут и на строках истории, — но ходов у них нет и быть не
      // должно, потому что нет самих заявок.
      const dead = status === 'it_approved' || status === 'diagnostics';
      if (waiting !== 'nobody' && waiting !== 'hold' && !dead) {
        expect(
          allowedServiceStatusTransitions(status, subject, BY_COUNTERPARTY).length,
          status,
        ).toBeGreaterThan(0);
      }
    }
    // Сторона ИТ проверяется отдельно: её единственный ход — «менять аппарат» из сметы, и он есть
    // ровно там, где её и ждут.
    expect(allowedServiceStatusTransitions('estimate_review', shtabIt).length).toBeGreaterThan(0);
  });
});

/**
 * Подпись шага (Р101): один словарь на все стороны — портал приписывает лицо сам («Вам: согласовать
 * смету» тому, за кем ход, и «ждёт оператора» остальным). Прежних словарей было два, и они
 * разъехались на первом же новом статусе: `serviceTodoLabel` знал три статуса из девяти. Пустая
 * подпись здесь означает «ждать нечего», и статус без хода обязан быть пустым ровно потому, что
 * портал показывает эту строку как призыв к действию.
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
   * Мёртвые статусы отвечают подписью своего живого двойника: заявка, застрявшая в `diagnostics` до
   * выпуска 2, обязана звать к тому же шагу, что «В работе», — иначе человек прочитает в списке
   * призыв к действию, которого в новом цикле нет.
   */
  it('мёртвые статусы зовут к шагу своего живого двойника', () => {
    expect(serviceStepLabels.it_approved).toBe(serviceStepLabels.new);
    expect(serviceStepLabels.diagnostics).toBe(serviceStepLabels.in_work);
  });

  it('словарь отвечает на каждый статус: новый статус обязан получить свою строку', () => {
    expect(Object.keys(serviceStepLabels).sort()).toEqual([...SERVICE_REQUEST_STATUSES].sort());
  });
});
