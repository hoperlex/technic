import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { selectOption, typeDate } from './antd';
import { list } from './factories/common';
import { machinist, vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';
import { VehicleEsm2Modal } from '../src/pages/vehicle/VehicleEsm2Modal';

/**
 * Линейная техника в портале (ADR 0100): машина, которая вечером возвращается на базу.
 *
 * Проверяется то, чем заказ такой машины отличается от обычного заказа на объект, — и обе стороны
 * различия сразу, потому что цена ошибки в них разная. У линейной заявки перевод в работу не
 * выписывает ни одного ЭСМ-2 (значит, машинист перестаёт быть обязательным) и не предлагает
 * перегона (его у такой техники не бывает вовсе). У обычной всё осталось как было: недели названы
 * до нажатия, машинист обязателен, доставка предлагается.
 *
 * Третья часть — само окно выписки по требованию: неделя, машина и машинист, причём машинист
 * спрашивается пустым полем даже тогда, когда в справочнике он один. Это решение, а не недоделка:
 * графа в бланке одна на неделю, а водитель у каждого дня свой (ADR 0100 решение 6).
 */

/** Автовышка — та самая линейная техника: днём объезжает площадки, ночует в гараже. */
const LIFT: VehicleDto = {
  id: 'v-lift',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  kindName: 'Спецтехника',
  vehicleTypeId: 'vt-1',
  typeName: 'Автовышки',
  // Бланк есть у каждого типа (ADR 0065); у линейного дня им и печатается работа.
  waybillFormCode: '4p',
  vehicleCategoryId: 'vc-1',
  categoryName: 'Автовышки, 22 м',
  categorySpecs: null,
  vehicleModelId: 'm-1',
  modelName: 'ВС-22-01',
  registrationNumber: 'А111АА77',
  passportNumber: null,
  lessorId: null,
  lessorName: null,
  lessorIsActive: null,
  deactivatedWithLessor: false,
  description: '',
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  status: 'active',
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

/** Вторая единица того же типа: за неделю на объекте могли отработать две разных (решение 7). */
const LIFT_2: VehicleDto = {
  ...LIFT,
  id: 'v-lift-2',
  modelName: 'ВС-22-02',
  registrationNumber: 'В222ВВ77',
};

const MACHINIST = machinist();

/** Назначение заявки: окно открывается на уже выбранной машине — так виден весь состав формы. */
function assignmentOf(v: VehicleDto) {
  return {
    vehicleId: v.id,
    ownership: v.ownership,
    vehicleKindId: v.vehicleKindId,
    vehicleTypeId: v.vehicleTypeId,
    typeName: v.typeName,
    vehicleCategoryId: v.vehicleCategoryId,
    categoryName: v.categoryName,
    categorySpecs: v.categorySpecs,
    modelName: v.modelName,
    registrationNumber: v.registrationNumber,
    description: v.description,
    lessorId: v.lessorId,
    lessorName: v.lessorName,
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  };
}

/** Причина отказа под своим полем (ADR 0094) — её рисует `Form.Item`, а не тост. */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

/**
 * Что стоит в поле выбора: `null` — поле пустое. Читается заполненное содержимое поля
 * (`ant-select-content-has-value`), а не текст всего `Form.Item`: у пустого поля там лежит
 * placeholder, и «пусто» от «выбрано» так не отличить.
 */
function selectedText(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-select-content-has-value')?.getAttribute('title') ?? null;
}

function renderAssign(isLinear: boolean, onSubmit: (v: unknown) => void = () => {}) {
  mockHttp({
    'GET /vehicles': () => json(list([LIFT, LIFT_2])),
    // Машинисты — весь справочник водителей: отбора по документам у ЭСМ-2 нет (ADR 0095).
    'GET /drivers': () => json(list([MACHINIST])),
  });
  renderWithUser(
    <VehicleAssignModal
      request={vehicleRequest({
        isLinear,
        vehicleTypeId: 'vt-1',
        vehicleTypeName: 'Автовышки',
        vehicleKindId: 'vk-special',
        vehicleCategoryId: 'vc-1',
        vehicleCategoryName: 'Автовышки, 22 м',
        vehicleCategorySpecs: null,
        assignment: assignmentOf(LIFT),
      })}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
}

describe('перевод в работу заказа линейной техники', () => {
  it('вместо перечня недель — объяснение: ЭСМ-2 по требованию, день печатает 4-П', async () => {
    renderAssign(true);

    expect(
      await screen.findByText('Линейная техника: ЭСМ-2 выписывается по требованию'),
    ).toBeDefined();
    expect(screen.getByText(/Работа каждого дня печатается своим 4-П/)).toBeDefined();
    // Перечня недель нет, потому что нет и расхода бланков: обещать их было бы неправдой.
    expect(screen.queryByText(/Будет выписано листов ЭСМ-2/)).toBeNull();
  });

  it('машинист необязателен: листов в этот момент не рождается', async () => {
    const onSubmit = vi.fn();
    renderAssign(true, onSubmit);
    await screen.findByText('Машинист');

    expect(
      screen.getByText('Необязательно: листов ЭСМ-2 перевод в работу не выписывает'),
    ).toBeDefined();
    fireEvent.click(screen.getByText('Взять в работу'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as {
      assignment: { vehicleId: string; driverPersonId?: string };
    };
    expect(body.assignment.vehicleId).toBe('v-lift');
    // Имени в назначение не уходит: кто сядет за технику во вторник, решают во вторник.
    expect(body.assignment.driverPersonId).toBeUndefined();
  });

  it('доставки на объект не предлагает: линейная машина вечером уезжает на базу', async () => {
    renderAssign(true);
    await screen.findByText('Машинист');

    expect(screen.queryByText('Доставка на объект')).toBeNull();
    expect(screen.queryByText(/Техника едет своим ходом/)).toBeNull();
  });
});

describe('обычный заказ техники на объект не изменился', () => {
  it('называет недели до нажатия и предлагает перегон', async () => {
    renderAssign(false);

    // Срок заявки — 05.08–07.08: одна неделя, одна выписка, и она названа числами.
    expect(await screen.findByText('Будет выписано листов ЭСМ-2: 1 — 05.08–07.08')).toBeDefined();
    expect(screen.getByText('Доставка на объект')).toBeDefined();
    expect(screen.queryByText('Линейная техника: ЭСМ-2 выписывается по требованию')).toBeNull();
  });

  it('без машиниста в работу не уходит: на него выписываются листы', async () => {
    const onSubmit = vi.fn();
    renderAssign(false, onSubmit);
    await screen.findByText('Машинист');

    fireEvent.click(screen.getByText('Взять в работу'));

    await waitFor(() => expect(fieldError('Машинист')).toContain('Выберите машиниста'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/** Линейная заявка в работе: с неё и выписывают недельный лист по требованию. */
const CONFIRMED = vehicleRequest({
  id: 'vr-9',
  isLinear: true,
  status: 'confirmed',
  dateFrom: '2026-08-03',
  dateTo: '2026-08-21',
  assignment: assignmentOf(LIFT),
  version: 4,
});

function renderEsm2() {
  const http = mockHttp({
    'GET /vehicles': () => json(list([LIFT, LIFT_2])),
    'GET /drivers': () => json(list([MACHINIST])),
    'POST /vehicle-requests/:id/esm2': () => json(CONFIRMED),
  });
  renderWithUser(<VehicleEsm2Modal request={CONFIRMED} onClose={() => {}} onDone={() => {}} />);
  return http;
}

describe('выписка ЭСМ-2 по требованию', () => {
  /**
   * День прогона зафиксирован, и без этого набор ломается сам собой: «текущая» неделя в сценариях
   * названа числами (10–16.08.2026), а форма сравнивает её с сегодняшним днём — 17 августа неделя
   * стала прошлым, окно потребовало причину заднего числа, и первый сценарий покраснел, не
   * изменившись ни строкой. Соседний сценарий про прошедшую неделю с этим уже считался — его
   * комментарий объясняет, почему там взято начало срока заявки; здесь то же самое сделано
   * прямо: середина недели 10–16.08 остаётся серединой при любом дне прогона.
   *
   * `shouldAdvanceTime` обязателен: без него `waitFor` из testing-library ждёт по остановленным
   * часам и падает по своему тайм-ауту, ничего не дождавшись.
   */
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-08-13T09:00:00') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('спрашивает неделю, машину и машиниста и уходит на сервер выбранным', async () => {
    const http = renderEsm2();
    await screen.findByText('Неделя');

    // Машина подставлена назначенной: ею закрывают большинство недель.
    await waitFor(() => expect(selectedText('Машина')).toContain('А111АА77'));
    // А машинист — нет, и это решение: графа одна на неделю, а водитель у каждого дня свой.
    // Единственный в справочнике сам в поле тоже не встаёт.
    expect(selectedText('Машинист')).toBeNull();

    typeDate('Неделя', '12.08.2026');
    // Границы листа считает сервер, но обещание портала совпадает с выпиской: та же неделя.
    await waitFor(() =>
      expect(screen.getByText('Лист покроет 10.08.2026 – 16.08.2026')).toBeDefined(),
    );

    await selectOption('Машинист', /Семёнов/);
    fireEvent.click(screen.getByText('Выписать лист'));

    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/esm2')).toBe(1));
    expect(http.lastCall('POST /vehicle-requests/:id/esm2')!.body).toEqual({
      weekOf: '2026-08-12',
      vehicleId: 'v-lift',
      driverPersonId: 'p-machinist',
      version: 4,
    });
  });

  it('день за сроком заявки называется до нажатия, а не отказом сервера', async () => {
    renderEsm2();
    await screen.findByText('Неделя');

    typeDate('Неделя', '25.08.2026');

    await waitFor(() =>
      expect(
        screen.getByText('Этот день за сроком заявки — выберите день внутри срока'),
      ).toBeDefined(),
    );
  });

  /**
   * Прошедшая неделя (ADR 0101 п. 4, дыра 3 плана). Для линейного заказа это частый случай: бланк
   * просят, когда неделя кончилась и известно, что машина работала. Сервер выписывает такой лист
   * только с правом, причиной и ключом операции, и форма обязана спросить причину до нажатия —
   * иначе человек соберёт неделю и получит 422.
   *
   * Неделя 3–9 августа выбрана нарочно: она лежит в начале срока заявки и остаётся прошедшей при
   * любом дне прогона — в отличие от недели дня среза, которая когда-нибудь тоже станет прошлым.
   */
  it('у прошедшей недели спрашивает причину и уносит её с ключом операции', async () => {
    const http = renderEsm2();
    await screen.findByText('Неделя');

    typeDate('Неделя', '05.08.2026');
    await waitFor(() =>
      expect(screen.getByText('Лист покроет 03.08.2026 – 09.08.2026')).toBeDefined(),
    );
    await selectOption('Машинист', /Семёнов/);

    // Без причины форма запрос не отправляет вовсе: тело заведомо отклоняемое.
    fireEvent.click(screen.getByText('Выписать лист'));
    await waitFor(() => expect(fieldError('Причина заднего числа')).toContain('Укажите причину'));
    expect(http.countOf('POST /vehicle-requests/:id/esm2')).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина заднего числа'), {
      target: { value: 'машина отработала неделю, бланк по факту' },
    });
    fireEvent.click(screen.getByText('Выписать лист'));

    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/esm2')).toBe(1));
    const body = http.lastCall('POST /vehicle-requests/:id/esm2')!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      weekOf: '2026-08-05',
      vehicleId: 'v-lift',
      driverPersonId: 'p-machinist',
      version: 4,
      reason: 'машина отработала неделю, бланк по факту',
    });
    // Ключ идемпотентности придумывает клиент — повтор после обрыва связи обязан вернуть тот же
    // номер, а не сжечь следующий (Р31). Его значение случайно, проверяется само его наличие.
    expect(typeof body.operationId).toBe('string');
  });

  it('без машиниста лист не выписывается', async () => {
    const http = renderEsm2();
    await screen.findByText('Неделя');

    typeDate('Неделя', '12.08.2026');
    fireEvent.click(screen.getByText('Выписать лист'));

    await waitFor(() => expect(fieldError('Машинист')).toContain('Выберите машиниста'));
    expect(http.countOf('POST /vehicle-requests/:id/esm2')).toBe(0);
  });
});
