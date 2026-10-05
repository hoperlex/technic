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
 * Vehicle type card (ADR 0016): the spec set and the categories — combinations of their values.
 * They share one card because they are one invariant: attaching a spec obliges every category to
 * have a value for it, and detaching changes them all at once. Each section owns its mutations and
 * their cache effect; the card only loads the data both read.
 */
export function VehicleTypeCardDrawer({ type, onClose }: Props) {
  const isMobile = useIsMobile();
  const typeId = type?.id ?? '';
  // The type leaves together with its specs and categories, so the classifier list goes stale as a
  // whole, not by one row. The same purge makes the server drop «нужна дополнительно» rows from
  // unapplied weekly requests — a purged position can no longer be ordered
  // (docs/adr/0085-weekly-vehicle-request.md, R15).
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
      // On a phone the card takes the whole screen: 960 px would shrink to the screen width anyway,
      // but with a side gap showing the list that is irrelevant right now (ADR 0030).
      size={isMobile ? '100%' : 960}
      destroyOnHidden
      // Permanent type deletion (docs/adr/0060-directory-record-purge.md) lives here, not in a list
      // row: the list is a flat classifier, and a type with categories has no row of its own there
      // (ADR 0028). The card also shows what leaves with the type: its specs and categories.
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
        {/* Document requisites of the type: the waybill blank (ADR 0065) and the site-order mode.
            They are edited in the directory form but asked about here — the card is already open
            for specs and categories, and «which waybill does this equipment run on» is answered
            in the same motion as «which categories does it have». */}
        {type ? (
          <Space size={16} wrap>
            <Typography.Text type="secondary">
              Путевой лист:{' '}
              <Typography.Text>{waybillFormLabels[type.waybillFormCode]}</Typography.Text>
            </Typography.Text>
            {/* Not «yes/no» but the consequence of the flag: the directory keeper needs to know
                «how will orders of this type run», and a bare «yes» does not say it. */}
            <Typography.Text type="secondary">
              Линейная техника:{' '}
              <Typography.Text>
                {type.isLinear ? 'да, заказы ведутся по дням' : 'нет'}
              </Typography.Text>
            </Typography.Text>
            {/* Requests caught by a flag switch (migration 0137, ADR 0107): they finish in the mode
                they were created with, and without this line the card would promise that the
                whole type runs the same way. Zero is not shown — that holds for every type never
                switched under running orders. */}
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
