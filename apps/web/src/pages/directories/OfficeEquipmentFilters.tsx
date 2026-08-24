import { Checkbox, Select, Space } from 'antd';
import {
  OFFICE_EQUIPMENT_WARRANTY_FILTERS,
  type OfficeEquipmentWarrantyFilter,
  WARRANTY_EXPIRING_DAYS,
} from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';

/**
 * Отбор справочника оргтехники: площадка, тип, отдел-владелец, гарантия и активность.
 *
 * Вынесено из самой вкладки отдельным модулем (приём `UserAuditFilters`): полей шесть, и каждое
 * живёт дважды — полосой на десктопе и описанием для шита на телефоне (ADR 0030). Во вкладке при
 * этом остаётся работа с данными: запросы, форма карточки, мутации и подтверждения удаления —
 * и читается она теперь без прокрутки через сто строк разметки.
 *
 * Данные для списков модуль не запрашивает, а получает готовыми: те же объекты и отделы стоят в
 * форме карточки, и второй запрос за ними означал бы два ответа на один вопрос.
 */

/** Три вопроса, которые задают справочнику про гарантию. Порог — общий с подсветкой (Р25). */
const warrantyFilterLabels: Record<OfficeEquipmentWarrantyFilter, string> = {
  active: 'Действует',
  expiring: `Истекает (${WARRANTY_EXPIRING_DAYS} дней)`,
  expired: 'Истекла',
};

const warrantyOptions = OFFICE_EQUIPMENT_WARRANTY_FILTERS.map((value) => ({
  value,
  label: warrantyFilterLabels[value],
}));

interface Option {
  value: string;
  label: string;
}

/** Отборы вкладки в параметрах списка; прочее (страница, сортировка) сюда не заходит. */
export interface OfficeEquipmentFilterParams {
  objectId?: string;
  equipmentTypeId?: string;
  departmentId?: string;
  unassignedDepartment?: string;
  warranty?: string;
  isActive?: string;
}

interface Args {
  params: OfficeEquipmentFilterParams;
  /** Смена любого отбора возвращает список на первую страницу — это делает вкладка. */
  apply: (patch: Partial<OfficeEquipmentFilterParams>) => void;
  objectOptions: Option[];
  typeOptions: Option[];
  typesLoading: boolean;
  departmentOptions: Option[];
}

export function useOfficeEquipmentFilters({
  params,
  apply,
  objectOptions,
  typeOptions,
  typesLoading,
  departmentOptions,
}: Args) {
  /**
   * Отдел и «без владельца» — один вопрос с двумя ответами, а не два фильтра: сервер их вместе не
   * принимает, да и смысла в «отдел АХО и при этом ничей» нет. Поэтому каждый гасит другой.
   */
  const applyDepartment = (v: string | undefined) =>
    apply({ departmentId: v, unassignedDepartment: undefined });
  const applyUnassigned = (checked: boolean) =>
    apply({ unassignedDepartment: checked ? 'true' : undefined, departmentId: undefined });

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
        onChange={(v) => apply({ objectId: v })}
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
        onChange={(v) => apply({ equipmentTypeId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все отделы"
        style={{ width: 220 }}
        options={departmentOptions}
        disabled={params.unassignedDepartment === 'true'}
        value={params.departmentId}
        onChange={applyDepartment}
      />
      <Checkbox
        checked={params.unassignedDepartment === 'true'}
        onChange={(e) => applyUnassigned(e.target.checked)}
      >
        Без владельца
      </Checkbox>
      <Select
        allowClear
        placeholder="Любая гарантия"
        style={{ width: 200 }}
        options={warrantyOptions}
        value={params.warranty}
        onChange={(v) => apply({ warranty: v })}
      />
    </Space>
  );

  /** Те же фильтры описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      onChange: (v) => apply({ objectId: v }),
    },
    {
      kind: 'select',
      key: 'equipmentTypeId',
      label: 'Тип',
      value: params.equipmentTypeId,
      options: typeOptions,
      loading: typesLoading,
      placeholder: 'Все типы',
      onChange: (v) => apply({ equipmentTypeId: v }),
    },
    {
      kind: 'select',
      key: 'departmentId',
      label: 'Отдел',
      value: params.departmentId,
      options: departmentOptions,
      placeholder: 'Все отделы',
      disabled: params.unassignedDepartment === 'true',
      onChange: applyDepartment,
    },
    {
      kind: 'toggle',
      key: 'unassignedDepartment',
      label: 'Без владельца',
      value: params.unassignedDepartment === 'true',
      onChange: applyUnassigned,
    },
    {
      kind: 'select',
      key: 'warranty',
      label: 'Гарантия',
      value: params.warranty,
      options: warrantyOptions,
      placeholder: 'Любая',
      onChange: (v) => apply({ warranty: v }),
    },
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
      onChange: (v) => apply({ isActive: v }),
    },
  ];
  return { filters, mobileFilters };
}
