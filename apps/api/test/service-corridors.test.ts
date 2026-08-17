import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  allowedServiceStatusTransitions,
  canTransitionServiceStatus,
  isWaitingOn,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  serviceResetOnTransition,
  serviceStatusChangeRequiresReason,
  serviceWaitingOn,
  type AccessSubject,
  type ServiceRequestStatus,
  type ServiceTransitionReset,
  type ServiceWaitingOn,
} from '@technic/contracts';

/**
 * Коридоры заявки на обслуживание оргтехники (ADR 0085, Р17).
 *
 * Главный тест модуля: цикл ведут три стороны, право `serviceRequests.status` у двух из них одно и
 * то же, а доступные им дуги — разные. По общей таблице переходов оператор оргтехники смог бы
 * выполнить шаги сервиса: взять заявку в диагностику, предъявить смету, закрыть работы. Портал такие
 * кнопки не рисует, но портал и не является защитой — отказывает сервер, и проверяется здесь именно
 * он: одна функция `allowedServiceStatusTransitions` отвечает обоим.
 *
 * Наборы сравниваются отсортированными: коридор — это множество доступных дуг, а не
 * последовательность, и порядок в нём не значит ничего.
 */

/** Сервис: роль исполнителя плюс контрагент типа `service` — сторону задаёт тип, а не роль. */
const service: AccessSubject = { role: 'operator', counterpartyType: 'service' };

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

const from = (status: ServiceRequestStatus, subject: AccessSubject | null | undefined) =>
  [...allowedServiceStatusTransitions(status, subject)].sort();

describe('коридор исполнителя: сервис делает только то, что делает сам', () => {
  it('берёт в диагностику и отказывается, предъявляет смету, закрывает и переоткрывает', () => {
    // Отказ возвращает заявку оператору, а не в «Новую»: виза ИТ уже дана (Р51).
    expect(from('assigned', service)).toEqual(['diagnostics', 'it_approved']);
    expect(from('diagnostics', service)).toEqual(['estimate_review']);
    expect(from('in_work', service)).toEqual(['diagnostics', 'done']);
  });

  it('в остальных статусах ход заявки не его: ждут не сервис', () => {
    // «Новую» заявку сервис не видит вовсе (Р22), смету согласует не он, приёмку делает оператор,
    // а из терминальных статусов заявку не двигает никто, кроме администратора.
    for (const status of [
      'new',
      'it_approved',
      'estimate_review',
      'done',
      'accepted',
      'cancelled',
    ] as const) {
      expect(from(status, service), status).toEqual([]);
    }
  });

  it('не согласует смету, не принимает работу, не отменяет и не откатывает', () => {
    // Решения заказчика: согласование, отклонение сметы, приёмка и возврат на доработку.
    expect(canTransitionServiceStatus('estimate_review', 'in_work', service)).toBe(false);
    expect(canTransitionServiceStatus('estimate_review', 'diagnostics', service)).toBe(false);
    expect(canTransitionServiceStatus('done', 'accepted', service)).toBe(false);
    expect(canTransitionServiceStatus('done', 'in_work', service)).toBe(false);
    // Виза ИТ — не его решение вовсе: сервис не подтверждает сам себе, что его надо звать (Р55).
    expect(canTransitionServiceStatus('new', 'it_approved', service)).toBe(false);
    // Назначение и переназначение — тоже решение заказчика: исполнитель себе работу не выбирает.
    expect(canTransitionServiceStatus('it_approved', 'assigned', service)).toBe(false);
    expect(canTransitionServiceStatus('assigned', 'assigned', service)).toBe(false);
    expect(canTransitionServiceStatus('diagnostics', 'assigned', service)).toBe(false);
    // Отмена: ни из одного статуса.
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(canTransitionServiceStatus(status, 'cancelled', service), status).toBe(false);
    }
    // Административные откаты. `assigned → new` в этот перечень не входит намеренно: у сервиса это
    // не откат, а собственный отказ от работы (Р20), и дуга у них общая.
    for (const [a, b] of [
      ['it_approved', 'new'],
      ['diagnostics', 'assigned'],
      ['estimate_review', 'diagnostics'],
      ['done', 'in_work'],
      ['accepted', 'done'],
      ['cancelled', 'new'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(canTransitionServiceStatus(a, b, service), `${a} → ${b}`).toBe(false);
    }
  });

  it('коридор задаёт тип контрагента, а не роль: исполнитель чужого модуля не двигает ничего', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, wasteOperator), status).toEqual([]);
      expect(
        from(status, { role: 'operator', counterpartyType: 'vehicle_lessor' }),
        status,
      ).toEqual([]);
      // Исполнитель без контрагента — то же самое: неизвестно, что он исполняет.
      expect(from(status, { role: 'operator', counterpartyType: null }), status).toEqual([]);
    }
  });
});

describe('коридор оператора оргтехники: решения заказчика и ни одного шага исполнителя', () => {
  it('назначает и переназначает, согласует и отклоняет, принимает, возвращает и отменяет', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      // Из «Новой» оператор только отменяет: назначить сервис до визы ИТ нечем (Р51).
      expect(from('new', operator), who).toEqual(['cancelled']);
      expect(from('it_approved', operator), who).toEqual(['assigned', 'cancelled']);
      // Переназначение — тот же статус, другой исполнитель (Р20).
      expect(from('assigned', operator), who).toEqual(['assigned', 'cancelled']);
      expect(from('diagnostics', operator), who).toEqual(['assigned', 'cancelled']);
      expect(from('estimate_review', operator), who).toEqual([
        'cancelled',
        'diagnostics',
        'in_work',
      ]);
      expect(from('in_work', operator), who).toEqual(['cancelled']);
      expect(from('done', operator), who).toEqual(['accepted', 'in_work']);
      // Терминальные статусы: вернуть заявку из них может только администратор.
      expect(from('accepted', operator), who).toEqual([]);
      expect(from('cancelled', operator), who).toEqual([]);
    }
  });

  /**
   * Ключевая проверка модуля. Право `serviceRequests.status` у оператора и у сервиса одно и то же,
   * и по общей таблице переходов оператор выполнил бы работу исполнителя: взял бы заявку в
   * диагностику, предъявил бы смету за него и закрыл бы работы, которых не делал. Коридоры на то и
   * разведены — сервер обязан отказать, независимо от того, нарисовал ли портал кнопку.
   */
  it('не берёт в диагностику, не предъявляет смету и не закрывает работы', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(canTransitionServiceStatus('assigned', 'diagnostics', operator), who).toBe(false);
      expect(canTransitionServiceStatus('diagnostics', 'estimate_review', operator), who).toBe(
        false,
      );
      expect(canTransitionServiceStatus('in_work', 'done', operator), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'diagnostics', operator), who).toBe(false);
      // Отказаться от заявки за сервис он тоже не может: отказ — шаг исполнителя, у оператора на
      // этот случай есть переназначение.
      expect(canTransitionServiceStatus('assigned', 'it_approved', operator), who).toBe(false);
      // И визы у него нет: решение «звать ли сервис» принимает отдел ИТ, а не тот, кто зовёт.
      expect(canTransitionServiceStatus('new', 'it_approved', operator), who).toBe(false);
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

describe('коридор ИТ: одно решение — звать ли внешний сервис', () => {
  it('визирует и отклоняет «Новую», и больше не делает ничего', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(from('new', approver), who).toEqual(['cancelled', 'it_approved']);
      // Дальше цикл ведут другие: назначает оператор, работает сервис, принимает снова оператор.
      for (const status of [
        'it_approved',
        'assigned',
        'diagnostics',
        'estimate_review',
        'in_work',
        'done',
        'accepted',
        'cancelled',
      ] as const) {
        expect(from(status, approver), `${who}: ${status}`).toEqual([]);
      }
    }
  });

  /**
   * Виза не требует права хода (`serviceRequests.status`): согласующий заявки не ведёт, он
   * отвечает на один вопрос. Требуй мы это право, полномочие пришлось бы выдавать вместе с
   * возможностью двигать заявку по всему циклу — то есть отдавать ИТ работу оператора.
   */
  it('шагов оператора у него нет: ни назначения, ни согласования сметы, ни приёмки', () => {
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(canTransitionServiceStatus('it_approved', 'assigned', approver), who).toBe(false);
      expect(canTransitionServiceStatus('estimate_review', 'in_work', approver), who).toBe(false);
      expect(canTransitionServiceStatus('done', 'accepted', approver), who).toBe(false);
      expect(canTransitionServiceStatus('in_work', 'cancelled', approver), who).toBe(false);
    }
  });

  it('надстройка и есть источник визы: без неё та же роль не визирует', () => {
    expect(canTransitionServiceStatus('new', 'it_approved', { role: 'shtab' })).toBe(false);
    expect(
      canTransitionServiceStatus('new', 'it_approved', {
        role: 'shtab',
        addons: ['office_equipment_operator'],
      }),
    ).toBe(false);
  });
});

/**
 * Администратор получает **объединение** коридоров: он разбирает ошибки и доводит заявку за любую
 * сторону. Перебор положительный — каждая дуга обоих коридоров плюс откаты: запрещающий тест
 * пропустил бы зависшую заявку, разобрать которую администратору оказалось бы нечем.
 */
describe('администратор проходит каждую дугу всех коридоров', () => {
  const ADMIN_ARCS: [ServiceRequestStatus, ServiceRequestStatus, string][] = [
    // Коридор ИТ
    ['new', 'it_approved', 'завизировать от ИТ'],
    // Коридор оператора
    ['it_approved', 'assigned', 'назначить сервис'],
    ['new', 'cancelled', 'отменить новую'],
    ['assigned', 'assigned', 'переназначить'],
    ['assigned', 'cancelled', 'отменить назначенную'],
    ['diagnostics', 'assigned', 'переназначить из диагностики'],
    ['diagnostics', 'cancelled', 'отменить из диагностики'],
    ['estimate_review', 'in_work', 'согласовать смету'],
    ['estimate_review', 'diagnostics', 'отклонить смету'],
    ['estimate_review', 'cancelled', 'отменить на согласовании'],
    ['in_work', 'cancelled', 'отменить работы'],
    ['done', 'accepted', 'принять работу'],
    ['done', 'in_work', 'вернуть на доработку'],
    // Коридор исполнителя
    ['assigned', 'diagnostics', 'взять в диагностику'],
    ['assigned', 'it_approved', 'отказаться от заявки'],
    ['diagnostics', 'estimate_review', 'предъявить смету'],
    ['in_work', 'done', 'закрыть работы'],
    ['in_work', 'diagnostics', 'переоткрыть смету'],
    // Откаты
    ['it_approved', 'new', 'откатить визу ИТ'],
    ['accepted', 'done', 'откатить приёмку'],
    ['cancelled', 'new', 'вернуть отменённую в работу'],
  ];

  it('каждая дуга проходима', () => {
    for (const [a, b, what] of ADMIN_ARCS) {
      expect(canTransitionServiceStatus(a, b, admin), `${what} (${a} → ${b})`).toBe(true);
    }
  });

  it('набор из каждого статуса — объединение четырёх таблиц', () => {
    expect(from('new', admin)).toEqual(['cancelled', 'it_approved']);
    expect(from('it_approved', admin)).toEqual(['assigned', 'cancelled', 'new']);
    expect(from('assigned', admin)).toEqual([
      'assigned',
      'cancelled',
      'diagnostics',
      'it_approved',
    ]);
    expect(from('diagnostics', admin)).toEqual(['assigned', 'cancelled', 'estimate_review']);
    expect(from('estimate_review', admin)).toEqual(['cancelled', 'diagnostics', 'in_work']);
    expect(from('in_work', admin)).toEqual(['cancelled', 'diagnostics', 'done']);
    expect(from('done', admin)).toEqual(['accepted', 'in_work']);
    expect(from('accepted', admin)).toEqual(['done']);
    expect(from('cancelled', admin)).toEqual(['new']);
  });

  /**
   * Чего нет и у администратора. Второй путь назад из «В работе» сделал бы необязательным
   * единственный способ изменить согласованную смету — переоткрытие в «Диагностику» (Р14). Отмена
   * из «Ожидает приёмки» стёрла бы предъявленный факт вместо возврата на доработку.
   */
  it('запертых дуг нет и у него: правка согласованной сметы и отмена предъявленной работы', () => {
    expect(canTransitionServiceStatus('in_work', 'estimate_review', admin)).toBe(false);
    expect(canTransitionServiceStatus('done', 'cancelled', admin)).toBe(false);
    // Из «Принята» — только откат приёмки: заново отменить принятую работу нечем.
    expect(canTransitionServiceStatus('accepted', 'cancelled', admin)).toBe(false);
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

  it('субъекта нет — хода нет: без роли и без субъекта вовсе', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(from(status, { role: null }), status).toEqual([]);
      expect(from(status, null), status).toEqual([]);
      expect(from(status, undefined), status).toEqual([]);
    }
  });

  /**
   * Перебором по всем субъектам портала: непустой коридор бывает ровно у трёх — сервис, оператор
   * оргтехники (обе базовые роли) и администратор. Новый субъект, получивший ход заявки молча,
   * обязан уронить этот перечень.
   */
  it('ход заявки есть только у сервиса, оператора оргтехники и администратора', () => {
    const movers = ACCESS_PROFILES.filter((subject) =>
      SERVICE_REQUEST_STATUSES.some(
        (status) => allowedServiceStatusTransitions(status, subject).length > 0,
      ),
    );
    expect(movers.map(accessProfileLabel)).toEqual([
      'Администратор',
      'Оператор (внешний исполнитель) — Сервисная компания',
      'Штаб + Оператор (оргтехника)',
      // Площадка — базовая роль обеих надстроек с шага prepare этапа 8 (ADR 0113): роль, на
      // которую переведут штаб, обязана двигать заявку так же, как он.
      'Площадка + Оператор (оргтехника)',
      'Отдел + Оператор (оргтехника)',
      'Штаб + Согласование ИТ',
      'Площадка + Согласование ИТ',
      'Отдел + Согласование ИТ',
    ]);
  });

  /**
   * Отмена из «Ожидает приёмки» запрещена всем без исключения (§5.2): работа предъявлена, и
   * «отменить» вместо «вернуть на доработку» стёрло бы предъявленный факт. Перебором по всем
   * субъектам, потому что запрет здесь не ролевой, а свойство самой дуги.
   */
  it('отмена из «Ожидает приёмки» закрыта каждому', () => {
    for (const subject of ACCESS_PROFILES) {
      expect(
        canTransitionServiceStatus('done', 'cancelled', subject),
        accessProfileLabel(subject),
      ).toBe(false);
    }
  });
});

/**
 * Причина обязательна там, где переход отменяет чужую работу: без неё в истории останется пара
 * строк, по которой не понять, ошиблись сервисом, отказался исполнитель или смета оказалась вдвое
 * дороже. Проверяется полной таблицей — предикат отвечает на любую пару статусов, и «требует» здесь
 * определяется дугой, а не тем, кто по ней идёт.
 */
describe('причина перехода', () => {
  const REQUIRE_REASON = new Set([
    'assigned→it_approved', // отказ исполнителя и откат назначения
    'it_approved→new', // откат визы ИТ
    'estimate_review→diagnostics', // отклонение сметы
    'in_work→diagnostics', // переоткрытие сметы
    'done→in_work', // возврат на доработку
  ]);

  it('обязательна на отмене, отказе, отклонении, переоткрытии и возврате', () => {
    for (const a of SERVICE_REQUEST_STATUSES) {
      for (const b of SERVICE_REQUEST_STATUSES) {
        // Отмена — из любого статуса: она всегда закрывает заявку без результата.
        const expected = b === 'cancelled' || REQUIRE_REASON.has(`${a}→${b}`);
        expect(serviceStatusChangeRequiresReason(a, b), `${a} → ${b}`).toBe(expected);
      }
    }
  });

  it('движение вперёд объяснений не требует', () => {
    for (const [a, b] of [
      ['new', 'it_approved'],
      ['it_approved', 'assigned'],
      ['assigned', 'diagnostics'],
      ['diagnostics', 'estimate_review'],
      ['estimate_review', 'in_work'],
      ['in_work', 'done'],
      ['done', 'accepted'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(serviceStatusChangeRequiresReason(a, b), `${a} → ${b}`).toBe(false);
    }
  });
});

/**
 * Что заявка теряет, возвращаясь назад (§5.4). Заявка после возврата не должна выглядеть так, будто
 * её и не двигали: снимок согласования под чужой ревизией сметы или факт закрытия у заявки «в
 * работе» означали бы решение, которого никто не принимал.
 */
describe('сброс при возвратах и откатах', () => {
  const resetKeys = (reset: ServiceTransitionReset) =>
    (Object.keys(reset) as (keyof ServiceTransitionReset)[]).filter((key) => reset[key]).sort();

  const keysOf = (a: ServiceRequestStatus, b: ServiceRequestStatus) =>
    resetKeys(serviceResetOnTransition(a, b));

  it('отказ и откат назначения: заявка снова ничья, но виза ИТ при ней остаётся', () => {
    expect(keysOf('assigned', 'it_approved')).toEqual(['executor']);
  });

  /**
   * Откат самой визы — единственная дуга, снимающая подпись отдела ИТ: заявка возвращается к нему
   * на решение, и сохранённая виза означала бы согласие, которого больше нет.
   */
  it('откат визы снимает подпись ИТ и ничего больше', () => {
    expect(keysOf('it_approved', 'new')).toEqual(['itApproval']);
  });

  it('отмена из любого статуса снимает исполнителя и согласование', () => {
    // Отменённая заявка остаётся историей того, что собирались чинить, но ни исполнителя, ни
    // согласованной сметы у неё больше нет. Смета при этом сохраняется: по ней и объясняют, почему
    // отменили.
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(keysOf(status, 'cancelled'), status).toEqual(['approval', 'executor']);
    }
  });

  it('откат отменённой заявки возвращает её в состояние «ничего не делали»', () => {
    expect(keysOf('cancelled', 'new')).toEqual(['approval', 'estimate', 'executor', 'itApproval']);
  });

  it('возврат в диагностику отменяет согласование, а смету и её ревизию оставляет', () => {
    // Отклонение сметы и её переоткрытие: снимок согласования недействителен, потому что относился
    // к другой ревизии.
    expect(keysOf('estimate_review', 'diagnostics')).toEqual(['approval']);
    expect(keysOf('in_work', 'diagnostics')).toEqual(['approval']);
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
      ['diagnostics', 'estimate_review'],
      ['estimate_review', 'in_work'],
      ['in_work', 'done'],
      ['done', 'accepted'],
    ] as [ServiceRequestStatus, ServiceRequestStatus][]) {
      expect(keysOf(a, b), `${a} → ${b}`).toEqual([]);
    }
    // Исключение из правила «вперёд ничего не теряется» — взятие в диагностику: ветка сброса
    // написана по цели перехода, а не по его направлению. В «Назначен сервис» согласования ещё не
    // бывает, поэтому снимать нечего, и заявка ничего не теряет на деле.
    expect(keysOf('assigned', 'diagnostics')).toEqual(['approval']);
  });

  it('переназначение матрицей возвратов не описано: его сброс делает своя ручка', () => {
    // Смену исполнителя (`assigned | diagnostics → assigned`) выполняет `PATCH /:id/service`: она
    // стирает незавершённую смету прежнего сервиса вместе со снимком согласования. Дугой назад
    // переназначение не является, и матрица возвратов о нём молчит намеренно.
    expect(keysOf('assigned', 'assigned')).toEqual([]);
    expect(keysOf('diagnostics', 'assigned')).toEqual([]);
  });
});

/**
 * Кого ждут (Р35). Сторона определяется правами и типом контрагента, а не именем роли: у оператора
 * оргтехники роль «Штаб» или «Отдел», у сервиса роль «Оператор (внешний исполнитель)». Сравнение
 * `waitingOn` с ролью напрямую отправило бы очередь «ждёт меня» не тем людям.
 */
describe('кого ждёт заявка', () => {
  it('сторона следует из статуса', () => {
    const byStatus: Record<ServiceRequestStatus, ServiceWaitingOn> = {
      // «Новая» ждёт отдел ИТ, а не оператора: до визы назначать сервис нечем (Р51).
      new: 'it',
      it_approved: 'operator',
      assigned: 'service',
      diagnostics: 'service',
      estimate_review: 'operator',
      in_work: 'service',
      done: 'operator',
      accepted: 'nobody',
      cancelled: 'nobody',
    };
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(serviceWaitingOn(status), status).toBe(byStatus[status]);
    }
    // Значение `customer` не заведено: заказчик в цикле решений не участвует — приёмку делает
    // оператор. Появится его шаг — появится и значение вместе с веткой предиката.
    expect([...SERVICE_WAITING_ON]).toEqual(['it', 'operator', 'service', 'nobody']);
  });

  it('сторону задают права, а не роль: у штаба-оператора роль «Штаб», а сторона — оператор', () => {
    for (const operator of OPERATORS) {
      const who = accessProfileLabel(operator);
      expect(isWaitingOn(operator, 'operator'), who).toBe(true);
      expect(isWaitingOn(operator, 'service'), who).toBe(false);
    }
    // У сервиса роль — «Оператор (внешний исполнитель)», а сторона его — `service`: совпадение имён
    // здесь ровно то, из-за которого сравнивать `waitingOn` с ролью нельзя.
    expect(isWaitingOn(service, 'service')).toBe(true);
    expect(isWaitingOn(service, 'operator')).toBe(false);
    // Та же роль у исполнителя чужого модуля — и ни одной стороны: решает тип контрагента.
    expect(isWaitingOn(wasteOperator, 'service')).toBe(false);
    expect(isWaitingOn(wasteOperator, 'operator')).toBe(false);
    // Администратор стоит на стороне оператора (право назначения у него есть), но сервисом не
    // становится: заявку он ведёт за компанию, а не за подрядчика.
    expect(isWaitingOn(admin, 'operator')).toBe(true);
    expect(isWaitingOn(admin, 'service')).toBe(false);
    // Сторона ИТ — тоже по праву, а не по надстройке: у администратора виза есть, и «Новая»
    // ждёт в том числе его.
    for (const approver of IT_APPROVERS) {
      const who = accessProfileLabel(approver);
      expect(isWaitingOn(approver, 'it'), who).toBe(true);
      expect(isWaitingOn(approver, 'operator'), who).toBe(false);
      expect(isWaitingOn(approver, 'service'), who).toBe(false);
    }
    expect(isWaitingOn(admin, 'it')).toBe(true);
    // У оператора визы нет: очередь ИТ — не его работа.
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

  it('очередь «ждёт меня» сходится со статусом: ждут того, чей сейчас шаг', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      const waiting = serviceWaitingOn(status);
      expect(isWaitingOn(shtabOperator, waiting), status).toBe(waiting === 'operator');
      expect(isWaitingOn(service, waiting), status).toBe(waiting === 'service');
      // У того, кого ждут, в этом статусе есть и что сделать: пустой коридор в своей очереди
      // означал бы заявку, которая ждёт человека без единой доступной ему кнопки.
      const subject = waiting === 'service' ? service : shtabOperator;
      if (waiting !== 'nobody') {
        expect(allowedServiceStatusTransitions(status, subject).length, status).toBeGreaterThan(0);
      }
    }
  });
});
