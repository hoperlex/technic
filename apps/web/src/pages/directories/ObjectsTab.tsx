import { useState } from 'react';
import { App, Button, Form, Input, Space, Switch } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateObjectInput, ObjectDto } from '@technic/contracts';
import { objectsApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, boolBadgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

export function ObjectsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, onTableChange } = useListParams<{ isActive?: string }>(
    {},
    {
      searchKeys: ['code', 'name', 'address'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: ['objects', params],
    queryFn: () => objectsApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ObjectDto | null>(null);
  const [form] = Form.useForm<CreateObjectInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true } as CreateObjectInput);
    setOpen(true);
  };
  const openEdit = (r: ObjectDto) => {
    setRecord(r);
    form.setFieldsValue(r);
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateObjectInput) =>
      record ? objectsApi.update(record.id, values) : objectsApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['objects'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => objectsApi.remove(id),
    onSuccess: () => {
      message.success('Объект деактивирован');
      void qc.invalidateQueries({ queryKey: ['objects'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (r: ObjectDto) =>
    modal.confirm({
      title: `Деактивировать объект «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<ObjectDto>({ key: 'code', title: 'Код', dataIndex: 'code', width: 160 }),
    textColumn<ObjectDto>({ key: 'name', title: 'Название', dataIndex: 'name' }),
    textColumn<ObjectDto>({ key: 'address', title: 'Адрес', dataIndex: 'address', ellipsis: true }),
    boolBadgeColumn<ObjectDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<ObjectDto>((r) => (
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
          Добавить объект
        </Button>
      }
    >
      <DataTable<ObjectDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? 'Редактирование объекта' : 'Новый объект'}
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
          <Form.Item name="address" label="Адрес">
            <Input />
          </Form.Item>
          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
