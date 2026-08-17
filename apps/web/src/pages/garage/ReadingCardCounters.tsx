import { Space, Typography } from 'antd';
import dayjs from 'dayjs';
import type { VehicleReadingCardDto } from '@technic/contracts';
import { ViewFields } from '@shared/ui';
import { decimal, kmText } from './readingNumbers';

/**
 * Шапка карточки машины: последние одометр и моточасы — **на конец выбранного периода** (Р16).
 *
 * Подпись про конец периода здесь обязательна, а не украшает. Число без неё читается как
 * сегодняшнее: карточка марта показывает мартовский одометр, и «128 400 км» у машины, которую с
 * тех пор гоняли всё лето, — это ответ про март, а выглядит как ответ про сейчас. Ту же цену имеет
 * дата снятия рядом с числом: у месяц простоявшего экскаватора последнее показание — с позапрошлой
 * смены, и без даты об этом узнают, только сверив пробег с путевым листом.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

const secondary = { fontSize: 12 } as const;

/**
 * Показание с датой снятия. Пусто — не ноль на приборе: снимка за машиной до конца периода не
 * числится вовсе, и догадка тут была бы хуже прочерка.
 */
function CounterValue({ text, measuredOn }: { text: string | null; measuredOn: string | null }) {
  if (text === null || measuredOn === null) {
    return <Typography.Text type="secondary">— снимков нет</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={0}>
      <span>{text}</span>
      <Typography.Text type="secondary" style={secondary}>
        снято {dayjs(measuredOn).format(SHOWN_DATE)}
      </Typography.Text>
    </Space>
  );
}

export function ReadingCardCounters({ card }: { card: VehicleReadingCardDto }) {
  const { lastOdometer, lastEngineHours } = card;

  return (
    <Space direction="vertical" size={6} style={{ display: 'flex' }}>
      <ViewFields
        items={[
          {
            key: 'odometer',
            label: 'Одометр на конец периода',
            children: (
              <CounterValue
                text={lastOdometer ? kmText(lastOdometer.km) : null}
                measuredOn={lastOdometer?.measuredOn ?? null}
              />
            ),
          },
          {
            key: 'engineHours',
            label: 'Моточасы на конец периода',
            children: (
              <CounterValue
                text={lastEngineHours ? `${decimal(lastEngineHours.value)} м/ч` : null}
                measuredOn={lastEngineHours?.measuredOn ?? null}
              />
            ),
          },
        ]}
      />
      <Typography.Text type="secondary" style={secondary}>
        Показания на {dayjs(card.to).format(SHOWN_DATE)} — это конец выбранного периода, а не
        сегодняшний день: снятое позже в карточку не попадает.
      </Typography.Text>
    </Space>
  );
}
