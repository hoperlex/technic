import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { UserAccountDto } from '@technic/contracts';
import { DataTable, PageTableLayout, sortOptionsFrom, type ActionSheetItem } from '@shared/ui';
import { useUserAccountRegistry } from '../model/useUserAccountRegistry';
import { registryMobileFilters, UserAccountRegistryFilters } from './UserAccountRegistryFilters';
import { userAccountRegistryCard } from './registryCard';
import { userAccountRegistryColumns, type ArchivedRowAction } from './registryColumns';

interface Props {
  create: () => void;
  edit: (record: UserAccountDto) => void;
  actionsFor: (record: UserAccountDto) => ActionSheetItem[];
  archivedActionsFor: (record: UserAccountDto) => ArchivedRowAction[];
}

/** Account list presentation; mutations enter through explicit action ports. */
export function UserAccountRegistry({ create, edit, actionsFor, archivedActionsFor }: Props) {
  const model = useUserAccountRegistry();
  const columns = userAccountRegistryColumns({ actionsFor, archivedActionsFor });
  const card = userAccountRegistryCard({ actionsFor, archivedActionsFor, edit });

  return (
    <PageTableLayout
      filters={<UserAccountRegistryFilters model={model} />}
      mobile={{
        search: {
          value: model.params.search,
          placeholder: 'Email, ФИО или телефон',
          onChange: (search) => model.applyFilter({ search }),
        },
        filters: registryMobileFilters(model),
        sort: {
          options: sortOptionsFrom(columns, { fullName: 'ФИО' }),
          sortBy: model.params.sortBy,
          sortOrder: model.params.sortOrder,
          onChange: model.setSort,
        },
        primaryAction: {
          label: 'Добавить пользователя',
          icon: <PlusOutlined />,
          onClick: create,
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={create}>
          Добавить
        </Button>
      }
    >
      <DataTable<UserAccountDto>
        columns={columns}
        card={card}
        data={model.data?.items ?? []}
        total={model.data?.total ?? 0}
        loading={model.isFetching}
        page={model.params.page}
        pageSize={model.params.pageSize}
        sortBy={model.params.sortBy}
        sortOrder={model.params.sortOrder}
        onChange={model.onTableChange}
      />
    </PageTableLayout>
  );
}
