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
  type TableColumnType,
} from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateVehicleTypeInput,
  UpdateVehicleTypeInput,
  VehicleTypeDto,
} from '@technic/contracts';
import { vehicleKindsApi, vehicleTypesApi } from '../../api/resources';
import { DataTable, type TableChange } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
import { errorMessage } from '../../utils/format';

interface VtParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  kindId?: string;
  isActive?: string;
  // объект параметров пригоден как query для apiFetch
  [key: string]: unknown;
}

interface VtFormValues {
  kindId?: string;
  code?: string;
  name?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

// Плоский справочник типов ТС (ADR 0005): один уровень, без подтипов/иерархии.
export function VehicleTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const [params, setParams] = useState<VtParams>({
    page: 1,
    pageSize: 50,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<VtParams>) => setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-types', params],
    queryFn: () => vehicleTypesApi.list(params),
  });

  const { data: kindsData } = useQuery({
    queryKey: ['vehicle-kinds'],
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const kindOptions = (kindsData?.items ?? []).map((k) => ({ value: k.id, label: k.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleTypeDto | null>(null);
  const [form] = Form.useForm<VtFormValues>();
  const isEdit = !!record;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ sortOrder: 100, isActive: true });
    setOpen(true);
  };
  const openEdit = (r: VehicleTypeDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      kindId: r.kindId,
      code: r.code,
      name: r.name,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (
      arg: { create: CreateVehicleTypeInput } | { id: string; body: UpdateVehicleTypeInput },
    ) =>
      'create' in arg
        ? vehicleTypesApi.create(arg.create)
        : vehicleTypesApi.update(arg.id, arg.body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: VtFormValues) => {
    if (isEdit) {
      const body: UpdateVehicleTypeInput = {
        name: v.name,
        description: v.description ?? '',
        sortOrder: v.sortOrder,
        isActive: v.isActive,
      };
      saveMut.mutate({ id: record!.id, body });
      return;
    }
    const create: CreateVehicleTypeInput = {
      kindId: v.kindId!,
      code: v.code!,
      name: v.name!,
      description: v.description ?? '',
      sortOrder: v.sortOrder ?? 100,
      isActive: v.isActive ?? true,
    };
    saveMut.mutate({ create });
  };

  // Активация/деактивация — инлайн; деактивация с подтверждением.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleTypesApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Тип активирован' : 'Тип деактивирован');
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const onToggleActive = (r: VehicleTypeDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать тип «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  const onTableChange = (c: TableChange) =>
    setParams((p) => ({ ...p, page: c.page, pageSize: c.pageSize }));

  // Колонки: Вид → Тип → Активен → Действия.
  const columns: TableColumnType<VehicleTypeDto>[] = [
    textColumn<VehicleTypeDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      sortable: false,
      searchable: false,
      width: 200,
    }),
    textColumn<VehicleTypeDto>({
      key: 'name',
      title: 'Тип',
      dataIndex: 'name',
      sortable: false,
      searchable: false,
    }),
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      render: (v: boolean, r) => (
        <Switch
          size="small"
          checked={v}
          loading={toggleMut.isPending}
          onChange={(n) => onToggleActive(r, n)}
        />
      ),
    },
    actionsColumn<VehicleTypeDto>((r) => (
      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
    )),
  ];

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код/название)"
        style={{ width: 220 }}
        value={params.search}
        onChange={(e) => patchParams({ search: e.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Вид"
        style={{ width: 200 }}
        options={kindOptions}
        value={params.kindId}
        onChange={(v) => patchParams({ kindId: v })}
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

  const codeRules = isEdit
    ? []
    : [
        { required: true, message: 'Укажите код' },
        {
          pattern: CODE_PATTERN,
          message: 'Только строчные латинские, цифры и _, первый символ — буква',
        },
      ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
      }
    >
      <DataTable<VehicleTypeDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={isEdit ? 'Редактирование типа' : 'Новый тип ТС'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          {isEdit ? (
            <Form.Item label="Вид">
              <Input value={record!.kindName} disabled />
            </Form.Item>
          ) : (
            <Form.Item
              name="kindId"
              label="Вид"
              rules={[{ required: true, message: 'Выберите вид' }]}
            >
              <Select options={kindOptions} placeholder="Выберите вид" />
            </Form.Item>
          )}

          <Form.Item name="code" label="Код" rules={codeRules}>
            {/* Код — стабильный системный идентификатор, неизменяем после создания. */}
            <Input disabled={isEdit} placeholder="например truck_cranes" />
          </Form.Item>

          <Form.Item
            name="name"
            label="Наименование типа"
            rules={[{ required: true, message: 'Укажите наименование' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item name="description" label="Описание">
            <Input.TextArea rows={2} />
          </Form.Item>

          <Form.Item name="sortOrder" label="Порядок сортировки">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>

          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
