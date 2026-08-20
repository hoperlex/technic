import type { ReactNode } from 'react';
import { Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { type GarageDriverDto } from '@technic/contracts';
import { garageApi, garageKeys } from '@entities/garage';
import { DataTable } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { useJournalAddress } from './journalAddress';
import { useBusyExpand } from './busyColumns';
import { driverCard, driverColumns } from './driverColumns';
import { useDriverFilters, type DriverFilterParams } from './driverFilters';
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
 *
 * Строка и отбор собраны рядом со своими ячейками: колонки с карточкой телефона — фабриками
 * `driverColumns.tsx`, полоса фильтров с описаниями для шита — `driverFilters.tsx`.
 */

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
  const { params, setParams, setSort, onTableChange } = useListParams<
    DriverFilterParams & {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  >({ sortBy: 'state', sortOrder: 'asc' }, { searchKeys: ['fullName'] });

  const applyFilter = (patch: DriverFilterParams) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = { ...params, on: date };
  const { data, isFetching } = useQuery({
    queryKey: garageKeys.drivers(query),
    queryFn: () => garageApi.drivers(query),
  });

  const items = data?.items ?? [];
  const journalVehicle = journal.id ? openedVehicle(journal.id, items) : null;

  /*
   * Сводка не сужается ни состоянием, ни комплектом: обе цифры — её собственные ответы.
   *
   * Площадка и бланк, наоборот, уходят в неё как есть (Р7): они **определяют перечень**, а не
   * являются одной из его цифр, — суженная таблица с несуженной сводкой отвечали бы про разных
   * людей, и «свободны: 12» под отбором по площадке считало бы свободных по всему парку.
   */
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
   * нижняя граница ширины таблицы: заданные ширины берут 300 + 150 + 120 + 180 + 170 = 920, и
   * оставшиеся 160 px достаются «Заказу/адресу» — единственной колонке без `width`, а на меньшем
   * поле состав рейса и площадку заказа читать уже нечем.
   *
   * Обмен внутри этой суммы границы не двигает: «Удостоверение» отдало 40 px (190 → 150), потеряв
   * строку категорий, а «Техника» их взяла (140 → 170) под марку машины второй строкой.
   *
   * Где контейнер шире границы (ноутбук 1366 минус сайдбар 230 и паддинги 32 — это около 1104 px),
   * таблица растягивается на него целиком и остаток забирает та же «Заказ/адрес»: колонку, уехавшую
   * за правый край, в срезе просто не находят. Где уже — окно на половину экрана, ноутбук при
   * масштабе 125 % — возвращается обычная прокрутка вбок, и это честнее графы, схлопнутой в полоску
   * из паддингов. Прибавка любой из пяти цифр двигает нижнюю границу, и считать её надо здесь —
   * включая две последние: ширины граф дня стоят рядом со своими ячейками (`busyDayColumns` в
   * `busyColumns.tsx`), потому что считаны под них, но бюджет у таблицы один и живёт тут.
   */
  const columns = driverColumns({
    expand,
    hrefOf: (id) => (canReadReadings ? journal.href(id) : null),
    on: date,
  });

  const { bar: filters, mobile: mobileFilters } = useDriverFilters({ params, applyFilter });

  const card = driverCard({ routeActions, on: date });

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
