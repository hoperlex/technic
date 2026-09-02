import { useState } from 'react';
import { App, Button } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  parseMechRequestNumberSearch,
  requestStatusLabels,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechFailureText,
  mechMoneySum,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { DataTable, PageTableLayout, SummaryBar, sortOptionsFrom } from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { mechHistoryCard, mechHistoryColumns } from './mechHistoryGrid';
import {
  MECH_HISTORY_FILTER_FIELDS,
  MechFilterBar,
  useMechRequestFilters,
  type MechListFilters,
} from './mechRequestFilters';
import { MechRequestViewModal } from './MechRequestViewModal';
import { useAuth } from '../../auth/AuthContext';

/**
 * «История» (§7, вкладка 3; Э3): закрытые заявки — «Выполнена» и «Отменена» — с итогами за
 * выбранный отбор.
 *
 * Первые две вкладки отвечают на «что вести» и «что вернуть», эта — на вопросы, которые задают
 * потом: сколько мы за месяц арендовали у этого арендодателя, сколько техника отработала и во
 * сколько это обошлось. Поэтому её строка — не строка рабочего списка: вместо ответственного и
 * файлов в ней стоят факт возврата, отработанное и итоговая стоимость.
 *
 * Своя серверная ручка, а не список с отбором по статусу: журналу нужен свой порядок (по сроку
 * возврата), свои поля сортировки (факт и деньги) и свой итог, а рабочий список закрытых заявок не
 * показывает вовсе.
 *
 * Действий у вкладки нет: закрытую заявку не ведут. Откат «Выполнена» → «В работе» живёт в списке
 * заявок вместе с остальным ходом — здесь он уводил бы от вопроса «во что это обошлось».
 */
export function HistoryTab() {
  const { user } = useAuth();
  const { message } = App.useApp();

  /** Московский день (Р12) — карточке: остаток срока она считает тем же значением, что и списки. */
  const today = moscowDateKeyOf(new Date());

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } = useListParams<
    MechListFilters & { num?: number }
  >(
    {},
    {
      searchKeys: [],
      // Без «просрочен возврат»: у закрытой аренды техника уже вернулась (Р12).
      filterKeys: MECH_HISTORY_FILTER_FIELDS,
      /*
       * Свой набор отборов, а не общий с рабочим списком (ADR 0139): журнал открывают разбором
       * периода — «сентябрь, этот арендодатель», — и переносить такой срез на список заявок,
       * который ведут каждый день, значило бы прятать от человека новые заявки.
       */
      persist: { scope: 'mech-history', userId: user?.id },
    },
  );

  const applyFilter = (patch: MechListFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));
  /*
   * Статусов у отбора два, и вопрос к ним другой — «чем закончилась». Просрочки нет вовсе: она
   * свойство действующей аренды, и отбор отвечал бы пустотой на любой выбор.
   */
  const filters = useMechRequestFilters({
    params,
    apply: applyFilter,
    status: 'closed',
    overdue: false,
  });

  const [numInput, setNumInput] = useState('');
  const applyNum = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseMechRequestNumberSearch(raw), page: 1 }));
  };

  /**
   * Отбор перечислен полями, а не взят из `params` целиком, ровно потому, что он уходит **в три
   * места**: в таблицу, в итог и в файл. Страница и порядок нужны только первой из них, и попади
   * они в остальные два — итог считался бы по двадцати видимым строкам, а книга повторяла бы одну
   * страницу вместо всего периода.
   */
  const filterQuery = {
    status: params.status,
    placeObjectId: params.placeObjectId,
    requester: params.requester,
    kind: params.kind,
    lessorId: params.lessorId,
    periodFrom: params.periodFrom,
    periodTo: params.periodTo,
    num: params.num,
  };

  /**
   * Умолчание порядка — по плановому возврату, поздние сверху: журнал читают с последнего
   * закрытого. По плановой дате, а не по фактической: у отменённой заявки факта нет вовсе, и по
   * нему все отмены слиплись бы в пустой хвост. Тем же полем и в ту же сторону сортирует сервер —
   * стрелка в заголовке и порядок строк расходиться не должны.
   */
  const sortBy = params.sortBy ?? 'plannedTo';
  const sortOrder = params.sortOrder;
  const listQuery = {
    ...filterQuery,
    page: params.page,
    pageSize: params.pageSize,
    sortBy,
    sortOrder,
  };
  const { data, isFetching } = useQuery({
    queryKey: mechRequestKeys.closed(listQuery),
    queryFn: () => mechRequestsApi.closedList(listQuery),
  });

  /*
   * Итог считается по тем же отборам, что и таблица, — включая статус: «во сколько обошлись
   * отменённые» законный вопрос к журналу. Сводка, отвечающая не про то, что человек видит перед
   * собой, вводит в заблуждение вернее, чем её отсутствие.
   */
  const { data: summary } = useQuery({
    queryKey: mechRequestKeys.closedSummary(filterQuery),
    queryFn: () => mechRequestsApi.closedSummary(filterQuery),
  });

  /**
   * Итог журнала. Два числа в нём объяснены прямо в подписи, потому что иначе их читают неверно:
   *
   * «Из них с выдачей» — сколько закрытых заявок были **арендой**: отменённая до подачи заявка
   * закрыта, но техника по ней не выезжала, и в расходы она не идёт. Разностью с «Отменено» это
   * число не является — отменить заявку можно и после выдачи.
   *
   * **Часы и смены — два числа, а не одно.** Ставка задаётся за час либо за смену (Р7), и сложить
   * их нельзя: «120» без единицы не значит ничего. Единица стоит в подписи, а не в значении —
   * число рядом с ней остаётся числом. Не встретившаяся в отборе единица не показывается вовсе:
   * «Отработано смен: 0» в журнале, где смен не было ни одной, читается как «отработали ноль», то
   * есть как простой техники.
   */
  const worked = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const summaryItems = [
    { label: 'Закрыто', value: summary?.closed ?? 0 },
    { label: 'Из них с выдачей', value: summary?.rentals ?? 0 },
    { label: requestStatusLabels.cancelled, value: summary?.cancelled ?? 0 },
    { label: 'Дней аренды', value: summary?.days ?? 0 },
    ...(summary?.hours ? [{ label: 'Отработано часов', value: worked(summary.hours) }] : []),
    ...(summary?.shifts ? [{ label: 'Отработано смен', value: worked(summary.shifts) }] : []),
    { label: 'Стоимость', value: mechMoneySum(summary?.cost) },
  ];

  /**
   * Выгрузка: тот же отбор и тот же порядок, что на экране, — файл, показывающий не то, что
   * портал, спорит с ним, а спор разбирают глазами. Страницы у файла нет: журнал сверяют со
   * счетами целиком.
   *
   * Ошибку показываем тостом: скачивание, которое не началось, человек прочтёт как поломку
   * портала, а не как отказ сервера.
   */
  const exportBook = useMutation({
    mutationFn: () => mechRequestsApi.exportClosed({ ...filterQuery, sortBy, sortOrder }),
    onError: (e: unknown) => message.error(mechFailureText(e)),
  });
  // Пустой отбор выгружать нечего: книга из одной шапки читается как сбой выгрузки.
  const exportDisabled = data !== undefined && data.total === 0;
  /** Одно описание кнопки на оба экрана: подпись и действие у неё общие, различается только место. */
  const exportAction = {
    label: 'Выгрузить',
    icon: <DownloadOutlined />,
    onClick: () => exportBook.mutate(),
  };

  const [viewRecord, setViewRecord] = useState<MechRequestDto | null>(null);

  /** Закрытая заявка, названная в адресе: в списке заявок её уже нет, ссылка ведёт сюда. */
  const opened = useOpenedRecord<MechRequestDto>({
    active: useActiveTabKey() === 'history',
    queryKey: (id) => mechRequestKeys.detail(id),
    fetch: (id) => mechRequestsApi.get(id),
  });

  const grid = { onOpen: (request: MechRequestDto) => setViewRecord(request) };
  const columns = mechHistoryColumns(grid);

  return (
    <PageTableLayout
      filters={
        <MechFilterBar
          filters={filters}
          num={{ text: numInput, onChange: applyNum }}
          reset={{ active: filtersActive, onClick: resetFilters }}
          extra={
            <Button
              icon={exportAction.icon}
              loading={exportBook.isPending}
              disabled={exportDisabled}
              onClick={exportAction.onClick}
            >
              {exportAction.label}
            </Button>
          }
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
          options: sortOptionsFrom(columns, {
            num: 'Номер заявки',
            plannedTo: 'Срок по плану',
            actualFrom: 'Дата выдачи',
            actualTo: 'Дата возврата',
          }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        /*
         * Выгрузка на телефоне — второстепенным действием панели (ADR 0030): круглая кнопка
         * означает «создать», а создавать в журнале нечего. Отбор у неё тот же, что и у списка,
         * поэтому и стоит она рядом с входом в фильтры.
         */
        secondaryActions: exportDisabled ? [] : [exportAction],
      }}
    >
      {/* Итог живёт в строке вкладок — там же, где сводки соседних вкладок: три виджета на одном
          месте читаются как один, переключаемый вкладкой. */}
      <TabsExtra tabKey="history">
        <SummaryBar title="Журнал" items={summaryItems} />
      </TabsExtra>

      <DataTable<MechRequestDto>
        columns={columns}
        card={mechHistoryCard(grid)}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      {/* Карточка закрытой заявки только на чтение: ни правки, ни хода ей не передано — в журнале
          заявку разбирают, а не ведут. */}
      <MechRequestViewModal
        request={viewRecord ?? opened.record}
        today={today}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />
    </PageTableLayout>
  );
}
