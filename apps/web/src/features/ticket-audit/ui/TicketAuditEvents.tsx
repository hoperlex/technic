import { Alert, App, Button, Empty, Pagination, Skeleton, Space, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TicketAuditEventsDto, TicketAuditPeriod } from '@technic/contracts';
import { ticketAuditEventsQuery, wasteTicketsApi } from '@entities/waste-ticket';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../../utils/format';
import { EVENTS_EXPORT_NOTE, FIRST_PAGE, ticketAuditEventsRequest } from '../model/eventFilters';
import { EVENTS_PERIOD_NOTE } from '../model/period';
import { useTicketAuditEvents } from '../model/useTicketAuditEvents';
import { EventFilters } from './EventFilters';
import { EventCards, EventTable } from './EventRows';
import { PeriodBar } from './PeriodBar';

/**
 * Лента событий (§5.3 плана): что происходило с прочитанными полями — по времени события.
 *
 * Показываются ВСЕ типы событий, а не одни правки: спор проходов и непрочитанное поле говорят о
 * промпте не меньше исправления, а отклонённое предложение — самый сильный отрицательный сигнал о
 * новой модели. Лента из одних правок отвечала бы на вопрос «где работал человек», а не «что путает
 * машина».
 *
 * ПЕРИОД ЗДЕСЬ ЗНАЧИТ ДРУГОЕ, чем на сводке и когортах, и подписан он поэтому «события за» (§1.3):
 * лента отбирает по времени СОБЫТИЯ, метрики — по времени наблюдения. Единственный такой экран в
 * разделе, и пояснение стоит под полосой периода постоянно, а не подсказкой.
 *
 * Состояний четыре — загрузка, ошибка, пусто, данные, — как и у соседей: «событий не было» и
 * «строк не пришло» отвечают на разные вопросы и не имеют права выглядеть одинаково.
 */
interface Props {
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  /** Окно открыто и право есть: закрытую ручку незачем спрашивать ради 403. */
  enabled: boolean;
}

export function TicketAuditEvents({ period, onPeriodChange, enabled }: Props) {
  const isMobile = useIsMobile();
  const { message } = App.useApp();
  const { filters, page, setFilters, setPage } = useTicketAuditEvents();

  // Один отбор на экран и на выгрузку: собран он в одном месте, и файл поэтому не может оказаться
  // не тем, что человек читал глазами (§4.3).
  const request = ticketAuditEventsRequest(period, filters, page);
  const { data, isLoading, isError, error, refetch } = useQuery(
    ticketAuditEventsQuery(request, enabled),
  );

  /**
   * Выгрузка — действие, а не запрос: она пишет след в журнал и кладёт файл на диск, поэтому
   * повторять её на перерисовке или кэшировать нельзя.
   *
   * Отказ показывается сообщением, а не молчанием: сервер отвечает 400, когда по отбору больше
   * 50 000 строк или период длиннее 92 дней, и текст отказа называет, что именно сузить. Молча
   * не начавшееся скачивание человек прочтёт как поломку портала.
   */
  const exportCsv = useMutation({
    mutationFn: () => wasteTicketsApi.auditEventsCsv(request),
    onError: (e: unknown) => message.error(errorMessage(e)),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <PeriodBar period={period} onChange={onPeriodChange} subject="events" />
        {/* Пояснение видно всегда: человек приходит сюда со сводки, где те же даты означают другое,
            и различие держится только на этих словах. */}
        <Typography.Text type="secondary">— {EVENTS_PERIOD_NOTE}</Typography.Text>
      </Space>

      <EventFilters filters={filters} onChange={setFilters} />

      <Space size={8} wrap>
        <Button
          icon={<DownloadOutlined />}
          loading={exportCsv.isPending}
          // Пустой отбор выгружать нечего: файл из одной шапки читается как сбой выгрузки.
          disabled={data !== undefined && data.total === 0}
          onClick={() => exportCsv.mutate()}
        >
          Выгрузить CSV
        </Button>
        {/* Подпись рядом с кнопкой, а не в подсказке: человек уносит файл с адресами площадок и
            фамилиями — он должен видеть это до нажатия, а не узнавать из журнала. */}
        <Typography.Text type="secondary" style={{ maxWidth: 520 }}>
          {EVENTS_EXPORT_NOTE}
        </Typography.Text>
      </Space>

      {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {isError ? (
        <Alert
          type="error"
          showIcon
          message="Лента не загрузилась"
          description={errorMessage(error)}
          // Кнопка, а не молчаливое повторение: сеть отвалилась на минуту — человек решает сам,
          // ждать ли ему ещё; журнал за прошедшие дни никуда не убежит.
          action={
            <Button size="small" onClick={() => void refetch()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {!isLoading && !isError && data ? (
        <EventsBody data={data} isMobile={isMobile} onPage={setPage} />
      ) : null}
    </Space>
  );
}

/** Данные и пустота. Разделены с загрузкой и ошибкой, чтобы каждое состояние читалось отдельно. */
function EventsBody({
  data,
  isMobile,
  onPage,
}: {
  data: TicketAuditEventsDto;
  isMobile: boolean;
  onPage: (page: number) => void;
}) {
  if (data.total === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Нет событий за период: по этому отбору в эти дни ничего не происходило"
      />
    );

  /*
   * Строк нет, а события есть: страница ушла за край выборки. Так бывает по пересланной ссылке —
   * `page=7` от отправителя, у которого отбор был шире. Это не пустой отбор, и печатать «ничего не
   * происходило» здесь значило бы соврать: события есть, просто не на этой странице.
   */
  if (data.rows.length === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`События кончились раньше этой страницы: всего их ${data.total}`}
      >
        <Button onClick={() => onPage(FIRST_PAGE)}>К первой странице</Button>
      </Empty>
    );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {isMobile ? <EventCards rows={data.rows} /> : <EventTable rows={data.rows} />}
      {/*
       * Постраничность общая для таблицы и карточек: страница приходит из ответа, а не из
       * состояния экрана, — сервер знает, сколько строк он отдал на самом деле.
       *
       * Размер страницы не переключается: он задан экрану (`EVENTS_PAGE_SIZE`), а кому нужен весь
       * отбор целиком, тот берёт выгрузку — она полная.
       */}
      <Pagination
        align="end"
        simple={isMobile}
        size={isMobile ? 'small' : undefined}
        current={data.page}
        pageSize={data.pageSize}
        total={data.total}
        showSizeChanger={false}
        showTotal={(total, range) => `${range[0]}–${range[1]} из ${total} событий`}
        onChange={onPage}
      />
    </Space>
  );
}
