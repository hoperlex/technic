import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  TimePicker,
  Typography,
  type TableColumnsType,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAILING_PERIODICITIES,
  MAILING_TYPES,
  MAILING_WINDOW_MAX_DAYS,
  mailingPeriodicityLabels,
  mailingRunStatusColors,
  mailingRunStatusLabels,
  mailingTypeLabels,
  type CreateMailingScheduleBody,
  type MailingPeriodicity,
  type MailingRunDto,
  type MailingScheduleDto,
  type MailingType,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { actionsColumn, DataTable, FormModal, RowActionButton, textColumn } from '@shared/ui';
import { driversApi, mailingsApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';

/**
 * Расписания рассылок и история их запусков (ADR 0075).
 *
 * Настройка живёт в БД, а не в `env`: время отправки, окно рейсов и исключения меняет
 * администратор, и правка `env` означала бы перезапуск сервиса руками того, у кого есть доступ к
 * серверу. Экран показывает ровно то, чем распоряжается планировщик, — и то, что он уже сделал:
 * без истории «рассылка не пришла» неотличимо от «рассылка не запускалась».
 */

const DATE_KEY = 'YYYY-MM-DD';
const TIME = 'HH:mm';

/** ISO-дни недели: 1 — понедельник, 7 — воскресенье. Тем же счётом живут БД и расчёт запуска. */
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_NAMES = [
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
];
const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function weekdayName(iso: number): string {
  return WEEKDAY_NAMES[iso - 1] ?? String(iso);
}

function weekdayShort(iso: number): string {
  return WEEKDAY_SHORT[iso - 1] ?? String(iso);
}

/**
 * Подписи итогов запуска. Письмо составляется не каждому, и три вида пропуска чинятся по-разному:
 * адрес заводят в справочнике, исключение снимают в расписании, а «нет рейсов» — не проблема вовсе.
 */
const STAT_LABELS: Record<string, string> = {
  sent: 'отправлено',
  withoutEmail: 'без адреса',
  excluded: 'исключены',
  empty: 'нет рейсов',
  reason: 'причина',
};

/**
 * Итоги приходят из `jsonb` нетипизированными: у выполненного запуска это счётчики, у пропущенного
 * — причина текстом. Известные поля печатаются подписями, незнакомые — ключом: промолчать о
 * непонятном итоге хуже, чем показать его как есть.
 */
function statsText(stats: Record<string, unknown>): string {
  const parts = Object.entries(stats).map(
    ([key, value]) => `${STAT_LABELS[key] ?? key}: ${String(value)}`,
  );
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** «18:00» → момент с этим временем: TimePicker работает с dayjs, а расписание хранит строку. */
function timeToDayjs(hhmm: string): Dayjs {
  const [hh, mm] = hhmm.split(':');
  return dayjs()
    .hour(Number(hh ?? 0))
    .minute(Number(mm ?? 0))
    .second(0)
    .millisecond(0);
}

function toDateKeys(values: Dayjs[] | undefined): string[] {
  return (values ?? []).map((d) => d.format(DATE_KEY));
}

function toDayjsList(values: string[]): Dayjs[] {
  return values.map((d) => dayjs(d));
}

interface ScheduleFormValues {
  type: MailingType;
  name: string;
  isEnabled: boolean;
  periodicity: MailingPeriodicity;
  sendAt: Dayjs;
  weekday?: number;
  runWeekdays?: number[];
  windowFromDays?: number;
  windowToDays?: number;
  excludedRunDates?: Dayjs[];
  excludedRouteDates?: Dayjs[];
  excludedPersonIds?: string[];
}

/**
 * Правка расписания уходит целиком (`updateMailingScheduleSchema`), поэтому и переключатель
 * «включено» в списке шлёт всю запись, а не одно поле: по одному присланному «день недели» сервер
 * не сказал бы, законен ли он.
 */
function bodyOf(r: MailingScheduleDto): CreateMailingScheduleBody {
  return {
    type: r.type,
    name: r.name,
    isEnabled: r.isEnabled,
    periodicity: r.periodicity,
    sendAt: r.sendAt,
    weekday: r.weekday,
    runWeekdays: r.runWeekdays,
    windowFromDays: r.windowFromDays,
    windowToDays: r.windowToDays,
    excludedRunDates: r.excludedRunDates,
    excludedRouteDates: r.excludedRouteDates,
    excludedPersonIds: r.excludedPersonIds,
  };
}

function formToBody(v: ScheduleFormValues): CreateMailingScheduleBody {
  const daily = v.periodicity === 'daily';
  const withWindow = v.type === 'driver_routes';
  return {
    type: v.type,
    name: v.name,
    isEnabled: v.isEnabled,
    periodicity: v.periodicity,
    sendAt: v.sendAt.format(TIME),
    // Поля чужой периодичности гасятся здесь: скрытое поле формы сохраняет прежнее значение, а
    // сервер такую пару отвергнет — «день недели у ежедневной рассылки» бывает только ошибкой.
    weekday: daily ? null : (v.weekday ?? null),
    // У недельной рассылки набор дней в расчёте не участвует (день задаёт `weekday`), но пустым
    // он быть не может: «не выполняется никогда» выражается флагом «выключено».
    runWeekdays: daily && v.runWeekdays?.length ? v.runWeekdays : ALL_WEEKDAYS,
    windowFromDays: withWindow ? (v.windowFromDays ?? null) : null,
    windowToDays: withWindow ? (v.windowToDays ?? null) : null,
    excludedRunDates: toDateKeys(v.excludedRunDates),
    excludedRouteDates: toDateKeys(v.excludedRouteDates),
    excludedPersonIds: v.excludedPersonIds ?? [],
  };
}

/**
 * Сообщение об отказе при сохранении. 409 здесь означает ровно одно — расписание успели изменить
 * в другом окне, и отправленная версия уже не последняя. Текст свой, а не серверный: человеку
 * нужно указание, что делать («обновите страницу»), а не констатация конфликта версий.
 */
function saveErrorMessage(e: unknown): string {
  return isApiError(e) && e.status === 409
    ? 'Расписание уже изменили — обновите страницу'
    : errorMessage(e);
}

const SCHEDULES_KEY = ['mailing-schedules'];
const RUNS_KEY = ['mailing-runs'];
/** Запусков за месяц набирается три десятка: страницы по 50 хватает, чтобы листать их редко. */
const RUNS_PAGE_SIZE = 50;

export function MailingSchedulesBlock() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('mailings.manage');

  const { data: schedules, isFetching } = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => mailingsApi.schedules(),
  });
  const rows = schedules ?? [];

  // Выбранное расписание держим идентификатором, а не самой записью: после перезагрузки списка
  // запомненная запись показывала бы историю рядом с уже изменившейся настройкой.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const [runsPage, setRunsPage] = useState(1);
  const [runsPageSize, setRunsPageSize] = useState(RUNS_PAGE_SIZE);

  const runsQuery = useQuery({
    queryKey: [...RUNS_KEY, selectedId, runsPage, runsPageSize],
    queryFn: () =>
      mailingsApi.runs({
        scheduleId: selectedId,
        page: runsPage,
        pageSize: runsPageSize,
        // Свежие сначала: у истории спрашивают «что было вчера вечером», а не «что было в марте».
        sortBy: 'plannedAt',
        sortOrder: 'desc',
      }),
    enabled: !!selectedId,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MailingScheduleDto | null>(null);
  const [form] = Form.useForm<ScheduleFormValues>();
  const watchType = Form.useWatch('type', form);
  const watchPeriodicity = Form.useWatch('periodicity', form);
  const watchExcludedPersons = Form.useWatch('excludedPersonIds', form);

  // Справочник водителей спрашиваем только при открытой форме: в нём персональные данные, и
  // держать его в кэше ради колонки «включено» незачем.
  const driversQuery = useQuery({
    queryKey: ['drivers', 'mailing-exclusions'],
    queryFn: () =>
      driversApi.list({ page: 1, pageSize: 500, sortBy: 'fullName', sortOrder: 'asc' }),
    enabled: open,
  });
  const driverOptions = (() => {
    const items = driversQuery.data?.items ?? [];
    const options = items.map((d) => ({ value: d.id, label: d.fullName }));
    const known = new Set(items.map((d) => d.id));
    // Исключённый водитель мог уйти в архив или не попасть в первые 500 строк справочника. Без
    // своей строки Select показал бы вместо него uuid, а «Сохранить» молча унесло бы его из набора.
    const missing = (watchExcludedPersons ?? []).filter((id) => !known.has(id));
    return [...options, ...missing.map((id) => ({ value: id, label: 'Карточка вне справочника' }))];
  })();

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      type: 'driver_routes',
      // Новая рассылка заводится выключенной: сначала настраивают, потом включают.
      isEnabled: false,
      periodicity: 'daily',
      sendAt: timeToDayjs('18:00'),
      runWeekdays: ALL_WEEKDAYS,
      // Задание на завтра: вечерняя рассылка ради этого и существует.
      windowFromDays: 1,
      windowToDays: 1,
      excludedRunDates: [],
      excludedRouteDates: [],
      excludedPersonIds: [],
    });
    setOpen(true);
  };

  const openEdit = (r: MailingScheduleDto) => {
    setEditing(r);
    form.resetFields();
    form.setFieldsValue({
      type: r.type,
      name: r.name,
      isEnabled: r.isEnabled,
      periodicity: r.periodicity,
      sendAt: timeToDayjs(r.sendAt),
      weekday: r.weekday ?? undefined,
      runWeekdays: r.runWeekdays.length > 0 ? r.runWeekdays : ALL_WEEKDAYS,
      windowFromDays: r.windowFromDays ?? undefined,
      windowToDays: r.windowToDays ?? undefined,
      excludedRunDates: toDayjsList(r.excludedRunDates),
      excludedRouteDates: toDayjsList(r.excludedRouteDates),
      excludedPersonIds: r.excludedPersonIds,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: ScheduleFormValues) => {
      const body = formToBody(v);
      return editing
        ? mailingsApi.updateSchedule(editing.id, { ...body, version: editing.version })
        : mailingsApi.createSchedule(body);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      setOpen(false);
    },
    onError: (e) => message.error(saveErrorMessage(e)),
  });

  const toggleMut = useMutation({
    mutationFn: (r: MailingScheduleDto) =>
      mailingsApi.updateSchedule(r.id, {
        ...bodyOf(r),
        isEnabled: !r.isEnabled,
        version: r.version,
      }),
    onSuccess: () => {
      message.success('Готово');
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (e) => message.error(saveErrorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => mailingsApi.deleteSchedule(id),
    onSuccess: (_res, id) => {
      message.success('Расписание удалено');
      // История удалённого расписания уходит вместе с ним — закрываем её, иначе внизу осталась бы
      // таблица запусков того, чего больше нет.
      if (selectedId === id) setSelectedId(null);
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const runMut = useMutation({
    mutationFn: (id: string) => mailingsApi.runNow(id),
    onSuccess: (res, id) => {
      message.success(`Рассылка выполнена: писем отправлено — ${res.stats.sent}`);
      // Итоги смотрят в истории — открываем её на этом расписании, чтобы не искать запуск руками.
      setSelectedId(id);
      setRunsPage(1);
      void qc.invalidateQueries({ queryKey: RUNS_KEY });
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmRun = (r: MailingScheduleDto) =>
    modal.confirm({
      title: `Запустить рассылку «${r.name}» сейчас?`,
      // Предупреждение обязано быть прямым: это не отладочная отправка администратору, а рабочая
      // рассылка живым людям, и отозвать ушедшее письмо нельзя.
      content:
        'Письма уйдут настоящим получателям — водителям, а не на проверочный адрес. Отменить ' +
        'отправку после подтверждения нельзя. Расписание при этом не сдвигается: очередной ' +
        'запуск по времени всё равно состоится.',
      okText: 'Запустить',
      cancelText: 'Отмена',
      onOk: () => runMut.mutateAsync(r.id),
    });

  const confirmRemove = (r: MailingScheduleDto) =>
    modal.confirm({
      title: `Удалить расписание «${r.name}»?`,
      content:
        'Вместе с расписанием пропадёт история его запусков. Журнал отправленных писем ' +
        'сохранится. Если рассылку нужно только приостановить — выключите её переключателем.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns: TableColumnsType<MailingScheduleDto> = [
    textColumn<MailingScheduleDto>({
      key: 'name',
      title: 'Название',
      dataIndex: 'name',
      // Список приходит целиком и уже упорядоченным: сортировать и искать в нём нечего.
      sortable: false,
      searchable: false,
      width: 220,
    }),
    textColumn<MailingScheduleDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      sortable: false,
      searchable: false,
      width: 200,
      render: (_v, r) => mailingTypeLabels[r.type],
    }),
    textColumn<MailingScheduleDto>({
      key: 'periodicity',
      title: 'Периодичность',
      dataIndex: 'periodicity',
      sortable: false,
      searchable: false,
      width: 140,
      render: (_v, r) => mailingPeriodicityLabels[r.periodicity],
    }),
    textColumn<MailingScheduleDto>({
      key: 'sendAt',
      title: 'Время',
      dataIndex: 'sendAt',
      sortable: false,
      searchable: false,
      width: 90,
    }),
    // Одна колонка на день недели и на набор дней: они принадлежат разным периодичностям, и
    // вторая стояла бы пустой у половины строк.
    textColumn<MailingScheduleDto>({
      key: 'days',
      title: 'Дни',
      dataIndex: 'runWeekdays',
      sortable: false,
      searchable: false,
      width: 170,
      render: (_v, r) =>
        r.periodicity === 'weekly'
          ? r.weekday
            ? weekdayName(r.weekday)
            : '—'
          : r.runWeekdays.length === ALL_WEEKDAYS.length
            ? 'Все дни'
            : r.runWeekdays.map(weekdayShort).join(', '),
    }),
    textColumn<MailingScheduleDto>({
      key: 'window',
      title: 'Окно рейсов',
      dataIndex: 'windowFromDays',
      sortable: false,
      searchable: false,
      width: 130,
      // Окно считается в днях от дня рассылки, поэтому и печатается днями: «+1…+1» — завтрашние.
      render: (_v, r) =>
        r.windowFromDays == null || r.windowToDays == null
          ? '—'
          : `+${r.windowFromDays}…+${r.windowToDays} дн.`,
    }),
    textColumn<MailingScheduleDto>({
      key: 'isEnabled',
      title: 'Включена',
      dataIndex: 'isEnabled',
      sortable: false,
      searchable: false,
      width: 110,
      render: (_v, r) => (
        <Switch
          size="small"
          checked={r.isEnabled}
          disabled={!canManage || toggleMut.isPending}
          onChange={() => toggleMut.mutate(r)}
        />
      ),
    }),
    textColumn<MailingScheduleDto>({
      key: 'nextRunAt',
      title: 'Следующий запуск',
      dataIndex: 'nextRunAt',
      sortable: false,
      searchable: false,
      width: 160,
      // У выключенного расписания времени нет вовсе: планировщик его не разбудит.
      render: (_v, r) => (r.nextRunAt ? formatDateTime(r.nextRunAt) : '—'),
    }),
    ...(canManage
      ? [
          actionsColumn<MailingScheduleDto>(
            (r) => (
              <Space size={4}>
                <RowActionButton
                  title="Редактировать"
                  icon={<EditOutlined />}
                  onClick={() => openEdit(r)}
                />
                <RowActionButton
                  title="Запустить сейчас"
                  icon={<ThunderboltOutlined />}
                  onClick={() => void confirmRun(r)}
                />
                <RowActionButton
                  title="Удалить"
                  icon={<DeleteOutlined />}
                  danger
                  onClick={() => void confirmRemove(r)}
                />
              </Space>
            ),
            130,
          ),
        ]
      : []),
  ];

  const runColumns: TableColumnsType<MailingRunDto> = [
    textColumn<MailingRunDto>({
      key: 'plannedAt',
      title: 'Запуск',
      dataIndex: 'plannedAt',
      sortable: false,
      searchable: false,
      width: 180,
      render: (_v, r) => (
        <Space size={4}>
          <span>{formatDateTime(r.plannedAt)}</span>
          {/* Ручной запуск в истории отличается от расписанного: по нему разбирают «почему письмо
              пришло дважды» и «кто отправил задание в воскресенье». */}
          {r.isManual ? <Tag>вручную</Tag> : null}
        </Space>
      ),
    }),
    textColumn<MailingRunDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      sortable: false,
      searchable: false,
      width: 130,
      render: (_v, r) => (
        <Tag color={mailingRunStatusColors[r.status]}>{mailingRunStatusLabels[r.status]}</Tag>
      ),
    }),
    textColumn<MailingRunDto>({
      key: 'finishedAt',
      title: 'Завершён',
      dataIndex: 'finishedAt',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_v, r) => (r.finishedAt ? formatDateTime(r.finishedAt) : '—'),
    }),
    textColumn<MailingRunDto>({
      key: 'period',
      title: 'Рейсы за',
      dataIndex: 'periodStart',
      sortable: false,
      searchable: false,
      width: 190,
      // Границы данных запуска: у видов рассылки, считающих период от даты запуска, их нет.
      render: (_v, r) =>
        r.periodStart && r.periodEnd
          ? `${formatDateOnly(r.periodStart)} — ${formatDateOnly(r.periodEnd)}`
          : '—',
    }),
    textColumn<MailingRunDto>({
      key: 'stats',
      title: 'Итоги',
      dataIndex: 'stats',
      sortable: false,
      searchable: false,
      width: 320,
      render: (_v, r) => statsText(r.stats),
    }),
    textColumn<MailingRunDto>({
      key: 'error',
      title: 'Ошибка',
      dataIndex: 'error',
      sortable: false,
      searchable: false,
      width: 240,
      ellipsis: true,
      // Текст ошибки бывает длинным (ответ SMTP целиком) — целиком он остаётся подсказкой.
      render: (_v, r) => (r.error ? <span title={r.error}>{r.error}</span> : '—'),
    }),
  ];

  return (
    <div style={{ padding: 16 }}>
      <Space
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}
        align="center"
        wrap
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          Расписания рассылок
        </Typography.Title>
        {canManage ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить расписание
          </Button>
        ) : null}
      </Space>

      {/* Высота задана явно: вкладка отдана содержимому целиком, и таблица без своей рамки
          растянулась бы на всё, выдавив историю запусков и отладочную отправку за низ экрана. */}
      <div style={{ height: 320 }}>
        <DataTable<MailingScheduleDto>
          columns={columns}
          data={rows}
          total={rows.length}
          loading={isFetching}
          page={1}
          pageSize={DICTIONARY_PAGE_SIZE}
          onChange={() => {
            /* Список приходит целиком и уже упорядоченным: листать и сортировать нечего. */
          }}
          onRowClick={(r) => {
            setSelectedId(r.id);
            // Другое расписание — другая история: страницу прежней сохранять незачем.
            setRunsPage(1);
          }}
        />
      </div>

      <Card
        size="small"
        style={{ marginTop: 12 }}
        title={selected ? `История запусков: ${selected.name}` : 'История запусков'}
        extra={
          selected ? (
            <Button size="small" onClick={() => setSelectedId(null)}>
              Закрыть
            </Button>
          ) : null
        }
      >
        {selected ? (
          <div style={{ height: 300 }}>
            <DataTable<MailingRunDto>
              columns={runColumns}
              data={runsQuery.data?.items ?? []}
              total={runsQuery.data?.total ?? 0}
              loading={runsQuery.isFetching}
              page={runsPage}
              pageSize={runsPageSize}
              onChange={(c) => {
                setRunsPage(c.page);
                setRunsPageSize(c.pageSize);
              }}
            />
          </div>
        ) : (
          <Typography.Text type="secondary">
            Выберите расписание в списке — здесь появится, когда оно срабатывало и чем это
            кончилось.
          </Typography.Text>
        )}
      </Card>

      <FormModal
        title={editing ? 'Редактирование расписания' : 'Новое расписание'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        // Шире стандартных 480: набор дней недели и пара полей окна рейсов в узком окне
        // переносятся по одному в строку, и форма перестаёт читаться целиком.
        width={620}
      >
        <Form
          form={form}
          layout="vertical"
          className="form-dense"
          onFinish={(v) => saveMut.mutate(v)}
        >
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Укажите название рассылки' }]}
          >
            <Input maxLength={200} placeholder="Например: задание водителям на завтра" />
          </Form.Item>

          <Form.Item
            name="type"
            label="Тип рассылки"
            rules={[{ required: true, message: 'Выберите тип рассылки' }]}
            // Тип держит и состав получателей, и историю запусков: «то же расписание, но теперь
            // про другое» читалось бы как подмена прошлых рассылок, поэтому сервер его не меняет.
            extra={editing ? 'Тип менять нельзя — заведите отдельное расписание' : undefined}
          >
            <Select
              disabled={!!editing}
              options={MAILING_TYPES.map((t) => ({ value: t, label: mailingTypeLabels[t] }))}
            />
          </Form.Item>

          <Form.Item
            name="periodicity"
            label="Периодичность"
            rules={[{ required: true, message: 'Выберите периодичность' }]}
          >
            <Select
              options={MAILING_PERIODICITIES.map((p) => ({
                value: p,
                label: mailingPeriodicityLabels[p],
              }))}
            />
          </Form.Item>

          {/* Шаг в пять минут: рассылку назначают на круглое время, а список из шестидесяти минут
              приходится прокручивать. Подтверждать выбор кнопкой не надо — поле одно, и «ОК»
              после каждого щелчка здесь лишний шаг. */}
          <Form.Item
            name="sendAt"
            label="Время отправки"
            rules={[{ required: true, message: 'Укажите время отправки' }]}
            extra="Местное время портала (Москва)"
          >
            <TimePicker format={TIME} minuteStep={5} needConfirm={false} style={{ width: 160 }} />
          </Form.Item>

          {/* День недели — принадлежность недельной рассылки; у ежедневной его нет вовсе. */}
          {watchPeriodicity === 'weekly' ? (
            <Form.Item
              name="weekday"
              label="День недели"
              rules={[{ required: true, message: 'Выберите день недели' }]}
            >
              <Select
                options={ALL_WEEKDAYS.map((d) => ({ value: d, label: weekdayName(d) }))}
                style={{ width: 220 }}
              />
            </Form.Item>
          ) : (
            <Form.Item
              name="runWeekdays"
              label="Дни выполнения"
              // Расписание, не выполняющееся никогда, выражается флагом «выключено», а не пустым
              // набором дней: иначе выключенная рассылка выглядела бы включённой.
              rules={[
                {
                  validator: (_rule, value: number[] | undefined) =>
                    value && value.length > 0
                      ? Promise.resolve()
                      : Promise.reject(
                          new Error('Выберите хотя бы один день или выключите рассылку'),
                        ),
                },
              ]}
            >
              <Checkbox.Group
                options={ALL_WEEKDAYS.map((d) => ({ value: d, label: weekdayShort(d) }))}
              />
            </Form.Item>
          )}

          {/* Окно рейсов — принадлежность задания водителю: у сводки по ролям период считается от
              даты запуска, и пара полей стояла бы у неё бессмысленной. */}
          {watchType === 'driver_routes' ? (
            <Space align="start" size={16} wrap>
              <Form.Item
                name="windowFromDays"
                label="Рейсы с (дней от дня рассылки)"
                rules={[{ required: true, message: 'Укажите, с какого дня брать рейсы' }]}
                extra="1 — завтрашние рейсы, 0 — сегодняшние"
              >
                <InputNumber min={0} max={MAILING_WINDOW_MAX_DAYS} style={{ width: 220 }} />
              </Form.Item>
              <Form.Item
                name="windowToDays"
                label="по (дней от дня рассылки)"
                dependencies={['windowFromDays']}
                rules={[
                  { required: true, message: 'Укажите, по какой день брать рейсы' },
                  ({ getFieldValue }) => ({
                    validator: (_rule, value: number | undefined) => {
                      const from = getFieldValue('windowFromDays') as number | undefined;
                      return value == null || from == null || value >= from
                        ? Promise.resolve()
                        : Promise.reject(new Error('Конец окна рейсов раньше его начала'));
                    },
                  }),
                ]}
                extra={`Не длиннее ${MAILING_WINDOW_MAX_DAYS} дней`}
              >
                <InputNumber min={0} max={MAILING_WINDOW_MAX_DAYS} style={{ width: 220 }} />
              </Form.Item>
            </Space>
          ) : null}

          <Form.Item
            name="excludedRunDates"
            label="Даты без рассылки"
            extra="В эти дни рассылка не уходит: праздники и остановки. Расчёт следующего запуска их учитывает"
          >
            <DatePicker multiple format="DD.MM.YYYY" style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="excludedRouteDates"
            label="Даты рейсов, которые не печатать"
            extra="Рейсы этих дней в письмо не попадут, сама рассылка при этом уходит"
          >
            <DatePicker multiple format="DD.MM.YYYY" style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="excludedPersonIds"
            label="Исключённые водители"
            extra="Этим людям рассылка не адресуется — например, они получают задание другим способом"
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Никто не исключён"
              loading={driversQuery.isLoading}
              options={driverOptions}
            />
          </Form.Item>

          <Form.Item
            name="isEnabled"
            label="Включена"
            valuePropName="checked"
            extra="Выключенная рассылка не срабатывает и следующего запуска не имеет"
          >
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </div>
  );
}
