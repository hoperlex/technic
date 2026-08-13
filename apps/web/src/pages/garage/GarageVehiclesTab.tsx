import type { ReactNode } from 'react';
import { Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  GARAGE_VEHICLE_STATES,
  type GarageVehicleDto,
  garageVehicleStateColors,
  garageVehicleStateLabels,
  type GarageVehicleState,
  vehicleClassificationLabel,
  type VehicleReadingDayState,
  vehicleReadingDayStateColors,
  vehicleReadingDayStateLabels,
  vehicleStatusLabels,
} from '@technic/contracts';
import { garageApi, garageKeys } from '@entities/garage';
import { DataTable, EntityLink, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { textColumn } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra } from '../../components/PageTabs';
import { useVehicleClassificationFilter } from '../../hooks/useVehicleClassificationFilter';
import { useAuth } from '../../auth/AuthContext';
import { BusyCell, busyLine } from './shared';
import { VehicleReadingsJournal } from './VehicleReadingsJournal';

/**
 * Гараж → «Техника»: полный перечень собственного парка и чем каждая машина занята в выбранный
 * день (ADR 0076).
 *
 * Перечень полный намеренно: свободная машина — то, ради чего срез открывают, а увидеть её можно
 * только в списке, где стоят все. Поэтому фильтра «показывать занятых» здесь нет, есть фильтр
 * состояния — он сужает список до одного ответа, а не определяет его.
 *
 * Действий нет: заявки, рейсы и бланки ведут в своих модулях, а номера в строке — ссылки туда.
 */

const STATE_OPTIONS = GARAGE_VEHICLE_STATES.map((state) => ({
  value: state,
  label: garageVehicleStateLabels[state],
}));

/**
 * Строка среза вместе с состоянием показаний за день (ADR 0103, Р27). Тип расширен здесь, а не в
 * контракте гаража: этап показаний `packages/contracts` не трогает, а сервер поле уже отдаёт
 * (`routes/garage.ts`).
 */
type VehicleRow = GarageVehicleDto & { readingState: VehicleReadingDayState };

/**
 * Фильтр «не сданы» — главный вопрос к экрану следующего утра (Р27). Значение одно: обратного к
 * нему («покажи сданные») никто не задаёт, поэтому это переключатель, а не список из двух.
 */
const READINGS_OPTIONS = [{ value: 'pending', label: 'Показания не сданы' }];

/** Состояние дня плюс причина недоступности: «в ремонте» объясняет тег, а не повторяет его. */
function stateCell(r: GarageVehicleDto) {
  return (
    <Space direction="vertical" size={0}>
      <Tag color={garageVehicleStateColors[r.state]} style={{ marginInlineEnd: 0 }}>
        {garageVehicleStateLabels[r.state]}
      </Tag>
      {r.state === 'unavailable' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {vehicleStatusLabels[r.status].toLowerCase()}
        </Typography.Text>
      )}
    </Space>
  );
}

/**
 * Адрес журнала: текущий отбор плюс машина. Собирается целиком, а не одним параметром, потому что
 * ссылку присылают коллеге — и открыться она должна на том же дне и том же отборе, что видел
 * отправитель.
 */
function journalQuery(params: Record<string, unknown>, vehicleId: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  query.set('journal', vehicleId);
  return query.toString();
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
  // Журнал открывают из строки — окно помнит машину, а не список: вернувшись, диспетчер остаётся
  // на том же дне и том же фильтре.
  const { params, setParams, setSort, onTableChange } = useListParams<{
    state?: GarageVehicleState;
    readings?: 'pending';
    /**
     * Открытый журнал машины живёт в адресе, а не в состоянии компонента, и это не мелочь: в
     * гараже журнал — единственное, что хочется прислать коллеге («посмотри, что с этой машиной»),
     * а состояние, которое нельзя переслать и нельзя обновить страницей, теряется первым.
     *
     * Заодно снимается противоречие с ADR 0076: в строках среза действий нет — есть переходы, и
     * журнал стал таким же переходом, как номер заявки или рейса рядом.
     */
    journal?: string;
    vehicleTypeId?: string;
    vehicleCategoryId?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>(
    // Свободные первыми: порядок задан явно, иначе первый запрос ушёл бы с общим для списков
    // «по убыванию» и открывал бы день с недоступных машин.
    { sortBy: 'state', sortOrder: 'asc' },
    { searchKeys: ['label'] },
  );

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    vehicleTypeId: params.vehicleTypeId,
    vehicleCategoryId: params.vehicleCategoryId,
    onChange: applyFilter,
  });

  // День приходит от страницы: он общий у обеих вкладок и живёт в адресе.
  const query = { ...params, on: date };
  const { data, isFetching } = useQuery({
    queryKey: garageKeys.vehicles(query),
    queryFn: () => garageApi.vehicles(query),
  });

  // Строка среза шире контракта на одно поле: состояние показаний сервер отдаёт, а `GarageVehicleDto`
  // о нём ещё не знает. Приведение — ровно до переезда поля в контракт, вместе с типом `VehicleRow`.
  const items = (data?.items ?? []) as VehicleRow[];
  // Машина открытого журнала — из уже загруженной страницы: журнал показывают по строке, которую
  // видят, и отдельного запроса за подписью машины ради заголовка окна не нужно.
  const journalRow = params.journal ? (items.find((r) => r.id === params.journal) ?? null) : null;

  // Сводка считается по тем же фильтрам, что и таблица, — кроме состояния и показаний: обоими она
  // свелась бы к одной своей цифре.
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

  // Ключ колонки — он же поле сортировки на сервере (GARAGE_VEHICLE_SORT_FIELDS).
  const columns: TableColumnType<VehicleRow>[] = [
    {
      ...textColumn<VehicleRow>({
        key: 'registrationNumber',
        title: 'Техника',
        dataIndex: 'label',
        width: 210,
        render: (_v, r) => (
          <Space direction="vertical" size={0}>
            <span>{r.label}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[r.modelName, r.garageNumber ? `гар. № ${r.garageNumber}` : null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </Space>
        ),
      }),
    },
    {
      key: 'typeName',
      title: 'Тип',
      dataIndex: 'typeName',
      width: 200,
      sorter: true,
      // Позиция классификатора (ADR 0028): категория, а без неё — сам тип.
      render: (_v, r) =>
        vehicleClassificationLabel({ typeName: r.typeName, categoryName: r.categoryName }),
    },
    {
      key: 'state',
      title: 'Состояние',
      width: 130,
      sorter: true,
      defaultSortOrder: 'ascend',
      render: (_v, r) => stateCell(r),
    },
    {
      key: 'busy',
      title: 'Занятость',
      render: (_v, r) => <BusyCell entries={r.busy} />,
    },
    {
      key: 'readings',
      title: 'Показания',
      width: 140,
      /**
       * Состояние дня по показаниям — одно значение из пяти, старшинством сверху вниз (Р27).
       * Журнал открывается той же кнопкой и только у тех, кому положены сами показания: у среза
       * своё право (`garage.read`), а цифры и подписи водителей — данные модуля показаний.
       */
      render: (_v, r) => (
        <Space direction="vertical" size={2} align="start">
          <Tag color={vehicleReadingDayStateColors[r.readingState]} style={{ marginInlineEnd: 0 }}>
            {vehicleReadingDayStateLabels[r.readingState]}
          </Tag>
          {can('vehicleReadings.read') && (
            <EntityLink to={`?${journalQuery(params, r.id)}`} title="Открыть журнал показаний">
              журнал
            </EntityLink>
          )}
        </Space>
      ),
    },
    {
      key: 'drivers',
      title: 'Водители',
      width: 200,
      render: (_v, r) =>
        r.drivers.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {r.drivers.map((driver) => (
              <span key={driver.personId}>{driver.fullName}</span>
            ))}
          </Space>
        ),
    },
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select<GarageVehicleState>
        allowClear
        placeholder="Любое состояние"
        style={{ width: 190 }}
        options={STATE_OPTIONS}
        value={params.state}
        onChange={(v) => applyFilter({ state: v })}
      />
      <Select<'pending'>
        allowClear
        placeholder="Показания: любые"
        style={{ width: 200 }}
        options={READINGS_OPTIONS}
        value={params.readings}
        onChange={(v) => applyFilter({ readings: v })}
      />
      {classificationFilter.controls}
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: [...STATE_OPTIONS],
      placeholder: 'Любое состояние',
      onChange: (v) => applyFilter({ state: v as GarageVehicleState | undefined }),
    },
    {
      kind: 'select',
      key: 'readings',
      label: 'Показания',
      value: params.readings,
      options: READINGS_OPTIONS,
      placeholder: 'Любые',
      onChange: (v) => applyFilter({ readings: v as 'pending' | undefined }),
    },
    classificationFilter.mobileFilter,
  ];

  /** Карточка телефона: машина и её состояние в шапке, занятость — строками (ADR 0030). */
  const card: CardConfig<VehicleRow> = {
    title: (r) => r.label,
    badge: (r) => (
      <Tag color={garageVehicleStateColors[r.state]}>{garageVehicleStateLabels[r.state]}</Tag>
    ),
    primary: (r) =>
      vehicleClassificationLabel({ typeName: r.typeName, categoryName: r.categoryName }),
    lines: [
      (r) => (r.busy.length === 0 ? 'на этот день ничего не назначено' : null),
      ...Array.from({ length: 3 }, (_, i) => (r: VehicleRow) => {
        const entry = r.busy[i];
        return entry ? busyLine(entry) : null;
      }),
      (r) => (r.drivers.length === 0 ? null : r.drivers.map((d) => d.fullName).join(', ')),
      // Состояние показаний — строкой, а не вторым бейджем: в шапке карточки уже стоит состояние
      // дня, и два тега рядом читались бы как одно противоречивое.
      (r) => `показания: ${vehicleReadingDayStateLabels[r.readingState]}`,
    ],
    // На телефоне карточка открывает тот же журнал — и тем же путём, через адрес: ссылку,
    // присланную с телефона, коллега открывает на десктопе и видит ровно тот же день.
    onOpen: can('vehicleReadings.read')
      ? (r: VehicleRow) => setParams((prev) => ({ ...prev, journal: r.id }))
      : undefined,
  };

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

      {journalRow && (
        <VehicleReadingsJournal
          vehicleId={journalRow.id}
          vehicleLabel={journalRow.label}
          day={date}
          open
          onClose={() => setParams((prev) => ({ ...prev, journal: undefined }))}
        />
      )}
    </PageTableLayout>
  );
}
