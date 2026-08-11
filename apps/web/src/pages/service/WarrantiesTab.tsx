import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { WARRANTY_EXPIRING_DAYS, type ServiceWarrantyRowDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { DataTable, PageTableLayout, sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { OPEN_PARAM } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { ServiceFilterBar } from './serviceRequestFilters';
import { warrantyCard, warrantyColumns } from './warrantyGrid';
import { ServiceRequestForm, type WarrantyClaimPreset } from './ServiceRequestForm';

interface WarrantyListFilters {
  objectId?: string;
  departmentId?: string;
  equipmentTypeId?: string;
  kind?: string;
  expiring?: string;
}

const KIND_OPTIONS = [
  { value: 'equipment', label: 'Только техника' },
  { value: 'repair', label: 'Только ремонты' },
];

/**
 * Реестр действующих гарантий (§9.5).
 *
 * Отвечает на свой вопрос — «что ещё покрыто», — и потому стоит отдельной вкладкой, а не колонкой
 * в списке заявок: там гарантия относится к заявке, здесь строка сама и есть гарантия, причём
 * гарантия поставщика существует и без единого ремонта.
 *
 * Реестр показывает только действующие: истёкшие — история, и в вопросе «за что не платить»
 * они лишь мешают. Порядок по умолчанию — «когда кончится», по возрастанию: реестр открывают
 * тем, что заканчивается ближе всего.
 *
 * Отсюда же заводится обращение по гарантии (Р26): только реестр знает `itemId` позиции прошлого
 * ремонта, а без него сервер обращение не примет — по построению, а не по забывчивости формы.
 */
export function WarrantiesTab() {
  const { can } = useAuth();
  const [, setSearchParams] = useSearchParams();

  const { params, setParams, setSort, onTableChange } = useListParams<WarrantyListFilters>(
    {},
    { searchKeys: ['equipment'] },
  );

  const sortBy = params.sortBy ?? 'warrantyUntil';
  const sortOrder = params.sortBy ? params.sortOrder : 'asc';
  const query = { ...params, sortBy, sortOrder };

  const { data, isFetching } = useQuery({
    queryKey: serviceRequestKeys.warranties(query),
    queryFn: () => serviceRequestsApi.warranties(query),
  });

  const { data: objectOptions = [] } = useQuery(objectOptionsQuery({ activeOnly: false }));
  const { data: departmentOptions = [] } = useQuery(departmentOptionsQuery());
  // Перечень типов закрыт правом справочника: сервису он недоступен (Р7), и спрашивать его за
  // него значило бы ловить 403 на каждом открытии вкладки.
  const { data: typeOptions = [] } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: can('officeEquipment.read'),
  });

  const apply = (patch: WarrantyListFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));

  const filters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'kind',
      label: 'Носитель',
      value: params.kind,
      options: KIND_OPTIONS,
      placeholder: 'Техника и ремонты',
      onChange: (v) => apply({ kind: v }),
    },
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
      key: 'departmentId',
      label: 'Отдел',
      value: params.departmentId,
      options: departmentOptions,
      placeholder: 'Все отделы',
      onChange: (v) => apply({ departmentId: v }),
    },
    ...(can('officeEquipment.read')
      ? [
          {
            kind: 'select' as const,
            key: 'equipmentTypeId',
            label: 'Тип техники',
            value: params.equipmentTypeId,
            options: typeOptions,
            placeholder: 'Все типы',
            onChange: (v: string | undefined) => apply({ equipmentTypeId: v }),
          },
        ]
      : []),
    {
      kind: 'toggle',
      key: 'expiring',
      label: `Истекает в ${WARRANTY_EXPIRING_DAYS} дней`,
      value: params.expiring === 'true',
      onChange: (v) => apply({ expiring: v ? 'true' : undefined }),
    },
  ];

  /** Обращение по гарантии, начатое строкой реестра: источник назван, и в форме он не правится. */
  const [claim, setClaim] = useState<WarrantyClaimPreset | null>(null);

  const openSourceRequest = (row: ServiceWarrantyRowDto) => {
    if (!row.requestId) return;
    setSearchParams({ tab: 'requests', [OPEN_PARAM]: row.requestId });
  };

  const grid = {
    canClaim: can('serviceRequests.create'),
    onClaim: (row: ServiceWarrantyRowDto) =>
      setClaim({
        equipmentId: row.equipmentId,
        source: row.kind === 'equipment' ? 'equipment' : 'item',
        itemId: row.itemId,
        subject: row.subject,
      }),
    onOpenRequest: openSourceRequest,
  };
  const columns = warrantyColumns(grid);

  return (
    <PageTableLayout
      filters={<ServiceFilterBar filters={filters} />}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Модель, инв. или серийный номер',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<ServiceWarrantyRowDto>
        columns={columns}
        card={warrantyCard(grid)}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onChange={onTableChange}
      />

      {/* Форма живёт здесь же: обращение по гарантии — обычная заявка, у которой заранее известен
          источник, и уводить человека на соседнюю вкладку ради неё незачем. */}
      <ServiceRequestForm
        open={!!claim}
        request={null}
        claim={claim}
        onClose={() => setClaim(null)}
      />
    </PageTableLayout>
  );
}
