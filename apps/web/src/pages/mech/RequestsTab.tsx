import { useEffect, useState } from 'react';
import { Button, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  parseMechRequestNumberSearch,
  type MechRequestDto,
} from '@technic/contracts';
import { mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { DataTable, PageTableLayout, SummaryBar, sortOptionsFrom } from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { mechRequestCard, mechRequestColumns } from './mechRequestGrid';
import {
  MECH_FILTER_FIELDS,
  MechFilterBar,
  useMechRequestFilters,
  type MechListFilters,
} from './mechRequestFilters';
import { useMechRequestActions } from './mechRequestActions';
import { MechRequestForm } from './MechRequestForm';
import { MechRequestViewModal } from './MechRequestViewModal';

/**
 * Рабочий список аренд: «Новая» и «В работе» (§7).
 *
 * Порядок по умолчанию — по плановому возврату: список открывают вопросом «что пора возвращать»,
 * и умолчание «по дате заведения» отвечает не на него.
 *
 * Сводка над списком — четыре числа, и все четыре про действие, а не про статус: «не обработано»
 * ждёт офиса, «ждут подачи» ждут арендодателя, «в аренде» стоит денег каждый день, «просрочено»
 * стоит денег и требует звонка. Считаются они предикатами Р2 — теми же, что и теги строк, — и
 * «ждут подачи» здесь единственная мера против забытой отметки выдачи (риск 4 плана): без неё
 * техника работала бы на площадке, а портал считал бы её неподанной.
 */
export function RequestsTab() {
  const { user, can } = useAuth();

  /**
   * Московский день считается один раз на отрисовку списка (Р12): по нему и колонка «Возврат», и
   * строки карточек, и поле срока в окне. Спроси его каждая ячейка сама — список, открытый в
   * 00:00, показал бы часть строк по вчерашнему дню.
   */
  const today = moscowDateKeyOf(new Date());

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } = useListParams<
    MechListFilters & { num?: number }
  >(
    {},
    {
      // Поиска по столбцу у списка нет: номер живёт отдельным полем панели, а прочие вопросы
      // закрывают отборы.
      searchKeys: [],
      filterKeys: MECH_FILTER_FIELDS,
      /*
       * Набор отборов переживает перезагрузку и утренний вход (ADR 0139): диспетчер работает не
       * со списком вообще, а со своим срезом — своя площадка, свой арендодатель, — и выставлять
       * его заново после каждого `F5` он не должен.
       */
      persist: { scope: 'mech-requests', userId: user?.id },
    },
  );

  const applyFilter = (patch: MechListFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));
  const filters = useMechRequestFilters({ params, apply: applyFilter });

  /**
   * Номер живёт строкой, а в параметрах — числом: «МХ-42», «мх42» и «42» человек набирает как
   * придётся, а искать сервер обязан по одному и тому же. Разбор — контрактный, второго в портале
   * нет.
   */
  const [numInput, setNumInput] = useState('');
  const applyNum = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseMechRequestNumberSearch(raw), page: 1 }));
  };

  /**
   * Умолчание порядка — ближайший возврат сверху: список открывают вопросом «что пора возвращать»,
   * и «сначала самые дальние» отвечает на него задом наперёд. Как только человек выбрал столбец
   * сам, направление становится его — своё умолчание тут же перестаёт действовать.
   */
  const sortBy = params.sortBy ?? 'plannedTo';
  const sortOrder = params.sortBy ? params.sortOrder : 'asc';
  const query = { ...params, sortBy, sortOrder, archive: 'exclude' };
  const { data, isFetching } = useQuery({
    queryKey: mechRequestKeys.list(query),
    queryFn: () => mechRequestsApi.list(query),
  });

  // Сводка знает из отборов только площадку: отбор по статусу свёл бы её к самой себе, а по
  // номеру — к одной заявке.
  const summaryQuery = { placeObjectId: params.placeObjectId };
  const { data: summary } = useQuery({
    queryKey: mechRequestKeys.summary(summaryQuery),
    queryFn: () => mechRequestsApi.summary(summaryQuery),
  });
  const summaryItems = [
    { label: 'Не обработано', value: summary?.pending ?? 0 },
    { label: 'Ждут подачи', value: summary?.awaitingIssue ?? 0 },
    { label: 'В аренде', value: summary?.rental ?? 0 },
    { label: 'Просрочено', value: summary?.overdue ?? 0 },
  ];

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MechRequestDto | null>(null);
  const [viewRecord, setViewRecord] = useState<MechRequestDto | null>(null);

  /** Заявка, названная в адресе: по ссылке из соседнего раздела и из письма. */
  const activeTab = useActiveTabKey() === 'requests';
  const opened = useOpenedRecord<MechRequestDto>({
    active: activeTab,
    queryKey: (id) => mechRequestKeys.detail(id),
    fetch: (id) => mechRequestsApi.get(id),
  });
  const shown = viewRecord ?? opened.record;

  const openEdit = (request: MechRequestDto) => {
    setViewRecord(null);
    opened.clear();
    setEditing(request);
    setFormOpen(true);
  };

  /*
   * Наборов действий два, и это не дубль по невнимательности (ADR 0140). Окна списка живут здесь,
   * на уровне вкладки, а окна карточки — внутри карточки: только вложенной модалке antd считает
   * слой, и окно выдачи не уходит под карточку, из которой его позвали. Один набор отрисовать в
   * двух местах нельзя — это два экземпляра одного окна. Состав пунктов при этом один: его решают
   * барьеры контрактов, а не место вызова.
   */
  const actions = useMechRequestActions({ onEdit: openEdit });
  const cardActions = useMechRequestActions({ onEdit: openEdit });

  /*
   * Закрылась карточка — гаснут и её окна. Карточку закрывают не только её кнопками: «Назад»
   * браузера снимает `?open=…`, а на телефоне тот же жест закрывает полноэкранный шит. Взведённая
   * цель осталась бы в наборе, и следующее открытие той же заявки выкидывало бы окно само — с
   * версией, которая к тому времени устарела.
   */
  const closeCardModals = cardActions.close;
  useEffect(() => {
    if (!shown) closeCardModals();
  }, [shown, closeCardModals]);

  const grid = {
    today,
    actions: actions.actionsFor,
    onOpen: (request: MechRequestDto) => setViewRecord(request),
  };
  const columns = mechRequestColumns(grid);

  const canCreate = can('mechRequests.create');
  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

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
        primaryAction: canCreate
          ? { label: 'Заказать технику', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
      }}
      extra={
        canCreate ? (
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Заказать технику
            </Button>
          </Space>
        ) : undefined
      }
    >
      {/* Сводка — на уровне вкладок, над фильтрами и кнопкой: она относится ко всему списку, а не
          к панели инструментов, и там не отнимает высоту у таблицы. */}
      <TabsExtra tabKey="requests">
        <SummaryBar title="Заявок" items={summaryItems} />
      </TabsExtra>

      <DataTable<MechRequestDto>
        columns={columns}
        card={mechRequestCard(grid)}
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

      <MechRequestForm
        open={formOpen}
        request={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <MechRequestViewModal
        request={shown}
        today={today}
        // Правку карточка предлагает по тому же барьеру, что и меню строки: пункт «Редактировать»
        // там есть ровно тогда, когда правка разрешена состоянием и ролью.
        onEdit={
          shown && cardActions.actionsFor(shown).some((item) => item.key === 'edit')
            ? openEdit
            : undefined
        }
        actions={(r) => cardActions.actionsFor(r).filter((item) => item.key !== 'edit')}
        modals={cardActions.modals}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />

      {actions.modals}
    </PageTableLayout>
  );
}
