import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Space, Switch, Tag } from 'antd';
import { DeleteFilled, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MECH_MODEL_CODE,
  MECH_MODEL_CODE_MAX,
  MECH_MODEL_CODE_MESSAGE,
  type CreateMechModelInput,
  type MechModelDto,
} from '@technic/contracts';
import type { TableColumnType } from 'antd';
import { mechModelKeys, mechModelsApi } from '@entities/mech-model';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';

/** Что вкладка спрашивает сверх базовых параметров списка. */
interface MechModelParams {
  isActive?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Справочник моделей малой механизации (план `docs/mechanization-models-directory-plan.md`, Э1).
 *
 * Устройство повторяет «Типы контейнеров»: то же деление на список, окно правки, деактивацию и
 * удаление насовсем. Отличие одно и содержательное — порядок по умолчанию. У типов контейнеров он
 * задан справочником (`sortOrder`): их полтора десятка, и в заявке они стоят так, как их привыкли
 * видеть. Моделей сто с лишним, привычного места у них нет, и открывается вкладка по алфавиту —
 * иначе первым делом человек видел бы то, что завели последним.
 *
 * Заявок эта вкладка пока не касается: поле «Вид техники» остаётся свободной строкой до этапа Э2.
 */
export function MechModelsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, setSort, onTableChange } = useListParams<MechModelParams>(
    // Алфавит просится явно: умолчание `baseListQuery` на сервере — «последняя заведённая
    // сверху» (`sortOrder: 'desc'`), и справочник открывался бы задом наперёд.
    { sortBy: 'name', sortOrder: 'asc' },
    {
      searchKeys: ['code', 'name'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: mechModelKeys.list(params),
    queryFn: () => mechModelsApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<MechModelDto | null>(null);
  const [form] = Form.useForm<CreateMechModelInput>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, sortOrder: 100 } as CreateMechModelInput);
    setOpen(true);
  };
  const openEdit = (r: MechModelDto) => {
    setRecord(r);
    form.setFieldsValue(r);
    setOpen(true);
  };

  const saveMut = useMutation({
    /**
     * Код уезжает только в заведение. Поле формы у него есть всегда — в правке оно заперто и
     * показывает заведённое значение, — но `updateMechModelSchema` строгая и кода не знает вовсе:
     * отправленный вместе с новым наименованием, он отбил бы **весь** запрос ответом
     * «Unrecognized key», и правка выглядела бы поломкой сохранения, а не запретом менять код.
     */
    mutationFn: ({ code, ...rest }: CreateMechModelInput) =>
      record ? mechModelsApi.update(record.id, rest) : mechModelsApi.create({ code, ...rest }),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: mechModelKeys.root });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаления нет: деактивация через isActive — на модель ссылаются заявки на аренду.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      mechModelsApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Активирована' : 'Деактивирована');
      void qc.invalidateQueries({ queryKey: mechModelKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onToggleActive = (r: MechModelDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать модель «${r.name}»?`,
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  // Удаление насовсем (ADR 0060): деактивация оставляет модель в базе навсегда, а заведённую по
  // ошибке строку убирает отсюда только администратор.
  const purge = usePurgeAction({
    subject: 'модель',
    purge: mechModelsApi.purge,
    invalidate: [mechModelKeys.root],
  });

  const activeColumn: TableColumnType<MechModelDto> = {
    key: 'isActive',
    title: 'Активна',
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
    textColumn<MechModelDto>({ key: 'name', title: 'Название', dataIndex: 'name' }),
    // Код читают, когда строку уже нашли: он узкий и стоит вторым. Искать по нему всё равно
    // можно — лупа заголовка «Названия» спрашивает сервер по обоим полям сразу.
    textColumn<MechModelDto>({
      key: 'code',
      title: 'Код',
      dataIndex: 'code',
      searchable: false,
      width: 260,
      ellipsis: true,
    }),
    activeColumn,
    actionsColumn<MechModelDto>((r) => (
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
   * Карточка строки на телефоне (ADR 0042): название, код и активность. Активность здесь тег, а
   * не переключатель, как в таблице: случайное касание в списке не должно выводить модель из
   * обращения — для этого есть действие в шите.
   */
  const card: CardConfig<MechModelDto> = {
    title: (r) => r.name,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
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
        primaryAction: { label: 'Добавить модель', icon: <PlusOutlined />, onClick: openCreate },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить модель
        </Button>
      }
    >
      <DataTable<MechModelDto>
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
        title={record ? 'Редактирование модели' : 'Новая модель'}
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
            /*
             * Вид кода проверяет и база (CHECK `mech_models_code_format_check`), но набирает его
             * руками человек: правило здесь помечает поле сразу, а не после отказа сервера.
             */
            rules={[
              { required: true, message: 'Укажите код' },
              { max: MECH_MODEL_CODE_MAX, message: `Не длиннее ${MECH_MODEL_CODE_MAX} знаков` },
              { pattern: MECH_MODEL_CODE, message: MECH_MODEL_CODE_MESSAGE },
            ]}
          >
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
          <Form.Item name="sortOrder" label="Порядок сортировки">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="isActive" label="Активна" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
