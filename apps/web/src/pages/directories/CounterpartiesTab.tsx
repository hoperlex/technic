import { useState } from 'react';
import { App, Button, Form, Input, Select, Space, Switch, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_TYPES,
  type CounterpartyDto,
  type CounterpartyType,
  counterpartyTypeColors,
  counterpartyTypeLabels,
  INN_CHECKSUM_MESSAGE,
  INN_MESSAGE,
  isValidInn,
} from '@technic/contracts';
import { counterpartiesApi, objectsApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import type { FilterDefinition } from '../../components/listControls';
import { actionsColumn, badgeColumn, boolBadgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { errorMessage } from '../../utils/format';

interface CounterpartyFormValues {
  type: CounterpartyType;
  name: string;
  inn: string;
  synonyms?: string[];
  /** Обслуживаемые объекты — только у типа «Оператор» (ADR 0010). */
  objectIds?: string[];
  comment?: string;
  isActive: boolean;
}

const typeOptions = COUNTERPARTY_TYPES.map((t) => ({ value: t, label: counterpartyTypeLabels[t] }));

export function CounterpartiesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { params, setParams, onTableChange } = useListParams<{
    type?: string;
    isActive?: string;
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
    queryKey: ['objects', 'for-counterparties'],
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const objectOptions = (objectsData?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<CounterpartyDto | null>(null);
  const [form] = Form.useForm<CounterpartyFormValues>();
  // Объекты обслуживает только оператор, поэтому поле следует за выбранным типом.
  const watchType = Form.useWatch('type', form);

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
      comment: r.comment,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CounterpartyFormValues) => {
      const payload = {
        type: values.type,
        name: values.name,
        inn: values.inn,
        synonyms: values.synonyms ?? [],
        // У прочих типов поля в форме нет; пустой список сервер примет, непустой — отклонит.
        objectIds: values.type === 'operator' ? (values.objectIds ?? []) : [],
        comment: values.comment ?? '',
        isActive: values.isActive,
      };
      return record
        ? counterpartiesApi.update(record.id, payload)
        : counterpartiesApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      // Привязка видна и в справочнике объектов — его список тоже устарел.
      void qc.invalidateQueries({ queryKey: ['objects'] });
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
      (r) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(r)} />
        </Space>
      ),
      90,
    ),
  ];

  const filters = (
    <Select
      style={{ width: 260 }}
      value={typeFilter}
      onChange={applyTypeFilter}
      options={[{ value: '', label: 'Все типы' }, ...typeOptions]}
    />
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
  ];

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
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
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
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
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item name="type" label="Тип" rules={[{ required: true, message: 'Выберите тип' }]}>
            <AutoSelect options={typeOptions} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Наименование"
            tooltip="Как называем контрагента мы; варианты из документов вносятся в синонимы"
            rules={[{ required: true, message: 'Укажите наименование' }]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item
            name="inn"
            label="ИНН"
            rules={[
              { required: true, message: INN_MESSAGE },
              {
                validator: (_rule, v: string | undefined) => {
                  if (!v) return Promise.resolve();
                  if (!/^(\d{10}|\d{12})$/.test(v.trim())) {
                    return Promise.reject(new Error(INN_MESSAGE));
                  }
                  // Контрольная сумма ловит опечатку в одной цифре — формат её не видит.
                  return isValidInn(v.trim())
                    ? Promise.resolve()
                    : Promise.reject(new Error(INN_CHECKSUM_MESSAGE));
                },
              },
            ]}
          >
            <Input maxLength={12} placeholder="10 или 12 цифр" />
          </Form.Item>
          <Form.Item
            name="synonyms"
            label="Синонимы наименования"
            tooltip="Как контрагента пишут в накладных и выгрузках. Enter — добавить вариант"
            extra="Один и тот же синоним не может принадлежать двум контрагентам"
          >
            <Select
              mode="tags"
              tokenSeparators={[';']}
              open={false}
              suffixIcon={null}
              placeholder="ООО «Ромашка», Ромашка ООО…"
            />
          </Form.Item>
          {watchType === 'operator' && (
            <Form.Item
              name="objectIds"
              label="Обслуживаемые объекты"
              tooltip="Объекты, с которых оператор вывозит мусор; из них подставляется исполнитель заявки"
              extra="Пусто — оператор доступен только на объектах, где операторы не заданы"
            >
              <Select
                mode="multiple"
                options={objectOptions}
                showSearch
                optionFilterProp="label"
                placeholder="Не ограничивать"
              />
            </Form.Item>
          )}
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} showCount />
          </Form.Item>
          <Form.Item
            name="isActive"
            label="Активен"
            valuePropName="checked"
            // У неактивного арендодателя не может быть активных предложений аренды (ADR 0018 §15):
            // деактивация гасит их разом, обратное включение — по одной позиции вручную.
            extra={
              watchType === 'vehicle_lessor'
                ? 'Деактивация выключит всю технику этого арендодателя, активация — вернёт ровно её (позиции, выключенные вручную, останутся выключенными)'
                : undefined
            }
          >
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
