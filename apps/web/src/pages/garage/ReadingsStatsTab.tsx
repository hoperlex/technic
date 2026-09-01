import { useState } from 'react';
import { Button, DatePicker, Space, Tooltip, Typography, type TableColumnType } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { VehicleReadingStatsRow } from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useReadingsAddress } from './readingsAddress';
import { decimal, kmText } from './readingNumbers';
import { ReadingsExportModal } from './ReadingsExportModal';
import { VehicleReadingCard } from './VehicleReadingCard';

/**
 * Гараж → «Сводка»: пробег, наработка и заправленное топливо по каждой машине за период
 * (ADR 0103, Р27).
 *
 * **Расхода здесь нет, как нет и производных от него** (Р28). Колонка одна — заправленные за смены
 * литры; ничего, поделённого на пробег или наработку, рядом не стоит. Причин две: фактический
 * расход требует остатков в баке, которых портал не хранит, а любая цифра «на сто километров»
 * читается как расход независимо от подписи — и проживёт ровно до первого совещания, где её
 * сравнят с нормой.
 *
 * Прочерк в строке — не ноль и не ошибка: ряд снимков разорвался (сброшенный счётчик, несданная
 * смена), и считать по «первой и последней» строке значило бы догадываться. Сколько раз ряд
 * рвался, стоит отдельной колонкой — она и объясняет прочерк рядом.
 *
 * Снимок счётчика и сумма за период стоят парами: «Одометр» рядом с «Пробегом», «Моточасы» рядом с
 * «Наработкой» (Р17). Это разные величины, и путать их нельзя: снимок — что показывал прибор в
 * последний день периода, когда его вообще снимали, а сумма — сколько за период наработано.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/**
 * Снимок счётчика за период: число и день, за который его сняли (Р17). Считает его сервер, портал
 * только печатает пришедшее — своего выбора «последнего» у него нет и быть не должно.
 *
 * Прочерк — не ноль на приборе: числового показания в периоде не сдавали вовсе. Дата второй
 * строкой обязательна по той же причине, что и в колонке гаража: снимок без даты читается как
 * сегодняшний и врёт тем сильнее, чем дольше машина стояла.
 */
function snapshotCell(
  last: { value: number; measuredOn: string } | null,
  text: (value: number) => string,
) {
  if (!last) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space orientation="vertical" size={0}>
      <span>{text(last.value)}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        снято {dayjs(last.measuredOn).format(SHOWN_DATE)}
      </Typography.Text>
    </Space>
  );
}

/** Итог по парку: суммы известного. Прочерки в сумму не идут — они не нули. */
function totalOf(
  rows: readonly VehicleReadingStatsRow[],
  pick: (row: VehicleReadingStatsRow) => number | null,
) {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
}

export function ReadingsStatsTab({ date }: { date: string }) {
  const active = useActiveTabKey() === 'readings';

  /**
   * Период — свой у вкладки, а не день среза: сводку читают за месяц, и день, которым живут
   * «Техника» и «Водители», отвечал бы здесь на другой вопрос. Умолчание отсчитывается от него же —
   * от начала того месяца, который открыт на соседних вкладках.
   *
   * Живёт он в адресе, а не в состоянии вкладки (Р29): «пробег за июль» отправляют ссылкой, а
   * состояние пересылке не подлежит — оно теряется и от перезагрузки, и от «назад».
   */
  const { period, setPeriod, vehicleId, openVehicle } = useReadingsAddress(date);
  /**
   * Окно выбора выгрузки (§8, Р18). Состояние, а не адрес: выбор книги — не предмет, который
   * пересылают ссылкой, и «назад» из него возвращать некуда. Предмет ссылки — период и машина, и
   * они в адресе уже есть.
   */
  const [exportOpen, setExportOpen] = useState(false);

  const { params, onTableChange } = useListParams<Record<string, never>>({}, { searchKeys: [] });

  const query = { from: period[0], to: period[1] };
  const { data, isFetching } = useQuery({
    queryKey: vehicleReadingKeys.stats(query),
    queryFn: () => vehicleReadingsApi.stats(query),
    /*
     * Только на своей вкладке. Скрытая вкладка не размонтируется (`PageTabs`), и без этого условия
     * сводка за месяц пересчитывалась бы на сервере всякий раз, когда открывают срез дня; с ним же
     * возвращение на вкладку показывает свежие числа, а не снимок получасовой давности.
     */
    enabled: active,
  });

  const rows = data?.items ?? [];
  // Страницами режет портал, а не сервер: сводка приходит целиком — её и выгружают целиком, тем же
  // составом, что видят на экране.
  const page = rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  const summaryItems = [
    { label: 'Машин', value: rows.length },
    { label: 'Пробег, км', value: Math.round(totalOf(rows, (r) => r.distanceKm)) },
    { label: 'Наработка, м/ч', value: Math.round(totalOf(rows, (r) => r.engineHours)) },
    { label: 'Заправлено, л', value: Math.round(totalOf(rows, (r) => r.fuelFilledLiters)) },
    // Разрывы стоят в сводке рядом с суммами не для красоты: ими измеряется, насколько суммам
    // можно верить.
    { label: 'Разрывов ряда', value: totalOf(rows, (r) => r.gaps) },
  ];

  const columns: TableColumnType<VehicleReadingStatsRow>[] = [
    // Порядок строк задаёт сервер — по госномеру, как во всех перечнях парка. Сортировки и поиска
    // в заголовке нет намеренно: сводка приходит одним куском, и органы управления, которые сервер
    // не слышит, обещали бы отбор, которого не происходит.
    {
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      width: 260,
    },
    // Подписи снимков короткие («Одометр», «Моточасы») — так их называют и в гараже, и в
    // карточке; выравнивания по правому краю у них нет, как и у колонки гаража: под числом стоит
    // дата, и прижатая к краю пара читается хуже, чем сумма в соседнем столбце.
    {
      key: 'lastOdometer',
      title: 'Одометр',
      width: 150,
      render: (_v, r) => snapshotCell(r.lastOdometer, kmText),
    },
    {
      key: 'distanceKm',
      title: 'Пробег, км',
      width: 130,
      align: 'right',
      render: (_v, r) => decimal(r.distanceKm, 0),
    },
    {
      key: 'lastEngineHours',
      title: 'Моточасы',
      width: 150,
      render: (_v, r) => snapshotCell(r.lastEngineHours, (value) => `${decimal(value)} м/ч`),
    },
    {
      key: 'engineHours',
      title: 'Наработка, м/ч',
      width: 140,
      align: 'right',
      render: (_v, r) => decimal(r.engineHours),
    },
    {
      key: 'fuelFilledLiters',
      title: 'Заправлено топлива, л',
      width: 180,
      align: 'right',
      render: (_v, r) => decimal(r.fuelFilledLiters),
    },
    {
      key: 'gaps',
      title: 'Разрывов ряда',
      width: 140,
      align: 'right',
      render: (_v, r) =>
        r.gaps === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tooltip title="Сброшенный счётчик или смена без показания: на них ряд рвётся, и участок в показатель не идёт">
            <span>{r.gaps}</span>
          </Tooltip>
        ),
    },
  ];

  return (
    <PageTableLayout>
      <TabsExtra tabKey="readings">
        <Space size={12} wrap>
          <DatePicker.RangePicker
            format={SHOWN_DATE}
            allowClear={false}
            value={[dayjs(period[0]), dayjs(period[1])]}
            onChange={(v) => {
              if (v?.[0] && v[1]) setPeriod(v[0].format(DATE), v[1].format(DATE));
            }}
          />
          {/* Книг шесть, и различаются они вопросом, а не оформлением: кнопка спрашивает, какую
              собрать, а не собирает молча одну (Р18). */}
          <Button icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>
            Выгрузить
          </Button>
          <SummaryBar title="Период" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<VehicleReadingStatsRow>
        rowKey="vehicleId"
        columns={columns}
        data={page}
        total={rows.length}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        // Строка сводки — вход в машину (Р2): вопрос «а из чего эти 4 200 км» задают ровно ей.
        onRowClick={(r) => openVehicle(r.vehicleId)}
        onChange={onTableChange}
      />

      {/*
       * Машины окну выгрузки достаются из уже загруженной сводки: это ровно тот перечень, который
       * человек видит в таблице, и своего запроса ради него окно не делает.
       */}
      {active && exportOpen && (
        <ReadingsExportModal
          from={period[0]}
          to={period[1]}
          vehicles={rows.map((r) => ({ id: r.vehicleId, label: r.vehicleLabel }))}
          vehicleId={vehicleId}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/*
       * Карточка живёт в адресе, а окно рисуется в портале поверх всей страницы — поэтому её
       * показывает только своя вкладка: без проверки `active` уход на «Технику» оставлял бы
       * открытое окно висеть над чужим списком, ведь скрытая вкладка не размонтируется.
       *
       * Подпись машины берётся из уже загруженной сводки, а не запрашивается: по ссылке из чужого
       * сообщения строки может не быть — тогда окно подпишется ответом карточки.
       */}
      {active && vehicleId && (
        <VehicleReadingCard
          vehicleId={vehicleId}
          vehicleLabel={rows.find((r) => r.vehicleId === vehicleId)?.vehicleLabel}
          from={period[0]}
          to={period[1]}
          onClose={() => openVehicle(null)}
        />
      )}
    </PageTableLayout>
  );
}
