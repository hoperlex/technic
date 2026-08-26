import type { Dispatch, SetStateAction } from 'react';
import { Checkbox, Input, Segmented, Select, Space } from 'antd';
import {
  type VehicleOwnership,
  vehicleOwnershipLabels,
  type VehicleStatus,
} from '@technic/contracts';
import type { BaseParams } from '@shared/lib';
import type { FilterDefinition } from '@shared/ui';

/**
 * Отбор справочника техники: принадлежность, тип, арендодатель, статус, поиск и архив.
 *
 * Вынесено из самой вкладки отдельным модулем (приём `OfficeEquipmentFilters`): отборов шесть, и
 * каждый живёт дважды — полосой на десктопе и описанием для шита на телефоне (ADR 0030). Во
 * вкладке при этом остаётся работа с данными: запросы, колонки, форма карточки, мутации и
 * подтверждения.
 *
 * Списки для селектов модуль не запрашивает, а получает готовыми: те же типы и арендодатели стоят
 * в форме карточки, и второй запрос за ними означал бы два ответа на один вопрос. По той же
 * причине готовыми приходят и наборы статусов: у аренды он свой (ADR 0018 §15), и разойтись
 * набору отбора с набором карточки нельзя.
 */

/** Отборы вкладки в параметрах списка; страница и сортировка сюда не заходят. */
export interface VehicleFilterParams {
  ownership?: VehicleOwnership;
  vehicleTypeId?: string;
  lessorId?: string;
  status?: VehicleStatus;
  includeDeleted?: string;
  // Статус и поиск задаются только панелью над таблицей: продублируй их выпадашкой столбца —
  // и любая сортировка сбрасывала бы выбранное (в onChange таблицы приходит пустой фильтр).
}

interface Option {
  value: string;
  label: string;
}

interface Args {
  params: BaseParams & VehicleFilterParams;
  /**
   * Тот же `setParams` вкладки, а не патч-функция: смена принадлежности читает прежний
   * `lessorId` из состояния, и делать это она обязана внутри обновления, а не по значению,
   * прочитанному отрисовкой.
   */
  setParams: Dispatch<SetStateAction<BaseParams & VehicleFilterParams>>;
  typeOptions: Option[];
  lessorOptions: Option[];
  lessorsLoading: boolean;
  statusOptions: { value: VehicleStatus; label: string }[];
  rentalStatusOptions: { value: VehicleStatus; label: string }[];
}

export function useVehicleFilters({
  params,
  setParams,
  typeOptions,
  lessorOptions,
  lessorsLoading,
  statusOptions,
  rentalStatusOptions,
}: Args) {
  const ownershipFilter = params.ownership;

  const filters = (
    <Space wrap>
      <Segmented<string>
        value={ownershipFilter ?? 'all'}
        options={[
          { value: 'all', label: 'Все' },
          { value: 'own', label: vehicleOwnershipLabels.own },
          { value: 'rental', label: vehicleOwnershipLabels.rental },
        ]}
        onChange={(v) =>
          setParams((p) => ({
            ...p,
            ownership: v === 'all' ? undefined : (v as VehicleOwnership),
            // Фильтр по арендодателю осмыслен только внутри аренды.
            lessorId: v === 'rental' ? p.lessorId : undefined,
            page: 1,
          }))
        }
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 200 }}
        options={typeOptions}
        value={params.vehicleTypeId as string | undefined}
        onChange={(v) => setParams((p) => ({ ...p, vehicleTypeId: v, page: 1 }))}
      />
      {ownershipFilter === 'rental' ? (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все арендодатели"
          style={{ width: 220 }}
          options={lessorOptions}
          value={params.lessorId}
          onChange={(v) => setParams((p) => ({ ...p, lessorId: v, page: 1 }))}
        />
      ) : null}
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 160 }}
        options={ownershipFilter === 'rental' ? rentalStatusOptions : statusOptions}
        value={params.status}
        onChange={(v) => setParams((p) => ({ ...p, status: v, page: 1 }))}
      />
      <Input.Search
        allowClear
        placeholder="Госномер / марка / арендодатель"
        style={{ width: 280 }}
        onSearch={(val) => setParams((p) => ({ ...p, search: val || undefined, page: 1 }))}
      />
      <Checkbox
        checked={params.includeDeleted === 'true'}
        onChange={(e) =>
          setParams((p) => ({
            ...p,
            includeDeleted: e.target.checked ? 'true' : undefined,
            page: 1,
          }))
        }
      >
        Показать архив
      </Checkbox>
    </Space>
  );

  /**
   * Те же фильтры описаниями — для шита на телефоне (ADR 0030). Принадлежность на десктопе —
   * переключатель на три положения; в шите это список с пустым значением «все», потому что
   * три кнопки во всю ширину заняли бы там целую строку ради одного выбора.
   */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'ownership',
      label: 'Принадлежность',
      value: ownershipFilter,
      options: [
        { value: 'own', label: vehicleOwnershipLabels.own },
        { value: 'rental', label: vehicleOwnershipLabels.rental },
      ],
      placeholder: 'Все',
      onChange: (v) =>
        setParams((p) => ({
          ...p,
          ownership: v as VehicleOwnership | undefined,
          // Фильтр по арендодателю осмыслен только внутри аренды.
          lessorId: v === 'rental' ? p.lessorId : undefined,
          page: 1,
        })),
    },
    {
      kind: 'select',
      key: 'vehicleTypeId',
      label: 'Тип ТС',
      value: params.vehicleTypeId as string | undefined,
      options: typeOptions,
      placeholder: 'Все типы',
      onChange: (v) => setParams((p) => ({ ...p, vehicleTypeId: v, page: 1 })),
    },
    ...(ownershipFilter === 'rental'
      ? [
          {
            kind: 'select' as const,
            key: 'lessorId',
            label: 'Арендодатель',
            value: params.lessorId,
            options: lessorOptions,
            placeholder: 'Все арендодатели',
            loading: lessorsLoading,
            onChange: (v: string | undefined) => setParams((p) => ({ ...p, lessorId: v, page: 1 })),
          },
        ]
      : []),
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: ownershipFilter === 'rental' ? rentalStatusOptions : statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) =>
        setParams((p) => ({ ...p, status: v as VehicleStatus | undefined, page: 1 })),
    },
    {
      kind: 'toggle',
      key: 'includeDeleted',
      label: 'Показывать архив',
      value: params.includeDeleted === 'true',
      onChange: (checked) =>
        setParams((p) => ({ ...p, includeDeleted: checked ? 'true' : undefined, page: 1 })),
    },
  ];

  return { filters, mobileFilters };
}
