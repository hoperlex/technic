import { useState } from 'react';
import { App, Button, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateObjectInput, ObjectDto } from '@technic/contracts';
import { counterpartiesApi } from '../../api/resources';
import { AddressAutoComplete } from '@entities/address';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from './usePurgeAction';
import { objectsApi, objectKeys } from '@entities/object';

export function ObjectsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<{ isActive?: string }>(
    {},
    {
      searchKeys: ['code', 'name', 'address'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: objectKeys.list(params),
    queryFn: () => objectsApi.list(params),
  });

  // Операторы вывоза для привязки (ADR 0010). Неактивных из списка не убираем: привязка
  // описывает сотрудничество с объектом, а не готовность взять заявку прямо сейчас, — иначе
  // уже заведённая привязка осталась бы в форме без наименования.
  const { data: operatorsData } = useQuery({
    queryKey: ['counterparties', 'operators-for-objects'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const operatorOptions = (operatorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ObjectDto | null>(null);
  const [form] = Form.useForm<CreateObjectInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, operatorIds: [] } as Partial<CreateObjectInput>);
    setOpen(true);
  };
  const openEdit = (r: ObjectDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      code: r.code,
      name: r.name,
      address: r.address,
      isActive: r.isActive,
      operatorIds: r.operators.map((o) => o.id),
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateObjectInput) =>
      record ? objectsApi.update(record.id, values) : objectsApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: objectKeys.root });
      // Та же привязка видна в карточке контрагента — его список тоже устарел.
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => objectsApi.remove(id),
    onSuccess: () => {
      message.success('Объект деактивирован');
      void qc.invalidateQueries({ queryKey: objectKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — только администратору и только на деактивированной строке.
  const purge = usePurgeAction({
    subject: 'объект',
    purge: objectsApi.purge,
    invalidate: [objectKeys.root],
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
    textColumn<ObjectDto>({
      key: 'operators',
      title: 'Операторы вывоза',
      dataIndex: 'operators',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) =>
        r.operators.length === 0 ? (
          // Пустой список — не ошибка: он просто не сужает выбор исполнителя в заявке.
          <Typography.Text type="secondary">Все</Typography.Text>
        ) : (
          r.operators.map((o) => o.name).join(' · ')
        ),
    }),
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
        {!r.isActive && purge.allowed && (
          <Button
            size="small"
            danger
            icon={<DeleteFilled />}
            title="Удалить окончательно"
            loading={purge.pending}
            onClick={() => purge.confirm(r.id, r.name)}
          />
        )}
      </Space>
    )),
  ];

  /**
   * Карточка строки на телефоне (ADR 0042). Заголовок — код объекта: им объект и называют между
   * собой, а полное наименование идёт следующей строкой.
   */
  const card: CardConfig<ObjectDto> = {
    title: (r) => r.code,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.name,
    lines: [
      (r) => r.address || null,
      (r) =>
        r.operators.length > 0
          ? `Операторы: ${r.operators.map((o) => o.name).join(' · ')}`
          : 'Операторы: все',
    ],
    onOpen: openEdit,
    actions: (r) => [
      { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
      { key: 'delete', label: 'Деактивировать', danger: true, onClick: () => confirmDelete(r) },
      ...(!r.isActive && purge.allowed
        ? [
            {
              key: 'purge',
              label: 'Удалить окончательно',
              danger: true,
              onClick: () => purge.confirm(r.id, r.name),
            },
          ]
        : []),
    ],
  };

  return (
    <PageTableLayout
      // На телефоне справочник читается карточками, а поиск, фильтр и сортировка живут в панели
      // и шитах (ADR 0042): в заголовках столбцов до них не дотянуться пальцем.
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код, название, адрес',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: [
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
            onChange: (v) => setParams((p) => ({ ...p, isActive: v, page: 1 })),
          },
        ],
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: { label: 'Добавить объект', icon: <PlusOutlined />, onClick: openCreate },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить объект
        </Button>
      }
    >
      <DataTable<ObjectDto>
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
            <AddressAutoComplete placeholder="Начните вводить адрес" maxLength={500} />
          </Form.Item>
          <Form.Item
            name="operatorIds"
            label="Операторы вывоза"
            tooltip="Контрагенты, которые вывозят мусор с объекта; из них выбирается исполнитель заявки"
            extra="Пусто — в заявке доступны все операторы"
          >
            <Select
              mode="multiple"
              options={operatorOptions}
              showSearch
              optionFilterProp="label"
              placeholder="Не ограничивать"
            />
          </Form.Item>
          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
