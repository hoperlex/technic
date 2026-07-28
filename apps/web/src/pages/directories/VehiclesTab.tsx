import { useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  type TableColumnsType,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RENTAL_STATUSES,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type VehicleDto,
  type VehicleOwnership,
  type VehicleStatus,
  VEHICLE_STATUSES,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  vehicleStatusColors,
  vehicleStatusLabels,
  vehicleTitle,
} from '@technic/contracts';
import {
  counterpartiesApi,
  vehicleCategoriesApi,
  vehicleModelsApi,
  vehiclesApi,
  vehicleTypesApi,
} from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, badgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

// Справочник техники (ADR 0007) с двумя ветками принадлежности (ADR 0018). Один список, а не две
// вкладки: сравнивать своё и аренду нужно рядом. Переключатель принадлежности не только фильтрует,
// но и убирает неприменимые колонки — у аренды нет госномера и марки, у своей нет цен.

interface FormValues {
  ownership: VehicleOwnership;
  vehicleTypeId: string;
  vehicleCategoryId?: string;
  vehicleModelId?: string;
  registrationNumber?: string;
  passportNumber?: string;
  lessorId?: string;
  description?: string;
  pricePerHour?: number;
  pricePerShift?: number;
  shiftHours?: number;
  status: VehicleStatus;
  note?: string;
}

const statusOptions = VEHICLE_STATUSES.map((s) => ({ value: s, label: vehicleStatusLabels[s] }));
const rentalStatusOptions = RENTAL_STATUSES.map((s) => ({
  value: s,
  label: vehicleStatusLabels[s],
}));

const money = (v: number | null) =>
  v == null ? '—' : `${v.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽`;

export function VehiclesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const { params, setParams, onTableChange } = useListParams<{
    ownership?: VehicleOwnership;
    vehicleTypeId?: string;
    lessorId?: string;
    status?: VehicleStatus;
    includeDeleted?: string;
    // Статус и поиск задаются только панелью над таблицей: продублируй их выпадашкой столбца —
    // и любая сортировка сбрасывала бы выбранное (в onChange таблицы приходит пустой фильтр).
  }>({}, { searchKeys: [] });

  const ownershipFilter = params.ownership;
  const showOwnColumns = ownershipFilter !== 'rental';
  const showRentalColumns = ownershipFilter !== 'own';

  const { data, isFetching } = useQuery({
    queryKey: ['vehicles', params],
    queryFn: () => vehiclesApi.list(params),
  });

  // Типы ТС для селекта (активные).
  const { data: typesData } = useQuery({
    queryKey: ['vehicle-types', 'for-select'],
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const types = typesData?.items ?? [];
  const typeOptions = types.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }));

  // Арендодатели — контрагенты роли «Арендодатель (ТС)»; учёток за ними нет, это чистый справочник.
  const { data: lessorsData } = useQuery({
    queryKey: ['counterparties', 'vehicle-lessors'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const lessorOptions = (lessorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const watchOwnership = Form.useWatch('ownership', form) ?? 'own';
  const watchTypeId = Form.useWatch('vehicleTypeId', form);
  const isRental = watchOwnership === 'rental';

  // Марки/модели выбранного типа (могут быть пусты, пока не засидированы — ADR 0007).
  const { data: modelsData } = useQuery({
    queryKey: ['vehicle-models', 'for-select', watchTypeId],
    queryFn: () =>
      vehicleModelsApi.list({
        page: 1,
        pageSize: 500,
        vehicleTypeId: watchTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!watchTypeId && !isRental,
  });
  const modelOptions = (modelsData?.items ?? []).map((m) => ({ value: m.id, label: m.name }));

  // Категории выбранного типа (ADR 0016): у типа без ТТХ их нет вовсе.
  const { data: categoriesData } = useQuery({
    queryKey: ['vehicle-categories', 'for-select', watchTypeId],
    queryFn: () =>
      vehicleCategoriesApi.list({
        page: 1,
        pageSize: 500,
        vehicleTypeId: watchTypeId,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!watchTypeId,
  });
  const categoryOptions = (categoriesData?.items ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const typeHasCategories = categoryOptions.length > 0;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      ownership: ownershipFilter ?? 'own',
      status: 'active',
    } as Partial<FormValues>);
    setOpen(true);
  };
  const openEdit = (r: VehicleDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      ownership: r.ownership,
      vehicleTypeId: r.vehicleTypeId,
      vehicleCategoryId: r.vehicleCategoryId ?? undefined,
      vehicleModelId: r.vehicleModelId ?? undefined,
      registrationNumber: r.registrationNumber ?? undefined,
      passportNumber: r.passportNumber ?? undefined,
      lessorId: r.lessorId ?? undefined,
      description: r.description || undefined,
      pricePerHour: r.pricePerHour ?? undefined,
      pricePerShift: r.pricePerShift ?? undefined,
      shiftHours: r.shiftHours ?? undefined,
      status: r.status,
      note: r.note,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: FormValues) => {
      const common = {
        vehicleTypeId: v.vehicleTypeId,
        vehicleCategoryId: v.vehicleCategoryId ?? null,
        status: v.status,
        note: v.note ?? '',
      };
      if (v.ownership === 'rental') {
        const body = {
          ...common,
          lessorId: v.lessorId!,
          description: v.description ?? '',
          pricePerHour: v.pricePerHour ?? null,
          pricePerShift: v.pricePerShift ?? null,
          shiftHours: v.shiftHours ?? null,
        };
        // Принадлежность неизменяема — в PATCH её не отправляем.
        return record
          ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
          : vehiclesApi.create({ ownership: 'rental', ...body } as CreateVehicleInput);
      }
      const body = {
        ...common,
        vehicleModelId: v.vehicleModelId ?? null,
        registrationNumber: v.registrationNumber ?? null,
        passportNumber: v.passportNumber ?? null,
      };
      return record
        ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
        : vehiclesApi.create({ ownership: 'own', ...body } as CreateVehicleInput);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => vehiclesApi.remove(id),
    onSuccess: () => {
      message.success('Перемещено в архив');
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => vehiclesApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (r: VehicleDto) =>
    modal.confirm({
      title: `Переместить в архив «${vehicleTitle(r)}»?`,
      okText: 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns: TableColumnsType<VehicleDto> = [
    // Колонку принадлежности показываем только в общем списке: в отфильтрованном она одинакова.
    ...(ownershipFilter
      ? []
      : [
          badgeColumn<VehicleDto>({
            key: 'ownership',
            title: 'Принадлежность',
            dataIndex: 'ownership',
            labels: vehicleOwnershipLabels,
            colors: vehicleOwnershipColors,
            width: 150,
          }),
        ]),
    {
      key: 'typeName',
      title: 'Тип',
      dataIndex: 'typeName',
      width: 180,
      ellipsis: true,
      sorter: true,
    },
    {
      key: 'categoryName',
      title: 'Категория',
      width: 200,
      ellipsis: true,
      sorter: true,
      render: (_v: unknown, r: VehicleDto) => r.categoryName ?? '—',
    },
    ...(showOwnColumns
      ? [
          textColumn<VehicleDto>({
            key: 'registrationNumber',
            title: 'Госномер',
            dataIndex: 'registrationNumber',
            searchable: false,
            width: 140,
            render: (_v, r) => r.registrationNumber ?? '—',
          }),
          {
            key: 'modelName',
            title: 'Марка/модель',
            width: 180,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.modelName ?? '—',
          },
        ]
      : []),
    ...(showRentalColumns
      ? [
          {
            key: 'lessorName',
            title: 'Арендодатель',
            width: 220,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.lessorName ?? '—',
          },
          {
            key: 'description',
            title: 'Описание',
            width: 180,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.description || '—',
          },
          {
            key: 'pricePerHour',
            title: '₽/час',
            width: 120,
            align: 'right' as const,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => money(r.pricePerHour),
          },
          {
            key: 'pricePerShift',
            title: '₽/смена',
            width: 140,
            align: 'right' as const,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) =>
              r.pricePerShift == null ? (
                '—'
              ) : (
                <Tooltip title={r.shiftHours ? `Смена ${r.shiftHours} ч` : 'Длительность смены не задана'}>
                  {money(r.pricePerShift)}
                </Tooltip>
              ),
          },
        ]
      : []),
    badgeColumn<VehicleDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      labels: vehicleStatusLabels,
      colors: vehicleStatusColors,
      width: 140,
    }),
    actionsColumn<VehicleDto>((r) =>
      r.deletedAt ? (
        <Space>
          <Tag>в архиве</Tag>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            title="Восстановить"
            onClick={() => restoreMut.mutate(r.id)}
          />
        </Space>
      ) : (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(r)} />
        </Space>
      ),
    ),
  ];

  const filters = (
    <Space wrap>
      <Segmented<string>
        value={ownershipFilter ?? 'all'}
        options={[
          { value: 'all', label: 'Все' },
          { value: 'own', label: vehicleOwnershipLabels.own },
          { value: 'rental', label: vehicleOwnershipLabels.rental },
        ]}
        onChange={(v) =>
          setParams((p) => ({
            ...p,
            ownership: v === 'all' ? undefined : (v as VehicleOwnership),
            // Фильтр по арендодателю осмыслен только внутри аренды.
            lessorId: v === 'rental' ? p.lessorId : undefined,
            page: 1,
          }))
        }
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 200 }}
        options={typeOptions}
        value={params.vehicleTypeId as string | undefined}
        onChange={(v) => setParams((p) => ({ ...p, vehicleTypeId: v, page: 1 }))}
      />
      {ownershipFilter === 'rental' ? (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все арендодатели"
          style={{ width: 220 }}
          options={lessorOptions}
          value={params.lessorId}
          onChange={(v) => setParams((p) => ({ ...p, lessorId: v, page: 1 }))}
        />
      ) : null}
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 160 }}
        options={ownershipFilter === 'rental' ? rentalStatusOptions : statusOptions}
        value={params.status}
        onChange={(v) => setParams((p) => ({ ...p, status: v, page: 1 }))}
      />
      <Input.Search
        allowClear
        placeholder="Госномер / марка / арендодатель"
        style={{ width: 280 }}
        onSearch={(val) => setParams((p) => ({ ...p, search: val || undefined, page: 1 }))}
      />
      <Checkbox
        checked={params.includeDeleted === 'true'}
        onChange={(e) =>
          setParams((p) => ({
            ...p,
            includeDeleted: e.target.checked ? 'true' : undefined,
            page: 1,
          }))
        }
      >
        Показать архив
      </Checkbox>
    </Space>
  );

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить технику
        </Button>
      }
    >
      <DataTable<VehicleDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={
          record
            ? `Редактирование: ${vehicleOwnershipLabels[record.ownership].toLowerCase()}`
            : 'Новая единица техники'
        }
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          onValuesChange={(changed) => {
            // Смена типа сбрасывает марку/модель и категорию: обе принадлежат типу.
            if ('vehicleTypeId' in changed) {
              form.setFieldValue('vehicleModelId', undefined);
              form.setFieldValue('vehicleCategoryId', undefined);
            }
            // У аренды состояний машины нет — статус приводим к допустимому.
            if (changed.ownership === 'rental' && form.getFieldValue('status') !== 'inactive') {
              form.setFieldValue('status', 'active');
            }
          }}
        >
          <Form.Item
            name="ownership"
            label="Принадлежность"
            extra={record ? 'Принадлежность неизменяема: это другая сущность, а не правка' : undefined}
          >
            <Segmented<VehicleOwnership>
              disabled={!!record}
              options={[
                { value: 'own', label: vehicleOwnershipLabels.own },
                { value: 'rental', label: vehicleOwnershipLabels.rental },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="vehicleTypeId"
            label="Тип ТС"
            rules={[{ required: true, message: 'Выберите тип' }]}
          >
            <Select options={typeOptions} showSearch optionFilterProp="label" placeholder="Тип ТС" />
          </Form.Item>

          {typeHasCategories ? (
            <Form.Item
              name="vehicleCategoryId"
              label="Категория"
              extra={
                isRental
                  ? 'Без категории предложение не сопоставить с заявкой — указывайте, если арендодатель уточнил'
                  : undefined
              }
            >
              <Select
                options={categoryOptions}
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Категория (опционально)"
              />
            </Form.Item>
          ) : null}

          {isRental ? (
            <>
              <Form.Item
                name="lessorId"
                label="Арендодатель"
                rules={[{ required: true, message: 'Выберите арендодателя' }]}
              >
                <Select
                  options={lessorOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Контрагент роли «Арендодатель (ТС)»"
                  notFoundContent="Арендодателей нет — заведите их в справочнике контрагентов"
                />
              </Form.Item>
              <Form.Item
                name="description"
                label="Описание"
                extra="Короткий срез вида «Автокран 70 тн» — им различаются предложения одного арендодателя"
              >
                <Input maxLength={120} placeholder="Автокран 70 тн" />
              </Form.Item>
              <Space style={{ width: '100%' }} size="middle">
                <Form.Item
                  name="pricePerHour"
                  label="₽ / час"
                  style={{ flex: 1 }}
                  rules={[
                    {
                      validator: (_rule, value) =>
                        value != null || form.getFieldValue('pricePerShift') != null
                          ? Promise.resolve()
                          : Promise.reject(new Error('Укажите цену за час или за смену')),
                    },
                  ]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} />
                </Form.Item>
                <Form.Item name="pricePerShift" label="₽ / смена" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} />
                </Form.Item>
                <Form.Item name="shiftHours" label="Часов в смене" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={1} max={24} placeholder="8" />
                </Form.Item>
              </Space>
              <Form.Item name="status" label="Статус">
                <Select options={rentalStatusOptions} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="vehicleModelId" label="Марка/модель">
                <Select
                  options={modelOptions}
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  disabled={!watchTypeId}
                  placeholder={watchTypeId ? 'Марка/модель (опционально)' : 'Сначала выберите тип'}
                  notFoundContent="Нет марок для этого типа"
                />
              </Form.Item>
              <Space style={{ width: '100%' }} size="middle">
                <Form.Item name="registrationNumber" label="Госномер" style={{ flex: 1 }}>
                  <Input maxLength={50} />
                </Form.Item>
                <Form.Item name="status" label="Статус" style={{ flex: 1 }}>
                  <Select options={statusOptions} />
                </Form.Item>
              </Space>
              <Form.Item name="passportNumber" label="ПТС / ПСМ">
                <Input maxLength={100} />
              </Form.Item>
            </>
          )}

          <Form.Item name="note" label="Примечание">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
