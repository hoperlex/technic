import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { RequestWaybillDto, VehicleDto } from '@technic/contracts';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { authUser } from './factories/auth';
import { assignmentPreview, machinist, vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * Коррекция назначения задним числом в окне смены техники (ADR 0101, Р8).
 *
 * У заказа техники на объект рейса нет — машина и машинист стоят на самой заявке, — поэтому «на
 * объекте работала другая машина» исправляется тем же окном, которым технику меняют обычным
 * порядком. Разница в одном: признак коррекции человек ставит сам, и вместе с ним окно спрашивает
 * причину и перечень листов ЭСМ-2 к перевыписке.
 *
 * Проверяется здесь ровно то, что портал обещает серверу:
 *
 * - блока нет без права `waybills.correct` (ADR 0101 п. 7): предлагать действие, которым ручка
 *   ответит 403, нельзя;
 * - к перевыписке предлагаются только **отработанные** недели: текущую сверка переоформит сама, и
 *   разблокировать её не надо;
 * - неделя, в которой у заявки листы двух машин (ADR 0100 п. 7), не предлагается вовсе — сервер
 *   такую пару отклоняет, и обещать её здесь значило бы вести человека в отказ;
 * - причина обязательна и уходит вместе с ключом операции (Р31).
 */

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** Прошлая календарная неделя — она отработана при любом дне, в который тест запустили. */
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

/** Заявка в работе на первой машине: её и меняют — обычным порядком либо задним числом. */
const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: PAST_FROM,
  dateTo: TODAY,
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
    driverName: 'Семёнов С. С.',
    routeId: null,
    routeNumber: null,
    ...over,
  };
}

/** Лист текущей недели: сверка переоформит его сама, и в перечне разблокировки ему не место. */
const CURRENT_SHEET = sheet({
  id: 'wb-current',
  number: '260604-646-00000004901',
  issuedForDate: MONDAY,
  periodFrom: MONDAY,
  periodTo: TODAY,
});

function renderModal(
  options: { waybills?: RequestWaybillDto[]; user?: ReturnType<typeof authUser> | null } = {},
) {
  const onSubmit = vi.fn();
  const http = mockHttp({
    'GET /vehicles': () => json(list([CRANE, OTHER_CRANE])),
    'GET /drivers': () => json(list([machinist()])),
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
      mode="reassign"
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
    options.user === undefined ? {} : { user: options.user },
  );
  return { http, onSubmit };
}

const CHECKBOX_LABEL = 'Исправить задним числом: работала другая машина';

/** Включить коррекцию и дождаться списка листов: он приезжает запросом уже после нажатия. */
async function enableCorrection(): Promise<void> {
  fireEvent.click(screen.getByText(CHECKBOX_LABEL));
  await screen.findByLabelText('Причина коррекции');
}

describe('коррекция назначения задним числом в окне смены техники', () => {
  it('без права на коррекцию блока нет вовсе', () => {
    // Штаб технику не назначает и прошлое не правит: у него нет ни `waybills.correct`, ни повода.
    renderModal({ user: authUser({ role: 'shtab' }) });
    expect(screen.queryByText(CHECKBOX_LABEL)).toBeNull();
  });

  it('к перевыписке предлагаются только отработанные недели', async () => {
    renderModal();
    await enableCorrection();

    // Лист прошлой недели предложен, лист текущей — нет: её сверка переоформит сама.
    await screen.findByText(/00000004897/);
    expect(screen.queryByText(/00000004901/)).toBeNull();
  });

  it('неделя с листами двух машин не предлагается: такую сервер не примет', async () => {
    renderModal({
      waybills: [
        sheet(),
        // Второй лист той же недели — другой машины (ADR 0100 п. 7).
        sheet({ id: 'wb-past-2', number: '260604-646-00000004898' }),
      ],
    });
    await enableCorrection();

    const first = await screen.findByText(/00000004897/);
    const checkbox = first.closest('label')!.querySelector('input') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('причина обязательна, а с ней уходят ключ операции и названные листы', async () => {
    const { onSubmit } = renderModal();
    await enableCorrection();

    // Без причины окно не отпускает: задним числом операция проходит только с объяснением.
    fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));
    await screen.findByText('Укажите причину коррекции');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Причина коррекции'), {
      target: { value: 'На объекте работала вторая машина' },
    });
    fireEvent.click((await screen.findByText(/00000004897/)).closest('label')!);
    fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0]![0] as {
      correction?: { operationId: string; reason: string; unlockWaybillIds: string[] };
    };
    expect(payload.correction?.reason).toBe('На объекте работала вторая машина');
    expect(payload.correction?.unlockWaybillIds).toEqual(['wb-past']);
    // Ключ идемпотентности придумывает клиент до отправки (Р31).
    expect(payload.correction?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('без признака коррекции окно остаётся обычной сменой техники', async () => {
    const { onSubmit } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as { correction?: unknown }).correction).toBeUndefined();
  });
});
