import { Badge, Checkbox, DatePicker, Input, Segmented, Select, Space } from 'antd';
import dayjs from 'dayjs';
import type { FilterDefinition } from '@shared/ui';
import type { UserAccountRegistryModel } from '../model/useUserAccountRegistry';

export function registryMobileFilters(model: UserAccountRegistryModel): FilterDefinition[] {
  const { params, applyFilter } = model;
  return [
    {
      kind: 'toggle',
      key: 'pending',
      label: 'Только ожидающие активации',
      value: model.showPending,
      onChange: model.setPending,
    },
    {
      kind: 'select',
      key: 'role',
      label: 'Роль',
      value: params.role,
      options: model.roleOptions,
      placeholder: 'Все роли',
      onChange: (role) => applyFilter({ role }),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Статус',
      value: params.isActive,
      options: model.statusOptions,
      placeholder: 'Активные и нет',
      onChange: (isActive) => applyFilter({ isActive }),
    },
    {
      kind: 'select',
      key: 'constructionObjectId',
      label: 'Объект',
      value: params.constructionObjectId,
      options: model.objectOptions,
      placeholder: 'Все объекты',
      loading: model.objectsLoading,
      onChange: (constructionObjectId) => applyFilter({ constructionObjectId }),
    },
    {
      kind: 'select',
      key: 'counterpartyId',
      label: 'Контрагент',
      value: params.counterpartyId,
      options: model.executorGroups,
      placeholder: 'Все контрагенты',
      loading: model.executorsLoading,
      onChange: (counterpartyId) => applyFilter({ counterpartyId }),
    },
    ...(model.showPending
      ? [
          {
            kind: 'select' as const,
            key: 'requestedRole',
            label: 'Пожелание при регистрации',
            value: params.requestedRole,
            options: model.requestedRoleOptions,
            placeholder: 'Любое пожелание',
            onChange: (requestedRole: string | undefined) => applyFilter({ requestedRole }),
          },
        ]
      : []),
    {
      kind: 'dateRange',
      key: 'createdAt',
      label: 'Зарегистрирован',
      from: params.createdFrom,
      to: params.createdTo,
      onChange: (createdFrom, createdTo) => applyFilter({ createdFrom, createdTo }),
    },
    ...(model.canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              applyFilter({ includeDeleted: checked ? 'true' : undefined }),
          },
        ]
      : []),
  ];
}

/** Desktop controls mirror the mobile filter sheet one for one. */
export function UserAccountRegistryFilters({ model }: { model: UserAccountRegistryModel }) {
  const { params, applyFilter } = model;
  return (
    <Space wrap size={8}>
      <Segmented
        value={model.showPending ? 'pending' : 'all'}
        onChange={(value) => model.setPending(value === 'pending')}
        options={[
          { value: 'all', label: 'Все' },
          {
            value: 'pending',
            label: (
              <Space size={6}>
                Ожидают активации
                {model.pending?.count ? <Badge count={model.pending.count} color="gold" /> : null}
              </Space>
            ),
          },
        ]}
      />
      <Input.Search
        allowClear
        placeholder="Email, ФИО или телефон"
        style={{ width: 240 }}
        defaultValue={params.search}
        onSearch={(search) => applyFilter({ search: search || undefined })}
      />
      <Select
        allowClear
        placeholder="Все роли"
        style={{ width: 190 }}
        options={model.roleOptions}
        value={params.role}
        onChange={(role: string | undefined) => applyFilter({ role })}
      />
      <Select
        allowClear
        placeholder="Активные и нет"
        style={{ width: 150 }}
        options={model.statusOptions}
        value={params.isActive}
        onChange={(isActive: string | undefined) => applyFilter({ isActive })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 220 }}
        options={model.objectOptions}
        loading={model.objectsLoading}
        value={params.constructionObjectId}
        onChange={(constructionObjectId: string | undefined) =>
          applyFilter({ constructionObjectId })
        }
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все контрагенты"
        style={{ width: 240 }}
        options={model.executorGroups}
        loading={model.executorsLoading}
        value={params.counterpartyId}
        onChange={(counterpartyId: string | undefined) => applyFilter({ counterpartyId })}
      />
      {model.showPending ? (
        <Select
          allowClear
          placeholder="Любое пожелание"
          style={{ width: 220 }}
          options={model.requestedRoleOptions}
          value={params.requestedRole}
          onChange={(requestedRole: string | undefined) => applyFilter({ requestedRole })}
        />
      ) : null}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Зарегистрирован с', 'по']}
        value={[
          params.createdFrom ? dayjs(params.createdFrom) : null,
          params.createdTo ? dayjs(params.createdTo) : null,
        ]}
        onChange={(range) =>
          applyFilter({
            createdFrom: range?.[0]?.format('YYYY-MM-DD'),
            createdTo: range?.[1]?.format('YYYY-MM-DD'),
          })
        }
      />
      {model.canSeeArchive ? (
        <Checkbox
          checked={params.includeDeleted === 'true'}
          onChange={(event) =>
            applyFilter({ includeDeleted: event.target.checked ? 'true' : undefined })
          }
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );
}
