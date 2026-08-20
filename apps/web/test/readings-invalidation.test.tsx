import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { garageKeys } from '@entities/garage';
import { vehicleReadingKeys } from '@entities/vehicle-reading';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingJournalDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';
import { VehicleReadingsJournal } from '../src/pages/garage/VehicleReadingsJournal';

/**
 * Кэш показаний после приёмки (план «Показания техники», Р19 и Р27).
 *
 * Приём дня идёт вместе с правкой показаний за водителя, а она меняет ровно те числа, которые
 * показывают сводка парка и журнал машины. Поэтому у модуля один корень ключей: приёмке достаточно
 * погасить `vehicleReadingKeys.root`, и обновятся все его экраны разом — знать ключ соседа не
 * должен никто. Разъедься корни — и статистика, открытая рядом с реестром, показывала бы вчерашние
 * цифры до перезагрузки страницы.
 *
 * Экрана приёма ещё нет (этап 5), поэтому корень здесь гасится напрямую — тем же вызовом, каким его
 * погасит реестр. Проверяется при этом не форма ключей (это делает `query-keys`), а живые запросы
 * экранов: ключи, собранные фабрикой, но не дошедшие до `useQuery`, инвалидацию бы не пережили, и
 * увидели бы это уже на экране.
 *
 * Обратная сторона — граница с гаражом. Свои таблицы у показаний есть (`garage-invalidation`
 * объясняет, почему у среза дня их нет), и общий корень с гаражом означал бы, что каждое
 * переключение вкладки пересчитывает сводку за месяц по всему парку.
 */

const STATS = 'GET /vehicle-readings/stats';
const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';

const DAY = '2026-07-24';

const ROW: VehicleReadingStatsRow = {
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  distanceKm: 1240.5,
  engineHours: 38,
  lastOdometer: { value: 128_400, measuredOn: '2026-07-20' },
  lastEngineHours: { value: 5120.5, measuredOn: '2026-07-20' },
  fuelFilledLiters: 620,
  gaps: 0,
};

const JOURNAL_PAGE: VehicleReadingJournalDto = {
  vehicleId: 'v-1',
  vehicleLabel: ROW.vehicleLabel,
  from: '2026-06-24',
  to: DAY,
  total: 0,
  page: 1,
  pageSize: 100,
  items: [],
};

const VEHICLES: GarageVehicleListDto = { items: [], total: 0, page: 1, pageSize: 50, onDate: DAY };
const VEHICLES_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: DAY,
};

/**
 * Оба читающих экрана модуля разом: сводка парка на своей вкладке и окно журнала одной машины.
 * Один корень обязан накрыть обоих — по одному экрану это не проверяется.
 */
function renderReadings() {
  const http = mockHttp({
    [STATS]: ({ query }) =>
      json({ items: [ROW], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [JOURNAL]: () => json(JOURNAL_PAGE),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
  });
  const rendered = renderWithUser(
    <>
      <GaragePage />
      <VehicleReadingsJournal
        vehicleId="v-1"
        vehicleLabel={ROW.vehicleLabel}
        day={DAY}
        open
        onClose={() => {}}
      />
    </>,
    { route: `/garage?tab=readings&date=${DAY}` },
  );
  return { ...rendered, http };
}

describe('кэш показаний: один корень на модуль', () => {
  it('корень модуля обновляет и сводку, и журнал', async () => {
    const { http, queryClient } = renderReadings();

    expect(await screen.findByText(ROW.vehicleLabel)).toBeDefined();
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));

    // Ровно это сделает приёмка после принятого дня.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: vehicleReadingKeys.root });
    });

    await waitFor(() => expect(http.countOf(STATS)).toBe(2));
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(2));
  });

  it('срез гаража от приёмки не устаревает', async () => {
    const { http, queryClient } = renderReadings();
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));

    /*
     * Гараж открыт до приёма и лежит в кэше свежим. Проверяется пометка кэша, а не перерисовка
     * среза, — по той же причине, что в `garage-invalidation`: у тестового `QueryClient`
     * `staleTime` равен нулю, и открытая вкладка перезапросилась бы сама.
     */
    const garageKey = garageKeys.vehicles({ on: DAY });
    queryClient.setQueryData(garageKey, { items: [], total: 0, onDate: DAY });

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: vehicleReadingKeys.root });
    });

    // Показания и срез дня — разные данные: день парка от исправленного одометра не меняется.
    expect(queryClient.getQueryState(garageKey)?.isInvalidated).toBe(false);
    await waitFor(() => expect(http.countOf(STATS)).toBe(2));
  });

  it('переключение вкладок гаража сводку за месяц не пересчитывает', async () => {
    const { http, queryClient } = renderReadings();
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));

    // Тем же корнем гасит вкладки сама страница гаража (`refreshQueryKey`): срез дня показывают
    // «как сейчас» при каждом переключении, а сводка за месяц по всему парку столько не стоит.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: garageKeys.root });
    });

    expect(http.countOf(STATS)).toBe(1);
    expect(http.countOf(JOURNAL)).toBe(1);
  });
});
