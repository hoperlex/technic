import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  autoAcceptedServiceRequest,
  disputedServiceRequest,
  heldServiceRequest,
  serviceExecutor,
  serviceOperator,
} from './factories/service';
import { objectDto } from './factories/waste';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import type { ServiceRequestModals } from '../src/pages/service/serviceRequestModals';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceEstimateDisputeModal } from '../src/pages/service/ServiceEstimateDisputeModal';

/**
 * СПОР ОБ ОСВОБОЖДЕНИИ ОТ ПОДПИСИ НА ПОРТАЛЕ (Р9 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, этап Э7).
 *
 * ДОСТУПНОСТЬ СЧИТАЮТ ПРЕДИКАТЫ КОНТРАКТОВ, и здесь проверяется не они, а ПРОВОДКА к ним: признаки
 * спора портал собирает из карточки (`serviceEstimateDisputeFacts`), и собранные не теми полями они
 * молча меняют ответ на «кому это доступно». Цена ошибки обе стороны: показанный лишним пункт ведёт
 * в 403 по денежному решению, а потерянный оставляет «Ведение» без единственного входа в контроль
 * постфактум — заявка, принятая мимо подписи, осталась бы неоспоримой.
 *
 * ЧЕТЫРЕ ПОЛЯ КАРТОЧКИ ДЕРЖАТ ОБА ПУНКТА, И КАЖДОЕ ИЗ НИХ — ОТДЕЛЬНАЯ ТОЧКА ОТКАЗА: `exemption` с
 * исходом и ревизией, `approval.revision`, `approval.source` и `dispute.state`. Сервер отдаёт все
 * четыре (`toDto`, пакетные читатели `estimateExemptionByRequest` и `estimateDisputeByRequest`), и
 * фикстуры здесь собраны той же четвёркой — `autoAcceptedServiceRequest` держит её целиком, потому
 * что порознь такого состояния в базе не бывает.
 *
 * СЦЕНАРИЙ «ПОДПИСЬ ЧЕЛОВЕКА» СТЕРЕЖЁТ САМУЮ ДОРОГУЮ ИЗ ЭТИХ ТОЧЕК. Пропади `approval.source` из
 * ответа — правило «пусто = человек» ответило бы `human` на каждой заявке, `exemptionApplied` стал
 * бы ложен всегда, и «Оспорить освобождение» исчезло бы молча: пункт, нарисованный в коде, но
 * недостижимый ни при каких данных. Именно так этот караул и краснеет — не на фикстуре без поля, а
 * на состоянии, где поле есть, но говорит другое.
 */

/** «Ведение»: спор ведёт держатель `serviceRequests.assign` — тем же правом, каким распределяет. */
const OPERATOR: AuthUser = serviceOperator();
/** Оператор подрядчика: освобождение заявил он, и спор с самим собой предикат запрещает явно. */
const EXECUTOR: AuthUser = serviceExecutor();

/** Набор окон, который ничего не открывает: перечень пунктов от их устройства не зависит. */
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

const keysFor = (request: ServiceRequestDto, user: AuthUser): string[] =>
  serviceRequestMenuItems(request, { user, modals: MODALS, run: RUN }).map((item) => item.key);

describe('«Оспорить освобождение» открыто тому и тогда, когда его пустит сервер (Р9)', () => {
  it('«Ведению» — на заявке, принятой без подписи', () => {
    expect(keysFor(autoAcceptedServiceRequest(), OPERATOR)).toContain('estimate-dispute');
  });

  it('и в «Решена» тоже: спорят до приёмки, а не до закрытия работ', () => {
    expect(keysFor(autoAcceptedServiceRequest({ status: 'done' }), OPERATOR)).toContain(
      'estimate-dispute',
    );
  });

  it('оператору подрядчика — нет: освобождение заявил он сам', () => {
    expect(keysFor(autoAcceptedServiceRequest(), EXECUTOR)).not.toContain('estimate-dispute');
  });

  it('по наблюдённому заявлению — нет: подпись по такой заявке и так собирают', () => {
    const observed = autoAcceptedServiceRequest({
      exemption: {
        revision: 1,
        by: 'user-5',
        byName: 'Сервисов А. А.',
        at: '2026-09-10T09:30:00.000Z',
        note: '',
        outcome: 'observed',
      },
    });
    expect(keysFor(observed, OPERATOR)).not.toContain('estimate-dispute');
  });

  it('по подписи ЧЕЛОВЕКА — нет: такой объём работ возвращают в правку, а не оспаривают', () => {
    /*
     * Источник подписи читается единственным носителем правила «пусто = человек»
     * (`serviceEstimateApprovalSourceOf`), и здесь поле опущено намеренно — так отвечает приложение,
     * не знающее про волну, в окне выката. Ответ обязан быть тот же, что у явного `human`: подпись
     * настоящая, спорить не о чем. Тот же случай стережёт и обратное — пропади `source` из ответа
     * нового сервера, пункт исчез бы на ВСЕХ заявках, и заметить это можно только здесь.
     */
    const signed = autoAcceptedServiceRequest({
      approval: {
        revision: 1,
        by: 'user-2',
        byName: 'Операторов О. О.',
        at: '2026-09-10T10:00:00.000Z',
      },
    });
    expect(keysFor(signed, OPERATOR)).not.toContain('estimate-dispute');
  });

  it('после возврата объёма в правку — нет: подписи под ревизией больше не стоит', () => {
    const reopened = autoAcceptedServiceRequest({ approval: null });
    expect(keysFor(reopened, OPERATOR)).not.toContain('estimate-dispute');
  });

  it('по заявке без освобождения набор действий не изменился', () => {
    const plain = autoAcceptedServiceRequest({ approval: null, exemption: null });
    const keys = keysFor(plain, OPERATOR);
    expect(keys).not.toContain('estimate-dispute');
    expect(keys).not.toContain('estimate-dispute-resolve');
    // Обычные ходы «В работе» на месте: волна не тронула ни одного из них.
    expect(keys).toContain('hold');
    expect(keys).toContain('cancel');
  });
});

describe('«Разрешить спор» открыто только по заявке, остановленной спором (Р9)', () => {
  it('у остановленной спором заявки пункт есть', () => {
    expect(keysFor(disputedServiceRequest(), OPERATOR)).toContain('estimate-dispute-resolve');
  });

  it('у обычной заморозки — нет: «ждём запчасть» разрешать нечего', () => {
    expect(keysFor(heldServiceRequest('in_work'), OPERATOR)).not.toContain(
      'estimate-dispute-resolve',
    );
  });

  it('оператору подрядчика — нет: спор закрывает тот, кто его начал', () => {
    expect(keysFor(disputedServiceRequest(), EXECUTOR)).not.toContain('estimate-dispute-resolve');
  });

  it('второго спора по остановленной заявке не открывают', () => {
    expect(keysFor(disputedServiceRequest(), OPERATOR)).not.toContain('estimate-dispute');
  });
});

/* ─── открытие спора: причина обязательна (Р9) ───────────────────────────────────────────────── */

function renderList(items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return http;
}

describe('спор открывают с причиной, и она уходит на сервер', () => {
  it('пункт ведёт в окно причины, а пустая причина запроса не делает', async () => {
    const request = autoAcceptedServiceRequest();
    const http = renderList([request], {
      'PATCH /service-requests/:id/estimate/dispute': () =>
        json(disputedServiceRequest({ version: request.version + 1 })),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
    fireEvent.click(await screen.findByText('Оспорить освобождение'));

    expect(await screen.findByText('Спор об освобождении от подписи')).toBeDefined();
    // Причина обязательна: спор ОСТАНАВЛИВАЕТ заявку, и остановку объясняют исполнителю.
    fireEvent.click(screen.getByRole('button', { name: 'Оспорить' }));
    await waitFor(() => expect(screen.getAllByText('Укажите причину').length).toBeGreaterThan(0));
    expect(http.countOf('PATCH /service-requests/:id/estimate/dispute')).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина'), {
      target: { value: 'счёт вдвое выше сметы соседней заявки' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Оспорить' }));

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/dispute')).toBe(1),
    );
    const body = http.lastCall('PATCH /service-requests/:id/estimate/dispute')?.body as Record<
      string,
      unknown
    >;
    expect(body.reason).toBe('счёт вдвое выше сметы соседней заявки');
    expect(body.version).toBe(request.version);
    // Что стало с заявкой — в самом тосте: искавший её в прежнем статусе должен узнать об остановке.
    expect(
      await screen.findByText('Спор открыт — заявка отложена до его разрешения'),
    ).toBeDefined();
  });
});

/* ─── разрешение спора: три исхода одним окном (Р9) ──────────────────────────────────────────── */

const DISPUTED = disputedServiceRequest();

function renderResolve(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'PATCH /service-requests/:id/estimate/dispute/resolution': () => json(DISPUTED),
    ...over,
  });
  renderWithUser(<ServiceEstimateDisputeModal request={DISPUTED} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

const resolve = () => fireEvent.click(screen.getByRole('button', { name: 'Разрешить спор' }));

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('PATCH /service-requests/:id/estimate/dispute/resolution')?.body as Record<
    string,
    unknown
  >;
}

describe('окно разрешения спора: три исхода и причина там, где её требует сервер', () => {
  it('исходов ровно три, и каждый назван последствием', async () => {
    renderResolve();
    await screen.findByText('Чем спор кончается');

    expect(screen.getByRole('radio', { name: /Оставить освобождение/ })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Нужна подпись/ })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Отменить заявку/ })).toBeDefined();
    // Причина спора видна здесь: после разрешения поля заморозки гаснут, и спросить будет нечего.
    expect(screen.getByText('счёт вдвое выше сметы соседней заявки')).toBeDefined();
  });

  it('без исхода запроса не уходит: выбор обязателен', async () => {
    const http = renderResolve();
    await screen.findByText('Чем спор кончается');

    resolve();

    await waitFor(() => expect(screen.getByText('Выберите, чем спор кончается')).toBeDefined());
    expect(http.countOf('PATCH /service-requests/:id/estimate/dispute/resolution')).toBe(0);
  });

  it('«оставить освобождение» уходит одним исходом, без причины', async () => {
    const http = renderResolve();
    await screen.findByText('Чем спор кончается');

    fireEvent.click(screen.getByRole('radio', { name: /Оставить освобождение/ }));
    // Поля причины у этого исхода нет вовсе: объяснение уже лежит в самом споре.
    expect(screen.queryByLabelText('Причина отмены')).toBeNull();
    resolve();

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/dispute/resolution')).toBe(1),
    );
    const body = bodyOf(http);
    expect(body.outcome).toBe('keep');
    expect(body.reason).toBeUndefined();
    expect(body.version).toBe(DISPUTED.version);
  });

  it('«нужна подпись» уходит своим исходом и говорит, что подпись теперь ждут', async () => {
    const http = renderResolve();
    await screen.findByText('Чем спор кончается');

    fireEvent.click(screen.getByRole('radio', { name: /Нужна подпись/ }));
    resolve();

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/dispute/resolution')).toBe(1),
    );
    expect(bodyOf(http).outcome).toBe('require_signature');
    expect(
      await screen.findByText('Спор разрешён: автоподпись снята, по объёму работ ждут подписи'),
    ).toBeDefined();
  });

  it('«отменить заявку» без причины не уходит, а с причиной несёт её в теле', async () => {
    const http = renderResolve();
    await screen.findByText('Чем спор кончается');

    fireEvent.click(screen.getByRole('radio', { name: /Отменить заявку/ }));
    // Поле причины появляется вместе с исходом: до его регистрации в форме нажимать нечего.
    await screen.findByLabelText('Причина отмены');
    resolve();

    await waitFor(() =>
      expect(screen.getByText('Укажите, почему заявка отменяется')).toBeDefined(),
    );
    expect(http.countOf('PATCH /service-requests/:id/estimate/dispute/resolution')).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина отмены'), {
      target: { value: 'работы не выполнялись, счёт выставлен ошибочно' },
    });
    resolve();

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/dispute/resolution')).toBe(1),
    );
    const body = bodyOf(http);
    expect(body.outcome).toBe('cancel');
    expect(body.reason).toBe('работы не выполнялись, счёт выставлен ошибочно');
  });
});
