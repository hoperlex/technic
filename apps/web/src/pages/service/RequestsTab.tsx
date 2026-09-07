import { useEffect, useMemo, useState } from 'react';
import { App, Button, Segmented, Space } from 'antd';
import { useSearchParams } from 'react-router';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canChangeRequestAsCustomer,
  isPlaceScopedRole,
  isServiceRequestEditable,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { MarkAllChatReadButton } from '@features/service-chat';
import { DataTable, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { serviceRequestColumns, serviceGridView } from './serviceRequestGrid';
import { serviceRequestCard } from './serviceRequestCard';
import {
  SERVICE_FILTER_FIELDS,
  useServiceRequestFilters,
  type ServiceListFilters,
} from './serviceRequestFilters';
import { useServiceQueue } from './serviceRequestQueues';
import { serviceRepeatQuery, useServiceRepeatMode } from './serviceRequestRepeat';
import { ServiceFilterBar } from './ServiceFilterBar';
import { useServiceRequestActions } from './serviceRequestActions';
import { useServiceBulk } from './ServiceBulkBar';
import type { ServiceMenuItem } from './serviceStatusChoices';
import { serviceActionRow, serviceRequestCustomerFacts } from './serviceRequestRow';
import { ServiceRequestForm } from './ServiceRequestForm';
import { ServiceRequestViewModal } from './ServiceRequestViewModal';

/**
 * Список заявок на обслуживание оргтехники (ADR 0085).
 *
 * Порядок по умолчанию — возраст текущего ожидания по возрастанию (Р4): список открывают вопросом
 * «что стоит дольше всех», и умолчание «по дате заведения» отвечает не на него. Меряется именно
 * ожидание, а не статус: сервер обнуляет колонку, когда меняется тот, кого ждут.
 *
 * Очереди-пресеты — не фильтры, а входы: «Требуют решения» и «Ожидаются документы» отвечают на
 * два вопроса, с которых начинается день оператора, и прятать их в шит фильтров значило бы
 * прятать саму работу.
 */
export function RequestsTab() {
  const { user, can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const view = useMemo(() => serviceGridView(user), [user]);

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } =
    useListParams<ServiceListFilters>(
      {},
      {
        // Поиск живёт лупой столбца «Техника»: сервер ищет по модели, обоим номерам и номеру заявки.
        searchKeys: ['equipment'],
        filterKeys: SERVICE_FILTER_FIELDS,
        /*
         * Набор отборов переживает перезагрузку и утренний вход (ADR 0139): оператор работает не
         * со списком вообще, а со своим срезом — своя площадка, свой подрядчик, — и выставлять
         * его заново после каждого `F5` он не должен.
         *
         * Очередь-пресет над таблицей сохраняется вместе с отборами: это те же три параметра
         * (`waitingOnMe`, `urgent`, `awaitingDocuments`), и разделять их значило бы заводить
         * исключение. Выбранная очередь при этом всегда видна переключателем — вопрос «почему я
         * вижу не всё» отвечается с экрана, а не догадкой.
         */
        persist: { scope: 'service-requests', userId: user?.id },
      },
    );

  const applyFilter = (patch: ServiceListFilters) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const sortBy = params.sortBy ?? 'statusChangedAt';
  const sortOrder = params.sortBy ? params.sortOrder : 'asc';
  // Режим «предыдущие» не сочетается с отбором (Р10): сочетание гасится ДО сети, а не эффектом.
  const query = serviceRepeatQuery({ ...params, sortBy, sortOrder });

  const { data, isFetching } = useQuery({
    queryKey: serviceRequestKeys.list(query),
    queryFn: () => serviceRequestsApi.list(query),
  });

  /*
   * Гарантии справочник больше не спрашивают вовсе (Ф3 плана кандидата): срок гарантии единицы
   * приезжает в самой строке заявки (`equipment.warrantyUntil`), и колонке «Гарантия» хватает
   * выдачи списка. Прежний запрос брал весь парк страницей в 500 строк — потолок Н11, из-за
   * которого колонка замолчала бы у части строк молча, — и снят он вместе со своим ключом кэша.
   */

  // Строки страницы спрашивают трое: таблица, набор колонок (ADR 0160) и набор отборов — «Только
  // повторные» показывается, лишь когда признак повтора включён (Р5).
  const items = data?.items ?? [];
  const filters = useServiceRequestFilters({ params, apply: applyFilter, rows: items });
  // Очереди-пресеты живут рядом с отборами: это те же параметры запроса, и состав их зависит от
  // читателя так же (ADR 0160, решение 9).
  const queue = useServiceQueue({ params, setParams });
  /*
   * Наборов действий два, и это не дубль по невнимательности (ADR 0140). Окна списка живут здесь,
   * на уровне страницы, а окна карточки — внутри карточки: только вложенной модалке antd считает
   * слой, и только так окно назначения не уходит под карточку, из которой его позвали. Один набор
   * отрисовать в двух местах нельзя — это два экземпляра одного окна, — поэтому у карточки свой.
   * Состав пунктов при этом один: его решают заявка и субъект, а не место вызова.
   */
  const actions = useServiceRequestActions();
  const cardActions = useServiceRequestActions();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRequestDto | null>(null);
  const [viewRecord, setViewRecord] = useState<ServiceRequestDto | null>(null);

  /** Заявка, названная в адресе: по ссылке из письма и из соседнего списка. */
  const activeTab = useActiveTabKey() === 'requests';
  const opened = useOpenedRecord<ServiceRequestDto>({
    active: activeTab,
    queryKey: (id) => serviceRequestKeys.detail(id),
    fetch: (id) => serviceRequestsApi.get(id),
  });
  const shown = viewRecord ?? opened.record;

  /*
   * Ссылка «предыдущие» из карточки (Р10 плана повторов): режим приходит адресом и ЗАМЕЩАЕТ отбор
   * целиком — иначе запомненный с прошлого сеанса фильтр (ADR 0139) дал бы 422 либо список, не
   * совпадающий с числом в теге. Карточку он закрывает: ссылку нажимают в ней, а ведёт она вниз.
   */
  const repeat = useServiceRepeatMode({ params, setParams, onEnter: () => setViewRecord(null) });

  /*
   * `?open=<id>&chat=1` — карточка с раскрытым обсуждением (§3.7). Заведено не сегодняшнему
   * порталу, а завтрашнему письму «перейти к обсуждению»: адрес обязан существовать раньше
   * ссылки, иначе первое же письмо потребует выката портала.
   *
   * Окно открывается набором КАРТОЧКИ (ADR 0140) — карточка тут открыта, и снаружи переписка
   * ушла бы под неё. Параметр после открытия снимается: оставленный, он выкидывал бы окно заново
   * при каждом закрытии — человек закрыл переписку, а адрес просит её открыть.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const chatRequested = activeTab && searchParams.get('chat') === '1';
  const openCardChat = cardActions.openChat;
  useEffect(() => {
    if (!chatRequested || !shown) return;
    openCardChat(shown);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('chat');
        return next;
      },
      { replace: true },
    );
  }, [chatRequested, shown, openCardChat, setSearchParams]);

  /*
   * Закрылась карточка — гаснут и её окна (ADR 0140). Карточку закрывают не только её кнопками:
   * «Назад» браузера снимает `?open=…`, а на телефоне тот же жест закрывает полноэкранный шит.
   * Элемент окна уезжает вместе с детьми карточки, но взведённая цель осталась бы в наборе — и
   * следующее открытие той же заявки выкидывало бы окно само, без нажатия и с ревизией, которая к
   * тому времени устарела. Списку такой уборки не нужно: его окна карточке не подчинены.
   */
  const closeCardModals = cardActions.close;
  useEffect(() => {
    if (!shown) closeCardModals();
  }, [shown, closeCardModals]);

  const removeMutation = useMutation({
    mutationFn: (id: string) => serviceRequestsApi.remove(id),
    onSuccess: () => {
      message.success('Заявка удалена');
      // Карточка удалённой заявки закрывается вместе с адресом: открытая, она показывала бы
      // запись, которой в этом списке больше нет.
      setViewRecord(null);
      opened.clear();
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openEdit = (request: ServiceRequestDto) => {
    setViewRecord(null);
    opened.clear();
    setEditing(request);
    setFormOpen(true);
  };

  /**
   * Разрешает ли сторона заказчика РАСПОРЯЖАТЬСЯ ЭТОЙ ЗАПИСЬЮ — то есть править её и уводить в
   * архив. Тот же предикат, что стоит на обеих серверных дверях (`assertServiceRequestEditable` и
   * `assertServiceRequestDeletable`, план профилей оргтехники, Р6 и находка Н8).
   *
   * Второй копии правила портал не заводит: предикат живёт в контрактах, признаки для него собирает
   * общий адаптер карточки, и обе стороны зовут одну функцию. Своё условие здесь («а не менеджер ли
   * это с набором „Заявитель“», «а не сисадмин ли это со сквозной областью») разошлось бы с
   * сервером в первую же правку состава профилей.
   *
   * СУЖАЕТ ОН ДВОИХ: держателя набора «Заявитель» у роли без оси (правило автора) и держателя
   * сквозной области модуля — сисадмина, — которому правка и удаление открыты только на своих
   * заявках и на заявках его настоящей области. У всех прочих ответ прежний, без единого
   * дополнительного условия: администратор, «Ведение», подрядчик и штаб своей площадки видят ровно
   * те же пункты, что и до правила. Ставится он тем не менее рядом с правом, а не вместо него:
   * право отвечает «положено ли действие вообще», предикат — «на этой ли строке».
   *
   * ПОДШИВКИ ДОКУМЕНТОВ ЭТОТ ПРЕДИКАТ НЕ КАСАЕТСЯ, и это не забывчивость: назначенный исполнитель
   * прикладывает акт к заявке чужой площадки — ради этого его и назначали, — поэтому вкладка
   * документов зовёт прежний `actsAsRequestCustomer`, ровно как и сервер на своём общем входе.
   */
  const actsAsCustomer = (request: ServiceRequestDto): boolean =>
    canChangeRequestAsCustomer(user, serviceRequestCustomerFacts(request));

  /**
   * Кому и когда позволено снести заявку в архив — тем же условием, что проверяет сервер
   * (`assertServiceRequestEditable`): площадочной роли снос открыт только пока заявку правят, то
   * есть пока она «Новая» и за ней никто не стоит, а администратору — в любом статусе. Прежде пункт
   * строился по одному лишь праву `serviceRequests.delete` и предлагался там, где сервер отвечает
   * 403 (Р110) — в том числе отложенной заявке, у которой в меню остаются только возобновление,
   * отмена и перемещение техники.
   *
   * Предикат читает СТРОКУ, а не статус (Р14): после слияния «Новая» бывает и назначенной, и правку
   * там уже закрыли — за заявкой стоят договорённости с исполнителем.
   */
  const mayDelete = (request: ServiceRequestDto) =>
    can('serviceRequests.delete') &&
    actsAsCustomer(request) &&
    (!isPlaceScopedRole(user?.role) || isServiceRequestEditable(serviceActionRow(request)));

  /**
   * Действия записи: сначала ход заявки (коридор там, где действие ещё переход, и предикаты Р11 там,
   * где оно им быть перестало), затем правка и удаление — они не ход, а распоряжение самой записью,
   * и потому стоят ниже.
   *
   * Набор строится от переданного владельца окон: у строки списка он свой, у карточки свой
   * (ADR 0140). Пункт обязан вести в окно того набора, которому принадлежит, — иначе карточка
   * открывала бы окно, живущее снаружи, и оно пряталось бы под ней. Состав пунктов при этом
   * одинаков: его решают заявка и субъект, а не место вызова.
   */
  const requestActions =
    (set: ReturnType<typeof useServiceRequestActions>) =>
    (request: ServiceRequestDto): ServiceMenuItem[] => [
      ...set.actionsFor(request),
      // Правка: право, открытая правка по строке и сторона заказчика ЭТОЙ строки (Р6). Третий
      // сомножитель ничего не отбирает у тех, кого правило не касается, — предикат отвечает им «да».
      ...(isServiceRequestEditable(serviceActionRow(request)) &&
      can('serviceRequests.update') &&
      actsAsCustomer(request)
        ? [
            {
              key: 'edit',
              label: 'Редактировать',
              onClick: () => openEdit(request),
            },
          ]
        : []),
      ...(mayDelete(request)
        ? [
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              onClick: () =>
                modal.confirm({
                  title: `Удалить заявку ${request.displayNumber}?`,
                  content: 'Заявка уйдёт в архив: восстановить её сможет администратор.',
                  okText: 'Удалить',
                  okButtonProps: { danger: true },
                  cancelText: 'Отмена',
                  onOk: () => removeMutation.mutateAsync(request.id),
                }),
            },
          ]
        : []),
    ];

  const rowActions = requestActions(actions);
  const cardRowActions = requestActions(cardActions);

  const grid = {
    view,
    // Учётка уходит в сетку целиком: подпись состояния и её лицо считает `serviceStatusLine`
    // (Р101), а прежний признак «ждут меня» был бы вторым источником того же факта.
    user,
    /*
     * Подпись «Вам: …» и быстрая кнопка «Принять в работу» берут свой пункт из ЭТОГО набора по
     * признаку `primary` (Р117, Р6) — каждая внутри своей ячейки. Отдельного обработчика для
     * подписи здесь больше нет: он строил набор заново, третий раз на ту же строку, и был вторым
     * источником одного факта.
     */
    actions: rowActions,
    // Выдача уходит и в набор колонок (ADR 0160, Р11): столбец «Сумма» один на таблицу, а
    // аудитория — свойство строки, и у исполнителя обе законно лежат в одной выдаче.
    requests: items,
    // Чей тег ждёт ответа (ADR 0161): действие идёт по одной строке, крутиться обязана она одна.
    pendingId: actions.pendingId,
    onOpen: (request: ServiceRequestDto) => setViewRecord(request),
    // Метка непрочитанного ведёт в окно набора СТРАНИЦЫ: карточка при нажатии на строку ещё не
    // открыта, и вкладывать переписку не во что.
    onChat: actions.openChat,
  };
  const columns = serviceRequestColumns(grid);

  const canCreate = can('serviceRequests.create');
  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <PageTableLayout
      filters={
        <ServiceFilterBar
          filters={repeat.active ? [] : filters}
          reset={{ active: filtersActive, onClick: resetFilters }}
        />
      }
      toolbar={
        /* В режиме «предыдущие» вместо очередей стоит плашка режима: очередь дописала бы к
           `repeatFor` отбор, которого сервер не принимает, а «Отметить все прочитанными» —
           единственная ручка, применяющая набор БЕЗ этого режима: она погасила бы не то, что
           видно, а всю область читателя. */
        repeat.banner ?? (
          <Space wrap>
            {/* Пресеты стоят над таблицей и на телефоне тоже: это вход в работу, а не фильтр. */}
            <Segmented {...queue} />
            {/* Отбор уходит тот же, которым отобран список: кнопка гасит ровно то, что видно. */}
            <MarkAllChatReadButton filters={query} />
          </Space>
        )
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'СО-14, модель, инв. или серийный номер',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: repeat.active ? [] : filters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
      }}
      extra={
        canCreate ? (
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Создать заявку
            </Button>
          </Space>
        ) : undefined
      }
    >
      <DataTable<ServiceRequestDto>
        columns={columns}
        card={serviceRequestCard(grid)}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching || actions.pending || cardActions.pending || removeMutation.isPending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
        selection={useServiceBulk(grid, query)}
      />

      <ServiceRequestForm
        open={formOpen}
        request={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <ServiceRequestViewModal
        request={shown}
        // Действия карточки — те же, что у строки: их строит коридор переходов, и разойтись
        // они не могут. Разные у них только окна: карточкины живут внутри неё (ADR 0140).
        actions={cardRowActions}
        pendingId={cardActions.pendingId}
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
