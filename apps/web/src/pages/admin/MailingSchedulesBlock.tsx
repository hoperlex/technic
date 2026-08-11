import { useState } from 'react';
import { App, Button, Card, Space, Switch, Tag, Typography, type TableColumnsType } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  digestRequestScopeLabels,
  mailingRunStatusColors,
  mailingRunStatusLabels,
  mailingTypeLabels,
  roleLabels,
  type MailingRunDto,
  type MailingScheduleDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { actionsColumn, DataTable, RowActionButton, textColumn } from '@shared/ui';
import { mailingsApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';
import { MailingScheduleForm } from './MailingScheduleForm';
import {
  ALL_WEEKDAYS,
  saveErrorMessage,
  scheduleBody,
  weekdayShort,
  windowText,
} from './mailingScheduleValues';

/**
 * Расписания рассылок и история их запусков (ADR 0075).
 *
 * Настройка живёт в БД, а не в `env`: время отправки, окно данных и исключения меняет
 * администратор, и правка `env` означала бы перезапуск сервиса руками того, у кого есть доступ к
 * серверу. Экран показывает ровно то, чем распоряжается планировщик, — и то, что он уже сделал:
 * без истории «рассылка не пришла» неотличимо от «рассылка не запускалась».
 *
 * Сама форма расписания живёт отдельным файлом: список отвечает на вопрос «что и когда уходит»,
 * форма — «как это настроено», и вместе они не помещались в один экран чтения.
 */

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

/** Сколько отмечено на оси аудитории; режим «все» показывается словами, а не числом. */
function audienceText(mode: string, count: number): string {
  return mode === 'all' ? 'все' : `отмечено ${count}`;
}

/**
 * Краткая настройка расписания для списка. Окно печатается одинаково у обоих типов: это одна и та
 * же настройка — за какие дни собираются данные. У сводки к нему добавляется объём аудитории:
 * сколько ролей она задевает и заданы ли области с получателями перечнем.
 */
function setupText(r: MailingScheduleDto): string {
  const window = windowText(r.windowFromDays, r.windowDays);
  if (r.type !== 'role_digest') return window;
  return (
    `${window} · ролей: ${r.roles.length} · площадки: ` +
    `${audienceText(r.scopeMode, r.objectIds.length + r.departmentIds.length)} · получатели: ` +
    `${audienceText(r.recipientMode, r.recipientUserIds.length)}`
  );
}

/** Расшифровка настройки под курсором: названия ролей и охват заявок в колонку не влезают. */
function setupHint(r: MailingScheduleDto): string {
  const lines = [`Данные ${windowText(r.windowFromDays, r.windowDays)}`];
  if (r.type !== 'role_digest') return lines.join('\n');
  const tables = [r.showTrips ? 'перевозки' : '', r.showOnsite ? 'техника на объектах' : '']
    .filter((s) => !!s)
    .join(', ');
  lines.push(`Роли: ${r.roles.map((role) => roleLabels[role]).join(', ') || '—'}`);
  lines.push(
    `Площадки и отделы: ${audienceText(r.scopeMode, r.objectIds.length + r.departmentIds.length)}`,
  );
  lines.push(`Получатели: ${audienceText(r.recipientMode, r.recipientUserIds.length)}`);
  lines.push(`Охват заявок: ${digestRequestScopeLabels[r.requestScope]}`);
  lines.push(`Таблицы: ${tables || '—'}`);
  return lines.join('\n');
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

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (r: MailingScheduleDto) => {
    setEditing(r);
    setOpen(true);
  };

  const toggleMut = useMutation({
    mutationFn: (r: MailingScheduleDto) =>
      mailingsApi.updateSchedule(r.id, {
        ...scheduleBody(r),
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
      // рассылка живым людям, и отозвать ушедшее письмо нельзя. Кому именно — называется по типу:
      // «водителям» в подтверждении сводки по ролям было бы прямой неправдой.
      content:
        `Письма уйдут настоящим получателям — ${
          r.type === 'role_digest' ? 'учётным записям выбранных ролей' : 'водителям'
        }, а не на проверочный адрес. Отменить ` +
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
      key: 'sendAt',
      title: 'Время',
      dataIndex: 'sendAt',
      sortable: false,
      searchable: false,
      width: 90,
    }),
    // Периодичности у расписания больше нет: набор дней и есть ответ на вопрос «когда».
    textColumn<MailingScheduleDto>({
      key: 'days',
      title: 'Дни',
      dataIndex: 'runWeekdays',
      sortable: false,
      searchable: false,
      width: 170,
      render: (_v, r) =>
        r.runWeekdays.length === ALL_WEEKDAYS.length
          ? 'Все дни'
          : r.runWeekdays.map(weekdayShort).join(', '),
    }),
    // Окно данных печатается одинаково у обоих типов, а объём аудитории — только у сводки.
    // Названия ролей в колонку не влезают: они остаются подсказкой под курсором.
    textColumn<MailingScheduleDto>({
      key: 'setup',
      title: 'Настройка',
      dataIndex: 'windowFromDays',
      sortable: false,
      searchable: false,
      width: 240,
      ellipsis: true,
      render: (_v, r) => <span title={setupHint(r)}>{setupText(r)}</span>,
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
      title: 'Данные за',
      dataIndex: 'periodStart',
      sortable: false,
      searchable: false,
      width: 190,
      // Границы окна фиксируются в запуске: повтор упавшей вечерней рассылки обязан взять те же
      // дни, а не пересчитать окно от утра следующего.
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

      <MailingScheduleForm
        open={open}
        editing={editing}
        onClose={() => setOpen(false)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
          setOpen(false);
        }}
      />
    </div>
  );
}
