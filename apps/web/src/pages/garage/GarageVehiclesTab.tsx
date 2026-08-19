import type { ReactNode } from 'react';
import { Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import { useNavigate } from 'react-router';
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
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useVehicleClassificationFilter } from '../../hooks/useVehicleClassificationFilter';
import { useAuth } from '../../auth/AuthContext';
import { useJournalAddress } from './journalAddress';
import { useMaintenanceColumn } from './maintenanceColumn';
import { vehicleCardHref } from './readingsAddress';
import { odometerCardLine, odometerColumn } from './odometerColumn';
import { BusyCell, busyLine, useBusyRouteActions } from './shared';
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
  const { params, setParams, setSort, onTableChange } = useListParams<{
    state?: GarageVehicleState;
    readings?: 'pending';
    /** Техника классификатора набором: `t<uuid>` — весь тип, `c<uuid>` — одна его категория. */
    classifications?: string;
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

  // Журнал показаний назван в адресе (а не в состоянии таблицы) и открывается только под правом на
  // сами показания: у среза дня своё право, у цифр приборов — своё. Вкладку спрашиваем не ради
  // права, а ради единственности окна: ключ `?journal=` общий у вкладок гаража, а скрытая вкладка
  // остаётся смонтированной (`PageTabs`) — без этой проверки один адрес открыл бы два журнала разом.
  const canReadReadings = can('vehicleReadings.read');
  const journal = useJournalAddress(useActiveTabKey() === 'vehicles' && canReadReadings);
  // Третий путь строки (§7): карточка машины на вкладке «Показания» — статистика за месяц по день
  // среза. Период считает разбор адреса показаний, а не эта вкладка (`vehicleCardHref`).
  const cardHref = (id: string) => vehicleCardHref(id, date);

  const classificationFilter = useVehicleClassificationFilter({
    classifications: params.classifications,
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
  const journalVehicle = journal.id ? openedVehicle(journal.id, items) : null;

  // Обслуживание (Р14в, Р16): состояние приходит пакетом на видимую страницу, окно сводки названо
  // в адресе — механику строка гаража единственный вход в журнал ТО.
  const maintenance = useMaintenanceColumn<VehicleRow>({ date, rows: items });

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
       * Оба входа в модуль показаний стоят под ним и только у тех, кому положены сами показания: у
       * среза своё право (`garage.read`), а цифры и подписи водителей — данные модуля показаний.
       * Журнал отвечает «что было по сменам», карточка — «сколько вышло за период» (§7).
       */
      render: (_v, r) => (
        <Space direction="vertical" size={2} align="start">
          <Tag color={vehicleReadingDayStateColors[r.readingState]} style={{ marginInlineEnd: 0 }}>
            {vehicleReadingDayStateLabels[r.readingState]}
          </Tag>
          {canReadReadings && (
            <Space size={8} wrap>
              <EntityLink to={journal.href(r.id)} title="Открыть журнал показаний">
                журнал
              </EntityLink>
              <EntityLink to={cardHref(r.id)} title="Открыть статистику машины за период">
                статистика
              </EntityLink>
            </Space>
          )}
        </Space>
      ),
    },
    /*
     * Одометр — колонка модуля показаний, а не гаража (Р16): у среза своё право (`garage.read`),
     * а цифры приборов открывает `vehicleReadings.read`. Проверка здесь не украшение к серверной:
     * без права сервер поля не присылает вовсе, и колонка без этого условия стояла бы у механика
     * пустым столбцом прочерков — то есть врала бы, что показаний нет.
     */
    ...(can('vehicleReadings.read') ? [odometerColumn<VehicleRow>()] : []),
    // Колонка ТО — под своим правом (Р14) и своим ответом: у механика она стоит там, где у
    // диспетчера одометр, и наоборот.
    ...maintenance.columns,
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
      // Одометр приходит только с правом на показания, и своего условия строке не нужно: без права
      // поля в ответе нет, и строка молчит сама (`odometerCardLine`).
      (r) => odometerCardLine(r),
      // ТО — тем же порядком: без права на обслуживание состояния нет, и строка молчит сама.
      maintenance.cardLine,
    ],
    /*
     * Действия карточки. Рейсы дня стоят первыми: карточка отвечает про **этот день**, и «что там
     * за Р-12» спрашивают у неё чаще, чем месячную статистику машины; остальные пункты — про саму
     * машину и от выбранного дня почти не зависят.
     *
     * Пунктами, а не ссылками в строках, всё это по одной причине: касание по карточке уже занято
     * журналом показаний, а третьего смысла у касания быть не может.
     */
    actions: (r) => [
      ...routeActions(r.busy),
      ...(canReadReadings
        ? [{ key: 'stats', label: 'Статистика за период', onClick: () => navigate(cardHref(r.id)) }]
        : []),
      ...maintenance.cardActions(r),
    ],
    // На телефоне карточка открывает тот же журнал — и тем же путём, через адрес: ссылку,
    // присланную с телефона, коллега открывает на десктопе и видит ровно тот же день.
    onOpen: canReadReadings ? (r: VehicleRow) => journal.open(r.id) : undefined,
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
    </PageTableLayout>
  );
}
