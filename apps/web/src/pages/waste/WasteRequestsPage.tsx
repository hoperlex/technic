import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Select,
  Typography,
  Upload,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import {
  MIN_WASTE_VOLUME_M3,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  statusChangeRequiresReason,
  transitionResetsWork,
  requestTypeLabels,
  roleScopeAxis,
  normalizeTimeInput,
  type CompleteWasteRequestInput,
  actsForCounterparty,
  checkContainerOwner,
  FOREIGN_CONTAINER_SPLIT_MESSAGE,
  isPlaceScopedRole,
  isPricedRequestType,
  presentGroupLabel,
  usesContainerGroup,
  isVolumeAllowed,
  volumeStepMessage,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
  wasteOperatorCommentEditable,
  wasteTicketsAttachable,
} from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { FileLinkList, filesApi } from '@entities/file';
import {
  isBeforeMinRequestDate,
  isPastDate,
  minRequestDate,
  wastePricingHint,
  wasteRollbackErases,
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '@entities/waste-request';
import { useAuth } from '@entities/session';
import { wasteTicketKeys } from '@entities/waste-ticket';
import { AutoSelect } from '@shared/ui';
import { PhoneInput } from '@entities/user-account';
import { CancelReasonModal, ResponsibleFields, RollbackReasonModal } from '@entities/request';
import { FormGrid } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { PageTabs, useActiveTabKey } from '@shared/ui';
import { TimeInput, optionalWorkTimeRule } from '@entities/request';
import { useIsMobile } from '@shared/lib';
import { useOpenedRecord } from '@shared/lib';
import { TicketAuditModal } from '@features/ticket-audit';
import { usePlaceObjectScope } from '@entities/session';
import { withSavedOption } from '@shared/lib';
import { WasteRequestFeed } from '@widgets/waste-request-feed';
import { OnSiteTab } from './OnSiteTab';
import { WasteArchiveTab } from './WasteArchiveTab';
import { WasteHistoryTab } from './WasteHistoryTab';
import {
  containerGroupKey,
  containerGroupOptions,
  findContainerGroup,
  parseContainerGroupKey,
  presentGroupsHint,
} from './containerGroups';
import { BlindCheckQueue } from '@features/waste-ticket-review';
import { WasteDoneModal } from './WasteDoneModal';
import { WasteRequestViewModal } from './WasteRequestViewModal';
import { WasteStatsTab } from './WasteStatsTab';
import { MOSCOW_TZ } from '@shared/config';
import { objectFilterOptionLabel, objectsApi, objectKeys } from '@entities/object';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { wasteTypeOptionsQuery } from '@entities/waste-type';
import { wasteTariffResolveQuery } from '@entities/waste-tariff';

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
  /**
   * Какой контейнер снимаем или меняем — группа присутствия «тип + владелец» одним значением
   * (ADR 0054). У установки поля нет: она привозит свой контейнер и выбирает тип из справочника.
   */
  containerGroupKey?: string;
  containersCount?: number;
  /** Подтверждение вывоза чужого контейнера — причиной; появляется только при расхождении. */
  ownerMismatchReason?: string;
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

const TABS = ['requests', 'on-site', 'history', 'blind-check', 'archive', 'stats'] as const;

export function WasteRequestsPage() {
  // Вкладки управляемые: виджет сводки живёт в строке вкладок и показывается только на «Заявках».
  const [sp, setSp] = useSearchParams();
  const { can, user } = useAuth();
  /**
   * «Архив» — удалённые заявки (ADR 0070): по матрице прав это только администратор. Спрашивается
   * право, а не имя роли: тем же правом закрыта выдача архива на сервере, и разойтись они не
   * должны — иначе вкладка либо ведёт в пустой список, либо прячет доступное.
   */
  const showArchive = can('archive.read');
  // «Перепроверка» — работа второго человека (ADR 0114, Р31), а не разбор своей заявки: он читает
  // талон, не видя ни распознанного, ни подтверждённого. Вкладкой здесь, а не отдельным разделом:
  // область та же и право то же, а приходят за ней редко — доля выборки считается процентами.
  const showBlindCheck = can('wasteRequests.ticketReview');
  // Аудит распознавания (ADR 0137) — не вкладка, а окно поверх реестра: право сильное и редкое,
  // а место размещения временное. Окно смонтировано здесь, над вкладками: ссылка `?ticketAudit=1`
  // приходит с любой из них, а внутри вкладки оно открылось бы только на своей.
  const canTicketAudit = can('wasteRequests.ticketAudit');
  /**
   * «Статистика» (план `docs/waste-stats-tab-plan.md`) — свод площадок за месяц. Право то же, что
   * у списка (Р8), а круг читателей уже: исполнителю вывоза и кабинету работника вкладка не
   * отвечает вовсе (Р7) — свод чужих площадок по своим рейсам не их сведения. Спрашивается ОСЬ
   * роли, тем же предикатом, которым отказывает сервер: разойдись эти две проверки, вкладка вела
   * бы в отказ.
   */
  const statsAxis = roleScopeAxis(user?.role ?? null);
  const showStats = statsAxis !== 'counterparty' && statsAxis !== 'person';
  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
    // «История» (ADR 0135) — журнал завершённых и отменённых заявок. Открыта всем, кто видит сам
    // модуль: закрытая заявка — это те же сведения, что и работающая, только по ним уже нечего
    // решать; сервер сужает выдачу той же областью, что и в списке.
    { key: 'history', label: 'История', children: <WasteHistoryTab /> },
    ...(showBlindCheck
      ? [{ key: 'blind-check', label: 'Перепроверка', children: <BlindCheckQueue /> }]
      : []),
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <WasteArchiveTab /> }] : []),
    // Последней, а не рядом с «Историей»: первые вкладки — работа с заявками, за ними в раздел и
    // приходят. Вкладка, вставленная в середину, сдвинула бы привычные, а не добавилась к ним.
    ...(showStats ? [{ key: 'stats', label: 'Статистика', children: <WasteStatsTab /> }] : []),
  ];

  const raw = sp.get('tab') ?? '';
  // Ссылка на скрытую вкладку ведёт в список, а не в пустоту: адрес переживает смену роли.
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <TicketAuditModal allowed={canTicketAudit} />
      <PageTabs
        activeKey={tab}
        // Переключение вкладки руками закрывает карточку, открытую по ссылке: адрес остаётся с
        // одним параметром `tab`, а `open` из него уходит.
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={wasteRequestKeys.root}
        items={items}
      />
    </div>
  );
}

function RequestsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const { user, can } = useAuth();
  // Область видимости («свои объекты», «свои заявки»), а не право: от неё зависит, что показывать
  // в фильтрах и колонках, а не что разрешено делать. У роли отдела объекты производны — это
  // площадка её отдела (ADR 0062), и спрашивается она хуком этого модуля, а не общим.
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = usePlaceObjectScope();
  // «Оператор вывоза» — это роль исполнителя плюс контрагент-оператор (ADR 0038): по одной роли
  // такой вывод уже неверен, ею же работает арендодатель техники в другом разделе.
  const isOperator = actsForCounterparty(user, 'operator');
  // Действия — только по правам (ADR 0021): те же, что проверяет API.
  const canCreate = can('wasteRequests.create');
  const canEdit = can('wasteRequests.update');
  const canDelete = can('wasteRequests.delete');
  const canAssignOperator = can('wasteRequests.assignOperator');
  // Примечание исполнителя (ADR 0053): пишут его оператор и те, кто ведёт заявку.
  const canOperatorComment = can('wasteRequests.operatorComment');
  // Ведение статусов: им же отпирается догрузка талонов к выполненной заявке (ADR 0189) — бумагу
  // приносит тот, кто закрывает, и отдельного права у неё нет.
  const canChangeStatus = can('wasteRequests.status');
  const canRestore = can('archive.restore');

  // Объектной роли с одним объектом фильтр зафиксирован на нём; с несколькими — фильтр открыт,
  // но сужен до своих (ADR 0039), а «все» означает все свои: остального сервер не отдаёт.
  const ownObjectId = soleObjectId ?? '';

  // Разбор талонов — отдельное право (ADR 0114, Р25): без него нет ни колонки-значка, ни фильтра.
  // Сервер отвечает так же: параметр `ticketReview` без права отклоняется, а не игнорируется.
  const canReviewTickets = can('wasteRequests.ticketReview');
  const canAuditTickets = can('wasteRequests.ticketAudit');

  // isLoading у списков нужен полям формы: обязательное поле с единственным вариантом
  // заполняет себя само, и подставлять по недогруженному списку нельзя.
  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  // Справочник берётся целиком и раскладывается по видам ниже: заявке нужны и контейнеры, и
  // самосвалы, а второй запрос за тем же ответом только удлинил бы первый экран.
  const { data: types, isLoading: typesLoading } = useQuery(
    containerTypeOptionsQuery({ activeOnly: true }),
  );
  const objectOptions = limitObjectOptions(
    (objects?.items ?? []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.name}`,
    })),
  );
  // Фильтр списка называет площадку ещё и адресом: заявки ищут «что было на Ленина, 14» не реже,
  // чем по названию объекта, — и по нему же работает поиск в поле. В форме заявки подпись прежняя:
  // там площадку не ищут, а выбирают свою, и третий кусок строки только удлинял бы список.
  const objectFilterOptions = limitObjectOptions(
    (objects?.items ?? []).map((o) => ({ value: o.id, label: objectFilterOptionLabel(o) })),
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

  // Типы мусора — только для вывоза (ADR 0019). Спрашиваются
  // только типы с действующей ценой (ADR 0017): выбор типа без тарифа кончался бы отказом
  // «тариф не найден» уже при сохранении заявки.
  const { data: wasteTypes, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: true }),
  );
  const wasteTypeOptions = (wasteTypes?.items ?? []).map((w) => ({ value: w.id, label: w.name }));

  // Операторы вывоза — контрагенты соответствующего типа (ADR 0010). Оператору этот список
  // не нужен: исполнителя он не выбирает.
  const { data: operatorsData, isLoading: operatorsLoading } = useQuery({
    queryKey: counterpartyKeys.activeOperatorOptions(),
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
  /** Фильтр списка спрашивает исполнителя без оглядки на объект: заявки ищут и по обоим сразу. */
  const operatorOptions = (operatorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name }));
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
  /** Чем открыта карточка: `tickets` — крестиком колонки «Талоны» (ADR 0195), окно едет к разбору. */
  const [viewFocus, setViewFocus] = useState<'tickets' | null>(null);

  /**
   * Заявка, названная в адресе: сюда приходят по ссылке из списка площадок («№ заявки установки»).
   * Спрашивается по идентификатору — та же заявка может лежать на другой странице списка или под
   * другим фильтром, и искать её в загруженном списке значило бы открывать карточку через раз.
   */
  const opened = useOpenedRecord<WasteRequestDto>({
    active: useActiveTabKey() === 'requests',
    queryKey: (id) => wasteRequestKeys.detail(id),
    fetch: (id) => wasteRequestsApi.get(id),
  });
  const viewed = viewRecord ?? opened.record;
  const closeView = () => {
    setViewRecord(null);
    // Иначе следующее открытие кликом по строке, за другим делом, снова уехало бы к талонам.
    setViewFocus(null);
    opened.clear();
  };
  const openTicketReview = (r: WasteRequestDto) => {
    setViewRecord(r);
    setViewFocus('tickets');
  };

  const [form] = Form.useForm<RequestFormValues>();
  const blockers = useFormBlockers(form, {
    // Смена объекта может сделать выбранного исполнителя недопустимым — снимаем его сразу,
    // а не отказом сервера при сохранении.
    onValuesChange: (changed: Partial<RequestFormValues>) => {
      if (!changed.objectId) return;
      const selected = form.getFieldValue('operatorCounterpartyId') as string | undefined;
      const allowed = operatorOptionsFor(changed.objectId);
      if (selected && !allowed.some((o) => o.value === selected)) {
        form.setFieldValue('operatorCounterpartyId', undefined);
      }
    },
  });
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
    ...wasteTariffResolveQuery({
      wasteTypeId: watchWasteTypeId,
      target: { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
      operatorCounterpartyId: watchOperatorId,
    }),
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

  // Что и чьё стоит на объекте (ADR 0054): группы присутствия. Ими выбирают контейнер для
  // замены и снятия, ими же считается потолок количества и подсказка «кого звать».
  const { data: presentGroups, isLoading: presentLoading } = useQuery({
    queryKey: wasteRequestKeys.presentGroups(watchObjectId),
    queryFn: () => wasteRequestsApi.presentGroups(watchObjectId),
    enabled: !!watchObjectId,
  });
  const groups = presentGroups ?? [];
  const objectHasPresent = groups.length > 0;

  const watchGroupKey = Form.useWatch('containerGroupKey', form);
  const selectedGroup = findContainerGroup(groups, watchGroupKey);
  // Сколько единиц можно указать: сверх стоящего на объекте снимать нечего. Правимая заявка
  // свои единицы из присутствия уже вычла, поэтому её собственное количество к потолку
  // прибавляется — тем же счётом, что и на сервере.
  const savedGroupKey = record?.containerTypeId
    ? containerGroupKey({
        containerTypeId: record.containerTypeId,
        ownerCounterpartyId: record.containerOwnerCounterpartyId,
      })
    : undefined;
  const ownContribution =
    record?.requestType === 'container_removal' && watchGroupKey === savedGroupKey
      ? record.containersCount
      : 0;
  const maxContainers = Math.max(1, (selectedGroup?.quantity ?? 1) + ownContribution);

  // Чем оперирует заявка: у замены и снятия выбор ограничен контейнерами, которые сейчас стоят
  // на объекте. У вывоза техники нет вовсе (ADR 0022) — заказывают объём, а чем его увезут,
  // решает оператор и показывает машинами при закрытии.
  const fromObjectField = {
    // Присутствие считается по объекту, а выбор заявки в нём мог и не остаться — его добавляем
    // отдельно. Подпись «На объекте нет контейнеров» при этом остаётся честной: она о самом
    // объекте, а не о том, что стоит в правимой заявке.
    options: withSavedOption(containerGroupOptions(groups), {
      id: savedGroupKey,
      name: savedContainerType.name
        ? presentGroupLabel({
            containerTypeName: savedContainerType.name,
            ownerName: record?.containerOwnerName ?? null,
            quantity: record?.containersCount ?? 1,
          })
        : undefined,
    }),
    loading: presentLoading,
    placeholder: 'Контейнер, стоящий на объекте',
  };
  const subjectFieldByType = {
    container_replace: {
      label: 'Заменяемый контейнер',
      message: 'Выберите контейнер для замены',
      countLabel: 'Сколько заменить',
      ...fromObjectField,
    },
    container_removal: {
      label: 'Снимаемый контейнер',
      message: 'Выберите контейнер для снятия',
      countLabel: 'Сколько снять',
      ...fromObjectField,
    },
  } as const;
  const subjectField =
    watchRequestType === 'container_replace' || watchRequestType === 'container_removal'
      ? subjectFieldByType[watchRequestType]
      : null;

  // Вывозит тот, кто привёз (ADR 0054). Форма считает расхождение тем же правилом, что и
  // сервер: предупредить до отправки лучше, чем показать отказ после.
  const ownerVerdict = watchRequestType
    ? checkContainerOwner(
        {
          requestType: watchRequestType,
          operatorCounterpartyId: watchOperatorId ?? null,
          containerOwnerCounterpartyId: selectedGroup?.ownerCounterpartyId ?? null,
        },
        false,
      )
    : 'ok';

  const openCreate = () => {
    setRecord(null);
    setFiles([]);
    setRemovedIds([]);
    form.resetFields();
    // Дата доставки по умолчанию — сегодня: раньше заявку не заводят (правило в контрактах).
    // Количество — один контейнер: снимают чаще всего его, и заставлять набирать «1» незачем.
    form.setFieldsValue({
      deliveryDate: minRequestDate(),
      containersCount: 1,
    } as Partial<RequestFormValues>);
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
      // Замена и снятие выбирают контейнер группой; у установки поля группы нет вовсе.
      containerGroupKey:
        usesContainerGroup(r.requestType) && r.containerTypeId
          ? containerGroupKey({
              containerTypeId: r.containerTypeId,
              ownerCounterpartyId: r.containerOwnerCounterpartyId,
            })
          : undefined,
      containersCount: r.containersCount,
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

  const handleRequestTypeChange = () => {
    form.setFieldsValue({
      containerTypeId: undefined,
      containerGroupKey: undefined,
      // Количество возвращается к одному контейнеру: «3» от прежнего типа заявки к новому
      // отношения не имеет, а у установки и вывоза его не бывает вовсе.
      containersCount: 1,
      ownerMismatchReason: undefined,
      wasteTypeId: undefined,
      volumeM3: undefined,
    });
  };
  // Смена объекта сбрасывает контейнер: и справочный тип, и группа зависят от площадки.
  const handleObjectChange = () => {
    form.setFieldsValue({
      containerTypeId: undefined,
      containerGroupKey: undefined,
      containersCount: 1,
      ownerMismatchReason: undefined,
    });
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
      // Замена и снятие выбирают контейнер группой «тип + владелец» (ADR 0054); установка —
      // типом из справочника, и группы у неё нет.
      const group = values.containerGroupKey
        ? parseContainerGroupKey(values.containerGroupKey)
        : null;
      const withGroup = usesContainerGroup(values.requestType);
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        // Тип из справочника несут только контейнерные операции: у вывоза поля в форме нет,
        // и присланное значение сервер всё равно обнулит (ADR 0022).
        containerTypeId: withGroup ? group?.containerTypeId : values.containerTypeId,
        containerOwnerCounterpartyId: withGroup
          ? (group?.ownerCounterpartyId ?? undefined)
          : undefined,
        containersCount: withGroup ? (values.containersCount ?? 1) : 1,
        // Причина уходит только вместе с расхождением: у совпавших сторон её поля в форме нет.
        ownerMismatchReason: withGroup ? values.ownerMismatchReason : undefined,
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
          // У правки «не прислали» означает «не трогали», поэтому группа без владельца и смена
          // типа заявки шлют явный null: иначе владелец пережил бы тип, у которого его не бывает.
          containerOwnerCounterpartyId: withGroup ? (group?.ownerCounterpartyId ?? null) : null,
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
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      setOpen(false);
    },
    onError: (e) => {
      // Ошибку валидации показываем на самом поле: тост «Ошибка валидации данных» не говорит,
      // что именно править. `deliveryAt` в форме разложен на дату и время — правим дату.
      if (!blockers.fromApi(e, { deliveryAt: 'deliveryDate' })) message.error(errorMessage(e));
    },
  });

  // Переход в работу и отмена проходят через модальные окна — оба требуют ввода
  // (оператор вывоза, причина отмены), поэтому целевая заявка хранится в состоянии.
  const [operatorTarget, setOperatorTarget] = useState<WasteRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WasteRequestDto | null>(null);
  /**
   * Заявка, которую возвращают из работы в «Новую» (`transitionResetsWork`). Отдельным состоянием
   * от отмены: окно причины у них одно, а перечень стираемого — свой, и по одному состоянию окно
   * не отличило бы возврат от отмены.
   */
  const [rollbackTarget, setRollbackTarget] = useState<WasteRequestDto | null>(null);
  const [operatorForm] = Form.useForm<{
    operatorCounterpartyId: string;
    ownerMismatchReason?: string;
  }>();
  // Список в модальном окне назначения сужается по объекту той заявки, которую переводят в работу.
  const assignOperatorOptions = operatorOptionsFor(operatorTarget?.objectId, {
    id: operatorTarget?.operatorCounterpartyId ?? null,
    name: operatorTarget?.operatorName ?? null,
  });
  // Что стоит на площадке, которой касается назначение: подсказка «кого звать» и основание для
  // предупреждения о чужом контейнере (ADR 0054). Запрос тот же, что у формы, — и кэш общий.
  const { data: targetGroups } = useQuery({
    queryKey: wasteRequestKeys.presentGroups(operatorTarget?.objectId),
    queryFn: () => wasteRequestsApi.presentGroups(operatorTarget!.objectId),
    enabled: !!operatorTarget,
  });
  const assignOperatorId = Form.useWatch('operatorCounterpartyId', operatorForm);
  const assignVerdict = operatorTarget
    ? checkContainerOwner(
        { ...operatorTarget, operatorCounterpartyId: assignOperatorId ?? null },
        false,
      )
    : 'ok';

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
      setRollbackTarget(null);
      setDoneTarget(null);
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      // Rollback to "new" erases the tickets with their pages and accepted mismatches in the same
      // transaction as the status (`purgeRequestRecognition`) — under their own root, so without
      // this the card keeps listing them and offering actions on rows that no longer exist.
      void qc.invalidateQueries({ queryKey: wasteTicketKeys.root });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });

  /**
   * Перевод в работу назначает исполнителя: с этого момента заявку видит оператор, который её
   * выполняет (ADR 0010). Два запроса подряд — назначение меняет версию заявки, поэтому статус
   * переводится уже по обновлённой версии.
   */
  const startWorkMut = useMutation({
    mutationFn: async (v: {
      r: WasteRequestDto;
      operatorCounterpartyId: string;
      ownerMismatchReason?: string;
    }) => {
      const assigned = await wasteRequestsApi.assignOperator(
        v.r.id,
        v.operatorCounterpartyId,
        v.r.version,
        v.ownerMismatchReason,
      );
      return wasteRequestsApi.changeStatus(assigned.id, 'confirmed', assigned.version);
    },
    onSuccess: () => {
      setOperatorTarget(null);
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });

  /**
   * Перевод в работу — через назначение оператора вывоза; закрытие — через окно предъявления
   * факта (машины у вывоза мусора, талоны у контейнерных операций) и комментария; отмена и
   * возврат в «Новую» — через обязательную причину. Остальные откаты выполняются сразу: они
   * ничего не стирают, и объяснять там нечего.
   */
  const requestStatusChange = (r: WasteRequestDto, status: RequestStatus) => {
    // Возврат из работы в «Новую» стирает нажитое в работе (`transitionResetsWork`) — факт и
    // талоны вывоза. Причину он спрашивает тем же окном, что отмена, но перечисляет над полем,
    // что именно потеряет эта заявка: после нажатия восстанавливать будет нечего.
    if (transitionResetsWork(r.status, status)) {
      setRollbackTarget(r);
      return;
    }
    if (statusChangeRequiresReason(status, r.status)) {
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

  /**
   * Примечание исполнителя (ADR 0053). Карточка живёт строкой списка, поэтому сохранённая заявка
   * возвращается в неё сразу: иначе в открытом окне осталась бы прежняя версия, и вторая правка
   * подряд упёрлась бы в конфликт версий.
   */
  const operatorCommentMut = useMutation({
    mutationFn: (v: { r: WasteRequestDto; text: string }) =>
      wasteRequestsApi.setOperatorComment(v.r.id, v.text, v.r.version),
    onSuccess: (updated) => {
      setViewRecord(updated);
      message.success('Комментарий сохранён');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });

  /**
   * Догрузка талонов к выполненной заявке (ADR 0189). Карточка живёт строкой списка, поэтому
   * обновлённая заявка возвращается в неё сразу: иначе в открытом окне остались бы прежняя версия
   * и прежний список бумаг, а вторая догрузка подряд упёрлась бы в конфликт версий.
   */
  const addTicketsMut = useMutation({
    mutationFn: (v: { r: WasteRequestDto; ticketFileIds: string[] }) =>
      wasteRequestsApi.addTickets(v.r.id, v.ticketFileIds, v.r.version),
    onSuccess: (updated, v) => {
      setViewRecord(updated);
      message.success(v.ticketFileIds.length === 1 ? 'Талон приложен' : 'Талоны приложены');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.remove(id),
    onSuccess: (res) => {
      message.success(res.mode === 'hard' ? 'Заявка удалена' : 'Заявка перемещена в архив');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const canModify = (r: WasteRequestDto): boolean => {
    if (r.deletedAt) return false;
    if (!canEdit && !canDelete) return false;
    // Заказчик правит заявку, пока её не взяли в работу: дальше за ней договорённости с
    // исполнителем. Предикат тот же, что у сервера (`assertObjectRoleEditable`), — правило про
    // заказчика, а не про площадку, и роль отдела на своей площадке под него тоже подпадает.
    if (isPlaceScopedRole(user?.role)) return r.status === 'new';
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

  return (
    <WasteRequestFeed
      actions={{
        canModify,
        changeStatus: requestStatusChange,
        create: openCreate,
        edit: openEdit,
        open: setViewRecord,
        openTicketReview,
        remove: confirmDelete,
        restore: (request) => restoreMut.mutate(request.id),
      }}
      pending={{
        statusRequestId:
          statusMut.isPending && statusMut.variables ? statusMut.variables.id : undefined,
      }}
      rights={{
        canAuditTickets,
        canCreate,
        canDelete,
        canEdit,
        canRestore,
        canReviewTickets,
        isOperator,
      }}
      sources={{
        initialObjectId: ownObjectId,
        objectFilterDisabled: objectFieldDisabled,
        objectOptions: objectFilterOptions,
        objectsLoading,
        subjectTypes: { cont: contTypeOptions, truck: truckTypeOptions },
        operators: canAssignOperator
          ? { options: operatorOptions, loading: operatorsLoading }
          : null,
      }}
    >
      {/* Карточка заявки: поля на чтение плюс история событий. Правка заявки — той же формой,
          что и из таблицы, и только если она этой роли доступна; примечание исполнителя
          (ADR 0053) правится прямо в карточке — у оператора формы правки нет вовсе. */}
      <WasteRequestViewModal
        request={viewed}
        focus={viewFocus}
        onClose={closeView}
        onEdit={
          viewed && canModify(viewed)
            ? (r) => {
                closeView();
                openEdit(r);
              }
            : undefined
        }
        onSaveOperatorComment={
          canOperatorComment &&
          viewed &&
          !viewed.deletedAt &&
          wasteOperatorCommentEditable(viewed.status)
            ? (r, text) => operatorCommentMut.mutate({ r, text })
            : undefined
        }
        savingOperatorComment={operatorCommentMut.isPending}
        // Бумага, не поспевшая к закрытию (ADR 0189): право то же, что у самого закрытия, окно
        // приёма считает предикат контрактов — тот же, которым сервер отвечает на запрос.
        onAddTickets={
          canChangeStatus && viewed && !viewed.deletedAt && wasteTicketsAttachable(viewed.status)
            ? (r, ticketFileIds) => addTicketsMut.mutate({ r, ticketFileIds })
            : undefined
        }
        addingTickets={addTicketsMut.isPending}
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
          onFinish={(v: { operatorCounterpartyId: string; ownerMismatchReason?: string }) =>
            operatorTarget &&
            startWorkMut.mutate({
              r: operatorTarget,
              operatorCounterpartyId: v.operatorCounterpartyId,
              ownerMismatchReason: v.ownerMismatchReason,
            })
          }
        >
          <Form.Item
            name="operatorCounterpartyId"
            label="Оператор вывоза"
            rules={[{ required: true, message: 'Выберите оператора' }]}
            // Контейнеры площадки — здесь же: назначение и есть тот момент, когда решают, кому
            // ехать, а «вывозит тот, кто привёз» — часть этого решения (ADR 0054).
            extra={
              assignOperatorOptions.length === 0
                ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                : presentGroupsHint(targetGroups ?? [])
            }
          >
            <AutoSelect
              options={assignOperatorOptions}
              loading={operatorsLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          {assignVerdict !== 'ok' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <Typography.Text type="warning">
                  {`Контейнер установил «${operatorTarget?.containerOwnerName ?? '—'}». `}
                  {assignVerdict === 'splitRequired'
                    ? FOREIGN_CONTAINER_SPLIT_MESSAGE
                    : 'Назначьте его либо объясните, почему вывозит другой оператор'}
                </Typography.Text>
              </div>
              {assignVerdict !== 'splitRequired' && (
                <Form.Item
                  name="ownerMismatchReason"
                  label="Причина вывоза чужого контейнера"
                  rules={[{ required: true, message: 'Укажите причину' }]}
                >
                  <Input.TextArea
                    rows={2}
                    maxLength={500}
                    placeholder="Например: контейнеры переданы по акту"
                  />
                </Form.Item>
              )}
            </>
          )}
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

      {/* Возврат в «Новую»: причина обязательна наравне с причиной отмены (её требует и сервер),
        а над полем — что заявка потеряет: факт и талоны вывоза этой самой заявки. */}
      <RollbackReasonModal
        open={!!rollbackTarget}
        subject={rollbackTarget ? `№ ${rollbackTarget.displayNumber}` : ''}
        erases={rollbackTarget ? wasteRollbackErases(rollbackTarget) : []}
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
          {...blockers.formProps}
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
            {/* Контейнер выбирается группой присутствия — типом вместе с владельцем (ADR 0054):
              на площадке могут стоять две одинаковых бочки от разных операторов, и тип без
              владельца на вопрос «какую снимаем» не отвечает. */}
            {subjectField && (
              <>
                <Form.Item
                  name="containerGroupKey"
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
                <Form.Item
                  name="containersCount"
                  label={subjectField.countLabel}
                  tooltip="Одной заявкой снимают несколько контейнеров одного типа от одного оператора"
                  rules={[
                    { required: true, message: 'Укажите количество' },
                    {
                      type: 'number',
                      min: 1,
                      max: maxContainers,
                      message: `На объекте ${maxContainers} шт.`,
                    },
                  ]}
                >
                  <InputNumber
                    min={1}
                    max={maxContainers}
                    precision={0}
                    style={{ width: '100%' }}
                    disabled={!selectedGroup}
                  />
                </Form.Item>
              </>
            )}
            {/* Исполнителя выбирают у уже заведённой заявки: при создании его чаще всего ещё не
              знают, и лишнее поле в форме отвлекало бы. Новой заявке оператора назначают
              отдельным действием списка или при переводе в работу. */}
            {canAssignOperator && record && (
              <Form.Item
                name="operatorCounterpartyId"
                label="Оператор вывоза"
                tooltip="Контрагент, который выполняет заявку; он увидит её в своём списке"
                // Кто уже работает на площадке — там же, где выбирают исполнителя (ADR 0054):
                // отвечает и на «кого звать», и на «почему нельзя этого».
                extra={
                  formOperatorOptions.length === 0
                    ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                    : presentGroupsHint(groups)
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
            {/* Расхождение «вывозит не тот, кто привёз»: снятие проходит с объяснённой причиной,
              замена не проходит вовсе — она меняет владельца контейнера на площадке. */}
            {ownerVerdict !== 'ok' && (
              <FormGrid.Full>
                <div style={{ marginTop: -8, marginBottom: 16 }}>
                  <Typography.Text type="warning">
                    {`Контейнер установил «${selectedGroup?.ownerName ?? '—'}». `}
                    {ownerVerdict === 'splitRequired'
                      ? FOREIGN_CONTAINER_SPLIT_MESSAGE
                      : 'Назначьте его либо объясните, почему вывозит другой оператор'}
                  </Typography.Text>
                </div>
                {ownerVerdict !== 'splitRequired' && (
                  <Form.Item
                    name="ownerMismatchReason"
                    label="Причина вывоза чужого контейнера"
                    rules={[{ required: true, message: 'Укажите причину' }]}
                  >
                    <Input.TextArea
                      rows={2}
                      maxLength={500}
                      placeholder="Например: контейнеры переданы по акту"
                    />
                  </Form.Item>
                )}
              </FormGrid.Full>
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
                phoneInput={PhoneInput}
              />
              {/* Комментарий площадки: строку исполнителя он пишет сам, в карточке заявки
                (ADR 0053) — форма заявки её не трогает. */}
              <Form.Item name="comment" label="Комментарий площадки">
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
    </WasteRequestFeed>
  );
}
