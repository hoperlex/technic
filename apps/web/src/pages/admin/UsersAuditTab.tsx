import { useEffect } from 'react';
import { DatePicker, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  describeAuditEntry,
  USER_AUDIT_ACTIONS,
  userAuditActionLabels,
  type AuditEntryDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE, MOSCOW_TZ } from '@shared/config';
import { DataTable, PageTableLayout, textColumn, type CardConfig } from '@shared/ui';
import { useListParams, withSavedOption } from '@shared/lib';
import { auditApi, usersApi } from '../../api/resources';
import { formatDateTime } from '../../utils/format';

/**
 * Журнал действий с учётными записями (ADR 0088): когда · кто · что сделал · над кем.
 *
 * Экран отвечает на вопросы разбора — «кто выдал этому человеку роль диспетчера и когда», «что
 * стало с учёткой, которой больше нет». Раньше их задавали базе руками: ручка журнала была, а
 * интерфейса у неё не было ни одного.
 *
 * Двух вещей здесь нет намеренно. Кода действия не видно нигде: строку собирает описатель из
 * контрактов (`describeAuditEntry`), и он же соберёт её будущему экспорту — раздвоившись в
 * вёрстке, формулировки разъехались бы при первом же новом действии. И карточки события нет:
 * строка журнала сама себе карточка, показывать в ней больше нечего.
 */

/** Учётка, историю которой открыли из списка: идентификатор для фильтра, имя — для подписи. */
export interface AuditTarget {
  id: string;
  name: string;
}

interface Props {
  /**
   * Чья история показана. Значение приходит снаружи, потому что задаётся оно не здесь, а пунктом
   * «История» в списке учёток: подвкладка открывается уже суженной до нужного человека.
   */
  target: AuditTarget | null;
  onTargetChange: (target: AuditTarget | null) => void;
}

const DATE = 'YYYY-MM-DD';

/**
 * Границы периода — моментами, а не сутками: записи ложатся с точностью до секунды, и «за 10
 * августа» — это промежуток от полуночи до полуночи, посчитанный в часовом поясе портала (МСК).
 * Без часового пояса граница уехала бы на часы: у сервера свой UTC, у браузера — свой.
 */
const dayStart = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).startOf('day').toISOString() : undefined;
const dayEnd = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).endOf('day').toISOString() : undefined;

const actionOptions = USER_AUDIT_ACTIONS.map((action) => ({
  value: action,
  label: userAuditActionLabels[action],
}));

/** Над кем действовали: ФИО и адрес. Пусто — цель не учётка либо её удалили насовсем. */
function targetCell(entry: AuditEntryDto) {
  if (!entry.targetName && !entry.targetEmail) return '—';
  return (
    <Space direction="vertical" size={0}>
      <span>{entry.targetName ?? '—'}</span>
      {entry.targetEmail ? (
        <Typography.Text type="secondary">{entry.targetEmail}</Typography.Text>
      ) : null}
    </Space>
  );
}

export function UsersAuditTab({ target, onTargetChange }: Props) {
  const { params, setParams, onTableChange } = useListParams<{
    /** Отмеченные действия одной строкой через запятую — в этом виде их и ждёт сервер. */
    actions?: string;
    actorUserId?: string;
    from?: string;
    to?: string;
  }>({}, { searchKeys: [] });

  /** Правка любого фильтра возвращает на первую страницу: та же страница при другом наборе — уже другие записи. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  /**
   * Смена человека — такая же смена отбора, как и любая другая, только приходит она снаружи:
   * пунктом «История» в списке учёток. Страница поэтому тоже возвращается на первую.
   */
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
    queryKey: ['audit', query],
    queryFn: () => auditApi.list(query),
  });

  /**
   * Люди для обоих списков выбора — один запрос: и действующим лицом, и целью бывает одна и та же
   * учётка. Неактивные из списка не убраны: журнал читают как раз про тех, кого выключили, и
   * фильтр без них отвечал бы «записей нет» на самый частый вопрос.
   */
  const { data: people, isFetching: peopleLoading } = useQuery({
    queryKey: ['users', 'audit-filter-options'],
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const personOptions = (people?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }));
  // Учётка из архива в списке действующих не значится, а историю у неё спрашивают чаще прочих —
  // имя её приезжает вместе с выбором, поэтому поле показывает человека, а не голый идентификатор.
  const targetOptions = withSavedOption(personOptions, {
    id: target?.id,
    name: target?.name,
  });

  const selectedActions = params.actions ? params.actions.split(',') : [];

  const columns = [
    textColumn<AuditEntryDto>({
      key: 'createdAt',
      title: 'Когда',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_v, r) => formatDateTime(r.createdAt),
    }),
    textColumn<AuditEntryDto>({
      key: 'actorName',
      title: 'Администратор',
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
    // Сортировка идёт по коду действия, а показывается человекочитаемая строка: одинаковые
    // события собираются рядом, и читать их подряд («все отказы за месяц») удобнее, чем выбирать
    // их фильтром по одному.
    textColumn<AuditEntryDto>({
      key: 'action',
      title: 'Что сделал',
      dataIndex: 'action',
      searchable: false,
      render: (_v, r) => describeAuditEntry(r),
    }),
    textColumn<AuditEntryDto>({
      key: 'target',
      title: 'Над кем',
      dataIndex: 'targetName',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => targetCell(r),
    }),
  ];

  /**
   * Фильтры полосой над таблицей, как на остальных списках портала. В шит фильтров (ADR 0030) она
   * не переложена намеренно: главный фильтр журнала — набор действий, а шит множественного выбора
   * не умеет, и на телефоне отбор шёл бы по одному действию за раз. Полоса переносится по строкам
   * и остаётся одинаковой в обоих режимах.
   */
  const filters = (
    <Space wrap size={8}>
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Действия с', 'по']}
        value={[params.from ? dayjs(params.from) : null, params.to ? dayjs(params.to) : null]}
        onChange={(range) =>
          applyFilter({ from: range?.[0]?.format(DATE), to: range?.[1]?.format(DATE) })
        }
      />
      <Select
        allowClear
        mode="multiple"
        // Отмеченное сворачивается в «+N», когда не помещается: набор бывает и в десяток
        // действий, и растянутое поле выдавило бы остальные фильтры на другую строку.
        maxTagCount="responsive"
        placeholder="Все действия"
        style={{ width: 320 }}
        options={actionOptions}
        value={selectedActions}
        onChange={(v: string[]) => applyFilter({ actions: v.length > 0 ? v.join(',') : undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой администратор"
        style={{ width: 240 }}
        options={personOptions}
        loading={peopleLoading}
        value={params.actorUserId}
        onChange={(v: string | undefined) => applyFilter({ actorUserId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любая учётная запись"
        style={{ width: 260 }}
        options={targetOptions}
        loading={peopleLoading}
        value={target?.id}
        onChange={(id: string | undefined) =>
          onTargetChange(
            id ? { id, name: targetOptions.find((o) => o.value === id)?.label ?? id } : null,
          )
        }
      />
    </Space>
  );

  /**
   * Строка журнала карточкой на телефоне (ADR 0042). Заголовок — момент события: журнал читают
   * сверху вниз по времени, а «что сделал» и «над кем» отвечают уже внутри карточки.
   */
  const card: CardConfig<AuditEntryDto> = {
    title: (r) => formatDateTime(r.createdAt),
    primary: (r) => describeAuditEntry(r),
    lines: [
      (r) => (r.targetName ? `Над кем: ${r.targetName}` : null),
      (r) => (r.actorName ? `Кто: ${r.actorName}` : null),
    ],
  };

  return (
    <PageTableLayout filters={filters}>
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
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
