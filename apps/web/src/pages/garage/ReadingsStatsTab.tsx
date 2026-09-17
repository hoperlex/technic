import { useState } from 'react';
import {
  Button,
  Checkbox,
  DatePicker,
  Space,
  Tooltip,
  Typography,
  type TableColumnType,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { fuelDeviation, type VehicleReadingStatsRow } from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useReadingsAddress } from './readingsAddress';
import { kmText } from '@shared/lib';
import { decimal } from './readingNumbers';
import { ReadingsExportModal } from './ReadingsExportModal';
import { VehicleReadingCard } from './VehicleReadingCard';

/**
 * Гараж → «Сводка»: пробег, наработка и заправленное топливо по каждой машине за период
 * (ADR 0103, Р27).
 *
 * **Расход и норма стоят здесь с приходом норм расхода топлива** (`docs/fuel-norms-plan.md`):
 * решение 12 ADR 0103 («расхода портал не считает») снято заказчиком вместе с ними. Расход
 * появился не как показатель сам по себе, а как половина сверки: колонка «Расход, л» показывает
 * ровно те смены, из которых посчитана норма рядом, поэтому три числа строки сходятся между собой,
 * а отклонение равно разности соседних колонок.
 *
 * Полного расхода по всем сменам с остатками здесь нет — он живёт в служебной книге показаний, где
 * стоит построчно и ни с чем не сводится.
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

/**
 * Ячейка нормы: число, а под ним охват или причина его отсутствия (план `docs/fuel-norms-plan.md`,
 * Р15а). Три состояния, и они отвечают разным людям:
 *
 * - нормы не заводили — вопрос к тому, кто ведёт справочник;
 * - норма есть, а сверять нечего (остатков в баке не сдают) — вопрос к тому, кто принимает
 *   показания;
 * - норма есть и сверка состоялась — тогда рядом стоит охват: по скольким сменам из скольких.
 *
 * Ноль здесь печатается прочерком осознанно: складываться числам нужно, а «0 л» в клетке читается
 * как «норма нулевая», чего не бывает.
 */
function normCell(row: VehicleReadingStatsRow) {
  if (!row.hasNorm) {
    return (
      <Tooltip title="Норма расхода для этой машины не заведена — справочник норм открывается из «Техники»">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  if (row.verifiedShifts === 0) {
    return (
      <Tooltip title="Нет смен, годных для сверки: не сдавали остатки топлива либо ряд снимков рвался">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  return (
    <Space orientation="vertical" size={0} style={{ alignItems: 'flex-end' }}>
      <span>{decimal(row.fuelNormLiters)}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        сверено {row.verifiedShifts} из {row.shiftsWithFuel}
      </Typography.Text>
    </Space>
  );
}

/**
 * Отклонение: литры и процент одной ячейкой (Р12а). Считается общей функцией контрактов — той же,
 * какой считают полоса, отбор и книги: два одинаковых с виду расчёта расходятся на первом же
 * округлении.
 */
function deviationCell(row: VehicleReadingStatsRow, tolerancePercent: number) {
  const dev = fuelDeviation(row.fuelSpentLiters, row.fuelNormLiters, tolerancePercent);
  if (dev.liters === null || dev.percent === null) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const sign = dev.liters > 0 ? '+' : '';
  return (
    <Space orientation="vertical" size={0} style={{ alignItems: 'flex-end' }}>
      <Typography.Text type={dev.exceeded ? 'danger' : undefined} strong={dev.exceeded}>
        {sign}
        {decimal(dev.liters)} л
      </Typography.Text>
      <Typography.Text type={dev.exceeded ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
        {sign}
        {decimal(dev.percent)}%
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
  const { period, setPeriod, vehicleId, openVehicle, overOnly, setOverOnly } =
    useReadingsAddress(date);
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
  const tolerancePercent = data?.tolerancePercent ?? 0;

  /**
   * Сверка по строке — одной функцией на экран, полосу и отбор. Считается для всех строк сразу, а
   * не в ячейке: счётчики полосы обязаны знать про машины, которых отбор со страницы убрал.
   */
  const deviations = new Map(
    rows.map((row) => [
      row.vehicleId,
      fuelDeviation(row.fuelSpentLiters, row.fuelNormLiters, tolerancePercent),
    ]),
  );
  /** Сверялось машин — знаменатель у «Превышений» (Р16): у машины без нормы превышения не бывает. */
  const checked = rows.filter((row) => row.hasNorm && row.verifiedShifts > 0);
  const exceeded = checked.filter((row) => deviations.get(row.vehicleId)?.exceeded === true);
  const overspend = exceeded.reduce(
    (sum, row) => sum + (deviations.get(row.vehicleId)?.liters ?? 0),
    0,
  );

  /*
   * Отбор клиентский (Р16а): сводка приходит целиком, страницами её режет портал, и сервер об
   * отборе не знает. Выгрузка его тоже не знает — книгу собирает сервер по периоду, и обещать
   * «выгружается ровно то, что на экране» здесь больше нельзя.
   */
  const shown = overOnly
    ? rows.filter((row) => deviations.get(row.vehicleId)?.exceeded === true)
    : rows;
  const page = shown.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  const summaryItems = [
    { label: 'Машин', value: rows.length },
    { label: 'Пробег, км', value: Math.round(totalOf(rows, (r) => r.distanceKm)) },
    { label: 'Наработка, м/ч', value: Math.round(totalOf(rows, (r) => r.engineHours)) },
    { label: 'Заправлено, л', value: Math.round(totalOf(rows, (r) => r.fuelFilledLiters)) },
    // Разрывы стоят в сводке рядом с суммами не для красоты: ими измеряется, насколько суммам
    // можно верить.
    { label: 'Разрывов ряда', value: totalOf(rows, (r) => r.gaps) },
  ];

  /**
   * Сверка — своей полосой, а не рядом с суммами (Р16). Причина простая: `SummaryBar` содержимое
   * не переносит, а счётчиков в одной строке стало бы восемь.
   *
   * «Сверялось машин» стоит первым и не для порядка: «Превышений: 3» при парке в шестьдесят машин,
   * из которых сверялись двенадцать, читается как благополучие. Перерасход — сумма положительных
   * отклонений тех, кто вышел за допуск; экономия его не гасит.
   */
  const checkItems = [
    { label: 'Сверялось машин', value: checked.length },
    { label: 'Превышений', value: exceeded.length },
    { label: 'Перерасход, л', value: Math.round(overspend) },
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
    /*
     * Три колонки сверки идут вместе и в этом порядке: расход, из которого посчитано отклонение,
     * норма, с которой его сравнили, и сам разрыв между ними. Порознь они не читаются.
     */
    {
      key: 'fuelSpentLiters',
      title: 'Расход, л',
      width: 120,
      align: 'right',
      render: (_v, r) =>
        r.verifiedShifts === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          decimal(r.fuelSpentLiters)
        ),
    },
    {
      key: 'fuelNormLiters',
      title: 'Норма, л',
      width: 140,
      align: 'right',
      render: (_v, r) => normCell(r),
    },
    {
      key: 'deviation',
      title: 'Отклонение',
      width: 130,
      align: 'right',
      render: (_v, r) => deviationCell(r, tolerancePercent),
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
          {/*
            * Вторая полоса — про сверку с нормой. Обёртка с прокруткой обязательна: `SummaryBar`
            * не переносит содержимое, а на телефоне слот вкладок узкий.
            */}
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <SummaryBar title="Сверка с нормой" items={checkItems} />
          </div>
          <Checkbox
            checked={overOnly}
            onChange={(e) => {
              setOverOnly(e.target.checked);
              // Страница живёт в состоянии списка, а не в адресе: без явного сброса включение
              // отбора на третьей странице показало бы пустую таблицу.
              onTableChange({ page: 1, pageSize: params.pageSize });
            }}
          >
            Только превышения
          </Checkbox>
        </Space>
      </TabsExtra>

      <DataTable<VehicleReadingStatsRow>
        rowKey="vehicleId"
        columns={columns}
        data={page}
        total={shown.length}
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
