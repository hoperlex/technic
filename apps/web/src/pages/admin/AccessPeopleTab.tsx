import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Checkbox, Input, Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import {
  can,
  counterpartyTypeLabels,
  describeAccessScope,
  moduleAccess,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  permissionSource,
  roleAddonColors,
  roleAddonLabels,
  roleColors,
  roleLabels,
  ROLES,
  type AccessSubject,
  type Permission,
  type Role,
  type UserDto,
} from '@technic/contracts';
import { DataTable, PageTableLayout, textColumn, ViewModal, type CardConfig } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  activeUsers,
  grantedPermissions,
  scopeAnomaly,
  scopeTargets,
  subjectOf,
  useAccessUsers,
} from './accessOverview';

/**
 * Срез «Люди» вкладки «Права» (`docs/permissions-tab-plan.md` §1.1): учётка × доступ.
 *
 * Экран отвечает на два вопроса, ради которых сегодня читают `permissions.ts` и ходят в базу: что
 * человек может и **почему** он это может. Второй важнее: право приходит из роли, из типа
 * контрагента или из надстройки (ADR 0038, 0086), и при пересмотре ролей решает именно это
 * различие, а не сам факт доступа. Поэтому источник подписан у каждого права в карточке.
 *
 * Ни одного действия здесь нет: выдача и отзыв прав — предмет отдельной панели, и смешивать её с
 * анализом нельзя, пока роли не пересмотрены. Своего представления о правах экран тоже не заводит
 * — всё считают `can`, `moduleAccess`, `permissionSource` и `describeAccessScope` из контрактов:
 * список «что может штаб», написанный на портале, разошёлся бы с матрицей ровно в тот момент,
 * когда по нему принимают решение.
 */

/** Подпись оси области — те же слова, что в карточке учётки. */
const scopeAxisTitles = {
  object: 'Объекты',
  department: 'Отделы',
  counterparty: 'Контрагент',
} as const;

/**
 * Роль и надстройки одной ячейкой (ADR 0086) — теми же пометками, что в списке учёток: строку
 * ищут глазами по цвету роли, и вторая раскраска сбивала бы. Подписи и цвета берутся из
 * контрактов; повторена здесь только вёрстка — в «Учётных записях» она внутренняя функция экрана,
 * и вытаскивать её наружу ради витрины значило бы править соседний файл.
 */
function roleTags(user: UserDto) {
  if (!user.role) return '—';
  return (
    <Space size={4} wrap>
      <Tag color={roleColors[user.role]}>{roleLabels[user.role]}</Tag>
      {user.addons.map((addon) => (
        <Tag key={addon} color={roleAddonColors[addon]}>
          {roleAddonLabels[addon]}
        </Tag>
      ))}
    </Space>
  );
}

function personCell(user: UserDto) {
  return (
    <Space direction="vertical" size={0}>
      <span>{user.fullName}</span>
      <Typography.Text type="secondary">{user.email}</Typography.Text>
    </Space>
  );
}

/**
 * Область одной строкой: перечень объектов, отделов или имя контрагента. У роли без своей оси —
 * «Все записи», и это не пустое место, а самая широкая область из возможных. Пустая ось молчит:
 * почему набор пуст, говорит `scopeAnomaly` рядом.
 */
function scopeText(user: UserDto): string {
  const { axis, items } = scopeTargets(user);
  if (items.length > 0) return items.join(', ');
  if (!user.role) return '—';
  return axis ? '—' : 'Все записи';
}

function scopeCell(user: UserDto) {
  const anomaly = scopeAnomaly(user);
  return (
    <Space direction="vertical" size={2}>
      <span>{scopeText(user)}</span>
      {/* Учётка, которая не видит ничего: роль требует области, а области нет. Ради таких строк
          срез и читают, поэтому они помечены предупреждением, а не пропуском. */}
      {anomaly ? <Tag color="warning">{anomaly}</Tag> : null}
    </Space>
  );
}

/**
 * Модули, открытые субъекту. Цветом отмечены те, где он действует, серым — те, где только
 * смотрит: «видит» и «работает» — разные ответы, и в витрине их путать нельзя.
 */
function moduleTags(subject: AccessSubject) {
  const open = PERMISSION_MODULES.map((module) => ({
    module,
    access: moduleAccess(subject, module),
  })).filter((m) => m.access !== 'none');
  if (open.length === 0) return '—';
  return (
    <Space size={4} wrap>
      {open.map(({ module, access }) => (
        <Tag key={module} color={access === 'write' ? 'blue' : undefined}>
          {permissionModuleLabels[module]}
        </Tag>
      ))}
    </Space>
  );
}

/** Откуда у субъекта право — словами, с именем самой роли или надстройки: «почему» без имени неполно. */
function sourceText(subject: AccessSubject, permission: Permission): string {
  const origin = permissionSource(subject, permission);
  if (!origin) return '';
  if (origin.kind === 'addon') {
    return origin.addon ? `надстройка «${roleAddonLabels[origin.addon]}»` : 'надстройка';
  }
  if (origin.kind === 'counterparty') {
    return subject.counterpartyType
      ? `контрагент: ${counterpartyTypeLabels[subject.counterpartyType]}`
      : 'контрагент';
  }
  return subject.role ? `роль «${roleLabels[subject.role]}»` : 'роль';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </section>
  );
}

interface CardProps {
  /** `null` — карточка закрыта; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  user: UserDto | null;
  onClose: () => void;
}

/**
 * Карточка доступа: область словами, все права по модулям с источником у каждого и перечень
 * закрытых модулей. Окном просмотра, а не разворотом строки: набор прав администратора — это
 * четыре десятка строк, и в раскрытой строке таблицы он выдавил бы с экрана сам список.
 */
function AccessCard({ user, onClose }: CardProps) {
  const subject = user ? subjectOf(user) : null;
  const modules = subject
    ? PERMISSION_MODULES.map((module) => ({
        module,
        access: moduleAccess(subject, module),
        granted: PERMISSIONS_BY_MODULE[module].filter((p) => can(subject, p)),
      }))
    : [];
  const closed = modules.filter((m) => m.access === 'none');
  const open = modules.filter((m) => m.access !== 'none');
  const targets = user ? scopeTargets(user) : null;
  const anomaly = user ? scopeAnomaly(user) : null;

  return (
    <ViewModal
      title={user ? user.fullName : 'Доступ'}
      open={!!user}
      onClose={onClose}
      width={720}
      // Карточку переоткрывают на соседней учётке — содержимое прошлой ей не годится.
      destroyOnHidden
      footer={null}
    >
      {user && subject && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">{user.email}</Typography.Text>
            {roleTags(user)}
          </Space>

          <Section title="Область">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {describeAccessScope(subject).map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
            {targets?.axis ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary">
                  {scopeAxisTitles[targets.axis]}:{' '}
                </Typography.Text>
                {targets.items.length > 0 ? targets.items.join(', ') : 'не заданы'}
              </div>
            ) : null}
            {anomaly ? (
              <div style={{ marginTop: 8 }}>
                <Tag color="warning">{anomaly}</Tag>
              </div>
            ) : null}
          </Section>

          <Section title="Что может">
            {open.length === 0 ? (
              <Typography.Text type="secondary">
                Прав нет ни одного: без роли учётка для портала — никто.
              </Typography.Text>
            ) : (
              <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                {open.map(({ module, granted }) => (
                  <div key={module}>
                    <Typography.Text strong>{permissionModuleLabels[module]}</Typography.Text>
                    {granted.map((permission) => (
                      <div key={permission}>
                        {PERMISSION_CATALOG[permission].label}{' '}
                        {/* Источник права — мелким вторичным текстом: спрашивают его не в каждой
                            строке, но ответ должен стоять именно у той строки, о которой спросили. */}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {sourceText(subject, permission)}
                        </Typography.Text>
                      </div>
                    ))}
                  </div>
                ))}
              </Space>
            )}
          </Section>

          <Section title="Закрыто">
            {closed.length === 0 ? (
              <Typography.Text type="secondary">Закрытых модулей нет.</Typography.Text>
            ) : (
              <Space size={4} wrap>
                {closed.map(({ module }) => (
                  <Tag key={module}>{permissionModuleLabels[module]}</Tag>
                ))}
              </Space>
            )}
          </Section>
        </div>
      )}
    </ViewModal>
  );
}

const roleOptions = ROLES.map((role) => ({ value: role, label: roleLabels[role] }));

/**
 * Права списком выбора — группами по модулям: плоский список из четырёх десятков подписей
 * («Правит заявку на вывоз», «Правит заказ техники», «Правит состав недели») читается только
 * поиском, а искать в нём приходится как раз тогда, когда точной формулировки не помнят.
 */
const permissionOptions = PERMISSION_MODULES.map((module) => ({
  label: permissionModuleLabels[module],
  options: PERMISSIONS_BY_MODULE[module].map((permission) => ({
    value: permission,
    label: PERMISSION_CATALOG[permission].label,
  })),
})).filter((group) => group.options.length > 0);

export function AccessPeopleTab() {
  const { users, total, truncated, isFetching } = useAccessUsers();
  const [opened, setOpened] = useState<UserDto | null>(null);

  /**
   * Параметры списка тем же хуком, что у серверных таблиц: он держит страницу и её размер
   * одинаково на телефоне и на десктопе. Запрос от них не зависит — список приходит целиком, и
   * весь отбор идёт по загруженным учёткам.
   */
  const { params, setParams, onTableChange } = useListParams<{
    role?: Role;
    permission?: Permission;
    onlyActive: boolean;
    withAddons: boolean;
  }>({ onlyActive: true, withAddons: false }, { searchKeys: [] });

  /** Правка любого отбора возвращает на первую страницу: та же страница при другом наборе — уже другие строки. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const rows = useMemo(() => {
    const needle = (params.search ?? '').trim().toLowerCase();
    return (params.onlyActive ? activeUsers(users) : users).filter((user) => {
      if (needle && !`${user.fullName} ${user.email}`.toLowerCase().includes(needle)) return false;
      if (params.role && user.role !== params.role) return false;
      if (params.withAddons && user.addons.length === 0) return false;
      // «У кого есть право» спрашивается у матрицы, а не у списка ролей: право приходит и от типа
      // контрагента, и от надстройки, и отбор по роли этих учёток не нашёл бы.
      if (params.permission && !can(subjectOf(user), params.permission)) return false;
      return true;
    });
  }, [users, params.search, params.role, params.onlyActive, params.withAddons, params.permission]);

  /** Страницу режем сами: на телефоне список показывается карточками, и там таблица его не порежет. */
  const pageRows = rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  // Сортировки в колонках нет: список приходит упорядоченным по ФИО, а свой порядок пришлось бы
  // считать на клиенте — колонка-обманка, которая на нажатие не отвечает, хуже её отсутствия.
  const columns: TableColumnType<UserDto>[] = [
    textColumn<UserDto>({
      key: 'fullName',
      title: 'Сотрудник',
      dataIndex: 'fullName',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => personCell(r),
    }),
    textColumn<UserDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      sortable: false,
      searchable: false,
      width: 220,
      render: (_v, r) => roleTags(r),
    }),
    textColumn<UserDto>({
      key: 'scope',
      title: 'Область',
      dataIndex: 'constructionObjects',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => scopeCell(r),
    }),
    // Модули и число прав считает матрица — поля записи, из которого их взять, нет вовсе, поэтому
    // и `dataIndex` у этих колонок нет.
    {
      key: 'modules',
      title: 'Модули',
      render: (_v: unknown, r: UserDto) => moduleTags(subjectOf(r)),
    },
    {
      key: 'permissions',
      title: 'Прав',
      width: 90,
      align: 'right',
      render: (_v: unknown, r: UserDto) => grantedPermissions(subjectOf(r)).length,
    },
  ];

  const filters = (
    <Space wrap size={8}>
      {/* Отбор по мере набора: список уже на клиенте, и ждать Enter, чтобы сузить его, незачем. */}
      <Input
        allowClear
        placeholder="ФИО или почта"
        style={{ width: 240 }}
        value={params.search ?? ''}
        onChange={(e) => applyFilter({ search: e.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Все роли"
        style={{ width: 190 }}
        options={roleOptions}
        value={params.role}
        onChange={(v: Role | undefined) => applyFilter({ role: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="У кого есть право…"
        style={{ width: 280 }}
        options={permissionOptions}
        value={params.permission}
        onChange={(v: Permission | undefined) => applyFilter({ permission: v })}
      />
      <Checkbox
        checked={params.onlyActive}
        onChange={(e) => applyFilter({ onlyActive: e.target.checked })}
      >
        Только активные
      </Checkbox>
      <Checkbox
        checked={params.withAddons}
        onChange={(e) => applyFilter({ withAddons: e.target.checked })}
      >
        С надстройками
      </Checkbox>
    </Space>
  );

  /** Строка карточкой на телефоне (ADR 0042): роль — бейджем, остальное строками под ФИО. */
  const card: CardConfig<UserDto> = {
    title: (r) => r.fullName,
    badge: (r) => roleTags(r),
    primary: (r) => r.email,
    lines: [
      (r) => `Область: ${scopeText(r)}`,
      (r) => scopeAnomaly(r),
      (r) => moduleTags(subjectOf(r)),
      (r) => `Прав: ${grantedPermissions(subjectOf(r)).length}`,
    ],
    onOpen: (r) => setOpened(r),
  };

  return (
    <PageTableLayout
      filters={filters}
      toolbar={
        truncated ? (
          <Alert
            type="warning"
            showIcon
            message={`Учётных записей ${total}, показаны первые ${users.length}: витрина берёт список одной страницей.`}
          />
        ) : null
      }
    >
      <DataTable<UserDto>
        columns={columns}
        card={card}
        data={pageRows}
        total={rows.length}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onRowClick={(r) => setOpened(r)}
        onChange={onTableChange}
      />
      <AccessCard user={opened} onClose={() => setOpened(null)} />
    </PageTableLayout>
  );
}
