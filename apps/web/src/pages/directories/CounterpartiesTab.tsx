import { useState } from 'react';
import { App, Button, Checkbox, Form, Select, Space, Tag, Typography } from 'antd';
import {
  DeleteFilled,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CounterpartyDto,
  counterpartyTypeColors,
  counterpartyTypeLabels,
} from '@technic/contracts';
import { counterpartiesApi } from '../../api/resources';
import {
  CounterpartyFormFields,
  type CounterpartyFormValues,
  counterpartyCreatePayload,
  counterpartyUpdatePayload,
  typeOptions,
} from './CounterpartyFormFields';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { actionsColumn, badgeColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { objectsApi, objectKeys } from '@entities/object';

export function CounterpartiesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  // Архив справочника (ADR 0021): удалённые контрагенты видны по `archive.read`, возвращает и
  // сносит их насовсем администратор. Кнопки следуют за правом — иначе они ведут в 403.
  const { can } = useAuth();
  const canSeeArchive = can('archive.read');
  const canRestore = can('archive.restore');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    type?: string;
    isActive?: string;
    includeDeleted?: string;
  }>(
    {},
    {
      searchKeys: ['name', 'inn'],
      // Тип задаётся только селектом над таблицей: продублируй его выпадашкой столбца — и любая
      // сортировка сбрасывала бы выбранное (в onChange таблицы приходит пустой фильтр).
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: ['counterparties', params],
    queryFn: () => counterpartiesApi.list(params),
  });

  const [typeFilter, setTypeFilter] = useState('');
  const applyTypeFilter = (v: string) => {
    setTypeFilter(v);
    setParams((p) => ({ ...p, page: 1, type: v || undefined }));
  };

  // Объекты для привязки к оператору. Неактивные не отфильтровываем: заявки по ним ещё живут,
  // а привязка без наименования в форме выглядела бы как чужой идентификатор.
  const { data: objectsData } = useQuery({
    queryKey: objectKeys.options({ activeOnly: false }),
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const objectOptions = (objectsData?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<CounterpartyDto | null>(null);
  const [form] = Form.useForm<CounterpartyFormValues>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      synonyms: [],
      objectIds: [],
    } as Partial<CounterpartyFormValues>);
    setOpen(true);
  };
  const openEdit = (r: CounterpartyDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      type: r.type,
      name: r.name,
      inn: r.inn,
      synonyms: r.synonyms,
      objectIds: r.objects.map((o) => o.id),
      email: r.email,
      comment: r.comment,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CounterpartyFormValues) => {
      // Тело запроса собирает модуль полей: что показано, то и отправляется. У правки и заведения
      // оно разное — правка чужого типа не трогает заведённый адрес (см. `counterpartyUpdatePayload`).
      return record
        ? counterpartiesApi.update(record.id, counterpartyUpdatePayload(values))
        : counterpartiesApi.create(counterpartyCreatePayload(values));
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      // Привязка видна и в справочнике объектов — его список тоже устарел.
      void qc.invalidateQueries({ queryKey: objectKeys.root });
      // Деактивация арендодателя гасит его технику — список техники тоже устарел.
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => counterpartiesApi.remove(id),
    onSuccess: () => {
      message.success('Контрагент удалён');
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => counterpartiesApi.restore(id),
    onSuccess: () => {
      message.success('Контрагент восстановлен');
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — только из архива: обычное удаление здесь и так лишь помечает
  // запись удалённой.
  const purge = usePurgeAction({
    subject: 'контрагента',
    purge: counterpartiesApi.purge,
    invalidate: [['counterparties'], ['vehicles'], objectKeys.root],
  });

  const confirmDelete = (r: CounterpartyDto) =>
    modal.confirm({
      title: `Удалить контрагента «${r.name}»?`,
      content:
        r.type === 'vehicle_lessor'
          ? 'Вся техника этого арендодателя будет выключена. Заявки, где он указан, сохранятся; восстановить запись может администратор.'
          : 'Заявки и учётные записи, где он указан, сохранятся; восстановить запись может администратор.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<CounterpartyDto>({
      key: 'name',
      title: 'Наименование',
      dataIndex: 'name',
      // Синонимы — второй строкой: по ним ищут так же часто, как по основному наименованию.
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.name}</div>
          {r.synonyms.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.synonyms.join(' · ')}
            </Typography.Text>
          )}
        </div>
      ),
    }),
    textColumn<CounterpartyDto>({ key: 'inn', title: 'ИНН', dataIndex: 'inn', width: 150 }),
    badgeColumn<CounterpartyDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      labels: counterpartyTypeLabels,
      colors: counterpartyTypeColors,
      width: 210,
    }),
    textColumn<CounterpartyDto>({
      key: 'objects',
      title: 'Объекты',
      dataIndex: 'objects',
      sortable: false,
      searchable: false,
      width: 220,
      // Заполняется только у операторов; у остальных типов колонка намеренно пуста.
      render: (_v, r) => (r.objects.length === 0 ? '—' : r.objects.map((o) => o.code).join(' · ')),
    }),
    textColumn<CounterpartyDto>({
      key: 'email',
      title: 'Email',
      dataIndex: 'email',
      searchable: false,
      width: 220,
      ellipsis: true,
      // Пусто у большинства типов, и это не дефект: письма по адресу шлёт сегодня один модуль
      // (ADR 0153). Колонка нужна именно затем, чтобы видеть, у каких сервисных компаний ящик
      // ещё не заведён, — иначе про пропавшее письмо узнаёшь от подрядчика.
      render: (_v, r) => r.email || '—',
    }),
    textColumn<CounterpartyDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      searchable: false,
      ellipsis: true,
    }),
    boolBadgeColumn<CounterpartyDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<CounterpartyDto>(
      (r) =>
        r.deletedAt ? (
          <Space size={4}>
            <Tag>в архиве</Tag>
            {canRestore ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                title="Восстановить"
                onClick={() => restoreMut.mutate(r.id)}
              />
            ) : null}
            {purge.allowed ? (
              <Button
                size="small"
                danger
                icon={<DeleteFilled />}
                title="Удалить окончательно"
                loading={purge.pending}
                onClick={() => purge.confirm(r.id, r.name)}
              />
            ) : null}
          </Space>
        ) : (
          <Space size={4}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => confirmDelete(r)}
            />
          </Space>
        ),
      130,
    ),
  ];

  const filters = (
    <Space wrap>
      <Select
        style={{ width: 260 }}
        value={typeFilter}
        onChange={applyTypeFilter}
        options={[{ value: '', label: 'Все типы' }, ...typeOptions]}
      />
      {canSeeArchive ? (
        <Checkbox
          checked={params.includeDeleted === 'true'}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              includeDeleted: e.target.checked ? 'true' : undefined,
              page: 1,
            }))
          }
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'type',
      label: 'Тип контрагента',
      value: typeFilter || undefined,
      options: typeOptions,
      placeholder: 'Все типы',
      onChange: (v) => applyTypeFilter(v ?? ''),
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
    ...(canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              setParams((p) => ({ ...p, includeDeleted: checked ? 'true' : undefined, page: 1 })),
          },
        ]
      : []),
  ];

  /**
   * Карточка строки на телефоне (ADR 0042): наименование и тип — то, чем контрагента узнают,
   * дальше ИНН, объекты и комментарий. Синонимы идут рядом с наименованием: по ним ищут не реже.
   */
  const card: CardConfig<CounterpartyDto> = {
    title: (r) => r.name,
    // Архивную запись на телефоне иначе не отличить от живой: действий у неё другие, а строка
    // выглядит так же.
    badge: (r) =>
      r.deletedAt ? (
        <Tag>в архиве</Tag>
      ) : (
        <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>
      ),
    primary: (r) => (
      <Tag color={counterpartyTypeColors[r.type]}>{counterpartyTypeLabels[r.type]}</Tag>
    ),
    lines: [
      (r) => (r.synonyms.length > 0 ? r.synonyms.join(' · ') : null),
      (r) => (r.inn ? `ИНН ${r.inn}` : null),
      (r) => (r.objects.length > 0 ? `Объекты: ${r.objects.map((o) => o.code).join(' · ')}` : null),
      (r) => r.email || null,
      (r) => r.comment || null,
    ],
    onOpen: (r) => (r.deletedAt ? undefined : openEdit(r)),
    actions: (r) =>
      r.deletedAt
        ? [
            ...(canRestore
              ? [{ key: 'restore', label: 'Восстановить', onClick: () => restoreMut.mutate(r.id) }]
              : []),
            ...(purge.allowed
              ? [
                  {
                    key: 'purge',
                    label: 'Удалить окончательно',
                    danger: true,
                    onClick: () => purge.confirm(r.id, r.name),
                  },
                ]
              : []),
          ]
        : [
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
          placeholder: 'Наименование или ИНН',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { name: 'Наименование' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: {
          label: 'Добавить контрагента',
          icon: <PlusOutlined />,
          onClick: openCreate,
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить контрагента
        </Button>
      }
    >
      <DataTable<CounterpartyDto>
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
        title={record ? 'Редактирование контрагента' : 'Новый контрагент'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <CounterpartyFormFields
          form={form}
          objectOptions={objectOptions}
          onFinish={(v) => saveMut.mutate(v)}
        />
      </FormModal>
    </PageTableLayout>
  );
}
