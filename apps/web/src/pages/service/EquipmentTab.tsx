import { useState } from 'react';
import { Checkbox, Select, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  OFFICE_EQUIPMENT_STATES,
  OFFICE_EQUIPMENT_WARRANTY_FILTERS,
  officeEquipmentStateLabels,
  WARRANTY_EXPIRING_DAYS,
  type OfficeEquipmentDto,
  type OfficeEquipmentWarrantyFilter,
} from '@technic/contracts';
import {
  DataTable,
  FilterReset,
  PageTableLayout,
  sortOptionsFrom,
  type FilterDefinition,
} from '@shared/ui';
import { useListParams, usePruneMissingFilters } from '@shared/lib';
import {
  officeEquipmentApi,
  officeEquipmentCard,
  officeEquipmentColumns,
  officeEquipmentKeys,
  officeEquipmentTypeOptionsQuery,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { EquipmentMoveModal } from '@features/equipment-move';
import { EquipmentHistoryModal } from '@features/equipment-history';
import { useAuth } from '../../auth/AuthContext';

/**
 * Парк оргтехники в самом модуле (план `docs/office-equipment-mail-and-history-plan.md`, Р72–Р74).
 *
 * Отличается от вкладки справочника не данными, а вопросом. В справочнике карточку **ведут**:
 * заводят, правят реквизиты, отправляют в архив. Здесь технику **эксплуатируют** — смотрят, где
 * что стоит, что уехало в ремонт и по чему истекает гарантия, — и отсюда же записывают переезд и
 * открывают историю. Заведения и правки карточек здесь нет: две формы одной сущности разъехались
 * бы при первой правке.
 *
 * Срезы поэтому свои. «Без владельца» осталось справочнику: разметка парка — ведение. Зато здесь
 * есть состояние и «в ремонте без открытых заявок» — вопрос «а где вообще этот аппарат» задают
 * именно те, кто ведёт заявки.
 */

const warrantyFilterLabels: Record<OfficeEquipmentWarrantyFilter, string> = {
  active: 'Действует',
  expiring: `Истекает (${WARRANTY_EXPIRING_DAYS} дней)`,
  expired: 'Истекла',
};

const warrantyOptions = OFFICE_EQUIPMENT_WARRANTY_FILTERS.map((value) => ({
  value,
  label: warrantyFilterLabels[value],
}));

const stateOptions = OFFICE_EQUIPMENT_STATES.map((value) => ({
  value,
  label: officeEquipmentStateLabels[value],
}));

/** Срезы вкладки в параметрах списка; поиск, страница и сортировка сюда не заходят. */
interface EquipmentListFilters {
  objectId?: string;
  equipmentTypeId?: string;
  departmentId?: string;
  state?: string;
  strandedAtService?: string;
  warranty?: string;
}

/** Те же срезы перечнем: вкладка запоминает их между сеансами и снимает «Сбросить» (ADR 0139). */
const EQUIPMENT_FILTER_FIELDS = [
  'objectId',
  'equipmentTypeId',
  'departmentId',
  'state',
  'strandedAtService',
  'warranty',
] as const satisfies readonly (keyof EquipmentListFilters)[];

export function EquipmentTab() {
  const { can, user } = useAuth();
  // Переезд записывает тот, кто ведёт парк. Смотреть список и историю может каждый, кому открыт
  // справочник: «что с этим аппаратом было» — вопрос читателя.
  const canWrite = can('officeEquipment.write');

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } =
    useListParams<EquipmentListFilters>(
      {},
      {
        searchKeys: ['name'],
        filterKeys: EQUIPMENT_FILTER_FIELDS,
        // Парк смотрят кабинет за кабинетом и площадка за площадкой: срез здесь — рабочее место,
        // а не разовый вопрос (ADR 0139).
        persist: { scope: 'service-equipment', userId: user?.id },
      },
    );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentKeys.list(params),
    queryFn: () => officeEquipmentApi.list(params),
  });

  const {
    data: typeOptions = [],
    isLoading: typesLoading,
    isSuccess: typesReady,
  } = useQuery(officeEquipmentTypeOptionsQuery());
  const { data: objectOptions = [], isSuccess: objectsReady } = useQuery(
    objectOptionsQuery({ activeOnly: false }),
  );
  const { data: departmentOptions = [], isSuccess: departmentsReady } =
    useQuery(departmentOptionsQuery());

  /**
   * Сохранённый срез мог пережить свой предмет: площадку закрыли, отдел выключили, тип погасили
   * (ADR 0139). Такое значение в поле не прочитать, а список от него пуст — снимаем.
   */
  usePruneMissingFilters(
    [
      { key: 'objectId', value: params.objectId, options: objectOptions, ready: objectsReady },
      {
        key: 'equipmentTypeId',
        value: params.equipmentTypeId,
        options: typeOptions,
        ready: typesReady,
      },
      {
        key: 'departmentId',
        value: params.departmentId,
        options: departmentOptions,
        ready: departmentsReady,
      },
      { key: 'state', value: params.state, options: stateOptions, ready: true },
      { key: 'warranty', value: params.warranty, options: warrantyOptions, ready: true },
    ],
    (keys) =>
      setParams((p) => ({
        ...p,
        ...Object.fromEntries(keys.map((key) => [key, undefined])),
        page: 1,
      })),
  );

  const [moving, setMoving] = useState<OfficeEquipmentDto | null>(null);
  const [historyOf, setHistoryOf] = useState<OfficeEquipmentDto | null>(null);

  /**
   * «В ремонте, а открытых заявок нет» — срез «Требуют внимания» (Р61). Состояние он задаёт сам:
   * без «в ремонте» вопрос теряет смысл, а два фильтра, спорящих друг с другом, человек выставит
   * неверно раньше, чем поймёт правило.
   */
  const applyStranded = (checked: boolean) =>
    setParams((p) => ({
      ...p,
      strandedAtService: checked ? 'true' : undefined,
      state: checked ? 'at_service' : p.state,
      page: 1,
    }));

  const grid = {
    canWrite,
    onMove: setMoving,
    onHistory: setHistoryOf,
  };

  const filters = (
    <Space wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        value={params.objectId}
        onChange={(v) => setParams((p) => ({ ...p, objectId: v, page: 1 }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 180 }}
        loading={typesLoading}
        options={typeOptions}
        value={params.equipmentTypeId}
        onChange={(v) => setParams((p) => ({ ...p, equipmentTypeId: v, page: 1 }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все отделы"
        style={{ width: 220 }}
        options={departmentOptions}
        value={params.departmentId}
        onChange={(v) => setParams((p) => ({ ...p, departmentId: v, page: 1 }))}
      />
      <Select
        allowClear
        placeholder="Любое состояние"
        style={{ width: 190 }}
        options={stateOptions}
        disabled={params.strandedAtService === 'true'}
        value={params.state}
        onChange={(v) => setParams((p) => ({ ...p, state: v, page: 1 }))}
      />
      <Checkbox
        checked={params.strandedAtService === 'true'}
        onChange={(e) => applyStranded(e.target.checked)}
      >
        В ремонте без заявок
      </Checkbox>
      <Select
        allowClear
        placeholder="Любая гарантия"
        style={{ width: 200 }}
        options={warrantyOptions}
        value={params.warranty}
        onChange={(v) => setParams((p) => ({ ...p, warranty: v, page: 1 }))}
      />
      {/* Выход из набора одним движением: срез здесь переживает сеанс, и разбирать его шестью
          крестиками человек не должен (ADR 0139). */}
      <FilterReset active={filtersActive} onClick={resetFilters} />
    </Space>
  );

  /** Те же срезы описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      onChange: (v) => setParams((p) => ({ ...p, objectId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'equipmentTypeId',
      label: 'Тип',
      value: params.equipmentTypeId,
      options: typeOptions,
      loading: typesLoading,
      placeholder: 'Все типы',
      onChange: (v) => setParams((p) => ({ ...p, equipmentTypeId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'departmentId',
      label: 'Отдел',
      value: params.departmentId,
      options: departmentOptions,
      placeholder: 'Все отделы',
      onChange: (v) => setParams((p) => ({ ...p, departmentId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: stateOptions,
      placeholder: 'Любое состояние',
      disabled: params.strandedAtService === 'true',
      onChange: (v) => setParams((p) => ({ ...p, state: v, page: 1 })),
    },
    {
      kind: 'toggle',
      key: 'strandedAtService',
      label: 'В ремонте без заявок',
      value: params.strandedAtService === 'true',
      onChange: applyStranded,
    },
    {
      kind: 'select',
      key: 'warranty',
      label: 'Гарантия',
      value: params.warranty,
      options: warrantyOptions,
      placeholder: 'Любая гарантия',
      onChange: (v) => setParams((p) => ({ ...p, warranty: v, page: 1 })),
    },
  ];

  const columns = officeEquipmentColumns(grid);

  return (
    <>
      <PageTableLayout
        filters={filters}
        mobile={{
          search: {
            value: params.search,
            placeholder: 'Модель, серийный или инвентарный номер',
            onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
          },
          filters: mobileFilters,
          sort: {
            options: sortOptionsFrom(columns),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          },
        }}
      >
        <DataTable<OfficeEquipmentDto>
          columns={columns}
          card={officeEquipmentCard(grid)}
          data={data?.items ?? []}
          total={data?.total ?? 0}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          sortBy={params.sortBy}
          sortOrder={params.sortOrder}
          onChange={onTableChange}
        />
      </PageTableLayout>

      <EquipmentMoveModal equipment={moving} onClose={() => setMoving(null)} />
      <EquipmentHistoryModal equipment={historyOf} onClose={() => setHistoryOf(null)} />
    </>
  );
}
