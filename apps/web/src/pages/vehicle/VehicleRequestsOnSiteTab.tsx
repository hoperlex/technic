import { Empty } from 'antd';

/** Заглушка вкладки «На объекте» (§32): без сетевых запросов. */
export function VehicleRequestsOnSiteTab() {
  return (
    <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
      <Empty description="Учёт техники на объекте будет реализован на следующем этапе" />
    </div>
  );
}
