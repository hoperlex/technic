import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Radio, Select, Space, Switch, Tag } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableColumnType } from 'antd';
import {
  CONTAINER_KINDS,
  type ContainerKind,
  containerKindColors,
  type CreateWasteTariffInput,
  pricePerM3FromContainer,
  type WasteTariffDto,
} from '@technic/contracts';
import { containerTypesApi, wasteTariffsApi, wasteTypesApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
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
  wasteTypeId: string;
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

const selectQuery = { page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' } as const;

/**
 * Прайс вывоза мусора (ADR 0009, ведение — ADR 0014): пара «что вывозим × чем вывозим» → цена.
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
  const wasteTypeOptions = (wasteTypesData?.items ?? []).map((t) => ({
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
  const watchTarget = Form.useWatch('target', form);
  const watchContainerTypeId = Form.useWatch('containerTypeId', form);
  const watchPricing = Form.useWatch('pricing', form);
  const watchPricePerContainer = Form.useWatch('pricePerContainer', form);

  const selectedVolumeM3 =
    containerTypes.find((t) => t.id === watchContainerTypeId)?.volumeM3 ?? null;
  // Цена за контейнер опирается на вместимость: без неё не вывести ни цену за м³, ни кратность.
  const perContainerAvailable = watchTarget === 'container_type' && selectedVolumeM3 != null;
  const derivedPricePerM3 =
    watchPricing === 'per_container' && selectedVolumeM3 && watchPricePerContainer
      ? pricePerM3FromContainer(Number(watchPricePerContainer), selectedVolumeM3)
      : null;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ target: 'container_type', pricing: 'per_m3', isActive: true, note: '' });
    setOpen(true);
  };
  const openEdit = (r: WasteTariffDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
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
      const payload: CreateWasteTariffInput = {
        wasteTypeId: v.wasteTypeId,
        containerTypeId: v.target === 'container_type' ? (v.containerTypeId ?? null) : null,
        containerKind: v.target === 'container_kind' ? (v.containerKind ?? null) : null,
        isPerContainer: v.pricing === 'per_container',
        // Передаётся ровно одна цена: вторую выводит сервер из вместимости контейнера.
        pricePerM3: v.pricing === 'per_m3' ? (v.pricePerM3 ?? null) : null,
        pricePerContainer: v.pricing === 'per_container' ? (v.pricePerContainer ?? null) : null,
        note: v.note ?? '',
        isActive: v.isActive,
      };
      return record ? wasteTariffsApi.update(record.id, payload) : wasteTariffsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-tariffs'] });
      setOpen(false);
    },
    onError: (e) => {
      if (!applyApiFieldErrors(form, e)) message.error(errorMessage(e));
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
    textColumn<WasteTariffDto>({
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      searchable: false,
      width: 240,
    }),
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
          <Form.Item
            name="wasteTypeId"
            label="Тип мусора"
            rules={[{ required: true, message: 'Выберите тип мусора' }]}
          >
            <Select options={wasteTypeOptions} showSearch optionFilterProp="label" />
          </Form.Item>

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
    </PageTableLayout>
  );
}
