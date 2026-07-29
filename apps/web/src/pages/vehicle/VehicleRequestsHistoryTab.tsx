import { Empty } from 'antd';

/**
 * Заглушка вкладки «История»: без сетевых запросов. История отдельной заявки живёт в её карточке
 * (ADR 0015), здесь будет общий журнал событий раздела.
 */
export function VehicleRequestsHistoryTab() {
  return (
    <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
      <Empty description="История заявок будет реализована на следующем этапе" />
    </div>
  );
}
