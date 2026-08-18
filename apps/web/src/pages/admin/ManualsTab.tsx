import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Space, Switch, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateManualInput, ManualDto } from '@technic/contracts';
import { manualKeys, manualsApi } from '@entities/manual';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { RowActionButton, actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';

/**
 * Ведение руководств пользователя (`docs/manuals-plan.md`): список ссылок на документы во внешнем
 * хранилище, который показывает окно служебного меню. Вкладка закрыта правом `manuals.manage` —
 * тем же, которым закрыты запись и просмотр снятых с публикации строк (ADR 0021).
 *
 * API берётся прямо из `@entities/manual`, минуя `src/api/resources.ts`: тот файл занимает весь
 * свой бюджет строк и значится подлежащим разрезанию — реэкспорт ради одной вкладки продлил бы
 * ему жизнь (план §3.5).
 */
export function ManualsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<{
    isActive?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>(
    // Список открывается в том же порядке, в каком его увидят в окне: вкладку открывают, чтобы
    // расставить руководства, и «первое сверху» здесь — рабочее состояние, а не сортировка по
    // умолчанию от нечего делать.
    { sortBy: 'sortOrder', sortOrder: 'asc' },
    {
      searchKeys: ['title'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: manualKeys.list(params),
    queryFn: () => manualsApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ManualDto | null>(null);
  const [form] = Form.useForm<CreateManualInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    // Те же умолчания, что в контракте и в базе: заведённое без раздумий руководство встаёт в
    // общий ряд и сразу показывается — заводят их затем, чтобы ими пользовались.
    form.setFieldsValue({ sortOrder: 100, isActive: true } as CreateManualInput);
    setOpen(true);
  };
  const openEdit = (r: ManualDto) => {
    setRecord(r);
    form.setFieldsValue(r);
    setOpen(true);
  };

  /**
   * Гасится корень сущности, а не `list(params)`: у окна свой ключ (план §3.3), и без корня
   * администратор, снявший руководство с публикации, продолжал бы видеть его в собственном окне
   * до перезагрузки вкладки.
   */
  const invalidateAll = () => void qc.invalidateQueries({ queryKey: manualKeys.root });

  const saveMut = useMutation({
    mutationFn: (values: CreateManualInput) =>
      record ? manualsApi.update(record.id, values) : manualsApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      invalidateAll();
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => manualsApi.remove(id),
    onSuccess: () => {
      message.success('Руководство удалено');
      invalidateAll();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Удаление настоящее и без второго шага (план §3.4): ссылок на строку нет, архива у неё нет.
   * Поэтому подтверждение и называет запасной выход — снять «Активно» вместо удаления: чаще всего
   * руководство не ошибочное, а устаревшее, и вернуть его в обращение проще, чем набирать заново.
   */
  const confirmDelete = (r: ManualDto) =>
    modal.confirm({
      title: `Удалить руководство «${r.title}»?`,
      content: 'Запись удаляется насовсем. Чтобы просто убрать её из окна, снимите «Активно».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = [
    textColumn<ManualDto>({ key: 'title', title: 'Название', dataIndex: 'title' }),
    textColumn<ManualDto>({
      key: 'url',
      title: 'Ссылка',
      dataIndex: 'url',
      // Ни сортировки, ни поиска: сервер по адресу не сортирует (`MANUAL_SORT_FIELDS`), а ищут
      // руководство по названию — адрес читают, чтобы проверить, куда оно ведёт.
      sortable: false,
      searchable: false,
      ellipsis: true,
      render: (_v, r) => (
        // Та же ссылка, что и в окне: проверять её ведущий список должен там же, где ведёт.
        <a href={r.url} target="_blank" rel="noreferrer noopener">
          {r.url}
        </a>
      ),
    }),
    textColumn<ManualDto>({
      key: 'sortOrder',
      title: 'Порядок',
      dataIndex: 'sortOrder',
      searchable: false,
      width: 120,
    }),
    boolBadgeColumn<ManualDto>({
      key: 'isActive',
      title: 'Активно',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<ManualDto>((r) => (
      <Space>
        <RowActionButton
          title="Редактировать"
          icon={<EditOutlined />}
          onClick={() => openEdit(r)}
        />
        <RowActionButton
          title="Удалить"
          icon={<DeleteOutlined />}
          danger
          onClick={() => confirmDelete(r)}
        />
      </Space>
    )),
  ];

  /**
   * Карточка строки на телефоне (ADR 0030): название, пояснение и адрес. Адрес показан целиком —
   * по нему и видно, туда ли ведёт руководство, а обрезанный он отвечал бы только «куда-то».
   */
  const card: CardConfig<ManualDto> = {
    title: (r) => r.title,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => r.description || null,
    lines: [(r) => r.url],
    onOpen: openEdit,
    actions: (r) => [
      { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
      { key: 'delete', label: 'Удалить', danger: true, onClick: () => confirmDelete(r) },
    ],
  };

  return (
    <PageTableLayout
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Название',
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
        primaryAction: {
          label: 'Добавить руководство',
          icon: <PlusOutlined />,
          onClick: openCreate,
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить руководство
        </Button>
      }
    >
      <DataTable<ManualDto>
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
        title={record ? 'Редактирование руководства' : 'Новое руководство'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item
            name="title"
            label="Название"
            rules={[{ required: true, message: 'Укажите название' }]}
          >
            <Input />
          </Form.Item>
          {/* Описание — вторая строка пункта в окне: чем документ помогает, а не как он назван. */}
          <Form.Item name="description" label="Описание">
            <Input />
          </Form.Item>
          <Form.Item
            name="url"
            label="Ссылка"
            rules={[
              { required: true, message: 'Укажите ссылку на документ' },
              // Тот же единственный запрет, что и в контракте: проверяем `https`, а не устройство
              // адреса хранилища — правило «где просмотр, а где правка» принадлежит Яндексу и
              // сломалось бы у нас на первой же смене их адресов.
              { pattern: /^https:\/\//, message: 'Ссылка должна начинаться с https://' },
            ]}
          >
            <Input placeholder="https://" />
          </Form.Item>
          <Form.Item name="sortOrder" label="Порядок">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          {/* Снятое с публикации руководство остаётся здесь и исчезает только из окна: документ
              устаревает раньше, чем становится ненужным. */}
          <Form.Item name="isActive" label="Активно" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
