import { useState } from 'react';
import { App, Button, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDepartmentInput, DepartmentDto } from '@technic/contracts';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { departmentsApi, departmentKeys } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import { useDepartmentHeadOptions } from './departmentHeadOptions';

/**
 * Справочник отделов (ADR 0040) — офисные подразделения. Устроен как справочник объектов: тот же
 * набор действий, то же удаление деактивацией.
 *
 * Руководители отдела не хранятся в карточке, а лежат признаком на привязке учётки к отделу
 * (`user_departments.is_head`, миграция 0149) — той же самой, что задаёт область видимости, только
 * показанной со стороны справочника. Роль «Руководитель отдела» руководителем больше не делает и
 * не требуется (§11.1 плана реструктуризации прав): признак ставится **только отсюда**, а карточка
 * учётки задаёт участие в отделе. Привязка общая, поэтому после сохранения список учёток тоже
 * устаревает.
 */
export function DepartmentsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<{ isActive?: string }>(
    {},
    {
      searchKeys: ['code', 'name'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: departmentKeys.list(params),
    queryFn: () => departmentsApi.list(params),
  });

  // Площадка отдела (ADR 0062). Неактивные объекты в списке есть: привязка описывает зону
  // ответственности, а не готовность принимать заявки — закрытую площадку отдел ещё доубирает.
  const { data: objectOptions = [], isFetching: objectsLoading } = useQuery(
    objectOptionsQuery({ activeOnly: false }),
  );

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<DepartmentDto | null>(null);
  const [form] = Form.useForm<CreateDepartmentInput>();

  // Кандидаты в руководители — учётки на отдельской оси, а не учётки одной роли: чем именно
  // сузился список и почему не «все живые», разобрано в `useDepartmentHeadOptions`.
  const { options: headOptions, loading: headsLoading } = useDepartmentHeadOptions(
    record?.heads ?? [],
  );

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      constructionObjectId: null,
      headUserIds: [],
    } as Partial<CreateDepartmentInput>);
    setOpen(true);
  };
  const openEdit = (r: DepartmentDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      code: r.code,
      name: r.name,
      isActive: r.isActive,
      // `null`, а не `undefined`: отсутствие поля сервер читает как «не трогать площадку», и
      // снять её из формы стало бы нечем (ADR 0062).
      constructionObjectId: r.object?.id ?? null,
      headUserIds: r.heads.map((h) => h.id),
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateDepartmentInput) =>
      record ? departmentsApi.update(record.id, values) : departmentsApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: departmentKeys.root });
      // Та же привязка видна в карточке учётки — список пользователей тоже устарел.
      void qc.invalidateQueries({ queryKey: ['users'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => departmentsApi.remove(id),
    onSuccess: () => {
      message.success('Отдел деактивирован');
      void qc.invalidateQueries({ queryKey: departmentKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — только администратору и только на деактивированной строке.
  const purge = usePurgeAction({
    subject: 'отдел',
    purge: departmentsApi.purge,
    invalidate: [departmentKeys.root],
  });

  const confirmDelete = (r: DepartmentDto) =>
    modal.confirm({
      title: `Деактивировать отдел «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<DepartmentDto>({ key: 'code', title: 'Код', dataIndex: 'code', width: 160 }),
    textColumn<DepartmentDto>({ key: 'name', title: 'Название', dataIndex: 'name' }),
    textColumn<DepartmentDto>({
      key: 'object',
      title: 'Площадка',
      dataIndex: 'object',
      sortable: false,
      searchable: false,
      width: 220,
      // Пусто — рабочее состояние, а не пропуск: у ПТО и АХО площадки нет, и вывоз мусора им
      // закрыт именно поэтому (ADR 0062).
      render: (_v, r) =>
        r.object ? (
          `${r.object.code} — ${r.object.name}`
        ) : (
          <Typography.Text type="secondary">Нет</Typography.Text>
        ),
    }),
    textColumn<DepartmentDto>({
      key: 'heads',
      title: 'Руководители',
      dataIndex: 'heads',
      sortable: false,
      searchable: false,
      width: 280,
      render: (_v, r) =>
        r.heads.length === 0 ? (
          // Пустой список — не ошибка, но и не рабочее состояние: визировать заявки отдела
          // некому, пока руководитель не назначен.
          <Typography.Text type="secondary">Не назначены</Typography.Text>
        ) : (
          r.heads.map((h) => h.fullName).join(' · ')
        ),
    }),
    boolBadgeColumn<DepartmentDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<DepartmentDto>((r) => (
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
   * Карточка отдела на телефоне (ADR 0042): код и наименование — то, чем отдел называют, дальше
   * руководители: пока их нет, визировать заявки отдела некому, и это видно сразу.
   */
  const card: CardConfig<DepartmentDto> = {
    title: (r) => r.code,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.name,
    lines: [
      (r) => (r.object ? `Площадка: ${r.object.code} — ${r.object.name}` : 'Площадки нет'),
      (r) =>
        r.heads.length > 0
          ? `Руководители: ${r.heads.map((h) => h.fullName).join(' · ')}`
          : 'Руководители не назначены',
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
      // На телефоне справочник читается карточками, поиск и фильтр — в панели и шите (ADR 0042).
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код или название',
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
        primaryAction: { label: 'Добавить отдел', icon: <PlusOutlined />, onClick: openCreate },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить отдел
        </Button>
      }
    >
      <DataTable<DepartmentDto>
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
        title={record ? 'Редактирование отдела' : 'Новый отдел'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={480}
      >
        {/* Очистка Select даёт `undefined`, а сервер читает отсутствие поля как «площадку не
            трогать» (ADR 0062): без этого снять её из формы было бы нечем. */}
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) =>
            saveMut.mutate({ ...v, constructionObjectId: v.constructionObjectId ?? null })
          }
        >
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
          <Form.Item
            name="constructionObjectId"
            label="Площадка"
            tooltip="Объект, на котором работает отдел: его сотрудники ведут вывоз мусора с этой площадки наравне со штабом"
            extra="Смена площадки закрывает открытые сессии всех учёток отдела — у них меняется область"
          >
            <Select
              options={objectOptions}
              loading={objectsLoading}
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="Нет — отдел без площадки"
            />
          </Form.Item>
          <Form.Item
            name="headUserIds"
            label="Руководители"
            tooltip="Кто здесь главный: они визируют заявки отдела. Признак ставится этим полем и только им — роль «Руководитель отдела» сама по себе руководителем не делает"
            extra="Назначенный войдёт в отдел, снятый — выйдет из него. Смена набора закрывает открытые сессии этих учёток: у них меняется область"
          >
            <Select
              mode="multiple"
              options={headOptions}
              loading={headsLoading}
              showSearch
              optionFilterProp="label"
              placeholder="Не назначены"
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
