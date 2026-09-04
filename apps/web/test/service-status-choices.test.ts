import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  allowedServiceStatusTransitions,
  permissionsFor,
  SERVICE_REQUEST_STATUSES,
  serviceResumeTarget,
  type AuthUser,
  type ServiceRequestDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { authUser } from './factories/auth';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  heldServiceRequest,
  serviceCustomer,
  serviceExecutor,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import {
  serviceStatusChoices,
  type ServiceMenuItem,
} from '../src/pages/service/serviceStatusChoices';
import { serviceExecutorAssignment } from '../src/pages/service/serviceRequestRow';
import type { ServiceRequestModals } from '../src/pages/service/serviceRequestModals';

/**
 * Караул соответствия для входа «тег статуса → список переходов» (ADR 0161).
 *
 * Проверяется то, что расходится МОЛЧА. Список переходов — проекция набора действий: пункт сам
 * говорит, куда ведёт (`toStatus`). Забыть это поле у новой дуги можно, и портал тогда просто не
 * покажет ход — ошибки не будет ни в типах, ни на экране. Поставить его лишним тоже можно — и
 * тогда пункт поведёт в 403. Оба случая ловятся здесь, а не глазами на пилоте.
 */

/** Набор окон, который ничего не открывает: перечень пунктов от их устройства не зависит. */
const MODALS: ServiceRequestModals = {
  assign: () => {},
  estimate: () => {},
  approval: () => {},
  consumables: () => {},
  complete: () => {},
  issue: () => {},
  accept: () => {},
  hold: () => {},
  urgency: () => {},
  chat: () => {},
  moveEquipment: () => {},
  ask: () => {},
  close: () => {},
  pending: false,
  node: null,
};

const RUN = { start: () => {}, approve: () => {}, rollbackStart: () => {}, notify: () => {} };

function itemsFor(request: ServiceRequestDto, user: AuthUser | null): ServiceMenuItem[] {
  return serviceRequestMenuItems(request, { user, modals: MODALS, run: RUN });
}

/** Подписи переходов — то, что человек читает в меню и в шите. */
function labelsFor(request: ServiceRequestDto, user: AuthUser | null): string[] {
  return serviceStatusChoices(itemsFor(request, user), request).map((item) => item.label);
}

/** Учётка по поставочному субъекту: перебором профилей проверяется вся матрица, а не три роли. */
function userOf(index: number): AuthUser {
  const subject = ACCESS_PROFILES[index]!;
  return authUser({
    role: subject.role,
    counterpartyType: subject.counterpartyType ?? null,
    // Идентификатор контрагента — тот же, что у заявки фикстуры: без него оператор подрядчика не
    // исполнитель ни на одной строке (Р8 аудита исполнителей), и половина перебора молчала бы.
    counterpartyId: subject.counterpartyType ? 'cp-1' : null,
    addons: subject.addons ? [...subject.addons] : [],
    grantCodes: subject.addons ? [...subject.addons] : [],
    permissions: [...permissionsFor(subject)],
  });
}

/** Составы заявки, на которых состояние цикла различается (Р2 плана упрощения). */
function requestsIn(status: ServiceRequestStatus): ServiceRequestDto[] {
  if (status === 'on_hold') return [heldServiceRequest('in_work'), heldServiceRequest('new')];
  return [
    serviceRequest({ status }),
    assignedServiceRequest({ status }),
    // Закрывающий документ подшит: без него «Закрыть работы» выключена, и пункт всё равно есть.
    assignedServiceRequest({ status, files: [serviceRequestFile('act')] }),
    estimatePendingServiceRequest({ status, service: { id: 'cp-1', name: 'КопиЛайт' } }),
  ];
}

describe('портал не предлагает того, чего сервер не пустит (ADR 0161, решение 1)', () => {
  it('каждый пункт списка переходов лежит в коридоре контрактов', () => {
    for (let i = 0; i < ACCESS_PROFILES.length; i += 1) {
      const user = userOf(i);
      const who = accessProfileLabel(ACCESS_PROFILES[i]!);
      for (const status of SERVICE_REQUEST_STATUSES) {
        for (const request of requestsIn(status)) {
          const assignment = serviceExecutorAssignment(request, user);
          const corridor = allowedServiceStatusTransitions(request.status, user, assignment);
          const resume = serviceResumeTarget(request);
          for (const item of itemsFor(request, user)) {
            const to = item.key === 'resume' ? resume : item.toStatus;
            if (!to) continue;
            expect(
              corridor.includes(to) || to === resume,
              `${who}: «${request.status}» → «${to}» пунктом «${item.label}»`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('мёртвые статусы ходов не предлагают никому', () => {
    for (const status of ['it_approved', 'assigned', 'diagnostics', 'estimate_review'] as const) {
      for (let i = 0; i < ACCESS_PROFILES.length; i += 1) {
        expect(labelsFor(serviceRequest({ status }), userOf(i)), status).toEqual([]);
      }
    }
  });

  it('архивной заявке ходов нет ни у кого, включая администратора', () => {
    const archived = assignedServiceRequest({ deletedAt: '2026-09-01T10:00:00.000Z' });
    expect(labelsFor(archived, authUser({ role: 'admin' }))).toEqual([]);
  });
});

/**
 * Ключи пунктов, которые ДВИГАЮТ статус. Перечень нужен ровно затем, чтобы забытый `toStatus`
 * падал тестом, а не молчал: без поля пункт просто исчезает из списка переходов — ни типы, ни
 * экран об этом не сообщают (ADR 0161, решение 1).
 *
 * Перечень закрытый и живёт здесь, а не в коде: в коде он был бы второй картой правил. Новый ход,
 * заведённый мимо него, ловится соседним тестом — «пункты покрывают весь коридор».
 */
const TRANSITION_KEYS = [
  'start',
  'complete',
  'accept',
  'rework',
  'rollback-start',
  'rollback-accept',
  'reopen-request',
  'hold',
  'resume',
  'reject',
  'cancel',
] as const;

describe('полнота вверх: коридор не остаётся без пункта (ADR 0161, решение 1)', () => {
  it('каждый ход несёт свой целевой статус', () => {
    for (let i = 0; i < ACCESS_PROFILES.length; i += 1) {
      const user = userOf(i);
      const who = accessProfileLabel(ACCESS_PROFILES[i]!);
      for (const status of SERVICE_REQUEST_STATUSES) {
        for (const request of requestsIn(status)) {
          for (const item of itemsFor(request, user)) {
            if (!TRANSITION_KEYS.includes(item.key as (typeof TRANSITION_KEYS)[number])) continue;
            // У возврата из заморозки цель динамическая и живёт в самой заявке (Р104).
            const to = item.key === 'resume' ? serviceResumeTarget(request) : item.toStatus;
            expect(
              to,
              `${who}: пункт «${item.label}» в «${status}» без целевого статуса`,
            ).toBeTruthy();
          }
        }
      }
    }
  });

  /**
   * На РАСПРЕДЕЛЁННОЙ заявке множества совпадают полностью: предикаты действий сужают коридор
   * только там, где заявкой ещё никто не занят.
   *
   * Единственное законное расхождение — нераспределённая заявка: ветка права на объём работ
   * открывает администратору дугу `new → in_work`, а пункта «Принять в работу» нет, потому что
   * `canStartServiceWork` требует исполнителей, — и сервер отвечает тем же отказом. Поэтому
   * сравнение идёт по заявке с исполнителями, а поведение нераспределённой закреплено отдельным
   * случаем ниже.
   *
   * Возврат из заморозки в сравнении не участвует: его цель коридором не выражается вовсе.
   */
  it('на распределённой заявке пункты покрывают коридор целиком', () => {
    for (let i = 0; i < ACCESS_PROFILES.length; i += 1) {
      const user = userOf(i);
      const who = accessProfileLabel(ACCESS_PROFILES[i]!);
      for (const status of SERVICE_REQUEST_STATUSES) {
        const request =
          status === 'on_hold'
            ? heldServiceRequest('in_work', {
                executors: [
                  {
                    userId: 'user-9',
                    name: 'Сисадминов С. С.',
                    assignedAt: '2026-08-05T10:00:00.000Z',
                  },
                ],
                service: { id: 'cp-1', name: 'КопиЛайт' },
              })
            : assignedServiceRequest({ status, files: [serviceRequestFile('act')] });
        const assignment = serviceExecutorAssignment(request, user);
        const corridor = [...allowedServiceStatusTransitions(request.status, user, assignment)]
          .sort()
          .join(', ');
        const covered = [
          ...new Set(
            itemsFor(request, user)
              .filter((item) => item.key !== 'resume')
              .map((item) => item.toStatus)
              .filter((to): to is ServiceRequestStatus => !!to),
          ),
        ]
          .sort()
          .join(', ');
        expect(covered, `${who}, «${status}»`).toBe(corridor);
      }
    }
  });

  it('у нераспределённой «Новой» ход исполнителя закрыт — и это не пропущенный пункт', () => {
    const admin = authUser({ role: 'admin' });
    const plain = serviceRequest({ status: 'new' });
    // Коридор дугу отдаёт (ветка права на объём работ)…
    expect(
      allowedServiceStatusTransitions('new', admin, serviceExecutorAssignment(plain, admin)),
    ).toContain('in_work');
    // …а пункта нет: заявка никому не назначена, и сервер откажет так же.
    expect(labelsFor(plain, admin)).not.toContain('«В работе» · принять в работу');
  });

  it('у отложенной всегда есть возврат — с целью из самой заявки', () => {
    for (const from of ['new', 'in_work', 'done'] as const) {
      const held = heldServiceRequest(from);
      expect(labelsFor(held, serviceOperator()), from).toContain(
        `«${{ new: 'Новая', in_work: 'В работе', done: 'Решена' }[from]}» · возобновить`,
      );
    }
  });
});

describe('кому вход виден (ADR 0161, решение 4)', () => {
  it('заявителю — ни одного перехода ни в одном статусе', () => {
    const customer = serviceCustomer();
    for (const status of SERVICE_REQUEST_STATUSES) {
      for (const request of requestsIn(status)) {
        expect(labelsFor(request, customer), status).toEqual([]);
      }
    }
  });

  it('назначенный исполнитель принимает заявку в работу, а нераспределённую — нет', () => {
    expect(labelsFor(assignedServiceRequest(), serviceExecutor())).toEqual([
      '«В работе» · принять в работу',
    ]);
    expect(labelsFor(serviceRequest({ status: 'new' }), serviceExecutor())).toEqual([]);
  });

  it('поимённый исполнитель ходит по назначению, а не по праву', () => {
    const named = serviceInHouseExecutor();
    expect(labelsFor(assignedServiceRequest(), named)).toContain('«В работе» · принять в работу');
    expect(labelsFor(serviceRequest({ status: 'new' }), named)).not.toContain(
      '«В работе» · принять в работу',
    );
  });

  it('оператор ведения отменяет и откладывает, но работы за исполнителя не принимает', () => {
    expect(labelsFor(assignedServiceRequest(), serviceOperator())).toEqual([
      '«Отложена» · отложить',
      '«Отменена» · отменить заявку',
    ]);
  });
});

describe('подписи переходов (ADR 0161, решение 3)', () => {
  it('два пути в «Отменена» из «В работе» различимы словами', () => {
    const pending = estimatePendingServiceRequest();
    const labels = labelsFor(pending, serviceOperator());
    expect(labels).toContain('«Отменена» · не согласовать объём работ');
    expect(labels).toContain('«Отменена» · отменить заявку');
  });

  it('без висящего предъявления путь в «Отменена» остаётся один', () => {
    const labels = labelsFor(assignedServiceRequest({ status: 'in_work' }), serviceOperator());
    expect(labels.filter((label) => label.startsWith('«Отменена»'))).toEqual([
      '«Отменена» · отменить заявку',
    ]);
  });

  it('возврат из заморозки называет статус, из которого заявку отложили', () => {
    expect(labelsFor(heldServiceRequest('in_work'), serviceOperator())).toContain(
      '«В работе» · возобновить',
    );
    expect(labelsFor(heldServiceRequest('new'), serviceOperator())).toContain(
      '«Новая» · возобновить',
    );
  });

  it('откат приёма в работу не повторяет имя статуса дважды', () => {
    const labels = labelsFor(
      assignedServiceRequest({ status: 'in_work' }),
      authUser({ role: 'admin' }),
    );
    expect(labels).toContain('«Новая» · откатить приём в работу');
  });

  it('администратор возвращает отменённую и отменяет приёмку', () => {
    const admin = authUser({ role: 'admin' });
    expect(labelsFor(serviceRequest({ status: 'cancelled' }), admin)).toEqual([
      '«Новая» · вернуть отменённую заявку в работу',
    ]);
    expect(labelsFor(serviceRequest({ status: 'accepted' }), admin)).toEqual([
      '«Решена» · отменить приёмку',
    ]);
  });
});

describe('выключенность переносится вместе с причиной (ADR 0161, решение 5)', () => {
  it('«Закрыть работы» без закрывающего документа виден, неактивен и объясняет себя', () => {
    const request = assignedServiceRequest({ status: 'in_work' });
    const [choice] = serviceStatusChoices(itemsFor(request, serviceExecutor()), request).filter(
      (item) => item.key === 'complete',
    );
    expect(choice?.label).toBe('«Решена» · закрыть работы');
    expect(choice?.disabled).toBe(true);
    expect(choice?.disabledReason).toContain('Сначала подшейте');
  });

  it('с подшитым актом тот же пункт активен', () => {
    const request = assignedServiceRequest({
      status: 'in_work',
      files: [serviceRequestFile('act')],
    });
    const [choice] = serviceStatusChoices(itemsFor(request, serviceExecutor()), request).filter(
      (item) => item.key === 'complete',
    );
    expect(choice?.disabled).toBeFalsy();
  });
});
