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
 * Fleet filters: ownership, type, lessor, status, search and archive.
 *
 * Each filter exists twice—as a desktop control and a phone-sheet definition (ADR 0030)—so both
 * views are built together here. Lookup options are supplied by the registry query model instead
 * of fetched again, and status sets are shared with the editor because rental has its own lifecycle
 * (ADR 0018 §15).
 */

/** Registry filters carried in list params; pagination and sorting are supplied by the base type. */
export interface VehicleFilterParams {
  ownership?: VehicleOwnership;
  vehicleTypeId?: string;
  lessorId?: string;
  status?: VehicleStatus;
  includeDeleted?: string;
  // Status and search exist only in the toolbar. Mirroring them as column filters would make every
  // sort clear the value because Ant Table reports empty filters for absent column controls.
}

interface Option {
  value: string;
  label: string;
}

interface Args {
  params: BaseParams & VehicleFilterParams;
  /**
   * The registry's state setter, not a patch callback: changing ownership must read the current
   * lessor id inside the state update rather than from a potentially stale render.
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
            // A lessor filter has meaning only within rental offers.
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
   * The same filters described for the phone sheet (ADR 0030). Ownership is a three-way desktop
   * segment but a select with an empty “all” value on phones, where three full-width buttons would
   * consume an entire row for one choice.
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
          // A lessor filter has meaning only within rental offers.
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
