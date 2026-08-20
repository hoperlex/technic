import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleRouteDto,
  WAYBILL_CORRECTION_DAYS,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { dateInput, selectOption, typeDate } from './antd';
import { formatDateOnly } from '../src/utils/date';
import { VehicleRouteEditModal } from '../src/pages/vehicle/VehicleRouteEditModal';

/**
 * Правка рейса: день, водитель и реквизиты выезда.
 *
 * Главное здесь — перенос дня. Он меняет не только строку рейса: заявка едет в тот день, в
 * который заведён рейс, и вместе с рейсом переезжает её подача. Поэтому проверяется, что перенос
 * спрашивают отдельным окном с перечнем заявок — «двигаю рейс» и «двигаю четыре чужих заказа» это
 * разные решения, и человек должен видеть, какое принимает.
 *
 * Второе — водитель: список подсказывает (пригодные первыми, с пометками), но никого не
 * подставляет сам, даже когда пригоден он один.
 *
 * Третье — задний ход (ADR 0101 п. 4 и 6, Р29): у прошлого рейса без листа водитель правится
 * свободно, а день двигается только с правом и причиной. Спутать эти два случая — значит либо
 * запереть дневную работу диспетчера, либо открыть прошедший календарь всем, кто правит рейсы.
 *
 * Даты здесь считаются от сегодняшнего дня, а не записаны числами: граница заднего числа живёт
 * относительно «сегодня», и прибитый календарём тест однажды начал бы проверять другой случай, чем
 * задумано, — молча и не в тот день, когда его писали.
 */

const TODAY = moscowDateKeyOf(new Date());
const TOMORROW = shiftDateKey(TODAY, 1);
/** Куда переносят рейс в сценарии обычного переноса: будущее, заднего хода в нём нет. */
const NEXT_WEEK = shiftDateKey(TODAY, 7);
const YESTERDAY = shiftDateKey(TODAY, -1);
/** Глубже предела диспетчера (Р37): такую давность двигает только администратор. */
const LONG_AGO = shiftDateKey(TODAY, -WAYBILL_CORRECTION_DAYS - 5);

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: TOMORROW,
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: null,
  driverName: '',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'городское',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      status: 'confirmed',
      customerName: 'Объект А',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 1',
      scheduledAt: `${TOMORROW}T06:00:00.000Z`,
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
  ],
  // Порядок объезда сценарию не нужен: он проверяет рейс целиком, а не сборку дня.
  points: [],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 3,
};

/** Рейс, замороженный выданным листом: бумага у водителя, и править нечего. */
const FROZEN: VehicleRouteDto = {
  ...ROUTE,
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: TOMORROW,
  },
};

/**
 * Прошедший рейс без листа — то самое состояние, о котором ADR 0101 п. 6 говорит «планировочная
 * запись»: день прошёл, бумаги не было, и правка водителя ничего о прошедшем дне не утверждает.
 */
const PAST: VehicleRouteDto = { ...ROUTE, routeDate: YESTERDAY };

const SELECTION = {
  requiredCategory: 'C',
  requiredCategoryType: 'driver_license',
  drivers: [
    {
      personId: 'p-1',
      fullName: 'Тестовый Водитель Первый',
      personnelNo: 'Т-001',
      credentialTypeCode: 'driver_license',
      licenseNumber: '00 00 000001',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['C'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

/**
 * Роль задаёт глубину заднего числа (ADR 0101 п. 7): у администратора её нет вовсе, у диспетчера
 * тридцать дней, у менеджера права на коррекцию нет — а рейсы он ведёт наравне с диспетчером.
 */
function renderModal(
  route: VehicleRouteDto = ROUTE,
  role: 'admin' | 'dispatcher' | 'manager' = 'admin',
) {
  const http = mockHttp({
    'GET /drivers/available': () => json(SELECTION),
    'PATCH /vehicle-routes/:id': ({ body }) => json({ ...route, ...(body as object) }),
  });
  renderWithUser(<VehicleRouteEditModal route={route} onClose={() => {}} onSaved={() => {}} />, {
    user: authUser({ role }),
  });
  return http;
}

function patchBody(http: ReturnType<typeof renderModal>): Record<string, unknown> {
  return http.lastCall('PATCH /vehicle-routes/:id')!.body as Record<string, unknown>;
}

describe('правка рейса', () => {
  it('водитель не подставляется сам, даже когда пригоден он один', async () => {
    renderModal();
    await screen.findByText('Дата рейса');

    // Единственный вариант в списке — но поле остаётся пустым: за руль сажает диспетчер.
    await waitFor(() => expect(screen.getByText('Выберите водителя')).toBeDefined());
  });

  it('смена водителя уходит на сервер вместе с версией рейса', async () => {
    const http = renderModal();
    await screen.findByText('Дата рейса');

    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const body = patchBody(http);
    expect(body.driverPersonId).toBe('p-1');
    expect(body.version).toBe(3);
    // День не трогали — он уходит прежним, и подтверждения переноса не было.
    expect(body.routeDate).toBe(TOMORROW);
  });

  /**
   * Вид сообщения печатается в графе бланка, поэтому окно спрашивает его списком из трёх слов и
   * пустым не выпускает. Два случая, которых список сам по себе не покрывает, и проверяются здесь:
   * рейс со своим написанием и рейс с пустой графой — оба заведены до появления списка, и обоих в
   * портале большинство.
   */
  it('чужое написание вида сообщения остаётся выбранным и уходит на сервер прежним', async () => {
    const http = renderModal({ ...ROUTE, communicationKind: 'междугородное' });
    await screen.findByText('Дата рейса');

    // Значение вне набора стоит пунктом списка: правка водителя не должна молча переписывать
    // графу, которая на выданном по этому рейсу листе уже напечатана.
    expect(screen.getByTitle('междугородное')).toBeDefined();

    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const trip = patchBody(http).trip as Record<string, unknown>;
    expect(trip.communicationKind).toBe('междугородное');
  });

  it('пустая графа вида сообщения открывается умолчанием, а не запирает сохранение', async () => {
    const http = renderModal({ ...ROUTE, communicationKind: '' });
    await screen.findByText('Дата рейса');

    expect(screen.getByTitle('пригородное')).toBeDefined();

    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const trip = patchBody(http).trip as Record<string, unknown>;
    expect(trip.communicationKind).toBe('пригородное');
  });

  it('перенос дня спрашивают отдельно и называют переезжающие заявки', async () => {
    const http = renderModal();
    await screen.findByText('Дата рейса');

    typeDate('Дата рейса', formatDateOnly(NEXT_WEEK));
    fireEvent.click(screen.getByText('Сохранить'));

    // Пока не подтвердили — на сервер ничего не ушло. Заголовок окна antd рисует дважды
    // (сам заголовок и его копия для чтения с экрана), поэтому ищем все совпадения.
    expect(
      (await screen.findAllByText(`Перенести маршрут на ${formatDateOnly(NEXT_WEEK)}?`)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/ТС-501/).length).toBeGreaterThan(0);
    expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(0);

    fireEvent.click(screen.getByText('Перенести'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const body = patchBody(http);
    expect(body.routeDate).toBe(NEXT_WEEK);
    // Будущее задним числом не является: причины у такого переноса нет и быть не должно.
    expect(body.reason).toBeUndefined();
  });

  it('рейс с выписанным листом не правится и объясняет почему', async () => {
    const http = renderModal(FROZEN);
    await screen.findByText('Дата рейса');

    expect(screen.getByText(/аннулируйте его, чтобы править рейс/)).toBeDefined();
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(0));
  });

  it('у прошлого рейса водитель правится без причины (ADR 0101 п. 6)', async () => {
    const http = renderModal(PAST);
    await screen.findByText('Дата рейса');

    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const body = patchBody(http);
    expect(body.driverPersonId).toBe('p-1');
    // Ни поля причины на экране, ни причины в теле: день не двигали, и заднего числа здесь нет.
    expect(screen.queryByText('Причина заднего числа')).toBeNull();
    expect(body.reason).toBeUndefined();
  });

  it('перенос дня прошлого рейса спрашивает причину и уносит её на сервер', async () => {
    const http = renderModal(PAST);
    await screen.findByText('Дата рейса');

    // Переносим во **вперёд**, на сегодня: заднее число всё равно есть — более ранней из двух дат
    // остаётся вчерашний день рейса, о котором перенос и утверждает (§4 плана ADR 0101).
    typeDate('Дата рейса', formatDateOnly(TODAY));
    await screen.findByText('Причина заднего числа');

    // Без причины форма запроса не шлёт: сервер ответил бы 422, и узнавать об этом из отказа
    // человеку незачем.
    fireEvent.click(screen.getByText('Сохранить'));
    await screen.findByText('Укажите причину');
    expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(0);

    fireEvent.change(screen.getByPlaceholderText(/рейс состоялся во вторник/), {
      target: { value: 'Рейс был вчера, в портал внесли сегодня' },
    });
    fireEvent.click(screen.getByText('Сохранить'));
    fireEvent.click(await screen.findByText('Перенести'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const body = patchBody(http);
    expect(body.routeDate).toBe(TODAY);
    expect(body.reason).toBe('Рейс был вчера, в портал внесли сегодня');
  });

  it('без права коррекции день прошлого рейса не двигается вовсе', async () => {
    renderModal(PAST, 'manager');
    await screen.findByText('Дата рейса');

    // У менеджера `waybills.correct` нет: любая новая дата даст ту же вчерашнюю более ранней из
    // двух, и сервер ответит 403. Портал не предлагает того, что ручка отклонит.
    expect(dateInput('Дата рейса').disabled).toBe(true);
    expect(screen.getByText(/право коррекции задним числом/)).toBeDefined();
    // Водитель при этом правится: рейс без листа — планировочная запись.
    expect(screen.getByText('Выберите водителя')).toBeDefined();
  });

  it('глубже тридцати дней диспетчер день не двигает — это к администратору (Р37)', async () => {
    renderModal({ ...ROUTE, routeDate: LONG_AGO }, 'dispatcher');
    await screen.findByText('Дата рейса');

    expect(dateInput('Дата рейса').disabled).toBe(true);
    expect(screen.getByText(new RegExp(`старше ${WAYBILL_CORRECTION_DAYS} дней`))).toBeDefined();
  });
});
