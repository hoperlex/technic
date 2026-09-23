import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnType } from 'antd';
import {
  dayBatchOutcomeLabels,
  dayBatchRemainderMessage,
  type VehicleRequestDayBatchOutcome,
  type VehicleRequestDayBatchResultDto,
  type VehicleRequestDayBatchRowDto,
} from '@technic/contracts';
import { ViewModal } from '@shared/ui';
import { formatDateOnly } from './shared';

/**
 * Отчёт пачки «4-П на весь период» (ADR 0207 решение 7): что пачка сделала за каждый день срока.
 *
 * Таблицей, а не подтверждением `Modal.confirm`: строк бывает полсотни, и в них смешаны три разные
 * новости — рейс заведён, лист выписан, день пропущен с причиной. Список из пятидесяти предложений
 * в теле подтверждения не читается вовсе, а читать его обязательно: пропущенные дни диспетчер
 * доделывает руками, и другого места, где ему скажут какие, нет.
 *
 * Своим файлом от обоих окон, которые пачку зовут: отчёт один и тот же и у галочки принятия в
 * работу, и у кнопки таблицы дней. Показывается он **после** действия, когда первое окно уже
 * закрыто, — это не второй шаг формы, а квитанция.
 */

/**
 * Цвет исхода. `planned` и `issued` разделены не ради подробности: первый расходует строку рейса,
 * второй — ещё и номер бланка строгой отчётности, и в отчёте это разные новости.
 */
const outcomeColors: Record<VehicleRequestDayBatchOutcome, string> = {
  planned: 'blue',
  issued: 'green',
  skipped: 'gold',
  failed: 'red',
};

const columns: TableColumnType<VehicleRequestDayBatchRowDto>[] = [
  {
    key: 'date',
    title: 'День',
    width: 120,
    render: (_v, row) => formatDateOnly(row.date),
  },
  {
    key: 'outcome',
    title: 'Исход',
    width: 140,
    // Подписи — словарь контрактов: исходы там закрытым списком, и портал со своим переводом
    // молча разошёлся бы с ним, стоило серверу завести исход шестым.
    render: (_v, row) => (
      <Tag color={outcomeColors[row.outcome]} style={{ marginInlineEnd: 0 }}>
        {dayBatchOutcomeLabels[row.outcome]}
      </Tag>
    ),
  },
  {
    key: 'route',
    title: 'Рейс',
    width: 110,
    // У пропущенного дня здесь стоит тот рейс, который его не принял: без номера причина «в рейсе
    // не осталось строк задания» не говорит, в каком именно.
    render: (_v, row) => row.routeNumber ?? <Typography.Text type="secondary">—</Typography.Text>,
  },
  {
    key: 'waybill',
    title: 'Лист',
    width: 190,
    render: (_v, row) =>
      row.waybillNumber ?? <Typography.Text type="secondary">не выписан</Typography.Text>,
  },
  {
    key: 'reason',
    title: 'Причина',
    render: (_v, row) => (
      <Typography.Text type={row.outcome === 'failed' ? 'danger' : undefined}>
        {row.reason ?? ''}
      </Typography.Text>
    ),
  },
];

interface Props {
  /** Ответ пачки; `null` — показывать нечего, окно закрыто. */
  result: VehicleRequestDayBatchResultDto | null;
  onClose: () => void;
}

export function DayBatchReport({ result, onClose }: Props) {
  /*
   * Числа берутся из ответа, а не пересчитываются по строкам: сервер считает их по тому же циклу,
   * что и выписывает, а портал считал бы по показанным строкам. Разойдясь однажды (порция, обрыв
   * на полпути), шапка соврала бы именно там, где её читают вместо таблицы.
   */
  const summary = result
    ? [
        { label: 'Выписано листов', value: result.issued, color: 'green' },
        { label: 'Заведено рейсов', value: result.planned, color: 'blue' },
        { label: 'Пропущено', value: result.skipped, color: 'gold' },
        { label: 'Ошибок', value: result.failed, color: 'red' },
      ]
    : [];

  return (
    <ViewModal
      title="Выписка 4-П на период: что получилось"
      open={!!result}
      onClose={onClose}
      width={860}
      // Содержимое пересобирается при каждом открытии: вторая пачка — другой отчёт, и оставшаяся
      // от первой прокрутка таблицы показывала бы не те строки.
      destroyOnHidden
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Space size={[8, 8]} wrap>
          {summary.map((s) => (
            // Ноль показывается наравне с остальными: «пропущено 0» — это ответ, а пропавшая
            // строка читается как «не считали».
            <Tag key={s.label} color={s.value > 0 ? s.color : undefined}>
              {s.label}: {s.value}
            </Tag>
          ))}
        </Space>

        {result && result.remaining > 0 ? (
          // Остаток срока — теми же словами, какими портал обещал его до нажатия (ADR 0207
          // решение 11). Без этой строки «пачка кончилась» читается как «сделано всё», и
          // квартальный заказ остался бы наполовину непройденным молча.
          <Alert type="info" showIcon title={dayBatchRemainderMessage(result.remaining)} />
        ) : null}

        <Table
          rowKey="date"
          size="small"
          dataSource={result?.rows ?? []}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content', y: 420 }}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Пропущенные дни остаются за диспетчером: их ставят по одному в таблице «Дни работ», где
          видно, чем занят рейс машины на эту дату. Повторное нажатие пачки доберёт остаток.
        </Typography.Text>
      </div>
    </ViewModal>
  );
}
