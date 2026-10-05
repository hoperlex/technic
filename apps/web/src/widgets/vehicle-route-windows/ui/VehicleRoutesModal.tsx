import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Input, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { VehicleRouteDto } from '@technic/contracts';
import { useDriverOptions } from '@entities/driver';
import { useAuth } from '@entities/session';
import { useOwnVehicleOptions } from '@entities/vehicle';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { DataTable } from '@shared/ui';
import { ListToolbar } from '@shared/ui';
import { ViewModal } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useIsMobile, useListParams } from '@shared/lib';
import { useRouteModal } from '@features/route-modal';
import { CreateRouteModal } from './CreateRouteModal';
import { routeListView } from './routeListView';

/**
 * The route list as a window over the page where routes were asked about
 * (docs/vehicle-routes-modal-plan.md; routes themselves: docs/vehicle-routes-plan.md, ADR 0050).
 *
 * Why a window rather than the tab the list used to be. A route is not a portal section but an
 * accompanying record: "what is the vehicle busy with" is asked from a request, the garage and the
 * waybill journal. The tab answered by leaving the screen, losing the asking page's filters and
 * searching for the way back. Meanwhile the list itself is needed by one person, the dispatcher
 * assembling the day, and the section kept a tab for them that everyone else walked past.
 *
 * The window answers the dispatcher's daily question: what the vehicle is busy with, who drives and
 * whether the form is issued. Requests arrive here by being taken into work, but the route is
 * assembled here: request order, driver and departure details belong to the route, not the request.
 *
 * It opens on today: routes are planned the day before and adjusted in the morning, and route
 * history is read through the waybill journal. A request to show another day comes from outside via
 * focusDate/focusToken.
 *
 * What the window does not do. It knows nothing about the URL: ?routes=1, ?route=... and
 * ?request=... are parsed by useRouteModalState (@features/route-modal), and the route card and the
 * edit window are mounted by VehicleRouteWindows next to this list. The list only asks them to open
 * (openRoute, editRoute). Its own action is one: creating a route.
 */

const DATE = 'YYYY-MM-DD';

/** Waybill state: the dispatcher closes the day by it ("what is still without a waybill"). */
const WAYBILL_FILTERS = [
  { value: 'none', label: 'Без листа' },
  { value: 'issued', label: 'Лист выписан' },
] as const;
type WaybillFilter = (typeof WAYBILL_FILTERS)[number]['value'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Day the list period moves to; 'YYYY-MM-DD'. */
  focusDate?: string;
  /** Focus request counter: grows with every openRoutesList call. */
  focusToken: number;
  /** Portal lists are stale after a route change; the URL-window state owner invalidates them. */
  onChanged: () => void;
}

export function VehicleRoutesModal({ open, onClose, focusDate, focusToken, onChanged }: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const { can } = useAuth();
  /** Route card and request card belong to the URL-window host: the list only asks to open them. */
  const { openRoute, openRequest, editRoute } = useRouteModal();
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs(), dayjs()]);
  const [creating, setCreating] = useState(false);

  /*
   * A request to show a specific day (openRoutesList({ focusDate })): sent by the route card's "All
   * routes" button and by the route edit with the new day it was moved to. Otherwise the list would
   * open on today while the route it was opened for lies the day before yesterday, and the user
   * would decide the route was lost.
   *
   * The dependency is the counter, not the date, and that is the point of the effect. A repeated
   * request for the same day must bring the period back if the user moved it to another month;
   * keyed by the date value, the second effect would not fire at all since the date did not change.
   */
  useEffect(() => {
    if (!focusDate) return;
    const day = dayjs(focusDate);
    setRange([day, day]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  /*
   * Filters live in a bar above the table, not in column dropdowns: they are not visible in the
   * header, and some values are directory lists (vehicles, drivers) with no room in a column
   * dropdown. The vehicle requests and users lists are built the same way, so portal lists filter
   * alike.
   */
  const { params, setParams, setSort, onTableChange } = useListParams<{
    vehicleId?: string;
    driverPersonId?: string;
    waybill?: WaybillFilter;
  }>({}, { searchKeys: [] });

  // Any filter change returns the list to the first page.
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = {
    ...params,
    dateFrom: range[0].format(DATE),
    dateTo: range[1].format(DATE),
  };
  const { data, isFetching } = useQuery({
    queryKey: vehicleRouteKeys.list(query),
    queryFn: () => vehicleRoutesApi.list(query),
  });

  const { options: vehicleOptions, loading: vehiclesLoading } = useOwnVehicleOptions();
  const { options: driverOptions, loading: driversLoading } = useDriverOptions();

  const { columns, card } = routeListView({ can, openRequest, openRoute, editRoute });

  // Filter bar above the table: search, vehicle, driver, waybill state and route period.
  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // The server searches by three route traits at once: number ("Р-12"), vehicle plate and
        // driver surname, because people remember a route by any of them.
        placeholder="Р-12, госномер или водитель"
        style={{ width: 240 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Вся техника"
        style={{ width: 220 }}
        options={vehicleOptions}
        loading={vehiclesLoading}
        value={params.vehicleId}
        onChange={(v: string | undefined) => applyFilter({ vehicleId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все водители"
        style={{ width: 220 }}
        options={driverOptions}
        loading={driversLoading}
        value={params.driverPersonId}
        onChange={(v: string | undefined) => applyFilter({ driverPersonId: v })}
      />
      <Select
        allowClear
        placeholder="Лист: любой"
        style={{ width: 170 }}
        options={[...WAYBILL_FILTERS]}
        value={params.waybill}
        onChange={(v: WaybillFilter | undefined) => applyFilter({ waybill: v })}
      />
      {/* The route period stays mandatory: routes are read by day, and "the whole history at
          once" is not the question asked here. Hence no clear button. */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        value={range}
        allowClear={false}
        inputReadOnly={isMobile}
        onChange={(v) => {
          if (!v) return;
          setRange(v as [dayjs.Dayjs, dayjs.Dayjs]);
          applyFilter({});
        }}
      />
    </Space>
  );

  // The same filters as descriptions for the phone filter sheet (ADR 0030).
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'vehicleId',
      label: 'Техника',
      value: params.vehicleId,
      options: vehicleOptions,
      placeholder: 'Вся техника',
      loading: vehiclesLoading,
      onChange: (v) => applyFilter({ vehicleId: v }),
    },
    {
      kind: 'select',
      key: 'driverPersonId',
      label: 'Водитель',
      value: params.driverPersonId,
      options: driverOptions,
      placeholder: 'Все водители',
      loading: driversLoading,
      onChange: (v) => applyFilter({ driverPersonId: v }),
    },
    {
      kind: 'select',
      key: 'waybill',
      label: 'Путевой лист',
      value: params.waybill,
      options: [...WAYBILL_FILTERS],
      placeholder: 'Лист: любой',
      onChange: (v) => applyFilter({ waybill: v as WaybillFilter | undefined }),
    },
    {
      kind: 'dateRange',
      key: 'range',
      label: 'Период рейсов',
      from: range[0].format(DATE),
      to: range[1].format(DATE),
      isActive: false,
      onChange: (from, to) => {
        setRange([from ? dayjs(from) : dayjs(), to ? dayjs(to) : dayjs()]);
        applyFilter({});
      },
    },
  ];

  return (
    <ViewModal
      title="Маршруты"
      open={open}
      onClose={onClose}
      width={1080}
      // The list is reopened on another day and from another portal place: rebuilding it is cheaper
      // than dragging the previous visit's filters along.
      destroyOnHidden
      // Creating is the list's only own action, and on a phone it belongs in the window footer
      // rather than a round button: Fab lives at the page's bottom navigation, which does not exist
      // under the window. One button works in both forms, a window on desktop and a sheet on phone.
      footer={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          Новый маршрут
        </Button>
      }
      // The body must have a height: DataTable measures its container (useElementSize) to compute
      // scroll.y, and in a content-sized body it would measure zero and collapse. On a phone the
      // window is full-screen anyway, so the height is its own rather than a share of the viewport.
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '70vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      {/* The desktop filter bar and the phone toolbar are drawn here: PageTableLayout belongs to
          pages, and the list has its own shell inside a window. Six fixed-width dropdowns would
          fill a 360 px screen (ADR 0030), so the phone gets ListToolbar with sheets. No primary
          action is passed to it: "New route" sits in the window footer. */}
      {isMobile ? (
        <ListToolbar
          search={{
            value: params.search,
            placeholder: 'Р-12, госномер или водитель',
            onChange: (v) => applyFilter({ search: v }),
          }}
          filters={mobileFilters}
          sort={{
            options: sortOptionsFrom(columns, { num: 'Маршрут' }),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          }}
        />
      ) : (
        <div style={{ flex: '0 0 auto' }}>{filters}</div>
      )}

      {/* On a phone this wrapper scrolls: list cards grow with content and would otherwise run past
          the bottom of the window. On desktop the table scrolls by itself. */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: isMobile ? 'auto' : undefined,
        }}
      >
        <DataTable<VehicleRouteDto>
          columns={columns}
          card={card}
          data={data?.items ?? []}
          total={data?.total ?? 0}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          sortBy={params.sortBy}
          sortOrder={params.sortOrder}
          onChange={onTableChange}
        />
      </div>

      {/* The create window is nested in the list window on purpose: antd raises nested windows'
          z-index above the parent by context, while a sibling would end up under the list sheet on
          a phone. It is not reflected in the URL: it is a step inside the list, not a place. */}
      <CreateRouteModal
        open={creating}
        onCancel={() => setCreating(false)}
        onCreated={(route) => {
          setCreating(false);
          onChanged();
          message.success('Маршрут заведён');
          // The period moves to the new route's day: routes are created for tomorrow and later, and
          // a list left on today would not show the route just created once the card is closed.
          const day = dayjs(route.routeDate);
          setRange([day, day]);
          openRoute(route.id);
        }}
      />
    </ViewModal>
  );
}
