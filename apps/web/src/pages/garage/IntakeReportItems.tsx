import { useState } from 'react';
import { Button, Empty, Space, Tag, Typography } from 'antd';
import { EditOutlined, SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  readingAnomalyLabels,
  type DriverReportDto,
  type ReadingAnomalyDto,
  type ReportItemDto,
  type VehicleReadingDto,
} from '@technic/contracts';
import { formatReading } from '@entities/vehicle-reading';
import { useAnomalyConfirm, type AnomalyCounter } from './intakeAnomalyConfirm';
import { IntakeShiftOrderModal } from './IntakeShiftOrderModal';

/**
 * Состав отчёта дня: строки ожидания с показаниями (ADR 0103; план «Показания техники», §7).
 *
 * Строка ожидания — это **выезд**, а не машина и не день: у одной машины за сутки бывает две
 * смены, и показание принадлежит той из них, в которой его сняли. Поэтому в подписи стоит источник
 * (рейс либо недельный ЭСМ-2) и позиция смены, а не одна только машина: без них разность соседних
 * снимков не к чему отнести.
 *
 * Числа показаны снимками, приросты — рядом и отдельно (ADR 0103). Хранится то, что списали с
 * прибора; «сколько проехали» — разность соседних снимков, и считает её сервер: портал приросты
 * только показывает и своих не выводит.
 *
 * Два действия строки живут здесь же, каждое при своём предмете:
 *
 * - **подтверждение аномалии** — при самой аномалии, по счётчику отдельно: неподтверждённая держит
 *   приём дня, и подписывают её там, где её видно (`intakeAnomalyConfirm`);
 * - **порядок смен** — при машине, один раз на машину, а не на строку: позиция принадлежит паре
 *   «машина + день», и переставляют её у дня целиком, даже если его половина лежит в чужом отчёте.
 */

const SHOWN_DATE = 'DD.MM.YYYY';
const SHOWN_TIME = 'DD.MM HH:mm';

const secondary = { fontSize: 12 } as const;

const blockStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: 12,
  border: '1px solid rgba(0, 0, 0, 0.06)',
  borderRadius: 8,
};

/** Одно число показания с его приростом. Прочерк — не ноль: счётчика могло не быть вовсе. */
function Counter({
  label,
  value,
  unit,
  delta,
}: {
  label: string;
  value: number | null;
  unit: string;
  /** Прирост к предшественнику, посчитанный сервером; `null` — начало ряда либо разрыв. */
  delta?: number | null;
}) {
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text type="secondary" style={secondary}>
        {label}
      </Typography.Text>
      {value === null ? (
        <Typography.Text type="secondary">—</Typography.Text>
      ) : (
        <span>{`${formatReading(value)} ${unit}`}</span>
      )}
      {/* Прирост подписан словом: голое «+240» рядом со снимком читается как второе показание. */}
      {delta != null && (
        <Typography.Text type="secondary" style={secondary}>
          {`прирост ${formatReading(delta)} ${unit}`}
        </Typography.Text>
      )}
    </Space>
  );
}

/**
 * Аномалия счётчика — та, которую записал СЕРВЕР при отправке (Р20), с тем значением, с которым
 * сравнивал. Неподтверждённая держит приём дня, и рядом с ней стоит подпись под ней: подтверждение
 * относится к строке и к счётчику, а не к дню.
 *
 * Подтверждённая кнопки не показывает: снять подпись отправкой нельзя — её снимает пересчёт
 * цепочки, когда концы интервала разошлись, — и кнопка «отменить» обещала бы действие, которого у
 * портала нет.
 */
function Anomaly({
  counter,
  source,
  anomaly,
  onConfirm,
  pending,
}: {
  counter: string;
  /** Источник строки: у дня несколько строк, и без него подпись называет счётчик, но не смену. */
  source: string;
  anomaly: ReadingAnomalyDto;
  onConfirm?: () => void;
  pending: boolean;
}) {
  const previous =
    anomaly.previousValue == null
      ? ''
      : `, предыдущее ${formatReading(anomaly.previousValue)}${
          anomaly.previousDate ? ` от ${dayjs(anomaly.previousDate).format(SHOWN_DATE)}` : ''
        }`;
  return (
    <Space size={6} wrap>
      <Tag
        color={anomaly.confirmed ? 'default' : 'orange'}
        style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}
      >
        {`${counter}: ${readingAnomalyLabels[anomaly.kind]}${previous} — ${
          anomaly.confirmed ? 'подтверждена' : 'не подтверждена'
        }`}
      </Tag>
      {onConfirm && !anomaly.confirmed && (
        <Button
          size="small"
          loading={pending}
          onClick={onConfirm}
          aria-label={`Подтвердить аномалию — ${counter}, ${source}`}
        >
          Подтвердить
        </Button>
      )}
    </Space>
  );
}

/** Показание строки: числа, аномалии, комментарий и кто его внёс. */
function Reading({
  item,
  reading,
  canWrite,
  onConfirm,
  pending,
}: {
  item: ReportItemDto;
  reading: VehicleReadingDto;
  canWrite: boolean;
  onConfirm: (counter: AnomalyCounter) => void;
  pending: boolean;
}) {
  return (
    <Space orientation="vertical" size={6} style={{ display: 'flex' }}>
      {reading.kind === 'no_data' ? (
        // «Нет данных» — это закрытие строки с причиной, а не пустое место (ADR 0103): причину
        // написал человек, и она показывается там же, где стояли бы числа.
        <Typography.Text>
          Нет возможности снять показания: {reading.noDataReason || 'причина не указана'}
        </Typography.Text>
      ) : (
        <Space size={24} wrap>
          <Counter
            label="Одометр"
            value={reading.odometerKm}
            unit="км"
            delta={reading.odometerDelta}
          />
          <Counter
            label="Моточасы"
            value={reading.engineHours}
            unit="ч"
            delta={reading.engineHoursDelta}
          />
          {/* Заправлено за смену, а не остаток и не расход (ADR 0103, решение 12). */}
          <Counter label="Заправлено" value={reading.fuelFilledLiters} unit="л" />
        </Space>
      )}

      {(reading.odometerAnomaly || reading.engineHoursAnomaly) && (
        <Space orientation="vertical" size={2} style={{ display: 'flex' }}>
          {reading.odometerAnomaly && (
            <Anomaly
              counter="Одометр"
              source={item.sourceLabel}
              anomaly={reading.odometerAnomaly}
              onConfirm={canWrite ? () => onConfirm('odometer') : undefined}
              pending={pending}
            />
          )}
          {reading.engineHoursAnomaly && (
            <Anomaly
              counter="Моточасы"
              source={item.sourceLabel}
              anomaly={reading.engineHoursAnomaly}
              onConfirm={canWrite ? () => onConfirm('engineHours') : undefined}
              pending={pending}
            />
          )}
        </Space>
      )}

      {reading.comment && <Typography.Text>{reading.comment}</Typography.Text>}

      <Typography.Text type="secondary" style={secondary}>
        {`${reading.source === 'staff' ? 'внесено персоналом' : 'передано водителем'} ${dayjs(
          reading.recordedAt,
        ).format(SHOWN_TIME)}`}
      </Typography.Text>
    </Space>
  );
}

export function IntakeReportItems({
  report,
  canWrite,
  onEdit,
}: {
  report: DriverReportDto;
  /** Право `vehicleReadings.write`: без него карточка остаётся читающей. */
  canWrite: boolean;
  onEdit: (item: ReportItemDto) => void;
}) {
  /** Машина, чей день переставляют: порядок смен принадлежит ей, а не строке и не отчёту. */
  const [ordering, setOrdering] = useState<{ id: string; label: string } | null>(null);
  const { confirm, pending } = useAnomalyConfirm(report);

  const items = report.items;
  if (items.length === 0) {
    // Отчёт без строк — законное состояние: источники дня отменили уже после того, как отчёт
    // открыли. Приёму такой день не подлежит, и об этом скажет блокер, а не пустота.
    return <Empty description="Строк в отчёте нет: выездов за этот день не осталось" />;
  }

  /*
   * Кнопка порядка смен ставится у первой строки каждой машины: день машины переставляют целиком,
   * и вторая такая же кнопка у соседней смены открывала бы то же самое окно.
   */
  const firstOfVehicle = new Map<string, string>();
  for (const item of items) {
    if (!firstOfVehicle.has(item.vehicleId)) firstOfVehicle.set(item.vehicleId, item.id);
  }

  return (
    <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
      {items.map((item) => (
        <div key={item.id} style={blockStyle}>
          <Space size={8} wrap style={{ justifyContent: 'space-between' }}>
            <Space orientation="vertical" size={0}>
              <Space size={6} wrap>
                <Typography.Text strong>{item.sourceLabel || '—'}</Typography.Text>
                {item.sourceKind === 'esm2' && <Tag style={{ marginInlineEnd: 0 }}>ЭСМ-2</Tag>}
                {/* Позиция смены — снимок, который человек исправляет (ADR 0103, решение 3): от
                    неё считаются приросты, и назначена она по номерам документов. */}
                <Tag style={{ marginInlineEnd: 0 }}>{`смена ${item.shiftOrder}`}</Tag>
              </Space>
              <Typography.Text type="secondary" style={secondary}>
                {item.vehicleLabel}
              </Typography.Text>
            </Space>
            <Space size={8}>
              {canWrite && firstOfVehicle.get(item.vehicleId) === item.id && (
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  onClick={() => setOrdering({ id: item.vehicleId, label: item.vehicleLabel })}
                  // Машина в подписи: у дня их несколько, и порядок переставляют у одной из них.
                  aria-label={`Порядок смен — ${item.vehicleLabel}`}
                >
                  Порядок смен
                </Button>
              )}
              {canWrite && (
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => onEdit(item)}
                  // Источник в подписи: у дня бывает несколько строк, и «Внести» без него называет
                  // действие, но не строку — ни на экране чтения, ни в тесте.
                  aria-label={`${item.reading ? 'Поправить' : 'Внести'} показание — ${item.sourceLabel}`}
                >
                  {item.reading ? 'Поправить' : 'Внести'}
                </Button>
              )}
            </Space>
          </Space>

          {item.reading ? (
            <Reading
              item={item}
              reading={item.reading}
              canWrite={canWrite}
              onConfirm={(counter) => confirm({ itemId: item.id, reading: item.reading!, counter })}
              pending={pending}
            />
          ) : (
            // Отсутствие показания — не то же самое, что «нет данных»: строка ждёт, и день с ней
            // не принимается. Слово «ждёт» здесь и есть ответ на вопрос «почему нельзя принять».
            <Typography.Text type="secondary">Показание не передано — строка ждёт</Typography.Text>
          )}
        </div>
      ))}

      {ordering && (
        <IntakeShiftOrderModal
          vehicleId={ordering.id}
          vehicleLabel={ordering.label}
          date={report.reportDate}
          onClose={() => setOrdering(null)}
        />
      )}
    </Space>
  );
}
