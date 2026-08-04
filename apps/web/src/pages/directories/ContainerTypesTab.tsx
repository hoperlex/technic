import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Space, Switch, Tag } from 'antd';
import { DeleteFilled, EditOutlined, PlusOutlined } from '@ant-design/icons';
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
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from './usePurgeAction';

const kindOptions = CONTAINER_KINDS.map((k) => ({ value: k, label: containerKindLabels[k] }));

export function ContainerTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<{
    isActive?: string;
    type?: string;
  }>(
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
    form.setFieldsValue({
      isActive: true,
      sortOrder: 100,
      type: 'cont',
    } as CreateContainerTypeInput);
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

  // Удаление насовсем (ADR 0060): деактивация оставляет тип в базе навсегда, а заведённый по
  // ошибке код убирает отсюда только администратор.
  const purge = usePurgeAction({
    subject: 'тип',
    purge: containerTypesApi.purge,
    invalidate: ['container-types'],
  });

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
      <Switch
        size="small"
        checked={v}
        loading={toggleMut.isPending}
        onChange={(n) => onToggleActive(r, n)}
      />
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
   * Карточка строки на телефоне (ADR 0042): наименование, вид контейнера и активность. Активность
   * здесь тег, а не переключатель, как в таблице: случайное касание в списке не должно выключать
   * тип из справочника — для этого есть карточка правки.
   */
  const card: CardConfig<ContainerTypeDto> = {
    title: (r) => r.name,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => containerKindLabels[r.type],
    lines: [(r) => `Код: ${r.code}`],
    onOpen: openEdit,
    actions: (r) => [
      { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
      {
        key: 'toggle',
        label: r.isActive ? 'Деактивировать' : 'Активировать',
        danger: r.isActive,
        onClick: () => onToggleActive(r, !r.isActive),
      },
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
      // На телефоне справочник читается карточками, поиск и фильтры — в панели и шите (ADR 0042).
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код или название',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: [
          {
            kind: 'select',
            key: 'type',
            label: 'Вид контейнера',
            value: params.type,
            options: kindOptions,
            placeholder: 'Любой',
            onChange: (v) => setParams((p) => ({ ...p, type: v, page: 1 })),
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
        ],
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: { label: 'Добавить тип', icon: <PlusOutlined />, onClick: openCreate },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить тип
        </Button>
      }
    >
      <DataTable<ContainerTypeDto>
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
            <AutoSelect options={kindOptions} />
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
