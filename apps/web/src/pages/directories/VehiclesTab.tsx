import { useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Tag,
  type TableColumnsType,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type CreateVehicleInput,
  type VehicleDto,
  type VehicleStatus,
  VEHICLE_STATUSES,
  vehicleStatusColors,
  vehicleStatusLabels,
} from '@technic/contracts';
import { vehicleModelsApi, vehiclesApi, vehicleTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, badgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

interface FormValues {
  vehicleTypeId: string;
  vehicleModelId?: string;
  registrationNumber?: string;
  inventoryNumber?: string;
  serialNumber?: string;
  passportNumber?: string;
  manufacturerName?: string;
  manufacturedOn?: Dayjs | null;
  status: VehicleStatus;
  note?: string;
}

const statusOptions = VEHICLE_STATUSES.map((s) => ({ value: s, label: vehicleStatusLabels[s] }));

export function VehiclesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const { params, setParams, onTableChange } = useListParams<{
    vehicleTypeId?: string;
    status?: VehicleStatus;
    includeDeleted?: string;
  }>(
    {},
    {
      searchKeys: ['registrationNumber'],
      mapFilters: (f) => ({ status: f.status?.[0] as VehicleStatus | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['vehicles', params],
    queryFn: () => vehiclesApi.list(params),
  });

  // Типы ТС для селекта (активные).
  const { data: typesData } = useQuery({
    queryKey: ['vehicle-types', 'for-select'],
    queryFn: () => vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const typeOptions = (typesData?.items ?? [])
    .filter((t) => t.isActive)
    .map((t) => ({ value: t.id, label: t.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const watchTypeId = Form.useWatch('vehicleTypeId', form);

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
    enabled: !!watchTypeId,
  });
  const modelOptions = (modelsData?.items ?? []).map((m) => ({ value: m.id, label: m.name }));

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ status: 'active' } as Partial<FormValues>);
    setOpen(true);
  };
  const openEdit = (r: VehicleDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      vehicleTypeId: r.vehicleTypeId,
      vehicleModelId: r.vehicleModelId ?? undefined,
      registrationNumber: r.registrationNumber ?? undefined,
      inventoryNumber: r.inventoryNumber ?? undefined,
      serialNumber: r.serialNumber ?? undefined,
      passportNumber: r.passportNumber ?? undefined,
      manufacturerName: r.manufacturerName,
      manufacturedOn: r.manufacturedOn ? dayjs(r.manufacturedOn) : null,
      status: r.status,
      note: r.note,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: FormValues) => {
      const payload: CreateVehicleInput = {
        vehicleTypeId: v.vehicleTypeId,
        vehicleModelId: v.vehicleModelId ?? null,
        registrationNumber: v.registrationNumber ?? null,
        inventoryNumber: v.inventoryNumber ?? null,
        serialNumber: v.serialNumber ?? null,
        passportNumber: v.passportNumber ?? null,
        manufacturerName: v.manufacturerName ?? '',
        manufacturedOn: v.manufacturedOn ? v.manufacturedOn.format('YYYY-MM-DD') : null,
        status: v.status,
        note: v.note ?? '',
      };
      return record ? vehiclesApi.update(record.id, payload) : vehiclesApi.create(payload);
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
      title: `Переместить в архив${r.registrationNumber ? ` «${r.registrationNumber}»` : ''}?`,
      okText: 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns: TableColumnsType<VehicleDto> = [
    textColumn<VehicleDto>({
      key: 'registrationNumber',
      title: 'Госномер',
      dataIndex: 'registrationNumber',
      width: 150,
      render: (_v, r) => r.registrationNumber ?? '—',
    }),
    { key: 'typeName', title: 'Тип', dataIndex: 'typeName', width: 180, ellipsis: true },
    {
      key: 'modelName',
      title: 'Марка/модель',
      width: 180,
      ellipsis: true,
      render: (_v: unknown, r: VehicleDto) => r.modelName ?? '—',
    },
    {
      key: 'inventoryNumber',
      title: 'Инв. №',
      width: 120,
      render: (_v: unknown, r: VehicleDto) => r.inventoryNumber ?? '—',
    },
    {
      key: 'serialNumber',
      title: 'Зав. № / VIN',
      width: 160,
      ellipsis: true,
      render: (_v: unknown, r: VehicleDto) => r.serialNumber ?? '—',
    },
    {
      key: 'manufacturerName',
      title: 'Изготовитель',
      width: 160,
      ellipsis: true,
      render: (_v: unknown, r: VehicleDto) => r.manufacturerName || '—',
    },
    {
      key: 'manufacturedOn',
      title: 'Дата вып.',
      width: 120,
      render: (_v: unknown, r: VehicleDto) => r.manufacturedOn ?? '—',
    },
    badgeColumn<VehicleDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      labels: vehicleStatusLabels,
      colors: vehicleStatusColors,
      filters: true,
      width: 150,
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
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 220 }}
        options={typeOptions}
        value={params.vehicleTypeId as string | undefined}
        onChange={(v) => setParams((p) => ({ ...p, vehicleTypeId: v, page: 1 }))}
      />
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 180 }}
        options={statusOptions}
        value={params.status}
        onChange={(v) => setParams((p) => ({ ...p, status: v, page: 1 }))}
      />
      <Input.Search
        allowClear
        placeholder="Госномер / инв. / зав. № / изготовитель"
        style={{ width: 300 }}
        onSearch={(val) => setParams((p) => ({ ...p, search: val || undefined, page: 1 }))}
      />
      <Checkbox
        checked={params.includeDeleted === 'true'}
        onChange={(e) =>
          setParams((p) => ({ ...p, includeDeleted: e.target.checked ? 'true' : undefined, page: 1 }))
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
        title={record ? 'Редактирование техники' : 'Новая единица техники'}
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
          // Смена типа сбрасывает марку/модель (модель принадлежит типу).
          onValuesChange={(changed) => {
            if ('vehicleTypeId' in changed) form.setFieldValue('vehicleModelId', undefined);
          }}
        >
          <Form.Item
            name="vehicleTypeId"
            label="Тип ТС"
            rules={[{ required: true, message: 'Выберите тип' }]}
          >
            <Select options={typeOptions} showSearch optionFilterProp="label" placeholder="Тип ТС" />
          </Form.Item>
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
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="inventoryNumber" label="Инв. № (1С)" style={{ flex: 1 }}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="serialNumber" label="Зав. № / VIN" style={{ flex: 1 }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="passportNumber" label="ПТС / ПСМ" style={{ flex: 1 }}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="manufacturedOn" label="Дата выпуска" style={{ flex: 1 }}>
              <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="manufacturerName" label="Изготовитель">
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="note" label="Примечание">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
