import { useState } from 'react';
import { Button, Input, Select, Space, Tag, Typography } from 'antd';
import {
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { GrantDto, GrantKindFilter } from '@technic/contracts';
import {
  actionsColumn,
  boolBadgeColumn,
  DataTable,
  ExpandableCell,
  PageTableLayout,
  RowActionButton,
  SummaryBar,
  sortOptionsFrom,
  textColumn,
  type CardConfig,
} from '@shared/ui';
import { useListParams } from '@shared/lib';
import { grantKeys, grantsApi } from '../../api/resources';
import { draftOf, GrantBuilderModal, type GrantDraft } from './GrantBuilderModal';
import { GrantHoldersModal } from './GrantHoldersModal';
import { roleListText } from './grantModel';

/**
 * Срез «Полномочия» вкладки «Права» (ADR 0106, план §12) — каталог назначаемых наборов и вход в две
 * работы над ними: конструктор состава и реестр выдач.
 *
 * Это первый экран вкладки, который **правит** доступ, а не только показывает его. Соседние три
 * среза остаются витриной по своей причине (анализ нельзя смешивать с выдачей, пока роли не
 * пересмотрены), а каталог заведён ровно затем, чтобы новая обязанность не требовала выката:
 * «Приёмка топлива» собирается здесь за минуту (§12.3).
 *
 * Открыт весь экран правом `users.manage` — тем же, которым открыта вкладка «Права» в
 * администрировании. Своего права у каталога нет намеренно: право, которым набирают права,
 * невыдаваемое (инвариант 1 решения 6), и второе такое право замкнуло бы модель саму на себя.
 */

const KIND_LABELS: Record<GrantKindFilter, string> = {
  all: 'Все наборы',
  system: 'Системные',
  custom: 'Пользовательские',
};

const kindOptions = (['all', 'system', 'custom'] as const).map((kind) => ({
  value: kind,
  label: KIND_LABELS[kind],
}));

/** Что открыто в конструкторе: существующий набор либо черновик нового. */
interface BuilderState {
  grant: GrantDto | null;
  draft: GrantDraft | null;
}

export function AccessGrantsTab() {
  const { params, setParams, setSort, onTableChange } = useListParams<{ kind: GrantKindFilter }>(
    { kind: 'all' },
    // Поиска в заголовках столбцов нет: он стоит в полосе над таблицей — рядом с отбором по классу,
    // потому что спрашивают их вместе («покажи пользовательские про топливо»).
    { searchKeys: [] },
  );
  /*
   * Порядок по умолчанию — по названию и от «А»: каталог читают глазами, а общий умолчательный
   * `desc` перевернул бы его в обратный алфавит. Заданная человеком сортировка идёт как есть.
   */
  const query = {
    ...params,
    sortBy: params.sortBy ?? 'name',
    sortOrder: params.sortBy ? params.sortOrder : ('asc' as const),
  };
  const { data, isFetching } = useQuery({
    queryKey: grantKeys.list(query),
    queryFn: () => grantsApi.list(query),
  });

  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [holdersOf, setHoldersOf] = useState<GrantDto | null>(null);

  const openBuilder = (grant: GrantDto | null) => setBuilder({ grant, draft: null });

  const columns = [
    textColumn<GrantDto>({
      key: 'name',
      title: 'Название',
      dataIndex: 'name',
      searchable: false,
      width: 260,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.name}</span>
          {/* Код — то, чем набор зовут журнал, реестр выдач и таблицы кода; в строке он вторичен. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.code}
          </Typography.Text>
        </Space>
      ),
    }),
    boolBadgeColumn<GrantDto>({
      key: 'isSystem',
      title: 'Класс',
      dataIndex: 'isSystem',
      trueText: 'Системное',
      falseText: 'Пользовательское',
      width: 170,
    }),
    textColumn<GrantDto>({
      key: 'permissions',
      title: 'Прав',
      dataIndex: 'permissions',
      sortable: false,
      searchable: false,
      width: 110,
      render: (_v, r) => (
        <Space size={4}>
          {r.permissions.length}
          {/* Сирота — право, снятое из словаря выкатом: доступа не даёт, но о ней надо сказать. */}
          {r.unknownPermissions.length > 0 && (
            <Tag color="orange">+{r.unknownPermissions.length} вне словаря</Tag>
          )}
        </Space>
      ),
    }),
    textColumn<GrantDto>({
      key: 'holderCount',
      title: 'Держателей',
      dataIndex: 'holderCount',
      sortable: false,
      searchable: false,
      width: 130,
      render: (_v, r) => (r.holderCount > 0 ? r.holderCount : <Tag>нет</Tag>),
    }),
    textColumn<GrantDto>({
      key: 'roles',
      title: 'Совместимые роли',
      dataIndex: 'roles',
      sortable: false,
      searchable: false,
      render: (_v, r) => <ExpandableCell>{roleListText(r.roles)}</ExpandableCell>,
    }),
    actionsColumn<GrantDto>(
      (r) => (
        <Space>
          <RowActionButton
            // Системный набор открывается просмотром, и подпись действия обязана это говорить до
            // нажатия: иначе «Изменить» обещало бы правку, которой не будет.
            title={r.isSystem ? 'Посмотреть состав' : 'Изменить состав'}
            icon={r.isSystem ? <EyeOutlined /> : <EditOutlined />}
            onClick={() => openBuilder(r)}
          />
          <RowActionButton
            title="Реестр выдач"
            icon={<TeamOutlined />}
            onClick={() => setHoldersOf(r)}
          />
        </Space>
      ),
      110,
    ),
  ];

  const card: CardConfig<GrantDto> = {
    title: (r) => r.name,
    badge: (r) =>
      r.holderCount > 0 ? <Tag color="blue">выдач: {r.holderCount}</Tag> : <Tag>нет выдач</Tag>,
    primary: (r) => r.code,
    lines: [
      (r) => (r.isSystem ? 'Системное' : 'Пользовательское'),
      (r) => `Прав: ${r.permissions.length}`,
      (r) => `Роли: ${roleListText(r.roles)}`,
    ],
    onOpen: openBuilder,
    actions: (r) => [
      {
        key: 'builder',
        label: r.isSystem ? 'Посмотреть состав' : 'Изменить состав',
        onClick: () => openBuilder(r),
      },
      { key: 'holders', label: 'Реестр выдач', onClick: () => setHoldersOf(r) },
    ],
  };

  const filterBar = (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <SummaryBar
        title="Полномочий"
        items={[
          // «Найдено» считает отбор, «показано» — страница: каталог листается, и одно число на два
          // вопроса означало бы, что фильтр нашёл ровно страницу.
          { label: 'Найдено', value: data?.total ?? '…' },
          { label: 'Показано', value: data?.items.length ?? '…' },
        ]}
      />
      <Space wrap size={8}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Название или код набора"
          style={{ width: 260 }}
          value={params.search ?? ''}
          onChange={(e) => setParams((p) => ({ ...p, search: e.target.value, page: 1 }))}
        />
        {/* Отбор подписан, а не оставлен подсказкой внутри поля: пустого состояния у него не бывает
            («Все наборы» — тоже выбор), и без подписи прочитать, чем сужен список, было бы нечем. */}
        <label htmlFor="grants-kind">
          <Typography.Text type="secondary">Класс набора</Typography.Text>
        </label>
        <Select<GrantKindFilter>
          id="grants-kind"
          style={{ width: 200 }}
          options={kindOptions}
          value={params.kind}
          onChange={(kind) => setParams((p) => ({ ...p, kind, page: 1 }))}
        />
      </Space>
    </Space>
  );

  return (
    <PageTableLayout
      filters={filterBar}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Название или код',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: [
          {
            kind: 'select',
            key: 'kind',
            label: 'Класс набора',
            value: params.kind,
            options: kindOptions,
            placeholder: KIND_LABELS.all,
            onChange: (v) =>
              setParams((p) => ({ ...p, kind: (v as GrantKindFilter) ?? 'all', page: 1 })),
          },
        ],
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: {
          label: 'Создать полномочие',
          icon: <PlusOutlined />,
          onClick: () => openBuilder(null),
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openBuilder(null)}>
          Создать полномочие
        </Button>
      }
    >
      <DataTable<GrantDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={query.sortBy}
        sortOrder={query.sortOrder}
        onChange={onTableChange}
        onRowClick={openBuilder}
      />
      {builder && (
        <GrantBuilderModal
          open
          grant={builder.grant}
          draft={builder.draft}
          onClose={() => setBuilder(null)}
          // Копия системного набора: то же окно, но уже как заведение нового — с составом,
          // перенесённым в черновик, и своим кодом.
          onCopy={(grant) => setBuilder({ grant: null, draft: draftOf(grant) })}
        />
      )}
      {holdersOf && <GrantHoldersModal open grant={holdersOf} onClose={() => setHoldersOf(null)} />}
    </PageTableLayout>
  );
}
