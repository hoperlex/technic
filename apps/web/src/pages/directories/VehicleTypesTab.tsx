import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
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
  sortOrder: 'asc' | 'desc';
  sortBy?: string;
  view: 'hierarchy';
  search?: string;
  kindId?: string;
  level?: 'type' | 'subtype';
  isActive?: string;
  // объект параметров пригоден как query для apiFetch
  [key: string]: unknown;
}

interface VtFormValues {
  level: 'type' | 'subtype';
  kindId?: string;
  parentId?: string;
  code?: string;
  name?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export function VehicleTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  // Иерархический режим: родитель и его подтипы идут подряд, весь справочник на одной странице.
  const [params, setParams] = useState<VtParams>({
    page: 1,
    pageSize: 500,
    sortOrder: 'asc',
    view: 'hierarchy',
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
  const watchLevel = Form.useWatch('level', form);
  const watchKindId = Form.useWatch('kindId', form);
  const level: 'type' | 'subtype' = isEdit ? record!.level : (watchLevel ?? 'type');

  // Родительские типы для формы подтипа — только выбранного вида (kindId — фильтр формы).
  const { data: parentsData, isFetching: parentsFetching } = useQuery({
    queryKey: ['vehicle-types', 'parents', watchKindId],
    queryFn: () =>
      vehicleTypesApi.list({
        level: 'type',
        kindId: watchKindId,
        view: 'list',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !isEdit && level === 'subtype' && !!watchKindId,
  });
  const parentOptions = (parentsData?.items ?? []).map((t) => ({ value: t.id, label: t.name }));

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ level: 'type', sortOrder: 100, isActive: true });
    setOpen(true);
  };
  const openEdit = (r: VehicleTypeDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      level: r.level,
      kindId: r.kindId,
      parentId: r.parentId ?? undefined,
      code: r.code,
      name: r.name,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (arg: { create: CreateVehicleTypeInput } | { id: string; body: UpdateVehicleTypeInput }) =>
      'create' in arg ? vehicleTypesApi.create(arg.create) : vehicleTypesApi.update(arg.id, arg.body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: VtFormValues) => {
    if (isEdit) {
      const body: UpdateVehicleTypeInput =
        record!.level === 'type'
          ? { name: v.name, description: v.description ?? '', sortOrder: v.sortOrder }
          : {
              name: v.name,
              description: v.description ?? '',
              sortOrder: v.sortOrder,
              isActive: v.isActive,
            };
      saveMut.mutate({ id: record!.id, body });
      return;
    }
    const create: CreateVehicleTypeInput =
      v.level === 'type'
        ? {
            level: 'type',
            kindId: v.kindId!,
            code: v.code!,
            name: v.name!,
            description: v.description ?? '',
            sortOrder: v.sortOrder ?? 100,
          }
        : {
            level: 'subtype',
            parentId: v.parentId!,
            code: v.code!,
            name: v.name!,
            description: v.description ?? '',
            sortOrder: v.sortOrder ?? 100,
            isActive: v.isActive ?? true,
          };
    saveMut.mutate({ create });
  };

  // Активация/деактивация подтипа — инлайн (§20). Деактивация — с подтверждением.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleTypesApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Подтип активирован' : 'Подтип деактивирован');
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
      title: `Деактивировать подтип «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  const onTableChange = (c: TableChange) =>
    setParams((p) => ({ ...p, page: c.page, pageSize: c.pageSize }));

  // Колонки строго: Вид → Тип → Подтип → Активен → Действия (§17).
  const activeColumn: TableColumnType<VehicleTypeDto> = {
    key: 'isActive',
    title: 'Активен',
    dataIndex: 'isActive',
    width: 110,
    render: (v: boolean, r) =>
      r.level === 'subtype' ? (
        <Switch size="small" checked={v} loading={toggleMut.isPending} onChange={(n) => onToggleActive(r, n)} />
      ) : (
        <Tag color={v ? 'green' : 'default'}>{v ? 'Да' : 'Нет'}</Tag>
      ),
  };

  const columns: TableColumnType<VehicleTypeDto>[] = [
    textColumn<VehicleTypeDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      sortable: false,
      searchable: false,
      width: 160,
    }),
    textColumn<VehicleTypeDto>({
      key: 'typeName',
      title: 'Тип',
      dataIndex: 'name',
      sortable: false,
      searchable: false,
      render: (_v, r) => (r.level === 'type' ? r.name : (r.parentName ?? '—')),
    }),
    textColumn<VehicleTypeDto>({
      key: 'subtypeName',
      title: 'Подтип',
      dataIndex: 'name',
      sortable: false,
      searchable: false,
      render: (_v, r) => (r.level === 'type' ? '—' : r.name),
    }),
    activeColumn,
    actionsColumn<VehicleTypeDto>((r) => (
      <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
      </Space>
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
        style={{ width: 180 }}
        options={kindOptions}
        value={params.kindId}
        onChange={(v) => patchParams({ kindId: v })}
      />
      <Select
        allowClear
        placeholder="Уровень"
        style={{ width: 140 }}
        options={[
          { value: 'type', label: 'Тип' },
          { value: 'subtype', label: 'Подтип' },
        ]}
        value={params.level}
        onChange={(v) => patchParams({ level: v })}
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
        title={
          isEdit
            ? record!.level === 'type'
              ? 'Редактирование типа'
              : 'Редактирование подтипа'
            : 'Новая запись'
        }
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          {!isEdit && (
            <Form.Item name="level" label="Уровень" rules={[{ required: true }]}>
              <Radio.Group onChange={() => form.setFieldValue('parentId', undefined)}>
                <Radio value="type">Тип</Radio>
                <Radio value="subtype">Подтип</Radio>
              </Radio.Group>
            </Form.Item>
          )}

          {isEdit ? (
            <Form.Item label="Вид">
              <Input value={record!.kindName} disabled />
            </Form.Item>
          ) : (
            <Form.Item name="kindId" label="Вид" rules={[{ required: true, message: 'Выберите вид' }]}>
              <Select
                options={kindOptions}
                placeholder="Выберите вид"
                onChange={() => form.setFieldValue('parentId', undefined)}
              />
            </Form.Item>
          )}

          {level === 'subtype' &&
            (isEdit ? (
              <Form.Item label="Родительский тип">
                <Input value={record!.parentName ?? ''} disabled />
              </Form.Item>
            ) : (
              <Form.Item
                name="parentId"
                label="Родительский тип"
                rules={[{ required: true, message: 'Выберите тип' }]}
              >
                <Select
                  options={parentOptions}
                  disabled={!watchKindId}
                  loading={parentsFetching}
                  placeholder={watchKindId ? 'Выберите тип' : 'Сначала выберите вид'}
                  notFoundContent={watchKindId ? 'Нет типов для вида' : null}
                />
              </Form.Item>
            ))}

          <Form.Item name="code" label="Код" rules={codeRules}>
            {/* Код — стабильный системный идентификатор, неизменяем после создания. */}
            <Input disabled={isEdit} placeholder="например truck_crane" />
          </Form.Item>

          <Form.Item
            name="name"
            label={level === 'type' ? 'Наименование типа' : 'Наименование подтипа'}
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

          {level === 'subtype' && (
            <Form.Item name="isActive" label="Активен" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
