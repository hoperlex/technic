import { useMemo, useState } from 'react';
import { Alert, Checkbox, Input, Select, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PERMISSIONS,
  permissionActionLabels,
  permissionModuleLabels,
  type Permission,
  type PermissionAction,
  type PermissionModule,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import {
  DataTable,
  ExpandableCell,
  PageTableLayout,
  SummaryBar,
  textColumn,
  ViewModal,
  type CardConfig,
} from '@shared/ui';
import { useAccessUsers } from './accessOverview';
import { PermissionDetails } from './PermissionHoldersCard';
import { buildRows, markColors, markLabels, marksOf, type PermissionRow } from './permissionRows';

/**
 * Срез «Права» вкладки «Права» (`docs/permissions-tab-plan.md` §1.3): обратный взгляд на модель
 * доступа — не «что может человек», а «кто владеет этим правом».
 *
 * Строка здесь — право, и читают её ради двух ответов, которых ни в списке учёток, ни в срезе
 * профилей не видно: право, запертое у того, кому и так открыто всё (кандидат в будущие
 * полномочия), и право, которого нет ни у одной живой учётки. Оба ответа — вход пересмотра ролей,
 * и добываются они сегодня чтением матрицы вместе с запросом в базу. С назначаемыми полномочиями
 * (ADR 0106) второй ответ становится и вовсе единственным способом узнать положение дел: статический
 * перебор профилей перестал описывать живые учётки, и §10.1 плана прямо назначает этот срез
 * компенсацией за его потерю.
 *
 * Держатели поэтому считаются по правам, которые отдал сервер, а профили матрицы остаются рядом
 * вторым, независимым ответом: «кому право положено по должности» — тоже вопрос пересмотра, и
 * расхождение двух колонок здесь не дефект витрины, а её главный вывод. Своего представления о
 * правах на срезе нет ни строчки: перечень и профили приходят вызовами контрактов (`PERMISSIONS`,
 * `profilesWith`, `PERMISSION_CATALOG`), права учёток — ответом API. Действий нет ни одного —
 * витрина только читает.
 */

const moduleOptions = PERMISSION_MODULES.map((module) => ({
  value: module,
  label: permissionModuleLabels[module],
}));

const actionOptions = PERMISSION_ACTIONS.map((action) => ({
  value: action,
  label: permissionActionLabels[action],
}));

/** Число держателей. Ноль — это вывод, а не пустая клетка, и выглядеть он должен пометкой. */
function holdersCell(row: PermissionRow, pending: boolean) {
  if (pending) return '…';
  return row.holders.length > 0 ? row.holders.length : <Tag>нет</Tag>;
}

/** Клиентский отбор: перечень прав приходит целиком из контрактов, спрашивать о нём некого. */
interface PermissionFilters {
  search: string;
  module?: PermissionModule;
  action?: PermissionAction;
  locked: boolean;
  granted: boolean;
  unused: boolean;
}

export function AccessPermissionsTab() {
  const { users, total, truncated, isFetching } = useAccessUsers();
  /** Список ещё не приехал: ноль держателей на пустом списке означал бы не пустое право, а загрузку. */
  const pending = isFetching && users.length === 0;
  const { rows, locked, granted, unused } = useMemo(() => buildRows(users), [users]);

  const [filters, setFilters] = useState<PermissionFilters>({
    search: '',
    locked: false,
    granted: false,
    unused: false,
  });
  const patchFilters = (patch: Partial<PermissionFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }));

  const visible = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      // Поиск идёт и по коду: в документации и в коде право зовут им, а не подписью.
      const matches =
        !needle ||
        row.label.toLowerCase().includes(needle) ||
        row.permission.toLowerCase().includes(needle);
      return (
        matches &&
        (!filters.module || row.module === filters.module) &&
        (!filters.action || row.action === filters.action) &&
        (!filters.locked || row.locked) &&
        (!filters.granted || row.byGrant) &&
        (!filters.unused || row.holders.length === 0)
      );
    });
  }, [rows, filters]);

  const [openedKey, setOpenedKey] = useState<Permission | null>(null);
  // Открытая строка ищется по коду, а не запоминается объектом: список учёток перечитывается, и
  // запомненная строка осталась бы с прежним числом держателей.
  const opened = rows.find((row) => row.permission === openedKey) ?? null;

  const columns = [
    textColumn<PermissionRow>({
      key: 'label',
      title: 'Право',
      dataIndex: 'label',
      // Ни сортировки, ни поиска в заголовке: строки — сама матрица, они приходят целиком и в
      // порядке её объявления (права модуля стоят рядом), а отбор идёт полосой над таблицей.
      sortable: false,
      searchable: false,
      width: 300,
      render: (_v, r) => (
        <Space orientation="vertical" size={0}>
          <span>{r.label}</span>
          {/* Код — то, по чему право ищут в коде и в документации; в строке он вторичен. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.permission}
          </Typography.Text>
        </Space>
      ),
    }),
    textColumn<PermissionRow>({
      key: 'module',
      title: 'Модуль',
      dataIndex: 'module',
      sortable: false,
      searchable: false,
      width: 170,
      render: (_v, r) => permissionModuleLabels[r.module],
    }),
    textColumn<PermissionRow>({
      key: 'action',
      title: 'Действие',
      dataIndex: 'action',
      sortable: false,
      searchable: false,
      width: 130,
      render: (_v, r) => permissionActionLabels[r.action],
    }),
    textColumn<PermissionRow>({
      key: 'profiles',
      // «Матрицы» в заголовке не для красоты: рядом стоит колонка держателей, и без уточнения два
      // числа читались бы как одно и то же, посчитанное по-разному.
      title: 'Профили матрицы',
      dataIndex: 'profiles',
      sortable: false,
      searchable: false,
      // Держателей у чтения справочников — десяток, у выгрузки — один: ячейка сворачивается
      // (`ExpandableCell`), иначе каждая строка таблицы вырастает под самое многолюдное право.
      render: (_v, r) => (
        <ExpandableCell>
          <Typography.Text strong>{r.profiles.length}</Typography.Text>
          {r.profiles.length > 0 ? ` — ${r.profiles.join(', ')}` : ''}
        </ExpandableCell>
      ),
    }),
    textColumn<PermissionRow>({
      key: 'holders',
      title: 'Учёток',
      dataIndex: 'holders',
      sortable: false,
      searchable: false,
      width: 100,
      render: (_v, r) => holdersCell(r, pending),
    }),
    textColumn<PermissionRow>({
      key: 'marks',
      title: 'Пометка',
      dataIndex: 'permission',
      sortable: false,
      searchable: false,
      width: 240,
      render: (_v, r) => {
        const marks = marksOf(r, pending);
        // Пусто, а не «—»: пометка — исключение, и прочерк в полусотне обычных строк спорил бы
        // весом с ним самим.
        if (marks.length === 0) return null;
        return (
          <Space size={[4, 4]} wrap>
            {marks.map((mark) => (
              <Tag key={mark} color={markColors[mark]}>
                {markLabels[mark]}
              </Tag>
            ))}
          </Space>
        );
      },
    }),
  ];

  /**
   * Строка права карточкой на телефоне (ADR 0042). Справа — число держателей: ради него срез и
   * открывают, и первым оно должно читаться в обоих режимах.
   */
  const card: CardConfig<PermissionRow> = {
    title: (r) => r.label,
    badge: (r) => holdersCell(r, pending),
    primary: (r) => `${permissionModuleLabels[r.module]} · ${permissionActionLabels[r.action]}`,
    lines: [
      (r) => r.permission,
      (r) => `Профили матрицы (${r.profiles.length}): ${r.profiles.join(', ') || '—'}`,
      (r) =>
        marksOf(r, pending)
          .map((mark) => markLabels[mark])
          .join(' · ') || null,
    ],
    onOpen: (r) => setOpenedKey(r.permission),
  };

  /**
   * Сводка отвечает на вопросы пересмотра до чтения таблицы: сколько прав заперто у полного доступа,
   * сколько уже раздают наборами и сколько не досталось никому. Ниже эти же три числа набираются
   * построчно — и уже не сводкой, а листанием полусотни строк.
   */
  const filterBar = (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <SummaryBar
        title="Прав"
        items={[
          { label: 'Всего', value: PERMISSIONS.length },
          { label: markLabels.locked, value: locked },
          { label: markLabels.granted, value: pending ? '…' : granted },
          { label: 'Не выданы никому', value: pending ? '…' : unused },
        ]}
      />
      <Space wrap size={8}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Подпись или код права"
          style={{ width: 260 }}
          value={filters.search}
          onChange={(e) => patchFilters({ search: e.target.value })}
        />
        <Select
          allowClear
          placeholder="Все модули"
          style={{ width: 220 }}
          options={moduleOptions}
          value={filters.module}
          onChange={(v: PermissionModule | undefined) => patchFilters({ module: v })}
        />
        <Select
          allowClear
          placeholder="Любое действие"
          style={{ width: 180 }}
          options={actionOptions}
          value={filters.action}
          onChange={(v: PermissionAction | undefined) => patchFilters({ action: v })}
        />
        <Checkbox
          checked={filters.locked}
          onChange={(e) => patchFilters({ locked: e.target.checked })}
        >
          {markLabels.locked}
        </Checkbox>
        <Checkbox
          checked={filters.granted}
          onChange={(e) => patchFilters({ granted: e.target.checked })}
        >
          {markLabels.granted}
        </Checkbox>
        <Checkbox
          checked={filters.unused}
          onChange={(e) => patchFilters({ unused: e.target.checked })}
        >
          {markLabels.unused}
        </Checkbox>
      </Space>
    </Space>
  );

  return (
    <PageTableLayout filters={filterBar}>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Учтены не все учётки: показаны первые ${users.length} из ${total}`}
          description="Число держателей и пометка «ни у кого из живых» посчитаны по этой части списка — право могло остаться без держателей только из-за среза."
        />
      )}
      <DataTable<PermissionRow>
        rowKey="permission"
        columns={columns}
        card={card}
        data={visible}
        total={visible.length}
        loading={isFetching}
        page={1}
        pageSize={DICTIONARY_PAGE_SIZE}
        onChange={() => {
          /* Матрица приходит целиком и уже упорядоченной: листать и сортировать нечего. */
        }}
        onRowClick={(row) => setOpenedKey(row.permission)}
      />
      <ViewModal
        title={opened?.label ?? ''}
        open={!!opened}
        onClose={() => setOpenedKey(null)}
        destroyOnHidden
      >
        {opened && <PermissionDetails row={opened} pending={pending} />}
      </ViewModal>
    </PageTableLayout>
  );
}
