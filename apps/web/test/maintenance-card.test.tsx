import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingTotals,
  VehicleDto,
  VehicleReadingCardDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { maintenanceRecord, maintenanceSummary } from './factories/maintenance';
import { MOBILE_VIEWPORT } from './viewport';
import { VehicleMaintenanceBlock } from '../src/features/vehicle-maintenance';
import { VehiclesTab } from '../src/pages/directories/VehiclesTab';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Обслуживание техники на портале (план «Показания техники», Р11а—Р15, Р24, Р30).
 *
 * Проверяется то, ради чего блок отделён от статистики. Право на ТО и право на показания
 * независимы (Р14), и независимость эта проверяема ровно одним способом: **без права
 * `vehicleMaintenance.read` блока нет и запроса нет**. Не «пустой блок» и не «ответ без полей» —
 * тогда право влияло бы на состав чужого DTO, то есть на то же смешение, только спрятанное.
 *
 * Дальше — состояние. Портал его не считает (Р24): «неизвестно» ниже норматива при сброшенном
 * счётчике и «просрочено» выше него при том же сбросе — это асимметрия правила Р11в, и своя
 * формула на портале дала бы в первом случае «скоро ТО». Заодно проверяется, что незнание
 * объяснено словами: «неизвестно» без объяснения читается как поломка портала, а «не ведётся» —
 * как потерянные показания.
 *
 * И форма (Р15): одна на два входа, с подсказкой вместо автоподстановки, с предупреждением вместо
 * отказа и с внятным словом на конфликт версий (Р30).
 */

const SUMMARY = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';
const CREATE = 'POST /vehicle-maintenance/vehicles/:vehicleId';
const UPDATE = 'PATCH /vehicle-maintenance/:id';
const REMOVE = 'DELETE /vehicle-maintenance/:id';

/** День среза блока: карточка машины отдаёт ему конец своего периода (Р16). */
const ON = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';

/** Текст всего показанного с нормализованными неразрывными пробелами: «8 340 км» ищут глазами. */
const shown = () => (document.body.textContent ?? '').replace(/\u00a0/gu, ' ');

function renderBlock(over: RouteMap = {}, user = authUser()): HttpMock {
  const http = mockHttp({
    [SUMMARY]: () => json(maintenanceSummary()),
    [HISTORY]: () => json({ items: [maintenanceRecord()] }),
    ...over,
  });
  renderWithUser(<VehicleMaintenanceBlock vehicleId="v-1" vehicleLabel={LABEL} on={ON} />, {
    user,
  });
  return http;
}

/** Блок с готовой сводкой: дальше по нему и спрашивают. */
async function blockWith(summary: Partial<Parameters<typeof maintenanceSummary>[0]> = {}) {
  const http = renderBlock({ [SUMMARY]: () => json(maintenanceSummary(summary)) });
  await screen.findByText('Обслуживание');
  return http;
}

describe('блок обслуживания в карточке машины', () => {
  it('без права на ТО не рисуется и ничего не запрашивает', async () => {
    // Штаб объекта ведёт заявки, но к обслуживанию техники отношения не имеет: права на ТО у него
    // нет вовсе. Блок обязан молчать — не «блок с пустотой», а отсутствие блока и запроса.
    const http = renderBlock({}, authUser({ role: 'shtab' }));

    await waitFor(() => expect(screen.queryByText('Обслуживание')).toBeNull());
    expect(http.calls).toEqual([]);
  });

  it('с правом спрашивает свою ручку и показывает состояние', async () => {
    const http = await blockWith();

    // Своя ручка под своим правом (Р14а), и день среза — тот, что дала карточка (Р16).
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    expect(http.lastCall(SUMMARY)!.path).toBe('/vehicle-maintenance/vehicles/v-1/summary');
    expect(http.lastCall(SUMMARY)!.query.get('on')).toBe(ON);
    expect(http.countOf(HISTORY)).toBe(1);

    expect(shown()).toContain('в норме');
    expect(shown()).toContain('8 340 км');
    // Последний одометр — единственное показание, видимое под правом ТО (Р14б): без него число
    // «с ТО» нечем проверить.
    expect(shown()).toContain('128 340 км');
    expect(shown()).toContain('снято 22.07.2026');
  });

  it('пробег ≥ норматива — просрочено', async () => {
    await blockWith({ kmSince: 10200 });

    expect(shown()).toContain('просрочено');
    expect(shown()).toContain('10 200 км');
    expect(shown()).toContain('Норматив 10 000 км пройден');
  });

  it('у границы норматива — скоро ТО', async () => {
    await blockWith({ kmSince: 9500 });

    expect(shown()).toContain('скоро ТО');
    expect(shown()).not.toContain('просрочено');
  });

  it('разрыв ряда ниже норматива — неизвестно и нижняя граница, а не «скоро ТО»', async () => {
    /*
     * Та же цифра, что в предыдущей проверке, но со сброшенным счётчиком. Своя формула на портале
     * («9 500 — это почти 10 000») ответила бы «скоро ТО»; контрактная говорит «неизвестно»,
     * потому что через сброс машина могла пройти сколько угодно (Р11в).
     */
    await blockWith({ kmSince: 9500, chainBroken: true });

    expect(shown()).toContain('неизвестно');
    expect(shown()).not.toContain('скоро ТО');
    // Число показано оговоркой — тем же приёмом, что и заниженный пробег в статистике.
    expect(shown()).toContain('не меньше 9 500 км');
    expect(shown()).toContain('счётчик меняли');
  });

  it('разрыв ряда выше норматива всё равно просрочено', async () => {
    // Асимметрия правила (Р11в): флаги могут только увеличить пробег, поэтому превышение
    // достоверно при любом из них — «неизвестно» здесь скрыло бы машину, которую пора обслужить.
    await blockWith({ kmSince: 10200, chainBroken: true });

    expect(shown()).toContain('просрочено');
    expect(shown()).not.toContain('неизвестно');
  });

  it('незакрытый хвост ожиданий объяснён своими словами', async () => {
    await blockWith({ kmSince: 4200, lowerBound: true });

    expect(shown()).toContain('неизвестно');
    expect(shown()).toContain('не меньше 4 200 км');
    expect(shown()).toContain('сданы не все смены');
  });

  it('тип техники без ТО объяснён словами, а не пустотой', async () => {
    await blockWith({ maintenanceBasis: 'none', kmSince: null, lastMaintenance: null });

    expect(shown()).toContain('не ведётся');
    expect(shown()).toContain('ТО по пробегу не ведётся');
    // «Не ведём» — это норма справочника (Р13), и путать её с «не знаем» нельзя.
    expect(shown()).not.toContain('неизвестно');
  });
});

describe('форма записи ТО', () => {
  const odometerField = () => screen.getByLabelText('Пробег на момент ТО, км') as HTMLInputElement;

  async function openCreateForm(over: RouteMap = {}) {
    const http = renderBlock({
      [SUMMARY]: () => json(maintenanceSummary()),
      [CREATE]: () => json(maintenanceRecord({ id: 'm-2' }), 201),
      ...over,
    });
    fireEvent.click(await screen.findByRole('button', { name: /Добавить ТО/u }));
    await screen.findByText(`Запись о ТО — ${LABEL}`);
    return http;
  }

  it('подставляет последний известный одометр подсказкой и даёт его исправить', async () => {
    await openCreateForm();

    // Подсказка, а не готовый ответ: число из акта бывает своим (Р11а).
    expect(odometerField().value).toBe('128340');
    expect(shown()).toContain('Подставлен последний известный одометр');

    fireEvent.change(odometerField(), { target: { value: '128500' } });
    expect(odometerField().value).toBe('128500');
  });

  it('одометр меньше предыдущего — предупреждение, но отправку не блокирует', async () => {
    const http = await openCreateForm();

    fireEvent.change(odometerField(), { target: { value: '90000' } });

    // Вопрос, а не отказ: счётчики меняют, и монотонности от акта никто не требует (Р11а).
    expect(await screen.findByText(/заменяли прибор/u)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    const body = http.lastCall(CREATE)!.body as { odometerKm: number; performedOn: string };
    expect(body.odometerKm).toBe(90000);
    // Дата новой записи — день среза блока, а не сегодняшний день браузера (Р16).
    expect(body.performedOn).toBe(ON);
  });

  it('правка ушедшей версии объясняется словами', async () => {
    const http = renderBlock({
      [UPDATE]: () =>
        apiError(409, { code: 'version_conflict', message: 'Конфликт версий — обновите данные' }),
    });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить запись ТО' }));
    await screen.findByText(`Правка записи ТО — ${LABEL}`);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    // Версия уходит с правкой (Р30), а отказ по ней переводится на человеческий: «конфликт
    // версий» из ответа сервера не говорит ни что случилось, ни что делать.
    expect((http.lastCall(UPDATE)!.body as { version: number }).version).toBe(0);
    expect(await screen.findByText(/изменили в другом окне/u)).toBeDefined();
    // Сводка и журнал перечитываются: повторять отправку не по чему, сначала нужно увидеть чужое.
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(2));
  });

  it('удаление идёт с версией и после подтверждения', async () => {
    const http = renderBlock({ [REMOVE]: () => json({ ok: true }) });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить запись ТО' }));
    // Акт сносится насовсем — архива у записей ТО нет, и подтверждение об этом говорит прямо.
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(http.countOf(REMOVE)).toBe(1));
    expect(http.lastCall(REMOVE)!.path).toBe('/vehicle-maintenance/m-1');
    // Версия в адресе: тела у DELETE нет, а сносить чужую правку вслепую нельзя (Р30).
    expect(http.lastCall(REMOVE)!.query.get('version')).toBe('0');
  });
});

/**
 * Второй вход в ту же форму (Р15). Механику вкладка «Показания» не видна вовсе, и ТО он ведёт из
 * строки справочника техники — тем же окном и той же формой, что диспетчер из карточки машины.
 */

const VEHICLE: VehicleDto = {
  id: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  kindName: 'Спецтехника',
  vehicleTypeId: 'vt-1',
  typeName: 'Самосвалы',
  waybillFormCode: '4p',
  vehicleCategoryId: null,
  categoryName: null,
  categorySpecs: {},
  vehicleModelId: 'm-1',
  modelName: 'КамАЗ 65115',
  registrationNumber: 'А123ВС799',
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

function totals(): ReadingTotals {
  return {
    distanceKm: 1240,
    engineHours: 38.5,
    fuelFilledLiters: 620,
    odometerGaps: 0,
    engineHoursGaps: 0,
    missingReadings: 0,
    shifts: 30,
    unacceptedShifts: 0,
  };
}

const CARD_DTO: VehicleReadingCardDto = {
  vehicleId: 'v-1',
  vehicleLabel: LABEL,
  from: '2026-07-01',
  to: ON,
  total: totals(),
  months: [{ month: '2026-07', ...totals() }],
  lastOdometer: { km: 128340, measuredOn: '2026-07-22' },
  lastEngineHours: null,
};

const GARAGE_VEHICLES: GarageVehicleListDto = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  onDate: ON,
};
const GARAGE_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON,
};

/** Поля открытой формы — по ним и сверяются два входа: одна форма или две похожих. */
function formFields(): string[] {
  const modal = screen.getByText(/Запись о ТО/u).closest('.ant-modal') as HTMLElement;
  return [...modal.querySelectorAll('.ant-form-item-label label')].map(
    (l) => l.textContent?.trim() ?? '',
  );
}

describe('форма ТО открывается из двух точек одним компонентом', () => {
  it('из карточки машины в сводке показаний', async () => {
    mockHttp({
      'GET /vehicle-readings/stats': () => json({ items: [], from: '2026-07-01', to: ON }),
      'GET /vehicle-readings/vehicles/:vehicleId/card': () => json(CARD_DTO),
      [SUMMARY]: () => json(maintenanceSummary()),
      [HISTORY]: () => json({ items: [] }),
      // Соседний блок карточки — автозапчасти (план чеков, Р16): своя ручка под `garage.read`.
      'GET /auto-part-receipts/vehicles/:vehicleId': ({ params }) =>
        json({
          vehicleId: params.vehicleId,
          vehicleLabel: '',
          total: 0,
          totalAllTime: 0,
          rows: [],
        }),
      'GET /garage/vehicles': () => json(GARAGE_VEHICLES),
      'GET /garage/vehicles/summary': () => json(GARAGE_SUMMARY),
      'GET /vehicle-classifications': () => json(emptyList()),
    });
    renderWithUser(<GaragePage />, {
      route: `/garage?tab=readings&sub=stats&date=${ON}&from=2026-07-01&to=${ON}&vehicle=v-1`,
    });

    fireEvent.click(await screen.findByRole('button', { name: /Добавить ТО/u }));
    await screen.findByText(`Запись о ТО — ${LABEL}`);
    expect(formFields()).toEqual([
      'Дата обслуживания',
      'Пробег на момент ТО, км',
      'Номер документа',
      'Примечание',
    ]);
  });

  it('из строки справочника техники — тем же окном и той же формой', async () => {
    const http = mockHttp({
      'GET /vehicles': () => json(list([VEHICLE])),
      'GET /vehicle-types': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
      [SUMMARY]: () => json(maintenanceSummary()),
      [HISTORY]: () => json({ items: [] }),
    });
    renderWithUser(<VehiclesTab />);

    await screen.findByText('А123ВС799');
    // Пока строку не открыли, обслуживание не спрашивается: список машин не тянет за собой
    // расчёт пробега по каждой из них.
    expect(http.countOf(SUMMARY)).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Обслуживание — А123ВС799' }));
    const modal = (await screen.findByText('Обслуживание — А123ВС799')).closest(
      '.ant-modal',
    ) as HTMLElement;
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));

    fireEvent.click(within(modal).getByRole('button', { name: /Добавить ТО/u }));
    await screen.findByText(/Запись о ТО/u);
    // Ровно та же форма, что открывается из карточки машины: поля, подписи и порядок совпадают.
    expect(formFields()).toEqual([
      'Дата обслуживания',
      'Пробег на момент ТО, км',
      'Номер документа',
      'Примечание',
    ]);
  });

  it('на телефоне тот же вход стоит пунктом в действиях строки', async () => {
    const http = mockHttp({
      'GET /vehicles': () => json(list([VEHICLE])),
      'GET /vehicle-types': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
      [SUMMARY]: () => json(maintenanceSummary()),
      [HISTORY]: () => json({ items: [] }),
    });
    renderWithUser(<VehiclesTab />, { viewport: MOBILE_VIEWPORT });

    await screen.findByText('А123ВС799');
    // На телефоне строка — карточка, и действия у неё списком с подписями (ADR 0030): иконка с
    // подсказкой там не открывается вовсе.
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    fireEvent.click(await screen.findByText('Обслуживание'));

    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    expect(await screen.findByText('Обслуживание — А123ВС799')).toBeDefined();
  });

  it('без права на ТО строки справочника кнопки не показывают', async () => {
    const http = mockHttp({
      'GET /vehicles': () => json(list([VEHICLE])),
      'GET /vehicle-types': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
    });
    renderWithUser(<VehiclesTab />, { user: authUser({ role: 'shtab' }) });

    await screen.findByText('А123ВС799');
    expect(screen.queryByRole('button', { name: /Обслуживание/u })).toBeNull();
    expect(http.calls.some((c) => c.path.includes('maintenance'))).toBe(false);
  });
});

/**
 * Адрес окна сводки в справочнике техники (Р14в, Р29).
 *
 * Ключ тот же, что в гараже (`?maintenance=<id>`), и это не совпадение: окно одно на оба входа, и
 * второе имя означало бы, что ссылка из гаража и ссылка из справочника открывают разные вещи.
 * Раньше справочник открывал его состоянием компонента — тогда окно нельзя было ни прислать
 * ссылкой, ни закрыть шагом назад, а перезагрузка теряла его совсем.
 */

/** Адрес и шаг назад по истории: окно живёт в адресе, и «назад» обязано его закрыть. */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Шаг назад</button>
    </>
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';

function renderDirectory(route = '/directories'): HttpMock {
  const http = mockHttp({
    'GET /vehicles': () => json(list([VEHICLE])),
    'GET /vehicle-types': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
    [SUMMARY]: () => json(maintenanceSummary()),
    [HISTORY]: () => json({ items: [] }),
  });
  renderWithUser(
    <>
      <VehiclesTab />
      <AddressProbe />
    </>,
    { route },
  );
  return http;
}

describe('справочник техники: сводка ТО названа в адресе', () => {
  it('открытие из строки пишет машину в адрес', async () => {
    renderDirectory();

    await screen.findByText('А123ВС799');
    fireEvent.click(screen.getByRole('button', { name: 'Обслуживание — А123ВС799' }));

    expect(await screen.findByText('Обслуживание — А123ВС799')).toBeDefined();
    // Ради этого окно и живёт в адресе: ссылку отправляют коллеге, а перезагрузка её не теряет.
    expect(address()).toContain('maintenance=v-1');
  });

  it('открывается прямо из присланного адреса', async () => {
    const http = renderDirectory('/directories?maintenance=v-1');

    // Подписи из строки у такого окна нет: машина названа идентификатором, и сводка грузится по
    // нему — ровно как в гараже, куда ссылка тоже приходит без списка.
    expect(await screen.findByText('Обслуживание — машина')).toBeDefined();
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    expect(http.lastCall(SUMMARY)!.path).toBe('/vehicle-maintenance/vehicles/v-1/summary');
  });

  it('«назад» закрывает окно, а не уводит из справочника', async () => {
    renderDirectory();

    await screen.findByText('А123ВС799');
    fireEvent.click(screen.getByRole('button', { name: 'Обслуживание — А123ВС799' }));
    expect(await screen.findByText('Обслуживание — А123ВС799')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));

    await waitFor(() => expect(screen.queryByText('Обслуживание — А123ВС799')).toBeNull());
    expect(address()).not.toContain('maintenance=');
    // Список остался на месте: закрылось окно, а не страница.
    expect(screen.getByText('А123ВС799')).toBeDefined();
  });
});
