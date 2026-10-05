import { useWeeklyRequestCreate } from '@features/weekly-request-create';
import {
  VehicleRequestFeed,
  useVehicleRequestFeedState,
  type VehicleRequestFeedActions,
} from '@widgets/vehicle-request-feed';
import { useVehicleRequestOperations } from './useVehicleRequestOperations';

/** Compose the feed with its independent command hosts and weekly-request entry point. */
export function VehicleRequestsTab() {
  const feed = useVehicleRequestFeedState();
  const operations = useVehicleRequestOperations();
  const weeklyCreate = useWeeklyRequestCreate();
  const actions: VehicleRequestFeedActions = {
    ...operations.actions,
    createWeekly: weeklyCreate.open,
    openWeekly: feed.openWeekly,
  };

  return (
    <VehicleRequestFeed
      rows={feed.rows}
      total={feed.total}
      loading={feed.loading}
      rights={{ ...feed.rights, ...operations.rights }}
      pending={operations.pending}
      actions={actions}
      filters={feed.filters}
      list={feed.list}
      summary={feed.summary}
    >
      {operations.node}
      {weeklyCreate.node}
    </VehicleRequestFeed>
  );
}
