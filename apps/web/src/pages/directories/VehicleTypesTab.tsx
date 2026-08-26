import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  type TableColumnType,
} from 'antd';
import { EditOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  formatVehicleRequestNumber,
  isOdometerMaintenance,
  isPassengerTypeForm,
  maintenanceBasisOf,
  typeWaybillFormOf,
  type CreateVehicleTypeInput,
  type UpdateVehicleTypeInput,
  type VehicleClassificationDto,
  type VehicleTypeDto,
  type VehicleTypeLinearSwitchPreviewDto,
  type VehicleTypeLinearSwitchResultDto,
} from '@technic/contracts';
import {
  vehicleCategoriesApi,
  vehicleClassificationsApi,
  vehicleKindsApi,
  vehicleTypesApi,
} from '../../api/resources';
import { isApiError } from '@shared/api';
import { DataTable, type CardConfig, type TableChange } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { actionsColumn, textColumn } from '@shared/ui';
import { formatDateOnly } from '../../utils/date';
import { errorMessage } from '../../utils/format';
import { VehicleTypeCardDrawer } from './VehicleTypeCardDrawer';
import { VehicleTypeFormFields, type VtFormValues } from './VehicleTypeFormFields';

interface VtParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  kindId?: string;
  isActive?: string;
  // объект параметров пригоден как query для apiFetch
  [key: string]: unknown;
}

/** Русское склонение счётного слова: 1 заявка, 2 заявки, 5 заявок. */
function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** «12 заявок» — счётное слово к заявкам собирается в одном месте, а читается в четырёх. */
const requestsCount = (n: number) => `${n} ${plural(n, 'заявка', 'заявки', 'заявок')}`;

/**
 * Что сказать про привязки, снятые переводом типа на «форму № 3» (план §4.2.3, четвёртая дверь).
 * Чисел два, а не одно: правка одной строки справочника проходит по всему типу, и счёт прицепов
 * сам по себе размера не называет — «3 у трёх машин» и «3 у одной» это разные новости.
 */
/*
 * Фраза начинается с того, что человек **нажал**: в форме он ставит галочку «Легковой транспорт»,
 * а слова «форма № 3» стоят подписью под ней. Начни с бланка — и связку «галочка → бланк → графы
 * прицепа» он достраивал бы сам, глядя на уже случившееся отцепление, которого не просил.
 */
const unhitchedNotice = (n: number, m: number) =>
  `Тип стал легковым, и лист по нему выписывается формой № 3: отцеплено ` +
  `${n} ${plural(n, 'прицеп', 'прицепа', 'прицепов')} ` +
  `у ${m} ${plural(m, 'машины', 'машин', 'машин')} — граф прицепа в этом бланке нет`;

/**
 * Следствие переключения словами — и обязательно с направлением. Переключают признак **типа**, а
 * заявки, застигнутые в работе, продолжают идти прежним режимом: не сказать, каким именно, значит
 * оставить человека гадать, что случится с бумагой по уже работающим заказам.
 */
function switchConsequence(next: boolean, count: number): string {
  const subject = `${requestsCount(count)} ${plural(count, 'продолжит', 'продолжат', 'продолжат')}`;
  return next
    ? `${subject} вестись по неделям: ЭСМ-2 портал выписывает по ним сам, дни им не планируются.`
    : `${subject} вестись по дням: распланированные дни остаются в рейсах, недельные листы им не выписываются.`;
}

// Справочник классификации ТС. Уровней два — тип (ADR 0005) и категория (ADR 0016), — но
// показываются они одним списком (ADR 0028): у типа с категориями строками идут категории, сам
// тип отдельной строкой не выводится, а тип без ТТХ остаётся собой. Состав ТТХ и заведение
// категорий — по-прежнему в карточке типа (VehicleTypeCardDrawer): там это один инвариант.
export function VehicleTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [card, setCard] = useState<VehicleTypeDto | null>(null);

  // pageSize берём из контракта: сервер принимает только PAGE_SIZES (100/200/500),
  // произвольное значение отклоняется валидацией querystring и список не грузится.
  const [params, setParams] = useState<VtParams>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<VtParams>) => setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-classifications', params],
    queryFn: () => vehicleClassificationsApi.list(params),
  });

  // Сами типы — для правки и карточки: в строке классификатора лежит только то, что показывают,
  // а форме нужен тип целиком (код, вид, описание, порядок). Типов десятки — грузим разом.
  const { data: typesData } = useQuery({
    queryKey: ['vehicle-types', 'full'],
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const typeById = new Map((typesData?.items ?? []).map((t) => [t.id, t]));

  const { data: kindsData, isLoading: kindsLoading } = useQuery({
    queryKey: ['vehicle-kinds'],
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const kindOptions = (kindsData?.items ?? []).map((k) => ({ value: k.id, label: k.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleTypeDto | null>(null);
  const [form] = Form.useForm<VtFormValues>();
  const isEdit = !!record;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    // Бланк по умолчанию — 4-П (ADR 0065): у собственной техники лист есть всегда, а «легковой»
    // это исключение, которое отмечают руками.
    // Разметка ТО тем же умолчанием, что и в колонке: пока тип не размечен, обслуживание с его
    // машин не спрашивается (Р13).
    form.setFieldsValue({
      sortOrder: 100,
      isActive: true,
      isPassenger: false,
      isLinear: false,
      maintenanceByOdometer: false,
    });
    setOpen(true);
  };
  const openEdit = (r: VehicleTypeDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      kindId: r.kindId,
      code: r.code,
      name: r.name,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      isPassenger: isPassengerTypeForm(r.waybillFormCode),
      isLinear: r.isLinear,
      maintenanceByOdometer: isOdometerMaintenance(r.maintenanceBasis),
    });
    setOpen(true);
  };

  const invalidateTypes = () => {
    void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
    // Наименование типа — это и подпись его строк в классификаторе (ADR 0028).
    void qc.invalidateQueries({ queryKey: ['vehicle-classifications'] });
  };

  // Заведение типа: признак линейности у нового типа уходит обычным полем — заявок, которых
  // переключение могло бы застать, у него нет и быть не может.
  const createMut = useMutation({
    mutationFn: (body: CreateVehicleTypeInput) => vehicleTypesApi.create(body),
    onSuccess: () => {
      message.success('Сохранено');
      invalidateTypes();
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Диалог подтверждения: что именно случится и с какими заявками. Обещание Promise, а не колбэк,
   * потому что переключение — шаг последовательности «предпросмотр → вопрос → запись», и читать
   * её надо сверху вниз.
   */
  const confirmLinearSwitch = (preview: VehicleTypeLinearSwitchPreviewDto, typeName: string) =>
    new Promise<boolean>((resolve) => {
      // Перечень короче счётчика ровно на то, чего этот человек и так не видит в списке заявок:
      // архив — администраторская область, а чужие площадки закрыты областью видимости. Молчать
      // об этой разнице нельзя — числа на экране перестали бы сходиться.
      const hidden = preview.count - preview.archivedCount - preview.requests.length;
      modal.confirm({
        title: `Переключить режим заказов типа «${typeName}»?`,
        width: 560,
        content: (
          <Space direction="vertical" size={8} style={{ display: 'flex' }}>
            <span>{switchConsequence(preview.next, preview.count)}</span>
            {preview.requests.length > 0 && (
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {preview.requests.map((r) => (
                  <li key={r.num}>
                    {formatVehicleRequestNumber(r.num)} — {r.objectName},{' '}
                    {formatDateOnly(r.dateFrom)}
                    {r.dateTo ? ` — ${formatDateOnly(r.dateTo)}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {preview.archivedCount > 0 && (
              <Typography.Text type="secondary">
                Ещё {requestsCount(preview.archivedCount)} в архиве.
              </Typography.Text>
            )}
            {hidden > 0 && (
              <Typography.Text type="secondary">
                Ещё {requestsCount(hidden)} на площадках, которых вы не ведёте.
              </Typography.Text>
            )}
          </Space>
        ),
        okText: 'Переключить',
        cancelText: 'Отмена',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

  /**
   * Переключение признака своей ручкой: предпросмотр → подтверждение → запись. `null` — человек
   * отказался, и не записано ничего.
   */
  const runLinearSwitch = async (
    type: VehicleTypeDto,
    next: boolean,
  ): Promise<VehicleTypeLinearSwitchResultDto | null> => {
    for (let attempt = 0; ; attempt++) {
      const preview = await vehicleTypesApi.linearSwitchPreview(type.id, next);
      // Пустое множество подтверждать нечего: заявок, которых переключение застигнет, нет.
      if (preview.count > 0 && !(await confirmLinearSwitch(preview, type.name))) return null;
      try {
        return await vehicleTypesApi.switchLinear(type.id, {
          isLinear: next,
          ...(preview.count > 0 ? { fingerprint: preview.fingerprint } : {}),
        });
      } catch (e) {
        // Ни 409 («состав заявок изменился»), ни 422 («нужно подтверждение») ничего не записали:
        // портал перечитывает предпросмотр и спрашивает заново — с новым перечнем перед глазами.
        // Второй такой отказ уходит человеку: справочник правят наперегонки, и решать это циклу
        // не по чину.
        const again = isApiError(e) && (e.status === 409 || e.status === 422);
        if (!again || attempt > 0) throw e;
        // Отказ сервера, а не пустое поле формы (ADR 0094): тост отвечает на ответ ручки, а
        // следом человек увидит перечитанный перечень.
        message.error(e.message);
      }
    }
  };

  /** Идёт ли сохранение правки: предпросмотр, переключение и PATCH — один шаг для человека. */
  const [saving, setSaving] = useState(false);

  /**
   * Правка типа — до двух запросов, и порядок между ними не вкусовой: сначала переключение
   * признака своей ручкой, потом `PATCH` остальных полей. Обратный порядок сохранил бы
   * описательные правки и потерял бы главное на отказе подтверждения.
   */
  const submitEdit = async (v: VtFormValues, type: VehicleTypeDto) => {
    // Признак линейности в теле `PATCH` не едет вовсе — этой ручкой он больше не правится.
    const body: UpdateVehicleTypeInput = {
      name: v.name,
      description: v.description ?? '',
      sortOrder: v.sortOrder,
      isActive: v.isActive,
      waybillFormCode: typeWaybillFormOf(v.isPassenger ?? false),
      // Разметка ТО правится обычным полем: своего протокола у неё нет — она включает расчёт, а не
      // переписывает режим работающих заявок.
      maintenanceBasis: maintenanceBasisOf(v.maintenanceByOdometer ?? false),
    };
    const nextLinear = v.isLinear ?? false;
    setSaving(true);
    let switched = false;
    try {
      if (nextLinear !== type.isLinear) {
        const result = await runLinearSwitch(type, nextLinear);
        if (!result) return;
        switched = true;
        // Тип в форме приводится к справочнику сразу: повтор сохранения после неудачного `PATCH`
        // не должен звать переключение по второму разу.
        setRecord(result.type);
        if (result.frozenNow > 0) {
          // Номера — из ответа ручки, а не из показанного предпросмотра: между ними множество
          // могло измениться, и заморожены ровно те, кого назвала запись. Длинный список режется:
          // счётчик полон, а сорок номеров в тосте не читает никто — они лежат в журнале.
          const nums = result.frozenNums.slice(0, 10).map(formatVehicleRequestNumber).join(', ');
          const rest = result.frozenNums.length - 10;
          message.info(
            `Режим переключён. На прежнем режиме ${requestsCount(result.frozenNow)}: ` +
              `${nums}${rest > 0 ? ` и ещё ${rest}` : ''}`,
          );
        }
      }
      const saved = await vehicleTypesApi.update(type.id, body);
      message.success('Сохранено');
      // Изменение в базе, которого не просили: галочку ставили про бланк, а отцепились прицепы у
      // всех машин типа. Предупреждением и дольше обычного, как в VehiclesTab; при нуле — молчим.
      if (saved.unhitchedTrailers)
        message.warning(unhitchedNotice(saved.unhitchedTrailers, saved.unhitchedVehicles), 8);
      setOpen(false);
    } catch (e) {
      // Переключение прошло, а правка остальных полей — нет: «не сохранено» здесь было бы
      // неправдой. Форма остаётся открытой с несохранёнными полями, а чекбокс уже совпадает со
      // справочником — повторное нажатие допишет то, что не доехало, и второго переключения не
      // случится.
      message.error(
        switched
          ? `Режим переключён, остальные поля не сохранены: ${errorMessage(e)}. Повторите сохранение.`
          : errorMessage(e),
      );
    } finally {
      // Тип перечитывается в любом исходе: после переключения он другой, а лишний запрос дешевле
      // формы, спорящей со справочником.
      invalidateTypes();
      setSaving(false);
    }
  };

  const submit = (v: VtFormValues) => {
    if (isEdit) {
      void submitEdit(v, record!);
      return;
    }
    const create: CreateVehicleTypeInput = {
      kindId: v.kindId!,
      code: v.code!,
      name: v.name!,
      description: v.description ?? '',
      sortOrder: v.sortOrder ?? 100,
      isActive: v.isActive ?? true,
      waybillFormCode: typeWaybillFormOf(v.isPassenger ?? false),
      isLinear: v.isLinear ?? false,
      maintenanceBasis: maintenanceBasisOf(v.maintenanceByOdometer ?? false),
    };
    createMut.mutate(create);
  };

  // Активация/деактивация — инлайн; деактивация с подтверждением. Строка классификатора может
  // быть и типом, и категорией: выключают ровно то, что в строке, — иначе выключение «Автокрана,
  // г/п 25 т» уносило бы с собой все остальные автокраны.
  const toggleMut = useMutation({
    mutationFn: async (r: { row: VehicleClassificationDto; isActive: boolean }) => {
      if (r.row.vehicleCategoryId) {
        await vehicleCategoriesApi.update(r.row.vehicleCategoryId, { isActive: r.isActive });
        return;
      }
      // Ответ читать нечего: активность бланка не трогает, а привязки снимает только он (§4.2.3).
      await vehicleTypesApi.update(r.row.vehicleTypeId, { isActive: r.isActive });
    },
    onSuccess: (_d, v) => {
      const what = v.row.vehicleCategoryId ? 'Категория' : 'Тип';
      message.success(
        `${what} ${v.isActive ? 'активирован' : 'деактивирован'}${v.row.vehicleCategoryId ? 'а' : ''}`,
      );
      void qc.invalidateQueries({ queryKey: ['vehicle-classifications'] });
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
      void qc.invalidateQueries({ queryKey: ['vehicle-categories'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const onToggleActive = (row: VehicleClassificationDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ row, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать «${row.label}»?`,
      content: row.vehicleCategoryId
        ? 'Заказать эту категорию будет нельзя; остальные категории типа останутся доступны.'
        : 'Заказать этот тип и любую его категорию будет нельзя.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ row, isActive: false }),
    });
  };

  // Сортировка серверная; снятая сортировка возвращает справочник к его собственному порядку.
  const onTableChange = (c: TableChange) =>
    setParams((p) => ({
      ...p,
      page: c.page,
      pageSize: c.pageSize,
      sortBy: c.sortBy ?? 'sortOrder',
      sortOrder: c.sortOrder ?? 'asc',
    }));

  // Колонки: Вид → Тип/категория → ТТХ → Линейная → Активен → Действия. Отдельного счётчика
  // категорий больше нет — категории и есть строки списка.
  const columns: TableColumnType<VehicleClassificationDto>[] = [
    textColumn<VehicleClassificationDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      searchable: false,
      width: 200,
    }),
    {
      key: 'label',
      title: 'Тип/категория',
      dataIndex: 'label',
      sorter: true,
      ellipsis: true,
      // Наименование категории уже начинается с типа («Автокраны, г/п 25 т»), поэтому тип рядом
      // не повторяется. Тег отличает категорию от типа, который выбирается целиком.
      render: (v: string, r) => (
        <Space size={6}>
          <span>{v}</span>
          {r.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        </Space>
      ),
    },
    {
      key: 'specCount',
      title: 'ТТХ',
      dataIndex: 'specCount',
      width: 90,
      sorter: false,
      render: (v: number) => (v > 0 ? <Tag color="blue">{v}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isLinear',
      title: 'Линейная',
      width: 160,
      sorter: false,
      // Признак живёт у типа, а строкой списка бывает и категория (ADR 0028) — берём его из
      // самого типа и показываем у всех его строк: режим заказа у категории тот же, что у типа.
      // Пометкой, а не переключателем: правится он в форме, где рядом стоит объяснение и где
      // портал называет заявки, которые останутся на прежнем режиме.
      render: (_v, r) => {
        const type = typeById.get(r.vehicleTypeId);
        return (
          <Space direction="vertical" size={2}>
            {type?.isLinear ? <Tag color="blue">по дням</Tag> : <span>—</span>}
            {/* Заявки, застигнутые переключением: они дорабатывают тем режимом, которым их
                завели, и колонка отвечает на вопрос «почему две заявки одного типа ведут себя
                по-разному». Ноль не показывается — так у подавляющего большинства типов. */}
            {type && type.frozenRequests > 0 ? (
              <Tooltip title="Эти заявки застало переключение признака: до закрытия они идут прежним режимом">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {type.frozenRequests} на прежнем режиме
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      key: 'maintenanceBasis',
      title: 'ТО',
      width: 120,
      sorter: false,
      // Разметка ТО (Р13) — тем же приёмом, что и линейность: признак живёт у типа, показывается у
      // всех его строк и правится в форме, а не переключателем списка. Колонка нужна затем, чтобы
      // «какие типы размечены» читалось списком: без неё ответ собирается открыванием карточек по
      // одной, а неразмеченный тип молча не показывает обслуживание нигде.
      render: (_v, r) =>
        isOdometerMaintenance(typeById.get(r.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">по пробегу</Tag>
        ) : (
          <Tooltip title="У этого типа ТО не ведётся: срок обслуживания портал не считает и не подсвечивает">
            <span>—</span>
          </Tooltip>
        ),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      // У категории показываем её доступность целиком: у выключенного типа не бывает доступных
      // категорий, и включать их по одной бессмысленно — сперва нужно включить сам тип.
      render: (v: boolean, r) => {
        const blocked = !!r.vehicleCategoryId && !r.typeIsActive;
        const control = (
          <Switch
            size="small"
            checked={v}
            disabled={blocked}
            loading={toggleMut.isPending}
            onChange={(n) => onToggleActive(r, n)}
          />
        );
        return blocked ? (
          <Tooltip title={`Тип «${r.typeName}» неактивен — активируйте сначала его`}>
            {control}
          </Tooltip>
        ) : (
          control
        );
      },
    },
    actionsColumn<VehicleClassificationDto>((r) => {
      const type = typeById.get(r.vehicleTypeId);
      return (
        <Space size={4}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            title="ТТХ и категории типа"
            disabled={!type}
            onClick={() => type && setCard(type)}
          />
          {/* Правится всегда тип: наименование категории собирается из его ТТХ и значений
              (ADR 0016) и правится там же, в карточке. */}
          <Button
            size="small"
            icon={<EditOutlined />}
            title={`Редактировать тип «${r.typeName}»`}
            disabled={!type}
            onClick={() => type && openEdit(type)}
          />
        </Space>
      );
    }),
  ];

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код, тип, категория)"
        style={{ width: 220 }}
        value={params.search}
        onChange={(e) => patchParams({ search: e.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Вид"
        style={{ width: 200 }}
        options={kindOptions}
        value={params.kindId}
        onChange={(v) => patchParams({ kindId: v })}
      />
      <Select
        allowClear
        placeholder="Активность"
        style={{ width: 150 }}
        options={[
          { value: 'true', label: 'Активные' },
          { value: 'false', label: 'Неактивные' },
        ]}
        value={params.isActive}
        onChange={(v) => patchParams({ isActive: v })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    // Поиска здесь нет: он стоит строкой в панели списка (ADR 0042), и второе поле в шите
    // спрашивало бы то же самое.
    {
      kind: 'select',
      key: 'kindId',
      label: 'Вид техники',
      value: params.kindId,
      options: kindOptions,
      placeholder: 'Любой вид',
      onChange: (v) => patchParams({ kindId: v }),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Неактивные' },
      ],
      placeholder: 'Все',
      onChange: (v) => patchParams({ isActive: v }),
    },
  ];

  /**
   * Карточка позиции классификатора на телефоне (ADR 0042). Заголовок — сама позиция: категория
   * уже начинается с типа («Автокраны, г/п 25 т»), поэтому тип рядом не повторяется, а тег
   * отличает бескатегорийный тип, который заказывают целиком.
   */
  const listCard: CardConfig<VehicleClassificationDto> = {
    title: (r) => r.label,
    badge: (r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Да' : 'Нет'}</Tag>,
    primary: (r) => (
      <Space size={6} wrap>
        <span>{r.kindName}</span>
        {r.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        {/* Тот же признак, что столбцом на большом экране, но словом «линейная»: заголовка
            столбца рядом нет, а голое «по дням» на карточке не о чем (ADR 0042). */}
        {typeById.get(r.vehicleTypeId)?.isLinear ? <Tag color="blue">линейная</Tag> : null}
        {/* Разметка ТО — тем же тегом и тоже только когда она есть: «не ведётся» на карточке
            телефона молчит, как и пустая колонка на большом экране. */}
        {isOdometerMaintenance(typeById.get(r.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">ТО по пробегу</Tag>
        ) : null}
      </Space>
    ),
    lines: [
      (r) => (r.specCount > 0 ? `ТТХ: ${r.specCount}` : 'ТТХ не заведены'),
      // Заявки, застигнутые переключением признака: строкой, а не тегом — на карточке телефона
      // это объяснение, а не пометка. Ноль строки не занимает.
      (r) => {
        const frozen = typeById.get(r.vehicleTypeId)?.frozenRequests ?? 0;
        return frozen > 0 ? `${frozen} на прежнем режиме` : '';
      },
    ],
    // Касание открывает карточку типа — там ТТХ, категории и правка наименования.
    onOpen: (r) => {
      const type = typeById.get(r.vehicleTypeId);
      if (type) setCard(type);
    },
    actions: (r) => {
      const type = typeById.get(r.vehicleTypeId);
      return [
        {
          key: 'card',
          label: 'ТТХ и категории типа',
          disabled: !type,
          onClick: () => type && setCard(type),
        },
        {
          key: 'edit',
          label: `Редактировать тип «${r.typeName}»`,
          disabled: !type,
          onClick: () => type && openEdit(type),
        },
        {
          key: 'toggle',
          label: r.isActive ? 'Деактивировать' : 'Активировать',
          danger: r.isActive,
          // Категорию выключенного типа включать нечего: сперва включают сам тип.
          disabled: !!r.vehicleCategoryId && !r.typeIsActive,
          onClick: () => onToggleActive(r, !r.isActive),
        },
      ];
    },
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
      }
      // На телефоне справочник читается карточками, поиск и фильтры — в панели и шите (ADR 0042).
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код, тип, категория',
          onChange: (v) => patchParams({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { label: 'Тип/категория' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: (sortBy, sortOrder) =>
            setParams((p) => ({
              ...p,
              sortBy: sortBy ?? 'sortOrder',
              sortOrder: sortOrder ?? 'asc',
              page: 1,
            })),
        },
        primaryAction: { label: 'Добавить тип', icon: <PlusOutlined />, onClick: openCreate },
      }}
    >
      <DataTable<VehicleClassificationDto>
        columns={columns}
        card={listCard}
        rowKey="key"
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
      <FormModal
        title={isEdit ? 'Редактирование типа' : 'Новый тип ТС'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={createMut.isPending || saving}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <VehicleTypeFormFields
            form={form}
            record={record}
            kinds={kindsData?.items ?? []}
            kindsLoading={kindsLoading}
          />
        </Form>
      </FormModal>
      <VehicleTypeCardDrawer type={card} onClose={() => setCard(null)} />
    </PageTableLayout>
  );
}
