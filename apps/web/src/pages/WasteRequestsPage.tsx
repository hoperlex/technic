import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  allowedStatusTransitions,
  MIN_WASTE_VOLUME_M3,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  requestStatusColors,
  requestStatusLabels,
  statusChangeRequiresReason,
  requestTypeColors,
  requestTypeLabels,
  parseWasteRequestNumberSearch,
  normalizeTimeInput,
  type CompleteWasteRequestInput,
  actsForCounterparty,
  isPricedRequestType,
  requiresWasteFact,
  isVolumeAllowed,
  volumeStepMessage,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';
import {
  containerTypesApi,
  counterpartiesApi,
  filesApi,
  objectsApi,
  wasteRequestsApi,
  wasteTariffsApi,
  wasteTypesApi,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '../api/resources';
import { AutoSelect } from '../components/AutoSelect';
import { CancelReasonModal } from '../components/CancelReasonModal';
import { ActionSheet } from '../components/ActionSheet';
import { DataTable, type CardConfig } from '../components/DataTable';
import { FileLinkList, FilesCell } from '../components/FileLinks';
import { FormGrid } from '../components/FormGrid';
import { FormModal } from '../components/FormModal';
import { PageTableLayout } from '../components/PageTableLayout';
import { ResponsibleFields } from '../components/ResponsibleFields';
import { sortOptionsFrom, type FilterDefinition } from '../components/listControls';
import { PageTabs, TabsExtra } from '../components/PageTabs';
import { SummaryBar } from '../components/SummaryBar';
import { actionsColumn, badgeColumn, textColumn } from '../components/columns';
import { ObjectCell } from '../components/ObjectCell';
import { TimeInput, optionalWorkTimeRule } from '../components/TimeInput';
import { useIsMobile } from '../hooks/useIsMobile';
import { useListParams } from '../hooks/useListParams';
import { useObjectScope } from '../hooks/useObjectScope';
import { useAuth } from '../auth/AuthContext';
import { MOSCOW_TZ } from '../theme';
import { errorMessage, formatDate, formatDateTimeMaybe } from '../utils/format';
import { applyApiFieldErrors } from '../utils/formErrors';
import { withSavedOption } from '../utils/selectOptions';
import { isBeforeMinRequestDate, isPastDate, minRequestDate } from '../utils/date';
import { OnSiteTab } from './waste/OnSiteTab';
import { wasteAmountLine, wastePricingHint } from './waste/pricingHint';
import { WasteDoneModal } from './waste/WasteDoneModal';
import { WasteRequestViewModal } from './waste/WasteRequestViewModal';

const FILE_MAX_SIZE = 52_428_800; // 50 МБ
const FILE_MAX_COUNT = 20;

interface EditorFile {
  id: string;
  filename: string;
  /** Нужен ссылке в списке: фото и PDF открываются окном просмотра, остальное скачивается. */
  contentType: string;
  size: number;
  isNew: boolean;
}

interface RequestFormValues {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  wasteTypeId?: string;
  volumeM3?: number;
  /** Оператор вывоза (контрагент); можно не выбирать — назначается при переводе в работу. */
  operatorCounterpartyId?: string;
  deliveryDate: Dayjs;
  /** Необязательное время в виде `HH:mm`; пусто — «на эту дату, время не важно». */
  deliveryTime?: string;
  /** Кто принимает машину на площадке и по какому телефону (миграция 0062). */
  responsibleName?: string;
  responsiblePhone?: string;
  comment?: string;
}

/** Человекочитаемое описание предмета заявки для колонки списка. */
function requestSubject(r: WasteRequestDto): string {
  // Объём — часть предмета заявки там, где он есть: у вывоза он определяет сумму (ADR 0019),
  // у контейнерных операций его нет — кроме заявок, заведённых до этого решения.
  // Техники у вывоза нет вовсе (ADR 0022); у заявок, заведённых раньше, тип в базе остался,
  // но предметом заявки он больше не является и в списке не показывается.
  const parts = [
    requiresWasteFact(r.requestType) ? null : r.containerTypeName,
    r.volumeM3 != null ? `${r.volumeM3} м³` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

export function WasteRequestsPage() {
  // Вкладки управляемые: виджет сводки живёт в строке вкладок и показывается только на «Заявках».
  const [tab, setTab] = useState('requests');
  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={setTab}
        refreshQueryKey={['waste-requests']}
        items={[
          { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
          { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
        ]}
      />
    </div>
  );
}

function RequestsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const { user, can } = useAuth();
  // Объектные роли и оператор — это область видимости («свои объекты», «свои заявки»), а не
  // право: от неё зависит, что показывать в фильтрах и колонках, а не что разрешено делать.
  const { isObjectRole, soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  // «Оператор вывоза» — это роль исполнителя плюс контрагент-оператор (ADR 0038): по одной роли
  // такой вывод уже неверен, ею же работает арендодатель техники в другом разделе.
  const isOperator = actsForCounterparty(user, 'operator');
  // Действия — только по правам (ADR 0021): те же, что проверяет API.
  const canCreate = can('wasteRequests.create');
  const canEdit = can('wasteRequests.update');
  const canDelete = can('wasteRequests.delete');
  const canAssignOperator = can('wasteRequests.assignOperator');
  const canRestore = can('archive.restore');

  // Объектной роли с одним объектом фильтр зафиксирован на нём; с несколькими — фильтр открыт,
  // но сужен до своих (ADR 0039), а «все» означает все свои: остального сервер не отдаёт.
  const ownObjectId = soleObjectId ?? '';

  // Фильтры живут в панели над таблицей, а не в выпадашках столбцов: в заголовке их не видно,
  // а половина из них (объект, оператор) — списки справочников, которым там тесно.
  const { params, setParams, setSort, onTableChange } = useListParams<{
    status?: string;
    requestType?: string;
    objectId?: string;
    containerTypeId?: string;
    operatorCounterpartyId?: string;
    num?: number;
  }>({ objectId: ownObjectId || undefined }, { searchKeys: ['comment'] });

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const [objectFilter, setObjectFilter] = useState(ownObjectId);
  const [numInput, setNumInput] = useState('');
  const applyObjectFilter = (v: string) => {
    setObjectFilter(v);
    applyFilter({ objectId: v || undefined });
  };
  const applyNumFilter = (raw: string) => {
    setNumInput(raw);
    applyFilter({ num: parseWasteRequestNumberSearch(raw) });
  };

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', params],
    queryFn: () => wasteRequestsApi.list(params),
  });

  // Сводка в шапке: сколько заявок ждёт обработки и сколько в работе. Ключ начинается с
  // 'waste-requests' — значит счётчики обновляются теми же инвалидациями, что и список.
  const { data: summary } = useQuery({
    queryKey: ['waste-requests', 'summary', params.objectId],
    queryFn: () => wasteRequestsApi.summary({ objectId: params.objectId }),
  });
  // Оператор заявки не обрабатывает — он их выполняет (ADR 0010): «Новых» у него не бывает,
  // они появляются в его списке уже переведёнными в работу.
  const summaryItems = [
    ...(isOperator ? [] : [{ label: 'Не обработанных', value: summary?.new ?? 0 }]),
    { label: requestStatusLabels.confirmed, value: summary?.confirmed ?? 0 },
  ];

  // isLoading у списков нужен полям формы: обязательное поле с единственным вариантом
  // заполняет себя само, и подставлять по недогруженному списку нельзя.
  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: ['objects', 'for-select'],
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const { data: types, isLoading: typesLoading } = useQuery({
    queryKey: ['container-types', 'for-select'],
    queryFn: () =>
      containerTypesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const objectOptions = limitObjectOptions(
    (objects?.items ?? []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.name}`,
    })),
  );
  const allTypes = types?.items ?? [];
  // Установка — только контейнеры (type='cont').
  const contTypeOptions = allTypes
    .filter((t) => t.type === 'cont')
    .map((t) => ({ value: t.id, label: t.name }));
  // Самосвалы нужны машинам закрытия (ADR 0011) и фильтру списка: сама заявка на вывоз
  // техники больше не несёт (ADR 0022), но у заведённых до этого решения тип сохранён.
  const truckTypes = allTypes.filter((t) => t.type === 'truck');
  const truckTypeOptions = truckTypes.map((t) => ({ value: t.id, label: t.name }));
  const requestTypeOptions = REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] }));
  const statusOptions = REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }));
  // Фильтр по столбцу «Контейнер / машина»: в нём соседствуют оба вида, поэтому список общий,
  // но разложен по группам — иначе самосвалы и контейнеры идут вперемешку. Самосвал в фильтре
  // находит только заявки вывоза, заведённые до ADR 0022: у новых техники в предмете нет.
  const subjectFilterOptions = [
    { label: 'Контейнеры', options: contTypeOptions },
    { label: 'Самосвалы', options: truckTypeOptions },
  ].filter((g) => g.options.length > 0);

  // Типы мусора — только для вывоза (ADR 0019). Спрашиваются
  // только типы с действующей ценой (ADR 0017): выбор типа без тарифа кончался бы отказом
  // «тариф не найден» уже при сохранении заявки.
  const { data: wasteTypes, isLoading: wasteTypesLoading } = useQuery({
    queryKey: ['waste-types', 'for-select', 'priced'],
    queryFn: () =>
      wasteTypesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        hasActiveTariff: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const wasteTypeOptions = (wasteTypes?.items ?? []).map((w) => ({ value: w.id, label: w.name }));

  // Операторы вывоза — контрагенты соответствующего типа (ADR 0010). Оператору этот список
  // не нужен: исполнителя он не выбирает.
  const { data: operatorsData, isLoading: operatorsLoading } = useQuery({
    queryKey: ['counterparties', 'operators-for-select'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: canAssignOperator,
  });
  /**
   * Исполнителя выбираем среди операторов, привязанных к объекту заявки (ADR 0010). Правило
   * повторяет серверное: объект, у которого операторы не заведены, список не сужает — иначе на
   * новом объекте выбрать было бы некого. Уже назначенный оператор остаётся в списке, даже если
   * привязку сняли: иначе форма показала бы вместо него идентификатор.
   */
  const operatorOptionsFor = (
    objectId: string | undefined,
    assigned?: { id: string | null; name: string | null },
  ) => {
    const all = operatorsData?.items ?? [];
    const linked = objectId ? all.filter((c) => c.objects.some((o) => o.id === objectId)) : [];
    const options = (linked.length > 0 ? linked : all).map((c) => ({ value: c.id, label: c.name }));
    return withSavedOption(options, { id: assigned?.id, name: assigned?.name });
  };

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  // Просмотр заявки — отдельное окно, только чтение: в таблице нет места ни автору, ни цене за
  // м³, ни машинам, а разбирать конкретную заявку без них нельзя (ADR 0012).
  const [viewRecord, setViewRecord] = useState<WasteRequestDto | null>(null);
  const [form] = Form.useForm<RequestFormValues>();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const watchObjectId = Form.useWatch('objectId', form);
  const watchRequestType = Form.useWatch('requestType', form);
  const watchWasteTypeId = Form.useWatch('wasteTypeId', form);
  const watchVolumeM3 = Form.useWatch('volumeM3', form);
  // Исполнитель влияет на цену: прайс у каждого оператора свой (ADR 0026).
  const watchOperatorId = Form.useWatch('operatorCounterpartyId', form);

  // Тип оформленной заявки остаётся в выборе, даже если его тариф успели отключить.
  const formWasteTypeOptions = withSavedOption(wasteTypeOptions, {
    id: record?.wasteTypeId,
    name: record?.wasteTypeName,
  });
  // Тем же приёмом держится тип контейнера: справочник могли выключить (установка), а с объекта
  // контейнер — снять соседней заявкой (замена и снятие). Поле правки обязательное, и без этого
  // оно открывалось бы пустым у заявки, предмет которой давно выбран.
  const savedContainerType = {
    id: record?.containerTypeId,
    name: record?.containerTypeName,
  };

  // Тарифицируется только вывоз (ADR 0019): тип мусора, объём и стоимость есть
  // у него одного, контейнерные операции ограничиваются типом контейнера.
  const isPriced = watchRequestType ? isPricedRequestType(watchRequestType) : false;

  // Факта выполнения в форме правки нет: он предъявляется закрытием заявки и правится повторным
  // закрытием (ADR 0035) — там же, где его вводят, с расчётом по прайсу перед глазами.

  // Выбор исполнителя в форме следует за выбранным объектом: сменили объект — сменился список.
  const formOperatorOptions = operatorOptionsFor(watchObjectId, {
    id: record?.operatorCounterpartyId ?? null,
    name: record?.operatorName ?? null,
  });

  // Предпросмотр цены: тариф подбирает сервер, чтобы форма и расчёт при сохранении не разошлись.
  // Техника в заявке не указывается (ADR 0022), поэтому подбор идёт по виду «Самосвал» — тем же
  // способом, что и на сохранении. Оператор выбран — цена его прайса; не выбран — минимальная
  // среди операторов, и форма показывает её как «от» (ADR 0026). Незаданный прайс приходит как
  // `tariff: null` при 200, поэтому «цены нет» и «запрос не прошёл» — разные ветки, а не общая
  // ошибка.
  const { data: tariffResult, isError: tariffRequestFailed } = useQuery({
    queryKey: ['waste-tariffs', 'resolve', watchWasteTypeId, watchOperatorId],
    queryFn: () =>
      wasteTariffsApi.resolve(
        watchWasteTypeId!,
        { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
        watchOperatorId,
      ),
    enabled: isPriced && !!watchWasteTypeId,
  });
  const tariff = tariffResult?.tariff ?? null;
  const volumeStepM3 = tariff?.volumeStepM3 ?? null;
  /** Объём, по которому считается заявка; есть только у вывоза (ADR 0019). */
  const plannedVolume = isPriced ? (watchVolumeM3 ?? null) : null;
  // Незаданный тариф заявку не отменяет (ADR 0046): расчёт сменяется предупреждением, а форма
  // отправляется как есть — заявка сохранится без стоимости.
  const pricingHint = wastePricingHint({
    isPriced,
    wasteTypeId: watchWasteTypeId,
    operatorSelected: !!watchOperatorId,
    tariff,
    resolved: tariffResult != null,
    requestFailed: tariffRequestFailed,
    volumeM3: plannedVolume,
  });

  // Наличие контейнеров на объекте (view: установки − снятия). Для «Замены» и «Снятия».
  const { data: presentData, isLoading: presentLoading } = useQuery({
    queryKey: ['waste-requests', 'present-for-object', watchObjectId],
    queryFn: () => wasteRequestsApi.present({ objectId: watchObjectId, pageSize: 500 }),
    enabled: !!watchObjectId,
  });
  // Уникальные присутствующие типы контейнеров на объекте.
  const presentTypeMap = new Map<string, string>();
  for (const r of presentData?.items ?? []) {
    if (!r.containerTypeId) continue;
    if (!presentTypeMap.has(r.containerTypeId)) {
      presentTypeMap.set(r.containerTypeId, r.containerTypeName ?? 'Контейнер');
    }
  }
  // Тип контейнера — единственное, что нужно замене и снятию (ADR 0019): вместимость в подписи
  // не нужна, объёма у такой заявки нет, и тип без вместимости в справочнике ей не мешает.
  const presentTypeOptions = [...presentTypeMap].map(([value, label]) => ({ value, label }));
  const objectHasPresent = presentTypeOptions.length > 0;

  // Чем оперирует заявка: у замены и снятия выбор ограничен контейнерами, которые сейчас стоят
  // на объекте. У вывоза техники нет вовсе (ADR 0022) — заказывают объём, а чем его увезут,
  // решает оператор и показывает машинами при закрытии.
  const fromObjectField = {
    // Присутствие считается по объекту, а выбор заявки в нём мог и не остаться — его добавляем
    // отдельно. Подпись «На объекте нет контейнеров» при этом остаётся честной: она о самом
    // объекте, а не о том, что стоит в правимой заявке.
    options: withSavedOption(presentTypeOptions, savedContainerType),
    loading: presentLoading,
    placeholder: 'Тип, присутствующий на объекте',
  };
  const subjectFieldByType = {
    container_replace: {
      label: 'Тип заменяемого контейнера',
      message: 'Выберите тип контейнера для замены',
      ...fromObjectField,
    },
    container_removal: {
      label: 'Тип снимаемого контейнера',
      message: 'Выберите тип контейнера для снятия',
      ...fromObjectField,
    },
  } as const;
  const subjectField =
    watchRequestType === 'container_replace' || watchRequestType === 'container_removal'
      ? subjectFieldByType[watchRequestType]
      : null;

  const openCreate = () => {
    setRecord(null);
    setFiles([]);
    setRemovedIds([]);
    form.resetFields();
    // Дата доставки по умолчанию — сегодня: раньше заявку не заводят (правило в контрактах).
    form.setFieldsValue({ deliveryDate: minRequestDate() } as Partial<RequestFormValues>);
    // Объект подставляется, только когда он у роли один: с несколькими выбирает человек —
    // подставленный за него первый попавшийся завёл бы заявку не на ту площадку (ADR 0039).
    if (soleObjectId) {
      form.setFieldsValue({ objectId: soleObjectId } as Partial<RequestFormValues>);
    }
    setOpen(true);
  };
  const openEdit = (r: WasteRequestDto) => {
    setRecord(r);
    setFiles(
      r.files.map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        isNew: false,
      })),
    );
    setRemovedIds([]);
    form.resetFields();
    form.setFieldsValue({
      objectId: r.objectId,
      requestType: r.requestType,
      containerTypeId: r.containerTypeId ?? undefined,
      wasteTypeId: r.wasteTypeId ?? undefined,
      volumeM3: r.volumeM3 ?? undefined,
      operatorCounterpartyId: r.operatorCounterpartyId ?? undefined,
      deliveryDate: dayjs(r.deliveryAt).tz(MOSCOW_TZ),
      // Время не задано — поле остаётся пустым (в deliveryAt лежит полночь МСК).
      deliveryTime: r.deliveryTimeUnspecified
        ? undefined
        : dayjs(r.deliveryAt).tz(MOSCOW_TZ).format('HH:mm'),
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
      comment: r.comment,
    });
    setOpen(true);
  };

  // Смена типа заявки очищает поля предыдущего варианта.
  const handleRequestTypeChange = () => {
    form.setFieldsValue({
      containerTypeId: undefined,
      wasteTypeId: undefined,
      volumeM3: undefined,
    });
  };
  // Смена объекта сбрасывает тип: для «Замены» список зависит от установок объекта.
  const handleObjectChange = () => {
    form.setFieldsValue({ containerTypeId: undefined });
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setFiles((prev) => [
        ...prev,
        {
          id: uploaded.id,
          filename: uploaded.filename,
          contentType: uploaded.contentType,
          size: uploaded.size,
          isNew: true,
        },
      ]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (item: EditorFile) => {
    if (item.isNew) {
      await filesApi.remove(item.id).catch(() => {});
    } else {
      setRemovedIds((prev) => [...prev, item.id]);
    }
    setFiles((prev) => prev.filter((f) => f.id !== item.id));
  };

  const saveMut = useMutation({
    mutationFn: (values: RequestFormValues) => {
      // Дата и время собираются в МСК — в этом же поясе сервер проверяет рабочее окно.
      // Время не задано → полночь МСК + признак: заявка «на дату», без конкретного часа.
      const time = normalizeTimeInput(values.deliveryTime ?? '');
      const deliveryAt = dayjs.tz(
        `${values.deliveryDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`,
        MOSCOW_TZ,
      );
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        // Тип из справочника несут только контейнерные операции: у вывоза поля в форме нет,
        // и присланное значение сервер всё равно обнулит (ADR 0022).
        containerTypeId: values.containerTypeId,
        // Тип мусора и объём есть только у вывоза (ADR 0019); у контейнерных
        // операций сервер их всё равно обнулит.
        wasteTypeId: isPricedRequestType(values.requestType) ? values.wasteTypeId : undefined,
        volumeM3: isPricedRequestType(values.requestType) ? values.volumeM3 : undefined,
        // Исполнителя назначает диспетчер и только у заведённой заявки: в форме создания поля
        // нет, у остальных ролей — нет и при редактировании (ADR 0010).
        operatorCounterpartyId:
          canAssignOperator && record ? values.operatorCounterpartyId : undefined,
        deliveryAt: deliveryAt.toISOString(),
        deliveryTimeUnspecified: time === undefined,
        responsibleName: values.responsibleName!,
        responsiblePhone: values.responsiblePhone!,
        comment: values.comment ?? '',
      };
      if (record) {
        const payload: WasteRequestUpdatePayload = {
          ...base,
          // Пустое поле у диспетчера означает «снять исполнителя» — это null, а не «не менять».
          operatorCounterpartyId: canAssignOperator
            ? (values.operatorCounterpartyId ?? null)
            : undefined,
          addFileIds: files.filter((f) => f.isNew).map((f) => f.id),
          removeFileIds: removedIds,
          version: record.version,
        };
        return wasteRequestsApi.update(record.id, payload);
      }
      const payload: WasteRequestPayload = {
        ...base,
        fileIds: files.filter((f) => f.isNew).map((f) => f.id),
      };
      return wasteRequestsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
      setOpen(false);
    },
    onError: (e) => {
      // Ошибку валидации показываем на самом поле: тост «Ошибка валидации данных» не говорит,
      // что именно править. `deliveryAt` в форме разложен на дату и время — правим дату.
      applyApiFieldErrors(form, e, { deliveryAt: 'deliveryDate' });
      message.error(errorMessage(e));
    },
  });

  // Переход в работу и отмена проходят через модальные окна — оба требуют ввода
  // (оператор вывоза, причина отмены), поэтому целевая заявка хранится в состоянии.
  const [operatorTarget, setOperatorTarget] = useState<WasteRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WasteRequestDto | null>(null);
  const [operatorForm] = Form.useForm<{ operatorCounterpartyId: string }>();
  // Список в модальном окне назначения сужается по объекту той заявки, которую переводят в работу.
  const assignOperatorOptions = operatorOptionsFor(operatorTarget?.objectId, {
    id: operatorTarget?.operatorCounterpartyId ?? null,
    name: operatorTarget?.operatorName ?? null,
  });

  // Закрытие заявки: факт (объём и стоимость либо только талон) и комментарий вводятся в отдельном
  // окне и уходят вместе со статусом одним запросом.
  const [doneTarget, setDoneTarget] = useState<WasteRequestDto | null>(null);

  const statusMut = useMutation({
    // Окно закрытия отдаёт факт уже в виде тела запроса: фактический объём со стоимостью
    // (ADR 0035) и талоны заявки — здесь остаётся приложить их к смене статуса.
    mutationFn: (v: {
      id: string;
      status: RequestStatus;
      version: number;
      comment?: string;
      completion?: CompleteWasteRequestInput;
      ticketFileIds?: string[];
    }) =>
      wasteRequestsApi.changeStatus(v.id, v.status, v.version, {
        comment: v.comment,
        completion: v.completion,
        ticketFileIds: v.ticketFileIds,
      }),
    onSuccess: () => {
      setOperatorTarget(null);
      setCancelTarget(null);
      setDoneTarget(null);
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

  /**
   * Перевод в работу назначает исполнителя: с этого момента заявку видит оператор, который её
   * выполняет (ADR 0010). Два запроса подряд — назначение меняет версию заявки, поэтому статус
   * переводится уже по обновлённой версии.
   */
  const startWorkMut = useMutation({
    mutationFn: async (v: { r: WasteRequestDto; operatorCounterpartyId: string }) => {
      const assigned = await wasteRequestsApi.assignOperator(
        v.r.id,
        v.operatorCounterpartyId,
        v.r.version,
      );
      return wasteRequestsApi.changeStatus(assigned.id, 'confirmed', assigned.version);
    },
    onSuccess: () => {
      setOperatorTarget(null);
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

  /**
   * Перевод в работу — через назначение оператора вывоза; закрытие — через окно предъявления
   * факта (машины у вывоза мусора, талоны у контейнерных операций) и комментария; отмена —
   * через обязательную причину. Остальные переходы (откаты) выполняются сразу.
   */
  const requestStatusChange = (r: WasteRequestDto, status: RequestStatus) => {
    if (statusChangeRequiresReason(status)) {
      setCancelTarget(r);
      return;
    }
    if (r.status === 'new' && status === 'confirmed') {
      operatorForm.resetFields();
      // Исполнитель мог быть выбран заранее в самой заявке — тогда окно только подтверждает его.
      operatorForm.setFieldsValue({
        operatorCounterpartyId: r.operatorCounterpartyId ?? undefined,
      });
      setOperatorTarget(r);
      return;
    }
    // Выполнение подтверждается окном у заявок любого типа: талон предъявляют и по контейнерной
    // операции, а комментарий к закрытию нужен везде (ADR 0013).
    if (status === 'done') {
      setDoneTarget(r);
      return;
    }
    statusMut.mutate({ id: r.id, status, version: r.version });
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.remove(id),
    onSuccess: (res) => {
      message.success(res.mode === 'hard' ? 'Заявка удалена' : 'Заявка перемещена в архив');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const canModify = (r: WasteRequestDto): boolean => {
    if (r.deletedAt) return false;
    if (!canEdit && !canDelete) return false;
    // Объект правит заявку, пока её не взяли в работу: дальше за ней договорённости с исполнителем.
    if (isObjectRole) return r.status === 'new';
    return true;
  };

  const confirmDelete = (r: WasteRequestDto) =>
    modal.confirm({
      title: r.status === 'new' ? 'Удалить заявку?' : 'Переместить заявку в архив?',
      content:
        r.status === 'new'
          ? 'Заявка в статусе «Новая» будет удалена безвозвратно вместе с файлами.'
          : 'Заявка будет помечена удалённой (soft-delete) и может быть восстановлена администратором.',
      okText: 'Подтвердить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const StatusCell = ({ r }: { r: WasteRequestDto }) => {
    // Набор переходов зависит от прав: линейный цикл для всех, откаты — только администратору,
    // а у внешнего исполнителя свой коридор — закрытие взятой в работу заявки.
    const transitions = user ? allowedStatusTransitions(r.status, user) : [];
    const [sheetOpen, setSheetOpen] = useState(false);
    const tag = (
      <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
        {requestStatusLabels[r.status]}
      </Tag>
    );
    // Причина отмены — в подсказке на теге: в таблице для неё нет колонки, а знать её нужно.
    // На телефоне подсказки нет вовсе — там причина выводится строкой карточки.
    const badge =
      r.cancelReason && !isMobile ? (
        <Tooltip title={`Причина отмены: ${r.cancelReason}`}>{tag}</Tooltip>
      ) : (
        tag
      );
    if (r.deletedAt || transitions.length === 0) {
      return badge;
    }
    const pending = statusMut.isPending && statusMut.variables?.id === r.id;
    const items = transitions.map((s) => ({ key: s, label: requestStatusLabels[s] }));

    // На телефоне переходы показываются списком снизу: выпадающее меню у тега в карточке
    // открывается под палец мимо цели, а подписи в нём — те же (ADR 0030).
    if (isMobile) {
      return (
        <>
          <button
            type="button"
            className="status-trigger"
            aria-label="Изменить статус"
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              setSheetOpen(true);
            }}
          >
            <Space size={4}>
              {badge}
              <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
            </Space>
          </button>
          <ActionSheet
            title="Изменить статус"
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            items={items.map((item) => ({
              key: item.key,
              label: item.label,
              onClick: () => requestStatusChange(r, item.key as RequestStatus),
            }))}
          />
        </>
      );
    }

    return (
      <Dropdown
        trigger={['click']}
        disabled={pending}
        menu={{
          items,
          onClick: ({ key }) => requestStatusChange(r, key as RequestStatus),
        }}
      >
        <Button
          type="text"
          size="small"
          loading={pending}
          aria-label="Изменить статус"
          style={{ padding: 0, height: 'auto', border: 'none' }}
        >
          <Space size={4}>
            {badge}
            <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
          </Space>
        </Button>
      </Dropdown>
    );
  };

  // Ключ колонки — он же поле сортировки на сервере (WASTE_REQUEST_SORT_FIELDS).
  const columns = [
    {
      key: 'num',
      title: '№',
      dataIndex: 'num',
      width: 90,
      sorter: true,
      // Номер — только идентификатор заявки; карточка открывается кнопкой в «Действиях».
      render: (_v: unknown, r: WasteRequestDto) => (
        <span style={{ whiteSpace: 'nowrap' }}>{r.displayNumber}</span>
      ),
    },
    // Ширина задана всем колонкам: при scroll.x='max-content' колонка без ширины тянется по
    // содержимому, и один длинный комментарий возвращал бы горизонтальный скролл всей таблице.
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Объект',
      dataIndex: 'objectName',
      searchable: false,
      width: 230,
      render: (_v, r) => <ObjectCell name={r.objectName} address={r.objectAddress} />,
    }),
    {
      key: 'containerTypeName',
      title: 'Контейнер / машина',
      dataIndex: 'containerTypeName',
      width: 230,
      sorter: true,
      // Стоимость — второй строкой к предмету заявки: своей колонки она стоила дороже, чем
      // помогала, а цена за м³ рядом с суммой объясняет, почему одинаковый объём стоит по-разному.
      render: (_v: unknown, r: WasteRequestDto) => {
        const amountLine = wasteAmountLine(r);
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{requestSubject(r)}</div>
            {amountLine && (
              <Typography.Text type={amountLine.tone} style={{ fontSize: 12 }}>
                {amountLine.text}
              </Typography.Text>
            )}
          </div>
        );
      },
    },
    {
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      width: 150,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => r.wasteTypeName ?? '—',
    },
    badgeColumn<WasteRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: requestTypeLabels,
      colors: requestTypeColors,
      // Названия типов развёрнутые («Замена полного контейнера на пустой»); тег переносится
      // на вторую строку — на одну строку такая колонка забирала бы пол-экрана.
      width: 160,
      multiline: true,
    }),
    {
      key: 'createdAt',
      title: (
        <div style={{ lineHeight: 1.2 }}>
          <div>Дата созд.</div>
          <div>Доставки</div>
        </div>
      ),
      dataIndex: 'createdAt',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35, whiteSpace: 'nowrap' }}>
          <div>{formatDate(r.createdAt)}</div>
          <Typography.Text style={{ color: '#1677ff' }}>
            {formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified)}
          </Typography.Text>
        </div>
      ),
    },
    // Оператор вывоза видит только свои заявки (ADR 0010) — колонка повторяла бы ему одно и то
    // же значение во всех строках.
    ...(isOperator
      ? []
      : [
          {
            key: 'operatorName',
            title: 'Оператор',
            dataIndex: 'operatorName',
            width: 170,
            sorter: true,
            render: (_v: unknown, r: WasteRequestDto) => r.operatorName ?? '—',
          },
        ]),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 160,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => <StatusCell r={r} />,
    },
    textColumn<WasteRequestDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 230,
      ellipsis: true,
    }),
    {
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      width: 80,
      render: (_v: unknown, r: WasteRequestDto) => <FilesCell files={r.files} />,
    },
    actionsColumn<WasteRequestDto>((r) => {
      // Карточка открывается и у архивной заявки: понять, что и почему в ней было, можно
      // только там — в строке таблицы ни автора, ни истории нет.
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
      // Роли, которая заявки не ведёт вовсе (наблюдатель, оператор), кнопки не показываются:
      // «выключено» читается как «сейчас нельзя», а нельзя ей всегда.
      if (!canEdit && !canDelete) return view;
      const allowed = canModify(r);
      return (
        <Space size={4}>
          {view}
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
    }, 120),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        style={{ width: 240 }}
        value={objectFilter}
        onChange={applyObjectFilter}
        options={[{ value: '', label: 'Все объекты' }, ...objectOptions]}
        showSearch
        optionFilterProp="label"
        disabled={objectFieldDisabled}
      />
      <Select
        style={{ width: 190 }}
        allowClear
        placeholder="Все типы заявок"
        options={requestTypeOptions}
        value={params.requestType}
        onChange={(v: string | undefined) => applyFilter({ requestType: v })}
      />
      <Select
        style={{ width: 150 }}
        allowClear
        placeholder="Все статусы"
        options={statusOptions}
        value={params.status}
        onChange={(v: string | undefined) => applyFilter({ status: v })}
      />
      <Select
        style={{ width: 200 }}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Контейнер / машина"
        options={subjectFilterOptions}
        value={params.containerTypeId}
        onChange={(v: string | undefined) => applyFilter({ containerTypeId: v })}
      />
      {/* Оператора выбирает тот, кто назначает исполнителя; самому оператору фильтр не нужен —
          в его списке все заявки и так его (ADR 0010). */}
      {canAssignOperator && (
        <Select
          style={{ width: 200 }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все операторы"
          options={(operatorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
          value={params.operatorCounterpartyId}
          onChange={(v: string | undefined) => applyFilter({ operatorCounterpartyId: v })}
        />
      )}
      <Input
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={numInput}
        onChange={(e) => applyNumFilter(e.target.value)}
      />
    </Space>
  );

  /**
   * Те же фильтры описаниями — для шита на телефоне (ADR 0030). Панель выше остаётся панелью:
   * на десктопе она вся на виду, и собирать её из описаний было бы переписыванием ради
   * единообразия. Значения и обработчики здесь общие с ней — расходиться нечему.
   */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: objectFilter || undefined,
      options: objectOptions,
      placeholder: 'Все объекты',
      loading: objectsLoading,
      // С одним объектом фильтр показан, но не меняется; с несколькими — выбор из своих.
      disabled: objectFieldDisabled,
      onChange: (v) => applyObjectFilter(v ?? ''),
    },
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: params.requestType,
      options: requestTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: (v) => applyFilter({ requestType: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => applyFilter({ status: v }),
    },
    {
      kind: 'select',
      key: 'containerTypeId',
      label: 'Контейнер / машина',
      value: params.containerTypeId,
      options: subjectFilterOptions,
      placeholder: 'Любой',
      onChange: (v) => applyFilter({ containerTypeId: v }),
    },
    ...(canAssignOperator
      ? [
          {
            kind: 'select' as const,
            key: 'operatorCounterpartyId',
            label: 'Оператор вывоза',
            value: params.operatorCounterpartyId,
            options: (operatorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            placeholder: 'Все операторы',
            loading: operatorsLoading,
            onChange: (v: string | undefined) => applyFilter({ operatorCounterpartyId: v }),
          },
        ]
      : []),
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: numInput || undefined,
      placeholder: 'Например, М-128',
      onChange: (v) => applyNumFilter(v ?? ''),
    },
  ];

  /**
   * Строка списка на телефоне (ADR 0030). Читают её сверху вниз: что за заявка и в каком она
   * статусе, на каком объекте, что и почём вывозим, когда и кем. Действия — списком с подписями:
   * иконки с подсказками на касании молчат.
   */
  const card: CardConfig<WasteRequestDto> = {
    title: (r) => `№ ${r.displayNumber}`,
    badge: (r) => <StatusCell r={r} />,
    primary: (r) => r.objectName,
    lines: [
      (r) => requestTypeLabels[r.requestType],
      (r) => [requestSubject(r), r.wasteTypeName].filter(Boolean).join(' · '),
      (r) => {
        // Незаданный тариф на телефоне называется тем же текстом, что и в таблице (ADR 0046):
        // цветом строки карточка не располагает, но молчать о непосчитанной сумме нельзя.
        const amountLine = wasteAmountLine(r);
        return amountLine?.text ?? null;
      },
      (r) => `Доставка: ${formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified)}`,
      // Оператору исполнителя не показываем: в его списке все заявки и так его (ADR 0010).
      (r) => (isOperator ? null : r.operatorName ? `Оператор: ${r.operatorName}` : null),
      // На десктопе причина отмены живёт подсказкой на теге статуса; на телефоне подсказок нет.
      (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
      (r) => r.comment || null,
      (r) => (r.files.length > 0 ? <FilesCell files={r.files} /> : null),
      (r) => (r.deletedAt ? <Tag>в архиве</Tag> : null),
    ],
    onOpen: (r) => setViewRecord(r),
    actions: (r) => {
      const view = {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      };
      if (r.deletedAt) {
        return canRestore
          ? [
              view,
              {
                key: 'restore',
                label: 'Восстановить',
                icon: <ReloadOutlined />,
                onClick: () => restoreMut.mutate(r.id),
              },
            ]
          : [view];
      }
      if (!canEdit && !canDelete) return [view];
      const allowed = canModify(r);
      return [
        view,
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
        canCreate ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Создать заявку
          </Button>
        ) : null
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          // Подписи там, где заголовок колонки — разметка в две строки.
          options: sortOptionsFrom(columns, { createdAt: 'Дата создания', num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
      }}
    >
      {/* Сводка — на уровне вкладок, над фильтрами и кнопкой: она относится ко всему списку,
          а не к панели инструментов, и там не отнимает высоту у таблицы. */}
      <TabsExtra tabKey="requests">
        <SummaryBar title="Заявок" items={summaryItems} />
      </TabsExtra>

      <DataTable<WasteRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <WasteRequestViewModal
        request={viewRecord}
        onClose={() => setViewRecord(null)}
        onEdit={
          viewRecord && canModify(viewRecord)
            ? (r) => {
                setViewRecord(null);
                openEdit(r);
              }
            : undefined
        }
      />

      {/* Назначение оператора вывоза при переводе заявки в работу: исполнитель обязателен —
          именно по нему заявка попадает в список своего оператора (ADR 0010). */}
      <FormModal
        title="Назначение оператора вывоза мусора"
        open={!!operatorTarget}
        onCancel={() => setOperatorTarget(null)}
        onSubmit={() => operatorForm.submit()}
        confirmLoading={startWorkMut.isPending}
        okText="В работу"
        // Поле одно, колонок здесь не нужно — окно просто перестаёт быть тесным: подпись
        // оператора и подсказка под ней в 480 px переносились по слогам.
        width={640}
      >
        <Form
          form={operatorForm}
          layout="vertical"
          onFinish={(v: { operatorCounterpartyId: string }) =>
            operatorTarget &&
            startWorkMut.mutate({
              r: operatorTarget,
              operatorCounterpartyId: v.operatorCounterpartyId,
            })
          }
        >
          <Form.Item
            name="operatorCounterpartyId"
            label="Оператор вывоза"
            rules={[{ required: true, message: 'Выберите оператора' }]}
            extra={
              assignOperatorOptions.length === 0
                ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                : 'Оператор увидит заявку в своём списке и сможет отметить её выполненной'
            }
          >
            <AutoSelect
              options={assignOperatorOptions}
              loading={operatorsLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        </Form>
      </FormModal>

      {/* Закрытие заявки: предъявление факта и комментарий уходят вместе со статусом. Вывоз
          мусора отчитывается фактическим объёмом и стоимостью (ADR 0035), контейнерные операции —
          одним талоном (ADR 0013); талон обязателен в обоих случаях (ADR 0020), а расхождение
          с заявленным объёмом — подсказка: сохранению оно не мешает. */}
      <WasteDoneModal
        request={doneTarget}
        confirmLoading={statusMut.isPending}
        onCancel={() => setDoneTarget(null)}
        onSubmit={(v) =>
          doneTarget &&
          statusMut.mutate({
            id: doneTarget.id,
            status: 'done',
            version: doneTarget.version,
            comment: v.comment,
            completion: v.completion ?? undefined,
            ticketFileIds: v.ticketFileIds,
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

      <FormModal
        title={record ? 'Редактирование заявки' : 'Новая заявка'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={880}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          // Смена объекта может сделать выбранного исполнителя недопустимым — снимаем его сразу,
          // а не отказом сервера при сохранении.
          onValuesChange={(changed: Partial<RequestFormValues>) => {
            if (!changed.objectId) return;
            const selected = form.getFieldValue('operatorCounterpartyId') as string | undefined;
            const allowed = operatorOptionsFor(changed.objectId);
            if (selected && !allowed.some((o) => o.value === selected)) {
              form.setFieldValue('operatorCounterpartyId', undefined);
            }
          }}
        >
          {/* Поля парами (FormGrid): узкое окно прятало половину формы под прокрутку, хотя
              справа было пусто. На телефоне колонка одна, порядок полей тот же. */}
          <FormGrid>
          <Form.Item
            name="objectId"
            label="Объект строительства"
            rules={[{ required: true, message: 'Выберите объект' }]}
          >
            <AutoSelect
              options={objectOptions}
              loading={objectsLoading}
              showSearch
              optionFilterProp="label"
              disabled={objectFieldDisabled}
              onChange={handleObjectChange}
            />
          </Form.Item>
          <Form.Item
            name="requestType"
            label="Тип заявки"
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <AutoSelect
              options={requestTypeOptions}
              placeholder={watchObjectId ? 'Выберите тип заявки' : 'Сначала выберите объект'}
              disabled={!watchObjectId}
              onChange={handleRequestTypeChange}
            />
          </Form.Item>

          {watchRequestType === 'container_install' && (
            <Form.Item
              name="containerTypeId"
              label="Тип контейнера"
              rules={[{ required: true, message: 'Выберите тип контейнера' }]}
            >
              <AutoSelect
                // Выключенный в справочнике тип остаётся видимым у уже заведённой заявки.
                options={withSavedOption(contTypeOptions, savedContainerType)}
                loading={typesLoading}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          )}

          {/* Вывоз мусора: что вывозим и сколько — весь предмет заявки. Техники в ней нет
              (ADR 0022): чем увезут объём, решает оператор и показывает машинами при закрытии.
              Поля стоимости тоже нет — цену даёт прайс по типу мусора, и расчёт виден подсказкой
              под полями (ADR 0009). У замены и снятия этих полей нет вовсе: они не
              тарифицируются (ADR 0019), в форме остаётся только контейнер с объекта. */}
          {isPriced && (
            // Соседние ячейки сетки: «что вывозим» и «сколько» читаются парой.
            <>
              <Form.Item
                name="wasteTypeId"
                label="Тип мусора"
                rules={[{ required: true, message: 'Выберите тип мусора' }]}
              >
                <AutoSelect
                  options={formWasteTypeOptions}
                  loading={wasteTypesLoading}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Что вывозим"
                />
              </Form.Item>
              <Form.Item
                name="volumeM3"
                label="Объём, м³"
                rules={[
                  { required: true, message: 'Укажите объём' },
                  {
                    type: 'number',
                    min: MIN_WASTE_VOLUME_M3,
                    message: `Не менее ${MIN_WASTE_VOLUME_M3} м³`,
                  },
                  {
                    // Тариф «за контейнер» тарифицирует контейнер целиком: половину не вывозят.
                    validator: (_rule, v: number | undefined) =>
                      v == null || isVolumeAllowed(v, volumeStepM3)
                        ? Promise.resolve()
                        : Promise.reject(new Error(volumeStepMessage(volumeStepM3!))),
                  },
                ]}
              >
                <InputNumber
                  min={MIN_WASTE_VOLUME_M3}
                  step={volumeStepM3 ?? 1}
                  // Заявленный объём — целое (в БД integer): дробное значение сервер отвергал
                  // бы валидацией уже после отправки формы.
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder={volumeStepM3 ? `Кратно ${volumeStepM3}` : 'Например, 20'}
                />
              </Form.Item>
            </>
          )}
          {pricingHint && (
            // Расчёт по прайсу относится к паре «тип мусора — объём» целиком, поэтому идёт
            // строкой во всю ширину, а не подписью под одним из полей.
            <FormGrid.Full>
              <div style={{ marginTop: -16, marginBottom: 24 }}>
                <Typography.Text type={pricingHint.tone}>{pricingHint.text}</Typography.Text>
              </div>
            </FormGrid.Full>
          )}
          {subjectField && (
            <Form.Item
              name="containerTypeId"
              label={subjectField.label}
              rules={[{ required: true, message: subjectField.message }]}
              extra={!objectHasPresent ? 'На объекте нет контейнеров' : undefined}
            >
              <AutoSelect
                options={subjectField.options}
                loading={subjectField.loading}
                showSearch
                optionFilterProp="label"
                placeholder={subjectField.placeholder}
                notFoundContent="Нет контейнеров на объекте"
              />
            </Form.Item>
          )}
          {/* Исполнителя выбирают у уже заведённой заявки: при создании его чаще всего ещё не
              знают, и лишнее поле в форме отвлекало бы. Новой заявке оператора назначают
              отдельным действием списка или при переводе в работу. */}
          {canAssignOperator && record && (
            <Form.Item
              name="operatorCounterpartyId"
              label="Оператор вывоза"
              tooltip="Контрагент, который выполняет заявку; он увидит её в своём списке"
              extra={
                formOperatorOptions.length === 0
                  ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                  : undefined
              }
            >
              <Select
                options={formOperatorOptions}
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Можно назначить позже"
              />
            </Form.Item>
          )}
          <>
            <Form.Item
              name="deliveryDate"
              label="Дата доставки"
              rules={[{ required: true, message: 'Укажите дату' }]}
            >
              {/* Новую заявку — не раньше чем на сегодня (по МСК); у заведённой дата правится
                  свободно, лишь бы не в прошлое. */}
              <DatePicker
                format="DD.MM.YYYY"
                style={{ width: '100%' }}
                placeholder="дд.мм.гггг"
                // На телефоне календарь открывается вместе с клавиатурой и прячется за ней:
                // дату там выбирают, а не набирают.
                inputReadOnly={isMobile}
                disabledDate={record ? isPastDate : isBeforeMinRequestDate}
              />
            </Form.Item>
            <Form.Item
              name="deliveryTime"
              label="Время"
              tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
              rules={[optionalWorkTimeRule]}
            >
              <TimeInput />
            </Form.Item>
          </>
          {/* Кто принимает машину на площадке: оператор приезжает к человеку, а не к адресу —
              без контакта место установки и подъезд выясняются уже на месте. */}
          <FormGrid.Full>
            <ResponsibleFields
              nameField="responsibleName"
              phoneField="responsiblePhone"
              nameLabel="Ответственный на площадке"
              phoneLabel="Контактный телефон"
            />
            <Form.Item name="comment" label="Комментарий">
              <Input.TextArea rows={3} maxLength={2000} showCount />
            </Form.Item>
          </FormGrid.Full>

          {/* Факта выполнения в форме правки нет: сколько вывезли и во сколько это обошлось,
              вводят при закрытии заявки — там же, где виден расчёт по прайсу (ADR 0035). Правят
              его повторным закрытием, после отката администратором. Состав техники прошлых
              закрытий виден в карточке заявки, в истории её выполнения. */}

          <FormGrid.Full>
          <Form.Item label={`Файлы (до ${FILE_MAX_COUNT}, до 50 МБ каждый)`}>
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={(file) => {
                if (files.length >= FILE_MAX_COUNT) {
                  message.warning(`Не более ${FILE_MAX_COUNT} файлов`);
                  return Upload.LIST_IGNORE;
                }
                if (file.size > FILE_MAX_SIZE) {
                  message.warning('Файл больше 50 МБ');
                  return Upload.LIST_IGNORE;
                }
                void handleUpload(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploading}>
                Прикрепить файл
              </Button>
            </Upload>
            <div style={{ marginTop: 8 }}>
              <FileLinkList
                files={files}
                emptyText="Файлы не прикреплены"
                maxNameWidth={300}
                onRemove={(f) => void removeFile(f)}
              />
            </div>
          </Form.Item>
          </FormGrid.Full>
          </FormGrid>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
