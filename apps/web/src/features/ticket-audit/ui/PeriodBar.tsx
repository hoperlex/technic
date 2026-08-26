import { DatePicker, Space, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { TicketAuditPeriod } from '@technic/contracts';
import { PERIOD_DATE, PERIOD_SUBJECTS, SHOWN_DATE, type PeriodSubject } from '../model/period';

/**
 * Период и дата начала сбора: обе подписи относятся ко всем числам под ними, поэтому стоят сверху.
 *
 * Полоса вынесена из сводки, когда экранов стало два: период у окна общий (это один отчёт,
 * показанный с разных сторон), и второй календарь, живущий своей копией кода, разошёлся бы с
 * первым — форматом, обязательностью или тем, что пишет в адрес.
 */
export function PeriodBar({
  period,
  onChange,
  collectingSince,
  subject = 'observations',
}: {
  period: TicketAuditPeriod;
  onChange: (period: TicketAuditPeriod) => void;
  /**
   * Дата начала сбора приходит только со сводкой. `undefined` — «экран её не знает», и подпись не
   * печатается вовсе: соврать «сбор не начинался» на экране, который об этом не спрашивал, хуже,
   * чем промолчать.
   */
  collectingSince?: string | null;
  /**
   * Чему принадлежат эти дни. Умолчание — наблюдения: так считают экраны метрик, сводка и когорты,
   * и подписывать их приходилось бы одинаково. Лента и точность называют своё явно — первая
   * отбирает по времени события, вторая по времени выдачи перепроверки (§1.3), — и подпись
   * единственное, чем эти различия видны. У состояния подсистемы полосы нет вовсе: периода у него
   * не существует, и календарь там обещал бы отбор, которого не бывает.
   */
  subject?: PeriodSubject;
}) {
  const shownSubject = PERIOD_SUBJECTS[subject];
  return (
    <Space size={12} wrap>
      {/* Подпись перед календарём, а не после: она называет, ЧТО отбирается этими днями, и
          прочитанная после дат уже не спасает — человек к тому времени решил, что видит. */}
      <Typography.Text>{shownSubject.label}</Typography.Text>
      <DatePicker.RangePicker
        format={SHOWN_DATE}
        // Период обязателен: сводка без него — числа неизвестно за что.
        allowClear={false}
        value={[dayjs(period.from), dayjs(period.to)]}
        onChange={(range) => {
          if (range?.[0] && range[1])
            onChange({ from: range[0].format(PERIOD_DATE), to: range[1].format(PERIOD_DATE) });
        }}
      />
      {/* Пояснение висит на поясе: там же, где спрашивают «а по какому времени». Текст свой у
          каждого предмета отбора — общий говорил бы про наблюдения и на ленте, где их нет. */}
      <Tooltip title={shownSubject.hint}>
        <Typography.Text type="secondary">Europe/Moscow</Typography.Text>
      </Tooltip>
      <CollectingSince value={collectingSince} periodFrom={period.from} />
    </Space>
  );
}

/**
 * «Сбор с ДД.ММ.ГГГГ» — обязательная подпись сводки: отчёт начинается не с начала работы портала,
 * а с первого наблюдения второй версии сбора. Всё, что собрано раньше, в метрики не идёт вовсе, и
 * не скажи мы этого — доли за старый период читались бы как посчитанные по всем талонам.
 */
function CollectingSince({
  value,
  periodFrom,
}: {
  value: string | null | undefined;
  periodFrom: string;
}) {
  if (value === undefined) return null;
  if (value === null)
    return <Typography.Text type="warning">Сбор наблюдений ещё не начинался</Typography.Text>;

  const since = dayjs(value);
  const shown = `Сбор с ${since.format(SHOWN_DATE)}`;
  // Начало периода раньше начала сбора — обычное дело на первых неделях модуля, и молчать об этом
  // нельзя: знаменатели тогда покрывают не весь выбранный период, а его хвост. Сравниваются
  // именно сутки: сервер вправе прислать момент, и «то же число, но 10 утра» больше не значит
  // «сбор начался позже периода».
  if (since.format(PERIOD_DATE) > periodFrom)
    return (
      <Tooltip title="Начало периода раньше начала сбора: числа ниже посчитаны только по той его части, что после этой даты">
        <Typography.Text type="warning">{shown}</Typography.Text>
      </Tooltip>
    );
  return <Typography.Text type="secondary">{shown}</Typography.Text>;
}
