import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { AutoPartReceiptListItemDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { DataTable, PageTableLayout, SummaryBar, sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { formatMoney } from '../../utils/format';
import { AutoPartReceiptCardModal } from './AutoPartReceiptCardModal';
import { AutoPartReceiptFormModal } from './AutoPartReceiptFormModal';
import { receiptCard, receiptColumns } from './receiptColumns';
import {
  RECEIPT_FILTER_FIELDS,
  RECEIPT_SEARCH_PLACEHOLDER,
  ReceiptFilterBar,
  useReceiptFilters,
  type ReceiptFilters,
} from './receiptFilters';
import { useNewReceiptAddress, useReceiptAddress, useVehicleSpendAddress } from './receiptsAddress';
import { VehiclePartsSpendModal } from './VehiclePartsSpendModal';

/**
 * Гараж → «Автозапчасти»: лента чеков на запчасти (план `docs/auto-part-receipts-plan.md`, §8,
 * ADR 0154).
 *
 * Вкладка отвечает на вопрос «сколько вложено и во что»: чек здесь — бумага из магазина, а не
 * позиция склада, и справочника номенклатуры у него нет вовсе (Р7). Отсюда и колонки: дата,
 * продавец, номер, сколько строк, сумма и машины, к которым эти строки отнесли.
 *
 * **Ключ вкладки в адресе остался прежним** (`?tab=parts`), и подпись тоже: раздел «Автозапчасти»
 * никуда не делся, сменился его предмет. Ссылки из переписки и закладок ведут туда же, куда вели.
 *
 * **Дня среза у вкладки нет** — у неё свой период по дате чека (Р13). Общий календарь страницы
 * отвечал бы не на тот вопрос: суммы смотрят за месяц и за год, а не на дату, и «чем занята машина
 * 24 июля» к покупкам отношения не имеет. Ключ `?date=` вкладка не читает и не пишет — страница
 * гаража хранит его сама, чтобы возврат на «Технику» показал тот же день.
 *
 * **Отбор, порядок и страницы считает сервер**, и сводка считается тем же отбором: четыре числа
 * над таблицей относятся ровно к тому, что видно, — иначе «Сумма» над отфильтрованным списком
 * называла бы чужое число.
 *
 * **Действия закрыты правом ведения** (`autoParts.manage`): «Принять чек» видит механик, а не
 * всякий, кому виден гараж. Сам список права не спрашивает вовсе — чеки читают под `garage.read`
 * (Р5), и ответить «покупали ли на эту машину» должен и диспетчер, и менеджер.
 */
export function AutoPartReceiptsTab() {
  const { can, user } = useAuth();

  /** Ведение чеков (Р12): заведение, правка и пометка на удаление. Чтение — под правом гаража. */
  const canManage = can('autoParts.manage');

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } =
    useListParams<ReceiptFilters>(
      {},
      {
        searchKeys: [],
        filterKeys: RECEIPT_FILTER_FIELDS,
        /*
         * Свой набор отборов у вкладки (ADR 0139): в чеках работают срезом — «август, этот
         * самосвал», — и открывать ленту заново с пустым периодом каждое утро значит заставлять
         * задавать его снова. Имя набора постоянно: это ключ хранилища, а не заголовок вкладки.
         */
        persist: { scope: 'garage-receipts', userId: user?.id },
      },
    );

  const applyFilter = (patch: ReceiptFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));
  const applySearch = (search: string | undefined) => setParams((p) => ({ ...p, search, page: 1 }));
  const filters = useReceiptFilters({ params, apply: applyFilter });

  /**
   * Отбор перечислен полями, а не взят из `params` целиком, ровно потому, что он уходит **в два
   * места**: в ленту и в сводку. Страница и порядок нужны только первой из них, и попади они во
   * вторую — схема сводки отвергла бы запрос целиком (`.strict()`, §6), а не молча их отбросила.
   */
  const filterQuery = {
    from: params.from,
    to: params.to,
    vehicleId: params.vehicleId,
    deletionMarked: params.deletionMarked,
    search: params.search,
  };
  const listQuery = {
    ...filterQuery,
    page: params.page,
    pageSize: params.pageSize,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  };

  const { data, isFetching } = useQuery({
    queryKey: autoPartReceiptKeys.list(listQuery),
    queryFn: () => autoPartReceiptApi.list(listQuery),
  });

  const { data: summary } = useQuery({
    queryKey: autoPartReceiptKeys.summary(filterQuery),
    queryFn: () => autoPartReceiptApi.summary(filterQuery),
  });

  /**
   * Четыре числа над таблицей (§8). «Не отнесено» стоит рядом с суммой, потому что объясняет
   * разницу между ней и суммами по машинам: строка без машины — законное состояние (Р8), и без
   * этого числа расхождение пришлось бы объяснять читателю самому.
   *
   * «К удалению» — очередь администратора и его же уведомление: писем по пометке не заводим (Р12),
   * а увидеть очередь он обязан, не открывая каждый чек.
   */
  const summaryItems = [
    { label: 'Чеков', value: summary?.receiptsCount ?? 0 },
    { label: 'Сумма', value: formatMoney(summary?.total ?? 0) },
    { label: 'Не отнесено', value: formatMoney(summary?.unassignedTotal ?? 0) },
    { label: 'К удалению', value: summary?.deletionMarkedCount ?? 0 },
  ];

  /*
   * Окна названы в адресе (§8). Активная вкладка спрашивается не ради права — чеки читают все,
   * кому виден гараж (Р5), — а ради единственности окна: скрытые вкладки остаются смонтированными
   * (`PageTabs`), а окно рисуется порталом в тело документа.
   */
  const active = useActiveTabKey() === 'parts';
  const receipt = useReceiptAddress(active);
  const newReceipt = useNewReceiptAddress(active && canManage);
  /*
   * Окно «Запчасти машины» отвечает отсюда, а не из карточки чека (Р15): ключ `?spend=` читают
   * трое — эта вкладка, колонка «Запчасти, ₽» соседней и блок карточки машины, — и открывать окно
   * обязан тот, кто сейчас на виду. Карточке чека достаётся только вход в него: адрес ссылки и
   * само открытие.
   */
  const spend = useVehicleSpendAddress(active);

  const columns = receiptColumns();
  const openReceipt = (r: AutoPartReceiptListItemDto) => receipt.open(r.id);

  /** Одно описание кнопки на оба экрана: подпись и действие общие, различается только место. */
  const createAction = {
    label: 'Принять чек',
    icon: <PlusOutlined />,
    onClick: newReceipt.open,
  };

  return (
    <PageTableLayout
      filters={
        <ReceiptFilterBar
          filters={filters}
          search={{ value: params.search, onSearch: applySearch }}
          reset={{ active: filtersActive, onClick: resetFilters }}
        />
      }
      extra={
        canManage ? (
          <Button type="primary" icon={createAction.icon} onClick={createAction.onClick}>
            {createAction.label}
          </Button>
        ) : null
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: RECEIPT_SEARCH_PLACEHOLDER,
          onChange: applySearch,
        },
        filters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        // Приём чека — главное действие вкладки, и на телефоне ему место круглой кнопкой у нижней
        // навигации: полоса фильтров десктопа там занимает весь экран.
        primaryAction: canManage ? createAction : undefined,
      }}
    >
      {/* Сводка живёт в строке вкладок — там же, где сводки соседних вкладок гаража: виджеты на
          одном месте читаются как один, переключаемый вкладкой. */}
      <TabsExtra tabKey="parts">
        <SummaryBar title="Автозапчасти" items={summaryItems} />
      </TabsExtra>

      <DataTable<AutoPartReceiptListItemDto>
        columns={columns}
        card={receiptCard({ onOpen: openReceipt })}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        // Нажатие по строке открывает карточку чека — там строки, сканы, оба итога и действия.
        onRowClick={openReceipt}
        onChange={onTableChange}
      />

      {/* Приём чека — форма без записи (`?newReceipt=1`); карточка открыта своим ключом адреса. */}
      <AutoPartReceiptFormModal
        receipt={null}
        open={newReceipt.opened}
        onClose={newReceipt.close}
      />
      <AutoPartReceiptCardModal
        receiptId={receipt.id}
        onClose={receipt.close}
        vehicleSpend={spend}
      />
      {/* Окно машины: подпись придёт в ответе — из строки карточки чека сюда едет только машина.
          Период не задаётся: из чека спрашивают «что вообще купили этой машине», а не «за август»
          (Р15) — у ленты чеков нет дня среза, которым его можно было бы сузить. */}
      <VehiclePartsSpendModal vehicle={spend.id ? { id: spend.id } : null} onClose={spend.close} />
    </PageTableLayout>
  );
}
