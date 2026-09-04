import { useEffect, useMemo, useState } from 'react';
import { App, Button, Segmented, Space } from 'antd';
import { useSearchParams } from 'react-router';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isPlaceScopedRole,
  isServiceRequestEditable,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys, officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { MarkAllChatReadButton } from '@features/service-chat';
import { DataTable, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { serviceRequestCard, serviceRequestColumns, serviceGridView } from './serviceRequestGrid';
import {
  SERVICE_FILTER_FIELDS,
  ServiceFilterBar,
  useServiceQueues,
  useServiceRequestFilters,
  type ServiceListFilters,
} from './serviceRequestFilters';
import { useServiceRequestActions } from './serviceRequestActions';
import type { ServiceMenuItem } from './serviceStatusChoices';
import { serviceActionRow } from './serviceRequestRow';
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
  const query = { ...params, sortBy, sortOrder };

  const { data, isFetching } = useQuery({
    queryKey: serviceRequestKeys.list(query),
    queryFn: () => serviceRequestsApi.list(query),
  });

  /**
   * Гарантии единиц справочника: в заявке лежит снимок реквизитов без срока, а состояние гарантии
   * техники — колонка списка (§9.2). Тот же запрос обслуживает выбор техники в форме, поэтому
   * лишним он не будет. Сервису справочник закрыт (Р7) — у него колонка просто молчит.
   */
  const { data: equipmentOptions = [] } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: can('officeEquipment.read'),
  });
  const warranties = useMemo(
    () => new Map(equipmentOptions.map((option) => [option.value, option.warrantyUntil])),
    [equipmentOptions],
  );
  const warrantyOf = (equipmentId: string) => warranties.get(equipmentId);

  const filters = useServiceRequestFilters({ params, apply: applyFilter });
  // Очереди-пресеты живут рядом с отборами: это те же параметры запроса, и состав их зависит от
  // читателя так же (ADR 0160, решение 9).
  const queues = useServiceQueues();
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
      ...(isServiceRequestEditable(serviceActionRow(request)) && can('serviceRequests.update')
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
    warrantyOf,
    // Учётка уходит в сетку целиком: подпись состояния и её лицо считает `serviceStatusLine`
    // (Р101), а прежний признак «ждут меня» был бы вторым источником того же факта.
    user,
    /*
     * Подпись «Вам: …» ведёт в то же окно, что и пункт меню строки (Р117): главный шаг помечен
     * признаком `primary` там же, где строится сам пункт, — второй карты «статус → окно» здесь нет
     * и быть не должно. Нет доступного пункта — подпись остаётся текстом.
     *
     * Быстрая кнопка «Принять в работу» берёт свой пункт тем же путём, но уже внутри ячейки
     * действий (Р6): признак `primary` у неё тот же, и расходиться им негде.
     */
    primaryAction: (r: ServiceRequestDto) =>
      actions.actionsFor(r).find((item) => item.primary)?.onClick ?? null,
    actions: rowActions,
    // Выдача уходит и в набор колонок (ADR 0160, Р11): столбец «Сумма» один на таблицу, а
    // аудитория — свойство строки, и у исполнителя обе законно лежат в одной выдаче.
    requests: data?.items ?? [],
    // Чей тег ждёт ответа (ADR 0161): действие идёт по одной строке, крутиться обязана она одна.
    pendingId: actions.pendingId,
    onOpen: (request: ServiceRequestDto) => setViewRecord(request),
    // Метка непрочитанного ведёт в окно набора СТРАНИЦЫ: карточка при нажатии на строку ещё не
    // открыта, и вкладывать переписку не во что.
    onChat: actions.openChat,
  };
  const columns = serviceRequestColumns(grid);

  const queue =
    params.waitingOnMe === 'true'
      ? 'waiting'
      : params.urgent === 'true'
        ? 'urgent'
        : params.awaitingDocuments === 'true'
          ? 'documents'
          : 'all';

  const setQueue = (value: string) =>
    setParams((p) => ({
      ...p,
      waitingOnMe: value === 'waiting' ? 'true' : undefined,
      urgent: value === 'urgent' ? 'true' : undefined,
      awaitingDocuments: value === 'documents' ? 'true' : undefined,
      page: 1,
    }));

  const canCreate = can('serviceRequests.create');
  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <PageTableLayout
      filters={
        <ServiceFilterBar
          filters={filters}
          reset={{ active: filtersActive, onClick: resetFilters }}
        />
      }
      toolbar={
        <Space wrap>
          {/* Пресеты стоят над таблицей и на телефоне тоже: это вход в работу, а не фильтр. */}
          <Segmented options={queues} value={queue} onChange={(v) => setQueue(String(v))} />
          {/* Отбор уходит тот же, которым отобран список: кнопка гасит ровно то, что видно. */}
          <MarkAllChatReadButton filters={query} />
        </Space>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'СО-14, модель, инв. или серийный номер',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters,
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
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching || actions.pending || cardActions.pending || removeMutation.isPending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
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
        // Гарантия — вопрос к справочнику по конкретной единице: у заявки без аппарата спрашивать
        // не о чем, и `undefined` означает здесь то же, что и закрытый справочник, — блок гарантии
        // в карточке не рисуется вовсе (Р8).
        equipmentWarrantyUntil={shown?.equipment ? warrantyOf(shown.equipment.id) : undefined}
        // Действия карточки — те же, что у строки: их строит коридор переходов, и разойтись
        // они не могут. Разные у них только окна: карточкины живут внутри неё (ADR 0140).
        actions={cardRowActions}
        pendingId={cardActions.pendingId}
        modals={cardActions.modals}
        onEdit={
          shown &&
          isServiceRequestEditable(serviceActionRow(shown)) &&
          can('serviceRequests.update')
            ? openEdit
            : undefined
        }
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />

      {actions.modals}
    </PageTableLayout>
  );
}
