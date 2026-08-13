import { useState } from 'react';
import { App, Button, DatePicker, Space, Tooltip, Typography, type TableColumnType } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { VehicleReadingStatsRow } from '@technic/contracts';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { errorMessage } from '../../utils/format';
import { readingsApi, readingsKeys } from './readingsApi';

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
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** Прочерк вместо числа: неизвестное значение не притворяется нулём. */
function decimal(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits).replace('.', ',');
}

/** Итог по парку: суммы известного. Прочерки в сумму не идут — они не нули. */
function totalOf(
  rows: readonly VehicleReadingStatsRow[],
  pick: (row: VehicleReadingStatsRow) => number | null,
) {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
}

export function ReadingsStatsTab({ date }: { date: string }) {
  const { message } = App.useApp();
  const active = useActiveTabKey() === 'readings';

  /**
   * Период — свой у вкладки, а не день среза: сводку читают за месяц, и день, которым живут
   * «Техника» и «Водители», отвечал бы здесь на другой вопрос. Умолчание отсчитывается от него же —
   * от начала того месяца, который открыт на соседних вкладках.
   */
  const [period, setPeriod] = useState<[string, string]>([
    dayjs(date).startOf('month').format(DATE),
    date,
  ]);
  const [exporting, setExporting] = useState(false);

  const { params, onTableChange } = useListParams<Record<string, never>>({}, { searchKeys: [] });

  const query = { from: period[0], to: period[1] };
  const { data, isFetching } = useQuery({
    queryKey: readingsKeys.stats(query),
    queryFn: () => readingsApi.stats(query),
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
    {
      key: 'distanceKm',
      title: 'Пробег, км',
      width: 130,
      align: 'right',
      render: (_v, r) => decimal(r.distanceKm, 0),
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

  const download = async () => {
    setExporting(true);
    try {
      await readingsApi.exportStats(query);
    } catch (e: unknown) {
      message.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageTableLayout>
      <TabsExtra tabKey="readings">
        <Space size={12} wrap>
          <DatePicker.RangePicker
            format={SHOWN_DATE}
            allowClear={false}
            value={[dayjs(period[0]), dayjs(period[1])]}
            onChange={(v) => {
              if (v?.[0] && v[1]) setPeriod([v[0].format(DATE), v[1].format(DATE)]);
            }}
          />
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void download()}>
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
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
