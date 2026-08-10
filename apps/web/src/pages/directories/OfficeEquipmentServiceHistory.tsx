import { Empty, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type OfficeEquipmentServiceEntryDto,
} from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys, WarrantyTag } from '@entities/office-equipment';
import { formatDate, formatMoney } from '../../utils/format';

/**
 * История обслуживания единицы и гарантии её ремонтов (§8.2).
 *
 * Секция отвечает на вопрос, с которого начинается работа с чужой техникой: чинили ли уже этот
 * аппарат, что в нём меняли и на что ещё действует гарантия. Без неё карточка знает про технику
 * всё, кроме единственного, ради чего её открывают перед назначением сервиса.
 *
 * Данные приходят карточкой с сервера (`GET /office-equipment/:id`), а не отдельным запросом в
 * раздел заявок: область у заявок своя (Р5), и собирать её на портале значило бы завести второе
 * правило видимости рядом с серверным. Поля `serviceHistory` в ответе нет вовсе, если у
 * смотрящего нет права модуля, — тогда секция не рисуется.
 */
export function OfficeEquipmentServiceHistory({ equipmentId }: { equipmentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: officeEquipmentKeys.detail(equipmentId),
    queryFn: () => officeEquipmentApi.get(equipmentId),
  });

  if (isLoading) return <Spin size="small" />;
  // Права нет — секции нет: пустой список сказал бы «ремонтов не было», а это другое утверждение.
  if (!data?.serviceHistory) return null;

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Обслуживание и гарантии
      </Typography.Title>
      {data.serviceHistory.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Заявок на обслуживание не было" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {data.serviceHistory.map((entry) => (
            <ServiceEntry key={entry.id} entry={entry} />
          ))}
        </Space>
      )}
    </>
  );
}

function ServiceEntry({ entry }: { entry: OfficeEquipmentServiceEntryDto }) {
  return (
    <div>
      <Space size={8} wrap>
        {/* Ссылка ведёт в раздел и открывает ту самую заявку (ADR 0074): «что там делали» читают
            в ней, а не в справочнике. */}
        <Link to={`/office-equipment?tab=requests&open=${entry.id}`}>{entry.displayNumber}</Link>
        <Tag color={serviceRequestStatusColors[entry.status]}>
          {serviceRequestStatusLabels[entry.status]}
        </Tag>
        <Typography.Text type="secondary">{formatDate(entry.createdAt)}</Typography.Text>
        {entry.serviceName && <Typography.Text>{entry.serviceName}</Typography.Text>}
        {entry.totalAmount !== null && (
          <Typography.Text strong>{formatMoney(entry.totalAmount)}</Typography.Text>
        )}
      </Space>
      {entry.warranties.map((warranty) => (
        <div key={warranty.itemId}>
          <Space size={6}>
            <Typography.Text type="secondary">{warranty.name}</Typography.Text>
            <WarrantyTag until={warranty.warrantyUntil} />
          </Space>
        </div>
      ))}
    </div>
  );
}
