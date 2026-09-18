import { Button, Descriptions, Empty, Spin, Table, Tag, Typography } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  componentLabels,
  deviceEventLabels,
  DEVICE_TELEMETRY_PAGE_SIZE,
  metricLabels,
  telemetrySourceLabels,
  type ComponentCode,
  type DeviceEventDto,
  type DeviceEventSeverity,
  type DeviceMetricValueDto,
  type MetricUnit,
} from '@technic/contracts';
import { deviceTelemetryApi, deviceTelemetryKeys } from '@entities/device-telemetry';
import { formatDateTime } from '../../../utils/format';

/**
 * Блок карточки «Показания и события» (план `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * Показывает две разные вещи и не смешивает их: СОСТОЯНИЕ («сколько напечатано, сколько осталось в
 * жёлтом») — последними значениями, и ПРОИСШЕСТВИЯ («замялась бумага, кончился тонер») — лентой.
 * Сложенные в одну таблицу, они заставили бы человека глазами отделять число от факта.
 *
 * ПУСТОЕ СОСТОЯНИЕ — ЗАКОННОЕ И ОБЯЗАТЕЛЬНОЕ. Блок встанет в карточки раньше, чем парк начнёт
 * слать письма, и большая часть аппаратов не пришлёт их никогда: почтовые уведомления умеют не
 * все, а профиль написан пока под один вендор. Пустая таблица без слов читалась бы как поломка
 * портала, поэтому здесь сказано ровно то, что есть: аппарат ещё не присылал писем.
 */
export function DeviceTelemetryBlock({ equipmentId }: { equipmentId: string }) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: deviceTelemetryKeys.card(equipmentId, DEVICE_TELEMETRY_PAGE_SIZE),
    queryFn: ({ pageParam }) =>
      deviceTelemetryApi.card(
        equipmentId,
        pageParam
          ? { cursor: pageParam, pageSize: DEVICE_TELEMETRY_PAGE_SIZE }
          : { pageSize: DEVICE_TELEMETRY_PAGE_SIZE },
      ),
    initialPageParam: '',
    // `nextCursor: null` — дальше ничего нет; `undefined` для react-query значит то же самое.
    getNextPageParam: (last) => last.events.nextCursor ?? undefined,
  });

  const pages = data?.pages ?? [];
  /*
   * Метрики берутся ИЗ ПЕРВОЙ страницы, а не из последней и не объединением всех.
   *
   * Ручка одна на состояние и на ленту (так устроен `DeviceTelemetryCardDto`), поэтому каждая
   * догруженная страница ленты приносит свежий снимок метрик заодно. Взять последний значило бы
   * менять числа на экране от нажатия «Показать ещё» — человек читал бы это как изменение
   * показаний, а не как то, чем оно является: повторным ответом на тот же вопрос.
   */
  const metrics = pages[0]?.metrics ?? [];
  const events = pages.flatMap((page) => page.events.items);

  if (isLoading) return <Spin size="small" />;

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Показания и события
      </Typography.Title>
      {metrics.length === 0 && events.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={TELEMETRY_EMPTY_TEXT} />
      ) : (
        <>
          <MetricsView metrics={metrics} />
          <EventsFeed
            events={events}
            hasMore={hasNextPage}
            loadingMore={isFetchingNextPage}
            loadMore={() => void fetchNextPage()}
          />
        </>
      )}
    </>
  );
}

/**
 * «Аппарат ещё не присылал писем», а не «данных нет».
 *
 * Разница несущая: «данных нет» человек читает как «портал потерял», а здесь названа причина — и
 * названа так, что из неё понятно, что делать (настроить уведомления на аппарате), и что делать
 * не нужно (звонить в поддержку портала).
 */
export const TELEMETRY_EMPTY_TEXT = 'Аппарат ещё не присылал писем';

/**
 * ПОДПИСИ ЕДИНИЦ ЖИВУТ ЗДЕСЬ ВРЕМЕННО, и это долг, а не решение.
 *
 * Единица — свойство метрики, и реестр `metricUnits` объявлен в контракте; подписей к нему там нет
 * (файл заморожен на время волны). Без них число стояло бы голым: «12 480» ничего не говорит, а
 * «12 480 оттисков» отвечает на вопрос, ради которого в блок и смотрят. Предложение перенести
 * словарь в контракт уехало отчётом пакета — до переноса это единственная копия, и второй быть не
 * должно.
 */
const UNIT_LABELS: Record<MetricUnit, string> = {
  impressions: 'оттисков',
  sheets: 'листов',
  pages: 'страниц',
  percent: '%',
  count: 'раз',
};

/**
 * ЧИСЛО БЕЗ ХВОСТА НУЛЕЙ, и обрезает его портал.
 *
 * `value` приходит строкой из `numeric(18,3)` — «200.000», «40.000», — и напечатанное дословно
 * читается как точность, которой нет: «200.000 оттисков» человек прочитает как двести тысяч.
 * Дробная часть в этой колонке существует ради одного — процентов остатка тонера, — и «40.5 %»
 * показать надо, а «40.000 %» нет.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В РУЧКЕ. Масштаб колонки — решение схемы, а «сколько знаков показать
 * человеку» — правило показа, из того же семейства, что `formatDateTime`. Обрежь его сервер, и
 * портал всё равно остался бы обязан пережить «40.000» от любого другого писателя (ручной ввод,
 * пачка коллектора), только проверять это было бы уже нечем.
 *
 * Строкой, а не через `Number`: счётчик за жизнь аппарата — восемнадцать знаков, и `number`
 * потерял бы точность ровно там, где эта колонка и заведена широкой.
 */
export function formatMetricValue(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+\.\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/\.?0+$/, '');
}

/**
 * Последние значения — списком «подпись: число», а не таблицей: строк обычно пять-восемь, и
 * заголовки колонок заняли бы больше места, чем сами данные.
 *
 * ПОДПИСЬ СОБИРАЕТСЯ ИЗ ДВУХ СЛОВАРЕЙ КОНТРАКТА — метрики и разреза (Р33): «Остаток расходника»
 * без разреза у цветного аппарата стояло бы четырьмя одинаковыми строками с разными числами.
 * Запасной вариант — сырой код: словари пополняются по ходу пилота, и строка, чьего кода в них ещё
 * нет, обязана быть видна, а не исчезнуть.
 *
 * ОТМЕТКА У ПОКАЗАНИЯ — ПРИЁМ ПОРТАЛОМ, А НЕ ВРЕМЯ АППАРАТА, И ЭТО РАЗВИЛКА, РЕШЁННАЯ ЗДЕСЬ.
 *
 * Р21 говорит прямо: для счётчика момент не важен, а для события важен предельно, — и время
 * аппарата лента показывает потому, что событие случилось В ТОТ момент. У показания вопрос другой:
 * «насколько свежее это число», то есть «когда мы его узнали». Часы МФУ без NTP уходят на месяцы, и
 * у одной строки фикстуры пилота `device_time` стоит в январе при приёме в сентябре: показанный как
 * есть, он объявил бы свежее значение восьмимесячной давностью.
 *
 * Хуже того, он сделал бы это НЕОТЛИЧИМО от соседней строки, у которой времени аппарата нет вовсе и
 * показан приём: две отметки выглядели бы одинаково достоверными, означая разное. Поэтому у
 * показаний отметка ОДНА на все строки по смыслу и названа вслух — «принято». Время аппарата у
 * наблюдений остаётся в ответе (`deviceTime`) и ждёт места, где оно отвечает на свой вопрос, —
 * например будущих месячных дельт.
 */
function MetricsView({ metrics }: { metrics: DeviceMetricValueDto[] }) {
  if (metrics.length === 0) return null;
  return (
    <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
      {metrics.map((row) => (
        <Descriptions.Item key={`${row.metricCode}|${row.component}`} label={metricTitle(row)}>
          <span>
            {formatMetricValue(row.value)} {UNIT_LABELS[row.unit] ?? row.unit}
          </span>{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            принято {formatDateTime(row.observedAt)}
          </Typography.Text>
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

function metricTitle(row: { metricCode: string; component: ComponentCode }): string {
  const base = metricLabels[row.metricCode as keyof typeof metricLabels] ?? row.metricCode;
  const part = componentLabels[row.component] ?? row.component;
  return part ? `${base} · ${part}` : base;
}

/** Цвет важности — шкала, а не словарь предметной области: три значения, и расширять нечем. */
const SEVERITY_COLOR: Record<DeviceEventSeverity, string> = {
  info: 'default',
  warning: 'orange',
  critical: 'red',
};

const SEVERITY_LABEL: Record<DeviceEventSeverity, string> = {
  info: 'Сообщение',
  warning: 'Внимание',
  critical: 'Критично',
};

/**
 * Лента событий.
 *
 * ВРЕМЯ В СТОЛБЦЕ — ВРЕМЯ АППАРАТА, А ПРИЁМ ТОЛЬКО ТОГДА, КОГДА ЕГО НЕТ (Р21). Это не мелочь
 * оформления. Приём порталом идёт пачками: выключенный на сутки рубильник или перечитывание
 * накопленного дают сорок писем за несколько секунд — и лента по приёму рассказала бы, что аппарат
 * «замялся сорок раз только что». Когда времени аппарата нет (старые прошивки шлют письма без
 * `Date`), показывается приём, и это сказано вслух пометкой, а не угадывается.
 *
 * ПОРЯДОК СТРОК ПРИ ЭТОМ ЗАДАЁТ ПРИЁМ, и считает его сервер: часы МФУ без NTP уходят на месяцы, а
 * ряд обязан быть монотонным хотя бы по одному надёжному времени. Второй сортировки на портале
 * нет вовсе — она разошлась бы с курсором и начала бы терять строки между страницами.
 */
function EventsFeed({
  events,
  hasMore,
  loadingMore,
  loadMore,
}: {
  events: DeviceEventDto[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}) {
  if (events.length === 0) {
    return <Typography.Text type="secondary">Событий аппарат пока не присылал</Typography.Text>;
  }
  return (
    <>
      <Table<DeviceEventDto>
        size="small"
        rowKey="id"
        dataSource={events}
        pagination={false}
        columns={[
          {
            key: 'when',
            title: 'Когда',
            width: 180,
            render: (_v, r) =>
              r.deviceTime ? (
                formatDateTime(r.deviceTime)
              ) : (
                <>
                  {formatDateTime(r.observedAt)}{' '}
                  {/* Пометка обязательна: без неё две строки ленты выглядели бы одинаково
                      достоверными, а означали бы разное — «так сказал аппарат» и «так это к нам
                      приехало». */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    (приём)
                  </Typography.Text>
                </>
              ),
          },
          {
            key: 'severity',
            title: 'Важность',
            width: 120,
            render: (_v, r) => (
              <Tag color={SEVERITY_COLOR[r.severity]}>{SEVERITY_LABEL[r.severity]}</Tag>
            ),
          },
          {
            key: 'what',
            title: 'Что случилось',
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{deviceEventLabels[r.eventCode] ?? r.eventCode}</div>
                {/* Текст и вендорский код — под подписью, а не вместо неё: словарь отвечает на
                    вопрос «что это», а строка вендора нужна тому, кто будет заводить новый код по
                    накопленным «Прочее сообщение аппарата». */}
                {r.text && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.text}
                  </Typography.Text>
                )}
                {r.vendorCode && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.text ? ' · ' : ''}
                    {r.vendorCode}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          {
            key: 'source',
            title: 'Откуда',
            width: 110,
            render: (_v, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {telemetrySourceLabels[r.source] ?? r.source}
              </Typography.Text>
            ),
          },
        ]}
      />
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        </div>
      )}
    </>
  );
}
