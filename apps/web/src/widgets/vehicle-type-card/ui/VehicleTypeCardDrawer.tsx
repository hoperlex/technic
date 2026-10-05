import { Button, Drawer, Space, Tooltip, Typography } from 'antd';
import { DeleteFilled } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { waybillFormLabels, type VehicleTypeDto } from '@technic/contracts';
import {
  vehicleCategoryKeys,
  vehicleCategoriesApi,
  vehicleClassificationKeys,
  vehicleTypeKeys,
  vehicleTypeSpecKeys,
  vehicleTypesApi,
} from '@entities/vehicle-type';
import { weeklyRequestKeys } from '@entities/weekly-request';
import { usePurgeAction } from '@features/purge-record';
import { VehicleTypeCategoriesSection } from '@features/vehicle-category-management';
import { VehicleTypeSpecsSection } from '@features/vehicle-type-spec-management';
import { useIsMobile } from '@shared/lib';

interface Props {
  type: VehicleTypeDto | null;
  onClose: () => void;
}

/**
 * Keep required specs and their complete category tuples in one card because changing either side
 * changes the same classification invariant (ADR 0016).
 */
export function VehicleTypeCardDrawer({ type, onClose }: Props) {
  const isMobile = useIsMobile();
  const typeId = type?.id ?? '';
  const purge = usePurgeAction({
    subject: 'тип',
    purge: vehicleTypesApi.purge,
    invalidate: [vehicleClassificationKeys.root, vehicleTypeKeys.root, weeklyRequestKeys.root],
  });
  const specsQuery = useQuery({
    queryKey: vehicleTypeSpecKeys.byType(typeId),
    queryFn: () => vehicleTypesApi.specs(typeId),
    enabled: !!typeId,
  });
  const categoriesQuery = useQuery({
    queryKey: vehicleCategoryKeys.byType(typeId),
    queryFn: () =>
      vehicleCategoriesApi.list({
        vehicleTypeId: typeId,
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!typeId,
  });
  const specs = specsQuery.data ?? [];
  const categories = categoriesQuery.data?.items ?? [];

  return (
    <Drawer
      title={type ? `Тип ТС: ${type.name}` : ''}
      open={!!type}
      onClose={onClose}
      size={isMobile ? '100%' : 960}
      destroyOnHidden
      footer={
        type && !type.isActive && purge.allowed ? (
          <Button
            danger
            icon={<DeleteFilled />}
            loading={purge.pending}
            onClick={() => {
              onClose();
              purge.confirm(type.id, type.name);
            }}
          >
            Удалить тип окончательно
          </Button>
        ) : undefined
      }
    >
      <Space orientation="vertical" size="large" style={{ display: 'flex' }}>
        {type ? (
          <Space size={16} wrap>
            <Typography.Text type="secondary">
              Путевой лист:{' '}
              <Typography.Text>{waybillFormLabels[type.waybillFormCode]}</Typography.Text>
            </Typography.Text>
            <Typography.Text type="secondary">
              Линейная техника:{' '}
              <Typography.Text>
                {type.isLinear ? 'да, заказы ведутся по дням' : 'нет'}
              </Typography.Text>
            </Typography.Text>
            {type.frozenRequests > 0 ? (
              <Tooltip title="Признак переключили, когда эти заказы уже шли: до закрытия они ведутся так, как были заведены">
                <Typography.Text type="secondary">
                  Заявок на прежнем режиме: <Typography.Text>{type.frozenRequests}</Typography.Text>
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        ) : null}
        <VehicleTypeSpecsSection
          typeId={typeId}
          specs={specs}
          categoriesCount={categories.length}
          loading={specsQuery.isFetching}
        />
        <VehicleTypeCategoriesSection
          typeId={typeId}
          specs={specs}
          categories={categories}
          loading={categoriesQuery.isFetching}
        />
      </Space>
    </Drawer>
  );
}
