import { useState } from 'react';
import { App, Button, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWarehouseInput, WarehouseDto } from '@technic/contracts';
import { counterpartiesApi } from '../../api/resources';
import { AddressAutoComplete } from '@entities/address';
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { warehousesApi, warehouseKeys } from '@entities/warehouse';

/**
 * Справочник складов поставщиков (ADR 0051). Склад — адрес, по которому работают с поставщиком,
 * поэтому строка списка отвечает двумя полями: чей склад и где он.
 *
 * Метка склада (`name`) в таблицу столбцом не выведена намеренно: заполняют её не всегда, а
 * место она отнимала бы у адреса, ради которого справочник и заведён. В форме и в карточке на
 * телефоне метка есть.
 */
export function WarehousesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<{
    supplierId?: string;
    isActive?: string;
  }>(
    {},
    {
      // Поиск живёт в заголовке «Адреса» — единственного столбца с поисковой выпадашкой;
      // поставщика отбирает селект над таблицей, и второй способ спрашивать о нём не нужен.
      searchKeys: ['address'],
      // Поставщик задаётся только селектом над таблицей — выпадашка в столбце сбрасывала бы
      // выбранное при любой сортировке (в onChange таблицы приходит пустой фильтр).
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: warehouseKeys.list(params),
    queryFn: () => warehousesApi.list(params),
  });

  // Поставщики — и для фильтра, и для формы. Неактивных из списка не убираем: склад у них
  // заведён, и в форме привязка осталась бы без наименования — та же оговорка, что у объектов.
  const { data: suppliersData } = useQuery({
    queryKey: ['counterparties', 'suppliers'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'supplier',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const supplierOptions = (suppliersData?.items ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));

  const applySupplierFilter = (v: string) =>
    setParams((p) => ({ ...p, page: 1, supplierId: v || undefined }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WarehouseDto | null>(null);
  const [form] = Form.useForm<CreateWarehouseInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      // Фильтр по поставщику — он же ответ на «чей склад заводим»: справочник наполняют
      // поставщик за поставщиком.
      supplierId: params.supplierId,
    } as Partial<CreateWarehouseInput>);
    setOpen(true);
  };
  const openEdit = (r: WarehouseDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      supplierId: r.supplier.id,
      address: r.address,
      name: r.name,
      contactPerson: r.contactPerson,
      contactPhone: r.contactPhone,
      comment: r.comment,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateWarehouseInput) =>
      record ? warehousesApi.update(record.id, values) : warehousesApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: warehouseKeys.root });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => warehousesApi.remove(id),
    onSuccess: () => {
      message.success('Склад удалён');
      void qc.invalidateQueries({ queryKey: warehouseKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление здесь настоящее (ADR 0051): предупреждаем, что вернуть строку будет нечем.
  const confirmDelete = (r: WarehouseDto) =>
    modal.confirm({
      title: `Удалить склад «${r.address}»?`,
      content:
        'Запись удаляется насовсем. Чтобы временно не пользоваться складом, снимите «Активен».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<WarehouseDto>({
      key: 'supplier',
      title: 'Поставщик',
      dataIndex: 'supplier',
      searchable: false,
      width: 280,
      render: (_v, r) => (
        <>
          {r.supplier.name}
          {/* Склад активен, а поставщик — нет: строка обязана объяснить, почему им не пользуются. */}
          {!r.supplier.isActive && (
            <>
              {' '}
              <Tag>Неактивен</Tag>
            </>
          )}
        </>
      ),
    }),
    textColumn<WarehouseDto>({ key: 'address', title: 'Адрес', dataIndex: 'address' }),
    textColumn<WarehouseDto>({
      key: 'contactPerson',
      title: 'Контактное лицо',
      dataIndex: 'contactPerson',
      sortable: false,
      searchable: false,
      width: 220,
      // ФИО и телефон читают вместе — это одна графа в две строки, а не два столбца.
      render: (_v, r) =>
        r.contactPerson || r.contactPhone ? (
          <>
            {r.contactPerson}
            {r.contactPhone && (
              <>
                {r.contactPerson && <br />}
                <Typography.Text type="secondary">{r.contactPhone}</Typography.Text>
              </>
            )}
          </>
        ) : null,
    }),
    textColumn<WarehouseDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      sortable: false,
      searchable: false,
      ellipsis: true,
    }),
    boolBadgeColumn<WarehouseDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<WarehouseDto>((r) => (
      <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(r)} />
      </Space>
    )),
  ];

  const filters = (
    <Select
      style={{ width: 280 }}
      value={params.supplierId ?? ''}
      onChange={applySupplierFilter}
      showSearch
      optionFilterProp="label"
      options={[{ value: '', label: 'Все поставщики' }, ...supplierOptions]}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'supplierId',
      label: 'Поставщик',
      value: params.supplierId,
      options: supplierOptions,
      placeholder: 'Все поставщики',
      onChange: (v) => applySupplierFilter(v ?? ''),
    },
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
  ];

  /**
   * Карточка строки на телефоне (ADR 0042). Заголовок — адрес: им склад и называют, а поставщик
   * идёт следующей строкой — по нему список чаще отфильтрован, чем прочитан.
   */
  const card: CardConfig<WarehouseDto> = {
    title: (r) => r.address,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.supplier.name,
    lines: [
      (r) => r.name || null,
      (r) => [r.contactPerson, r.contactPhone].filter(Boolean).join(' · ') || null,
      (r) => r.comment || null,
    ],
    onOpen: openEdit,
    actions: (r) => [
      { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
      { key: 'delete', label: 'Удалить', danger: true, onClick: () => confirmDelete(r) },
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Адрес, метка, поставщик',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: { label: 'Добавить склад', icon: <PlusOutlined />, onClick: openCreate },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить склад
        </Button>
      }
    >
      <DataTable<WarehouseDto>
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
        title={record ? 'Редактирование склада' : 'Новый склад'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item
            name="supplierId"
            label="Поставщик"
            rules={[{ required: true, message: 'Выберите поставщика' }]}
            extra="Список — контрагенты типа «Поставщик»"
          >
            <AutoSelect options={supplierOptions} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item
            name="address"
            label="Адрес"
            rules={[{ required: true, message: 'Укажите адрес склада' }]}
          >
            <AddressAutoComplete placeholder="Начните вводить адрес" maxLength={500} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Метка"
            tooltip="Как склад называют между собой: «Основной», «Склад №2». Необязательна — узнают склад по адресу"
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="contactPerson" label="Контактное лицо">
            <Input maxLength={200} placeholder="Кто принимает машину" />
          </Form.Item>
          <Form.Item name="contactPhone" label="Телефон">
            <Input maxLength={50} placeholder="+7 (___) ___-__-__" />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
