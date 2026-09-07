import { Button, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  equipmentHistoryKindColors,
  equipmentHistoryKindLabels,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type EquipmentHistoryEventDto,
} from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { formatDate, formatMoney } from '../../../utils/format';
import { fieldLabels } from './fieldLabels';
import { placeOf, stateOf } from './place';

/**
 * «Полная история» — та самая лента шести источников (план
 * `office-equipment-mail-and-history-plan.md`, Р75–Р82), ставшая четвёртой вкладкой окна (план
 * истории тремя блоками, Р11).
 *
 * ПЕРЕЕХАЛА ЦЕЛИКОМ И БЕЗ ПРАВОК, и это требование плана (К2): лента остаётся каноническим
 * аудитом — ни один источник не снят, ни одно событие не перестало показываться, — а три
 * бизнес-блока рядом отвечают на другие вопросы поверх тех же таблиц. Поэтому и запрос у неё
 * прежний (свой размер страницы, свой курсор, свой признак `serviceVisible`), а не общая механика
 * блоков: «то же самое, только через общий хук» — самый тихий способ незаметно изменить то, с чем
 * сверяются в споре.
 *
 * Шесть источников приходят одним потоком: перемещения, заявки, их ключевые шаги, правки карточки,
 * гарантии и жизненный цикл самой карточки. Сшивать их здесь нечего и нельзя — у половины событий
 * нет времени, и порядок считает сервер; портал только рисует и просит следующую страницу.
 */
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
      const from = placeOf(event.fromObject.code, event.fromLocation, stateOf(event.fromState, ''));
      const to = placeOf(event.toObject.code, event.toLocation, stateOf(event.toState, ''));
      return (
        <div style={{ lineHeight: 1.4 }}>
          <div>
            {from} → <strong>{to}</strong>
          </div>
          <Typography.Text type="secondary">{event.reason}</Typography.Text>
          {event.serviceRequestNum !== null && (
            <>
              {' '}
              {/* Параметр `open`, а не `id`: карточку по адресу открывает `useOpenedRecord`, и он
                  читает именно `open`. Прежние ссылки ленты вели «в никуда» — раздел открывался,
                  заявка нет; блоки истории с самого начала используют рабочий параметр. */}
              <Link to={`/office-equipment?tab=requests&open=${event.serviceRequestId}`}>
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
            <Link to={`/office-equipment?tab=requests&open=${event.requestId}`}>
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
          <Link to={`/office-equipment?tab=requests&open=${event.requestId}`}>
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
              <Link to={`/office-equipment?tab=requests&open=${event.requestId}`}>
                {event.displayNumber}
              </Link>
            </Typography.Text>
          )}
        </div>
      );
  }
}

export function FullHistoryBlock({ equipmentId }: { equipmentId: string }) {
  /**
   * Страницами, а не целиком: у единицы с десятью ремонтами в год лента за пять лет — сотни строк,
   * и грузить их разом ради первых десяти незачем. Курсор считает сервер; портал только передаёт
   * его обратно.
   */
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: officeEquipmentKeys.history(equipmentId),
    queryFn: ({ pageParam }) =>
      officeEquipmentApi.history(equipmentId, pageParam ? { cursor: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const pages = data?.pages ?? [];
  const events = pages.flatMap((page) => page.items);
  // Ремонтная часть приходит с сервера только при праве модуля: у менеджера и диспетчера справочник
  // открыт, а обслуживание — нет, и лента у них состоит из перемещений и правок карточки.
  const serviceVisible = pages[0]?.serviceVisible ?? false;

  if (isLoading) return <Spin />;
  if (events.length === 0)
    return (
      <Empty
        description={
          serviceVisible
            ? 'Ни перемещений, ни ремонтов: карточку завели и с тех пор не трогали'
            : 'Перемещений и правок нет: карточку завели и с тех пор не трогали'
        }
      />
    );

  return (
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
  );
}
