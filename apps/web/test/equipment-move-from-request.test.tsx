import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE,
  type AuthUser,
  type OfficeEquipmentDto,
  type OfficeEquipmentMovePlaceDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { serviceOperator, serviceRequest } from './factories/service';
import { EquipmentMoveFromRequest } from '../src/features/equipment-move';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import type { ServiceRequestModals } from '../src/pages/service/serviceRequestModals';

/**
 * Перемещение техники, записанное из карточки заявки (план
 * `docs/office-equipment-move-from-request-plan.md`, §9.2; Р1, Р3, Р6, Р7, Р8, Р11).
 *
 * Здесь проверяется ровно то, ради чего выпуск и делается: перемещение закрыто **своим** правом, а
 * не ведением справочника; дверь к нему живёт, пока жива заявка, — «вернулась из сервиса» пишут по
 * ПРИНЯТОЙ; окно, открытое из заявки с заявленным расхождением, знает о нём и предлагает разобрать;
 * и «откуда» уходит снятым с ПОКАЗАННОЙ карточки, а не собранным из полей формы.
 *
 * Соседний караул — `equipment-movements.test.tsx`: там то же окно, открытое из справочника, где ни
 * заявки, ни расхождения нет вовсе. Оба нужны: одно окно на два входа, и разница между ними — не
 * оформление, а состав того, что уходит на сервер.
 */

/* ─── кто смотрит ────────────────────────────────────────────────────────────────────────────── */

/** Оператор оргтехники: право перемещения у него есть — набор «Ведение» его сохранил (Р2). */
const MOVER: AuthUser = serviceOperator();

/**
 * Держатель `officeEquipment.write` БЕЗ `officeEquipment.move` — то самое сужение, ради которого
 * право и отделено (Р1). Права заданы списком, а не ролью: сервер отдаёт учётке итог, и портал
 * обязан спрашивать именно его.
 */
const WRITER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: ['officeEquipment.read', 'officeEquipment.write', 'serviceRequests.read'],
});

/**
 * Сторона подрядчика с правом перемещения: право есть, а двери нет (Р7 ADR 0085). Переезд по
 * своему парку решает заказывающая сторона, и выдача права сервисной компании этого не меняет.
 */
const CONTRACTOR: AuthUser = authUser({
  role: 'operator',
  counterpartyType: 'service',
  counterpartyId: 'cp-1',
  permissions: ['officeEquipment.read', 'officeEquipment.move', 'serviceRequests.read'],
});

/* ─── пункт в наборе действий ────────────────────────────────────────────────────────────────── */

/** Окна не открываются: состав пунктов от их устройства не зависит. */
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

const RUN = { start: () => {}, approve: () => {}, rollbackStart: () => {} };

const hasMoveItem = (request: ServiceRequestDto, user: AuthUser): boolean =>
  serviceRequestMenuItems(request, { user, modals: MODALS, run: RUN }).some(
    (item) => item.key === 'move-equipment',
  );

describe('кому положена дверь к перемещению', () => {
  it('без права `officeEquipment.move` пункта нет, даже у держателя ведения справочника', () => {
    expect(hasMoveItem(serviceRequest(), WRITER)).toBe(false);
  });

  it('с правом — есть', () => {
    expect(hasMoveItem(serviceRequest(), MOVER)).toBe(true);
  });

  it('стороне подрядчика пункта нет и с правом: переезд решает заказывающая сторона', () => {
    expect(hasMoveItem(serviceRequest(), CONTRACTOR)).toBe(false);
  });
});

describe('дверь живёт, пока жива заявка (Р6)', () => {
  /*
   * Главная находка Н3: «увезли в сервис» пишут в начале, а «вернулась» — в момент приёмки или
   * после неё, когда заявка уже принята. Прежнее условие «не закрытая» гнало человека в справочник
   * ровно тогда, когда переезд и надо записать.
   */
  it('у принятой заявки пункт есть', () => {
    expect(hasMoveItem(serviceRequest({ status: 'accepted' }), MOVER)).toBe(true);
  });

  it('у отменённой — тоже: «ремонт нецелесообразен» и есть причина увезти аппарат на склад', () => {
    expect(hasMoveItem(serviceRequest({ status: 'cancelled' }), MOVER)).toBe(true);
  });

  it('у архивной пункта нет: у неё нет ни одного действия — её восстанавливают или сносят', () => {
    const archived = serviceRequest({ deletedAt: '2026-08-30T10:00:00.000Z' });
    expect(hasMoveItem(archived, MOVER)).toBe(false);
  });

  it('у заявки без аппарата пункта нет: переезжать нечему', () => {
    expect(hasMoveItem(serviceRequest({ equipment: null, object: null }), MOVER)).toBe(false);
  });

  it('у заявки с непроверенным кандидатом — тоже (Р11): карточки парка ещё не существует', () => {
    const withCandidate = serviceRequest({
      equipment: null,
      object: null,
      equipmentCandidate: {
        id: 'cand-1',
        status: 'pending',
        declaredModel: 'Kyocera ECOSYS M3145',
        serialNumber: 'SN-9',
        inventoryNumber: '',
        decisionReason: '',
      },
    });
    expect(hasMoveItem(withCandidate, MOVER)).toBe(false);
  });
});

/* ─── окно, открытое из заявки ───────────────────────────────────────────────────────────────── */

/**
 * Карточка парка, какой её показывают человеку. Состояние — «у сотрудника» с уточнением: именно на
 * нём видно, что сверка исходной стороны идёт по всем пяти полям, включая `stateNote` (Р3, Р5).
 */
function equipmentCard(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 214',
    state: 'with_employee',
    stateNote: 'Иванов И. И.',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

/** Заявка, в которой заявитель сказал «аппарат стоит на другой площадке», и это не разобрано. */
const mismatched = (overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto =>
  serviceRequest({
    objectOverridden: true,
    objectMismatch: true,
    object: { id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' },
    ...overrides,
  });

const MOVE_ROUTE = 'POST /office-equipment/:id/move';

function renderWindow(request: ServiceRequestDto, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment/:id': () => json(equipmentCard()),
    'GET /service-requests/:id': () => json(request),
    'GET /objects': () =>
      json(list([objectDto(), objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' })])),
    'GET /departments': () => json(emptyList()),
    [MOVE_ROUTE]: () => json(equipmentCard(), 201),
    ...over,
  });
  renderWithUser(
    <EquipmentMoveFromRequest equipmentId="oe-1" serviceRequestId="sr-1" open onClose={() => {}} />,
    { user: MOVER },
  );
  return http;
}

/** Что показано в поле выбора (не в хранилище формы) — подпись выбранного варианта. */
const shownObject = (): string | null => {
  const field = document.querySelector('#objectId')?.closest('.ant-select');
  return field?.querySelector('.ant-select-content')?.getAttribute('title') ?? null;
};

const reasonField = (): HTMLInputElement =>
  screen.getByPlaceholderText(/Перевод бухгалтерии/) as HTMLInputElement;

const submit = () => fireEvent.click(screen.getByText('Записать перемещение'));

const lastBody = (http: HttpMock): Record<string, unknown> =>
  http.lastCall(MOVE_ROUTE)?.body as Record<string, unknown>;

describe('окно знает о заявленном месте (Р7)', () => {
  it('баннер называет заявленный объект и дату заявления', async () => {
    renderWindow(mismatched());

    const banner = await screen.findByText(/Заявитель сообщил/);
    expect(banner.textContent).toContain('ОБ-2 — ЖК Южный');
    // Дата заявления — день заведения заявки: снимок объекта после создания не правится (Р6).
    expect(screen.getByText(/Заявлено 05\.08\.2026/)).toBeDefined();
  });

  it('целевым объектом предложен заявленный, причина — ссылкой на заявку', async () => {
    renderWindow(mismatched());

    await screen.findByText(/Заявитель сообщил/);
    // Предложен, а не записан: поле обычное, и ответственный волен выбрать третью площадку —
    // аппарат нередко находится там, где не ждал никто (находка Н6).
    expect(shownObject()).toBe('ОБ-2 — ЖК Южный');
    expect(reasonField().value).toBe('Подтверждение места по заявке СО-14');
  });

  it('галочка подтверждения видна и снята: служебный переезд места не подтверждает', async () => {
    const http = renderWindow(mismatched());

    const checkbox = (await screen.findByText('Подтверждаю заявленное место'))
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    submit();
    await waitFor(() => expect(http.lastCall(MOVE_ROUTE)).toBeDefined());
    expect(lastBody(http).confirmsDeclaredPlace).toBe(false);
  });

  it('поставленная галочка уходит флагом — им и гасится очередь ИТ-службы (Р8)', async () => {
    const http = renderWindow(mismatched());

    const checkbox = (await screen.findByText('Подтверждаю заявленное место'))
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    submit();

    await waitFor(() => expect(http.lastCall(MOVE_ROUTE)).toBeDefined());
    const body = lastBody(http);
    expect(body.confirmsDeclaredPlace).toBe(true);
    // Флаг без заявки схемой не принимается: он о том, ЧЬЁ заявление разобрали.
    expect(body.serviceRequestId).toBe('sr-1');
  });

  it('у заявки без расхождения ни баннера, ни галочки, а цель равна текущему объекту', async () => {
    renderWindow(serviceRequest());

    await screen.findByPlaceholderText(/Перевод бухгалтерии/);
    expect(screen.queryByText(/Заявитель сообщил/)).toBeNull();
    expect(screen.queryByText('Подтверждаю заявленное место')).toBeNull();
    expect(shownObject()).toBe('ОБ-1 — ЖК Северный');
    // Причина не предлагается: подтверждать нечего, и подпись «по заявке» была бы неправдой.
    expect(reasonField().value).toBe('');
  });
});

describe('исходная сторона уходит снятой с показанной карточки (Р3)', () => {
  it('`from` собран из карточки целиком, а правка полей его не подменяет', async () => {
    const http = renderWindow(serviceRequest());

    // Человек правит «куда»: другое место внутри объекта и другой сотрудник. «Откуда» от этого не
    // меняется — иначе исходную сторону можно было бы подменить правкой поля.
    fireEvent.change(await screen.findByPlaceholderText(/кабинет 214/), {
      target: { value: 'каб. 999' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Склад АХО/), {
      target: { value: 'Петров П. П.' },
    });
    fireEvent.change(reasonField(), { target: { value: 'Передан другому сотруднику' } });
    submit();

    await waitFor(() => expect(http.lastCall(MOVE_ROUTE)).toBeDefined());
    const body = lastBody(http);
    expect(body.from).toEqual({
      objectId: 'obj-1',
      departmentId: null,
      location: 'каб. 214',
      state: 'with_employee',
      // Пустая строка уточнения — тоже состояние, поэтому сверка идёт по всем пяти полям (Р5).
      stateNote: 'Иванов И. И.',
    });
    expect(body.location).toBe('каб. 999');
    expect(body.stateNote).toBe('Петров П. П.');
  });
});

describe('«техника уже переехала» (Р3, находка Н1)', () => {
  /** Где аппарат оказался на самом деле — тело отказа `409`, прочитанное сервером под блокировкой. */
  const CURRENT: OfficeEquipmentMovePlaceDto = {
    objectId: 'obj-2',
    objectName: 'ОБ-2 · ЖК Южный',
    departmentId: null,
    departmentName: null,
    location: 'каб. 12',
    state: 'with_employee',
    stateNote: 'Петров П. П.',
  };

  const conflictThenOk = (): { route: RouteMap; countOf: () => number } => {
    let count = 0;
    return {
      countOf: () => count,
      route: {
        [MOVE_ROUTE]: (): MockResponse => {
          count += 1;
          return count === 1
            ? json(
                {
                  code: OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE,
                  message: 'Техника уже переехала — откройте окно заново',
                  details: { current: CURRENT },
                },
                409,
              )
            : json(equipmentCard(), 201);
        },
      },
    };
  };

  it('окно называет текущее место словами, а не «обновите страницу»', async () => {
    const { route } = conflictThenOk();
    renderWindow(serviceRequest(), route);

    fireEvent.change(await reasonFieldWhenReady(), { target: { value: 'Вернули из сервиса' } });
    submit();

    const alert = await screen.findByText(/Техника уже переехала/);
    const shown = alert.closest('.ant-alert')?.textContent ?? '';
    expect(shown).toContain('ОБ-2 · ЖК Южный');
    expect(shown).toContain('каб. 12');
    expect(shown).toContain('У сотрудника');
    expect(shown).toContain('Петров П. П.');
    // Отказ остаётся в окне вместе с тем, что человек собирался записать: перезаполнять форму
    // заново он не должен.
    expect(reasonField().value).toBe('Вернули из сервиса');
  });

  it('повторная отправка уходит с обновлённым «откуда»', async () => {
    const { route, countOf } = conflictThenOk();
    const http = renderWindow(serviceRequest(), route);

    fireEvent.change(await reasonFieldWhenReady(), { target: { value: 'Вернули из сервиса' } });
    submit();
    await screen.findByText(/Техника уже переехала/);

    submit();
    await waitFor(() => expect(countOf()).toBe(2));
    expect(lastBody(http).from).toEqual({
      objectId: 'obj-2',
      departmentId: null,
      location: 'каб. 12',
      state: 'with_employee',
      stateNote: 'Петров П. П.',
    });
    expect(http.countOf(MOVE_ROUTE)).toBe(2);
  });
});

/** Поле причины, дождавшись отрисовки окна: обе стороны догружаются по идентификатору. */
async function reasonFieldWhenReady(): Promise<HTMLInputElement> {
  return (await screen.findByPlaceholderText(/Перевод бухгалтерии/)) as HTMLInputElement;
}
