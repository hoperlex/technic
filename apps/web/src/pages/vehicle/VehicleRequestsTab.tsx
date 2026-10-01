import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canCorrectAssignment,
  canReassignVehicle,
  esm2Mode,
  type FeedKind,
  feedKindLabels,
  parseFeedNumberSearch,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
  allowedVehicleRequestTypes,
  vehicleRequestTypeLabels,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { canOpenRoute, vehicleRouteKeys, vehicleRouteLink } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { useActiveTabKey } from '@shared/ui';
import { useRequestCustomerDefaults, useRequestCustomerFilter } from '@features/request-customer';
import { garageKeys } from '@entities/garage';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useVehicleClassificationFilter } from '@entities/vehicle-type';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { VehicleAssignModal } from '@widgets/vehicle-assignment-dialog';
import * as assignmentModel from '@features/vehicle-assignment';
import { VehicleCompleteModal } from './VehicleCompleteModal';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleEsm2Modal } from './VehicleEsm2Modal';
import { VehicleMachinistModal } from './VehicleMachinistModal';
import { VehicleRepairModal } from './VehicleRepairModal';
import { VehiclePeriodModal } from './VehiclePeriodModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRouteTransferModal } from './VehicleRouteTransferModal';
import { useRouteModal } from '@features/route-modal';
import { useVehicleFilter } from './shared';
import { useWeeklyRequestCreate, weekSelectOptions, weeklyRequestPath } from './weeklyShared';
import { useVehicleRequestEditor, VehicleRelocationModal } from '@widgets/vehicle-request-editor';
import { useVehicleRequestLifecycle } from '@widgets/vehicle-request-lifecycle';
import { VehicleRequestFeed } from '@widgets/vehicle-request-feed';

export function VehicleRequestsTab() {
  const { message } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  // Настоящий переход остался один — недельная заявка: у неё своя страница с адресом, потому что
  // состав в неё правят построчно, и в окно такая работа не помещается (`openWeekly`).
  const navigate = useNavigate();
  // Рейс и список рейсов — окнами поверх этого списка (ADR 0120). Вкладки «Маршруты» больше нет, и
  // вопрос «а где эта заявка едет» перестал стоить ухода с экрана вместе с фильтрами и страницей.
  const { openRoute, openRoutesList } = useRouteModal();
  // Умолчания фильтра «Заказчик» — общим правилом обеих осей (ADR 0201): предрешённый заказчик
  // учётки, и ничего, когда осей у неё две. Состав подбора считает `useRequestCustomerOptions`.
  const customerDefaults = useRequestCustomerDefaults();
  // Перечень — из матрицы и области учётки: отделу с площадкой доступна и спецтехника (ADR 0201).
  const requestTypeOptions = allowedVehicleRequestTypes(user).map((t) => ({
    value: t,
    label: vehicleRequestTypeLabels[t],
  }));
  const canCreate = can('vehicleRequests.create');
  /** Ведение хода заявки: перевод в работу и, тем же правом, смена назначенной машины (ADR 0048). */
  const canChangeStatus = can('vehicleRequests.status');
  /**
   * Заведение недельной заявки (ADR 0085) — по своему праву, а не по факту показа недельных
   * строк: видеть документ теперь могут и те, кто его не заводит (наблюдатель, отдел,
   * арендодатель), и кнопка, выключенная у половины списка, объясняла бы им несуществующий запрет.
   */
  const canCreateWeekly = can('weeklyRequests.create');
  /**
   * «Маршруты» — одна из трёх дверей в список рейсов (план «маршрут и заявка окнами»): здесь, в
   * карточке заявки и в карточке самого рейса. В тулбаре она потому, что день собирают отсюда:
   * заявки подтверждают в этом списке, а раскладывают их по рейсам — в том, и прежде это была
   * соседняя вкладка. Право то же, каким открывается сам рейс: в списке видны чужие машины и ФИО
   * водителей собственного парка.
   */
  const showRoutes = canOpenRoute(can);
  const weeklyCreate = useWeeklyRequestCreate();

  /**
   * Вид документа из адреса: старая вкладка «Недельные заявки» переехала сюда, и её закладки
   * (`?tab=weekly`) ведут теперь на `?tab=requests&kind=weekly` — то есть на этот список,
   * заранее суженный до недельных. Читается один раз, при первом состоянии фильтров: дальше
   * видом распоряжается селект, и адрес перестал бы отвечать тому, что на экране.
   */
  const [searchParams] = useSearchParams();
  const initialKind: FeedKind | undefined =
    searchParams.get('kind') === 'weekly' ? 'weekly' : undefined;

  // requestType не задан — список обоих типов; фильтр в шапке сужает до одного.
  // Все фильтры собраны в панели над таблицей, а не в выпадашках столбцов: в заголовке их
  // не видно, а часть значений (объект, тип ТС) — списки справочников.
  const { params, setParams, setSort, onTableChange } = useListParams<{
    requestType?: string;
    status?: string;
    objectId?: string;
    departmentId?: string;
    /** Заказанная техника (ADR 0028) набором: `t<uuid>` — весь тип, `c<uuid>` — его категория. */
    classifications?: string;
    /** Назначенная машина (ADR 0098): единица парка, а не позиция классификатора. */
    vehicleId?: string;
    num?: number;
    /** Виза (ADR 0025): 'false' — заявки, ждущие согласования. */
    approved?: string;
    /**
     * Вид документа ленты: `weekly` — только недельные заявки. В интерфейсе это третье значение
     * того же селекта, что и тип заявки, но в запрос уходит своим параметром: `requestType` едет
     * ещё и в тело заявки, где третьего значения не существует вовсе.
     */
    kind?: FeedKind;
    /** Неделя недельной заявки; спрашивается только при выбранном её виде. */
    weekStart?: string;
  }>(
    {
      objectId: customerDefaults.objectId,
      departmentId: customerDefaults.departmentId,
      kind: initialKind,
    },
    { searchKeys: ['comment'] },
  );

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    classifications: params.classifications,
    onChange: applyFilter,
  });
  // Отбор по назначенной машине (ADR 0098) — второй вопрос о технике рядом с первым: «какую
  // заказывали» спрашивает классификатор, «какой закрыли» — этот.
  const vehicleFilter = useVehicleFilter({ vehicleId: params.vehicleId, onChange: applyFilter });

  /**
   * Лента раздела, а не список заказов: заказы ТС и недельные заявки приходят одним запросом,
   * одной страницей и в одном порядке (`vehicleRequestsApi.feed`). Отдельным маршрутом, а не
   * флагом у списка: тем списком пользуются «Архив» и подбор заявок в рейс, и недельный документ,
   * который в рейс не ставится, там был бы строкой, которую нельзя выбрать.
   */
  const { data, isFetching } = useQuery({
    queryKey: vehicleRequestKeys.feed(params),
    queryFn: () => vehicleRequestsApi.feed(params),
  });
  // Сводка в шапке: сколько заявок ждёт обработки и сколько в работе. Ключ начинается с
  // 'vehicle-requests' — значит счётчики обновляются теми же инвалидациями, что и список.
  // Сужающие фильтры (заказчик, тип заявки, тип ТС и сама машина) в сводку идут: цифры относятся к
  // тому же списку, что человек видит перед собой. Статус и номер — нет, они свели бы её к самой
  // себе.
  const summaryQuery = {
    objectId: params.objectId,
    // Отдел сужает и цифры (Р9а): иначе таблица сузится, а счётчики над ней останутся по всем.
    departmentId: params.departmentId,
    requestType: params.requestType,
    classifications: params.classifications,
    vehicleId: params.vehicleId,
  };
  const { data: summary } = useQuery({
    queryKey: vehicleRequestKeys.summary(summaryQuery),
    queryFn: () => vehicleRequestsApi.summary(summaryQuery),
  });
  /** Открытая карточка заявки: поля только на чтение и история событий (ADR 0015). */
  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);

  /**
   * Заявка, названная в адресе: сюда приходят по ссылке из состава рейса или из журнала листов.
   * Запись спрашивается по идентификатору, а не ищется в загруженном списке: та же заявка может
   * лежать на другой его странице или под другим фильтром.
   *
   * Недельных идентификаторов здесь не бывает и появиться им неоткуда: недельная строка ведёт на
   * свою страницу (`/vehicle-requests/weekly/:id`), а не открывает карточку в списке, и параметра
   * `open` ни одна ссылка на неделю не ставит. Иначе лента спрашивала бы недельный документ у
   * маршрута заказов и получала бы «Запись не найдена» на каждый такой адрес.
   */
  const opened = useOpenedRecord<VehicleRequestDto>({
    active: useActiveTabKey() === 'requests',
    queryKey: (id) => vehicleRequestKeys.detail(id),
    fetch: (id) => vehicleRequestsApi.get(id),
  });
  const viewed = viewRecord ?? opened.record;
  const closeView = () => {
    setViewRecord(null);
    opened.clear();
  };
  const requestEditor = useVehicleRequestEditor({
    openRoute,
    renderPeriodModal: (props) => <VehiclePeriodModal {...props} />,
  });
  const lifecycle = useVehicleRequestLifecycle({
    staleReasonOf: (error) =>
      assignmentModel.reassignStaleReason(error) ?? assignmentModel.recheckReasonOf(error),
    renderCompleteModal: (props) => <VehicleCompleteModal {...props} />,
    renderEarlyEndApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
    renderEarlyEndModal: (props) => <VehicleEarlyEndModal {...props} />,
  });
  // Смена машины у работающей заявки (ADR 0048) — своим запросом: статус при ней не меняется.
  const [reassignTarget, setReassignTarget] = useState<VehicleRequestDto | null>(null);
  /**
   * Смена машиниста внутри срока и «Состав по датам» (план `docs/assignment-periods-plan.md`,
   * §9); `null` — окно закрыто. Своё окно, а не поле в окне смены техники: там меняют, чем заявку
   * выполняют, — машину, ставки и рейс, — а здесь одно решение о человеке и о дате, с которой он
   * работает.
   */
  const [machinistTarget, setMachinistTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [repairTarget, setRepairTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  /** Заведение перегона: заявка и что именно заводим — доставку или вывоз. */
  const [relocation, setRelocation] = useState<{
    request: VehicleRequestDto;
    purpose: 'delivery' | 'pickup';
  } | null>(null);
  /** Заявка, которую переносят в другой рейс (ADR 0052); null — окно переноса закрыто. */
  const [transferTarget, setTransferTarget] = useState<VehicleRequestDto | null>(null);
  /** Заявка, по которой выписывают недельный ЭСМ-2 (ADR 0100); null — окно закрыто. */
  const [esm2Target, setEsm2Target] = useState<VehicleRequestDto | null>(null);

  const reassignMut = useMutation({
    // The window's command as it is — handshakes included; the body is assembled next to it.
    mutationFn: (v: { id: string; version: number; command: assignmentModel.AssignCommand }) =>
      vehicleRequestsApi.changeAssignment(
        v.id,
        assignmentModel.reassignRequestBody(v.command, v.version),
      ),
    onSuccess: (_updated, v) => {
      message.success(
        v.command.correction ? 'Назначение исправлено задним числом' : 'Техника изменена',
      );
      setReassignTarget(null);
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Заявка переезжает в рейс новой машины — списки маршрутов после этого не те же.
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // Смена машины переписывает и путевые листы: сервер сводит ЭСМ-2 рейса заново (ADR 0037).
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    /*
     * «Последствия изменились» — не ошибка, а вопрос, и отвечает на него окно: оно спрашивает план
     * заново и показывает пересчитанный перечень с объяснением, почему вернулось. Тост здесь был бы
     * вторым голосом о том же — и увёл бы глаз от экрана, на который человеку и надо смотреть.
     */
    onError: (e) => {
      if (assignmentModel.reassignStaleReason(e) ?? assignmentModel.recheckReasonOf(e)) return;
      message.error(errorMessage(e));
    },
  });

  /**
   * Сменить назначенную машину (ADR 0048). Право — то же, которым заявку берут в работу: подбор
   * техники решает диспетчер, а не автор заявки. Состояние спрашивается предикатом из контрактов —
   * тем же, которым отвечает сервер, чтобы кнопка не предлагала отказ.
   */
  const reassignAllowed = (r: VehicleRequestDto) => canChangeStatus && canReassignVehicle(r);

  /**
   * Сменить машиниста внутри срока заявки (план `docs/assignment-periods-plan.md`, §9).
   *
   * Права — те же, какими открыта сама дверь: вести состояние заявки и видеть путевые листы.
   * Коррекционные (`waybills.correct` и глубже тридцати дней) здесь не спрашиваются нарочно — их
   * спрашивает сервер и **по посчитанному исходу**, а не по календарю (Р32): плановая смена с
   * понедельника — обычная работа диспетчера, и запретить её тому, у кого нет права коррекции,
   * значило бы отнять работающее действие. Отказ по исходу окно показывает словами.
   *
   * Состояние заявки спрашивается теми же предикатами, что у смены техники, а режим ведения
   * бумаги — контрактом `esm2Mode`: у линейного заказа машиниста называют при выписке каждого
   * листа (ADR 0100 §6), а на арендную машину бланк выписывает арендодатель — истории человека
   * там не ведётся вовсе, и дверь отвечает на такую команду отказом.
   */
  const machinistChangeAllowed = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    r.requestType === 'special_equipment' &&
    canCorrectAssignment(r) &&
    esm2Mode({
      requestType: r.requestType,
      status: r.status,
      ownership: r.assignment?.ownership ?? null,
      deletedAt: r.deletedAt,
      isLinear: r.isLinear,
    }) === 'auto';

  /**
   * Починка истории (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29).
   *
   * Условия те же, что у смены машиниста, **плюс архив**: архивная заявка с непустой бумагой —
   * ровно тот случай, ради которого дверь ремонта и заведена (коррекция назначения в архиве
   * запрещена, и разомкнуть это больше нечем). Поэтому `canCorrectAssignment` здесь не спрашивается
   * — он отвергает удалённые.
   *
   * Пункт стоит по применимости двери, а не по наличию работы: «есть ли что чинить» знает только
   * осмотр, и спрашивать его для каждой строки списка значило бы слать запрос на страницу. Ответ
   * «чинить нечего» окно говорит словами — это честнее, чем спрятанный пункт меню.
   */
  const historyRepairAllowed = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    r.requestType === 'special_equipment' &&
    r.status === 'confirmed' &&
    !!r.assignment &&
    !r.isLinear &&
    (r.assignment?.ownership ?? 'own') === 'own';

  /** Открыть неделю: у недельной строки это единственное действие и оно же клик по строке. */
  const openWeekly = (weekly: WeeklyVehicleRequestDto) =>
    void navigate(weeklyRequestPath(weekly.id));

  /**
   * «Тип заявки» с третьим значением — видом документа. В интерфейсе это один селект: человек
   * спрашивает «что показать», и «Недельная заявка» стоит для него в одном ряду с «Техникой на
   * объект» и «Грузоперевозкой». В запрос при этом уходит либо `requestType`, либо `kind` —
   * смешивать их в одном параметре нельзя, `requestType` едет ещё и в тело заявки.
   */
  const documentTypeOptions = [
    ...requestTypeOptions,
    { value: 'weekly', label: feedKindLabels.weekly },
  ];
  // В фильтр попадают те же недели, что предлагаются при заведении: прошедшие ищут по номеру —
  // список недель, растущий с каждой неделей, к концу года стал бы нечитаемым.
  const weekOptions = weekSelectOptions();
  const documentTypeValue = params.kind === 'weekly' ? 'weekly' : params.requestType;
  const applyDocumentType = (v: string | undefined) =>
    v === 'weekly'
      ? applyFilter({ kind: 'weekly', requestType: undefined })
      : // Уходя с недельного вида, снимаем и неделю: фильтр, который не показан, продолжал бы
        // сужать выдачу — и заказы вернулись бы не все, а неизвестно почему не все.
        applyFilter({ kind: undefined, weekStart: undefined, requestType: v });

  /**
   * Поиск по номеру разбирает оба префикса: «НЗ-12» ищет неделю, «ТС-341» и голое число — заказ.
   * Номера — две независимые последовательности, поэтому ввод отвечает **парой** «вид + номер», и
   * пара эта уезжает в запрос как есть: искать «12» сразу в обеих значило бы отвечать двумя
   * документами на вопрос об одном.
   *
   * Пустой ввод снимает только номер, а выбранный вид оставляет: очистка строки поиска — это «не
   * ищу конкретный документ», а не «покажи всё подряд».
   */
  const applyNumberSearch = (value: string) => {
    const found = parseFeedNumberSearch(value);
    if (!found) return applyFilter({ num: undefined });
    return applyFilter({
      num: found.num,
      // Заказ ищут и среди недельных строк выбранного вида: номер заказа сам называет, что нужно
      // показать, и держать вид «Недельная заявка» значило бы ответить пустым списком.
      kind: found.kind === 'weekly' ? 'weekly' : undefined,
      ...(found.kind === 'weekly' ? {} : { weekStart: undefined }),
    });
  };

  /**
   * Заказчик в фильтре ленты (Р9) — общим фильтром модуля: тот же подбор, что в форме, и тем же
   * составом групп — своя ось у заявителя, обе у офиса и у тех, кто заявки только читает.
   * Сохранённого значения у фильтра нет: он спрашивает справочник, а не запись. Умолчания (свой
   * объект, свой отдел) остаются параметрами списка выше.
   */
  const customerFilter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    onChange: applyFilter,
  });

  return (
    <VehicleRequestFeed
      rows={data?.items ?? []}
      total={data?.total ?? 0}
      loading={isFetching}
      rights={{
        canApprove: lifecycle.rights.canApprove,
        canCreate,
        canCreateWeekly,
        canDelete: lifecycle.rights.canDelete,
        canEdit: lifecycle.rights.canEdit,
        canRestore: lifecycle.rights.canRestore,
        showRoutes,
      }}
      pending={lifecycle.pending}
      actions={{
        approveEarlyEnd: lifecycle.actions.approveEarlyEnd,
        canChangeMachinist: machinistChangeAllowed,
        canDecideEarlyEnd: lifecycle.actions.canDecideEarlyEnd,
        canModify: lifecycle.actions.canModify,
        canReassign: reassignAllowed,
        canRepairHistory: historyRepairAllowed,
        canRequestEarlyEnd: lifecycle.actions.canRequestEarlyEnd,
        changeApproval: lifecycle.actions.changeApproval,
        changeMachinist: setMachinistTarget,
        changeStatus: lifecycle.actions.changeStatus,
        create: requestEditor.openCreate,
        createWeekly: weeklyCreate.open,
        edit: requestEditor.openEdit,
        openOrder: setViewRecord,
        openRoute,
        openRoutes: () => openRoutesList(),
        openWeekly,
        reassign: setReassignTarget,
        rejectEarlyEnd: lifecycle.actions.rejectEarlyEnd,
        remove: lifecycle.actions.remove,
        repairHistory: setRepairTarget,
        requestEarlyEnd: lifecycle.actions.requestEarlyEnd,
        restore: lifecycle.actions.restore,
        routeLink: (routeId) => vehicleRouteLink(can, routeId),
      }}
      filters={{
        approved: params.approved,
        classificationControls: classificationFilter.controls,
        classificationMobileFilter: classificationFilter.mobileFilter,
        customerControls: customerFilter.controls,
        customerMobileFilter: customerFilter.mobileFilter,
        documentTypeOptions,
        documentTypeValue,
        kind: params.kind,
        num: params.num,
        onApprovalChange: (value) => applyFilter({ approved: value }),
        onDocumentTypeChange: applyDocumentType,
        onNumberSearch: applyNumberSearch,
        onStatusChange: (value) => applyFilter({ status: value }),
        onWeekStartChange: (value) => applyFilter({ weekStart: value }),
        status: params.status,
        vehicleControls: vehicleFilter.controls,
        vehicleMobileFilter: vehicleFilter.mobileFilter,
        weekOptions,
        weekStart: params.weekStart,
      }}
      list={{
        onChange: onTableChange,
        onSortChange: setSort,
        page: params.page,
        pageSize: params.pageSize,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
      }}
      summary={{
        awaitingApproval: summary?.awaitingApproval ?? 0,
        confirmed: summary?.confirmed ?? 0,
        new: summary?.new ?? 0,
        weeklyPending: data?.weeklyPendingCount ?? 0,
      }}
    >
      {requestEditor.node}

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <VehicleRequestViewModal
        request={viewed}
        onClose={closeView}
        earlyEndActions={lifecycle.earlyEndActions}
        onEdit={
          viewed && lifecycle.actions.canModify(viewed)
            ? (r) => {
                closeView();
                requestEditor.openEdit(r);
              }
            : undefined
        }
        onCopy={
          viewed && requestEditor.canCopy(viewed)
            ? (r) => {
                closeView();
                requestEditor.openCopy(r);
              }
            : undefined
        }
        // Смена машины прямо из карточки (ADR 0048): поле «Техника» видно здесь, и менять его
        // логично здесь же, а не возвращаясь в строку списка.
        onReassign={
          viewed && reassignAllowed(viewed)
            ? (r) => {
                closeView();
                setReassignTarget(r);
              }
            : undefined
        }
        // Смена машиниста и «Состав по датам» прямо из карточки: строка «Водитель» отвечает про
        // сегодня, а вопрос «кто работал в марте» задают, глядя на неё. Карточка закрывается —
        // команда меняет версию заявки, и её поля позади устареют.
        onChangeMachinist={
          viewed && machinistChangeAllowed(viewed)
            ? (r) => {
                closeView();
                if (machinistChangeAllowed(r)) setMachinistTarget(r);
              }
            : undefined
        }
        // Перенос заявки в другой рейс (ADR 0052) — тем же правом, что и ход заявки: рейс это
        // ход работы по ней. Карточка закрывается, потому что после переноса её поля устареют —
        // заявка уедет в другой рейс, а с ним, возможно, и на другую машину.
        onTransfer={
          viewed && canChangeStatus && viewed.route && !viewed.route.hasWaybill
            ? (r) => {
                closeView();
                setTransferTarget(r);
              }
            : undefined
        }
        // Перегон техники (миграция 0082) — тем же правом, что и ход заявки: рейс это ход работы
        // по ней. Предлагается у заказа техники на объект в работе: доставку и вывоз выписывают
        // на назначенную машину, а её нет ни у новой заявки, ни у арендной.
        onRelocate={
          viewed &&
          canChangeStatus &&
          viewed.requestType === 'special_equipment' &&
          viewed.status === 'confirmed' &&
          viewed.assignment?.ownership === 'own'
            ? (r, purpose) => {
                closeView();
                setRelocation({ request: r, purpose });
              }
            : undefined
        }
        // Выписка недельного ЭСМ-2 по требованию (ADR 0100 решение 6) — теми же правами, что и
        // выписка листа с рейса: это тот же документ и тот же коридор решений, отдельного права
        // ему не заводили. Предлагается только линейному заказу в работе на собственной машине: у
        // обычного листы выписывает сама заявка, а на арендную бланк выписывает арендодатель.
        // Карточка закрывается — выписка меняет версию заявки, и её поля позади устареют.
        onIssueEsm2={
          viewed &&
          viewed.requestType === 'special_equipment' &&
          viewed.isLinear &&
          viewed.status === 'confirmed' &&
          viewed.assignment?.ownership === 'own' &&
          canChangeStatus &&
          can('waybills.read')
            ? (r) => {
                closeView();
                setEsm2Target(r);
              }
            : undefined
        }
      />

      {/* Недельный ЭСМ-2 по требованию: линейная заявка листов сама не получает, и человек
        выписывает их по неделе за раз (ADR 0100). */}
      <VehicleEsm2Modal
        request={esm2Target}
        onClose={() => setEsm2Target(null)}
        onDone={() => setEsm2Target(null)}
      />

      {/* Доставка техники на объект и вывоз с него: рейс перемещения, по которому выписывается
        4-П. Заводится по желанию — технику могут привезти тралом. */}
      <VehicleRelocationModal
        request={relocation?.request ?? null}
        purpose={relocation?.purpose ?? 'delivery'}
        onClose={() => setRelocation(null)}
        onDone={() => setRelocation(null)}
      />

      {/* Перенос заявки из рейса в рейс: подходящие рейсы того же дня и того же типа техники. */}
      <VehicleRouteTransferModal
        request={transferTarget}
        onClose={() => setTransferTarget(null)}
        onDone={() => setTransferTarget(null)}
      />

      {/* Перевод в работу: техника, ставки (ADR 0027) и фактический срок. Всё уходит тем же
          запросом, что и смена статуса, — заявка не бывает «в работе» ни на чём и не бывает
          взятой на одно время с путевым листом на другое. */}
      <VehicleAssignModal
        request={lifecycle.assignment.target}
        confirmLoading={lifecycle.assignment.pending}
        onCancel={lifecycle.assignment.close}
        onSubmit={lifecycle.assignment.submit}
      />

      {/* Смена техники у заявки в работе (ADR 0048): то же окно подбора, но без фактического
          срока — он уже согласован, и меняется только чем заявку выполняют. */}
      <VehicleAssignModal
        request={reassignTarget}
        mode="reassign"
        confirmLoading={reassignMut.isPending}
        onCancel={() => setReassignTarget(null)}
        // `mutateAsync`, а не `mutate`: окно ждёт ответа сервера — 409 «последствия изменились»
        // лечится повторным показом, и узнать об отказе обязано именно оно (волна 4a).
        onSubmit={(command) =>
          reassignTarget
            ? reassignMut.mutateAsync({
                id: reassignTarget.id,
                version: reassignTarget.version,
                command,
              })
            : undefined
        }
      />

      {/* Смена машиниста внутри срока и «Состав по датам» (план `docs/assignment-periods-plan.md`,
          §9): окно показывает историю заявки отрезками, спрашивает человека и дату, а перед
          записью — цену действия. Окно остаётся открытым после команды: состав по датам обновится
          в нём же, и вторая смена подряд идёт уже с новой версией заявки. */}
      <VehicleMachinistModal
        request={machinistTarget}
        onCancel={() => setMachinistTarget(null)}
        onApplied={() => {
          // Списки за окном устарели: у заявки другая версия, а у недель — другие номера бланков.
          void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
          void qc.invalidateQueries({ queryKey: waybillKeys.root });
        }}
      />

      {/* Починка истории (подэтап 6a): пробелы машиниста, заполнение неизвестных дней и решение о
          машине после конца срока. Окно само спрашивает сервер, что чинить, — портал этого не
          считает: зависит от того, какую бумагу ещё можно отменить. */}
      <VehicleRepairModal
        request={repairTarget}
        onCancel={() => setRepairTarget(null)}
        onRepaired={() => {
          void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
          void qc.invalidateQueries({ queryKey: waybillKeys.root });
        }}
      />

      {lifecycle.node}

      {/* Окно «Заявка на неделю»: спрашивает площадку и неделю, а дальше уводит на страницу
          сборки — состав в модалку не помещается (ADR 0085 §5). */}
      {weeklyCreate.node}
    </VehicleRequestFeed>
  );
}
