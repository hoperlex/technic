import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  type TableColumnType,
} from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  VEHICLE_SPEC_CODE_RE,
  VEHICLE_SPEC_MAX_DECIMALS,
  type CreateVehicleSpecInput,
  type UpdateVehicleSpecInput,
  type VehicleSpecDto,
} from '@technic/contracts';
import { vehicleSpecsApi } from '../../api/resources';
import { DataTable, type CardConfig, type TableChange } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { sortOptionsFrom, type FilterDefinition } from '../../components/listControls';
import { actionsColumn, textColumn } from '../../components/columns';
import { errorMessage } from '../../utils/format';

// Справочник ТТХ (ADR 0016): характеристики, из значений которых складываются категории типов ТС.
// Удаления нет — деактивация, и та запрещена, пока ТТХ привязан к типам. Единица измерения и
// точность замораживаются с первой привязки: они входят в смысл уже заведённых категорий.

interface SpecParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  isActive?: string;
  [key: string]: unknown;
}

interface SpecFormValues {
  code?: string;
  name?: string;
  shortName?: string;
  unit?: string;
  decimals?: number;
  minValue?: number | null;
  maxValue?: number | null;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export function VehicleSpecsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const [params, setParams] = useState<SpecParams>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<SpecParams>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-specs', params],
    queryFn: () => vehicleSpecsApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleSpecDto | null>(null);
  const [form] = Form.useForm<SpecFormValues>();
  const isEdit = !!record;
  // Привязанный ТТХ уже участвует в канонизации значений — единицу и точность менять нельзя.
  const isUsed = (record?.usedInTypes ?? 0) > 0;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ decimals: 0, sortOrder: 100, isActive: true });
    setOpen(true);
  };
  const openEdit = (r: VehicleSpecDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      code: r.code,
      name: r.name,
      shortName: r.shortName,
      unit: r.unit,
      decimals: r.decimals,
      minValue: r.minValue,
      maxValue: r.maxValue,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (
      arg: { create: CreateVehicleSpecInput } | { id: string; body: UpdateVehicleSpecInput },
    ) =>
      'create' in arg
        ? vehicleSpecsApi.create(arg.create)
        : vehicleSpecsApi.update(arg.id, arg.body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-specs'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: SpecFormValues) => {
    if (isEdit) {
      const body: UpdateVehicleSpecInput = {
        name: v.name,
        shortName: v.shortName ?? '',
        description: v.description ?? '',
        minValue: v.minValue ?? null,
        maxValue: v.maxValue ?? null,
        sortOrder: v.sortOrder,
        isActive: v.isActive,
        // Замороженные поля отправляем только у ещё не привязанного ТТХ.
        ...(isUsed ? {} : { unit: v.unit ?? '', decimals: v.decimals }),
      };
      saveMut.mutate({ id: record!.id, body });
      return;
    }
    saveMut.mutate({
      create: {
        code: v.code!,
        name: v.name!,
        shortName: v.shortName ?? '',
        unit: v.unit ?? '',
        decimals: v.decimals ?? 0,
        minValue: v.minValue ?? null,
        maxValue: v.maxValue ?? null,
        description: v.description ?? '',
        sortOrder: v.sortOrder ?? 100,
        isActive: v.isActive ?? true,
      },
    });
  };

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleSpecsApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'ТТХ активирован' : 'ТТХ деактивирован');
      void qc.invalidateQueries({ queryKey: ['vehicle-specs'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const onToggleActive = (r: VehicleSpecDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать ТТХ «${r.name}»?`,
      content: 'Деактивированный ТТХ нельзя привязать к новым типам.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  const onTableChange = (c: TableChange) =>
    setParams((p) => ({
      ...p,
      page: c.page,
      pageSize: c.pageSize,
      sortBy: c.sortBy ?? 'sortOrder',
      sortOrder: c.sortOrder ?? 'asc',
    }));

  const columns: TableColumnType<VehicleSpecDto>[] = [
    textColumn<VehicleSpecDto>({
      key: 'name',
      title: 'Характеристика',
      dataIndex: 'name',
      searchable: false,
    }),
    textColumn<VehicleSpecDto>({
      key: 'unit',
      title: 'Ед. изм.',
      dataIndex: 'unit',
      searchable: false,
      width: 110,
      render: (v) => (v as string) || '—',
    }),
    {
      key: 'decimals',
      title: 'Знаков',
      dataIndex: 'decimals',
      width: 90,
      sorter: false,
    },
    {
      key: 'bounds',
      title: 'Границы',
      width: 140,
      render: (_v, r) =>
        r.minValue == null && r.maxValue == null
          ? '—'
          : `${r.minValue ?? '…'} — ${r.maxValue ?? '…'}`,
    },
    {
      key: 'usedInTypes',
      title: 'В типах',
      dataIndex: 'usedInTypes',
      width: 100,
      sorter: false,
      render: (v: number) => (v > 0 ? <Tag color="blue">{v}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      render: (v: boolean, r) => (
        <Tooltip title={r.usedInTypes > 0 ? 'ТТХ привязан к типам — сначала отвяжите' : undefined}>
          <Switch
            size="small"
            checked={v}
            disabled={v && r.usedInTypes > 0}
            loading={toggleMut.isPending}
            onChange={(n) => onToggleActive(r, n)}
          />
        </Tooltip>
      ),
    },
    actionsColumn<VehicleSpecDto>((r) => (
      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
    )),
  ];

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код/название/ед.)"
        style={{ width: 240 }}
        value={params.search}
        onChange={(e) => patchParams({ search: e.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Активность"
        style={{ width: 150 }}
        options={[
          { value: 'true', label: 'Активные' },
          { value: 'false', label: 'Неактивные' },
        ]}
        value={params.isActive}
        onChange={(v) => patchParams({ isActive: v })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). Поиска здесь нет: он стоит
      строкой в панели списка (ADR 0042), и второе поле спрашивало бы то же самое. */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Неактивные' },
      ],
      placeholder: 'Все',
      onChange: (v) => patchParams({ isActive: v }),
    },
  ];

  /**
   * Карточка ТТХ на телефоне (ADR 0042): наименование с единицей — то, чем характеристику
   * называют, дальше границы значений и число типов, где она уже привязана.
   */
  const card: CardConfig<VehicleSpecDto> = {
    title: (r) => r.name,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => (r.unit ? `Единица: ${r.unit}` : 'Без единицы измерения'),
    lines: [
      (r) =>
        r.minValue == null && r.maxValue == null
          ? null
          : `Границы: ${r.minValue ?? '…'} — ${r.maxValue ?? '…'}`,
      (r) => (r.usedInTypes > 0 ? `Привязан к типам: ${r.usedInTypes}` : 'Не привязан к типам'),
    ],
    onOpen: openEdit,
    actions: (r) => [
      { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
      {
        key: 'toggle',
        label: r.isActive ? 'Деактивировать' : 'Активировать',
        danger: r.isActive,
        // Привязанный к типам ТТХ не выключают: сперва его отвязывают в карточке типа.
        disabled: r.isActive && r.usedInTypes > 0,
        onClick: () => onToggleActive(r, !r.isActive),
      },
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код, название, единица',
          onChange: (v) => patchParams({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: (sortBy, sortOrder) =>
            patchParams({ sortBy: sortBy ?? 'sortOrder', sortOrder: sortOrder ?? 'asc' }),
        },
        primaryAction: { label: 'Добавить ТТХ', icon: <PlusOutlined />, onClick: openCreate },
      }}
    >
      <DataTable<VehicleSpecDto>
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
      <FormModal
        title={isEdit ? 'Редактирование ТТХ' : 'Новый ТТХ'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item
            name="code"
            label="Код"
            rules={
              isEdit
                ? []
                : [
                    { required: true, message: 'Укажите код' },
                    {
                      pattern: VEHICLE_SPEC_CODE_RE,
                      message: 'Только строчные латинские, цифры и _, первый символ — буква',
                    },
                  ]
            }
          >
            {/* Код — стабильный системный идентификатор, неизменяем после создания. */}
            <Input disabled={isEdit} placeholder="например lift_capacity" />
          </Form.Item>

          <Form.Item
            name="name"
            label="Наименование"
            rules={[{ required: true, message: 'Укажите наименование' }]}
          >
            <Input placeholder="Грузоподъёмность" />
          </Form.Item>

          <Form.Item
            name="shortName"
            label="Короткое имя"
            extra="Используется в наименовании категории: «Автокраны, г/п 25 т»"
          >
            <Input placeholder="г/п" />
          </Form.Item>

          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item
              name="unit"
              label="Единица измерения"
              extra={isUsed ? 'Заморожена: ТТХ привязан к типам' : undefined}
              style={{ flex: 1 }}
            >
              <Input disabled={isUsed} placeholder="т" />
            </Form.Item>
            <Form.Item
              name="decimals"
              label="Знаков после запятой"
              extra={isUsed ? 'Заморожено: ТТХ привязан к типам' : undefined}
              style={{ flex: 1 }}
            >
              <InputNumber
                disabled={isUsed}
                min={0}
                max={VEHICLE_SPEC_MAX_DECIMALS}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Space>

          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="minValue" label="Минимум" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} placeholder="—" />
            </Form.Item>
            <Form.Item name="maxValue" label="Максимум" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} placeholder="—" />
            </Form.Item>
          </Space>

          <Form.Item name="description" label="Описание">
            <Input.TextArea rows={2} />
          </Form.Item>

          <Form.Item name="sortOrder" label="Порядок сортировки">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>

          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch disabled={isUsed} />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
