import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { VehicleRequestDto, VehicleRequestShiftsDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';

/**
 * Вкладка «Смены» в карточке заявки: подтверждённую работу по дням читают и те, кто к площадке
 * отношения не имеет, — диспетчер при разборе счёта, арендодатель при споре о часах. Ведут смены
 * на вкладке «На объекте», поэтому здесь проверяется именно чтение: полей ввода в карточке нет.
 */

const request = vehicleRequest({
  id: 'r1',
  status: 'confirmed',
  dateFrom: '2026-08-03',
  dateTo: '2026-08-04',
  shifts: { approvedDays: 1, unapprovedPastDays: 1 },
});

const shifts: VehicleRequestShiftsDto = {
  onDate: '2026-08-04',
  items: [
    {
      date: '2026-08-03',
      startedAt: '08:00',
      endedAt: '20:00',
      machineHours: 11.5,
      refuel: '120 л',
      comment: '',
      filledBy: 'user-2',
      filledByName: 'Петров П. П.',
      filledAt: '2026-08-03T17:00:00.000Z',
      approvedBy: 'user-3',
      approvedByName: 'Сидоров С. С.',
      approvedAt: '2026-08-03T18:00:00.000Z',
    },
    // День внесён, но не подтверждён: о его часах ещё не договорились, и закрытие заявки с таким
    // днём предупреждает, что работа принята без подписи объекта.
    {
      date: '2026-08-04',
      startedAt: null,
      endedAt: null,
      machineHours: 0,
      refuel: '',
      comment: 'дождь, простой',
      filledBy: 'user-2',
      filledByName: 'Петров П. П.',
      filledAt: '2026-08-04T17:00:00.000Z',
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
    },
  ],
};

function renderCard(dto: VehicleRequestDto = request, table: VehicleRequestShiftsDto = shifts) {
  mockHttp({
    'GET /vehicle-requests/r1/history': () => json([]),
    'GET /vehicle-requests/r1/waybills': () => json([]),
    'GET /vehicle-requests/r1/relocations': () => json([]),
    'GET /vehicle-requests/r1/shifts': () => json(table),
    // The freight variant of the card asks for its recorded stop times instead (plan §8).
    'GET /vehicle-requests/r1/route-time': () =>
      json({ readings: [], seconds: null, issues: ['no_readings'] }),
  });
  return renderWithUser(<VehicleRequestViewModal request={dto} onClose={() => {}} />, {
    user: authUser({ role: 'dispatcher' }),
  });
}

describe('вкладка «Смены» в карточке заявки', () => {
  it('показывает принятые дни и кто их подтвердил — без полей ввода', async () => {
    renderCard();

    fireEvent.click(await screen.findByRole('tab', { name: 'Смены' }));

    expect(await screen.findByText('08:00 – 20:00')).toBeDefined();
    expect(screen.getByText('11,5 ч')).toBeDefined();
    expect(screen.getByText('120 л')).toBeDefined();
    // Подпись объекта: кто принял день работы.
    expect(screen.getByText('Сидоров С. С.')).toBeDefined();
    // Неподтверждённый день назван прямо — им и предупреждают при закрытии заявки.
    expect(screen.getByText('ждёт согласования')).toBeDefined();
    // Простой читается нулём часов и объяснением, а не пустой строкой.
    expect(screen.getByText('дождь, простой')).toBeDefined();
    expect(screen.getByText('согласовано 1 из 2')).toBeDefined();

    // Правят смены на вкладке «На объекте»: в карточке их только читают.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('у грузоперевозки вкладок нет вовсе: у неё не период работ, а момент подачи', async () => {
    // Грузоперевозка собирается из той же фабрики: значимы здесь тип и поля подачи, остальное
    // карточка читает одинаково у обоих типов.
    const freight = {
      ...vehicleRequest({ id: 'r1', status: 'confirmed' }),
      requestType: 'freight_transport',
      scheduledAt: '2026-08-04T09:00:00.000Z',
      scheduledTimeUnspecified: false,
      volumeM3: 12,
      weightTons: null,
      loadingLocation: 'Склад',
      unloadingLocation: 'Объект',
      loadingAddress: null,
      unloadingAddress: null,
      loadingResponsibleName: 'Петров П. П.',
      loadingResponsiblePhone: '+7 900 000-00-01',
      unloadingResponsibleName: 'Сидоров С. С.',
      unloadingResponsiblePhone: '+7 900 000-00-02',
    } as unknown as VehicleRequestDto;
    renderCard(freight);

    expect(await screen.findByText('Грузоперевозка')).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Смены' })).toBeNull();
  });

  /**
   * The driver's readings as the day's numbers (readings-shifts-merge plan §6.7): a driver day
   * shows its hours with the mark and, for `vehicleReadings.read`, the report state; a non-clean
   * one shows what the readings have under a dash; a signed day whose readings changed since shows
   * the difference next to the signed hours — never a silent rewrite.
   */
  it('показывает день водителя, неполный день и расхождение под подписью', async () => {
    const [signed, idle] = shifts.items;
    const driverShifts: VehicleRequestShiftsDto = {
      onDate: '2026-08-06',
      items: [
        {
          ...signed!,
          source: 'site',
          driverDay: {
            machineHours: 12,
            refuelLiters: 120,
            clean: true,
            since: null,
            fingerprint: 'v1:a',
          },
        },
        {
          ...idle!,
          comment: '',
          filledBy: null,
          filledByName: null,
          filledAt: null,
          source: null,
          driverDay: {
            machineHours: 23,
            refuelLiters: 0,
            clean: false,
            since: '2026-08-01',
            fingerprint: 'v1:b',
          },
        },
        {
          date: '2026-08-05',
          startedAt: null,
          endedAt: null,
          machineHours: 7.5,
          refuel: '60 л',
          comment: '',
          filledBy: null,
          filledByName: null,
          filledAt: null,
          approvedBy: null,
          approvedByName: null,
          approvedAt: null,
          source: 'driver',
          driverDay: {
            machineHours: 7.5,
            refuelLiters: 60,
            clean: true,
            since: null,
            fingerprint: 'v1:c',
          },
          driver: {
            issues: [],
            readings: [
              {
                readingId: 'rd-1',
                personName: 'Машинистов И. П.',
                reportState: 'accepted',
                sourceKind: 'esm2',
                sourceLabel: 'ЭСМ-2 № 0012',
                kind: 'values',
                machineHours: 7.5,
                refuelLiters: 60,
                previousDate: '2026-08-04',
                noDataReason: '',
                comment: '',
                discrepancies: [],
              },
            ],
          },
        },
      ],
    };
    renderCard({ ...request, dateTo: '2026-08-05' }, driverShifts);

    fireEvent.click(await screen.findByRole('tab', { name: 'Смены' }));

    expect(await screen.findByText('7,5 ч')).toBeDefined();
    expect(screen.getByText('по водителю')).toBeDefined();
    expect(screen.getByText('отчёт: принят')).toBeDefined();
    expect(screen.getByText('60 л')).toBeDefined();
    // A driver day has numbers to sign: it waits for the sign-off, it is not "unfilled".
    expect(screen.getAllByText('ждёт согласования')).toHaveLength(1);
    expect(screen.getByText('не заполнена')).toBeDefined();
    // The non-clean day: a dash and what the readings have.
    expect(screen.getByText('водитель: 23 ч с 01.08')).toBeDefined();
    // The signed day keeps its 11,5 h; the readings now say 12 h.
    expect(screen.getByText('11,5 ч')).toBeDefined();
    expect(screen.getByText('водитель сейчас: 12 ч')).toBeDefined();
  });
});
