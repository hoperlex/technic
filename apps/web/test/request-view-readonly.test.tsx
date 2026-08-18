import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type {
  AuthUser,
  RequestWaybillDto,
  VehicleRequestAssignmentDto,
  VehicleRequestDaysDto,
  VehicleRequestDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';

/**
 * Карточка заявки в режиме читалки — `readOnly` (ADR 0120, план «маршрут и заявка окнами», §3.5).
 *
 * Так её открывает держатель окон: из состава рейса, из задания путевого листа, из журнала листов
 * и из гаража — поверх того экрана, где о заявке спросили. Действия карточки закрыты тем, что их
 * пропы просто не передают, и проверять тут нечего. Проверять нужно ровно то, что **пропами не
 * закрывается**, и то, что режим намеренно НЕ прячет.
 *
 * Первое — вкладка «Дни работ» линейного заказа: карточка монтирует её сама, а планирование дня и
 * снятие его с рейса живут внутри `VehicleRequestDays` собственными мутациями. Условие их
 * доступности — `vehicleRequests.status && waybills.read`, то есть **ровно то же**, каким
 * открывается рейс. Значит, диспетчер, заглянувший в заявку из рейса, без флага получил бы там
 * рабочий планировщик, ничего для этого не сделав: не «кнопка выключена», а полноценная правка
 * чужого дня из окна, открытого посмотреть. Поэтому сценарий идёт парой — с флагом и без него: без
 * второй половины он доказывал бы лишь то, что кнопок в этой карточке нет вовсе.
 *
 * Второе — то, что читалка сохраняет, и это решено планом явно: сама вкладка «Дни работ» остаётся
 * (она и отвечает на «каким рейсом едет какой день» — вопрос, ради которого заявку из рейса и
 * открывают), а печать листа остаётся доступной (печать бумаги — чтение, и `waybills.read` у
 * открывшего рейс заведомо есть).
 *
 * Третье — «Открыть в списке заявок»: единственная дверь читалки к действиям. Адрес ей считает
 * `vehicleRequestLink` по **загруженному DTO**, а не по одному статусу: вкладку выбирает ещё и
 * `deletedAt`, а архив закрыт своим правом — без `archive.read` кнопки нет вовсе, потому что
 * ссылка, кончающаяся отказом, хуже её отсутствия.
 */

/** Назначение собственной машиной: без него дни планировать нечем (`linearDaysBlocker`). */
const ASSIGNMENT: VehicleRequestAssignmentDto = {
  vehicleId: 'v-lift',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автовышки',
  vehicleCategoryId: 'vc-1',
  categoryName: 'Автовышки, 22 м',
  categorySpecs: null,
  modelName: 'ВС-22-01',
  registrationNumber: 'А111АА77',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Д. П.',
  assignedAt: '2026-08-09T10:00:00.000Z',
};

/** Линейный заказ в работе на своей машине: только у такого и бывает вкладка «Дни работ». */
const LINEAR = vehicleRequest({
  id: 'vr-9',
  displayNumber: 'ТС-42',
  isLinear: true,
  status: 'confirmed',
  dateFrom: '2026-08-10',
  dateTo: '2026-08-16',
  assignment: ASSIGNMENT,
});

/**
 * Неделя срока: один день уже стоит в рейсе, второй свободен. Оба нужны, потому что кнопок в
 * колонке действий две и приходят они из разных веток — «Снять» у распланированного дня, «В рейс»
 * у свободного.
 */
const DAYS: VehicleRequestDaysDto = {
  onDate: '2026-08-12',
  blocker: null,
  items: [
    {
      date: '2026-08-10',
      outOfTerm: false,
      otherVehicle: false,
      route: {
        id: 'r-12',
        displayNumber: 'Р-12',
        position: 3,
        vehicleId: 'v-lift',
        vehicleLabel: 'ВС-22-01 · А111АА77',
        driverPersonId: 'p-1',
        driverName: 'Тестовый Водитель Первый',
        // Листа по рейсу нет: замороженный бумагой рейс день не отдаёт вовсе, и «Снять» была бы
        // выключена по своей причине — сценарий же смотрит на причину «это читалка».
        waybill: null,
        version: 1,
      },
      shift: null,
    },
    { date: '2026-08-12', outOfTerm: false, otherVehicle: false, route: null, shift: null },
  ],
};

/** Лист, выписанный по заявке: его печатают прямо из карточки, не уходя в журнал (ADR 0041). */
const WAYBILL: RequestWaybillDto = {
  id: 'w-1',
  number: '260604-646-00000004897',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-08-10',
  periodFrom: null,
  periodTo: null,
  slot: 1,
  driverName: 'Тестовый Водитель Первый',
  routeId: 'r-12',
  routeNumber: 'Р-12',
};

interface CardOptions {
  /** Читалка. Не передан — карточка смонтирована так, как её монтирует вкладка заявок. */
  readOnly?: boolean;
  user?: AuthUser;
  waybills?: RequestWaybillDto[];
}

function renderCard(request: VehicleRequestDto, options: CardOptions = {}) {
  const http = mockHttp({
    'GET /vehicle-requests/:id/history': () => json([]),
    'GET /vehicle-requests/:id/driver': () =>
      json({ personId: 'p-1', fullName: 'Тестовый Водитель Первый', phone: '' }),
    'GET /vehicle-requests/:id/waybills': () => json(options.waybills ?? []),
    'GET /vehicle-requests/:id/relocations': () => json([]),
    'GET /vehicle-requests/:id/days': () => json(DAYS),
    // Запросов планировщика дня (`GET /vehicles`, `/vehicle-routes/suggest`, `/drivers/available`)
    // здесь нет намеренно: ни один сценарий его не открывает, а незамоканный запрос общая сверка
    // после теста не пропустит (`test/setup.ts`) — то есть окно, взявшееся ниоткуда, себя выдаст.
  });
  const result = renderWithUser(
    <VehicleRequestViewModal request={request} onClose={() => {}} readOnly={options.readOnly} />,
    // Диспетчер: у него есть и `vehicleRequests.status`, и `waybills.read` — то самое условие,
    // которым открывается рейс и по которому раньше становились рабочими кнопки дней. Архива
    // (`archive.read`) у него нет, и это тоже предмет проверки ниже.
    { user: options.user ?? authUser({ role: 'dispatcher' }) },
  );
  return { ...result, http };
}

/** Открыть вкладку «Дни работ»: antd рисует содержимое вкладки только после перехода на неё. */
async function openDaysTab(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: 'Дни работ' }));
  await screen.findByText('10.08.2026');
}

/** Строка таблицы дней по дате: кнопки и рейс читаются в пределах своего дня. */
function dayRow(date: string): HTMLElement {
  return screen.getByText(date).closest('tr') as HTMLElement;
}

describe('дни линейного заказа в читалке заявки', () => {
  it('показывает, каким рейсом едет какой день, но ни планировать, ни снимать не даёт', async () => {
    renderCard(LINEAR, { readOnly: true });
    await openDaysTab();

    // Вкладка осталась и отвечает на свой вопрос: рейс дня, его строка задания, машина и водитель.
    // Спрятать её было бы проще, но читалка стала бы беднее той же карточки в списке заявок.
    const planned = dayRow('10.08.2026');
    expect(within(planned).getByText('Р-12')).toBeDefined();
    expect(within(planned).getByText('строка 3')).toBeDefined();
    expect(within(planned).getByText('ВС-22-01 · А111АА77')).toBeDefined();
    expect(screen.getByText('распланировано 1 из 2 дней')).toBeDefined();

    // А колонки действий нет вовсе — и это не выключенные кнопки: права у диспетчера как раз
    // хватает, планировать нельзя потому, что заявку открыли посмотреть.
    expect(within(planned).queryByText('Снять')).toBeNull();
    expect(within(dayRow('12.08.2026')).queryByText('В рейс')).toBeNull();

    // Планировщика нет и в дереве: `VehicleDayRouteModal` в этом режиме не монтируется вовсе, и
    // взяться ему неоткуда — единственная дверь к нему та самая колонка действий. Спрашивается
    // его собственная кнопка подтверждения: заголовок окна называет день, а она — само окно.
    expect(screen.queryByText('Поставить в рейс')).toBeNull();
  });

  it('без читалки та же вкладка даёт и поставить день в рейс, и снять его', async () => {
    renderCard(LINEAR);
    await openDaysTab();

    // Тот же экран, тот же человек, те же права — разница ровно в одном флаге. Кнопки не просто
    // нарисованы, а рабочие: выключенная объясняла бы себя нехваткой права, и проверка выше
    // доказывала бы тогда не читалку, а отсутствие прав у диспетчера.
    const remove = within(dayRow('10.08.2026')).getByText('Снять').closest('button')!;
    expect(remove.disabled).toBe(false);

    const plan = within(dayRow('12.08.2026')).getByText('В рейс').closest('button')!;
    expect(plan.disabled).toBe(false);
  });
});

describe('дверь читалки в список заявок', () => {
  it('закрытую заявку ведёт в журнал, а удалённую — в архив', async () => {
    const closed = vehicleRequest({ id: 'vr-7', displayNumber: 'ТС-7', status: 'done' });
    const { unmount } = renderCard(closed, { readOnly: true });

    const toHistory = await screen.findByRole('link', { name: 'Открыть в списке заявок' });
    // Адрес считается по загруженному DTO: закрытая заявка живёт в журнале, а не в рабочем списке.
    expect(toHistory.getAttribute('href')).toBe('/vehicle-requests?tab=history&open=vr-7');
    unmount();

    // Удалённая заявка — в архиве, и выбирает его `deletedAt`, а не статус: заявку удаляют из
    // любого состояния, и по статусу «выполнена» ссылка ушла бы в журнал, где её больше нет.
    const deleted = vehicleRequest({
      id: 'vr-8',
      displayNumber: 'ТС-8',
      status: 'done',
      deletedAt: '2026-08-15T09:00:00.000Z',
      deletedByName: 'Админов А. А.',
    });
    renderCard(deleted, { readOnly: true, user: authUser({ role: 'admin' }) });

    const toArchive = await screen.findByRole('link', { name: 'Открыть в списке заявок' });
    expect(toArchive.getAttribute('href')).toBe('/vehicle-requests?tab=archive&open=vr-8');
  });

  it('без права на архив кнопки нет вовсе — но та же заявка не удалённой её показывает', async () => {
    // Диспетчер: заявки ведёт, а архив (`archive.read`) ему не положен. Ссылка в архив кончилась
    // бы для него отказом — поэтому её нет, а не «есть и не работает».
    const deleted = vehicleRequest({
      id: 'vr-8',
      displayNumber: 'ТС-8',
      status: 'confirmed',
      deletedAt: '2026-08-15T09:00:00.000Z',
      deletedByName: 'Админов А. А.',
    });
    const { unmount } = renderCard(deleted, { readOnly: true });

    await screen.findByText('Заявка ТС-8');
    expect(screen.queryByRole('link', { name: 'Открыть в списке заявок' })).toBeNull();
    unmount();

    // Та же заявка и та же роль без `deletedAt` — кнопка на месте: архив выбирается удалением, и
    // одного статуса «в работе» для отказа было бы мало.
    renderCard({ ...deleted, deletedAt: null, deletedByName: null }, { readOnly: true });

    const link = await screen.findByRole('link', { name: 'Открыть в списке заявок' });
    expect(link.getAttribute('href')).toBe('/vehicle-requests?tab=requests&open=vr-8');
  });
});

describe('печать листа из читалки', () => {
  it('остаётся доступной: печать бумаги — чтение, и право на неё у открывшего уже есть', async () => {
    renderCard(vehicleRequest({ id: 'vr-7', status: 'confirmed', assignment: ASSIGNMENT }), {
      readOnly: true,
      waybills: [WAYBILL],
    });

    expect(await screen.findByText(WAYBILL.number)).toBeDefined();
    const print = await screen.findByLabelText('Печать бланка');
    expect((print as HTMLButtonElement).disabled).toBe(false);
  });
});
