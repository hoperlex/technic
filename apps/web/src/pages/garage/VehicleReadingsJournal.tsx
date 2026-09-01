import { DatePicker, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnType } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  driverReportStateLabels,
  type ReadingAnomalyDto,
  readingAnomalyLabels,
  type VehicleReadingJournalRow,
} from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { DataTable, ViewModal } from '@shared/ui';
import { useIsMobile, useListParams } from '@shared/lib';
import { FilesCell } from '../../components/FileLinks';

/**
 * Журнал показаний машины (ADR 0103, Р27): день, смена, кто передал, три числа, разности по
 * каждому счётчику со своим предшественником, аномалии, фотографии и история правок.
 *
 * Окно читающее — правят показания в своём модуле, под `vehicleReadings.write` и с причиной. Гараж
 * показывает чужие данные ровно так же, как показывает рейсы и бланки (ADR 0076).
 *
 * Строка без показания из журнала не выпадает: «смена была, цифр нет» — это ответ, за которым сюда
 * и приходят, а список одних сданных смен отвечал бы на другой вопрос.
 *
 * Страницы серверные, как у любого списка портала (Р25): окно спрашивает страницу и показывает
 * общее число строк. Прежнее предупреждение «хвост периода не поместился» из окна ушло вместе с
 * пределом сервера — оно предлагало сузить период там, где спрашивают следующую страницу.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** Месяц назад от выбранного дня: журнал открывают вопросом «что было в этом месяце». */
const DEFAULT_DAYS = 30;

/**
 * Высота таблицы в окне. Задаётся явно, потому что у окна её нет: тело модального окна растёт по
 * содержимому, а `DataTable` считает от неё свою прокрутку — без числа таблица схлопнулась бы до
 * своего минимума. Доля экрана, а не пиксели: на ноутбуке окно и так упирается в высоту экрана.
 */
const TABLE_HEIGHT = 'min(60vh, 620px)';

/** События истории показания (`vehicle_reading_history`): свои слова каждому. */
const EVENT_LABELS: Record<string, string> = {
  created: 'передано',
  updated: 'исправлено',
  anomaly_confirmed: 'аномалия подтверждена',
  chain_relinked: 'пересчитана цепочка',
};

const secondary = { fontSize: 12 } as const;

/** Число с точностью до десятых и запятой: так его пишут в бланке и читают в отчёте. */
function decimal(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits).replace('.', ',');
}

/**
 * Аномалия счётчика (Р20). Неподтверждённая — красным: это и есть строка, с которой надо что-то
 * делать; подтверждённая остаётся в строке серой пометкой — «знаем, разобрались».
 */
function AnomalyTag({ anomaly }: { anomaly: ReadingAnomalyDto | null }) {
  if (!anomaly) return null;
  const previous =
    anomaly.previousValue === null
      ? 'предшественника нет'
      : `предыдущее ${decimal(anomaly.previousValue)}${
          anomaly.previousDate ? ` от ${dayjs(anomaly.previousDate).format(SHOWN_DATE)}` : ''
        }`;
  return (
    <Tooltip title={previous}>
      <Tag color={anomaly.confirmed ? 'default' : 'red'} style={{ marginInlineEnd: 0 }}>
        {readingAnomalyLabels[anomaly.kind]}
        {anomaly.confirmed ? ' · подтверждена' : ''}
      </Tag>
    </Tooltip>
  );
}

/** Снимок счётчика с приростом к предшественнику: разность считает сервер, окно её показывает. */
function CounterCell({
  value,
  delta,
  unit,
  anomaly,
}: {
  value: number | null;
  delta: number | null;
  unit: string;
  anomaly: ReadingAnomalyDto | null;
}) {
  if (value === null && !anomaly) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space orientation="vertical" size={0}>
      <span>{value === null ? '—' : `${decimal(value, unit === 'км' ? 0 : 1)} ${unit}`}</span>
      {/* Прочерк вместо прироста — начало ряда либо разрыв: догадка тут была бы хуже пустоты. */}
      <Typography.Text type="secondary" style={secondary}>
        {delta === null
          ? 'прирост неизвестен'
          : `+${decimal(delta, unit === 'км' ? 0 : 1)} ${unit}`}
      </Typography.Text>
      <AnomalyTag anomaly={anomaly} />
    </Space>
  );
}

/** История правок строки: кто, когда и с какой причиной трогал чужие числа (Р19). */
function EditsCell({ edits }: { edits: VehicleReadingJournalRow['edits'] }) {
  if (edits.length === 0) return null;
  return (
    <Popover
      trigger="click"
      content={
        <Space orientation="vertical" size={4} style={{ maxWidth: 320 }}>
          {edits.map((edit, index) => (
            <Typography.Text key={`${edit.changedAt}-${index}`} style={secondary}>
              {dayjs(edit.changedAt).format('DD.MM.YYYY HH:mm')} ·{' '}
              {EVENT_LABELS[edit.event] ?? edit.event} · {edit.changedByName}
              {edit.reason ? ` — ${edit.reason}` : ''}
            </Typography.Text>
          ))}
        </Space>
      }
    >
      <Tag style={{ cursor: 'pointer', marginInlineEnd: 0 }}>правок: {edits.length}</Tag>
    </Popover>
  );
}

/** Что со строкой: сдана, «нет данных» с причиной или ещё ждёт показания. */
function ReadingStateCell({ row }: { row: VehicleReadingJournalRow }) {
  if (!row.reading) return <Tag color="gold">не сдано</Tag>;
  if (row.reading.kind === 'no_data') {
    return (
      <Space orientation="vertical" size={0}>
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          нет данных
        </Tag>
        <Typography.Text type="secondary" style={secondary}>
          {row.reading.noDataReason}
        </Typography.Text>
      </Space>
    );
  }
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text type="secondary" style={secondary}>
        {row.reading.source === 'staff' ? 'внесено персоналом' : 'передано водителем'}
      </Typography.Text>
      {row.reading.comment ? (
        <Typography.Text type="secondary" style={secondary}>
          {row.reading.comment}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

const columns: TableColumnType<VehicleReadingJournalRow>[] = [
  {
    key: 'day',
    title: 'День',
    width: 130,
    render: (_v, r) => (
      <Space orientation="vertical" size={0}>
        <span>{dayjs(r.reportDate).format(SHOWN_DATE)}</span>
        <Typography.Text type="secondary" style={secondary}>
          смена {r.shiftOrder}
        </Typography.Text>
      </Space>
    ),
  },
  {
    key: 'source',
    title: 'Смена',
    width: 200,
    render: (_v, r) => (
      <Space orientation="vertical" size={0}>
        <Space size={6} wrap>
          <span>{r.sourceLabel || '—'}</span>
          {r.sourceKind === 'esm2' && <Tag>ЭСМ-2</Tag>}
        </Space>
        <Typography.Text type="secondary" style={secondary}>
          {r.personName}
        </Typography.Text>
        <Typography.Text type="secondary" style={secondary}>
          {driverReportStateLabels[r.reportState].toLowerCase()}
        </Typography.Text>
      </Space>
    ),
  },
  {
    key: 'odometer',
    title: 'Одометр',
    width: 150,
    render: (_v, r) => (
      <CounterCell
        value={r.reading?.odometerKm ?? null}
        delta={r.reading?.odometerDelta ?? null}
        unit="км"
        anomaly={r.reading?.odometerAnomaly ?? null}
      />
    ),
  },
  {
    key: 'engineHours',
    title: 'Моточасы',
    width: 150,
    render: (_v, r) => (
      <CounterCell
        value={r.reading?.engineHours ?? null}
        delta={r.reading?.engineHoursDelta ?? null}
        unit="м/ч"
        anomaly={r.reading?.engineHoursAnomaly ?? null}
      />
    ),
  },
  {
    key: 'fuel',
    // Заправлено за смену, а не остаток и не расход (Р28): портал называет ровно то, что считает.
    title: 'Заправлено',
    width: 110,
    render: (_v, r) =>
      r.reading?.fuelFilledLiters == null ? (
        <Typography.Text type="secondary">—</Typography.Text>
      ) : (
        `${decimal(r.reading.fuelFilledLiters)} л`
      ),
  },
  {
    key: 'state',
    title: 'Показание',
    render: (_v, r) => <ReadingStateCell row={r} />,
  },
  {
    key: 'files',
    title: 'Файлы',
    width: 110,
    render: (_v, r) => (
      <Space size={4} wrap>
        <FilesCell files={r.files} />
        <EditsCell edits={r.edits} />
      </Space>
    ),
  },
];

export function VehicleReadingsJournal({
  vehicleId,
  vehicleLabel,
  day,
  from,
  open,
  onClose,
}: {
  vehicleId: string;
  /** Подпись машины из строки списка: окно открывают из неё и закрывают, не уходя со среза. */
  vehicleLabel: string;
  /** Конец периода: у гаража это день среза, у карточки — конец её отрезка. */
  day: string;
  /**
   * Начало периода, если у зовущего оно своё. Гараж его не задаёт — там журнал открывают вопросом
   * «что было у этой машины в последнее время», и месяц назад от дня среза отвечает на него лучше
   * любого умолчания. Карточка задаёт: она живёт периодом, и журнал внутри неё, отсчитывающий свои
   * тридцать дней от `to`, показывал бы хвост квартала вместо квартала.
   */
  from?: string;
  open: boolean;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  /**
   * Период живёт в тех же параметрах, что и страница: они меняются вместе — другой отрезок
   * начинается с первой страницы, — и держать их в двух состояниях значило бы иметь два ответа на
   * вопрос «что сейчас показано».
   */
  const { params, setParams, onTableChange } = useListParams<{ from: string; to: string }>(
    { from: from ?? dayjs(day).subtract(DEFAULT_DAYS, 'day').format(DATE), to: day },
    { searchKeys: [] },
  );

  /*
   * Серверу уходит ровно период со страницей: сортировки и поиска у журнала нет — порядок строк
   * задан (свежее сверху), — и лишний параметр запроса обещал бы отбор, которого не происходит.
   */
  const query = { from: params.from, to: params.to, page: params.page, pageSize: params.pageSize };
  const { data, isFetching } = useQuery({
    queryKey: vehicleReadingKeys.journal(vehicleId, query),
    queryFn: () => vehicleReadingsApi.journal(vehicleId, query),
    // Окно открывают из строки списка: до открытия спрашивать журнал незачем.
    enabled: open,
  });

  /** Другой период — другие строки: третья страница прежнего отрезка означала бы уже не те смены. */
  const changePeriod = (from: string, to: string) => {
    setParams((prev) => ({ ...prev, from, to, page: 1 }));
  };

  const table = (
    <DataTable<VehicleReadingJournalRow>
      rowKey="itemId"
      columns={columns}
      data={data?.items ?? []}
      total={data?.total ?? 0}
      loading={isFetching}
      page={params.page}
      pageSize={params.pageSize}
      onChange={onTableChange}
    />
  );

  return (
    <ViewModal
      title={`Показания — ${vehicleLabel}`}
      open={open}
      onClose={onClose}
      width={1040}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
        <DatePicker.RangePicker
          format={SHOWN_DATE}
          allowClear={false}
          value={[dayjs(params.from), dayjs(params.to)]}
          onChange={(v) => {
            if (v?.[0] && v[1]) changePeriod(v[0].format(DATE), v[1].format(DATE));
          }}
        />

        {/* На телефоне список живёт своей раскладкой (`DataTable`), и чужая высота ему помешала бы. */}
        {isMobile ? table : <div style={{ height: TABLE_HEIGHT }}>{table}</div>}
      </Space>
    </ViewModal>
  );
}
