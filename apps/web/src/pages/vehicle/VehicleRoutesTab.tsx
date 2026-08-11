import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  isRouteEditable,
  ROUTE_FROZEN_MESSAGE,
  routeRequestCapacity,
  routePurposeShortLabels,
  type VehicleRouteDto,
  vehicleLabel,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi, vehiclesApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useListParams } from '@shared/lib';
import { useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { errorMessage } from '../../utils/format';
import { vehicleRequestLink, waybillLink } from '../../utils/links';
import { useAuth } from '../../auth/AuthContext';
import { VehicleRouteModal } from './VehicleRouteModal';
import { VehicleRouteEditModal } from './VehicleRouteEditModal';
import { formatDateOnly, useDriverOptions, useOwnVehicleOptions } from './shared';

/**
 * Рейсы: что и с кем едет в конкретный день (план `docs/vehicle-routes-plan.md`).
 *
 * Первая вкладка отвечает на «что заказали и что с этим делают», эта — на вопрос дня диспетчера:
 * чем занята машина, кто за рулём и выписан ли бланк. Заявки попадают сюда переводом в работу,
 * но собирают рейс здесь: порядок заявок, водитель и реквизиты выезда — свойства рейса, а не
 * заявки.
 *
 * Открывается день сегодняшний: рейс планируют накануне и правят утром, а история рейсов
 * читается журналом путевых листов.
 */

const DATE = 'YYYY-MM-DD';

/** Состояние документа — им диспетчер закрывает день: «что ещё без листа». */
const WAYBILL_FILTERS = [
  { value: 'none', label: 'Без листа' },
  { value: 'issued', label: 'Лист выписан' },
] as const;
type WaybillFilter = (typeof WAYBILL_FILTERS)[number]['value'];

interface CreateValues {
  vehicleId?: string;
  routeDate?: dayjs.Dayjs;
  driverPersonId?: string;
}

export function VehicleRoutesTab() {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs(), dayjs()]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Рейс, открытый на правку: день, водитель и реквизиты выезда. */
  const [editing, setEditing] = useState<VehicleRouteDto | null>(null);

  /**
   * Рейс, названный в адресе: сюда приходят по ссылке из строки заявки («Маршрут Р-12»). Ключ
   * запроса тот же, которым карточка грузит рейс, — рейс спрашивается один раз на двоих.
   */
  const opened = useOpenedRecord<VehicleRouteDto>({
    active: useActiveTabKey() === 'routes',
    queryKey: (id) => ['vehicle-routes', id],
    fetch: (id) => vehicleRoutesApi.get(id),
  });

  /**
   * Период списка встаёт на день открытого рейса. Иначе за карточкой оставался бы сегодняшний
   * день — а пришли по ссылке на позавчерашний, и, закрыв карточку, человек оказывался бы в
   * списке, где этого рейса нет вовсе. Зависимость — сама дата: перебирать период руками при
   * открытой карточке это не мешает.
   */
  const openedRouteDate = opened.record?.routeDate;
  useEffect(() => {
    if (!openedRouteDate) return;
    const day = dayjs(openedRouteDate);
    setRange([day, day]);
  }, [openedRouteDate]);

  /**
   * Фильтры живут полосой над таблицей, а не выпадашками столбцов: в заголовке их не видно, а
   * часть значений — списки справочников (техника, водители), которым в выпадашке столбца места
   * нет. Тем же порядком собраны «Заявки ТС» и «Пользователи» — списки портала фильтруются
   * одинаково.
   */
  const { params, setParams, setSort, onTableChange } = useListParams<{
    vehicleId?: string;
    driverPersonId?: string;
    waybill?: WaybillFilter;
  }>({}, { searchKeys: [] });

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = {
    ...params,
    dateFrom: range[0].format(DATE),
    dateTo: range[1].format(DATE),
  };
  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-routes', query],
    queryFn: () => vehicleRoutesApi.list(query),
  });

  const { options: vehicleOptions, loading: vehiclesLoading } = useOwnVehicleOptions();
  const { options: driverOptions, loading: driversLoading } = useDriverOptions();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
    // Список заявок показывает номер рейса и предупреждение «без маршрута» — он тоже устарел.
    void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    // Тем же обновлением заканчивается выдача листа: он рождается ручкой рейса, а печатают его из
    // журнала — и диспетчер идёт туда сразу. Правка состава и даты рейса переписывает уже
    // выписанный лист, поэтому гасится журнал на любое изменение, а не только на выдачу.
    void qc.invalidateQueries({ queryKey: ['waybills'] });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const columns = [
    textColumn<VehicleRouteDto>({
      key: 'num',
      title: 'Маршрут',
      dataIndex: 'displayNumber',
      width: 140,
      // Поиск ушёл в панель над таблицей: он один на номер рейса, госномер и фамилию водителя, и
      // лупа в заголовке одного столбца обещала бы поиск только по нему.
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <span>{r.displayNumber}</span>
            {/* Перегон техники стоит в том же списке, что и грузовые рейсы: это тот же рейс той
              же машины на тот же день, и искать его в отдельной вкладке было бы негде. Отличает
              его пометка — и другое содержимое колонки «Заявки». */}
            {isRelocationPurpose(r.purpose) && (
              <Tag color={r.purpose === 'delivery' ? 'blue' : 'gold'}>
                {routePurposeShortLabels[r.purpose]}
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateOnly(r.routeDate)}
          </Typography.Text>
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.vehicleLabel}</span>
          {r.withTrailer && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              с прицепом {r.trailerLabel}
            </Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      searchable: false,
      width: 220,
      // Пустой водитель — не поломка, а состояние: рейс собрали заранее, человека ставят утром.
      // Но лист без него не выписать, и молчать об этом нельзя.
      render: (_v, r) => r.driverName || <Tag color="orange">не назначен</Tag>,
    }),
    textColumn<VehicleRouteDto>({
      key: 'requests',
      title: 'Заявки',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 280,
      render: (_v, r) =>
        // У перегона состава нет: он едет по одной заявке, а «откуда — куда» и есть его задание.
        isRelocationPurpose(r.purpose) ? (
          <Space direction="vertical" size={0}>
            <span>
              {r.sourceRequest ? (
                <EntityLink
                  to={vehicleRequestLink(can, {
                    id: r.sourceRequest.requestId,
                    status: r.sourceRequest.status,
                  })}
                  title="Открыть заявку"
                >
                  {r.sourceRequest.displayNumber}
                </EntityLink>
              ) : (
                '—'
              )}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.moveFrom} → {r.moveTo}
            </Typography.Text>
          </Space>
        ) : r.requests.length === 0 ? (
          <Typography.Text type="secondary">рейс пуст</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {/* Номер заявки — ссылка в её список: состав рейса читают вопросом «а что там за
                заявка», и до сих пор на него отвечали переключением вкладки и поиском номера. */}
            {r.requests.map((item) => (
              <span key={item.requestId}>
                {item.position}.{' '}
                <EntityLink
                  to={vehicleRequestLink(can, { id: item.requestId, status: item.status })}
                  title="Открыть заявку"
                >
                  {item.displayNumber}
                </EntityLink>{' '}
                — {item.customerName}
              </span>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.requests.length} из {routeRequestCapacity(r.formCode)} заявок
            </Typography.Text>
          </Space>
        ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'waybill',
      title: 'Путевой лист',
      dataIndex: 'waybill',
      sortable: false,
      searchable: false,
      width: 240,
      render: (_v, r) =>
        r.waybill ? (
          <Space direction="vertical" size={0}>
            {/* Номер ведёт в журнал учёта с этим же номером в поиске: карточки у листа нет —
                строка журнала и отвечает, что с бланком стало и чем он подшит (ADR 0037). */}
            <span>
              <EntityLink to={waybillLink(can, r.waybill.number)} title="Открыть в журнале листов">
                {r.waybill.number}
              </EntityLink>
            </span>
            <Tag color={waybillStatusColors[r.waybill.status]}>
              {waybillStatusLabels[r.waybill.status]}
            </Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">не выписан</Typography.Text>
        ),
    }),
    actionsColumn<VehicleRouteDto>(
      // Состав рейса и выписка листа — в карточке; отсюда рейс открывают и правят его реквизиты:
      // «переставить день» и «сменить водителя» это утренние действия, ради которых открывать
      // карточку незачем.
      (r) => {
        const frozen = !isRouteEditable(r.waybill?.status ?? null);
        return (
          <Space>
            <RowActionButton
              title="Открыть маршрут"
              icon={<EyeOutlined />}
              onClick={() => setOpenId(r.id)}
            />
            {/* Выключенная кнопка объясняется обёрткой: подсказку antd на ней не показывает. */}
            <span title={frozen ? ROUTE_FROZEN_MESSAGE : undefined}>
              <RowActionButton
                title="Редактировать маршрут"
                icon={<EditOutlined />}
                disabled={frozen}
                onClick={() => setEditing(r)}
              />
            </span>
          </Space>
        );
      },
      110,
    ),
  ];

  // Карточка телефона (ADR 0030): номер рейса и дата в шапке, машина и водитель — строками;
  // касание открывает тот же рейс, что и кнопка «Открыть» на десктопе.
  const card: CardConfig<VehicleRouteDto> = {
    title: (r) => `${r.displayNumber} · ${formatDateOnly(r.routeDate)}`,
    badge: (r) =>
      r.waybill ? (
        <Tag color={waybillStatusColors[r.waybill.status]}>
          {waybillStatusLabels[r.waybill.status]}
        </Tag>
      ) : (
        <Tag>без листа</Tag>
      ),
    primary: (r) => r.vehicleLabel,
    lines: [
      (r) => r.driverName || 'водитель не назначен',
      (r) =>
        r.requests.length === 0
          ? 'рейс пуст'
          : `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок: ${r.requests
              .map((item) => item.displayNumber)
              .join(', ')}`,
    ],
    onOpen: (r) => setOpenId(r.id),
  };

  /** Полоса фильтров над таблицей: поиск, техника, водитель, состояние листа и период рейсов. */
  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Ищет сервер сразу по трём приметам рейса: номер («Р-12»), госномер машины и фамилия
        // водителя — рейс запоминают то одним, то другим.
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
      {/* Период рейсов остаётся обязательным: маршруты читают по дням, и «вся история сразу» —
        не тот вопрос, который здесь задают. Поэтому без крестика. */}
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

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
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
    <>
      <PageTableLayout
        filters={filters}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            Новый маршрут
          </Button>
        }
        mobile={{
          search: {
            value: params.search,
            placeholder: 'Р-12, госномер или водитель',
            onChange: (v) => applyFilter({ search: v }),
          },
          filters: mobileFilters,
          sort: {
            options: sortOptionsFrom(columns, { num: 'Маршрут' }),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          },
          primaryAction: {
            label: 'Новый маршрут',
            icon: <PlusOutlined />,
            onClick: () => setCreating(true),
          },
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
      </PageTableLayout>

      <VehicleRouteModal
        routeId={openId ?? opened.id}
        onClose={() => {
          setOpenId(null);
          opened.clear();
        }}
        onChanged={refresh}
        onEdit={setEditing}
      />

      <VehicleRouteEditModal
        route={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setEditing(null);
          refresh();
          // Список стоит на дне: рейс, уехавший на другую дату, из текущего периода пропадает —
          // и человек должен увидеть его там, куда перенёс, а не гадать, куда он делся.
          const day = dayjs(updated.routeDate);
          setRange([day, day]);
        }}
      />

      <CreateRouteModal
        open={creating}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          refresh();
          message.success('Маршрут заведён');
          setOpenId(id);
        }}
      />
    </>
  );
}

/**
 * Новый рейс: машина, дата и — если уже известно — водитель. Реквизиты выезда сюда не вынесены:
 * их наследует сам сервер от прошлого рейса этой машины, а правят их в карточке.
 */
function CreateRouteModal({
  open,
  onCancel,
  onCreated,
}: {
  open: boolean;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<CreateValues>();
  const vehicleId = Form.useWatch('vehicleId', form);
  const routeDate = Form.useWatch('routeDate', form);

  // Рейс ведётся только на собственной технике: у арендной лист выписывает арендодатель.
  const { data: vehicles, isFetching } = useQuery({
    queryKey: ['vehicles', 'for-routes'],
    queryFn: () => vehiclesApi.list({ ownership: 'own', status: 'active', page: 1, pageSize: 500 }),
    enabled: open,
  });

  // Водитель — весь справочник (ADR 0064): категория и полнота документов никого не убирают, они
  // помечают строку. Чем это грозит бланку, скажет карточка рейса — там, где лист выписывают.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, routeDate?.format(DATE)],
    queryFn: () =>
      driversApi.available({
        vehicleId: vehicleId!,
        on: routeDate!.format(DATE),
        withTrailer: false,
      }),
    enabled: open && !!vehicleId && !!routeDate,
  });

  const create = useMutation({
    mutationFn: (v: CreateValues) =>
      vehicleRoutesApi.create({
        vehicleId: v.vehicleId!,
        routeDate: v.routeDate!.format(DATE),
        driverPersonId: v.driverPersonId ?? null,
      }),
    onSuccess: (route) => {
      form.resetFields();
      onCreated(route.id);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title="Новый маршрут"
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={create.isPending}
      okText="Завести"
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
        <FormGrid>
          <Form.Item
            name="vehicleId"
            label="Техника"
            rules={[{ required: true, message: 'Выберите технику' }]}
          >
            <AutoSelect
              options={(vehicles?.items ?? []).map((v) => ({
                value: v.id,
                label: vehicleLabel(v),
              }))}
              showSearch
              optionFilterProp="label"
              loading={isFetching}
              placeholder="Выберите машину"
            />
          </Form.Item>
          {/* Дата спрашивается пустым полем: рейс заводят и на завтра, и на послезавтра, а
            подставленное «сегодня» проскакивают не глядя — и рейс оказывается не в том дне, где
            его потом ищут. */}
          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Водитель"
              extra="Необязательно: рейс собирают заранее, а человека ставят утром. Без водителя лист не выписать."
            >
              {/* Порядок задал сервер: пригодные первыми — комплект документов, затем категория
                (ADR 0064, ADR 0055), внутри них работавшие на этой машине (ADR 0056). Пометки в
                строке объясняют почему — но выбирает человек: сам собой водитель в поле не
                встаёт даже тогда, когда пригоден он один. */}
              <AutoSelect
                autoSelectSole={false}
                options={(selection?.drivers ?? []).map((d) => ({
                  value: d.personId,
                  label: [
                    d.fullName,
                    d.categories.join(', '),
                    driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
                    d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
                    driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                showSearch
                allowClear
                optionFilterProp="label"
                loading={driversLoading}
                disabled={!vehicleId || !routeDate}
                placeholder={vehicleId ? 'Выберите водителя' : 'Сначала выберите машину'}
              />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
