import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Space, Switch } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableColumnType } from 'antd';
import { type CreateWasteTypeInput, type WasteTypeDto } from '@technic/contracts';
import { wasteTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { applyApiFieldErrors } from '../../utils/formErrors';
import { errorMessage } from '../../utils/format';

/** «Что вывозим» (ADR 0009): справочник, на который опирается прайс вывоза. */
export function WasteTypesTab() {
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
    queryKey: ['waste-types', params],
    queryFn: () => wasteTypesApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteTypeDto | null>(null);
  const [form] = Form.useForm<CreateWasteTypeInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, sortOrder: 100, description: '' });
    setOpen(true);
  };
  const openEdit = (r: WasteTypeDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue(r);
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: CreateWasteTypeInput) =>
      record
        ? wasteTypesApi.update(record.id, {
            name: v.name,
            description: v.description,
            sortOrder: v.sortOrder,
            isActive: v.isActive,
          })
        : wasteTypesApi.create(v),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-types'] });
      // Прайс показывает названия типов — список тарифов тоже устарел.
      void qc.invalidateQueries({ queryKey: ['waste-tariffs'] });
      setOpen(false);
    },
    onError: (e) => {
      if (!applyApiFieldErrors(form, e)) message.error(errorMessage(e));
    },
  });

  // Удаления нет: на тип ссылаются заявки и позиции прайса — выбытие через isActive.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      wasteTypesApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Активирован' : 'Деактивирован');
      void qc.invalidateQueries({ queryKey: ['waste-types'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onToggleActive = (r: WasteTypeDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать тип «${r.name}»?`,
      content: 'Тип исчезнет из выбора в заявках; заведённые заявки и тарифы останутся как есть.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  const activeColumn: TableColumnType<WasteTypeDto> = {
    key: 'isActive',
    title: 'Активен',
    dataIndex: 'isActive',
    width: 110,
    sorter: true,
    filters: [
      { text: 'Да', value: 'true' },
      { text: 'Нет', value: 'false' },
    ],
    filterMultiple: false,
    render: (v: boolean, r) => (
      <Switch
        size="small"
        checked={v}
        loading={toggleMut.isPending}
        onChange={(n) => onToggleActive(r, n)}
      />
    ),
  };

  const columns = [
    textColumn<WasteTypeDto>({ key: 'name', title: 'Название', dataIndex: 'name', width: 280 }),
    {
      key: 'description',
      title: 'Описание',
      dataIndex: 'description',
      ellipsis: true,
      render: (v: string) => v || '—',
    },
    { key: 'sortOrder', title: 'Порядок', dataIndex: 'sortOrder', width: 110, sorter: true },
    activeColumn,
    actionsColumn<WasteTypeDto>(
      (r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
        </Space>
      ),
      100,
    ),
  ];

  return (
    <PageTableLayout
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить тип мусора
        </Button>
      }
    >
      <DataTable<WasteTypeDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? 'Редактирование типа мусора' : 'Новый тип мусора'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item
            name="code"
            label="Код"
            extra="Латиница в нижнем регистре, цифры и «_» — например concrete_debris"
            rules={[{ required: true, message: 'Укажите код' }]}
          >
            {/* Код — стабильный идентификатор, неизменяем после создания. */}
            <Input disabled={!!record} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Укажите название' }]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="description" label="Описание">
            <Input.TextArea rows={2} maxLength={2000} />
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
