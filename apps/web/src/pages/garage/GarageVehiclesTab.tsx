import type { ReactNode } from 'react';
import { Space } from 'antd';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { garageApi, garageKeys } from '@entities/garage';
import { DataTable } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { useJournalAddress } from './journalAddress';
import { useMaintenanceColumn } from './maintenanceColumn';
import { usePartsSpendColumn } from './partsSpendColumn';
import { useBusyRouteActions } from './shared';
import { vehicleCard, vehicleColumns, type VehicleRow } from './vehicleColumns';
import { useVehicleFilters, type VehicleFilterParams } from './vehicleFilters';
import { VehicleReadingsJournal } from './VehicleReadingsJournal';

/**
 * Гараж → «Техника»: полный перечень собственного парка и чем каждая машина занята в выбранный
 * день (ADR 0076).
 *
 * Перечень полный намеренно: свободная машина — то, ради чего срез открывают, а увидеть её можно
 * только в списке, где стоят все. Поэтому фильтра «показывать занятых» здесь нет, есть фильтр
 * состояния — он сужает список до одного ответа, а не определяет его.
 *
 * Своих действий над записями у среза нет: он отвечает на вопрос, а не правит день. Заявку, рейс
 * и бланк ведут в своих модулях, а номера в строке — вход туда: рейс и заявка открываются окном
 * поверх среза (ADR 0120), бланк уводит в журнал листов.
 *
 * Полоса отбора и сборка колонок с карточкой живут рядом (`vehicleFilters.tsx`,
 * `vehicleColumns.tsx`): здесь остаются параметры списка, запросы, сводка и разметка.
 */

/**
 * Подпись машины в заголовке журнала. Обычно берётся из строки, по которой нажали; присланная
 * ссылка может назвать машину с другой страницы отбора — тогда журнал всё равно открывается и
 * грузит себя по идентификатору из адреса, а имени у окна до ответа нет (так же ведёт себя сводка
 * ТО, `maintenanceColumn.tsx`).
 */
function openedVehicle(id: string, rows: readonly VehicleRow[]) {
  return { id, label: rows.find((r) => r.id === id)?.label ?? 'машина' };
}

export function GarageVehiclesTab({
  date,
  dayControls,
}: {
  /** День среза: общий у обеих вкладок, приходит от страницы вместе с органами управления им. */
  date: string;
  dayControls: ReactNode;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  // Рейсы дня пунктами действий телефона: на карточке занятость — текст, и ссылки в ней нет
  // (см. `busyLine`). Право хук спрашивает сам.
  const routeActions = useBusyRouteActions();
  const { params, setParams, setSort, onTableChange } = useListParams<
    VehicleFilterParams & {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  >(
    // Свободные первыми: порядок задан явно, иначе первый запрос ушёл бы с общим для списков
    // «по убыванию» и открывал бы день с недоступных машин.
    { sortBy: 'state', sortOrder: 'asc' },
    { searchKeys: ['label'] },
  );

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  // Журнал показаний назван в адресе (а не в состоянии таблицы) и открывается только под правом на
  // сами показания: у среза дня своё право, у цифр приборов — своё. Вкладку спрашиваем не ради
  // права, а ради единственности окна: ключ `?journal=` общий у вкладок гаража, а скрытая вкладка
  // остаётся смонтированной (`PageTabs`) — без этой проверки один адрес открыл бы два журнала разом.
  const canReadReadings = can('vehicleReadings.read');
  const journal = useJournalAddress(useActiveTabKey() === 'vehicles' && canReadReadings);

  const { filters, mobileFilters } = useVehicleFilters({ params, applyFilter });

  // День приходит от страницы: он общий у обеих вкладок и живёт в адресе.
  const query = { ...params, on: date };
  const { data, isFetching } = useQuery({
    queryKey: garageKeys.vehicles(query),
    queryFn: () => garageApi.vehicles(query),
  });

  // Строка среза шире контракта на одно поле: состояние показаний сервер отдаёт, а `GarageVehicleDto`
  // о нём ещё не знает. Приведение — ровно до переезда поля в контракт, вместе с типом `VehicleRow`.
  const items = (data?.items ?? []) as VehicleRow[];
  const journalVehicle = journal.id ? openedVehicle(journal.id, items) : null;

  // Обслуживание (Р14в, Р16): состояние приходит пакетом на видимую страницу, окно сводки названо
  // в адресе — механику строка гаража единственный вход в журнал ТО.
  const maintenance = useMaintenanceColumn<VehicleRow>({ date, rows: items });

  // Запчасти (Р14, Р15): суммы тем же приёмом — пакетом на видимую страницу и не позже дня среза,
  // — а окно машины названо в адресе. Права на показания колонка не требует: «сколько вложено в
  // эту машину» спрашивает всякий, кому виден гараж (Р5).
  const partsSpend = usePartsSpendColumn<VehicleRow>({ date, rows: items });

  // Сводка считается по тем же фильтрам, что и таблица, — кроме состояния и показаний: обоими она
  // свелась бы к одной своей цифре. Площадка остаётся: она определяет перечень машин, а не одну
  // из его цифр, и несуженная сводка отвечала бы про весь парк под отобранной таблицей.
  const summaryQuery = { ...query, state: undefined, readings: undefined };
  const { data: summary } = useQuery({
    queryKey: garageKeys.vehiclesSummary(summaryQuery),
    queryFn: () => garageApi.vehiclesSummary(summaryQuery),
  });

  const summaryItems = [
    { label: 'Машин', value: summary?.total ?? 0 },
    { label: 'Свободны', value: summary?.free ?? 0 },
    { label: 'В рейсах', value: summary?.onRoute ?? 0 },
    { label: 'На объектах', value: summary?.onSite ?? 0 },
    { label: 'Недоступны', value: summary?.unavailable ?? 0 },
    // Цифра дня диспетчера: пока водителя нет, лист по такому рейсу не выписать.
    { label: 'Рейсов без водителя', value: summary?.routesWithoutDriver ?? 0 },
  ];

  const columns = vehicleColumns({ date, canReadReadings, journal, maintenance, partsSpend });
  const card = vehicleCard({
    date,
    canReadReadings,
    journal,
    maintenance,
    partsSpend,
    navigate,
    routeActions,
  });

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, {
            registrationNumber: 'Госномер',
            typeName: 'Тип',
            state: 'Состояние',
          }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <TabsExtra tabKey="vehicles">
        <Space size={12} wrap>
          {dayControls}
          <SummaryBar title="Парк" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<VehicleRow>
        columns={columns}
        card={card}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />

      {journalVehicle && (
        <VehicleReadingsJournal
          vehicleId={journalVehicle.id}
          vehicleLabel={journalVehicle.label}
          day={date}
          open
          onClose={journal.close}
        />
      )}

      {maintenance.modal}
      {partsSpend.modal}
    </PageTableLayout>
  );
}
