import { useEffect, useState } from 'react';
import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { roleColors, roleLabels, type AuditEntryDto } from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { DataTable, PageTableLayout, textColumn, type CardConfig } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { userAuditKeys } from '@entities/user-audit';
import { auditApi } from '../../api/resources';
import { formatDateTime } from '../../utils/format';
import { AuditEventCell } from './UserAuditChanges';
import { useUserAuditFilters, type AuditFilterParams } from './UserAuditFilters';
import { UserAuditPathDrawer, type AuditTarget } from './UserAuditPathDrawer';

/**
 * Журнал изменений учётных записей (ADR 0088, ADR 0109): что стало с учёткой, кто это сделал и
 * когда.
 *
 * Экран отвечает на вопросы разбора — «кто выдал этому человеку роль диспетчера», «кому открыли
 * СУ-10 в прошлый вторник», «что стало с учёткой, которой больше нет». Раньше он показывал список
 * действий администраторов без расшифровки: правка объектов, отделов и контактов приезжала одной
 * строкой «Учётная запись изменена», а отобрать журнал по данным самих учёток было нечем.
 *
 * Двух вещей здесь нет намеренно. Кода действия не видно нигде: строку собирает описатель из
 * контрактов (`describeAuditEntry`, `auditChangesOf`) — раздвоившись в вёрстке, формулировки
 * разъехались бы при первом же новом поле учётки. И карточки события нет: строка сама себе
 * карточка, а связный рассказ показывает путь учётки — панель, которая открывается по строке.
 */

/**
 * Границы периода — моментами, а не сутками: записи ложатся с точностью до секунды, и «за 10
 * августа» — это промежуток от полуночи до полуночи, посчитанный в часовом поясе портала (МСК).
 * Без часового пояса граница уехала бы на часы: у сервера свой UTC, у браузера — свой.
 */
const dayStart = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).startOf('day').toISOString() : undefined;
const dayEnd = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).endOf('day').toISOString() : undefined;

/** Над кем действовали: ФИО, адрес и чем учётка стала сейчас. Пусто — её удалили насовсем. */
function targetCell(entry: AuditEntryDto) {
  if (!entry.targetName && !entry.targetEmail) return '—';
  return (
    <Space orientation="vertical" size={0}>
      <span>{entry.targetName ?? '—'}</span>
      {entry.targetEmail ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.targetEmail}
        </Typography.Text>
      ) : null}
      <Space size={4} wrap>
        {entry.targetRole ? (
          <Tag color={roleColors[entry.targetRole]} style={{ marginInlineEnd: 0 }}>
            {roleLabels[entry.targetRole]}
          </Tag>
        ) : null}
        {entry.targetDeletedAt ? (
          <Tag color="red" style={{ marginInlineEnd: 0 }}>
            в архиве
          </Tag>
        ) : null}
      </Space>
    </Space>
  );
}

export function UsersAuditTab() {
  // Поиск идёт по людям — ФИО и адресу учётки, ФИО администратора, — а не по столбцам таблицы:
  // сортируемых и ищущихся колонок у журнала нет вовсе.
  const { params, setParams, setSort, onTableChange } = useListParams<AuditFilterParams>(
    {},
    { searchKeys: [] },
  );

  /** Чей путь открыт панелью; `null` — панель закрыта. */
  const [path, setPath] = useState<AuditTarget | null>(null);
  /**
   * Чьей учёткой сужен журнал. Живёт здесь, а не приходит снаружи: разбор конкретного человека
   * теперь показывает панель пути — и из списка учёток, и из строки журнала, — а этот фильтр
   * остался тем, чем и был, обычным сужением ленты.
   */
  const [target, setTarget] = useState<AuditTarget | null>(null);

  /** Правка любого фильтра возвращает на первую страницу: та же страница при другом наборе — уже другие записи. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  /** Смена человека — такая же смена отбора, как и любая другая: страница возвращается на первую. */
  useEffect(() => {
    setParams((p) => ({ ...p, page: 1 }));
  }, [target?.id, setParams]);

  const query = {
    ...params,
    from: dayStart(params.from),
    to: dayEnd(params.to),
    // Цель — пара «тип сущности и её идентификатор»: журнал общий на весь портал, и без типа
    // фильтр отобрал бы заодно однажды совпавший идентификатор чужой записи.
    entityType: target ? 'user' : undefined,
    entityId: target?.id,
  };
  const { data, isFetching } = useQuery({
    queryKey: userAuditKeys.list(query),
    queryFn: () => auditApi.list(query),
  });

  const { filters, mobileFilters } = useUserAuditFilters({
    params,
    apply: applyFilter,
    target,
    onTargetChange: setTarget,
  });

  const openPath = (entry: AuditEntryDto) => {
    if (!entry.entityId) return;
    setPath({ id: entry.entityId, name: entry.targetName ?? entry.targetEmail ?? '' });
  };

  const columns = [
    textColumn<AuditEntryDto>({
      key: 'createdAt',
      title: 'Когда',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_v, r) => formatDateTime(r.createdAt),
    }),
    // Учётка вторым столбцом, а не последним: экран про то, что стало с людьми, и читают его по
    // ним же — «кто» отвечает уже на вопрос, кем это сделано.
    textColumn<AuditEntryDto>({
      key: 'target',
      title: 'Учётная запись',
      dataIndex: 'targetName',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => targetCell(r),
    }),
    // Сортировка идёт по коду действия, а показывается человекочитаемая строка: одинаковые
    // события собираются рядом, и читать их подряд («все отказы за месяц») удобнее, чем выбирать
    // их фильтром по одному.
    textColumn<AuditEntryDto>({
      key: 'action',
      title: 'Что изменилось',
      dataIndex: 'action',
      searchable: false,
      render: (_v, r) => <AuditEventCell entry={r} />,
    }),
    textColumn<AuditEntryDto>({
      key: 'actorName',
      title: 'Кто изменил',
      dataIndex: 'actorName',
      // Сортировки нет: сервер упорядочивает журнал по времени и коду действия, а ФИО автора
      // приходит join'ом — `AUDIT_SORT_FIELDS` его не принимает.
      sortable: false,
      searchable: false,
      width: 220,
      // Пусто — учётку автора удалили насовсем либо действие человек сделал сам до входа
      // (подтверждение адреса, восстановление пароля по ссылке из письма).
      render: (_v, r) => r.actorName ?? '—',
    }),
  ];

  /**
   * Строка журнала карточкой на телефоне (ADR 0042). Заголовок — учётка: список читают по людям,
   * а момент события уходит подстрокой, как и автор правки.
   */
  const card: CardConfig<AuditEntryDto> = {
    title: (r) => r.targetName ?? r.targetEmail ?? '—',
    badge: (r) => (r.targetDeletedAt ? <Tag color="red">в архиве</Tag> : null),
    primary: (r) => <AuditEventCell entry={r} />,
    lines: [
      (r) => formatDateTime(r.createdAt),
      (r) => (r.actorName ? `Кто: ${r.actorName}` : null),
    ],
    onOpen: openPath,
  };

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'ФИО или адрес',
          onChange: (v) => applyFilter({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { createdAt: 'Когда' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<AuditEntryDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={openPath}
        onChange={onTableChange}
      />
      <UserAuditPathDrawer target={path} onClose={() => setPath(null)} />
    </PageTableLayout>
  );
}
