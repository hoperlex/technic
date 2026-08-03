import { useState } from 'react';
import { App, Button, DatePicker, Form, Segmented, Space, Tag, Typography } from 'antd';
import { EyeOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverWorkedOnVehicle,
  MAX_ROUTE_REQUESTS,
  type VehicleRouteDto,
  vehicleLabel,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi, vehiclesApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { DataTable, type CardConfig } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { FormGrid } from '../../components/FormGrid';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, RowActionButton, textColumn } from '../../components/columns';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';
import { VehicleRouteModal } from './VehicleRouteModal';
import { formatDateOnly } from './shared';

/**
 * Рейсы: что и с кем едет в конкретный день (план `docs/vehicle-routes-plan.md`).
 *
 * Первая вкладка отвечает на «что заказали и что с этим делают», эта — на вопрос дня диспетчера:
 * чем занята машина, кто за рулём и выписан ли бланк. Заявки попадают сюда переводом в работу,
 * но собирают рейс здесь: порядок талонов, водитель и реквизиты выезда — свойства рейса, а не
 * заявки.
 *
 * Открывается день сегодняшний: рейс планируют накануне и правят утром, а история рейсов
 * читается журналом путевых листов.
 */

const DATE = 'YYYY-MM-DD';

/** Состояние документа — им диспетчер закрывает день: «что ещё без листа». */
const WAYBILL_FILTERS = [
  { value: 'all', label: 'Все' },
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
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs(), dayjs()]);
  const [waybill, setWaybill] = useState<WaybillFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { params, onTableChange } = useListParams({}, { searchKeys: ['num'] });
  const query = {
    ...params,
    dateFrom: range[0].format(DATE),
    dateTo: range[1].format(DATE),
    waybill: waybill === 'all' ? undefined : waybill,
  };
  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-routes', query],
    queryFn: () => vehicleRoutesApi.list(query),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
    // Список заявок показывает номер рейса и предупреждение «без маршрута» — он тоже устарел.
    void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
  };

  const columns = [
    textColumn<VehicleRouteDto>({
      key: 'num',
      title: 'Маршрут',
      dataIndex: 'displayNumber',
      width: 140,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.displayNumber}</span>
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
        r.requests.length === 0 ? (
          <Typography.Text type="secondary">рейс пуст</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {r.requests.map((item) => (
              <span key={item.requestId}>
                {item.position}. {item.displayNumber} — {item.customerName}
              </span>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.requests.length} из {MAX_ROUTE_REQUESTS} талонов
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
            <span>{r.waybill.number}</span>
            <Tag color={waybillStatusColors[r.waybill.status]}>
              {waybillStatusLabels[r.waybill.status]}
            </Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">не выписан</Typography.Text>
        ),
    }),
    actionsColumn<VehicleRouteDto>(
      // Карточка рейса — единственное место, где собирают талоны, ставят водителя и выписывают
      // лист; из списка рейс только открывают.
      (r) => (
        <RowActionButton
          title="Открыть маршрут"
          icon={<EyeOutlined />}
          onClick={() => setOpenId(r.id)}
        />
      ),
      70,
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
          : `${r.requests.length} из ${MAX_ROUTE_REQUESTS} талонов: ${r.requests
              .map((item) => item.displayNumber)
              .join(', ')}`,
    ],
    onOpen: (r) => setOpenId(r.id),
  };

  return (
    <>
      <PageTableLayout
        extra={
          <Space wrap>
            <DatePicker.RangePicker
              format="DD.MM.YYYY"
              value={range}
              allowClear={false}
              inputReadOnly={isMobile}
              onChange={(v) => v && setRange(v as [dayjs.Dayjs, dayjs.Dayjs])}
            />
            <Segmented<WaybillFilter>
              value={waybill}
              onChange={setWaybill}
              options={[...WAYBILL_FILTERS]}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Новый маршрут
            </Button>
          </Space>
        }
      >
        <DataTable<VehicleRouteDto>
          columns={columns}
          card={card}
          data={data?.items ?? []}
          total={data?.total ?? 0}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          onChange={onTableChange}
        />
      </PageTableLayout>

      <VehicleRouteModal routeId={openId} onClose={() => setOpenId(null)} onChanged={refresh} />

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

  // Водитель — из тех, кто допущен к этой машине на эту дату: тот же отбор проверит сервер при
  // выписке листа.
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
          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            initialValue={dayjs()}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Водитель"
              extra="Необязательно: рейс собирают заранее, а человека ставят утром. Без водителя лист не выписать."
            >
              {/* Порядок задал сервер: подходящие по категории первыми (ADR 0055), внутри них —
                работавшие на этой машине (ADR 0056). Пометки в строке объясняют почему. */}
              <AutoSelect
                options={(selection?.drivers ?? []).map((d) => ({
                  value: d.personId,
                  label: [
                    d.fullName,
                    d.categories.join(', '),
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
