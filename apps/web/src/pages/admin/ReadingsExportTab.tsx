import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Space, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { errorMessage } from '../../utils/format';

/**
 * Служебная выгрузка показаний автотранспорта (`docs/readings-admin-export-plan.md`, Р1).
 *
 * Вкладка администрирования, а не седьмая кнопка в гараже, и причин тому три. Право у книги своё
 * (`vehicleReadings.export`) — она сводит весь парк вместе с ФИО водителей и уходит письмом.
 * Период задаёт человек, а не экран: гаражные книги выгружают то, на что смотрят (Р29 плана
 * показаний), и второй период в том окне означал бы, что таблица и книга отвечают про разные
 * отрезки. И место расширяемо: следующая служебная выгрузка ляжет сюда же, а не расползётся
 * кнопками по модулям.
 *
 * Состав книги подписан прямо здесь, до нажатия: файл собирается секунды и весит мегабайты, и
 * «скачать и посмотреть, что внутри» — не тот способ выбирать выгрузку.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** Тот же потолок, что стоит на сервере (`MAX_PERIOD_DAYS`): год. */
const MAX_DAYS = 366;

/** Умолчание — прошедший месяц целиком: за него книгу и заказывают, когда месяц закрылся. */
function defaultPeriod(): [Dayjs, Dayjs] {
  const start = dayjs().startOf('month');
  return [start, dayjs().endOf('day')];
}

const SHEETS: [string, string][] = [
  [
    'Свод',
    'строка на машину: смены по плану и сколько отчитались, пробег, наработка, актуальные одометр и моточасы с датами, заправлено, расход, разрывы, аномалии, водители и нарекания. Строки без нареканий залиты зелёным и стоят сверху.',
  ],
  [
    'Детализация',
    'смены по каждой машине: заголовок с гос. номером и моделью, строки смен с приростами и топливом, итог по машине. Смены сворачиваются кнопкой слева.',
  ],
  [
    'Сводная',
    'готовая сводная таблица: техника по строкам, месяцы по колонкам, значения — пробег, заправлено, расход. Разрезы по водителю и типу техники собираются мышью.',
  ],
  [
    'Параметры',
    'период, кто и когда выгрузил, счётчики строк и правила, по которым считана книга.',
  ],
];

export function ReadingsExportTab() {
  const [period, setPeriod] = useState<[Dayjs, Dayjs]>(defaultPeriod);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [from, to] = period;
  const days = to.startOf('day').diff(from.startOf('day'), 'day') + 1;
  /**
   * Потолок проверяется до запроса — тем же числом, каким его проверяет сервер. Отказ, пришедший
   * после десяти секунд сборки, ничего не добавляет к тому, что видно в форме сразу.
   */
  const tooLong = days > MAX_DAYS;

  const download = async () => {
    if (tooLong) return;
    setBusy(true);
    setFailure(null);
    try {
      await vehicleReadingsApi.adminExport({ from: from.format(DATE), to: to.format(DATE) });
    } catch (e: unknown) {
      /*
       * Отказ остаётся во вкладке, а не улетает тостом: сервер отвечает «сузьте период», когда
       * строк детализации больше предела, — это указание, что делать дальше, и читать его надо
       * там же, где выбирают период.
       */
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Книга Excel по показаниям автотранспорта за выбранный период. В неё попадает техника, у
          которой в периоде были смены.
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
          Расход топлива считается как «остаток на начало + заправлено − остаток на конец» и только
          по сменам, где известны оба остатка; рядом с ним в книге стоит охват — сколько таких смен
          из скольких. Прочерк «—» означает «значение неизвестно» и в суммы не входит.
        </Typography.Paragraph>
      </Space>
    </div>
  );
}
