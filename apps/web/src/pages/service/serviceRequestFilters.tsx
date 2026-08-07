import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { SERVICE_REQUEST_STATUSES, serviceRequestStatusLabels } from '@technic/contracts';
import { serviceCompanyOptionsQuery } from '@entities/service-request';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import type { FilterDefinition } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';

const DATE = 'YYYY-MM-DD';

/**
 * Фильтры списка заявок на обслуживание — **одним описанием** на десктоп и телефон (§9.2).
 *
 * Обычно панель над таблицей собирается разметкой, а шит на телефоне — списком описаний, и две
 * копии расходятся при первой же правке: фильтр появляется на десктопе и не появляется в шите.
 * Здесь описание одно, а панель десктопа рисуется по нему же (`ServiceFilterBar`) — забыть
 * половину нельзя.
 */

export interface ServiceListFilters {
  status?: string;
  objectId?: string;
  departmentId?: string;
  serviceCounterpartyId?: string;
  equipmentTypeId?: string;
  /** Признаки-очереди: сервер ждёт строку `'true'`, отсутствие значит «не спрашивали». */
  waitingOnMe?: string;
  mine?: string;
  overdue?: string;
  awaitingDocuments?: string;
  warrantyClaim?: string;
  createdFrom?: string;
  createdTo?: string;
}

const statusOptions = SERVICE_REQUEST_STATUSES.map((value) => ({
  value,
  label: serviceRequestStatusLabels[value],
}));

/** Признак включён — уходит строкой; выключен — не уходит вовсе, а не приходит `'false'`. */
const flag = (checked: boolean) => (checked ? 'true' : undefined);

export function useServiceRequestFilters({
  params,
  apply,
}: {
  params: ServiceListFilters;
  apply: (patch: ServiceListFilters) => void;
}): FilterDefinition[] {
  const { can } = useAuth();

  const { data: objectOptions = [] } = useQuery(objectOptionsQuery({ activeOnly: false }));
  const { data: departmentOptions = [] } = useQuery(departmentOptionsQuery());
  const { data: serviceOptions = [], isFetching: servicesLoading } = useQuery(
    serviceCompanyOptionsQuery(),
  );
  // Перечень типов оргтехники закрыт правом справочника: сервису он недоступен вовсе (Р7), и
  // спрашивать его за него значило бы ловить 403 на каждом открытии списка.
  const { data: typeOptions = [] } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: can('officeEquipment.read'),
  });

  return [
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => apply({ status: v }),
    },
    {
      kind: 'toggle',
      key: 'waitingOnMe',
      label: 'Ждут меня',
      value: params.waitingOnMe === 'true',
      onChange: (v) => apply({ waitingOnMe: flag(v) }),
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
    {
      kind: 'select',
      key: 'serviceCounterpartyId',
      label: 'Сервис',
      value: params.serviceCounterpartyId,
      options: serviceOptions,
      loading: servicesLoading,
      placeholder: 'Все исполнители',
      onChange: (v) => apply({ serviceCounterpartyId: v }),
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
      key: 'mine',
      label: 'Мои заявки',
      value: params.mine === 'true',
      onChange: (v) => apply({ mine: flag(v) }),
    },
    {
      kind: 'toggle',
      key: 'overdue',
      label: 'Просроченные',
      value: params.overdue === 'true',
      onChange: (v) => apply({ overdue: flag(v) }),
    },
    {
      kind: 'toggle',
      key: 'awaitingDocuments',
      label: 'Ожидаются документы',
      value: params.awaitingDocuments === 'true',
      onChange: (v) => apply({ awaitingDocuments: flag(v) }),
    },
    {
      kind: 'toggle',
      key: 'warrantyClaim',
      label: 'Только гарантийные',
      value: params.warrantyClaim === 'true',
      onChange: (v) => apply({ warrantyClaim: flag(v) }),
    },
    {
      kind: 'dateRange',
      key: 'created',
      label: 'Период заведения',
      from: params.createdFrom,
      to: params.createdTo,
      onChange: (from, to) => apply({ createdFrom: from, createdTo: to }),
    },
  ];
}

/**
 * Один фильтр в панели десктопа. Обычная функция, а не компонент: она вызывается прямо из
 * разметки панели и своего состояния не имеет — объявленный внутри компонент пересоздавался бы
 * на каждый рендер и терял бы фокус поля при вводе.
 */
function renderFilter(filter: FilterDefinition): ReactNode {
  switch (filter.kind) {
    case 'select':
      return (
        <Select
          key={filter.key}
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder={filter.placeholder ?? filter.label}
          options={filter.options}
          loading={filter.loading}
          disabled={filter.disabled}
          value={filter.value}
          onChange={(v) => filter.onChange(v)}
        />
      );
    case 'text':
      return (
        <Input
          key={filter.key}
          allowClear
          style={{ width: 180 }}
          placeholder={filter.placeholder ?? filter.label}
          value={filter.value}
          onChange={(e) => filter.onChange(e.target.value || undefined)}
        />
      );
    case 'toggle':
      return (
        <Checkbox
          key={filter.key}
          checked={filter.value}
          disabled={filter.disabled}
          onChange={(e) => filter.onChange(e.target.checked)}
        >
          {filter.label}
        </Checkbox>
      );
    case 'dateRange':
      return (
        <DatePicker.RangePicker
          key={filter.key}
          format="DD.MM.YYYY"
          allowEmpty={[true, true]}
          value={[filter.from ? dayjs(filter.from) : null, filter.to ? dayjs(filter.to) : null]}
          onChange={(range) =>
            filter.onChange(
              range?.[0] ? range[0].format(DATE) : undefined,
              range?.[1] ? range[1].format(DATE) : undefined,
            )
          }
        />
      );
  }
}

/** Панель фильтров десктопа из тех же описаний, что уходят в шит телефона. */
export function ServiceFilterBar({ filters }: { filters: FilterDefinition[] }) {
  return <Space wrap>{filters.map(renderFilter)}</Space>;
}
