import { Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  formatServiceRequestNumber,
  officeEquipmentStateLabels,
  officeEquipmentTitle,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type OfficeEquipmentDto,
  type OfficeEquipmentMovementDto,
  type OfficeEquipmentServiceEntryDto,
} from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { ViewModal } from '@shared/ui';
import { formatDate, formatMoney } from '../../utils/format';

/**
 * История единицы одной лентой (план модернизации, Р62): перемещения и ремонты вперемешку по
 * датам.
 *
 * Две ленты рядом читались бы как два независимых рассказа, а вопрос у смотрящего один — «что с
 * этим аппаратом было». Ровно поэтому строки сведены: «увезли в сервис» и «ремонт СО-14 на
 * 6 200 ₽» — соседние события одного дня, и разносить их по вкладкам значит заставлять человека
 * сопоставлять даты глазами.
 *
 * Ремонтная часть приходит с сервера только при праве модуля: у менеджера и диспетчера справочник
 * открыт, а обслуживание — нет, и лента у них состоит из одних перемещений.
 */

type Row =
  | { key: string; kind: 'movement'; on: string; movement: OfficeEquipmentMovementDto }
  | { key: string; kind: 'service'; on: string; service: OfficeEquipmentServiceEntryDto };

/** Куда переехала техника: место и состояние одной строкой — по ней её и ищут. */
function placeOf(objectLabel: string, location: string, state: string): string {
  return [objectLabel, location, state].filter(Boolean).join(' · ');
}

function movementText(m: OfficeEquipmentMovementDto): React.ReactNode {
  const from = placeOf(
    m.fromObject.code,
    m.fromLocation,
    m.fromState === 'on_site' ? '' : officeEquipmentStateLabels[m.fromState],
  );
  const to = placeOf(
    m.toObject.code,
    m.toLocation,
    m.toState === 'on_site' ? '' : officeEquipmentStateLabels[m.toState],
  );
  return (
    <div style={{ lineHeight: 1.4 }}>
      <div>
        {from} → <strong>{to}</strong>
      </div>
      <Typography.Text type="secondary">{m.reason}</Typography.Text>
      {m.serviceRequestNum !== null && (
        <>
          {' '}
          <Link to={`/office-equipment?tab=requests&id=${m.serviceRequestId}`}>
            {formatServiceRequestNumber(m.serviceRequestNum)}
          </Link>
        </>
      )}
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {m.movedByName}
          {m.toDepartment ? ` · отдел: ${m.toDepartment.name}` : ''}
        </Typography.Text>
      </div>
    </div>
  );
}

function serviceText(entry: OfficeEquipmentServiceEntryDto): React.ReactNode {
  return (
    <div style={{ lineHeight: 1.4 }}>
      <Space size={8} wrap>
        <Link to={`/office-equipment?tab=requests&id=${entry.id}`}>{entry.displayNumber}</Link>
        <Tag color={serviceRequestStatusColors[entry.status]}>
          {serviceRequestStatusLabels[entry.status]}
        </Tag>
        {entry.totalAmount !== null && <span>{formatMoney(entry.totalAmount)}</span>}
      </Space>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.serviceName ?? 'Сервис не назначен'}
          {entry.warranties.length > 0 &&
            ` · гарантия: ${entry.warranties.map((w) => w.name).join(', ')}`}
        </Typography.Text>
      </div>
    </div>
  );
}

export function EquipmentHistoryModal({
  equipment,
  onClose,
}: {
  /** `null` — окно закрыто. */
  equipment: OfficeEquipmentDto | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: officeEquipmentKeys.history(equipment?.id ?? ''),
    queryFn: () => officeEquipmentApi.history(equipment!.id),
    enabled: !!equipment,
  });

  const rows: Row[] = [
    ...(data?.movements ?? []).map((m) => ({
      key: `m-${m.id}`,
      kind: 'movement' as const,
      on: m.movedOn,
      movement: m,
    })),
    ...(data?.serviceHistory ?? []).map((entry) => ({
      key: `s-${entry.id}`,
      kind: 'service' as const,
      // Дата ремонта — день закрытия, а пока он идёт — день заведения: лента отвечает «когда это
      // случилось», и незакрытая заявка случилась в день, когда её завели.
      on: (entry.completedAt ?? entry.createdAt).slice(0, 10),
      service: entry,
    })),
  ].sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0));

  return (
    <ViewModal
      title={equipment ? `История · ${officeEquipmentTitle(equipment)}` : 'История'}
      open={!!equipment}
      onClose={onClose}
      width={760}
      destroyOnHidden
    >
      {isLoading ? (
        <Spin />
      ) : rows.length === 0 ? (
        <Empty description="Ни перемещений, ни ремонтов: карточку завели и с тех пор не трогали" />
      ) : (
        <Table<Row>
          size="small"
          rowKey="key"
          dataSource={rows}
          pagination={false}
          columns={[
            {
              key: 'on',
              title: 'Дата',
              width: 120,
              render: (_v, r) => formatDate(r.on),
            },
            {
              key: 'kind',
              title: 'Событие',
              width: 140,
              render: (_v, r) => (
                <Tag color={r.kind === 'movement' ? 'blue' : 'geekblue'}>
                  {r.kind === 'movement' ? 'Перемещение' : 'Обслуживание'}
                </Tag>
              ),
            },
            {
              key: 'what',
              title: 'Что произошло',
              render: (_v, r) =>
                r.kind === 'movement' ? movementText(r.movement) : serviceText(r.service),
            },
          ]}
        />
      )}
    </ViewModal>
  );
}
