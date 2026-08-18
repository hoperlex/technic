import { Space, Tag, type TableColumnsType } from 'antd';
import {
  mailingRunStatusColors,
  mailingRunStatusLabels,
  type MailingRunDto,
} from '@technic/contracts';
import { textColumn } from '@shared/ui';
import { formatDateTime } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';

/**
 * История запусков рассылки: чем кончился каждый её выход.
 *
 * Отдельно от списка расписаний, потому что отвечает на другой вопрос — не «что и кому уходит», а
 * «что уже ушло и почему не ушло остальное». Отсюда и всё своеобразие этих колонок: итоги приходят
 * нетипизированным `jsonb` и печатаются по ключам, границы окна берутся из самого запуска, а не
 * пересчитываются от сегодняшнего дня, и ручной запуск отличается от расписанного. Настройки
 * расписания ни одна из них не читает — общего у двух таблиц ровно ничего, кроме экрана.
 */

/**
 * Подписи итогов запуска. Письмо составляется не каждому, и три вида пропуска чинятся по-разному:
 * адрес заводят в справочнике, исключение снимают в расписании, а «нет рейсов» — не проблема вовсе.
 */
const STAT_LABELS: Record<string, string> = {
  sent: 'отправлено',
  withoutEmail: 'без адреса',
  excluded: 'исключены',
  empty: 'нет рейсов',
  reason: 'причина',
};

/**
 * Итоги приходят из `jsonb` нетипизированными: у выполненного запуска это счётчики, у пропущенного
 * — причина текстом. Известные поля печатаются подписями, незнакомые — ключом: промолчать о
 * непонятном итоге хуже, чем показать его как есть.
 */
function statsText(stats: Record<string, unknown>): string {
  const parts = Object.entries(stats).map(
    ([key, value]) => `${STAT_LABELS[key] ?? key}: ${String(value)}`,
  );
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export const mailingRunColumns: TableColumnsType<MailingRunDto> = [
  textColumn<MailingRunDto>({
    key: 'plannedAt',
    title: 'Запуск',
    dataIndex: 'plannedAt',
    sortable: false,
    searchable: false,
    width: 180,
    render: (_v, r) => (
      <Space size={4}>
        <span>{formatDateTime(r.plannedAt)}</span>
        {/* Ручной запуск в истории отличается от расписанного: по нему разбирают «почему письмо
            пришло дважды» и «кто отправил задание в воскресенье». */}
        {r.isManual ? <Tag>вручную</Tag> : null}
      </Space>
    ),
  }),
  textColumn<MailingRunDto>({
    key: 'status',
    title: 'Статус',
    dataIndex: 'status',
    sortable: false,
    searchable: false,
    width: 130,
    render: (_v, r) => (
      <Tag color={mailingRunStatusColors[r.status]}>{mailingRunStatusLabels[r.status]}</Tag>
    ),
  }),
  textColumn<MailingRunDto>({
    key: 'finishedAt',
    title: 'Завершён',
    dataIndex: 'finishedAt',
    sortable: false,
    searchable: false,
    width: 160,
    render: (_v, r) => (r.finishedAt ? formatDateTime(r.finishedAt) : '—'),
  }),
  textColumn<MailingRunDto>({
    key: 'period',
    title: 'Данные за',
    dataIndex: 'periodStart',
    sortable: false,
    searchable: false,
    width: 190,
    // Границы окна фиксируются в запуске: повтор упавшей вечерней рассылки обязан взять те же
    // дни, а не пересчитать окно от утра следующего.
    render: (_v, r) =>
      r.periodStart && r.periodEnd
        ? `${formatDateOnly(r.periodStart)} — ${formatDateOnly(r.periodEnd)}`
        : '—',
  }),
  textColumn<MailingRunDto>({
    key: 'stats',
    title: 'Итоги',
    dataIndex: 'stats',
    sortable: false,
    searchable: false,
    width: 320,
    render: (_v, r) => statsText(r.stats),
  }),
  textColumn<MailingRunDto>({
    key: 'error',
    title: 'Ошибка',
    dataIndex: 'error',
    sortable: false,
    searchable: false,
    width: 240,
    ellipsis: true,
    // Текст ошибки бывает длинным (ответ SMTP целиком) — целиком он остаётся подсказкой.
    render: (_v, r) => (r.error ? <span title={r.error}>{r.error}</span> : '—'),
  }),
];
