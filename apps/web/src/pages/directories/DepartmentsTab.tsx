import { useState } from 'react';
import { App, Button, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDepartmentInput, DepartmentDto } from '@technic/contracts';
import { departmentsApi, usersApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from './usePurgeAction';

/**
 * Справочник отделов (ADR 0040) — офисные подразделения. Устроен как справочник объектов: тот же
 * набор действий, то же удаление деактивацией.
 *
 * Руководители отдела не хранятся в карточке, а выводятся из учёток с ролью «Руководитель
 * отдела»: это привязка учётки к отделу, показанная со стороны справочника. Правится с обеих
 * сторон — здесь и в карточке учётки, — поэтому после сохранения список учёток тоже устаревает.
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
    queryKey: ['departments', params],
    queryFn: () => departmentsApi.list(params),
  });

  // Кандидаты в руководители — только учётки с этой ролью: привязать сюда сотрудника отдела или
  // штаб сервер всё равно не даст, и предлагать их значило бы обещать несуществующий выбор.
  const { data: headsData, isFetching: headsLoading } = useQuery({
    queryKey: ['users', 'department-heads'],
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: 500,
        role: 'department_head',
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const headOptions = (headsData?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<DepartmentDto | null>(null);
  const [form] = Form.useForm<CreateDepartmentInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, headUserIds: [] } as Partial<CreateDepartmentInput>);
    setOpen(true);
  };
  const openEdit = (r: DepartmentDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      code: r.code,
      name: r.name,
      isActive: r.isActive,
      headUserIds: r.heads.map((h) => h.id),
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateDepartmentInput) =>
      record ? departmentsApi.update(record.id, values) : departmentsApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['departments'] });
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
      void qc.invalidateQueries({ queryKey: ['departments'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — только администратору и только на деактивированной строке.
  const purge = usePurgeAction({
    subject: 'отдел',
    purge: departmentsApi.purge,
    invalidate: ['departments'],
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
          <Form.Item
            name="headUserIds"
            label="Руководители"
            tooltip="Учётки с ролью «Руководитель отдела»: они визируют заявки отдела"
            extra="Смена набора закрывает открытые сессии этих учёток — у них меняется область"
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
