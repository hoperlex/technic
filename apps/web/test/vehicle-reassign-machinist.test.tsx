import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { RequestWaybillDto, VehicleDto } from '@technic/contracts';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { list } from './factories/common';
import { assignmentPreview, machinist, vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * Машинист при смене назначенной техники (ADR 0048) — и то, что портал его не подставляет
 * (ADR 0083).
 *
 * Смысл пары решений в одном: за другой машиной на объект приезжает и другой человек, и менять
 * его перевыпиской листов руками — работа на ровном месте, которую сверка ЭСМ-2 делает сама
 * (миграция 0087). Но подставить в поле прежнее имя нельзя: подставленная фамилия читается как
 * принятое решение, её пролистывают, и в бланк она уезжает настоящей — с настоящим человеком,
 * которого за технику никто не сажал. Поэтому имя стоит **текстом** под полем, а пустое поле
 * значимо и означает «оставить прежнего».
 *
 * Отсюда и предмет проверок: поле есть, поле пустое, пустота объяснена именем нынешнего
 * машиниста, и обе ветки — «не тронули» и «назвали другого» — доходят до тела запроса такими,
 * какими их ждёт сервер (`changeVehicleAssignmentSchema`: ключа нет — человека не меняли).
 */

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** Прошлая календарная неделя — отработана в любой день, в который запустили тест. */
const PAST_FROM = shiftDateKey(MONDAY, -7);
const PAST_TO = shiftDateKey(MONDAY, -1);

const CRANE: VehicleDto = {
  id: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  kindName: 'Спецтехника',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  waybillFormCode: '4p',
  vehicleCategoryId: 'vc-1',
  categoryName: 'Автокраны, г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  vehicleModelId: 'm-1',
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
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

const OTHER_CRANE: VehicleDto = {
  ...CRANE,
  id: 'v-2',
  modelName: 'Liebherr LTM 1130',
  registrationNumber: 'Х001ХХ199',
};

/**
 * Люди справочника и человек в листах — намеренно разные: иначе «поле пустое, а под ним имя»
 * читалось бы одинаково при обеих ошибках — и при подстановке, и при её отсутствии.
 */
const SEMENOV = machinist({ id: 'p-semenov', fullName: 'Семёнов Семён Семёнович' });
const KUZNETSOV = machinist({
  id: 'p-kuznetsov',
  fullName: 'Кузнецов Кузьма Кузьмич',
  personnelNo: '4022',
});
/** Кто стоит в действующем листе ЭСМ-2 — его и оставляет пустое поле. */
const IN_SHEETS = 'Иванов Иван Иванович';

/** Заявка в работе на первой машине: её и меняют. */
const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: PAST_FROM,
  dateTo: shiftDateKey(TODAY, 7),
  assignment: {
    vehicleId: CRANE.id,
    ownership: 'own',
    vehicleKindId: CRANE.vehicleKindId,
    vehicleTypeId: CRANE.vehicleTypeId,
    typeName: CRANE.typeName,
    vehicleCategoryId: CRANE.vehicleCategoryId,
    categoryName: CRANE.categoryName,
    categorySpecs: CRANE.categorySpecs,
    modelName: CRANE.modelName,
    registrationNumber: CRANE.registrationNumber,
    description: '',
    lessorId: null,
    lessorName: null,
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  },
});

function sheet(over: Partial<RequestWaybillDto> = {}): RequestWaybillDto {
  return {
    id: 'wb-past',
    number: '260604-646-00000004897',
    formCode: 'esm2',
    status: 'issued',
    issuedForDate: PAST_FROM,
    periodFrom: PAST_FROM,
    periodTo: PAST_TO,
    slot: 1,
    driverName: IN_SHEETS,
    routeId: null,
    routeNumber: null,
    ...over,
  };
}

/** Лист текущей недели — самой поздней: по нему и называется нынешний машинист. */
const CURRENT_SHEET = sheet({
  id: 'wb-current',
  number: '260604-646-00000004901',
  issuedForDate: MONDAY,
  periodFrom: MONDAY,
  periodTo: shiftDateKey(MONDAY, 6),
});

function renderModal(
  options: { waybills?: RequestWaybillDto[]; mode?: 'confirm' | 'reassign' } = {},
) {
  const onSubmit = vi.fn();
  const http = mockHttp({
    'GET /vehicles': () => json(list([CRANE, OTHER_CRANE])),
    'GET /drivers': () => json(list([SEMENOV, KUZNETSOV])),
    'GET /vehicle-requests/:id/waybills': () => json(options.waybills ?? [sheet(), CURRENT_SHEET]),
    /*
     * Предпросмотр последствий (волна 4a): окно спрашивает его перед каждой сменой техники у
     * заказа на объект. Здесь он не предмет проверки и отвечает пустым планом — тогда окно
     * отправляет команду сразу, как отправляло до этой волны.
     */
    'POST /vehicle-requests/:id/assignment/preview': () => json(assignmentPreview()),
  });
  renderWithUser(
    <VehicleAssignModal
      request={REQUEST}
      mode={options.mode ?? 'reassign'}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return { http, onSubmit };
}

/** Что уехало в теле смены техники: назначение лежит внутри payload, рядом с блоком коррекции. */
function assignmentOf(onSubmit: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const payload = onSubmit.mock.calls[0]![0] as { assignment: Record<string, unknown> };
  return payload.assignment;
}

describe('машинист в окне смены техники', () => {
  it('поле есть и открывается пустым — прежнее имя стоит подсказкой, а не значением', async () => {
    renderModal();

    // Поле спрашивается: до сих пор при смене техники его не было вовсе, и человека меняли
    // перевыпиской листов руками.
    expect(screen.getByLabelText('Машинист')).toBeTruthy();
    // Пустое — и это видно по плейсхолдеру: ни одного выбранного значения в поле нет.
    expect(screen.getByText('Оставить прежнего')).toBeTruthy();
    // Имя нынешнего человека — текстом под полем: пустота обязана быть объяснена, иначе она
    // читается как «машиниста нет».
    await screen.findByText(new RegExp(`Сейчас в листах — ${IN_SHEETS}`));
  });

  it('называется человек с самого позднего действующего листа', async () => {
    // Прошлая неделя — другой человек: он тоже в листах, но говорить надо про сейчас.
    renderModal({
      waybills: [sheet({ driverName: 'Сидоров С. С.' }), CURRENT_SHEET],
    });

    await screen.findByText(new RegExp(`Сейчас в листах — ${IN_SHEETS}`));
    expect(screen.queryByText(/Сидоров/)).toBeNull();
  });

  it('листов ЭСМ-2 нет — подсказка говорит, что машиниста называют впервые', async () => {
    renderModal({ waybills: [] });

    await screen.findByText(/машиниста называют впервые/);
  });

  it('пустое поле отправке не мешает и в тело не попадает', async () => {
    const { onSubmit } = renderModal();
    await screen.findByText(new RegExp(`Сейчас в листах — ${IN_SHEETS}`));

    fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Ключа нет вовсе — так сервер отличает «оставить прежнего» от «назвали человека»
    // (`changeVehicleAssignmentSchema.driverPersonId`).
    expect(assignmentOf(onSubmit).driverPersonId).toBeUndefined();
  });

  it('выбранный машинист уходит в тело смены техники', async () => {
    const { onSubmit } = renderModal();
    await screen.findByText(new RegExp(`Сейчас в листах — ${IN_SHEETS}`));

    await selectOption('Машинист', /Кузнецов/);
    fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(assignmentOf(onSubmit).driverPersonId).toBe(KUZNETSOV.id);
  });

  it('перевод в работу листов не спрашивает: их у заявки ещё нет', async () => {
    const { http } = renderModal({ mode: 'confirm' });

    // Ждём отрисовки поля — если бы запрос уходил, он ушёл бы к этому моменту.
    expect(screen.getByLabelText('Машинист')).toBeTruthy();
    await waitFor(() => expect(http.countOf('GET /vehicles')).toBeGreaterThan(0));
    expect(http.countOf('GET /vehicle-requests/:id/waybills')).toBe(0);
    // И разговор под полем другой: там цена ответа, а не «кто сейчас».
    expect(screen.queryByText(/Сейчас в листах/)).toBeNull();
  });
});
