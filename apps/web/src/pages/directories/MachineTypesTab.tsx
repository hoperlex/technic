import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Space, Switch } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMachineTypeInput, MachineTypeDto } from '@technic/contracts';
import { machineTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, boolBadgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

export function MachineTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, onTableChange } = useListParams<{ isActive?: string }>(
    {},
    {
      searchKeys: ['code', 'name'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: ['machine-types', params],
    queryFn: () => machineTypesApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<MachineTypeDto | null>(null);
  const [form] = Form.useForm<CreateMachineTypeInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, sortOrder: 100 } as CreateMachineTypeInput);
    setOpen(true);
  };
  const openEdit = (r: MachineTypeDto) => {
    setRecord(r);
    form.setFieldsValue(r);
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateMachineTypeInput) =>
      record ? machineTypesApi.update(record.id, values) : machineTypesApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['machine-types'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => machineTypesApi.remove(id),
    onSuccess: () => {
      message.success('Тип деактивирован');
      void qc.invalidateQueries({ queryKey: ['machine-types'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (r: MachineTypeDto) =>
    modal.confirm({
      title: `Деактивировать тип «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<MachineTypeDto>({ key: 'code', title: 'Код', dataIndex: 'code', width: 200 }),
    textColumn<MachineTypeDto>({ key: 'name', title: 'Название', dataIndex: 'name' }),
    textColumn<MachineTypeDto>({
      key: 'sortOrder',
      title: 'Порядок',
      dataIndex: 'sortOrder',
      searchable: false,
      width: 120,
    }),
    boolBadgeColumn<MachineTypeDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<MachineTypeDto>((r) => (
      <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(r)} />
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
      <DataTable<MachineTypeDto>
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
            <Input />
          </Form.Item>
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Укажите название' }]}
          >
            <Input />
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
