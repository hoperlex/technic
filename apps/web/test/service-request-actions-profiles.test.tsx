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
 * added by them.
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

function keysFor(request: ServiceRequestDto, user: AuthUser): string[] {
  return serviceRequestMenuItems(request, {
    user,
    can: permissionChecks(user).can,
    modals: MODALS,
    run: RUN,
  }).map((item) => item.key);
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
