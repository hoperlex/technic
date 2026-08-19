import type { ReactNode } from 'react';
import { Select, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  driverDocumentGapLabel,
  formatPhone,
  GARAGE_DRIVER_STATES,
  type GarageDriverDto,
  garageDriverStateColors,
  garageDriverStateLabels,
  type GarageDriverState,
} from '@technic/contracts';
import { garageApi, garageKeys } from '@entities/garage';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { textColumn } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { formatDateOnly } from '../../utils/date';
import { useAuth } from '../../auth/AuthContext';
import { useJournalAddress } from './journalAddress';
import { busyDayColumns, driverBusyLine, useBusyExpand } from './busyColumns';
import { useBusyRouteActions } from './shared';
import { VehicleReadingsJournal } from './VehicleReadingsJournal';

/**
 * Гараж → «Водители»: кто из действующих водителей занят в выбранный день, а кто свободен
 * (ADR 0076).
 *
 * Перечень тот же, что в справочнике: человек с действующей специализацией водителя. Пробелы
 * комплекта документов считаются **на выбранный день** и идут пометкой, а не фильтром по
 * умолчанию (ADR 0064): они говорят, какие графы бланка останутся пустыми, а не запрещают работу.
 *
 * День человека читается тремя колонками — «Рейс/путевой лист», «Техника», «Заказ/адрес», — а не
 * одним столбцом занятости, как день машины. Спрашивают о водителе другое: не «что за работа», а
 * «на чём он сегодня и по какому заказу». В общей колонке оба ответа приходилось выуживать из
 * строки текста подряд по всему списку; разложенные поперёк, они читаются вдоль своей графы —
 * столбец техники отвечает сразу за всю страницу отбора.
 *
 * Плата за это — одна работа в свёрнутых графах: ячейки одной строки обязаны стоять вровень, а
 * блоки разной высоты разъезжаются и рвут чтение поперёк. И работа эта — **первая заведённая** за
 * день, а не та, где человек сейчас: порядок набора задаёт сервер (`loadDriverBusy` в
 * `apps/api/src/services/garage.ts`) — рейсы отсортированы по `vehicleRoutes.num`, сквозному
 * счётчику создания записи, а недельный лист ЭСМ-2 дописан за ними хвостом. Времени выезда у рейса
 * в схеме нет вовсе, упорядочить день по часам сейчас нечем.
 *
 * На «где человек сейчас» отвечает поэтому не свёрнутая строка, а раскрытая: пометка «ещё N»
 * (`BusyMore` в `busyColumns.tsx`) — переключатель, и по нажатию все три графы дописывают остальные
 * работы дня целиком, теми же ссылками, что и первую. Раскрытие держит строка, а не ячейка
 * (`useBusyExpand`): переключатель стоит в первой графе, а дописывают блоки все три.
 *
 * Номер машины ведёт в журнал показаний, а не в карточку техники: из гаражного дня о машине под
 * человеком спрашивают ровно одно — сданы ли за неё цифры приборов и что там по сменам. Открыт
 * журнал окном поверх среза (тем же приёмом, что рейс и заявка, ADR 0120) и только под правом на
 * сами показания: у среза дня своё право (`garage.read`), у цифр приборов — своё.
 */

const STATE_OPTIONS = GARAGE_DRIVER_STATES.map((state) => ({
  value: state,
  label: garageDriverStateLabels[state],
}));

const DOCUMENT_OPTIONS = [
  { value: 'complete', label: 'Комплект полный' },
  { value: 'incomplete', label: 'Есть пробелы' },
];

/**
 * Ячейки строки — вровень по верху (`.garage-day-cell` в `styles.css`). Умолчание браузера для
 * ячейки таблицы — «по середине», и стоит «Рейсу/путевому листу» вырасти до трёх строк (номер,
 * бланк, «ещё 2»), как однострочная «Техника» уезжает в вертикальный центр: номер машины оказывается
 * не напротив номера рейса — то самое чтение поперёк, ради которого день и разложен на три графы.
 *
 * Класс идёт всем шести колонкам, а не только трём графам занятости: выравняв правую половину
 * строки, мы получили бы в ней два разных уровня — ФИО с удостоверением по середине, день по
 * верху, — а это заметнее исходной беды. Ставится он через `onCell`: своего `className` таблица
 * `DataTable` наружу не отдаёт, а ячейка чужие свойства принимает.
 *
 * Чужому `onCell` это не мешает: у всех шести колонок он свой единственный, затирать `NO_ROW_CLICK`
 * (класс ячейки, не отдающей клик строке) здесь нечего — да и отдавать некому: нажатие на строку
 * этой таблице не поручено вовсе, `onRowClick` у `DataTable` не задан.
 */
const TOP_CELL = () => ({ className: 'garage-day-cell' });

/**
 * Подпись машины в заголовке журнала показаний. Берётся из занятостей загруженной страницы — той
 * самой работы, по номеру которой нажали. Присланная ссылка может назвать машину, которой на этой
 * странице отбора нет вовсе: тогда журнал всё равно открывается и грузит себя по идентификатору из
 * адреса, а имени у окна до ответа нет (так же ведёт себя `openedVehicle` на вкладке техники).
 */
function openedVehicle(id: string, rows: readonly GarageDriverDto[]) {
  const busy = rows.flatMap((r) => r.busy).find((entry) => entry.vehicleId === id);
  return { id, label: busy?.vehicleLabel ?? 'машина' };
}

/**
 * Чего не хватает для листа: тег с расшифровкой — теми же словами, что в справочнике. Документ
 * назван своим именем (ADR 0095): за экскаватор садятся по удостоверению тракториста-машиниста, и
 * «нет действующего ВУ» отправило бы искать не ту бумагу.
 */
function gapsTag(r: GarageDriverDto) {
  if (r.gaps.length === 0) return null;
  return (
    <Tooltip
      title={r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; ')}
    >
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        документы: {r.gaps.length}
      </Tag>
    </Tooltip>
  );
}

export function GarageDriversTab({
  date,
  dayControls,
}: {
  /** День среза: общий у обеих вкладок, приходит от страницы вместе с органами управления им. */
  date: string;
  dayControls: ReactNode;
}) {
  const { can } = useAuth();
  // Рейсы человека пунктами действий телефона: занятость на карточке — текст (`driverBusyLine`).
  const routeActions = useBusyRouteActions();
  // Раскрытые дни — общие на три графы строки, поэтому набор живёт здесь, а не в ячейке.
  const expand = useBusyExpand();
  // Журнал показаний назван в адресе (`?journal=<id>`) и открыт только под правом на сами цифры
  // приборов. Вкладку спрашиваем не ради права, а ради единственности окна: ключ `?journal=` у
  // вкладок гаража общий, а скрытая вкладка остаётся смонтированной (`PageTabs`) — без этой
  // проверки один адрес открыл бы два журнала разом, здесь и на соседней вкладке.
  const canReadReadings = can('vehicleReadings.read');
  const journal = useJournalAddress(useActiveTabKey() === 'drivers' && canReadReadings);
  const { params, setParams, setSort, onTableChange } = useListParams<{
    state?: GarageDriverState;
    documents?: 'complete' | 'incomplete';
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>({ sortBy: 'state', sortOrder: 'asc' }, { searchKeys: ['fullName'] });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = { ...params, on: date };
  const { data, isFetching } = useQuery({
    queryKey: garageKeys.drivers(query),
    queryFn: () => garageApi.drivers(query),
  });

  const items = data?.items ?? [];
  const journalVehicle = journal.id ? openedVehicle(journal.id, items) : null;

  // Сводка не сужается ни состоянием, ни комплектом: обе цифры — её собственные ответы.
  const summaryQuery = { ...query, state: undefined, documents: undefined };
  const { data: summary } = useQuery({
    queryKey: garageKeys.driversSummary(summaryQuery),
    queryFn: () => garageApi.driversSummary(summaryQuery),
  });

  const summaryItems = [
    { label: 'Водителей', value: summary?.total ?? 0 },
    { label: 'Свободны', value: summary?.free ?? 0 },
    { label: 'Назначены', value: summary?.assigned ?? 0 },
    { label: 'Документы неполны', value: summary?.documentsIncomplete ?? 0 },
  ];

  /*
   * Бюджет ширин. `fitWidth={1080}` у `DataTable` — это не обещание «влезем в любой экран», а
   * нижняя граница ширины таблицы: заданные ширины берут 300 + 190 + 120 + 180 + 140 = 930, и ещё
   * около 150 px оставлено «Заказу/адресу» — единственной колонке без `width`, а на меньшем поле
   * состав рейса и площадку заказа читать уже нечем.
   *
   * Где контейнер шире границы (ноутбук 1366 минус сайдбар 230 и паддинги 32 — это около 1104 px),
   * таблица растягивается на него целиком и остаток забирает та же «Заказ/адрес»: колонку, уехавшую
   * за правый край, в срезе просто не находят. Где уже — окно на половину экрана, ноутбук при
   * масштабе 125 % — возвращается обычная прокрутка вбок, и это честнее графы, схлопнутой в полоску
   * из паддингов. Прибавка любой из пяти цифр двигает нижнюю границу, и считать её надо здесь —
   * включая две последние: ширины граф дня стоят рядом со своими ячейками (`busyDayColumns` в
   * `busyColumns.tsx`), потому что считаны под них, но бюджет у таблицы один и живёт тут.
   */
  const columns: TableColumnType<GarageDriverDto>[] = [
    {
      ...textColumn<GarageDriverDto>({
        key: 'fullName',
        title: 'Водитель',
        dataIndex: 'fullName',
        width: 300,
        render: (_v, r) => (
          // `display: flex` у обёртки не украшение: `Space` иначе inline-flex, ширина у него по
          // содержимому, и однострочному ФИО было бы не от чего отрезаться — оно вылезло бы в
          // соседнюю колонку вместо многоточия.
          <Space direction="vertical" size={0} style={{ display: 'flex' }}>
            {/* ФИО — строго в одну строку: ячейка обязана остаться двухстрочной (имя и «таб. № …
                телефон»), иначе строки пляшут высотой от длины фамилии. Обрез отдан antd тем же
                приёмом, что у подписи машины (`BusyVehicleCell`), и подсказка у него всплывает по
                факту обреза: имя, поместившееся в 300 px, договаривать нечем, а на странице из 25
                строк безусловная подсказка — шум при каждом наведении. */}
            <Typography.Text ellipsis={{ tooltip: r.fullName }}>{r.fullName}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[r.personnelNo ? `таб. № ${r.personnelNo}` : null, formatPhone(r.phone) || null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </Space>
        ),
      }),
      // Снаружи `textColumn`: своего `onCell` он не принимает и не ставит — затирать нечего.
      onCell: TOP_CELL,
    },
    {
      // Удостоверением не сортируют: спрашивают его строкой — по какому документу выпишется лист
      // и до какого числа он годен.
      key: 'license',
      title: 'Удостоверение',
      width: 190,
      onCell: TOP_CELL,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.categories.length > 0 ? r.categories.join(', ') : '—'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[
              r.licenseNumber || null,
              r.licenseExpiresOn ? `до ${formatDateOnly(r.licenseExpiresOn)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'state',
      title: 'Состояние',
      width: 120,
      onCell: TOP_CELL,
      sorter: true,
      defaultSortOrder: 'ascend',
      render: (_v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={garageDriverStateColors[r.state]} style={{ marginInlineEnd: 0 }}>
            {garageDriverStateLabels[r.state]}
          </Tag>
          {gapsTag(r)}
        </Space>
      ),
    },
    // Три графы дня — готовыми колонками (`busyDayColumns`): заголовки и ширины считаны под свои
    // ячейки и живут рядом с ними. Без права на показания номер машины остаётся текстом: `null` —
    // не «ссылку не нашли», а «смотрящему цифры приборов не положены», и ссылка вела бы в пустое
    // окно.
    ...busyDayColumns({
      expand,
      hrefOf: (id) => (canReadReadings ? journal.href(id) : null),
      onCell: TOP_CELL,
    }),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select<GarageDriverState>
        allowClear
        placeholder="Любое состояние"
        style={{ width: 180 }}
        options={STATE_OPTIONS}
        value={params.state}
        onChange={(v) => applyFilter({ state: v })}
      />
      <Select<'complete' | 'incomplete'>
        allowClear
        placeholder="Любые документы"
        style={{ width: 190 }}
        options={DOCUMENT_OPTIONS}
        value={params.documents}
        onChange={(v) => applyFilter({ documents: v })}
      />
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: [...STATE_OPTIONS],
      placeholder: 'Любое состояние',
      onChange: (v) => applyFilter({ state: v as GarageDriverState | undefined }),
    },
    {
      kind: 'select',
      key: 'documents',
      label: 'Документы',
      value: params.documents,
      options: DOCUMENT_OPTIONS,
      placeholder: 'Любые документы',
      onChange: (v) => applyFilter({ documents: v as 'complete' | 'incomplete' | undefined }),
    },
  ];

  const card: CardConfig<GarageDriverDto> = {
    title: (r) => r.fullName,
    badge: (r) => (
      <Tag color={garageDriverStateColors[r.state]}>{garageDriverStateLabels[r.state]}</Tag>
    ),
    primary: (r) => (r.categories.length > 0 ? r.categories.join(', ') : '—'),
    lines: [
      (r) => (r.busy.length === 0 ? 'на этот день ничего не назначено' : null),
      // Занятость строкой: на телефоне трёх граф нет, и машину называет сама строка
      // (`driverBusyLine`) — на десктопе на это отвечает графа «Техника» раскрытой строки.
      ...Array.from({ length: 3 }, (_, i) => (r: GarageDriverDto) => {
        const entry = r.busy[i];
        return entry ? driverBusyLine(entry) : null;
      }),
      (r) =>
        r.gaps.length === 0
          ? null
          : r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; '),
    ],
    /*
     * Единственные действия карточки водителя — его рейсы этого дня, и заведены они здесь ровно
     * поэтому: своей карточки человек в гараже не открывает (`onOpen` у списка нет), занятость
     * показана строкой текста, и до сих пор с телефона нельзя было попасть в рейс никак —
     * оставалось искать его номер на десктопе.
     *
     * Пункты те же, что у техники (`useBusyRouteActions`): вопрос «что за рейс Р-12» один, а
     * пришли к нему с разных сторон — от машины или от человека за рулём. Машину каждого рейса
     * при этом называет строка карточки, так что номера в подписях не двоятся.
     */
    actions: (r) => routeActions(r.busy),
  };

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { fullName: 'ФИО', state: 'Состояние' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <TabsExtra tabKey="drivers">
        <Space size={12} wrap>
          {dayControls}
          <SummaryBar title="Водители" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<GarageDriverDto>
        columns={columns}
        rowKey="personId"
        card={card}
        fitWidth={1080}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />

      {journalVehicle && (
        <VehicleReadingsJournal
          vehicleId={journalVehicle.id}
          vehicleLabel={journalVehicle.label}
          day={date}
          open
          onClose={journal.close}
        />
      )}
    </PageTableLayout>
  );
}
