import { useState } from 'react';
import { Alert, DatePicker, Input, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  MAIL_ACCOUNTS,
  MAIL_KINDS,
  MAIL_STATUSES,
  mailAccountHints,
  mailAccountLabels,
  mailKindLabels,
  mailStatusColors,
  mailStatusLabels,
  type MailAccount,
  type MailKind,
  type MailLogItemDto,
  type MailStatus,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { useListParams } from '@shared/lib';
import { mailLogApi, mailLogKeys } from '@entities/mail-log';
import { formatDateTime } from '../../utils/format';
import { MailLogModal } from './MailLogModal';

/**
 * Журнал отправки писем (ADR 0199): что портал отправлял и чем это кончилось.
 *
 * Соседние подвкладки раздела отвечают на вопрос «как должно быть» — кому и когда уходит сводка, на
 * какой ящик идёт письмо события, включено ли событие вообще. Этот — на вопрос «как оказалось», и
 * до него ответ жил только в таблице `mail_messages`, то есть в запросе к базе. Пока письмо было
 * одно, задание водителю, это терпелось; с полным контуром модуля «Орг.техника» видов стало
 * двадцать, а вопрос «ушло ли письмо подрядчику» — ежедневным.
 *
 * **Канал — переключатель, а не фильтр со значением «любой».** `default` даёт сотни заданий
 * водителям за день, `repair` — десятки писем по заявкам оргтехники, и в общем списке вторые тонут
 * в первых ровно тогда, когда их ищут. Начинается вкладка с ящика службы ремонта: ради него её и
 * просили, а задания водителям разбирают по своей подвкладке запусков.
 *
 * **Строк отсюда не правят и писем не шлют.** Журнал показывает факт; повторную отправку письма
 * модуля делает кнопка в карточке заявки — она знает событие и якорь дедупликации, а строка очереди
 * помнит только их отпечаток.
 */

interface LogFilters {
  account: MailAccount;
  kind?: MailKind;
  status?: MailStatus;
  from?: string;
  to?: string;
}

/**
 * Границы периода — моментами, а не сутками: письма ложатся с точностью до секунды, и «за 17
 * сентября» — это промежуток от полуночи до полуночи в часовом поясе портала (МСК). Без пояса
 * граница уехала бы на часы: у сервера свой UTC, у браузера — свой.
 */
const dayStart = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).startOf('day').toISOString() : undefined;
const dayEnd = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).endOf('day').toISOString() : undefined;

export function MailLogBlock() {
  const { params, setParams, onTableChange } = useListParams<LogFilters>(
    { account: 'repair' },
    { searchKeys: [], filterKeys: ['account', 'kind', 'status', 'from', 'to'] },
  );
  /** Какое письмо открыто; `null` — модальное окно закрыто. */
  const [openId, setOpenId] = useState<string | null>(null);

  /** Любая правка отбора возвращает на первую страницу: та же страница при другом отборе — другие письма. */
  const applyFilter = (patch: Partial<LogFilters & { search: string }>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = { ...params, from: dayStart(params.from), to: dayEnd(params.to) };
  const { data, isFetching } = useQuery({
    queryKey: mailLogKeys.list(query),
    queryFn: () => mailLogApi.list(query),
  });

  const columns = [
    {
      key: 'createdAt',
      title: 'Когда',
      width: 170,
      sorter: true,
      defaultSortOrder: 'descend' as const,
      render: (_v: unknown, r: MailLogItemDto) => formatDateTime(r.createdAt),
    },
    {
      key: 'kind',
      title: 'Причина',
      width: 320,
      render: (_v: unknown, r: MailLogItemDto) => (
        <Space orientation="vertical" size={0}>
          <span>{mailKindLabels[r.kind]}</span>
          {/* Тема — подстрокой: в ней стоит номер заявки, и по ней письмо узнают в ящике. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.subject}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'toEmail',
      title: 'Получатель',
      sorter: true,
      render: (_v: unknown, r: MailLogItemDto) => r.toEmail,
    },
    {
      key: 'status',
      title: 'Состояние',
      width: 220,
      sorter: true,
      render: (_v: unknown, r: MailLogItemDto) => (
        <Space orientation="vertical" size={0}>
          <Tag color={mailStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
            {mailStatusLabels[r.status]}
          </Tag>
          {/* Отказ виден прямо в строке, одной строкой: ради него журнал чаще всего и открывают. */}
          {r.lastError ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis>
              {r.lastError}
            </Typography.Text>
          ) : null}
          {r.isTest ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              отладочное
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
        Аудит отправки
      </Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="Что здесь видно"
        description={
          'Каждое письмо, которое портал составил: когда, по какой причине, кому и чем кончилась ' +
          'доставка. «Ждёт отправки» — письмо в очереди, его заберёт ближайшая попытка; ' +
          '«Не отправлено» — почтовый сервер отказал, текст отказа виден в строке и в письме. ' +
          'Отправить письмо повторно отсюда нельзя: это делается из карточки заявки.'
        }
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<MailAccount>
          value={params.account}
          onChange={(v) => applyFilter({ account: v })}
          options={MAIL_ACCOUNTS.map((account) => ({
            value: account,
            label: mailAccountLabels[account],
            title: mailAccountHints[account],
          }))}
        />
        <Select<MailKind>
          allowClear
          aria-label="Причина"
          placeholder="Причина"
          style={{ width: 280 }}
          value={params.kind}
          onChange={(v) => applyFilter({ kind: v })}
          options={MAIL_KINDS.map((kind) => ({ value: kind, label: mailKindLabels[kind] }))}
        />
        <Select<MailStatus>
          allowClear
          aria-label="Состояние"
          placeholder="Состояние"
          style={{ width: 180 }}
          value={params.status}
          onChange={(v) => applyFilter({ status: v })}
          options={MAIL_STATUSES.map((status) => ({
            value: status,
            label: mailStatusLabels[status],
          }))}
        />
        <DatePicker.RangePicker
          allowEmpty={[true, true]}
          format="DD.MM.YYYY"
          value={[params.from ? dayjs(params.from) : null, params.to ? dayjs(params.to) : null]}
          onChange={(range) =>
            applyFilter({
              from: range?.[0]?.format('YYYY-MM-DD'),
              to: range?.[1]?.format('YYYY-MM-DD'),
            })
          }
        />
        <Input.Search
          allowClear
          placeholder="Адрес или тема"
          style={{ width: 260 }}
          defaultValue={params.search}
          onSearch={(v) => applyFilter({ search: v })}
        />
      </Space>

      <Table<MailLogItemDto>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data?.items ?? []}
        loading={isFetching}
        onChange={(pagination, _filters, sorter) => {
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          const order = s?.order === 'ascend' ? 'asc' : s?.order === 'descend' ? 'desc' : undefined;
          onTableChange({
            page: pagination.current ?? 1,
            pageSize: pagination.pageSize ?? params.pageSize,
            sortBy: order ? String(s?.columnKey ?? '') : undefined,
            sortOrder: order,
          });
        }}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: 'pointer' } })}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total: data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (total) => `Всего: ${total}`,
        }}
      />

      <MailLogModal id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
