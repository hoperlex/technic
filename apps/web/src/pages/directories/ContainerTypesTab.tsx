import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Select, Space, Switch } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTAINER_KINDS,
  containerKindColors,
  containerKindLabels,
  type ContainerTypeDto,
  type CreateContainerTypeInput,
} from '@technic/contracts';
import type { TableColumnType } from 'antd';
import { containerTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, badgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

const kindOptions = CONTAINER_KINDS.map((k) => ({ value: k, label: containerKindLabels[k] }));

export function ContainerTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, onTableChange } = useListParams<{ isActive?: string; type?: string }>(
    {},
    {
      searchKeys: ['code', 'name'],
      mapFilters: (f) => ({
        isActive: f.isActive?.[0] as string | undefined,
        type: f.type?.[0] as string | undefined,
      }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: ['container-types', params],
    queryFn: () => containerTypesApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ContainerTypeDto | null>(null);
  const [form] = Form.useForm<CreateContainerTypeInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, sortOrder: 100, type: 'cont' } as CreateContainerTypeInput);
    setOpen(true);
  };
  const openEdit = (r: ContainerTypeDto) => {
    setRecord(r);
    form.setFieldsValue(r);
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateContainerTypeInput) =>
      record ? containerTypesApi.update(record.id, values) : containerTypesApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['container-types'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаления нет: деактивация через isActive (единый принцип со справочником ТС).
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      containerTypesApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Активирован' : 'Деактивирован');
      void qc.invalidateQueries({ queryKey: ['container-types'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onToggleActive = (r: ContainerTypeDto, next: boolean) => {
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

  const activeColumn: TableColumnType<ContainerTypeDto> = {
    key: 'isActive',
    title: 'Активен',
    dataIndex: 'isActive',
    width: 120,
    sorter: true,
    filters: [
      { text: 'Да', value: 'true' },
      { text: 'Нет', value: 'false' },
    ],
    filterMultiple: false,
    render: (v: boolean, r) => (
      <Switch size="small" checked={v} loading={toggleMut.isPending} onChange={(n) => onToggleActive(r, n)} />
    ),
  };

  const columns = [
    textColumn<ContainerTypeDto>({ key: 'name', title: 'Название', dataIndex: 'name' }),
    badgeColumn<ContainerTypeDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      labels: containerKindLabels,
      colors: containerKindColors,
      filters: true,
      width: 140,
    }),
    activeColumn,
    actionsColumn<ContainerTypeDto>((r) => (
      <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
      </Space>
    )),
  ];

  return (
    <PageTableLayout
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить тип
        </Button>
      }
    >
      <DataTable<ContainerTypeDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? 'Редактирование типа' : 'Новый тип'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item name="code" label="Код" rules={[{ required: true, message: 'Укажите код' }]}>
            {/* Код — стабильный идентификатор, неизменяем после создания. */}
            <Input disabled={!!record} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Укажите название' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true, message: 'Выберите тип' }]}>
            <Select options={kindOptions} />
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
