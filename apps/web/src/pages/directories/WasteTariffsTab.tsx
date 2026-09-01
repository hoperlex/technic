import { useMemo, useState } from 'react';
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
  Tooltip,
  Typography,
} from 'antd';
import { DeleteFilled, EditOutlined, InfoCircleOutlined, PlusOutlined } from '@ant-design/icons';
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
import { counterpartiesApi } from '../../api/resources';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { wasteTariffKeys, wasteTariffsApi } from '@entities/waste-tariff';
import { wasteTypeKeys, wasteTypeOptionsQuery, wasteTypesApi } from '@entities/waste-type';
import { AutoSelect } from '@shared/ui';
import { DataTable } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import type { FilterDefinition } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useListParams } from '@shared/lib';
import { errorMessage, formatMoney } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import {
  buildWasteTariffGrid,
  wasteTariffColumnOperators,
  type WasteTariffGridRow,
} from './wasteTariffGrid';

/** Тариф на вид техники целиком — «любой контейнер» / «любой самосвал». */
const kindAllLabels: Record<ContainerKind, string> = {
  cont: 'Любой контейнер',
  truck: 'Любой самосвал',
};

const kindOptions = CONTAINER_KINDS.map((k) => ({ value: k, label: kindAllLabels[k] }));

interface FormValues {
  /** Чей это прайс: цена принадлежит оператору (ADR 0026). */
  operatorCounterpartyId?: string;
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

const operatorsQuery = {
  page: 1,
  pageSize: 200,
  sortBy: 'name',
  sortOrder: 'asc',
  type: 'operator',
} as const;

/**
 * Прайс целиком грузится одной страницей: справочник сводный, и строку «мусор × техника» нельзя
 * собрать из куска выборки — цены операторов приехали бы на разных страницах. Предел на случай,
 * если прайс однажды перерастёт эту цифру: тогда таблица честно скажет, что показано не всё.
 */
const MAX_TARIFFS = 500;

/**
 * Прайс вывоза мусора (ADR 0009, ведение — ADR 0014, 0017): пара «что вывозим × чем вывозим» →
 * цена. Цена принадлежит оператору (ADR 0026), поэтому таблица сводная: строка — пара, столбцы —
 * операторы, в ячейке цена за м³. Отдельного справочника типов мусора нет: тип заводится здесь же
 * вместе с первой ценой и правится в строке тарифа.
 * Правка цены не пересчитывает оформленные заявки — в них снимок применённого тарифа.
 */
export function WasteTariffsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  const { params, setParams, onTableChange } = useListParams<{
    wasteTypeId?: string;
    isActive?: string;
  }>({}, { searchKeys: [] });

  const { data, isFetching } = useQuery({
    queryKey: wasteTariffKeys.grid({
      wasteTypeId: params.wasteTypeId,
      isActive: params.isActive,
    }),
    queryFn: () =>
      wasteTariffsApi.list({
        page: 1,
        pageSize: MAX_TARIFFS,
        ...(params.wasteTypeId ? { wasteTypeId: params.wasteTypeId } : {}),
        ...(params.isActive ? { isActive: params.isActive } : {}),
      }),
  });

  // Справочники для селектов — целиком, вместе с неактивными: тариф мог быть заведён до
  // деактивации, и при его правке выбор должен показывать сохранённое значение, а не пустоту.
  const { data: wasteTypesData, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: false }),
  );
  const { data: containerTypesData, isLoading: containerTypesLoading } = useQuery(
    containerTypeOptionsQuery({ activeOnly: false }),
  );
  const { data: operatorsData, isLoading: operatorsLoading } = useQuery({
    queryKey: ['counterparties', 'operators'],
    queryFn: () => counterpartiesApi.list(operatorsQuery),
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
  const operators = operatorsData?.items ?? [];
  const operatorOptions = operators.map((o) => ({
    value: o.id,
    label: o.isActive ? o.name : `${o.name} (неактивен)`,
  }));

  const tariffs = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(() => buildWasteTariffGrid(tariffs), [tariffs]);
  const columnOperators = useMemo(
    () => wasteTariffColumnOperators(operators, tariffs),
    [operators, tariffs],
  );
  // Пагинация идёт по строкам сводной таблицы, а не по позициям прайса: строк меньше, чем цен.
  const pageRows = rows.slice(
    (params.page - 1) * params.pageSize,
    (params.page - 1) * params.pageSize + params.pageSize,
  );
  const truncated = (data?.total ?? 0) > tariffs.length;

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteTariffDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form, {
    onValuesChange: (changed: Partial<FormValues>) => {
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
    },
  });
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

  /** Пустая ячейка сводной таблицы: пара и оператор уже известны — остаётся цена. */
  const openCreateFor = (row: WasteTariffGridRow, operatorCounterpartyId: string) => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      operatorCounterpartyId,
      wasteTypeSource: 'existing',
      wasteTypeId: row.wasteTypeId,
      target: row.containerTypeId ? 'container_type' : 'container_kind',
      containerTypeId: row.containerTypeId ?? undefined,
      containerKind: row.containerKind ?? undefined,
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
      operatorCounterpartyId: r.operatorCounterpartyId,
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
        operatorCounterpartyId: v.operatorCounterpartyId!,
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
      void qc.invalidateQueries({ queryKey: wasteTariffKeys.root });
      // Вместе с ценой мог появиться новый тип мусора — список для выбора устарел.
      void qc.invalidateQueries({ queryKey: wasteTypeKeys.root });
      setOpen(false);
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  // ── Правка типа мусора: его интерфейс — строка тарифа (ADR 0017) ──
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeRecord, setTypeRecord] = useState<WasteTypeDto | null>(null);
  const [typeForm] = Form.useForm<TypeFormValues>();
  const typeBlockers = useFormBlockers(typeForm);

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
      void qc.invalidateQueries({ queryKey: wasteTypeKeys.root });
      // Название типа показано в каждой строке прайса и в заявках.
      void qc.invalidateQueries({ queryKey: wasteTariffKeys.root });
      setTypeOpen(false);
    },
    onError: (e) => {
      if (!typeBlockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  // Удаления нет: на позицию прайса ссылаются снимки цены в заявках — выбытие через isActive.
  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      wasteTariffsApi.update(id, { isActive }),
    onSuccess: (_d, v) => {
      message.success(v.isActive ? 'Цена включена' : 'Цена отключена');
      void qc.invalidateQueries({ queryKey: wasteTariffKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Удаление насовсем (ADR 0060). Строк действий в сетке нет — предмет действия задаёт открытая
   * модалка, поэтому кнопки живут в её подвале: у цены — в карточке цены, у типа мусора — в
   * карточке типа.
   */
  const purgeTariff = usePurgeAction({
    subject: 'цену',
    purge: wasteTariffsApi.purge,
    invalidate: [wasteTariffKeys.root],
  });
  const purgeType = usePurgeAction({
    subject: 'тип мусора',
    purge: wasteTypesApi.purge,
    // Тип виден и строкой сетки, и списком выбора в форме цены, поэтому устаревают обе сущности.
    invalidate: [wasteTypeKeys.root, wasteTariffKeys.root],
  });

  const onToggleActive = (r: WasteTariffDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ id: r.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Отключить цену «${r.wasteTypeName}» у оператора «${r.operatorName}»?`,
      content:
        'Новые заявки этого оператора на такую пару «мусор × техника» перестанут тарифицироваться. Суммы уже оформленных заявок не изменятся.',
      okText: 'Отключить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ id: r.id, isActive: false }),
    });
  };

  /** Подсказка ячейки: что за цена и в каком виде она задана в прайсе. */
  const cellHint = (t: WasteTariffDto): string => {
    const parts = [
      t.isPerContainer && t.pricePerContainer != null
        ? `В прайсе — ${formatMoney(t.pricePerContainer)} за контейнер${
            t.containerVolumeM3 != null ? ` ${t.containerVolumeM3} м³` : ''
          }`
        : null,
      t.note || null,
      t.isActive ? null : 'Цена отключена',
    ].filter(Boolean);
    return parts.join(' · ');
  };

  const operatorColumns: TableColumnType<WasteTariffGridRow>[] = columnOperators.map((op) => ({
    key: `operator:${op.id}`,
    title: (
      <Space orientation="vertical" size={0}>
        <span>{op.name}</span>
        <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.65 }}>
          {op.isActive ? '₽/м³' : '₽/м³ · неактивен'}
        </span>
      </Space>
    ),
    width: isMobile ? 150 : 200,
    render: (_v: unknown, row: WasteTariffGridRow) => {
      const t = row.byOperator[op.id];
      // Пустая ячейка — не «нет цены навсегда», а место, куда её заводят: пара и оператор
      // уже выбраны самой ячейкой.
      if (!t) {
        return (
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            title={`Задать цену — ${op.name}`}
            onClick={() => openCreateFor(row, op.id)}
          />
        );
      }
      const hint = cellHint(t);
      // На телефоне в ячейке остаётся только цена: она же кнопка правки, где есть и заметка,
      // и признак «действует». Подсказка на значке по касанию всё равно не открывается, а
      // переключатель рядом с ценой в колонке 150 px не оставляет места ни тому, ни другому.
      if (isMobile) {
        return (
          <Space size={4} wrap>
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: 'auto', opacity: t.isActive ? 1 : 0.45 }}
              onClick={() => openEdit(t)}
            >
              {formatMoney(t.pricePerM3)}
            </Button>
            {!t.isActive && <Tag>отключена</Tag>}
          </Space>
        );
      }
      return (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto', opacity: t.isActive ? 1 : 0.45 }}
            onClick={() => openEdit(t)}
          >
            {formatMoney(t.pricePerM3)}
          </Button>
          {!t.isActive && <Tag>отключена</Tag>}
          {hint && (
            <Tooltip title={hint}>
              <InfoCircleOutlined style={{ opacity: 0.45 }} />
            </Tooltip>
          )}
          <Switch
            size="small"
            checked={t.isActive}
            loading={toggleMut.isPending}
            title="Действует"
            onChange={(n) => onToggleActive(t, n)}
          />
        </Space>
      );
    },
  }));

  /**
   * Пара «что вывозим × чем вывозим» — якорь строки. На телефоне обе колонки сливаются в одну
   * (ADR 0030): по отдельности они занимают 480 px, и закрепить их на экране 360 px нельзя, а
   * без закреплённого якоря при прокрутке к третьему оператору непонятно, чья это цена.
   */
  const subjectColumn: TableColumnType<WasteTariffGridRow> = {
    key: 'subject',
    title: 'Мусор · техника',
    width: 170,
    render: (_v: unknown, r: WasteTariffGridRow) => {
      const type = wasteTypeById.get(r.wasteTypeId);
      return (
        <div style={{ lineHeight: 1.3 }}>
          <Space size={4}>
            <span>{r.wasteTypeName}</span>
            {type && !type.isActive && <Tag>неактивен</Tag>}
            {type && (
              <Button
                type="text"
                size="small"
                className="touch-icon"
                aria-label="Переименовать тип мусора"
                icon={<EditOutlined />}
                onClick={() => openTypeEdit(type)}
              />
            )}
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.containerTypeName ?? (r.containerKind ? kindAllLabels[r.containerKind] : '—')}
            </Typography.Text>
          </div>
        </div>
      );
    },
  };

  const columns: TableColumnType<WasteTariffGridRow>[] = isMobile
    ? [subjectColumn, ...operatorColumns]
    : [
        {
          key: 'wasteTypeName',
          title: 'Тип мусора',
          dataIndex: 'wasteTypeName',
          width: 260,
          // Карандаш правит сам тип, а не цену: отдельной вкладки у типов больше нет.
          render: (v: string, r: WasteTariffGridRow) => {
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
          render: (_v: unknown, r: WasteTariffGridRow) =>
            r.containerTypeName ??
            (r.containerKind ? (
              <Tag color={containerKindColors[r.containerKind]}>
                {kindAllLabels[r.containerKind]}
              </Tag>
            ) : (
              '—'
            )),
        },
        ...operatorColumns,
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
      <Select
        allowClear
        placeholder="Все цены"
        style={{ width: 200 }}
        options={[
          { value: 'true', label: 'Только действующие' },
          { value: 'false', label: 'Только отключённые' },
        ]}
        value={params.isActive}
        onChange={(v) => setParams((p) => ({ ...p, isActive: v, page: 1 }))}
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

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'wasteTypeId',
      label: 'Тип мусора',
      value: params.wasteTypeId,
      options: wasteTypeOptions,
      placeholder: 'Все типы мусора',
      loading: wasteTypesLoading,
      onChange: (v) => setParams((p) => ({ ...p, wasteTypeId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Действие цены',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Только действующие' },
        { value: 'false', label: 'Только отключённые' },
      ],
      placeholder: 'Все цены',
      onChange: (v) => setParams((p) => ({ ...p, isActive: v, page: 1 })),
    },
  ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить цену
        </Button>
      }
      mobile={{
        filters: mobileFilters,
        primaryAction: { label: 'Добавить цену', icon: <PlusOutlined />, onClick: openCreate },
      }}
    >
      {operators.length === 0 && !operatorsLoading && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Операторы не заведены"
          description="Цена вывоза принадлежит оператору — заведите контрагента типа «Оператор» в справочнике контрагентов."
        />
      )}
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Показаны первые ${tariffs.length} позиций прайса из ${data?.total ?? 0}`}
          description="Отфильтруйте справочник по типу мусора — иначе часть цен в таблицу не попала."
        />
      )}
      <DataTable<WasteTariffGridRow>
        rowKey="key"
        columns={columns}
        data={pageRows}
        total={rows.length}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? 'Редактирование цены' : 'Новая цена'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
        footerExtra={
          record && !record.isActive && purgeTariff.allowed ? (
            <Button
              danger
              icon={<DeleteFilled />}
              loading={purgeTariff.pending}
              onClick={() => {
                setOpen(false);
                purgeTariff.confirm(record.id, `${record.wasteTypeName} — ${record.operatorName}`);
              }}
            >
              Удалить окончательно
            </Button>
          ) : undefined
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          {...blockers.formProps}
        >
          <Form.Item
            name="operatorCounterpartyId"
            label="Оператор"
            extra="Цена действует только для этого оператора"
            rules={[{ required: true, message: 'Выберите оператора' }]}
          >
            <AutoSelect
              options={operatorOptions}
              loading={operatorsLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

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
                  title="Есть похожие типы"
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
              <AutoSelect
                options={wasteTypeOptions}
                loading={wasteTypesLoading}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          )}

          <Form.Item name="target" label="Цена действует для">
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
              extra="Точная цена на конкретный тип контейнера побеждает цену вида"
              rules={[{ required: true, message: 'Выберите вид техники' }]}
            >
              <AutoSelect options={kindOptions} />
            </Form.Item>
          ) : (
            <Form.Item
              name="containerTypeId"
              label="Тип машины/контейнера"
              rules={[{ required: true, message: 'Выберите тип машины/контейнера' }]}
            >
              <AutoSelect
                options={containerTypeOptions}
                loading={containerTypesLoading}
                showSearch
                optionFilterProp="label"
              />
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
        footerExtra={
          typeRecord && !typeRecord.isActive && purgeType.allowed ? (
            <Button
              danger
              icon={<DeleteFilled />}
              loading={purgeType.pending}
              onClick={() => {
                setTypeOpen(false);
                purgeType.confirm(typeRecord.id, typeRecord.name);
              }}
            >
              Удалить окончательно
            </Button>
          ) : undefined
        }
      >
        <Form
          form={typeForm}
          layout="vertical"
          onFinish={(v) => saveTypeMut.mutate(v)}
          {...typeBlockers.formProps}
        >
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
