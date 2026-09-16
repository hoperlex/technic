import { useState } from 'react';
import { Button, DatePicker, Space, Tooltip, Typography, type TableColumnsType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { monthSchema, type WasteStatsRowDto } from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { formatMoney } from '../../utils/format';
import { confirmedNotes, costNotes, volumeNotes, volumeText } from './wasteStatsNumbers';
import { WasteStatsObjectModal } from './WasteStatsObjectModal';

const MONTH = 'YYYY-MM';

/**
 * «Вывоз мусора» → «Статистика»: сколько кубов вывезли с каждой площадки за отчётный месяц и во
 * сколько это обошлось (план `docs/waste-stats-tab-plan.md`).
 *
 * ЧИСЛА СЧИТАЕТ СЕРВЕР, портал только печатает пришедшее (Р1): вкладка и книга сводной аналитики
 * берут их из одного слоя, и своего счёта — хотя бы сложения строк ради итога — здесь нет вовсе.
 * Итог приходит отдельным полем ответа именно поэтому.
 *
 * ЧТО СТОИТ В КОЛОНКАХ. Объём и стоимость складывают состоявшееся с заказанным (Р3): деньги
 * незакрытой заявки посчитаны прайсом из её заказанного объёма, и колонка объёма, считающая другой
 * набор заявок, сделала бы строку неразложимой. Доли подписаны второй строкой в ячейке — «в т. ч.
 * заказано», «в т. ч. оценка»: без них подтверждённый талонами объём читался бы как недовывоз, хотя
 * у незакрытой заявки талонов не бывает по порядку работы.
 *
 * ЛОМА И КОНТЕЙНЕРНЫХ ОПЕРАЦИЙ ЗДЕСЬ НЕТ ВОВСЕ (Р6): лом принимают тоннами и денег у него нет,
 * операции не тарифицируются. Площадка, у которой за месяц только они, во вкладке не появляется —
 * её работа видна в «Заявках» и в «Истории».
 */
export function WasteStatsTab() {
  const active = useActiveTabKey() === 'stats';
  const [sp, setSp] = useSearchParams();

  /**
   * Отчётный месяц живёт в адресе (Р9): «статистику за август» отправляют ссылкой, а состояние
   * вкладки пересылке не подлежит — оно теряется и от перезагрузки, и от «назад».
   *
   * Мусорная строка вкладку не ломает: портал падает на текущий месяц, и до сервера она не
   * доходит. А вот БУДУЩИЙ месяц законен и не подменяется: заявка с доставкой в сентябре относится
   * к сентябрю и приносит туда заказанный объём с оценкой (Р2, Р3), то есть «Статистика» за
   * следующий месяц отвечает на «сколько уже заказано». Подмени её текущим — и единственный
   * экран, который на этот вопрос отвечает, стало бы не открыть.
   */
  const raw = sp.get('month') ?? '';
  /*
   * Годность месяца спрашивается У КОНТРАКТА, а не у dayjs: `dayjs('2026-13-01')` считает себя
   * действительной датой и молча переносит месяц в январь следующего года — портал отправил бы на
   * сервер значение, которое тот отвергает схемой, и человек получил бы ошибку валидации вместо
   * экрана. Схема здесь ровно та же, которой маршрут проверяет запрос: второе правило «какой месяц
   * бывает» разошлось бы с первым на тринадцатом.
   */
  const month = monthSchema.safeParse(raw).success ? raw : dayjs().format(MONTH);
  /*
   * `tab` пишется вместе с месяцем не для полноты: страница переключает вкладки через
   * `setSp({ tab })`, то есть чистит адрес целиком, — и месяц при уходе на «Заявки» законно
   * теряется. Но потерять `tab`, меняя месяц, значило бы вернуть человека на «Заявки» нажатием на
   * календарь.
   */
  const setMonth = (next: string) => setSp({ tab: 'stats', month: next });

  const { params, onTableChange } = useListParams<Record<string, never>>({}, { searchKeys: [] });
  /**
   * Площадка открытого окна — состоянием, а не адресом: предмет ссылки здесь месяц, а окно
   * показывает то, что уже приехало вместе с таблицей, и своего запроса не делает (Р11).
   */
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'stats', month],
    queryFn: () => wasteRequestsApi.stats(month),
    /*
     * Только на своей вкладке: скрытая вкладка не размонтируется (`PageTabs`), и без этого условия
     * месяц пересчитывался бы на сервере всякий раз, когда открывают список заявок.
     */
    enabled: active,
  });

  const rows = data?.rows ?? [];
  // Страницами режет портал: ответ приходит целиком — его и показываем тем же составом.
  const page = rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);
  const totals = data?.totals;
  const opened = rows.find((r) => r.objectId === openObjectId) ?? null;

  const summaryItems = totals
    ? [
        { label: 'Площадок', value: rows.length },
        { label: 'Вывозов', value: totals.removals },
        {
          label: 'Объём',
          value: (
            <Tooltip title={volumeNotes(totals).join('; ') || undefined}>
              {volumeText(totals.volumeM3)}
            </Tooltip>
          ),
        },
        {
          label: 'Стоимость',
          value: (
            <Tooltip title={costNotes(totals).join('; ') || undefined}>
              {formatMoney(totals.totalCost)}
            </Tooltip>
          ),
        },
        {
          label: 'Подтверждено',
          value: (
            <Tooltip title={confirmedNotes(totals).join('; ') || undefined}>
              {volumeText(totals.confirmedVolumeM3)}
            </Tooltip>
          ),
        },
      ]
    : [];

  /** Величина крупно, из чего она состоит — подписью под ней. */
  const cell = (value: string, notes: string[]) => (
    <div style={{ lineHeight: 1.35 }}>
      <div>{value}</div>
      {notes.map((note) => (
        <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Text>
      ))}
    </div>
  );

  const columns: TableColumnsType<WasteStatsRowDto> = [
    {
      key: 'name',
      title: 'Площадка',
      width: OBJECT_COLUMN_WIDTH,
      /*
       * Название — вход в детализацию: вопрос «а из чего эти 412 м³» задают именно ему. Кнопкой,
       * а не ссылкой: адрес окно не меняет, и настоящая ссылка обещала бы переход.
       */
      render: (_v, r) => (
        <Button
          type="link"
          style={{ padding: 0, height: 'auto', textAlign: 'left' }}
          onClick={() => setOpenObjectId(r.objectId)}
        >
          <ObjectCell name={r.name} hint={r.code} />
        </Button>
      ),
    },
    {
      key: 'volume',
      title: 'Объём',
      align: 'right',
      width: 180,
      render: (_v, r) => cell(volumeText(r.volumeM3), volumeNotes(r)),
    },
    {
      key: 'cost',
      title: 'Стоимость',
      align: 'right',
      width: 200,
      render: (_v, r) => cell(formatMoney(r.totalCost), costNotes(r)),
    },
  ];

  return (
    <PageTableLayout>
      <TabsExtra tabKey="stats">
        <Space size={12} wrap>
          <DatePicker
            picker="month"
            allowClear={false}
            /*
             * Формат строкой, а не функцией: функция печатает то же «май 2026», но лишает поле
             * ввода — antd разбирает набранное ровно этим форматом, и календарь остаётся
             * единственным способом выбрать месяц. Подпись при этом та же, что у `monthLabel`.
             */
            format="MMMM YYYY"
            value={dayjs(`${month}-01`)}
            onChange={(v) => {
              if (v) setMonth(v.format(MONTH));
            }}
          />
          <SummaryBar title="Отчётный месяц" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<WasteStatsRowDto>
        rowKey="objectId"
        columns={columns}
        data={page}
        total={rows.length}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        fitWidth={700}
        onRowClick={(r) => setOpenObjectId(r.objectId)}
        onChange={onTableChange}
      />

      {/*
       * Насколько числам можно верить (Р10): те же счётчики, что у листа «Качество данных» книги.
       * Таблица, где «подтверждено 0 из 340 м³» выглядит недовывозом, а не горой неразобранных
       * талонов, вводит в заблуждение вернее, чем её отсутствие.
       */}
      {data && data.quality.length > 0 && (
        <div style={{ padding: '8px 0' }}>
          <Space size={16} wrap>
            {/*
             * «По видимым заявкам»: область и отбор типов стоят в самой выборке, поэтому числа
             * здесь — про таблицу под ними, а не про всю организацию. Те же счётчики в книге
             * аналитики дадут другие знаменатели, и подпись обязана сказать это словами.
             */}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              По видимым заявкам вывоза за месяц:
            </Typography.Text>
            {data.quality.map((q) => (
              <Tooltip key={q.key} title={q.note}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {q.label}: {q.value}
                  {q.outOf != null ? ` из ${q.outOf}` : ''}
                </Typography.Text>
              </Tooltip>
            ))}
          </Space>
        </div>
      )}

      {/*
       * Окно рисуется в портале поверх всей страницы, поэтому показывает его только своя вкладка:
       * без проверки `active` уход на «Заявки» оставил бы его висеть над чужим списком.
       */}
      {active && opened && (
        <WasteStatsObjectModal row={opened} month={month} onClose={() => setOpenObjectId(null)} />
      )}
    </PageTableLayout>
  );
}
