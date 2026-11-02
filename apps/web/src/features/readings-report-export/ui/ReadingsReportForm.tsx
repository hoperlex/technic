import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Space, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { errorMessage } from '@shared/lib';

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** The server's ceiling (`MAX_PERIOD_DAYS`): a year. */
const MAX_DAYS = 366;

/** The current month up to today: the book is usually asked for the month in progress. */
function defaultPeriod(): [Dayjs, Dayjs] {
  return [dayjs().startOf('month'), dayjs().endOf('day')];
}

const SHEETS: [string, string][] = [
  [
    'Собственная',
    'строка на заявку за день: машина, водитель, объект или маршрут, задача с пометками, одометр и моточасы на начало и конец, пробег и моточасы за день; итоги над таблицей следуют фильтру.',
  ],
  [
    'Аренда',
    'арендная техника теми же строками: арендодатель, время смены, часы дня, ставка и стоимость.',
  ],
];

/**
 * The readings report (ADR 0240) for a period the person picks: the garage header's window and
 * the «Выгрузки» tab show the same form (ADR 0241), so the period rule and the composition are
 * written once.
 *
 * The composition is spelled out before the click: the book takes seconds to build and weighs
 * megabytes, and «download and look inside» is not a way to choose it.
 */
export function ReadingsReportForm() {
  const [period, setPeriod] = useState<[Dayjs, Dayjs]>(defaultPeriod);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [from, to] = period;
  const days = to.startOf('day').diff(from.startOf('day'), 'day') + 1;
  // Checked before the request with the server's number: a refusal after ten seconds of building
  // adds nothing to what the form can say at once.
  const tooLong = days > MAX_DAYS;

  const download = async () => {
    if (tooLong) return;
    setBusy(true);
    setFailure(null);
    try {
      await vehicleReadingsApi.adminExport({ from: from.format(DATE), to: to.format(DATE) });
    } catch (e: unknown) {
      // The refusal stays in the form, not in a toast: the server says «narrow the period» when
      // the rows exceed the limit, and that is read where the period is chosen.
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Книга Excel о работе техники по дням заявок за выбранный период, по образцу суточного
        отчёта. В книгу входит весь парк, и её период не зависит от дня, открытого в гараже.
      </Typography.Paragraph>

      <Space wrap align="end" size="middle">
        <label>
          <div style={{ marginBottom: 4 }}>Период</div>
          <DatePicker.RangePicker
            value={period}
            format={SHOWN_DATE}
            allowClear={false}
            onChange={(value) => {
              if (value?.[0] && value[1]) setPeriod([value[0], value[1]]);
            }}
          />
        </label>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={busy}
          disabled={tooLong}
          onClick={() => void download()}
        >
          Скачать книгу
        </Button>
      </Space>

      {tooLong && (
        <Alert
          type="warning"
          showIcon
          title="Период больше года"
          description="Выберите отрезок не длиннее 366 дней: книга собирается целиком в памяти сервера."
        />
      )}

      {failure && <Alert type="error" showIcon title={failure} />}

      <Card size="small" title="Что внутри книги">
        <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
          {SHEETS.map(([name, composition]) => (
            <div key={name}>
              <Typography.Text strong>{name}</Typography.Text>{' '}
              <Typography.Text type="secondary">— {composition}</Typography.Text>
            </div>
          ))}
        </Space>
      </Card>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Прочерк «—» — у показания нет этого счётчика; «Проверить» — конец меньше начала. Ни то, ни
        другое в итоги не входит.
      </Typography.Paragraph>
    </Space>
  );
}
