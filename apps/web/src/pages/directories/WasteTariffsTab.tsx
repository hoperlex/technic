import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableColumnType } from 'antd';
import {
  CONTAINER_KINDS,
  type ContainerKind,
  containerKindColors,
  type CreateWasteTariffInput,
  findSimilarWasteTypes,
  findWasteTypeByName,
  pricePerM3FromContainer,
  type WasteTariffDto,
  wasteTypeDuplicateMessage,
  type WasteTypeDto,
} from '@technic/contracts';
import { containerTypesApi, wasteTariffsApi, wasteTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { applyApiFieldErrors } from '../../utils/formErrors';
import { errorMessage, formatMoney } from '../../utils/format';

/** Тариф на вид техники целиком — «любой контейнер» / «любой самосвал». */
const kindAllLabels: Record<ContainerKind, string> = {
  cont: 'Любой контейнер',
  truck: 'Любой самосвал',
};

const kindOptions = CONTAINER_KINDS.map((k) => ({ value: k, label: kindAllLabels[k] }));

interface FormValues {
  /** Откуда берётся тип мусора: из списка заведённых или заводится тут же (ADR 0017). */
  wasteTypeSource: 'existing' | 'new';
  wasteTypeId?: string;
  wasteTypeName?: string;
  /** Чему назначается цена: конкретному типу контейнера/машины или виду техники целиком. */
  target: 'container_type' | 'container_kind';
  containerTypeId?: string;
  containerKind?: ContainerKind;
  /** Как объявлена цена в прайсе: за кубометр или за контейнер целиком. */
  pricing: 'per_m3' | 'per_container';
  pricePerM3?: number;
  pricePerContainer?: number;
  note?: string;
  isActive: boolean;
}

interface TypeFormValues {
  name: string;
  isActive: boolean;
}

const selectQuery = { page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' } as const;

/**
 * Прайс вывоза мусора (ADR 0009, ведение — ADR 0014, 0017): пара «что вывозим × чем вывозим» →
 * цена. Отдельного справочника типов мусора нет: тип заводится здесь же вместе с первой ценой и
 * правится в строке тарифа — сам по себе, без цены, он ничего не значит.
 * Правка цены не пересчитывает оформленные заявки — в них снимок применённого тарифа.
 */
export function WasteTariffsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const { params, setParams, onTableChange } = useListParams<{
    wasteTypeId?: string;
    isActive?: string;
  }>(
    {},
    {
      searchKeys: [],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: ['waste-tariffs', params],
    queryFn: () => wasteTariffsApi.list(params),
  });

  // Справочники для селектов. Неактивные не прячем: тариф мог быть заведён до деактивации,
  // и при его правке выбор должен показывать сохранённое значение, а не пустоту.
  const { data: wasteTypesData } = useQuery({
    queryKey: ['waste-types', 'for-select'],
    queryFn: () => wasteTypesApi.list(selectQuery),
  });
  const { data: containerTypesData } = useQuery({
    queryKey: ['container-types', 'for-select'],
    queryFn: () => containerTypesApi.list(selectQuery),
  });
  const wasteTypeList = wasteTypesData?.items ?? [];
  const wasteTypeById = new Map(wasteTypeList.map((t) => [t.id, t]));
  const wasteTypeOptions = wasteTypeList.map((t) => ({
    value: t.id,
    label: t.isActive ? t.name : `${t.name} (неактивен)`,
  }));
  const containerTypes = containerTypesData?.items ?? [];
  const containerTypeOptions = containerTypes.map((t) => ({
    value: t.id,
    label: `${t.isActive ? t.name : `${t.name} (неактивен)`}${
      t.volumeM3 == null ? ' — вместимость не задана' : ''
    }`,
  }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteTariffDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const watchWasteTypeSource = Form.useWatch('wasteTypeSource', form);
  const watchWasteTypeName = Form.useWatch('wasteTypeName', form);
  const watchTarget = Form.useWatch('target', form);
  const watchContainerTypeId = Form.useWatch('containerTypeId', form);
  const watchPricing = Form.useWatch('pricing', form);
  const watchPricePerContainer = Form.useWatch('pricePerContainer', form);

  // Проверка названия нового типа идёт по уже загруженному списку — человек видит ответ, пока
  // печатает, а не после отправки. Сервер повторяет её же (и за ним UNIQUE в БД): список в
  // браузере успевает устареть, поэтому последнее слово не за формой.
  const newTypeName = (watchWasteTypeName ?? '').trim();
  const duplicateType = newTypeName ? findWasteTypeByName(newTypeName, wasteTypeList) : undefined;
  const similarTypes = duplicateType ? [] : findSimilarWasteTypes(newTypeName, wasteTypeList);

  /** Похожий тип оказался тем самым — форма возвращается к выбору из списка. */
  const pickExistingType = (t: WasteTypeDto) => {
    form.setFieldsValue({ wasteTypeSource: 'existing', wasteTypeId: t.id, wasteTypeName: '' });
  };

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      wasteTypeSource: 'existing',
      target: 'container_type',
      pricing: 'per_m3',
      isActive: true,
      note: '',
    });
    setOpen(true);
  };
  const openEdit = (r: WasteTariffDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      wasteTypeSource: 'existing',
      wasteTypeId: r.wasteTypeId,
      target: r.containerTypeId ? 'container_type' : 'container_kind',
      containerTypeId: r.containerTypeId ?? undefined,
      containerKind: r.containerKind ?? undefined,
      pricing: r.isPerContainer ? 'per_container' : 'per_m3',
      pricePerM3: r.isPerContainer ? undefined : r.pricePerM3,
      pricePerContainer: r.pricePerContainer ?? undefined,
      note: r.note,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: FormValues) => {
      const common = {
        containerTypeId: v.target === 'container_type' ? (v.containerTypeId ?? null) : null,
        containerKind: v.target === 'container_kind' ? (v.containerKind ?? null) : null,
        isPerContainer: v.pricing === 'per_container',
        // Передаётся ровно одна цена: вторую выводит сервер из вместимости контейнера.
        pricePerM3: v.pricing === 'per_m3' ? (v.pricePerM3 ?? null) : null,
        pricePerContainer: v.pricing === 'per_container' ? (v.pricePerContainer ?? null) : null,
        note: v.note ?? '',
        isActive: v.isActive,
      };
      if (record)
        return wasteTariffsApi.update(record.id, { ...common, wasteTypeId: v.wasteTypeId });
      // Новый тип уходит названием: заводит его сервер той же транзакцией, что и цену.
      const payload: CreateWasteTariffInput = {
        ...common,
        wasteTypeId: v.wasteTypeSource === 'new' ? null : (v.wasteTypeId ?? null),
        wasteTypeName: v.wasteTypeSource === 'new' ? (v.wasteTypeName ?? null) : null,
      };
      return wasteTariffsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-tariffs'] });
      // Вместе с ценой мог появиться новый тип мусора — список для выбора устарел.
      void qc.invalidateQueries({ queryKey: ['waste-types'] });
      setOpen(false);
    },
    onError: (e) => {
      if (!applyApiFieldErrors(form, e)) message.error(errorMessage(e));
    },
  });

  // ── Правка типа мусора: его интерфейс — строка тарифа (ADR 0017) ──
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeRecord, setTypeRecord] = useState<WasteTypeDto | null>(null);
  const [typeForm] = Form.useForm<TypeFormValues>();

  const openTypeEdit = (t: WasteTypeDto) => {
    setTypeRecord(t);
    typeForm.resetFields();
    typeForm.setFieldsValue({ name: t.name, isActive: t.isActive });
    setTypeOpen(true);
  };

  const saveTypeMut = useMutation({
    mutationFn: (v: TypeFormValues) => wasteTypesApi.update(typeRecord!.id, v),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-types'] });
      // Название типа показано в каждой строке прайса и в заявках.
      void qc.invalidateQueries({ queryKey: ['waste-tariffs'] });
      setTypeOpen(false);
    },
    onError: (e) => {
      if (!applyApiFieldErrors(typeForm, e)) message.error(errorMessage(e));
    },
  });

  // Удаления нет: на позицию прайса ссылаются снимки цены в заявках — выбытие через isActive.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      wasteTariffsApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Тариф включён' : 'Тариф отключён');
      void qc.invalidateQueries({ queryKey: ['waste-tariffs'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onToggleActive = (r: WasteTariffDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Отключить тариф «${r.wasteTypeName}»?`,
      content:
        'Новые заявки на эту пару «мусор × техника» перестанут тарифицироваться. Суммы уже оформленных заявок не изменятся.',
      okText: 'Отключить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  const activeColumn: TableColumnType<WasteTariffDto> = {
    key: 'isActive',
    title: 'Действует',
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
    {
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      width: 260,
      sorter: true,
      // Карандаш правит сам тип, а не тариф: отдельной вкладки у типов больше нет.
      render: (v: string, r: WasteTariffDto) => {
        const type = wasteTypeById.get(r.wasteTypeId);
        return (
          <Space size={4}>
            <span>{v}</span>
            {type && !type.isActive && <Tag>неактивен</Tag>}
            {type && (
              <Button
                type="text"
                size="small"
                title="Переименовать тип мусора"
                icon={<EditOutlined />}
                onClick={() => openTypeEdit(type)}
              />
            )}
          </Space>
        );
      },
    },
    {
      key: 'container',
      title: 'Техника',
      width: 220,
      render: (_v: unknown, r: WasteTariffDto) =>
        r.containerTypeName ??
        (r.containerKind ? (
          <Tag color={containerKindColors[r.containerKind]}>{kindAllLabels[r.containerKind]}</Tag>
        ) : (
          '—'
        )),
    },
    {
      key: 'pricePerM3',
      title: 'Цена за м³',
      dataIndex: 'pricePerM3',
      width: 150,
      sorter: true,
      render: (v: number) => formatMoney(v),
    },
    {
      key: 'pricePerContainer',
      title: 'Цена за контейнер',
      width: 200,
      render: (_v: unknown, r: WasteTariffDto) =>
        r.isPerContainer && r.pricePerContainer != null ? (
          <span>
            {formatMoney(r.pricePerContainer)}
            {r.containerVolumeM3 != null ? ` / ${r.containerVolumeM3} м³` : ''}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'note',
      title: 'Пункт прайса',
      dataIndex: 'note',
      ellipsis: true,
      render: (v: string) => v || '—',
    },
    activeColumn,
    actionsColumn<WasteTariffDto>(
      (r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
        </Space>
      ),
      100,
    ),
  ];

  const filters = (
    <Space wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы мусора"
        style={{ width: 280 }}
        options={wasteTypeOptions}
        value={params.wasteTypeId}
        onChange={(v) => setParams((p) => ({ ...p, wasteTypeId: v, page: 1 }))}
      />
    </Space>
  );

  const selectedVolumeM3 =
    containerTypes.find((t) => t.id === watchContainerTypeId)?.volumeM3 ?? null;
  // Цена за контейнер опирается на вместимость: без неё не вывести ни цену за м³, ни кратность.
  const perContainerAvailable = watchTarget === 'container_type' && selectedVolumeM3 != null;
  const derivedPricePerM3 =
    watchPricing === 'per_container' && selectedVolumeM3 && watchPricePerContainer
      ? pricePerM3FromContainer(Number(watchPricePerContainer), selectedVolumeM3)
      : null;

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить тариф
        </Button>
      }
    >
      <DataTable<WasteTariffDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? 'Редактирование тарифа' : 'Новый тариф'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          onValuesChange={(changed: Partial<FormValues>) => {
            // Источник типа переключён — поле предыдущего варианта очищается, иначе на сервер
            // ушли бы и id, и название сразу.
            if ('wasteTypeSource' in changed) {
              form.setFieldsValue({ wasteTypeId: undefined, wasteTypeName: '' });
            }
            // Область действия и режим тарификации связаны: цена за контейнер существует
            // только у конкретного типа с известной вместимостью.
            if ('target' in changed) {
              form.setFieldsValue({ containerTypeId: undefined, containerKind: undefined });
              if (changed.target !== 'container_type') form.setFieldValue('pricing', 'per_m3');
            }
            if ('containerTypeId' in changed) {
              const volume =
                containerTypes.find((t) => t.id === changed.containerTypeId)?.volumeM3 ?? null;
              if (volume == null && form.getFieldValue('pricing') === 'per_container') {
                form.setFieldValue('pricing', 'per_m3');
              }
            }
          }}
        >
          {/* Тип мусора у новой позиции можно завести на месте: отдельного справочника нет. */}
          {!record && (
            <Form.Item name="wasteTypeSource" label="Тип мусора" style={{ marginBottom: 12 }}>
              <Radio.Group
                options={[
                  { value: 'existing', label: 'Из заведённых' },
                  { value: 'new', label: 'Новый' },
                ]}
                optionType="button"
              />
            </Form.Item>
          )}

          {!record && watchWasteTypeSource === 'new' ? (
            <>
              <Form.Item
                name="wasteTypeName"
                extra={
                  duplicateType ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 'auto' }}
                      onClick={() => pickExistingType(duplicateType)}
                    >
                      Выбрать «{duplicateType.name}»
                    </Button>
                  ) : (
                    'Тип заведётся вместе с этой ценой'
                  )
                }
                rules={[
                  { required: true, message: 'Укажите название типа мусора' },
                  {
                    // Вариации написания уже заведённого типа — не новый тип, а тот же самый:
                    // пара «тип × техника» разошлась бы на две цены. Это запрет, а не подсказка.
                    validator: (_r, v: string) => {
                      const clash = v ? findWasteTypeByName(v, wasteTypeList) : undefined;
                      return clash
                        ? Promise.reject(new Error(wasteTypeDuplicateMessage(clash.name)))
                        : Promise.resolve();
                    },
                  },
                ]}
              >
                <Input maxLength={255} placeholder="Например, бетонный бой" />
              </Form.Item>
              {similarTypes.length > 0 && (
                // Похожесть — предупреждение, а не запрет: решать человеку, поэтому кнопка
                // «Сохранить» остаётся рабочей.
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="Есть похожие типы"
                  description={
                    <>
                      <div>Если речь об одном и том же — выберите заведённый тип:</div>
                      <Space wrap style={{ marginTop: 8 }}>
                        {similarTypes.map((t) => (
                          <Button key={t.id} size="small" onClick={() => pickExistingType(t)}>
                            {t.name}
                          </Button>
                        ))}
                      </Space>
                    </>
                  }
                />
              )}
            </>
          ) : (
            <Form.Item
              name="wasteTypeId"
              label={record ? 'Тип мусора' : undefined}
              rules={[{ required: true, message: 'Выберите тип мусора' }]}
            >
              <Select options={wasteTypeOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          )}

          <Form.Item name="target" label="Тариф действует для">
            <Radio.Group
              options={[
                { value: 'container_type', label: 'Конкретной техники' },
                { value: 'container_kind', label: 'Вида техники целиком' },
              ]}
              optionType="button"
            />
          </Form.Item>

          {watchTarget === 'container_kind' ? (
            <Form.Item
              name="containerKind"
              label="Вид техники"
              extra="Точный тариф на конкретный тип контейнера побеждает тариф вида"
              rules={[{ required: true, message: 'Выберите вид техники' }]}
            >
              <Select options={kindOptions} />
            </Form.Item>
          ) : (
            <Form.Item
              name="containerTypeId"
              label="Тип машины/контейнера"
              rules={[{ required: true, message: 'Выберите тип машины/контейнера' }]}
            >
              <Select options={containerTypeOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          )}

          <Form.Item name="pricing" label="Цена задана">
            <Radio.Group
              options={[
                { value: 'per_m3', label: 'За кубометр' },
                {
                  value: 'per_container',
                  label: 'За контейнер целиком',
                  disabled: !perContainerAvailable,
                },
              ]}
              optionType="button"
            />
          </Form.Item>

          {watchPricing === 'per_container' ? (
            <Form.Item
              name="pricePerContainer"
              label="Цена за контейнер"
              extra={
                derivedPricePerM3 != null
                  ? `В прайсе хранится ${formatMoney(derivedPricePerM3)} за м³; объём заявки должен быть кратен ${selectedVolumeM3} м³`
                  : 'Цену за м³ выведет сервер из вместимости контейнера'
              }
              rules={[{ required: true, message: 'Укажите цену за контейнер' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                precision={2}
                step={100}
                addonAfter="₽"
              />
            </Form.Item>
          ) : (
            <Form.Item
              name="pricePerM3"
              label="Цена за м³"
              rules={[{ required: true, message: 'Укажите цену за м³' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                precision={2}
                step={50}
                addonAfter="₽/м³"
              />
            </Form.Item>
          )}

          <Form.Item name="note" label="Пункт прайса">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Form.Item name="isActive" label="Действует" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>

      {/* Правка самого типа мусора. Удаления нет: на тип ссылаются заявки и позиции прайса. */}
      <FormModal
        title="Тип мусора"
        open={typeOpen}
        onCancel={() => setTypeOpen(false)}
        onSubmit={() => typeForm.submit()}
        confirmLoading={saveTypeMut.isPending}
        width={480}
      >
        <Form form={typeForm} layout="vertical" onFinish={(v) => saveTypeMut.mutate(v)}>
          <Form.Item
            name="name"
            label="Название"
            rules={[
              { required: true, message: 'Укажите название' },
              {
                validator: (_r, v: string) => {
                  const others = wasteTypeList.filter((t) => t.id !== typeRecord?.id);
                  const clash = v ? findWasteTypeByName(v, others) : undefined;
                  return clash
                    ? Promise.reject(new Error(wasteTypeDuplicateMessage(clash.name)))
                    : Promise.resolve();
                },
              },
            ]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item
            name="isActive"
            label="Активен"
            valuePropName="checked"
            extra="Неактивный тип исчезает из выбора в заявках; заведённые заявки и тарифы остаются как есть"
          >
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
