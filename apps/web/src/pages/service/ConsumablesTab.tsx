import { useState } from 'react';
import { Button, Checkbox, Input, Segmented, Select, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
import {
  DataTable,
  FilterReset,
  PageTableLayout,
  sortOptionsFrom,
  type FilterDefinition,
} from '@shared/ui';
import { useListParams, usePruneMissingFilters } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
  officeEquipmentModelPickerQuery,
} from '@entities/office-equipment';
import {
  CONSUMABLE_SORT_LABELS,
  officeEquipmentConsumableCard,
  officeEquipmentConsumableColumns,
  OfficeEquipmentRequiredModal,
  OfficeEquipmentStockHistoryModal,
  OfficeEquipmentStockModal,
  PARK_COUNT_HINT,
  STOCK_HINT,
} from '@features/office-equipment-consumables';
import { useAuth } from '../../auth/AuthContext';
import { OfficeEquipmentPurchaseFormModal } from './OfficeEquipmentPurchaseFormModal';
import { OfficeEquipmentPurchasesList } from './OfficeEquipmentPurchasesList';
import { OfficeEquipmentPurchaseViewModal } from './OfficeEquipmentPurchaseViewModal';

/**
 * Вкладка «Расходники» раздела «Орг.техника» (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р14).
 *
 * РАБОТА, А НЕ ВЕДЕНИЕ — и отсюда всё остальное. В «Справочниках» номенклатуру **ведут**: заводят
 * коды, правят наименования, гасят и удаляют строки. Здесь со складом **работают**: смотрят, чего
 * не хватает, правят остаток и потребность, читают журнал и заводят плановую закупку. Поэтому
 * заведения, правки и удаления позиций тут нет вовсе (решение заказчика) — за ними в
 * «Справочники» → «Оргтехника» → «Картриджи и тонеры».
 *
 * Что показано — то же самое, что и там, и это держится не договорённостью: колонки и карточка
 * строки приходят из одного модуля (`@features/office-equipment-consumables`), а различие дверей
 * выражено тем, какие действия строки сюда переданы. Столбец, добавленный одной двери, появляется у
 * обеих сам.
 *
 * ПЕРЕКЛЮЧАТЕЛЬ «ПОЗИЦИИ / ЗАКУПКИ», а не два экрана: это один рабочий стол — на позиции смотрят,
 * чтобы завести закупку, и в закупку заглядывают, чтобы понять, почему у позиции нет дефицита.
 * Вторая половина открывается только держателю `officeEquipmentPurchases.manage`: закупка видна по
 * праву, а не по области (Р9).
 */

/**
 * Что вкладка спрашивает сверх базовых параметров списка. Порядок сортировки объявлен здесь же:
 * умолчание `baseListQuery` — `desc`, и перечень открывался бы задом наперёд.
 */
interface ConsumableFilters {
  modelId?: string;
  stock?: string;
  hasDeficit?: string;
  isActive?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/** Те же срезы перечнем: вкладка запоминает их между сеансами и снимает «Сбросить» (ADR 0139). */
const FILTER_FIELDS = [
  'modelId',
  'stock',
  'hasDeficit',
  'isActive',
] as const satisfies readonly (keyof ConsumableFilters)[];

export function ConsumablesTab() {
  const { can, user } = useAuth();
  /*
   * Права раздельные и проверяются независимо (Р10, Р12). Сама вкладка открыта по
   * `officeEquipment.read` — тем же правом, что и справочник расходников; правка остатка,
   * потребности и ведение закупок приходят своими.
   */
  const canStock = can('officeEquipmentConsumables.stock');
  const canManage = can('officeEquipmentConsumables.manage');
  const canPurchase = can('officeEquipmentPurchases.manage');

  const [view, setView] = useState<'items' | 'purchases'>('items');
  const [stockOf, setStockOf] = useState<OfficeEquipmentConsumableDto | null>(null);
  const [historyOf, setHistoryOf] = useState<OfficeEquipmentConsumableDto | null>(null);
  const [requiredOf, setRequiredOf] = useState<OfficeEquipmentConsumableDto | null>(null);
  const [purchaseFormOpen, setPurchaseFormOpen] = useState(false);
  const [openedPurchase, setOpenedPurchase] = useState<string | null>(null);

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } =
    useListParams<ConsumableFilters>(
      // Алфавит просится явно: умолчание `baseListQuery` — «последняя заведённая сверху», и
      // перечень, который читают глазами, открывался бы задом наперёд.
      { sortBy: 'name', sortOrder: 'asc' },
      {
        searchKeys: [],
        filterKeys: FILTER_FIELDS,
        // Склад смотрят одним и тем же срезом изо дня в день: «есть дефицит» — рабочее место, а не
        // разовый вопрос (ADR 0139).
        persist: { scope: 'service-consumables', userId: user?.id },
      },
    );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentConsumableKeys.list(params),
    queryFn: () => officeEquipmentConsumablesApi.list(params),
  });

  const { data: modelOptions = [], isSuccess: modelsReady } = useQuery(
    officeEquipmentModelPickerQuery(),
  );

  // Сохранённый срез мог пережить свой предмет: модель погасили и убрали из перечня (ADR 0139).
  usePruneMissingFilters(
    [{ key: 'modelId', value: params.modelId, options: modelOptions, ready: modelsReady }],
    (keys) =>
      setParams((p) => ({
        ...p,
        ...Object.fromEntries(keys.map((key) => [key, undefined])),
        page: 1,
      })),
  );

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  /*
   * Что здесь можно сделать со строкой (Р14). `onOpen` и `onDelete` не передаются вовсе: карточки
   * номенклатуры на этой двери нет, и кнопка, ведущая в её чтение, обещала бы вкладке ведение.
   * Потребность, наоборот, есть только здесь — в справочнике она стоит полем карточки.
   */
  const grid = {
    canManage,
    onStock: canStock ? setStockOf : undefined,
    onRequired: canManage ? setRequiredOf : undefined,
    onHistory: setHistoryOf,
  };
  const columns = officeEquipmentConsumableColumns(grid);

  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Сервер ищет по наименованию и коду сразу: спрашивают и «Pantum», и «Д0000337733».
        placeholder="Наименование или код"
        style={{ width: 240 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все модели"
        style={{ width: 240 }}
        options={modelOptions}
        value={params.modelId}
        onChange={(v: string | undefined) => applyFilter({ modelId: v })}
      />
      {/* Тот срез, ради которого на вкладку и заходят перед закупкой (Р15). «Нет в наличии» рядом —
          это другой вопрос: позиция с потребностью 20 и остатком 5 в наличии есть, а заказывать её
          надо; позиция с нулевой потребностью и пустой полкой в наличии отсутствует, а дефицита у
          неё нет — за ней не следят. */}
      <Checkbox
        checked={params.hasDeficit === 'true'}
        onChange={(e) => applyFilter({ hasDeficit: e.target.checked ? 'true' : undefined })}
      >
        Есть дефицит
      </Checkbox>
      <Checkbox
        checked={params.stock === 'out_of_stock'}
        onChange={(e) => applyFilter({ stock: e.target.checked ? 'out_of_stock' : undefined })}
      >
        Нет в наличии
      </Checkbox>
      <Checkbox
        checked={params.isActive === 'true'}
        onChange={(e) => applyFilter({ isActive: e.target.checked ? 'true' : undefined })}
      >
        Только активные
      </Checkbox>
      <FilterReset active={filtersActive} onClick={resetFilters} />
    </Space>
  );

  /** Те же срезы описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'modelId',
      label: 'Модель',
      value: params.modelId,
      options: modelOptions,
      placeholder: 'Все модели',
      onChange: (v) => applyFilter({ modelId: v }),
    },
    {
      kind: 'toggle',
      key: 'hasDeficit',
      label: 'Есть дефицит',
      value: params.hasDeficit === 'true',
      onChange: (v) => applyFilter({ hasDeficit: v ? 'true' : undefined }),
    },
    {
      kind: 'toggle',
      key: 'stock',
      label: 'Нет в наличии',
      value: params.stock === 'out_of_stock',
      onChange: (v) => applyFilter({ stock: v ? 'out_of_stock' : undefined }),
    },
    {
      kind: 'toggle',
      key: 'isActive',
      label: 'Только активные',
      value: params.isActive === 'true',
      onChange: (v) => applyFilter({ isActive: v ? 'true' : undefined }),
    },
  ];

  const toolbar = (
    <Space wrap>
      {canPurchase && (
        <Segmented<'items' | 'purchases'>
          value={view}
          options={[
            { value: 'items', label: 'Позиции' },
            { value: 'purchases', label: 'Закупки' },
          ]}
          onChange={setView}
        />
      )}
      {/* Кнопка стоит рядом с переключателем и видна из обеих половин: закупку заводят, глядя на
          дефицит, и уводить за ней в другой экран незачем (Р16). */}
      {canPurchase && (
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setPurchaseFormOpen(true)}>
          Плановая закупка
        </Button>
      )}
    </Space>
  );

  return (
    <>
      {view === 'purchases' && canPurchase ? (
        <PageTableLayout toolbar={toolbar}>
          <OfficeEquipmentPurchasesList onOpen={setOpenedPurchase} />
        </PageTableLayout>
      ) : (
        <PageTableLayout
          toolbar={toolbar}
          filters={filters}
          mobile={{
            search: {
              value: params.search,
              placeholder: 'Наименование или код',
              onChange: (v) => applyFilter({ search: v }),
            },
            filters: mobileFilters,
            sort: {
              options: sortOptionsFrom(columns, CONSUMABLE_SORT_LABELS),
              sortBy: params.sortBy,
              sortOrder: params.sortOrder,
              onChange: setSort,
            },
          }}
        >
          {/* Тело вкладки — своя колонка: `DataTable` меряет свой контейнер и считает по нему
              `scroll.y`, а стоя в одном потоке с подписью, намерил бы её высоту заодно. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
            {/* Две подписи одной строкой: обе объясняют колонки, которые иначе прочитают неверно —
                остаток («почему не правится прямо здесь») и счётчик парка («чей это парк»). */}
            <Typography.Text type="secondary" style={{ flex: '0 0 auto', fontSize: 12 }}>
              {STOCK_HINT} {PARK_COUNT_HINT}
            </Typography.Text>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <DataTable<OfficeEquipmentConsumableDto>
                columns={columns}
                card={officeEquipmentConsumableCard(grid)}
                data={data?.items ?? []}
                total={data?.total ?? 0}
                loading={isFetching}
                page={params.page}
                pageSize={params.pageSize}
                sortBy={params.sortBy}
                sortOrder={params.sortOrder}
                onChange={onTableChange}
              />
            </div>
          </div>
        </PageTableLayout>
      )}

      <OfficeEquipmentStockModal consumable={stockOf} onClose={() => setStockOf(null)} />
      <OfficeEquipmentStockHistoryModal consumable={historyOf} onClose={() => setHistoryOf(null)} />
      <OfficeEquipmentRequiredModal consumable={requiredOf} onClose={() => setRequiredOf(null)} />
      <OfficeEquipmentPurchaseFormModal
        open={purchaseFormOpen}
        purchase={null}
        onClose={() => setPurchaseFormOpen(false)}
        // Заведённая закупка открывается карточкой сразу: следующее действие — «Провести», и
        // искать её в списке после заведения человек не должен.
        onSaved={(saved) => setOpenedPurchase(saved.id)}
      />
      <OfficeEquipmentPurchaseViewModal
        purchaseId={openedPurchase}
        onClose={() => setOpenedPurchase(null)}
      />
    </>
  );
}
