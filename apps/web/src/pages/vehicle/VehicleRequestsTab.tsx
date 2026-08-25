import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  type TableColumnType,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
  UserSwitchOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type AssignVehicleBody,
  type CorrectAssignmentBody,
  type ConfirmScheduleBody,
  assignmentRateLabel,
  assignmentTitle,
  canCorrectAssignment,
  canOrderVehicleRequestType,
  canReassignVehicle,
  canRequestEarlyEnd,
  canShortenWorkPeriodByEdit,
  type CompleteVehicleRequestInput,
  // Ключ заказчика собирают контракты (план Р2): своего представления о формате в портале нет.
  costTargetKeyOf,
  costTargetOf,
  esm2Mode,
  type FeedKind,
  feedKindLabels,
  minRequestDateKey,
  isCargoAmountRequired,
  CARGO_AMOUNT_MESSAGE,
  isVehicleKindAllowedForRequest,
  moscowDateKeyOf,
  // Какую дату двигает правка и уходит ли она в прошлое (ADR 0101, §4) — тем же контрактом, каким
  // это решает сервер: форма спрашивает причину ровно там, где её спросит ручка.
  movedRequestDateKey,
  type RequestCalendar,
  normalizeTimeInput,
  parseFeedNumberSearch,
  parseVehicleClassificationKey,
  REQUEST_CUSTOMER_LOCKED_MESSAGE,
  REQUEST_STATUSES,
  type RequestStatus,
  requestCustomerLabel,
  requestStatusLabels,
  requestTypeChangeBlocker,
  ROLLBACK_WAYBILL_MESSAGE,
  routeDateMismatch,
  type SpecialEquipmentRequestDto,
  statusChangeRequiresReason,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  transitionResetsWork,
  vehicleClassificationLabel,
  type VehicleFeedRow,
  type VehicleRequestDto,
  type VehicleRequestType,
  vehicleRequestTypeColors,
  allowedVehicleRequestTypes,
  vehicleRequestTypeLabels,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { vehicleRequestsApi, type VehicleRequestPeriodResultDto } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { CancelReasonModal, RollbackReasonModal } from '../../components/CancelReasonModal';
import { DataTable, type CardConfig } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { ExpandableCell } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { SummaryBar } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { UserAvatar } from '../../components/UserAvatar';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { departmentPlatformQuery } from '@entities/department';
// Подбор «Объект/отдел» — общий модуль (план `docs/department-requests-plan.md`, §9 п. 1): то же
// поле спрашивает и заявка на обслуживание оргтехники.
import {
  RequestCustomerSelect,
  useRequestCustomerFilter,
  useRequestCustomerOptions,
} from '@features/request-customer';
import { garageKeys } from '@entities/garage';
import { useIsMobile } from '@shared/lib';
import { useListParams } from '@shared/lib';
import { useOpenedRecord } from '@shared/lib';
import {
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
} from '../../hooks/useVehicleClassifications';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDate, formatDateTime } from '../../utils/format';
import { canOpenRoute, vehicleRouteLink } from '../../utils/links';
import { withSavedOption } from '@shared/lib';
import { calendarDaysLabel, vehicleRequestDateRules } from '../../utils/date';

import { FilesCell } from '../../components/FileLinks';
import { VehicleAssignModal } from './VehicleAssignModal';
import { reassignStaleReason } from './ReassignPreview';
import { VehicleCompleteModal } from './VehicleCompleteModal';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleEsm2Modal } from './VehicleEsm2Modal';
import { VehicleMachinistModal } from './VehicleMachinistModal';
import { VehicleRepairModal } from './VehicleRepairModal';
import { VehiclePeriodModal, type VehiclePeriodCommand } from './VehiclePeriodModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRelocationModal } from './VehicleRelocationModal';
import { RequestRelocationsField } from './RequestRelocationsField';
import { VehicleBackdateFields } from './VehicleBackdateFields';
import { VehicleRouteTransferModal } from './VehicleRouteTransferModal';
import { useRouteModal } from './routeModal';
import { useObjectScope } from '../../hooks/useObjectScope';
import { useDepartmentScope } from '../../hooks/useDepartmentScope';
import { MOSCOW_TZ } from '@shared/config';
import { ApprovalCell, StatusCell } from './requestRowCells';
import { RequestTripsBlock } from './RequestTripsBlock';
import {
  blankTrip,
  editTripBody,
  newTripBody,
  tripNeedsList,
  tripToForm,
  type TripFormValue,
} from './requestTripsForm';
import { rollbackErases, retypeErases, termLabel } from './requestRowText';
import {
  EarlyEndTag,
  FileEditor,
  RequestAssignmentCell,
  RequestContactsCell,
  useEarlyEnd,
  VehicleClassificationSelect,
  useFileEditor,
  useVehicleClassificationFilter,
  useVehicleFilter,
  type EditorFile,
} from './shared';
import {
  WeeklyApprovalCell,
  WeeklyCommentCell,
  WeeklyCompositionCell,
  WeeklyContactsCell,
} from './weeklyFeedRow';
import {
  useWeeklyRequestCreate,
  weekSelectOptions,
  weeklyCountsText,
  weeklyRequestPath,
  WeeklyStatusTag,
} from './weeklyShared';

/**
 * Единая форма заявки на автотехнику. Тип заявки выбирают явно — он задаёт и набор полей,
 * и список доступной техники: на объект заказывают технику любого вида, грузоперевозку —
 * только грузовым (`isVehicleKindAllowedForRequest`). Поля чужого типа скрыты вместе с
 * лейблами, пока тип заявки не выбран — не видно ни одного из двух блоков.
 */
interface FormValues {
  requestType: VehicleRequestType;
  /**
   * Заказчик (ADR 0040) одним ключом `object:<id>` | `department:<id>` (план Р2): пара колонок для
   * тела запроса собирается из выбранной опции (`customerPairOf`), а не разбором строки.
   */
  customerKey?: string;
  /** Ключ позиции классификатора «тип:категория» (ADR 0028); в API уходит парой полей. */
  classificationKey: string;
  // Техника на объект: период работы (date-only) и контакт встречающего.
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  responsibleName?: string;
  responsiblePhone?: string;
  // Грузоперевозка: дата + необязательное время `HH:mm` первой подачи (Р3) и список ездок.
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  /**
   * Ездки заявки (Р1, Р2 плана `docs/route-trips-plan.md`): адреса, количество и контакты обоих
   * концов лежат у них, а не у заявки — у заявки с ездками `A→B` и `A→C` «адреса разгрузки
   * заявки» не существует.
   *
   * Списком в значениях формы, а не антовским `Form.List`: адресное поле и контакт зовут форму
   * напрямую и путь к полю знают целиком (`trips.3.fromLocation`), а `Form.List` подставляет свой
   * префикс только элементам `Form.Item`. Ведёт список `RequestTripsBlock`.
   */
  trips?: TripFormValue[];
  comment?: string;
  /**
   * Причина заднего числа (ADR 0101). Полем формы, а не состоянием экрана: показывается оно по
   * выбранной дате, и `resetFields` обязан уносить его вместе с ней — иначе объяснение вчерашней
   * заявки уехало бы в следующую, заведённую в том же окне.
   */
  backdateReason?: string;
}

/**
 * Вход сохранения формы: значения плюс уже проведённая правка срока (волна 4a плана
 * `docs/assignment-periods-plan.md`).
 *
 * `period` приходит там, где срок ушёл своей дверью, и несёт две вещи, которых у формы больше нет:
 * **свежую версию** заявки (дверь её подняла — старая ответила бы 409) и признак того, что
 * календарь этой правкой уже сдвинут, а значит второй записи в журнал коррекций не положено.
 */
interface SaveInput {
  v: FormValues;
  period?: VehicleRequestPeriodResultDto;
}

/**
 * Комментарий — единственное место, где автор объясняет суть заказа, и объясняет он разное:
 * у грузоперевозки диспетчеру нужно знать груз (от него зависит машина и погрузка), у техники
 * на объект — какие работы её ждут. Поэтому заголовок уточняется типом заявки, а пример
 * заполнения стоит в самом поле: без него комментарий приходит пустым или бесполезным
 * («срочно»), и детали всё равно выясняются звонком.
 */
const COMMENT_HINTS: Record<VehicleRequestType, { label: string; placeholder: string }> = {
  special_equipment: {
    label: 'Комментарий (планируемые задачи)',
    placeholder:
      'Например: разработка котлована под фундамент, погрузка грунта в самосвалы; заезд с ул. Ленина, работы с 08:00',
  },
  freight_transport: {
    label: 'Комментарий (опишите груз)',
    placeholder:
      'Например: плиты перекрытия ПК 60-15, 12 шт, 14 т; погрузка краном поставщика, на объекте нужен манипулятор',
  },
};

const SPECIAL_FIELDS = ['dateFrom', 'dateTo', 'responsibleName', 'responsiblePhone'] as const;
// Адреса, груз и контакты лежат внутри `trips` (Р2), поэтому сбрасываются вместе со списком одним
// именем: перечислять поля ездок здесь пришлось бы с номерами строк, которых форма заранее не
// знает.
const FREIGHT_FIELDS = ['scheduledDate', 'scheduledTime', 'trips'] as const;

/**
 * Строка ленты с ключом таблицы. `id` дописывается на клиенте: у размеченного объединения общего
 * поля идентификатора нет и быть не должно — заказ и неделя это разные документы, — а `DataTable`
 * различает строки одним именем поля. Идентификаторы UUID из двух таблиц не совпадают, поэтому
 * ключ остаётся уникальным по всей ленте.
 */
type FeedRow = VehicleFeedRow & { id: string };

const feedRowId = (row: VehicleFeedRow): string =>
  row.kind === 'order' ? row.order.id : row.weekly.id;

/** Прочерк колонки, у которой в недельной строке значения нет по существу документа. */
const dash = <Typography.Text type="secondary">—</Typography.Text>;

export function VehicleRequestsTab() {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  // Настоящий переход остался один — недельная заявка: у неё своя страница с адресом, потому что
  // состав в неё правят построчно, и в окно такая работа не помещается (`openWeekly`).
  const navigate = useNavigate();
  // Рейс и список рейсов — окнами поверх этого списка (ADR 0120). Вкладки «Маршруты» больше нет, и
  // вопрос «а где эта заявка едет» перестал стоить ухода с экрана вместе с фильтрами и страницей.
  const { openRoute, openRoutesList } = useRouteModal();
  // Объектные роли — область видимости (свои объекты, заявка до «В работе»); действия — по
  // правам (ADR 0021). Виза — право руководителя строительства (ADR 0025).
  const { isObjectRole, soleObjectId, ownObjectIds } = useObjectScope();
  // Вторая ось заказчика (ADR 0040): отдел вместо объекта — у роли она ровно одна. Состав подбора
  // по обеим осям считает `useRequestCustomerOptions`, здесь от них остались только умолчания
  // фильтра: единственный объект и единственный отдел учётки.
  const { soleDepartmentId } = useDepartmentScope();
  // Отдел заказывает только грузоперевозки: перечень берётся из матрицы, а не из имени роли.
  const requestTypeOptions = allowedVehicleRequestTypes(user).map((t) => ({
    value: t,
    label: vehicleRequestTypeLabels[t],
  }));
  const canEdit = can('vehicleRequests.update');
  const canDelete = can('vehicleRequests.delete');
  const canCreate = can('vehicleRequests.create');
  const canApprove = can('vehicleRequests.approve');
  const canRestore = can('archive.restore');
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

  // С одним объектом он зафиксирован и в фильтре списка, и в форме заявки; с несколькими —
  // выбор сужен до своих (ADR 0039). Сервер всё равно отвечает 403 на чужой — assertObjectScope.
  const ownObjectId = soleObjectId ?? '';

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
      objectId: ownObjectId || undefined,
      departmentId: soleDepartmentId ?? undefined,
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
    queryKey: ['vehicle-requests', 'feed', params],
    queryFn: () => vehicleRequestsApi.feed(params),
  });
  const items: FeedRow[] = (data?.items ?? []).map((row) => ({ ...row, id: feedRowId(row) }));

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
    queryKey: ['vehicle-requests', 'summary', summaryQuery],
    queryFn: () => vehicleRequestsApi.summary(summaryQuery),
  });
  const summaryItems = [
    { label: 'Не обработанных', value: summary?.new ?? 0 },
    // Заявка без визы не двинется дальше «Новой», и по статусам это не видно (ADR 0025).
    { label: 'Ждут визы', value: summary?.awaitingApproval ?? 0 },
    { label: requestStatusLabels.confirmed, value: summary?.confirmed ?? 0 },
    // Цифра, ради которой у недельных заявок была отдельная вкладка: неделя площадки стоит и ждёт
    // решения, а сроки продлятся только визой (ADR 0085 Р6). Считается по области учётки, а не по
    // фильтрам ленты, — как и три цифры слева, она о работе, а не о текущей выдаче.
    { label: 'Недельных ждут визы', value: data?.weeklyPendingCount ?? 0 },
  ];

  const { byKey: classificationByKey, groups, loading: typesLoading } = useVehicleClassifications();

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleRequestDto | null>(null);
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
    queryKey: (id) => ['vehicle-requests', id],
    fetch: (id) => vehicleRequestsApi.get(id),
  });
  const viewed = viewRecord ?? opened.record;
  const closeView = () => {
    setViewRecord(null);
    opened.clear();
  };
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();

  // Тип заявки выбирают в форме первым — от него зависят и поля, и список типов ТС, и состав
  // подбора заказчика: спецтехника выходит на площадку, и отделов в ней нет вовсе (Р4).
  const watchRequestType = Form.useWatch('requestType', form);
  const isSpecial = watchRequestType === 'special_equipment';

  /**
   * Заказчик правимой заявки (К7): ссылка и подпись — из самой записи, а не из действующего
   * справочника. Объект закрыли, отдел расформировали, а заявка на них заведена; поле
   * обязательное, и без сохранённого варианта правка начиналась бы с пустого заказчика. Разбирать
   * пару колонок нечем и незачем: заполнена ровно одна её половина (CHECK), и готовый объект
   * затрат приходит в DTO — тем же `costTargetOf`, каким его считает сервер.
   *
   * Только при открытом окне: закрытое держит запись прошлой правки, и её вариант, добавленный к
   * списку, сбил бы счёт «вариант один», по которому заведение подставляет заказчика (Р3а).
   * Отменённый типом род (отдел у спецтехники, ADR 0091) отсеивает сам подбор — правило про состав
   * поля живёт там же, где состав, и форме его не повторять (Р4, К8).
   */
  const savedTarget = open && record ? costTargetOf(record) : null;
  const savedCustomer = savedTarget
    ? { target: savedTarget, label: `${savedTarget.code} — ${savedTarget.name}` }
    : null;
  /**
   * Заказчик формы: группы, запертость, единственный вариант и сохранённое значение — одним
   * ответом (план Р3). Разложенные по местам, они разъезжались бы: запертость считается по обеим
   * группам сразу, а сохранённое значение обязано попадать в свою.
   */
  const customer = useRequestCustomerOptions({
    // Спецтехника отделов не знает (Р4): группы «Отделы» при ней нет вовсе, а стоящее в поле
    // подразделение убирает сама форма — модуль лишь перестаёт его предлагать (К8).
    departments: isSpecial ? 'none' : 'scope',
    saved: savedCustomer,
  });
  // Заказчика меняют только у «Новой» (Р7): у взятой в работу объект затрат уже ушёл снимком в
  // строки задания путевого листа, и перенос заявки разошёлся бы с выписанной бумагой.
  // Ограничение серверное (422), поле лишь показывает его заранее и говорит почему.
  const customerLocked = !!record && record.status !== 'new';

  /**
   * Что предложить первой строкой в списке мест (ADR 0069): площадку заявки, затем площадки
   * учётки. Заказчика меняют, не закрывая форму, поэтому пара берётся из самой формы, а не из
   * заявки; у заказчика-отдела своей площадки в форме нет — её даёт карта отделов (ADR 0062).
   *
   * Список короткий и без записей без адреса: чего в справочнике мест нет, того и предлагать
   * нечем — этим занимается сам компонент поля.
   */
  const formCustomer = customer.customerPairOf(Form.useWatch('customerKey', form));
  const { data: departmentPlatforms } = useQuery(departmentPlatformQuery());
  const suggestObjectIds = useMemo(() => {
    const departmentObjectId = formCustomer.departmentId
      ? departmentPlatforms?.get(formCustomer.departmentId)
      : undefined;
    const ids = [formCustomer.objectId, departmentObjectId, ...ownObjectIds];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }, [formCustomer.objectId, formCustomer.departmentId, departmentPlatforms, ownObjectIds]);

  /**
   * Тип правимой заявки остаётся в списке, даже если роли он недоступен (ADR 0040): подписать
   * значение вне списка `AutoSelect` нечем — показался бы код.
   */
  const formRequestTypeOptions = withSavedOption(requestTypeOptions, {
    id: record?.requestType,
    name: record ? vehicleRequestTypeLabels[record.requestType] : null,
  });

  /**
   * Можно ли переоформить правимую заявку в другой тип (ADR 0091) — и если нет, то почему.
   * Правило и текст берутся из контрактов: сервер отвечает ими же, и разойдись они, поле
   * предлагало бы выбор, который потом отклоняют.
   *
   * Вид заказанной техники берётся из справочника классификации по позиции самой заявки. Позиции
   * может там не оказаться — её выключили или заявка старше категорий, — и тогда смена типа
   * закрыта: сервер такую позицию всё равно не примет (`resolveClassification`).
   */
  const recordKindCode = record
    ? (classificationByKey.get(classificationKeyOf(record))?.kindCode ?? null)
    : null;
  const otherRequestType: VehicleRequestType | null = record
    ? record.requestType === 'special_equipment'
      ? 'freight_transport'
      : 'special_equipment'
    : null;
  /** Причина, по которой тип заперт; `null` — менять можно, `undefined` — заявка новая. */
  const retypeBlocker =
    record && otherRequestType
      ? requestTypeChangeBlocker(record, recordKindCode, otherRequestType)
      : undefined;
  // Второй тип должен быть и доступен роли: отдел спецтехнику не заказывает вовсе (ADR 0040).
  const canRetype =
    retypeBlocker === null &&
    !!otherRequestType &&
    canOrderVehicleRequestType(user, otherRequestType);

  /**
   * Ездки правимой заявки (Р1, Р2 плана `docs/route-trips-plan.md`); `null` — правится заказ
   * техники на объект либо заводится новая заявка.
   *
   * Отсюда список ездок узнаёт прежнее состояние каждой своей строки: номер («ТС-40/2», Р13а) и
   * послабления Р2а — непроверенный адрес и пустой контакт правку не блокируют, пока их не меняют.
   * Строка без пары среди сохранённых — новая, и жёсткая модель действует на неё целиком.
   */
  const recordTrips = record?.requestType === 'freight_transport' ? record.trips : null;

  /**
   * Разворачивать ли ездки списком (§4.1). Заявка с одной ездкой выглядит и заполняется ровно как
   * сегодня, поэтому по умолчанию флаг снят; поднимает его либо сама форма при открытии окна, либо
   * кнопка «+ ездка».
   *
   * Состоянием вкладки, а не списка: открытие другой заявки обязано его пересчитать, а вложенный
   * компонент о смене правимой записи не знает.
   */
  const [tripsExpanded, setTripsExpanded] = useState(false);

  const isFreight = watchRequestType === 'freight_transport';
  const commentHint = watchRequestType ? COMMENT_HINTS[watchRequestType] : null;

  /**
   * Нужен ли груз. У легковой машины (форма № 3) его не бывает: она возит людей, и требовать
   * «объём или массу» значило бы заставлять заявителя выдумывать число. Правило то же, которым
   * отвечает сервер, — и спрашивает оно бланк заказанного типа, а не его код.
   */
  const watchClassificationKey = Form.useWatch('classificationKey', form);
  const cargoRequired = isCargoAmountRequired(
    (watchClassificationKey
      ? classificationByKey.get(watchClassificationKey)?.waybillFormCode
      : null) ?? null,
  );

  // Подсказка о длине периода работы техники: пустая дата окончания — однодневный срок
  // (так же его понимает сервер). Та же подсказка стоит в карточке заявки.
  const watchDateFrom = Form.useWatch('dateFrom', form);
  const watchDateTo = Form.useWatch('dateTo', form);
  const periodHint = watchDateFrom
    ? calendarDaysLabel(watchDateFrom.format('YYYY-MM-DD'), watchDateTo?.format('YYYY-MM-DD'))
    : null;

  // Ограничение дат заявки на технику (ADR 0104): ближайший доступный день зависит от того, кто
  // её заводит, и в форме он тот же, что на сервере, — подробности при самом правиле.
  const { minDate, disabledDate: minDateRule, leadTimeHint } = vehicleRequestDateRules(user);

  /*
   * Задним числом (ADR 0101, Р6 и Р15): уходит ли выбранная дата в прошлое и по какой именно
   * границе. Считает контракт (`movedRequestDateKey`) — тот же, которым сервер решает, спрашивать
   * ли право: разойдись они, форма либо требовала бы причину там, где ручка её не ждёт, либо
   * молча отправляла бы правку, на которую придёт 403.
   *
   * У правки эффективная дата — самая ранняя из **сдвинутых** границ, а не просто «дата заявки»:
   * у вчерашней заявки правят и телефон, и комментарий, и это не коррекция.
   */
  const watchScheduledDate = Form.useWatch('scheduledDate', form);
  const formCalendar: RequestCalendar = isSpecial
    ? {
        dateFrom: watchDateFrom?.format('YYYY-MM-DD'),
        dateTo: watchDateTo ? watchDateTo.format('YYYY-MM-DD') : null,
      }
    : { scheduledDay: watchScheduledDate?.format('YYYY-MM-DD') };
  // Переоформление в другой тип (ADR 0091) идёт своей ручкой, и границы дат у неё нет вовсе:
  // заявку, заведённую вчера, переоформляют сегодня, и требовать за это право на коррекцию
  // значило бы менять заказ ради смены его вида. Сравнивать календари разных типов тем более не о
  // чем — у них разные поля.
  const retyping = !!record && record.requestType !== watchRequestType;
  const recordCalendar: RequestCalendar | null =
    !record || retyping
      ? null
      : record.requestType === 'freight_transport'
        ? { scheduledDay: moscowDateKeyOf(new Date(record.scheduledAt)) }
        : { dateFrom: record.dateFrom, dateTo: record.dateTo };
  const effectiveDateKey = recordCalendar
    ? movedRequestDateKey(recordCalendar, formCalendar)
    : (formCalendar.dateFrom ?? formCalendar.scheduledDay ?? null);
  // Прошлое считается по МСК — тем же поясом, что на сервере: у диспетчера восточнее Москвы своё
  // «сегодня», и по нему граница разошлась бы с ответом ручки.
  const backdated =
    !retyping && !!effectiveDateKey && effectiveDateKey < moscowDateKeyOf(new Date());

  // Срок работающей заявки правкой только продлевают: сокращение идёт досрочным завершением с
  // визой (ADR 0044), и сервер прямую правку отклоняет.
  const dateToLocked =
    !!record &&
    record.requestType === 'special_equipment' &&
    !canShortenWorkPeriodByEdit(record.status);
  const currentLastDay =
    record?.requestType === 'special_equipment' ? record.dateTo || record.dateFrom : null;
  const isBeforeCurrentDateTo = (d: Dayjs) =>
    !!currentLastDay && d.format('YYYY-MM-DD') < currentLastDay;

  /**
   * Правятся ли у этой заявки перегоны 4-П (миграция 0082): доставка техники на площадку и вывоз
   * с неё. Условия те же, что проверит сервер, — заказ техники на объект, взятый в работу
   * собственной машиной: перегон едет назначенной единицей, а на арендную лист выписывает
   * арендодатель. У новой заявки блока нет вовсе — машины ещё не выбрали.
   */
  const relocationsEditable =
    !!record &&
    record.requestType === 'special_equipment' &&
    record.status === 'confirmed' &&
    record.assignment?.ownership === 'own' &&
    canChangeStatus;

  // Заказ техники на объект допускает технику любого вида, грузоперевозка — только грузовую.
  // Позиция правимой заявки могла выйти из справочника (её выключили) или не существовать вовсе
  // (заявка старше категорий) — её добавляем отдельной заблокированной строкой, иначе поле
  // выглядит пустым и непонятно, что вообще заказывали.
  const typeGroups = watchRequestType
    ? withSavedClassification(
        groups.filter((g) => isVehicleKindAllowedForRequest(watchRequestType, g.kindCode)),
        record
          ? {
              vehicleTypeId: record.vehicleTypeId,
              vehicleCategoryId: record.vehicleCategoryId,
              typeName: record.vehicleTypeName,
              categoryName: record.vehicleCategoryName,
            }
          : null,
      )
    : [];

  /**
   * Смена типа заявки: поля чужого типа очищаем, своей дате подставляем сегодня — раньше
   * нельзя; выбранную технику сбрасываем, если новому типу заявки её вид не подходит.
   *
   * Что можно — переносим, а не спрашиваем заново (ADR 0091). Однозначны две вещи: день (заказанная
   * подача становится первым днём работ и наоборот) и контакт на месте — техника на объект едет к
   * тому, кто её встретит, а в рейсе этот же человек стоит на разгрузке. Адреса, груз и срок
   * окончания не переносятся: у другого типа их либо нет, либо они означают другое.
   */
  const handleRequestTypeChange = (next: VehicleRequestType) => {
    const key: string | undefined = form.getFieldValue('classificationKey');
    const kindCode = key ? classificationByKey.get(key)?.kindCode : undefined;
    if (kindCode && !isVehicleKindAllowedForRequest(next, kindCode)) {
      form.resetFields(['classificationKey']);
    }
    // Контакт на разгрузке живёт у **первой** ездки (Р2): она же станет одна на весь заказ, если
    // заявку переоформят в технику на объект, — у остальных ездок свои концы и свои люди.
    const trips: TripFormValue[] | undefined = form.getFieldValue('trips');
    if (next === 'special_equipment') {
      // Спецтехника выходит на площадку, и отдела в такой заявке нет вовсе (Р4): стоящее в поле
      // подразделение убирает форма, а не подбор (К8) — иначе поле показывало бы пустоту, а
      // заявка ушла бы с прежним заказчиком.
      if (customer.customerPairOf(form.getFieldValue('customerKey')).departmentId) {
        form.resetFields(['customerKey']);
      }
      const scheduledDate: Dayjs | undefined = form.getFieldValue('scheduledDate');
      const name = trips?.[0]?.toResponsibleName;
      const phone = trips?.[0]?.toResponsiblePhone;
      // Ездки целиком лежат в тех же `FREIGHT_FIELDS` и сбрасываются вместе с подачей: у заказа
      // техники на объект их не бывает вовсе.
      form.resetFields([...FREIGHT_FIELDS]);
      form.setFieldsValue({
        dateFrom: form.getFieldValue('dateFrom') ?? scheduledDate ?? minDate,
        responsibleName: form.getFieldValue('responsibleName') || name,
        responsiblePhone: form.getFieldValue('responsiblePhone') || phone,
      });
    } else {
      const dateFrom: Dayjs | undefined = form.getFieldValue('dateFrom');
      const name: string | undefined = form.getFieldValue('responsibleName');
      const phone: string | undefined = form.getFieldValue('responsiblePhone');
      form.resetFields([...SPECIAL_FIELDS]);
      // Ездок не бывает ноль: у грузоперевозки без ездки не сказано, что везти и куда. Пустой
      // список случается, когда заказ на объект переоформляют в грузоперевозку, — тогда заводится
      // первая строка, и контакт встречающего становится контактом на разгрузке.
      const [first = blankTrip(), ...rest] = trips ?? [];
      form.setFieldsValue({
        scheduledDate: form.getFieldValue('scheduledDate') ?? dateFrom ?? minDate,
        trips: [
          {
            ...first,
            toResponsibleName: first.toResponsibleName || name,
            toResponsiblePhone: first.toResponsiblePhone || phone,
          },
          ...rest,
        ],
      });
    }
  };

  /*
   * Ключ операции задним числом (ADR 0101, Р31) — один на открытое окно, а не на нажатие.
   *
   * Именно так он и работает: связь оборвалась, ответа нет, человек жмёт «Сохранить» ещё раз — и
   * сервер по тому же ключу возвращает прежний результат вместо второй заявки и второго сгоревшего
   * номера. Новый uuid на каждое нажатие сделал бы ключ бесполезным ровно в том случае, ради
   * которого он заведён.
   *
   * Неудачная попытка ключ не жжёт: строка операции пишется той же транзакцией, что и сама правка,
   * и откатывается вместе с ней, — поэтому «поправил причину и сохранил снова» проходит обычным
   * порядком, а не упирается в «ключ занят другой командой».
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  /**
   * Правка срока, ждущая своей двери: заявка, каким срок станет и значения формы, которые
   * досохранятся следом (волна 4a плана `docs/assignment-periods-plan.md`).
   *
   * Состоянием, а не флагом внутри мутации: между «нажал Сохранить» и «подтвердил последствия»
   * стоит окно, и значения формы обязаны пережить его — форма к этому моменту уже отработала свои
   * правила, и спрашивать их заново было бы вторым прогоном тех же полей.
   */
  const [periodSave, setPeriodSave] = useState<{
    request: SpecialEquipmentRequestDto;
    command: VehiclePeriodCommand;
    values: FormValues;
  } | null>(null);

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    setOperationId(crypto.randomUUID());
    // Штаб заводит заявку только на свой объект, сотрудник отдела — только от своего отдела:
    // заказчик подставляется, когда вариант у учётки один, и поле при этом заперто. Ставит его
    // форма, а не поле: заблокированное `AutoSelect` не заполняет намеренно (Р3а, К6).
    if (customer.soleCustomerKey) {
      form.setFieldsValue({ customerKey: customer.soleCustomerKey } as Partial<FormValues>);
    }
    // Отделу доступен один тип заявки — подставляем его, чтобы поле не спрашивало о выборе,
    // которого нет.
    if (requestTypeOptions.length === 1) {
      form.setFieldsValue({ requestType: requestTypeOptions[0]!.value } as Partial<FormValues>);
    }
    // Новая заявка начинается с одной ездки и выглядит ровно как заявка до плана (Р24, §4.1):
    // список разворачивается только по «+ ездка».
    form.setFieldsValue({ trips: [blankTrip()] } as Partial<FormValues>);
    setTripsExpanded(false);
    editor.reset([]);
    setOpen(true);
  };

  const openEdit = (r: VehicleRequestDto) => {
    setRecord(r);
    form.resetFields();
    setOperationId(crypto.randomUUID());
    /*
     * Свёрнутый вид годится не всякой заявке (§4.1): списком открываются те, у кого ездок
     * несколько, и та, у кого ездка одна, но со своим временем подачи или примечанием — их
     * свёрнутый вид не показывает вовсе, и человек правил бы заявку, не видя половины заказа.
     * Тем же правилом решает карточка (`tripNeedsList`), показывать ли ездку парой полей.
     */
    const trips = r.requestType === 'freight_transport' ? r.trips : [];
    setTripsExpanded(trips.length > 1 || trips.some(tripNeedsList));
    if (r.requestType === 'special_equipment') {
      form.setFieldsValue({
        requestType: r.requestType,
        // Заказчик — ключом из самой заявки (Р2): пара колонок под CHECK заполнена ровно
        // наполовину, и род берётся из неё, а не из оси того, кто правит.
        customerKey: costTargetKeyOf(r) ?? undefined,
        classificationKey: classificationKeyOf(r),
        dateFrom: dayjs(r.dateFrom),
        dateTo: r.dateTo ? dayjs(r.dateTo) : null,
        responsibleName: r.responsibleName,
        responsiblePhone: r.responsiblePhone,
        comment: r.comment,
      });
    } else {
      // Момент с сервера переводится в МСК, а не читается как московское время: `dayjs.tz(iso,
      // tz)` теряет пришедшее смещение и показывал бы подачу на три часа раньше — а правка
      // сохраняла бы этот сдвиг обратно в заявку. Так же читает подачу заявка на вывоз мусора.
      const at = dayjs(r.scheduledAt).tz(MOSCOW_TZ);
      /*
       * Адреса, груз и контакты лежат у ездок (Р2 плана `docs/route-trips-plan.md`) — у заявки их
       * больше нет, и форма правит их полным списком (§7).
       *
       * Переносится каждая ездка как есть, включая непроверенный адрес и пустой контакт: у строк,
       * доехавших бэкфилом от заявок старше ADR 0006 и миграции `0062`, их не бывает, и выдумывать
       * за прошлое форма не станет (Р2а). Метаданные едут вместе со строкой — по ним адресное поле
       * само откроется в том режиме, каким адрес и заводили.
       *
       * Пустой список тут теоретически невозможен (ездок не бывает ноль), но окно правки не то
       * место, где это стоит утверждать падением: список просто окажется без строк.
       */
      form.setFieldsValue({
        requestType: r.requestType,
        customerKey: costTargetKeyOf(r) ?? undefined,
        classificationKey: classificationKeyOf(r),
        scheduledDate: at,
        // Время не задано — поле остаётся пустым (в scheduledAt лежит полночь МСК).
        scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
        trips: trips.map(tripToForm),
        comment: r.comment,
      });
    }
    editor.reset(
      r.files.map((f): EditorFile => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        isNew: false,
      })),
    );
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: ({ v, period }: SaveInput) => {
      // Выбрана одна позиция классификатора (ADR 0028) — в API она уходит парой «тип +
      // категория»: категория пуста у типа, у которого её и не бывает.
      const picked = parseVehicleClassificationKey(v.classificationKey)!;
      /*
       * Задним числом (ADR 0101): причина и ключ операции едут только тогда, когда операция
       * действительно уходит в прошлое. Слать их всегда нельзя — сервер завёл бы запись коррекции
       * на обычную дневную работу, и журнал правок бланков наполнился бы заявками на завтра.
       *
       * Срок, уже проведённый своей дверью, календарь этой правки больше не двигает: даты в теле
       * совпадают с теми, что лежат в заявке, и причина здесь означала бы вторую запись журнала
       * коррекций за одну и ту же правку — объяснение человек дал двери срока.
       */
      const backdate =
        backdated && !period ? { backdateReason: v.backdateReason?.trim(), operationId } : {};
      /*
       * Заказчик — парой колонок из выбранной опции (Р2, Р2а): род и идентификатор лежат в ней
       * данными, и разбирать строку на каждом сохранении незачем.
       *
       * Значение, которого поле не предлагает, отдаётся пустой парой (К8) — это защита, а не
       * потеря: так наружу не уходит отдел, оставшийся в форме от переоформления в спецтехнику.
       */
      const pair = customer.customerPairOf(v.customerKey);
      const common = {
        vehicleTypeId: picked.vehicleTypeId,
        vehicleCategoryId: picked.vehicleCategoryId,
        comment: v.comment ?? '',
        ...backdate,
      };
      // Смена типа у заведённой заявки — не правка, а переоформление (ADR 0091): у него своя
      // ручка, потому что деталь прежнего типа снимается целиком, а новая приходит полным составом.
      const retyping = !!record && record.requestType !== v.requestType;
      const edit = record
        ? {
            // Версия — та, что вернула дверь срока, если она отработала перед этим: заявку она
            // изменила, и прежняя версия ответила бы 409 на правку, которую человек уже начал.
            version: period?.version ?? record.version,
            addFileIds: editor.newFileIds(),
            removeFileIds: editor.removedIds,
          }
        : null;

      if (v.requestType === 'special_equipment') {
        // Спецтехнику заказывает только объект: она выходит на площадку, и отдела в такой заявке
        // нет вовсе (ADR 0040) — роль отдела до этой ветки не доходит, ей закрыт сам тип.
        const base = {
          requestType: 'special_equipment' as const,
          objectId: pair.objectId!,
          ...common,
          dateFrom: v.dateFrom!.format('YYYY-MM-DD'),
          dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
          responsibleName: v.responsibleName!,
          responsiblePhone: v.responsiblePhone!,
        };
        if (!record || !edit)
          return vehicleRequestsApi.create({ ...base, fileIds: editor.newFileIds() });
        return retyping
          ? vehicleRequestsApi.changeRequestType(record.id, { ...base, ...edit })
          : vehicleRequestsApi.update(record.id, { ...base, ...edit });
      }

      // Заказчик грузоперевозки — объект либо отдел, ровно один (ADR 0040): присылать обе оси
      // сервер не даст, и половина пары выбирается по роду выбранного, а не по оси того, кто правит.
      const customerBody = pair.departmentId
        ? { departmentId: pair.departmentId }
        : { objectId: pair.objectId! };

      // Время не задано → полночь МСК + признак: заявка «на дату», без конкретного часа.
      const time = normalizeTimeInput(v.scheduledTime ?? '');
      const scheduledAt = dayjs
        .tz(`${v.scheduledDate!.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        requestType: 'freight_transport' as const,
        ...customerBody,
        ...common,
        scheduledAt,
        scheduledTimeUnspecified: time === undefined,
      };

      /*
       * Ездки из списка формы (Р1, Р2): адреса, груз и контакты уехали с заявки на них, и форма
       * отправляет их полным составом.
       *
       * День заявки передаётся сборке отдельно: своё время ездки (Р3) форма спрашивает часами, а
       * момент собирается из них и дня подачи — иначе первая же правка подачи оставила бы ездки во
       * вчерашнем дне, и сервер ответил бы 422 на поле, которого никто не трогал (Р18).
       */
      const requestDay = v.scheduledDate!.format('YYYY-MM-DD');
      const formTrips = v.trips ?? [];

      /*
       * Заведение и переоформление — жёсткая модель целиком (ADR 0006): каждая ездка новая, её
       * адрес приходит парой со своими метаданными и обязан быть верифицирован. У переоформления
       * деталь нового типа заводится с нуля (ADR 0091), и `id` там не бывает по существу — ездок у
       * заказа техники на объект не было вовсе.
       */
      const created = formTrips.map((t) => newTripBody(t, requestDay));
      if (!record || !edit)
        return vehicleRequestsApi.create({ ...base, trips: created, fileIds: editor.newFileIds() });
      if (retyping)
        return vehicleRequestsApi.changeRequestType(record.id, {
          ...base,
          trips: created,
          ...edit,
        });
      /*
       * Правка — полным списком (§7): строка с `id` перезаписывает существующую ездку, строка без
       * него заводит новую, а ездка, которой в списке не оказалось, мягко удаляется (Р13а). Номер
       * при этом не переиспользуется: следующая получит следующий свободный, и «ТС-40/2» из
       * выданного листа навсегда останется той ездкой, что напечатана.
       *
       * Послабления Р2а держит сама сборка (`editTripBody`): метаданные адреса уходят как есть,
       * вплоть до `null`, а верификацию сервер потребует ровно за изменившееся поле.
       */
      return vehicleRequestsApi.update(record.id, {
        ...base,
        trips: formTrips.map((t) => editTripBody(t, requestDay)),
        ...edit,
      });
    },
    onSuccess: (saved) => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      // Изменившийся срок работ сводит ЭСМ-2 заново (`afterWorkPeriodChanged`), как и досрочное
      // завершение: правка заявки переписывает уже выписанные листы.
      void qc.invalidateQueries({ queryKey: ['waybills'] });
      // Правка заявки поднимает версию её рейса (Р18): адреса, контакты, количество и состав ездок
      // попадают в документ, и карточка маршрута обязана перечитаться. Иначе открытый рейс
      // остаётся с прежней версией, и следующее действие из него получает 409 — данные сервер
      // защитит, но экран до обновления недостоверен.
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      setOpen(false);
      warnRouteDateMismatch(saved);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Заявку подвинули по дате, а она лежит в рейсе прежнего дня.
   *
   * Портал такую правку не запрещает: заявку и рейс правят разные люди в разное время, и
   * запрещать значило бы требовать чинить рейс до того, как узнал о расхождении. Но и молчать
   * нельзя — рейс останется на прежнем дне, а лист напечатает задание, которого в этот день уже
   * нет. Поэтому окно называет расхождение и ведёт туда, где оно чинится: в карточку маршрута,
   * где день рейса переносится вместе с заявками.
   */
  const warnRouteDateMismatch = (saved: VehicleRequestDto) => {
    if (saved.requestType !== 'freight_transport' || !saved.route) return;
    // Рейс — в локальную константу: дальше он спрашивается из замыкания кнопки, где сужение по
    // `saved.route` уже не действует.
    const route = saved.route;
    const routeLink = vehicleRouteLink(can, route.id);
    const mismatch = routeDateMismatch(
      { tripDate: moscowDateKeyOf(new Date(saved.scheduledAt)) },
      { displayNumber: route.displayNumber, routeDate: route.routeDate },
    );
    if (!mismatch) return;
    modal.warning({
      title: 'Дата заявки разошлась с днём маршрута',
      content: mismatch,
      okText: 'Понятно',
      // Кнопка перехода — там же, где объяснение: иначе человек закроет окно и пойдёт искать
      // маршрут руками, а половина расхождений так и останется незамеченной. Рейс открывается
      // окном поверх списка (ADR 0120): расхождение находят сразу после правки заявки, и увести
      // человека со списка значило бы отобрать у него ту самую заявку, которую он только что
      // правил, — вместе с фильтрами и страницей, на которой она нашлась.
      ...(routeLink
        ? {
            cancelText: `Открыть маршрут ${route.displayNumber}`,
            okCancel: true,
            onCancel: () => openRoute(route.id),
          }
        : {}),
    });
  };

  /**
   * Идёт ли эта правка срока через свою дверь — и каким срок станет (Ж4, З5, И5).
   *
   * `null` — двери здесь нет, и срок уходит прежним, широким маршрутом. Так бывает в четырёх
   * случаях, и каждый из них не «пока не сделали», а свойство самой правки:
   *
   * - **срок не менялся**: дверь пустую команду и не примет — она подняла бы версию заявки и
   *   оставила бы в журнале строку без предмета;
   * - **не заказ техники на объект**: у грузоперевозки срока работ нет вовсе;
   * - **заявка «Новая»**: ни техники, ни бумаги, ни истории — предпросмотру нечего показать, а
   *   гасить нечего. До cutover её срок ведёт широкий маршрут, и это законный путь (И5);
   * - **нет права читать бумагу**: последствия показывает предпросмотр, а он живёт на
   *   `waybills.read`; роль без него упёрлась бы в 403 посреди сохранения.
   */
  const periodDoorCommand = (v: FormValues): VehiclePeriodCommand | null => {
    if (!record || record.requestType !== 'special_equipment') return null;
    if (v.requestType !== 'special_equipment') return null;
    if (record.status === 'new' || !can('waybills.read')) return null;
    const dateFrom = v.dateFrom!.format('YYYY-MM-DD');
    const dateTo = v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null;
    if (dateFrom === record.dateFrom && dateTo === record.dateTo) return null;
    return { dateFrom, dateTo };
  };

  /**
   * Переоформление спрашиваем, обычное сохранение — нет. Заявка при смене типа не просто меняет
   * значения: поля прежнего типа исчезают вместе с деталью, и виза, если её ставил не тот, кто
   * правит, уходит следом. Перечень — по самой заявке (`retypeErases`), а не общими словами:
   * человек должен увидеть, что именно перестанет существовать, до нажатия, а не в истории после.
   */
  const submit = (v: FormValues) => {
    if (!record || record.requestType === v.requestType) {
      /*
       * Правка срока — своя дверь (план `docs/assignment-periods-plan.md`, волна 4a; Ж4, З5, Д2).
       * Сохранение при этом распадается на две команды: у срока свои последствия и свои
       * рукопожатия, и «продлить и заодно поправить комментарий» одним телом не бывает. Сначала
       * срок — он показывает цену и берёт подтверждения, — потом остальное с версией, которую он
       * вернул.
       */
      const command = periodDoorCommand(v);
      if (command && record?.requestType === 'special_equipment') {
        setPeriodSave({ request: record, command, values: v });
        return;
      }
      saveMut.mutate({ v });
      return;
    }
    // Право визы у себя же заявку не отбирает (ADR 0025): визирующий подтверждает переоформление
    // самим фактом правки — тем же правилом отвечает сервер.
    const erased = retypeErases(record, !!record.approvedAt && !canApprove);
    modal.confirm({
      title: `Переоформить заявку ${record.displayNumber} в «${vehicleRequestTypeLabels[v.requestType]}»?`,
      content: (
        <>
          <div>У заявки не станет:</div>
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
            {erased.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Typography.Text type="secondary">
            Номер, вложения и история остаются за заявкой.
          </Typography.Text>
        </>
      ),
      okText: 'Переоформить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => saveMut.mutateAsync({ v }),
    });
  };

  /** Доваливаем правила, которые зависят от типа заявки и не выражаются rules-ами полей. */
  const onFinish = (v: FormValues) => {
    if (v.requestType === 'special_equipment') {
      submit(v);
      return;
    }
    /*
     * Количество спрашивается у **каждой** ездки, а не у заявки: везут они разное, и «6 ездок, у
     * одной не указан объём» — законное состояние формы, которое сервер отклонит с указанием
     * строки (`assertCargoAmount`). Отказ называет строку теми же словами, что и карточка списка:
     * номера у новой ездки ещё нет, обещать его нельзя (Р13а).
     */
    const emptyCargo = cargoRequired
      ? (v.trips ?? []).findIndex((t) => t.volumeM3 == null && t.weightTons == null)
      : -1;
    if (emptyCargo >= 0) {
      const trips = v.trips ?? [];
      message.error(
        trips.length > 1
          ? `Строка ${emptyCargo + 1}: ${CARGO_AMOUNT_MESSAGE}`
          : CARGO_AMOUNT_MESSAGE,
      );
      return;
    }
    // Жёсткая модель адресов (ADR 0006) сюда не доходит: её проверяет правило самого поля, и
    // невыбранный адрес останавливает отправку с ошибкой на своём поле, а не общим сообщением.
    submit(v);
  };

  // Отмена заявки требует причины — она вводится в отдельном окне.
  const [cancelTarget, setCancelTarget] = useState<VehicleRequestDto | null>(null);
  /**
   * Заявка, которую возвращают из работы в «Новую» (`transitionResetsWork`). Отдельно от отмены:
   * окно причины у них общее, но перечень стираемого — свой, и по нему видно, что именно потеряет
   * эта заявка. Смешай их в одном состоянии — окно не знало бы, что показывать.
   */
  const [rollbackTarget, setRollbackTarget] = useState<VehicleRequestDto | null>(null);
  /**
   * Перегоны заявки, которую возвращают в «Новую» (миграция 0082): они едут ради этой заявки и на
   * назначенной ей машине, поэтому возврат стирает их вместе с назначением. Спрашиваются, только
   * пока открыто окно, и только у заказа техники на объект — у грузоперевозки перегонов не бывает,
   * а лишний запрос на каждую строку списка ради окна, которое откроют раз в месяц, ни к чему.
   * Ключ тот же, что у карточки заявки: открытая перед этим карточка отдаёт ответ из кэша.
   */
  const { data: rollbackRelocations } = useQuery({
    queryKey: ['vehicle-requests', rollbackTarget?.id, 'relocations'],
    queryFn: () => vehicleRequestsApi.relocations(rollbackTarget!.id),
    enabled: !!rollbackTarget && rollbackTarget.requestType === 'special_equipment',
  });
  // Перевод в работу — выбор техники и ставок (ADR 0027): назначение уходит вместе со статусом.
  const [assignTarget, setAssignTarget] = useState<VehicleRequestDto | null>(null);
  // Выполнение — отработанное время и стоимость (ADR 0029): факт тоже уходит со статусом.
  const [completeTarget, setCompleteTarget] = useState<VehicleRequestDto | null>(null);
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
  /** Заявка, которую переносят в другой рейс (ADR 0052); null — окно переноса закрыто. */
  /** Заведение перегона: заявка и что именно заводим — доставку или вывоз. */
  const [relocation, setRelocation] = useState<{
    request: VehicleRequestDto;
    purpose: 'delivery' | 'pickup';
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<VehicleRequestDto | null>(null);
  /** Заявка, по которой выписывают недельный ЭСМ-2 (ADR 0100); null — окно закрыто. */
  const [esm2Target, setEsm2Target] = useState<VehicleRequestDto | null>(null);

  const reassignMut = useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      assignment: AssignVehicleBody;
      /** Смена машины задним числом (ADR 0101, Р8): причина, ключ операции и листы к перевыписке. */
      correction?: CorrectAssignmentBody;
      /**
       * Отпечаток последствий, показанных вторым шагом окна (волна 4a плана
       * `docs/assignment-periods-plan.md`): им сервер сверяет под блокировками, что обещанное
       * человеку ещё верно. Не приходит там, где предпросмотра не было вовсе, — у грузоперевозки и
       * у сервера старее портала.
       */
      previewFingerprint?: string;
    }) =>
      vehicleRequestsApi.changeAssignment(v.id, {
        ...v.assignment,
        version: v.version,
        ...(v.correction ? { correction: v.correction } : {}),
        ...(v.previewFingerprint ? { previewFingerprint: v.previewFingerprint } : {}),
      }),
    onSuccess: (_updated, v) => {
      message.success(v.correction ? 'Назначение исправлено задним числом' : 'Техника изменена');
      setReassignTarget(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      // Заявка переезжает в рейс новой машины — списки маршрутов после этого не те же.
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      // Смена машины переписывает и путевые листы: сервер сводит ЭСМ-2 рейса заново (ADR 0037).
      void qc.invalidateQueries({ queryKey: ['waybills'] });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    /*
     * «Последствия изменились» — не ошибка, а вопрос, и отвечает на него окно: оно спрашивает план
     * заново и показывает пересчитанный перечень с объяснением, почему вернулось. Тост здесь был бы
     * вторым голосом о том же — и увёл бы глаз от экрана, на который человеку и надо смотреть.
     */
    onError: (e) => {
      if (reassignStaleReason(e)) return;
      message.error(errorMessage(e));
    },
  });

  const statusMut = useMutation({
    mutationFn: (v: {
      id: string;
      status: RequestStatus;
      version: number;
      comment?: string;
      assignment?: AssignVehicleBody;
      /** Фактический срок, уточнённый при переводе в работу: заказывали на одно время, вышли на другое. */
      schedule?: ConfirmScheduleBody;
      completion?: CompleteVehicleRequestInput;
      /**
       * Отпечаток последствий, показанных вторым шагом окна назначения (§5.4 плана). Приходит
       * только с отката «Выполнена» → «В работе»: на нём портал обещал точный результат сверки
       * ЭСМ-2, и сервер сверяет, что обещанное ещё верно.
       */
      previewFingerprint?: string;
    }) =>
      vehicleRequestsApi.changeStatus(v.id, v.status, v.version, {
        comment: v.comment,
        assignment: v.assignment,
        schedule: v.schedule,
        completion: v.completion,
        previewFingerprint: v.previewFingerprint,
      }),
    onSuccess: () => {
      message.success('Статус изменён');
      setCancelTarget(null);
      setRollbackTarget(null);
      setAssignTarget(null);
      setCompleteTarget(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      // Возврат в «Новую» снимает машину, а с ней уходят из рейсов и сама заявка, и её перегоны:
      // списки маршрутов после такого перехода уже не те. Инвалидация общая на все переходы —
      // рейсов касается и закрытие заявки, и её отмена.
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      // Перевод в работу выписывает путевой лист, а закрытие и отмена его переписывают (ADR 0037):
      // журнал листов после смены статуса показывает не то, что в базе.
      void qc.invalidateQueries({ queryKey: ['waybills'] });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const requestStatusChange = (r: VehicleRequestDto, status: RequestStatus) => {
    // Возврат из работы в «Новую» стирает всё, что заявка нажила в работе (`transitionResetsWork`),
    // и спрашивает причину тем же окном, что отмена, — но со своим перечнем стираемого: человек
    // должен увидеть, чего лишится эта заявка, до нажатия, а не после.
    if (transitionResetsWork(r.status, status)) {
      setRollbackTarget(r);
      return;
    }
    if (statusChangeRequiresReason(status, r.status)) {
      setCancelTarget(r);
      return;
    }
    // «В работе» без машины не бывает: заявку берут конкретной единицей и по конкретной ставке.
    if (transitionRequiresAssignment(status)) {
      setAssignTarget(r);
      return;
    }
    // Закрытие спрашивает факт — но только там, где есть чем считать: у заявки, взятой в работу
    // до ADR 0027, машины и ставки нет, и просить отработанное время не у чего. Так же решает
    // и сервер: факт обязателен при назначенной технике.
    if (transitionRequiresCompletion(status) && r.assignment) {
      setCompleteTarget(r);
      return;
    }
    statusMut.mutate({ id: r.id, status, version: r.version });
  };

  const approvalMut = useMutation({
    mutationFn: (v: { id: string; approved: boolean; version: number }) =>
      vehicleRequestsApi.setApproval(v.id, v.approved, v.version),
    onSuccess: (_res, v) => {
      message.success(v.approved ? 'Заявка завизирована' : 'Виза снята');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Снятие визы спрашиваем: заявка после этого перестаёт годиться в работу. */
  const requestApprovalChange = (r: VehicleRequestDto, approved: boolean) => {
    if (approved) {
      approvalMut.mutate({ id: r.id, approved, version: r.version });
      return;
    }
    modal.confirm({
      title: `Снять визу с заявки ${r.displayNumber}?`,
      content: 'Пока визы нет, заявку нельзя взять в работу.',
      okText: 'Снять визу',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => approvalMut.mutateAsync({ id: r.id, approved: false, version: r.version }),
    });
  };

  // Досрочное завершение (ADR 0044): запрос сокращения срока, решение по нему и отзыв. Действия
  // общие со срезом «На объекте» — там их и вызывают чаще, — поэтому живут одним хуком.
  const earlyEnd = useEarlyEnd();
  /** «Сегодня» по Москве: тем же днём применимость считает сервер (`earlyEndBlocker`). */
  const today = minRequestDateKey();
  /** Предикаты-сужения: досрочно завершают только заказ спецтехники, и окно ждёт именно его. */
  const earlyEndAllowed = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canEdit &&
    r.requestType === 'special_equipment' &&
    canRequestEarlyEnd(r, today) &&
    r.earlyEnd?.status !== 'pending';
  const decidableEarlyEnd = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canApprove && r.requestType === 'special_equipment' && r.earlyEnd?.status === 'pending';

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

  /** Кнопка смены техники — одна на обе ветки «Действий»: у арендодателя своя короткая. */
  const reassignButton = (r: VehicleRequestDto) => (
    <Tooltip title="Сменить технику">
      <Button
        size="small"
        icon={<SwapOutlined />}
        aria-label="Сменить технику"
        onClick={() => setReassignTarget(r)}
      />
    </Tooltip>
  );

  const removeMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.remove(id),
    onSuccess: (res) => {
      message.success(res.mode === 'hard' ? 'Удалено' : 'Перемещено в архив');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const canModify = (r: VehicleRequestDto) =>
    !r.deletedAt && (canEdit || canDelete) && (!isObjectRole || r.status === 'new');

  const confirmDelete = (r: VehicleRequestDto) =>
    modal.confirm({
      title:
        r.status === 'new'
          ? `Удалить заявку ${r.displayNumber} безвозвратно?`
          : `Переместить заявку ${r.displayNumber} в архив?`,
      okText: r.status === 'new' ? 'Удалить' : 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  /** Открыть неделю: у недельной строки это единственное действие и оно же клик по строке. */
  const openWeekly = (weekly: WeeklyVehicleRequestDto) =>
    void navigate(weeklyRequestPath(weekly.id));

  // Единая таблица трёх видов документа: два типа заявки ТС и недельная заявка (ADR 0085).
  // Колонки чужого типа остаются пустыми, а у недельной строки каждая колонка отвечает своей
  // веткой — рендеры вынесены в `weeklyFeedRow`, иначе ветвление размазалось бы по всему файлу.
  // Ключ колонки — он же поле сортировки на сервере (VEHICLE_REQUEST_SORT_FIELDS).
  //
  // Объём/массы и адресов погрузки-разгрузки в строке нет: они есть только у грузоперевозки, а
  // список читают по номеру, объекту и сроку. Всё это — в карточке заявки. Автор и тип заявки
  // тоже своих колонок не занимают: они уточняют номер и тип ТС и стоят вторыми строками к ним.
  const columns: TableColumnType<FeedRow>[] = [
    {
      key: 'num',
      title: '№',
      width: 190,
      sorter: true,
      // Вид документа читается по самому номеру — «НЗ-12» против «ТС-341», — и отдельного тега
      // вида в строке нет: он повторял бы то, что и так написано первым, что видит глаз.
      render: (_v, row) => {
        const r = row.kind === 'order' ? row.order : row.weekly;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{r.displayNumber}</div>
            <Space size={6}>
              <UserAvatar name={r.createdByName} size={18} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.createdByName}
              </Typography.Text>
            </Space>
          </div>
        );
      },
    },
    // Ширина задана всем колонкам: при scroll.x='max-content' колонка без ширины тянется по
    // содержимому, и один длинный комментарий возвращал бы горизонтальный скролл всей таблице.
    // Заказчик заявки: объект или отдел (ADR 0040). Одна колонка на обе оси — у заявки заказчик
    // один, и вторая стояла бы пустой в каждой строке. Сортировка осталась по `objectName`:
    // ключ колонки — он же поле сортировки на сервере.
    textColumn<FeedRow>({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_v, row) => {
        // У недельной заявки заказчик всегда площадка — второй оси у документа нет вовсе: неделю
        // собирают из техники, стоящей на объекте, а отдел спецтехнику не заказывает.
        if (row.kind === 'weekly') {
          return <ObjectCell name={row.weekly.objectName} address={row.weekly.objectCode} />;
        }
        const customer = requestCustomerLabel(row.order);
        return (
          <ObjectCell name={customer.text} hint={customer.hint} address={row.order.objectAddress} />
        );
      },
    }),
    {
      key: 'vehicleTypeName',
      title: 'Тип/категория',
      width: 200,
      sorter: true,
      // У недельной строки колонка пуста намеренно: позиции классификатора у документа нет —
      // единиц в нём много и они разные, — и заполнить её нечем. Прочерк честнее, чем перечень
      // типов состава: он читался бы как «заказано вот это», а заказано оно построчно.
      render: (_v, row) => {
        if (row.kind === 'weekly') return dash;
        const r = row.order;
        return (
          <div style={{ lineHeight: 1.35 }}>
            {/* Заказанная позиция классификатора (ADR 0028): категория, а без неё — сам тип.
                Наименование категории уже начинается с типа, повторять его незачем. */}
            <div>
              {vehicleClassificationLabel({
                typeName: r.vehicleTypeName,
                categoryName: r.vehicleCategoryName,
              })}
            </div>
            {/* Подписи типов развёрнутые («Техника для работы на объекте») — тег переносится
                на вторую строку, иначе колонка растянулась бы на них одну строку в пол-экрана. */}
            <Tag
              color={vehicleRequestTypeColors[r.requestType]}
              style={{
                whiteSpace: 'normal',
                lineHeight: 1.25,
                maxWidth: '100%',
                wordBreak: 'break-word',
                marginTop: 2,
              }}
            >
              {vehicleRequestTypeLabels[r.requestType]}
            </Tag>
            {/* Заявку застигло переключение признака у типа (миграция 0137): тип уже ведёт заказы
                иначе, а она дорабатывает как заведена. Без метки диспетчер видит две заявки
                одного типа, ведущие себя по-разному, и ни одного объяснения на экране.
                Развёрнуто то же сказано в карточке — здесь только режим и с какого числа. */}
            {r.requestType === 'special_equipment' && r.linearFrozen ? (
              <Tooltip
                title={`Тип «${r.vehicleTypeName}» переключили после того, как заявку взяли в работу: до закрытия она ведётся так, как заведена`}
              >
                <Tag color="gold" style={{ marginInlineEnd: 0, marginTop: 2 }}>
                  прежний режим: {r.linearFrozen.isLinear ? 'по дням' : 'по неделям'}, с{' '}
                  {formatDate(r.linearFrozen.at)}
                </Tag>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'term',
      title: 'Срок',
      width: 170,
      // Срок у типов заявки лежит в разных полях — сортировку сводит сервер. Неделя встаёт в тот
      // же порядок своим понедельником: документ занимает неделю целиком, и «срок» у него — она.
      sorter: true,
      // Досрочное завершение (ADR 0044) читается тут же: запрошенное — тегом «ждёт визы»,
      // состоявшееся — припиской, с какого числа срок сократили. Иначе заказ на две недели,
      // кончающийся послезавтра, выглядит опечаткой.
      render: (_v, row) => {
        // Подпись недели приходит с сервера готовой (`weekLabel`, «17–23 августа 2026»): второго
        // понятия недели в портале быть не должно — сложи её здесь заново, и список обещал бы не
        // те дни, которые применит виза.
        if (row.kind === 'weekly') return row.weekly.weekLabel;
        const r = row.order;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{termLabel(r)}</div>
            {r.requestType === 'special_equipment' && <EarlyEndTag earlyEnd={r.earlyEnd} />}
          </div>
        );
      },
    },
    {
      // Назначенная техника (ADR 0027): у «Новой» заявки пусто, дальше — чем её взяли и почём.
      // Ставка второй строкой: без неё в списке видно «кто поехал», но не «во сколько встало».
      // Арендодатель — запасной вариант: у назначения без ставок иначе стояла бы пустая строка.
      //
      // Ячейка сворачиваемая (`RequestAssignmentCell`): у заказа тут ровно две строки и внешне не
      // меняется ничего, но эту же колонку заполняет состав недельной заявки — строка на каждую
      // единицу техники, — и без ограничения высоты одна такая строка растянула бы весь список.
      key: 'assignment',
      title: 'Техника',
      width: 200,
      render: (_v, row) =>
        row.kind === 'weekly' ? (
          <WeeklyCompositionCell weekly={row.weekly} />
        ) : (
          <RequestAssignmentCell
            assignment={row.order.assignment}
            detail={(a) => assignmentRateLabel(a) || a.lessorName || '—'}
          />
        ),
    },
    {
      /*
       * Рейс, в котором заявка едет. Пустая ячейка сама по себе ничего не значит — рейса нет ни у
       * «Новой», ни у аренды, ни у заказа техники на объект, — но грузоперевозка в работе на
       * собственной машине без рейса это потерянная заявка: лист по ней не выпишется, и в дне
       * машины её никто не увидит. Такую помечаем предупреждением.
       */
      key: 'route',
      title: 'Маршрут',
      width: 150,
      render: (_v, row) => {
        // Недельная заявка сама никуда не едет: рейсы заводятся по заказам, которые она продлила
        // или породила, и каждый виден в своей строке ленты.
        if (row.kind === 'weekly') return dash;
        const r = row.order;
        const route = r.route;
        if (route) {
          return (
            <div style={{ lineHeight: 1.35 }}>
              {/* Номер рейса открывает его карточку окном поверх списка (ADR 0120): «где эта
                  заявка едет» спрашивают, стоя в этой самой строке, и ответ не должен стоить
                  ухода с экрана вместе с фильтрами и страницей. Ссылка при этом настоящая —
                  Ctrl-кликом её по-прежнему открывают соседней вкладкой браузера. */}
              <div>
                <EntityLink
                  to={vehicleRouteLink(can, route.id)}
                  title="Открыть маршрут"
                  onActivate={() => openRoute(route.id)}
                >
                  {route.displayNumber}
                </EntityLink>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                строка {route.position}
                {route.hasWaybill ? ' · лист выписан' : ''}
              </Typography.Text>
            </div>
          );
        }
        const lost =
          r.status === 'confirmed' &&
          r.requestType === 'freight_transport' &&
          r.assignment?.ownership === 'own';
        return lost ? (
          <Tag color="orange">Без маршрута</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
    {
      key: 'status',
      title: 'Статус',
      width: 150,
      sorter: true,
      // Статусы у документов разные и общего перечня у них нет: у заказа их пять с переходами
      // (ADR 0021), у недели — четыре своих (ADR 0085). Поэтому и ячейки разные: у недельной
      // строки это просто тег — переходы недели решают на её странице, вместе с составом.
      render: (_v, row) => {
        if (row.kind === 'weekly') return <WeeklyStatusTag status={row.weekly.status} />;
        const r = row.order;
        return (
          <StatusCell
            status={r.status}
            deleted={!!r.deletedAt}
            approved={!!r.approvedAt}
            cancelReason={r.cancelReason}
            pending={statusMut.isPending && statusMut.variables?.id === r.id}
            onChange={(status) => requestStatusChange(r, status)}
          />
        );
      },
    },
    {
      // Виза руководителя строительства (ADR 0025): без неё диспетчер не берёт заявку в работу.
      // У недельной заявки виза та же по смыслу и стоит в той же колонке — но ставится только на
      // её странице: она той же транзакцией двигает сроки заказов (ADR 0085 Р6).
      key: 'approval',
      title: 'Согласование',
      width: 160,
      sorter: true,
      render: (_v, row) => {
        if (row.kind === 'weekly') return <WeeklyApprovalCell weekly={row.weekly} />;
        const r = row.order;
        return (
          <ApprovalCell
            status={r.status}
            deleted={!!r.deletedAt}
            approved={!!r.approvedAt}
            approvedByName={r.approvedByName}
            approvedAt={r.approvedAt}
            canApprove={canApprove}
            pending={approvalMut.isPending && approvalMut.variables?.id === r.id}
            onChange={(approved) => requestApprovalChange(r, approved)}
          />
        );
      },
    },
    {
      /*
       * Контакты по местам работы (`requestContacts`): у заказа техники на объект — встречающий на
       * площадке, у грузоперевозки — по ответственному на каждом конце маршрута. Стоят сразу за
       * согласованием: завизировав заявку, её отдают в работу, а работа начинается со звонка тому,
       * кто откроет ворота, — до сих пор за номером открывали карточку каждой заявки.
       *
       * Ячейка сворачивается: два контакта с адресами — это пять-шесть строк текста, и пущенные в
       * высоту они растянули бы каждую строку списка под самую многословную заявку.
       */
      key: 'contacts',
      title: 'Контактные данные',
      width: 260,
      render: (_v, row) =>
        row.kind === 'weekly' ? (
          <WeeklyContactsCell weekly={row.weekly} />
        ) : (
          <RequestContactsCell request={row.order} />
        ),
    },
    textColumn<FeedRow>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 260,
      // Не `ellipsis`: тот держит комментарий в одну строку и обрезает её там, где у заявки как
      // раз и начинается суть заказа. Здесь текст переносится по ширине колонки, а свёрнутая
      // ячейка показывает две строки — столько же, сколько занимают соседние колонки.
      render: (_v, row) => {
        if (row.kind === 'weekly') return <WeeklyCommentCell weekly={row.weekly} />;
        const text = row.order.comment;
        return text.trim() ? (
          <ExpandableCell>
            {/* Абзацы автора сохраняются: комментарий заводят многострочным полем. */}
            <span style={{ whiteSpace: 'pre-line' }}>{text}</span>
          </ExpandableCell>
        ) : (
          dash
        );
      },
    }),
    {
      key: 'files',
      title: 'Файлы',
      width: 110,
      // Файлов у недельной заявки не бывает: вложения носит заказ — счёт, схема заезда, письмо, —
      // а неделя это решение по срокам, к которому прикладывать нечего.
      render: (_v, row) => (row.kind === 'weekly' ? dash : <FilesCell files={row.order.files} />),
    },
    actionsColumn<FeedRow>((row) => {
      // Действие недельной строки ровно одно: открыть неделю. Состав правят, визируют и снимают
      // на самой странице — там же, где видно, что именно согласуют.
      if (row.kind === 'weekly') {
        return (
          <RowActionButton
            title="Открыть неделю"
            icon={<EyeOutlined />}
            onClick={() => openWeekly(row.weekly)}
          />
        );
      }
      const r = row.order;
      // Карточка открывается и у архивной заявки: понять, что и почему в ней было, можно
      // только там — в строке таблицы ни истории, ни адресов целиком нет.
      const view = (
        <Tooltip title="Открыть карточку">
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label="Открыть карточку"
            onClick={() => setViewRecord(r)}
          />
        </Tooltip>
      );
      if (r.deletedAt) {
        return (
          <Space size={4}>
            {view}
            {canRestore ? (
              <Tooltip title="Восстановить">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => restoreMut.mutate(r.id)}
                />
              </Tooltip>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>в архиве</Tag>
            )}
          </Space>
        );
      }
      // Роль без права вести заявки (наблюдатель) кнопок не видит: «выключено» читается как
      // «сейчас нельзя», а нельзя ей всегда. Смена техники живёт на своём праве (ADR 0048) и
      // спрашивается отдельно: у арендодателя правки заявки нет, а машину он подменяет свою.
      if (!canEdit && !canDelete) {
        return reassignAllowed(r) ? (
          <Space size={4}>
            {view}
            {reassignButton(r)}
          </Space>
        ) : (
          view
        );
      }
      const allowed = canModify(r);
      return (
        <Space size={4}>
          {view}
          {reassignAllowed(r) && reassignButton(r)}
          {/* Досрочное завершение (ADR 0044): у ожидающего визы запроса кнопка ведёт в карточку —
            решают, прочитав причину, а она там. Пока запроса нет — просят сокращение отсюда. */}
          {decidableEarlyEnd(r) ? (
            <Tooltip title="Ждёт визы на досрочное завершение">
              <Button
                size="small"
                icon={<FieldTimeOutlined />}
                onClick={() => setViewRecord(r)}
                aria-label="Досрочное завершение ждёт визы"
              />
            </Tooltip>
          ) : (
            earlyEndAllowed(r) && (
              <Tooltip title="Завершить досрочно">
                <Button
                  size="small"
                  icon={<FieldTimeOutlined />}
                  onClick={() => earlyEnd.open(r)}
                  aria-label="Завершить досрочно"
                />
              </Tooltip>
            )
          )}
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!allowed}
            onClick={() => openEdit(r)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!allowed}
            onClick={() => confirmDelete(r)}
          />
        </Space>
      );
    }, 150),
  ];

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

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={documentTypeOptions}
        value={documentTypeValue}
        onChange={applyDocumentType}
      />
      {/* Неделя — фильтр одного вида документа, и показывается он только при выбранном виде: у
          заказа недели нет вовсе, и заданный фильтр отсекал бы заказы целиком. */}
      {params.kind === 'weekly' && (
        <Select
          allowClear
          placeholder="Все недели"
          style={{ width: 210 }}
          options={weekOptions}
          value={params.weekStart}
          onChange={(v: string | undefined) => applyFilter({ weekStart: v })}
        />
      )}
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 150 }}
        options={REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }))}
        value={params.status as RequestStatus | undefined}
        onChange={(v: RequestStatus | undefined) => applyFilter({ status: v })}
      />
      <Select
        allowClear
        placeholder="Любое согласование"
        style={{ width: 190 }}
        options={[
          { value: 'false', label: 'Ждут визы' },
          { value: 'true', label: 'Завизированные' },
        ]}
        value={params.approved}
        onChange={(v: string | undefined) => applyFilter({ approved: v })}
      />
      {/* Заказчик — тот же подбор, что в форме (Р9): площадки и подразделения одним полем. Двух
          фильтров рядом не бывает — у заявки заказчик один, и второй всегда давал бы пусто. */}
      {customerFilter.controls}
      {/* Заказанная техника: тип целиком либо одна его категория (ADR 0028). */}
      {classificationFilter.controls}
      {/* Назначенная машина (ADR 0098): заявки, которые закрыли этой единицей парка. */}
      {vehicleFilter.controls}
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123, НЗ-12)"
        style={{ width: 210 }}
        onSearch={applyNumberSearch}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: documentTypeValue,
      options: documentTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: applyDocumentType,
    },
    // Неделя — только при выбранном виде документа, как и в панели над таблицей: у заказа недели
    // нет, и заданный фильтр отсекал бы заказы целиком.
    ...(params.kind === 'weekly'
      ? [
          {
            kind: 'select',
            key: 'weekStart',
            label: 'Неделя',
            value: params.weekStart,
            options: weekOptions,
            placeholder: 'Все недели',
            onChange: (v: string | undefined) => applyFilter({ weekStart: v }),
          } as const,
        ]
      : []),
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] })),
      placeholder: 'Все статусы',
      onChange: (v) => applyFilter({ status: v }),
    },
    {
      kind: 'select',
      key: 'approved',
      label: 'Согласование',
      value: params.approved,
      options: [
        { value: 'false', label: 'Ждут визы' },
        { value: 'true', label: 'Завизированные' },
      ],
      placeholder: 'Любое согласование',
      onChange: (v) => applyFilter({ approved: v }),
    },
    // Тот же подбор заказчика, что в панели над таблицей (Р9): площадки и подразделения одним
    // полем, и выбор так же чистит вторую половину пары.
    customerFilter.mobileFilter,
    classificationFilter.mobileFilter,
    vehicleFilter.mobileFilter,
    {
      kind: 'text',
      key: 'num',
      label: '№ документа',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, ТС-123 или НЗ-12',
      onChange: (v) => applyNumberSearch(v ?? ''),
    },
  ];

  /**
   * Строки карточки заказа на телефоне (ADR 0030): что заказано и на когда, чем взяли и во сколько
   * встало. Виза — кнопкой прямо в карточке: у руководителя строительства это главное действие
   * списка, и прятать его в меню значило бы добавить к нему два касания.
   */
  const orderCardLines: ((r: VehicleRequestDto) => ReactNode)[] = [
    (r) =>
      `${vehicleClassificationLabel({
        typeName: r.vehicleTypeName,
        categoryName: r.vehicleCategoryName,
      })} · ${vehicleRequestTypeLabels[r.requestType]}`,
    (r) => `Срок: ${termLabel(r)}`,
    (r) =>
      r.assignment
        ? `${assignmentTitle(r.assignment)} · ${assignmentRateLabel(r.assignment) || r.assignment.lessorName || 'без ставки'}`
        : null,
    // Рейс и та же потерянная заявка, что помечена в таблице колонкой «Маршрут». Номер здесь
    // ссылка, а не текст: карточка отдаёт касание себе только там, где под пальцем не оказалось
    // ссылки (`opensRow`), и одно движение больше не значит двух разных вещей. Тот же рейс
    // продублирован пунктом шита действий — пальцем по пункту попадают вернее, чем по номеру
    // внутри строки, а ссылка остаётся ради Ctrl-клика и соседней вкладки браузера.
    (r) => {
      const route = r.route;
      if (route)
        return (
          <>
            Маршрут{' '}
            <EntityLink
              to={vehicleRouteLink(can, route.id)}
              title="Открыть маршрут"
              onActivate={() => openRoute(route.id)}
            >
              {route.displayNumber}
            </EntityLink>{' '}
            · строка {route.position}
          </>
        );
      return r.status === 'confirmed' &&
        r.requestType === 'freight_transport' &&
        r.assignment?.ownership === 'own' ? (
        <Tag color="orange">Без маршрута</Tag>
      ) : null;
    },
    (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
    (r) => r.comment || null,
    (r) => (
      <ApprovalCell
        status={r.status}
        deleted={!!r.deletedAt}
        approved={!!r.approvedAt}
        approvedByName={r.approvedByName}
        approvedAt={r.approvedAt}
        canApprove={canApprove}
        pending={approvalMut.isPending && approvalMut.variables?.id === r.id}
        onChange={(approved) => requestApprovalChange(r, approved)}
      />
    ),
    (r) => (r.files.length > 0 ? <FilesCell files={r.files} /> : null),
    (r) => (r.deletedAt ? <Tag>в архиве</Tag> : null),
  ];

  /**
   * Строки карточки недельной заявки — те же, что были у её собственного списка: площадка, итог
   * состава словами, ожидание визы, причина снятия и автор. Состав здесь считается, а не
   * перечисляется: на телефоне десять единиц техники — это экран прокрутки на одну строку списка.
   */
  const weeklyCardLines: ((w: WeeklyVehicleRequestDto) => ReactNode)[] = [
    (w) => w.objectName,
    (w) => weeklyCountsText(w.counts),
    (w) => (w.status === 'pending' ? 'Ждёт визы' : null),
    (w) => (w.cancelReason ? `Причина снятия: ${w.cancelReason}` : null),
    (w) => `${w.createdByName} · ${formatDateTime(w.createdAt)}`,
  ];

  /**
   * Карточка строки ленты: заказ и неделя рисуются своими наборами строк, а не общим — полей у них
   * общих ровно два, номер и площадка. Наборы склеиваются в один список, потому что строка
   * принадлежит одному виду документа: чужие строки в ней возвращают `null` и не показываются.
   */
  const card: CardConfig<FeedRow> = {
    title: (row) => (row.kind === 'weekly' ? row.weekly.displayNumber : row.order.displayNumber),
    badge: (row) => {
      if (row.kind === 'weekly') return <WeeklyStatusTag status={row.weekly.status} />;
      const r = row.order;
      return (
        <StatusCell
          status={r.status}
          deleted={!!r.deletedAt}
          approved={!!r.approvedAt}
          cancelReason={r.cancelReason}
          pending={statusMut.isPending && statusMut.variables?.id === r.id}
          onChange={(status) => requestStatusChange(r, status)}
        />
      );
    },
    // Отдел и в карточке телефона стоит кодом — тем же, что в колонке списка: подсказки
    // наведением на телефоне нет, но и разной подписи у одного заказчика быть не должно.
    // У недели главная строка — сама неделя: её документ и называет.
    primary: (row) =>
      row.kind === 'weekly' ? row.weekly.weekLabel : requestCustomerLabel(row.order).text,
    lines: [
      ...weeklyCardLines.map(
        (line) => (row: FeedRow) => (row.kind === 'weekly' ? line(row.weekly) : null),
      ),
      ...orderCardLines.map(
        (line) => (row: FeedRow) => (row.kind === 'order' ? line(row.order) : null),
      ),
    ],
    onOpen: (row) => (row.kind === 'weekly' ? openWeekly(row.weekly) : setViewRecord(row.order)),
    actions: (row) => {
      if (row.kind === 'weekly') {
        return [
          {
            key: 'open-weekly',
            label: 'Открыть неделю',
            icon: <EyeOutlined />,
            onClick: () => openWeekly(row.weekly),
          },
        ];
      }
      const r = row.order;
      const view = {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      };
      /*
       * Рейс — пунктом шита, а не только ссылкой в строке карточки: по пункту во весь экран
       * пальцем попадают вернее, чем по номеру внутри текста. Номер стоит в подписи не для
       * красоты — по нему видно, тот ли это рейс, о котором думаешь, ещё до нажатия.
       *
       * Право спрашивается адресом ссылки, а не отдельным условием: где номер остался текстом,
       * там и пункта быть не должно, иначе окно открывалось бы там, где ссылки не показывают.
       * Пункт живёт во всех ветках, включая архивную: у заявки, уехавшей в архив, рейс никуда не
       * делся, и вопрос «в чём она ехала» задают о ней чаще, чем о живой.
       */
      const route = r.route;
      const routeActions =
        route && vehicleRouteLink(can, route.id)
          ? [
              {
                key: 'route',
                label: `Открыть маршрут ${route.displayNumber}`,
                icon: <NodeIndexOutlined />,
                onClick: () => openRoute(route.id),
              },
            ]
          : [];
      if (r.deletedAt) {
        return canRestore
          ? [
              view,
              ...routeActions,
              {
                key: 'restore',
                label: 'Восстановить',
                icon: <ReloadOutlined />,
                onClick: () => restoreMut.mutate(r.id),
              },
            ]
          : [view, ...routeActions];
      }
      /** Смена техники (ADR 0048) — на своём праве, поэтому и в короткой ветке арендодателя. */
      const reassign = reassignAllowed(r)
        ? [
            {
              key: 'reassign',
              label: 'Сменить технику',
              icon: <SwapOutlined />,
              onClick: () => setReassignTarget(r),
            },
          ]
        : [];
      /** Смена машиниста — рядом со сменой техники: одно решение о заявке, только о человеке. */
      const machinist = machinistChangeAllowed(r)
        ? [
            {
              key: 'machinist',
              label: 'Сменить машиниста',
              icon: <UserSwitchOutlined />,
              onClick: () => setMachinistTarget(r),
            },
          ]
        : [];
      /** Починка истории — рядом со сменой машиниста: та же история, но про её пробелы. */
      const repair = historyRepairAllowed(r)
        ? [
            {
              key: 'history-repair',
              label: 'Починка истории',
              icon: <ToolOutlined />,
              onClick: () => setRepairTarget(r),
            },
          ]
        : [];
      if (!canEdit && !canDelete)
        return [view, ...routeActions, ...reassign, ...machinist, ...repair];
      const allowed = canModify(r);
      return [
        view,
        ...routeActions,
        ...reassign,
        ...machinist,
        ...repair,
        ...(decidableEarlyEnd(r)
          ? [
              {
                key: 'approve-early-end',
                label: 'Согласовать досрочное завершение',
                icon: <FieldTimeOutlined />,
                onClick: () => earlyEnd.approve(r),
              },
              {
                key: 'reject-early-end',
                label: 'Отклонить досрочное завершение',
                danger: true,
                onClick: () => earlyEnd.reject(r),
              },
            ]
          : []),
        ...(earlyEndAllowed(r)
          ? [
              {
                key: 'early-end',
                label: 'Завершить досрочно',
                icon: <FieldTimeOutlined />,
                onClick: () => earlyEnd.open(r),
              },
            ]
          : []),
        {
          key: 'edit',
          label: 'Редактировать',
          icon: <EditOutlined />,
          disabled: !allowed,
          onClick: () => openEdit(r),
        },
        {
          key: 'delete',
          label: r.status === 'new' ? 'Удалить' : 'Переместить в архив',
          icon: <DeleteOutlined />,
          danger: true,
          disabled: !allowed,
          onClick: () => confirmDelete(r),
        },
      ];
    },
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        /* Два входа рядом: обычный заказ и заявка на неделю. Недельная — не «ещё один тип
           заявки», а документ-основание над заказами (ADR 0085), и вести её из того же списка,
           где эти заказы видны, — единственное место, где оба вопроса решают вместе. Право на
           неё своё: видеть документ теперь могут и те, кто его не заводит.

           Третья кнопка не заводит ничего, а открывает список рейсов окном (ADR 0120) — там же,
           где прежде стояла его вкладка. Она первая слева и без выделения: главное действие
           списка — заказ, а маршруты приходят к нему довеском. */
        canCreate || canCreateWeekly || showRoutes ? (
          <Space size={8} wrap>
            {showRoutes && (
              <Button icon={<NodeIndexOutlined />} onClick={() => openRoutesList()}>
                Маршруты
              </Button>
            )}
            {canCreateWeekly && (
              <Button icon={<PlusOutlined />} onClick={weeklyCreate.open}>
                Заявка на неделю
              </Button>
            )}
            {canCreate && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                Создать заявку
              </Button>
            )}
          </Space>
        ) : null
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер документа' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        // Круглая кнопка на телефоне одна, и это заказ: недельную заявку собирают за столом —
        // состав в неё правят построчно, и на экране телефона такой работы не делают.
        primaryAction: canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
        // «Маршруты» на телефоне стоят рядом с «Фильтрами»: десктопный слот `extra` там не
        // рисуется вовсе, а круглая кнопка занята заказом — и вторая такая же читалась бы как
        // ещё одно «создать», а не как переход в чужой список.
        secondaryActions: showRoutes
          ? [{ label: 'Маршруты', icon: <NodeIndexOutlined />, onClick: () => openRoutesList() }]
          : undefined,
      }}
    >
      {/* Сводка — на уровне вкладок, над фильтрами и кнопкой: она относится ко всему списку. */}
      <TabsExtra tabKey="requests">
        <SummaryBar title="Заявок" items={summaryItems} />
      </TabsExtra>

      <DataTable<FeedRow>
        columns={columns}
        card={card}
        // Карточку открывает клик по строке — тем же движением, что и касание карточки на телефоне
        // (`card.onOpen`). Кнопка «Открыть карточку» в «Действиях» остаётся: клавиатурой до строки
        // не добраться, а ячейки с активным содержимым клик строке не отдают (`opensRow`).
        //
        // Недельная строка карточки не открывает вовсе: у документа её нет — сборка живёт
        // отдельной страницей с адресом, и клик ведёт туда.
        onRowClick={(row) =>
          row.kind === 'weekly' ? openWeekly(row.weekly) : setViewRecord(row.order)
        }
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? `Заявка ${record.displayNumber}` : 'Новая заявка на автотехнику'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={880}
      >
        {/* Поля парами (FormGrid): в одну колонку форма заявки не помещается в экран и половину
            полей прячет под прокрутку. На телефоне колонка одна, порядок полей тот же. */}
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <FormGrid>
            {/* Заказчик заявки (ADR 0040, план Р2): площадки и подразделения одним подбором — по
              видимости учётки, а не по её оси в отдельности. Два поля рядом означали бы, что одно
              из них пустое и непонятно почему; заказчик у заявки ровно один. */}
            <Form.Item
              name="customerKey"
              label="Объект/отдел"
              // Заказчика меняют только у «Новой» (Р7): у взятой в работу объект затрат уже ушёл
              // снимком в задание путевого листа, и сервер отвечает на такую правку 422. Текст —
              // его же, чтобы поле и отказ говорили одно.
              extra={customerLocked ? REQUEST_CUSTOMER_LOCKED_MESSAGE : undefined}
              rules={[{ required: true, message: 'Выберите объект или отдел' }]}
            >
              <RequestCustomerSelect
                options={customer.options}
                loading={customer.loading}
                disabled={customerLocked || customer.disabled}
              />
            </Form.Item>
            {/* Тип заведённой заявки меняется переоформлением (ADR 0091) — там, где заказанная
              позиция годится обоим типам. Где не годится, поле заперто и говорит почему. */}
            <Form.Item
              name="requestType"
              label="Тип заявки"
              tooltip="Заказ техники на объект — техника любого вида; грузоперевозка — только грузовая"
              extra={record ? (retypeBlocker ?? 'Смена типа переоформит заявку') : undefined}
              rules={[{ required: true, message: 'Выберите тип заявки' }]}
            >
              <AutoSelect
                options={formRequestTypeOptions}
                placeholder="Выберите тип заявки"
                // Заперто, когда переоформлять нельзя, и когда роли доступен один тип: выбор,
                // которого нет, поле обещать не должно.
                disabled={(!!record && !canRetype) || requestTypeOptions.length === 1}
                onChange={handleRequestTypeChange}
              />
            </Form.Item>
            {/* Позиция классификатора — во всю ширину: подписи вроде «Автокраны, г/п 130 т» в
              половине окна обрезаются там, где начинается отличие одной от другой. */}
            <FormGrid.Full>
              <VehicleClassificationSelect
                groups={typeGroups}
                loading={typesLoading}
                disabled={!watchRequestType}
                placeholder={
                  watchRequestType ? 'Выберите тип или категорию' : 'Сначала выберите тип заявки'
                }
              />
            </FormGrid.Full>

            {/* Техника на объект: период работы. Ближайший доступный день зависит от того, кто
              заводит заявку (ADR 0104): заявителю — завтра, а после 15:00 послезавтра; тому, кто
              ведёт заказы, — сегодня по МСК. */}
            {isSpecial && (
              // Даты — соседними ячейками сетки: пара «начало — окончание» читается вместе.
              <>
                <Form.Item
                  name="dateFrom"
                  label="Дата начала"
                  tooltip={leadTimeHint}
                  rules={[{ required: true, message: 'Укажите дату начала' }]}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    disabledDate={minDateRule}
                  />
                </Form.Item>
                <Form.Item
                  name="dateTo"
                  label="Дата окончания"
                  // Число дней (столько техника занята на объекте) — подписью под полем: в сетке из
                  // двух колонок отдельной колонки под него уже нет. У работающей заявки здесь же
                  // сказано, чем сокращают срок: правкой его сократить нельзя (ADR 0044).
                  extra={
                    dateToLocked
                      ? 'Срок работающей техники сокращают досрочным завершением — с визой'
                      : periodHint
                  }
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    // Продление правкой остаётся, сокращение — нет: то же правило проверяет
                    // сервер, и предлагать дату, которую он отклонит, портал не должен.
                    disabledDate={dateToLocked ? isBeforeCurrentDateTo : minDateRule}
                  />
                </Form.Item>
                {/* Задним числом (ADR 0101): причина и цена правки — сразу под датами, которые её
                  вызвали, а не в конце формы. Блока нет вовсе, пока срок не уходит в прошлое. */}
                {backdated && effectiveDateKey && (
                  <FormGrid.Full>
                    <VehicleBackdateFields
                      record={record}
                      next={formCalendar}
                      effectiveDate={effectiveDateKey}
                    />
                  </FormGrid.Full>
                )}
                {/* Кто встречает технику на объекте: без контакта заезд и место работ выясняются
                  звонками через диспетчера уже на воротах. */}
                <FormGrid.Full>
                  <ResponsibleFields
                    nameField="responsibleName"
                    phoneField="responsiblePhone"
                    nameLabel="Ответственный на объекте"
                    phoneLabel="Контактный телефон"
                  />
                </FormGrid.Full>

                {/* Перегоны 4-П работающей заявки: доставка на площадку и вывоз с неё. Правятся
                  здесь, потому что здесь их и вспоминают — открыв заявку, по которой технику
                  повезли не так, как собирались. У новой заявки блока нет: перегон едет на
                  назначенной машине, а её ещё не выбрали. */}
                {relocationsEditable && (
                  <FormGrid.Full>
                    <Form.Item label="Перегон техники (4-П)">
                      <RequestRelocationsField request={record!} />
                    </Form.Item>
                  </FormGrid.Full>
                )}
              </>
            )}

            {/* Грузоперевозка: дата/время, объём или масса, адреса. */}
            {isFreight && (
              <>
                <Form.Item
                  name="scheduledDate"
                  label="Дата подачи"
                  tooltip={leadTimeHint}
                  rules={[{ required: true, message: 'Укажите дату' }]}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    disabledDate={minDateRule}
                  />
                </Form.Item>
                <Form.Item
                  name="scheduledTime"
                  label="Время (МСК)"
                  tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
                  rules={[optionalWorkTimeRule]}
                >
                  <TimeInput />
                </Form.Item>
                {/* Задним числом (ADR 0101) — тем же блоком, что и у заказа на объект: правило на
                  оба типа заявки одно, разная у них только дата, по которой оно считается. */}
                {backdated && effectiveDateKey && (
                  <FormGrid.Full>
                    <VehicleBackdateFields
                      record={record}
                      next={formCalendar}
                      effectiveDate={effectiveDateKey}
                    />
                  </FormGrid.Full>
                )}
                {/* Ездки заявки (§4.1): груз, адреса и контакты обоих концов. С одной ездкой блок
                  выглядит и заполняется ровно как форма до плана — те же поля в тех же ячейках
                  сетки; списком с «+ ездка» и «повторить N раз» он разворачивается по нажатию. */}
                <RequestTripsBlock
                  savedTrips={recordTrips}
                  expanded={tripsExpanded}
                  onExpand={() => setTripsExpanded(true)}
                  suggestObjectIds={suggestObjectIds}
                  cargoRequired={cargoRequired}
                />
              </>
            )}

            {/* Заголовок и пример заполнения зависят от типа заявки (COMMENT_HINTS). */}
            <FormGrid.Full>
              <Form.Item name="comment" label={commentHint?.label ?? 'Комментарий'}>
                <Input.TextArea rows={3} maxLength={2000} placeholder={commentHint?.placeholder} />
              </Form.Item>
              <Form.Item label="Файлы">
                <FileEditor editor={editor} />
              </Form.Item>
            </FormGrid.Full>
          </FormGrid>
        </Form>
      </FormModal>

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <VehicleRequestViewModal
        request={viewed}
        onClose={closeView}
        // Решение по досрочному завершению принимают, прочитав причину, — а она в карточке.
        // Решённый запрос кнопок не получает: согласованный уже сократил срок, отклонённый
        // объясняет, почему этого не случилось.
        earlyEndActions={(r) => {
          if (r.requestType !== 'special_equipment' || r.earlyEnd?.status !== 'pending') {
            return null;
          }
          return (
            <Space size={8} wrap>
              {canApprove && (
                <>
                  <Button size="small" type="primary" onClick={() => earlyEnd.approve(r)}>
                    Согласовать
                  </Button>
                  <Button size="small" danger onClick={() => earlyEnd.reject(r)}>
                    Отклонить
                  </Button>
                </>
              )}
              {/* Отзывает тот, кто мог и подать: отбой приходит и диспетчеру, и площадке. */}
              {canEdit && (
                <Button size="small" onClick={() => earlyEnd.withdraw(r)}>
                  Отозвать запрос
                </Button>
              )}
            </Space>
          );
        }}
        onEdit={
          viewed && canModify(viewed)
            ? (r) => {
                closeView();
                openEdit(r);
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

      {/* Правка срока — своя дверь (волна 4a плана `docs/assignment-periods-plan.md`): окно
        показывает, что сгорит и что выпишется, какие решения о технике погасит сокращение, и
        берёт подтверждения, которых у широкого маршрута нет. Причина, набранная в форме за задний
        ход, переезжает сюда: человек объясняет одну правку, а не каждую ручку, через которую она
        проходит. */}
      <VehiclePeriodModal
        request={periodSave?.request ?? null}
        command={periodSave?.command ?? null}
        reason={periodSave?.values.backdateReason}
        operationId={operationId}
        onCancel={() => setPeriodSave(null)}
        onApplied={(result) => {
          const pending = periodSave;
          setPeriodSave(null);
          // Остальное тело — второй командой: у неё своя дверь и своя версия. Даты в нём те же,
          // что дверь уже записала, — широкий маршрут их и не тронет.
          if (pending) saveMut.mutate({ v: pending.values, period: result });
        }}
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
        request={assignTarget}
        confirmLoading={statusMut.isPending}
        onCancel={() => setAssignTarget(null)}
        onSubmit={({ assignment, schedule, previewFingerprint }) => {
          if (!assignTarget) return;
          statusMut.mutate({
            id: assignTarget.id,
            status: 'confirmed',
            version: assignTarget.version,
            assignment,
            // Срок при переводе в работу окно спрашивает всегда — `null` сюда не приходит.
            schedule: schedule ?? undefined,
            // Приходит только с отката «Выполнена» → «В работе»: на прочих переходах окно
            // предпросмотра не зовёт и обещать серверу нечего.
            previewFingerprint,
          });
        }}
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
        onSubmit={({ assignment, correction, previewFingerprint }) =>
          reassignTarget
            ? reassignMut.mutateAsync({
                id: reassignTarget.id,
                version: reassignTarget.version,
                assignment,
                correction,
                previewFingerprint,
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
          void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
          void qc.invalidateQueries({ queryKey: ['waybills'] });
        }}
      />

      {/* Починка истории (подэтап 6a): пробелы машиниста, заполнение неизвестных дней и решение о
          машине после конца срока. Окно само спрашивает сервер, что чинить, — портал этого не
          считает: зависит от того, какую бумагу ещё можно отменить. */}
      <VehicleRepairModal
        request={repairTarget}
        onCancel={() => setRepairTarget(null)}
        onRepaired={() => {
          void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
          void qc.invalidateQueries({ queryKey: ['waybills'] });
        }}
      />

      {/* Выполнение: отработанное время и стоимость (ADR 0029). Факт уходит тем же запросом,
          что и статус, — заявка не бывает выполненной без ответа «сколько стоило». */}
      {/* Отказ по запросу досрочного завершения: причина спрашивается окном хука. */}
      {earlyEnd.node}

      {/* Досрочное завершение — то же окно, что и на вкладке «На объекте» (ADR 0044). */}
      <VehicleEarlyEndModal
        request={earlyEnd.target}
        onDate={today}
        approvesOwn={earlyEnd.approvesOwn}
        confirmLoading={earlyEnd.pending}
        onCancel={earlyEnd.close}
        onSubmit={earlyEnd.submit}
      />

      <VehicleCompleteModal
        request={completeTarget}
        confirmLoading={statusMut.isPending}
        onCancel={() => setCompleteTarget(null)}
        onSubmit={({ completion, comment }) =>
          completeTarget &&
          statusMut.mutate({
            id: completeTarget.id,
            status: 'done',
            version: completeTarget.version,
            comment,
            completion,
          })
        }
      />

      <CancelReasonModal
        open={!!cancelTarget}
        subject={cancelTarget ? `№ ${cancelTarget.displayNumber}` : ''}
        confirmLoading={statusMut.isPending}
        onCancel={() => setCancelTarget(null)}
        onSubmit={(reason) =>
          cancelTarget &&
          statusMut.mutate({
            id: cancelTarget.id,
            status: 'cancelled',
            version: cancelTarget.version,
            comment: reason,
          })
        }
      />

      {/* Возврат в «Новую»: причина обязательна наравне с причиной отмены, а над полем — перечень
        того, что заявка потеряет. Выписанный по ней путевой лист возврат не пропустит
        (`ROLLBACK_WAYBILL_MESSAGE`): работу заявки, попавшей в выданный бланк, стирать нельзя —
        об этом сказано здесь же, до набранной впустую причины. */}
      <RollbackReasonModal
        open={!!rollbackTarget}
        subject={rollbackTarget ? `№ ${rollbackTarget.displayNumber}` : ''}
        erases={rollbackTarget ? rollbackErases(rollbackTarget, rollbackRelocations ?? []) : []}
        blocker={
          rollbackTarget?.route?.hasWaybill ||
          rollbackRelocations?.some(
            (route) => route.waybill && route.waybill.status !== 'cancelled',
          )
            ? ROLLBACK_WAYBILL_MESSAGE
            : null
        }
        confirmLoading={statusMut.isPending}
        onCancel={() => setRollbackTarget(null)}
        onSubmit={(reason) =>
          rollbackTarget &&
          statusMut.mutate({
            id: rollbackTarget.id,
            status: 'new',
            version: rollbackTarget.version,
            comment: reason,
          })
        }
      />

      {/* Окно «Заявка на неделю»: спрашивает площадку и неделю, а дальше уводит на страницу
          сборки — состав в модалку не помещается (ADR 0085 §5). */}
      {weeklyCreate.node}
    </PageTableLayout>
  );
}
