import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { DriverDto } from '@technic/contracts';
import { DataTable, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import { useDriverRegistry } from '../model/useDriverRegistry';
import type { DriverRegistryActions } from '../model/types';
import { useDriverRegistryFilters } from './DriverRegistryFilters';
import { driverRegistryCard } from './driverRegistryCard';
import { driverRegistryColumns } from './driverRegistryColumns';

interface Props extends DriverRegistryActions {
  canSeeArchive: boolean;
}

/** Driver list presentation; every write enters through an explicit action port. */
export function DriverRegistry({ canSeeArchive, ...actions }: Props) {
  const model = useDriverRegistry();
  const columns = driverRegistryColumns(model, actions);
  const card = driverRegistryCard(model, actions);
  const { filters, mobileFilters } = useDriverRegistryFilters({
    params: model.params,
    setParams: model.setParams,
    documentSetOptions: model.documentSetOptions,
    jobTitleOptions: model.jobTitleOptions,
    filterCategoryOptions: model.filterCategoryOptions,
    filterType: model.filterType,
    canSeeArchive,
    setDocuments: model.setDocuments,
    setJobTitle: model.setJobTitle,
    setCategory: model.setCategory,
  });

  return (
    <PageTableLayout
      filters={filters}
      // On a phone the directory is read as cards; search and sorting live in the panel (ADR 0042).
      mobile={{
        search: {
          value: model.params.search,
          // One field searches everything the card shows: the placeholder lists exactly what the
          // server parses, otherwise users never try a phone number there.
          placeholder: 'ФИО, СНИЛС или контакты',
          onChange: (search) => model.setParams((current) => ({ ...current, search, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: model.params.sortBy,
          sortOrder: model.params.sortOrder,
          onChange: model.setSort,
        },
        primaryAction: actions.canWrite
          ? {
              label: 'Добавить водителя',
              icon: <PlusOutlined />,
              onClick: actions.create,
            }
          : undefined,
      }}
      extra={
        actions.canWrite ? (
          // The HR file import moved to «Администрирование → Обмен справочниками» (ADR 0073): one
          // format and one entry point for all directories. Single-record creation stays here for
          // the dispatcher who has no exchange rights.
          <Button type="primary" icon={<PlusOutlined />} onClick={actions.create}>
            Добавить водителя
          </Button>
        ) : undefined
      }
    >
      <DataTable<DriverDto>
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
