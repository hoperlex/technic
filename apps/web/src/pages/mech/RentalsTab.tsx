import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  parseMechRequestNumberSearch,
  type MechRequestDto,
} from '@technic/contracts';
import { mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import {
  DataTable,
  PageTableLayout,
  SummaryBar,
  sortOptionsFrom,
  type ActionSheetItem,
} from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { mechRentalCard, mechRentalColumns } from './mechRentalGrid';
import {
  MECH_FILTER_FIELDS,
  MechFilterBar,
  useMechRequestFilters,
  type MechListFilters,
} from './mechRequestFilters';
import { useMechRequestActions } from './mechRequestActions';
import { MECH_RENTAL_ACTION_KEYS } from './mechRequestMenu';
import { MechRequestViewModal } from './MechRequestViewModal';
import { useAuth } from '../../auth/AuthContext';

/**
 * «В аренде» (Р13, §7): что сейчас стоит на площадках и до какого числа.
 *
 * Отбор делает сервер параметром `rental` — **всем предикатом Р2 целиком**, а не статусом: «В
 * работе» бывает и у заявки, которую ещё не подали, и у строки после отката «Выполнена» → «В
 * работе», где техника уже вернулась. Спроси вкладка статус — она показала бы обе, то есть соврала
 * бы в главном своём утверждении: «это стоит у нас прямо сейчас».
 *
 * Считать присутствие на клиенте по приехавшей странице тоже нельзя: список постраничный, и
 * «просроченных нет» означало бы всего лишь «нет на этой странице».
 *
 * Порядок по умолчанию — по плановому возврату, ближайший сверху, и просроченные оказываются в
 * самом начале: их дата дальше всех в прошлом. Отдельного «сначала просроченные» поэтому не
 * заводится — оно уже есть.
 *
 * Своя вкладка, а не отбор в списке заявок, хотя данные одни: вопросы разные. Список заявок ведут
 * («что взять в работу, что выдать»), присутствие сверяют («что вернуть, что продлить, за что
 * платим»), и колонки, порядок и действия у этих двух занятий не совпадают.
 */
export function RentalsTab() {
  const { user } = useAuth();

  /** Московский день считается один раз на отрисовку вкладки (Р12) — как и в списке заявок. */
  const today = moscowDateKeyOf(new Date());

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } = useListParams<
    MechListFilters & { num?: number }
  >(
    {},
    {
      searchKeys: [],
      filterKeys: MECH_FILTER_FIELDS,
      /*
       * Набор запоминается своим именем, а не общим со списком заявок (ADR 0139): срез у вкладок
       * разный по смыслу — там «чем я занимаюсь», здесь «за чем слежу», — и общее хранилище
       * переносило бы отбор одной вкладки на другую при каждом переключении.
       */
      persist: { scope: 'mech-rentals', userId: user?.id },
    },
  );

  const applyFilter = (patch: MechListFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));
  // Статус вкладке не показывается: все её строки в «В работе» по построению отбора (Р2).
  const filters = useMechRequestFilters({ params, apply: applyFilter, status: false });

  const [numInput, setNumInput] = useState('');
  const applyNum = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseMechRequestNumberSearch(raw), page: 1 }));
  };

  /**
   * Умолчание порядка — ближайший возврат сверху: вкладку открывают вопросом «что пора
   * возвращать». Как только человек выбрал столбец сам, направление становится его.
   */
  const sortBy = params.sortBy ?? 'plannedTo';
  const sortOrder = params.sortBy ? params.sortOrder : 'asc';
  const query = { ...params, sortBy, sortOrder, rental: 'true', archive: 'exclude' };
  const { data, isFetching } = useQuery({
    queryKey: mechRequestKeys.list(query),
    queryFn: () => mechRequestsApi.list(query),
  });

  /*
   * Сводка — та же ручка и те же предикаты, что у списка заявок, но показываются из неё два числа
   * из четырёх: «ждут подачи» и «не обработано» отвечают на вопросы соседней вкладки, а здесь
   * читались бы как часть выдачи, которой в ней нет. Из отборов сводка знает только площадку —
   * сузить её вкладочными отборами нечем, и это честнее, чем показать число, посчитанное по
   * другому срезу.
   */
  const summaryQuery = { placeObjectId: params.placeObjectId };
  const { data: summary } = useQuery({
    queryKey: mechRequestKeys.summary(summaryQuery),
    queryFn: () => mechRequestsApi.summary(summaryQuery),
  });
  const summaryItems = [
    { label: 'В аренде', value: summary?.rental ?? 0 },
    { label: 'Просрочено', value: summary?.overdue ?? 0 },
  ];

  const [viewRecord, setViewRecord] = useState<MechRequestDto | null>(null);

  /** Заявка, названная в адресе: ссылку на действующую аренду шлют и из соседних разделов. */
  const activeTab = useActiveTabKey() === 'rentals';
  const opened = useOpenedRecord<MechRequestDto>({
    active: activeTab,
    queryKey: (id) => mechRequestKeys.detail(id),
    fetch: (id) => mechRequestsApi.get(id),
  });
  const shown = viewRecord ?? opened.record;

  /*
   * Наборов действий два — строки и карточки (ADR 0140): один набор, отрисованный в двух местах, —
   * это два экземпляра одного окна, и второе прячется под первым.
   *
   * Правки среди действий нет намеренно: формы у вкладки нет вовсе (`onEdit` не передан). Заявку
   * здесь не ведут — её продлевают и завершают, а правят на вкладке «Заявки».
   */
  const actions = useMechRequestActions({});
  const cardActions = useMechRequestActions({});

  /**
   * Из меню заявки вкладка показывает два пункта по существу присутствия (§7): продлить и
   * завершить. Остальное — дублирование, откаты, удаление — про ведение заявки, и место им в
   * списке заявок: здесь они уводили бы от вопроса «что вернуть и что продлить».
   *
   * Отбором по ключам, а не своим меню: состав по-прежнему решают барьеры контрактов
   * (`mechMenuItems`), и пункта без права или не в том состоянии здесь не появится.
   */
  const rentalActions =
    (source: (request: MechRequestDto) => ActionSheetItem[]) => (request: MechRequestDto) =>
      source(request).filter((item) => MECH_RENTAL_ACTION_KEYS.includes(item.key));

  /*
   * Закрылась карточка — гаснут и её окна: «Назад» браузера снимает `?open=…`, и взведённая цель
   * осталась бы в наборе с версией, устаревшей к следующему открытию.
   */
  const closeCardModals = cardActions.close;
  useEffect(() => {
    if (!shown) closeCardModals();
  }, [shown, closeCardModals]);

  const grid = {
    today,
    actions: rentalActions(actions.actionsFor),
    onOpen: (request: MechRequestDto) => setViewRecord(request),
  };
  const columns = mechRentalColumns(grid);

  return (
    <PageTableLayout
      filters={
        <MechFilterBar
          filters={filters}
          num={{ text: numInput, onChange: applyNum }}
          reset={{ active: filtersActive, onClick: resetFilters }}
        />
      }
      mobile={{
        search: {
          value: numInput,
          placeholder: 'Например, МХ-42',
          onChange: (v) => applyNum(v ?? ''),
        },
        filters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      {/* Сводка — на уровне вкладок, над панелью: она про весь раздел, а не про эту таблицу. */}
      <TabsExtra tabKey="rentals">
        <SummaryBar title="Единиц" items={summaryItems} />
      </TabsExtra>

      <DataTable<MechRequestDto>
        columns={columns}
        card={mechRentalCard(grid)}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching || actions.pending || cardActions.pending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      <MechRequestViewModal
        request={shown}
        today={today}
        actions={rentalActions(cardActions.actionsFor)}
        modals={cardActions.modals}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />
    </PageTableLayout>
  );
}
