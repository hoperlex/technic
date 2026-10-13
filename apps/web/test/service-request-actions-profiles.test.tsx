import { describe, expect, it } from 'vitest';
import {
  attachableServiceFileKinds,
  OFFICE_EQUIPMENT_PROFILE_REGISTRY,
  type AuthUser,
  type ServiceRequestDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { permissionChecks } from '@entities/session';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  serviceExecutor,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import type { ServiceRequestModals } from '../src/pages/service/serviceRequestModals';
import {
  serviceActionRow,
  serviceExecutorAssignment,
} from '../src/pages/service/serviceRequestRow';

/**
 * Guard of the action set by access profile (plan `docs/office-equipment-workflow-fixes-plan.md`,
 * Р5): what each of the four profiles of `OFFICE_EQUIPMENT_PROFILE_REGISTRY` is offered, checked
 * as a SET over the real action builder, not piece by piece.
 *
 * Availability is decided by contract predicates, and a profile's menu is the sum of a dozen of
 * them: a change to one predicate moves an item for one profile and nobody notices until the
 * owner walks the roles again. Each scenario ships with the decision it guards (plan §Р5): this
 * file starts with the estimate scenarios of stage Э2 (Р6); the scenarios of the later stages are
 * added by them (the consumables scenarios of stage Э4 — Р7, Р8 — are the last two blocks).
 */

/** Windows that open nothing: the item list does not depend on what the windows are. */
const MODALS: ServiceRequestModals = {
  assign: () => {},
  estimate: () => {},
  approval: () => {},
  disputeResolution: () => {},
  consumables: () => {},
  complete: () => {},
  issue: () => {},
  accept: () => {},
  cancel: () => {},
  hold: () => {},
  urgency: () => {},
  chat: () => {},
  moveEquipment: () => {},
  ask: () => {},
  close: () => {},
  pending: false,
  node: null,
};

const RUN = { start: () => {}, approve: () => {}, rollbackStart: () => {} };

const DOCUMENT_FEATURES = ['service_estimate_document_mode', 'service_estimate_exemption'] as const;

function itemsFor(request: ServiceRequestDto, user: AuthUser) {
  return serviceRequestMenuItems(request, {
    user,
    can: permissionChecks(user).can,
    modals: MODALS,
    run: RUN,
  });
}

function keysFor(request: ServiceRequestDto, user: AuthUser): string[] {
  return itemsFor(request, user).map((item) => item.key);
}

/** Every estimate action of the set: the money step, the three decisions and the dispute. */
const ESTIMATE_KEYS = [
  'estimate',
  'approve',
  'reject',
  'reopen',
  'estimate-dispute',
  'estimate-dispute-resolve',
];

const IT = OFFICE_EQUIPMENT_PROFILE_REGISTRY.it.label;
const SERVICE = OFFICE_EQUIPMENT_PROFILE_REGISTRY.service.label;

/** The own system administrator (`it` profile), named on the request as `user-9`. */
const itAdmin = serviceInHouseExecutor({ features: [...DOCUMENT_FEATURES] });
/** The service centre's operator (`service` profile), the request assigned to his company. */
const contractor = serviceExecutor({ features: [...DOCUMENT_FEATURES] });

const NAMED_ONLY = {
  executors: [
    { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
  ],
  service: null,
} satisfies Partial<ServiceRequestDto>;

const WORKING: ServiceRequestStatus[] = ['new', 'in_work', 'on_hold', 'done', 'accepted'];

describe(`${IT}: на внутренней заявке нет ни одного пункта объёма работ`, () => {
  it.each(WORKING)('статус «%s», в том числе с историческим предъявлением', (status) => {
    for (const request of [
      serviceRequest({ status, ...NAMED_ONLY }),
      // A pending estimate left from before ADR 0174: nobody answers it any more.
      estimatePendingServiceRequest({ status, ...NAMED_ONLY }),
    ]) {
      const keys = keysFor(request, itAdmin);
      for (const key of ESTIMATE_KEYS) expect(keys, `${status}: ${key}`).not.toContain(key);
    }
  });
});

describe(`${IT} на смешанном назначении: объём работ — подрядчика (Р6)`, () => {
  it('ни предъявления, ни возврата в правку, ни подшивки вида «Объём работ»', () => {
    const inWork = assignedServiceRequest({ status: 'in_work' });
    const pending = estimatePendingServiceRequest({
      status: 'in_work',
      executors: inWork.executors,
      service: inWork.service,
    });
    // The anchor: he is a real side of this request — the contractor's step is not his only
    // because the estimate is not, not because he has no part in the request.
    expect(serviceExecutorAssignment(inWork, itAdmin).isNamedExecutor).toBe(true);

    expect(keysFor(inWork, itAdmin)).not.toContain('estimate');
    expect(keysFor(pending, itAdmin)).not.toContain('reopen');
    expect(
      attachableServiceFileKinds(
        'in_work',
        'finance',
        itAdmin,
        serviceExecutorAssignment(inWork, itAdmin),
        serviceActionRow(inWork),
      ),
    ).not.toContain('estimate');
  });
});

describe(`${SERVICE} по ремонту: объём работ и закрытие есть, распоряжения заявкой нет`, () => {
  it('«В работе»: денежный шаг и закрытие работ; ни отмены, ни срочности, ни перемещения', () => {
    const request = assignedServiceRequest({ status: 'in_work' });
    const keys = keysFor(request, contractor);
    expect(keys).toContain('estimate');
    expect(keys).toContain('complete');
    for (const key of ['cancel', 'urgency', 'move-equipment']) expect(keys).not.toContain(key);
    expect(
      attachableServiceFileKinds(
        'in_work',
        'finance',
        contractor,
        serviceExecutorAssignment(request, contractor),
        serviceActionRow(request),
      ),
    ).toContain('estimate');
  });

  it('с висящим предъявлением возвращает свой объём работ в правку', () => {
    const request = estimatePendingServiceRequest({
      status: 'in_work',
      executors: assignedServiceRequest().executors,
      service: assignedServiceRequest().service,
    });
    expect(keysFor(request, contractor)).toContain('reopen');
  });
});

/** The composition row a consumables request carries; the same row for every reader of the case. */
const TONER = {
  id: 'line-1',
  consumableId: 'c-1',
  code: 'RC201',
  name: 'Тонер Ricoh 201',
  color: null,
  requestedQuantity: 2,
  issuedQuantity: null,
  issueNote: '',
} satisfies ServiceRequestDto['consumables'][number];

/** A consumables request handed to the service company alone (the contractor brings the toner). */
function contractorConsumables(status: ServiceRequestStatus): ServiceRequestDto {
  return assignedServiceRequest({
    kind: 'consumable',
    status,
    consumables: [TONER],
    executors: [],
  });
}

/** The same request without a contractor: our shelf, the in-house administrator is named. */
function ownConsumables(status: ServiceRequestStatus): ServiceRequestDto {
  return serviceRequest({ kind: 'consumable', status, consumables: [TONER], ...NAMED_ONLY });
}

const STATE_OF_ISSUE: ServiceRequestStatus[] = ['in_work', 'done'];

describe(`${SERVICE} по расходникам: номенклатуры, выдачи и отмены нет, ход в «Решена» есть (Р7, Р8)`, () => {
  it('«Новая»: принять в работу; ни состава, ни выдачи, ни отмены', () => {
    const keys = keysFor(contractorConsumables('new'), contractor);
    expect(keys).toContain('start');
    for (const key of ['consumables', 'consumables-issued', 'cancel']) {
      expect(keys, key).not.toContain(key);
    }
  });

  it('«В работе»: ход в «Решена» назван своим именем; ни состава, ни выдачи, ни отмены', () => {
    const items = itemsFor(contractorConsumables('in_work'), contractor);
    const complete = items.find((item) => item.key === 'complete');
    expect(complete?.label).toBe('Перевести в «Решена»');
    // Nothing is wrong with the move itself: the contractor closes his own request.
    expect(complete?.disabled).toBeFalsy();
    for (const key of ['consumables', 'consumables-issued', 'cancel']) {
      expect(
        items.map((item) => item.key),
        key,
      ).not.toContain(key);
    }
  });

  it('контроль: у ремонта того же подрядчика ход называется по-прежнему «Закрыть работы»', () => {
    const items = itemsFor(
      assignedServiceRequest({ status: 'in_work', executors: [] }),
      contractor,
    );
    expect(items.find((item) => item.key === 'complete')?.label).toBe('Закрыть работы');
  });
});

describe('склад не двигается у заявки подрядчика: отметки выдачи нет ни у кого (Р8)', () => {
  const operator = serviceOperator();

  it.each(STATE_OF_ISSUE)('статус «%s»: ни «Ведению», ни ИТ, ни самому подрядчику', (status) => {
    const request = contractorConsumables(status);
    for (const [who, user] of [
      ['«Ведение»', operator],
      [IT, itAdmin],
      [SERVICE, contractor],
    ] as const) {
      expect(keysFor(request, user), `${who}, ${status}`).not.toContain('consumables-issued');
    }
  });

  it.each(STATE_OF_ISSUE)(
    'смешанное назначение, статус «%s»: и свой сисадмин остаётся без неё',
    (status) => {
      const mixed = assignedServiceRequest({ kind: 'consumable', status, consumables: [TONER] });
      expect(serviceExecutorAssignment(mixed, itAdmin).isNamedExecutor).toBe(true);
      expect(keysFor(mixed, itAdmin)).not.toContain('consumables-issued');
    },
  );

  it.each(STATE_OF_ISSUE)(
    'контроль, статус «%s»: у своей заявки (подрядчика нет) пункт есть у «Ведения» и у назначенного ИТ',
    (status) => {
      const request = ownConsumables(status);
      expect(keysFor(request, operator), `«Ведение», ${status}`).toContain('consumables-issued');
      expect(keysFor(request, itAdmin), `${IT}, ${status}`).toContain('consumables-issued');
    },
  );

  it('состав заявки подрядчика ведёт своя сторона: пункт есть у назначенного ИТ, у подрядчика нет', () => {
    // The contractor does not see the nomenclature, so he does not fill it in; the own side does —
    // applying the Р7 rule to the REQUEST alone would take the item from the people who fill it.
    const mixed = assignedServiceRequest({
      kind: 'consumable',
      status: 'in_work',
      consumables: [],
    });
    expect(keysFor(mixed, itAdmin)).toContain('consumables');
    expect(keysFor(mixed, contractor)).not.toContain('consumables');
  });
});

describe(`${IT}: отмена есть, остального коридора «Ведения» нет (Р2)`, () => {
  const operator = serviceOperator();
  const CANCELLABLE: ServiceRequestStatus[] = ['new', 'in_work', 'on_hold'];

  it.each(CANCELLABLE)('внутренняя заявка в «%s»: «Отменить заявку» есть', (status) => {
    expect(keysFor(serviceRequest({ status, ...NAMED_ONLY }), itAdmin), status).toContain('cancel');
  });

  it.each(['done', 'accepted', 'cancelled'] as const)(
    'внутренняя заявка в «%s»: отмены нет — это дуги «Ведения», а не отмены',
    (status) => {
      expect(keysFor(serviceRequest({ status, ...NAMED_ONLY }), itAdmin), status).not.toContain(
        'cancel',
      );
    },
  );

  it('ни приёмки, ни возврата на доработку, ни отката приёмки, ни «Вернуть в «Новую»»', () => {
    // The guard of the status door admits the cancel right now, so «rollback-start» (an arc that
    // the right to assign puts into the corridor) is closed only by the per-target question.
    const forbidden = ['accept', 'rework', 'rollback-accept', 'reopen-request', 'rollback-start'];
    for (const status of WORKING) {
      const keys = keysFor(serviceRequest({ status, ...NAMED_ONLY }), itAdmin);
      for (const key of forbidden) expect(keys, `${status}: ${key}`).not.toContain(key);
    }
  });

  it('контроль: «Ведение» эти пункты получает там, где им положено', () => {
    expect(keysFor(serviceRequest({ status: 'done', ...NAMED_ONLY }), operator)).toEqual(
      expect.arrayContaining(['accept', 'rework']),
    );
    expect(keysFor(serviceRequest({ status: 'in_work', ...NAMED_ONLY }), operator)).toEqual(
      expect.arrayContaining(['rollback-start', 'cancel']),
    );
  });

  it('подрядчик по-прежнему без отмены, чьи бы права ни лежали в наборе', () => {
    for (const status of CANCELLABLE) {
      expect(
        keysFor(assignedServiceRequest({ status, executors: [] }), contractor),
        status,
      ).not.toContain('cancel');
    }
  });
});
