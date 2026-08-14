import { App, Button, Descriptions, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  equipmentHistoryKindColors,
  equipmentHistoryKindLabels,
  officeEquipmentStateLabels,
  officeEquipmentTitle,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type EquipmentHistoryEventDto,
  type OfficeEquipmentDto,
} from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys, WarrantyTag } from '@entities/office-equipment';
import { ViewModal } from '@shared/ui';
import { errorMessage, formatDate, formatMoney } from '../../../utils/format';
import { fieldLabels } from './fieldLabels';

/**
 * История единицы одной лентой (план `office-equipment-mail-and-history-plan.md`, Р75–Р82).
 *
 * Шесть источников приходят одним потоком: перемещения, заявки, их ключевые шаги, правки карточки,
 * гарантии и жизненный цикл самой карточки. Сшивать их здесь нечего и нельзя — у половины событий
 * нет времени, и порядок считает сервер; портал только рисует и просит следующую страницу.
 *
 * Шапка отвечает на вопрос, который задают до истории: где аппарат сейчас, за кем закреплён и до
 * какого числа действует гарантия. Без неё лента начинается с прошлого, а спрашивают обычно про
 * настоящее.
 */

/** Куда переехала техника: место и состояние одной строкой — по ней её и ищут. */
function placeOf(objectCode: string, location: string, state: string): string {
  return [objectCode, location, state].filter(Boolean).join(' · ');
}

function eventText(event: EquipmentHistoryEventDto): React.ReactNode {
  switch (event.kind) {
    case 'card_lifecycle':
      return (
        <span>
          {event.action === 'created'
            ? 'Карточка заведена'
            : event.action === 'archived'
              ? 'Карточка отправлена в архив'
              : 'Карточка восстановлена из архива'}
        </span>
      );

    case 'movement': {
      const from = placeOf(
        event.fromObject.code,
        event.fromLocation,
        event.fromState === 'on_site' ? '' : officeEquipmentStateLabels[event.fromState],
      );
      const to = placeOf(
        event.toObject.code,
        event.toLocation,
        event.toState === 'on_site' ? '' : officeEquipmentStateLabels[event.toState],
      );
      return (
        <div style={{ lineHeight: 1.4 }}>
          <div>
            {from} → <strong>{to}</strong>
          </div>
          <Typography.Text type="secondary">{event.reason}</Typography.Text>
          {event.serviceRequestNum !== null && (
            <>
              {' '}
              <Link to={`/office-equipment?tab=requests&id=${event.serviceRequestId}`}>
                СО-{event.serviceRequestNum}
              </Link>
            </>
          )}
          {event.toDepartmentName && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Отдел: {event.toDepartmentName}
              </Typography.Text>
            </div>
          )}
        </div>
      );
    }

    case 'service_request':
      return (
        <div style={{ lineHeight: 1.4 }}>
          <Space size={8} wrap>
            <Link to={`/office-equipment?tab=requests&id=${event.requestId}`}>
              {event.displayNumber}
            </Link>
            <Tag color={serviceRequestStatusColors[event.status]}>
              {serviceRequestStatusLabels[event.status]}
            </Tag>
            {event.totalAmount !== null && <span>{formatMoney(event.totalAmount)}</span>}
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {event.serviceName ?? 'Сервис не назначен'} · {event.description}
            </Typography.Text>
          </div>
        </div>
      );

    case 'service_step':
      return (
        <Space size={8} wrap>
          <Link to={`/office-equipment?tab=requests&id=${event.requestId}`}>
            {event.displayNumber}
          </Link>
          <Tag color={serviceRequestStatusColors[event.toStatus]}>
            {serviceRequestStatusLabels[event.toStatus]}
          </Tag>
          {event.comment && <Typography.Text type="secondary">{event.comment}</Typography.Text>}
        </Space>
      );

    case 'card_change':
      return (
        <div style={{ lineHeight: 1.4 }}>
          {event.changes.map((change) => (
            <div key={change.field}>
              <Typography.Text type="secondary">
                {fieldLabels[change.field] ?? change.field}:
              </Typography.Text>{' '}
              {change.from ?? '—'} → <strong>{change.to ?? '—'}</strong>
            </div>
          ))}
        </div>
      );

    case 'warranty':
      return (
        <div style={{ lineHeight: 1.4 }}>
          <div>
            {event.action === 'set' &&
              `Гарантия на «${event.subject}» до ${formatDate(event.until)}`}
            {event.action === 'moved' &&
              `Гарантия на «${event.subject}»: ${formatDate(event.from)} → ${formatDate(event.until)}`}
            {event.action === 'cleared' &&
              `Гарантия на «${event.subject}» снята (была до ${formatDate(event.from)})`}
            {event.action === 'expired' && `Гарантия на «${event.subject}» истекла`}
          </div>
          {event.displayNumber && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              заявка{' '}
              <Link to={`/office-equipment?tab=requests&id=${event.requestId}`}>
                {event.displayNumber}
              </Link>
            </Typography.Text>
          )}
        </div>
      );
  }
}

export function EquipmentHistoryModal({
  equipment,
  onClose,
}: {
  /** `null` — окно закрыто. */
  equipment: OfficeEquipmentDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();

  /**
   * Страницами, а не целиком: у единицы с десятью ремонтами в год лента за пять лет — сотни строк,
   * и грузить их разом ради первых десяти незачем. Курсор считает сервер; портал только передаёт
   * его обратно.
   */
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: officeEquipmentKeys.history(equipment?.id ?? ''),
    queryFn: ({ pageParam }) =>
      officeEquipmentApi.history(equipment!.id, pageParam ? { cursor: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!equipment,
  });

  const pages = data?.pages ?? [];
  const events = pages.flatMap((page) => page.items);
  // Ремонтная часть приходит с сервера только при праве модуля: у менеджера и диспетчера справочник
  // открыт, а обслуживание — нет, и лента у них состоит из перемещений и правок карточки.
  const serviceVisible = pages[0]?.serviceVisible ?? false;

  const exportHistory = () => {
    if (!equipment) return;
    void officeEquipmentApi
      .historyExport(equipment.id, officeEquipmentTitle(equipment))
      .catch((e: unknown) => message.error(errorMessage(e)));
  };

  return (
    <ViewModal
      title={equipment ? `История · ${officeEquipmentTitle(equipment)}` : 'История'}
      open={!!equipment}
      onClose={onClose}
      width={860}
      destroyOnHidden
    >
      {equipment && (
        <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="Где сейчас">
            {placeOf(
              `${equipment.object.code} — ${equipment.object.name}`,
              equipment.location,
              equipment.state === 'on_site' ? '' : officeEquipmentStateLabels[equipment.state],
            )}
            {equipment.stateNote ? ` (${equipment.stateNote})` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="Отдел">
            {equipment.department?.name ?? 'не закреплена'}
          </Descriptions.Item>
          <Descriptions.Item label="Гарантия">
            {equipment.warrantyUntil ? <WarrantyTag until={equipment.warrantyUntil} /> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Выгрузка">
            <Button size="small" icon={<DownloadOutlined />} onClick={exportHistory}>
              Скачать историю
            </Button>
          </Descriptions.Item>
        </Descriptions>
      )}

      {isLoading ? (
        <Spin />
      ) : events.length === 0 ? (
        <Empty
          description={
            serviceVisible
              ? 'Ни перемещений, ни ремонтов: карточку завели и с тех пор не трогали'
              : 'Перемещений и правок нет: карточку завели и с тех пор не трогали'
          }
        />
      ) : (
        <>
          <Table<EquipmentHistoryEventDto>
            size="small"
            rowKey="sortId"
            dataSource={events}
            pagination={false}
            columns={[
              { key: 'on', title: 'Дата', width: 110, render: (_v, r) => formatDate(r.occurredOn) },
              {
                key: 'kind',
                title: 'Событие',
                width: 150,
                render: (_v, r) => (
                  <Tag color={equipmentHistoryKindColors[r.kind]}>
                    {equipmentHistoryKindLabels[r.kind]}
                  </Tag>
                ),
              },
              { key: 'what', title: 'Что произошло', render: (_v, r) => eventText(r) },
              {
                key: 'who',
                title: 'Кто',
                width: 170,
                render: (_v, r) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.actorName ?? '—'}
                  </Typography.Text>
                ),
              },
            ]}
          />
          {hasNextPage && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Button onClick={() => void fetchNextPage()} loading={isFetchingNextPage}>
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}
    </ViewModal>
  );
}
