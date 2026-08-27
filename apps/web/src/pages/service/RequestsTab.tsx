import { useEffect, useMemo, useState } from 'react';
import { App, Button, Segmented, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isPlaceScopedRole,
  isServiceRequestEditable,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys, officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { DataTable, PageTableLayout, sortOptionsFrom, type ActionSheetItem } from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { serviceRequestCard, serviceRequestColumns, serviceGridView } from './serviceRequestGrid';
import {
  SERVICE_FILTER_FIELDS,
  ServiceFilterBar,
  useServiceRequestFilters,
  type ServiceListFilters,
} from './serviceRequestFilters';
import { useServiceRequestActions } from './serviceRequestActions';
import { ServiceRequestForm } from './ServiceRequestForm';
import { ServiceRequestViewModal } from './ServiceRequestViewModal';

/** Очереди-пресеты (§9.2): с них начинают работу оператор и сервис. */
const QUEUES = [
  { value: 'all', label: 'Все заявки' },
  { value: 'waiting', label: 'Требуют решения' },
  // Срочные — вход, а не фильтр: с них начинают день, и прятать их в шит значило бы прятать саму
  // работу (план модернизации, Р56).
  { value: 'urgent', label: 'Срочные' },
  { value: 'documents', label: 'Ожидаются документы' },
] as const;

/**
 * Список заявок на обслуживание оргтехники (ADR 0085).
 *
 * Порядок по умолчанию — возраст в текущем статусе по возрастанию: список открывают вопросом
 * «что стоит дольше всех», и умолчание «по дате заведения» отвечает не на него.
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
  /*
   * Наборов действий два, и это не дубль по невнимательности (ADR 0140). Окна списка живут здесь,
   * на уровне страницы, а окна карточки — внутри карточки: только вложенной модалке antd считает
   * слой, и только так окно назначения не уходит под карточку, из которой его позвали. Один набор
   * отрисовать в двух местах нельзя — это два экземпляра одного окна, — поэтому у карточки свой.
   * Состав пунктов при этом один: его строит коридор переходов, а не место вызова.
   */
  const actions = useServiceRequestActions();
  const cardActions = useServiceRequestActions();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRequestDto | null>(null);
  const [viewRecord, setViewRecord] = useState<ServiceRequestDto | null>(null);

  /** Заявка, названная в адресе: по ссылке из письма и из соседнего списка. */
  const opened = useOpenedRecord<ServiceRequestDto>({
    active: useActiveTabKey() === 'requests',
    queryKey: (id) => serviceRequestKeys.detail(id),
    fetch: (id) => serviceRequestsApi.get(id),
  });
  const shown = viewRecord ?? opened.record;

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
   * есть в «Новой» и «Согласована ИТ», а администратору — в любом статусе. Прежде пункт строился
   * по одному лишь праву `serviceRequests.delete` и предлагался там, где сервер отвечает 403 (Р110)
   * — в том числе отложенной заявке, у которой в меню остаются только возобновление, отмена и
   * перемещение техники.
   */
  const mayDelete = (request: ServiceRequestDto) =>
    can('serviceRequests.delete') &&
    (!isPlaceScopedRole(user?.role) || isServiceRequestEditable(request.status));

  /**
   * Действия записи: сначала ход заявки (его строит коридор переходов), затем правка и удаление —
   * они не переходы, а распоряжение самой записью, и потому стоят ниже.
   *
   * Набор строится от переданного владельца окон: у строки списка он свой, у карточки свой
   * (ADR 0140). Пункт обязан вести в окно того набора, которому принадлежит, — иначе карточка
   * открывала бы окно, живущее снаружи, и оно пряталось бы под ней. Состав пунктов при этом
   * одинаков: его решает коридор, а не место вызова.
   */
  const requestActions =
    (set: ReturnType<typeof useServiceRequestActions>) =>
    (request: ServiceRequestDto): ActionSheetItem[] => [
      ...set.actionsFor(request),
      ...(isServiceRequestEditable(request.status) && can('serviceRequests.update')
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
     */
    primaryAction: (r: ServiceRequestDto) =>
      actions.actionsFor(r).find((item) => item.primary)?.onClick ?? null,
    actions: rowActions,
    onOpen: (request: ServiceRequestDto) => setViewRecord(request),
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
        // Пресеты стоят над таблицей и на телефоне тоже: это вход в работу, а не фильтр.
        <Segmented options={[...QUEUES]} value={queue} onChange={(v) => setQueue(String(v))} />
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
        equipmentWarrantyUntil={shown ? warrantyOf(shown.equipment.id) : undefined}
        // Действия карточки — те же, что у строки: их строит коридор переходов, и разойтись
        // они не могут. Разные у них только окна: карточкины живут внутри неё (ADR 0140).
        actions={cardRowActions}
        modals={cardActions.modals}
        onEdit={
          shown && isServiceRequestEditable(shown.status) && can('serviceRequests.update')
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
