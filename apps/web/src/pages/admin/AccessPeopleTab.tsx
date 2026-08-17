import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Checkbox, Input, Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import {
  counterpartyTypeLabels,
  describeAccessScope,
  moduleAccess,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  permissionSources,
  roleAddonColors,
  roleAddonLabels,
  roleColors,
  roleLabels,
  ROLES,
  type AccessSubject,
  type Permission,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { DataTable, PageTableLayout, textColumn, ViewModal, type CardConfig } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  activeUsers,
  effectiveSubject,
  grantCodeLabel,
  scopeAnomaly,
  scopeAxisTitles,
  scopeTargets,
  scopeText,
  sourceSubject,
  useAccessUsers,
} from './accessOverview';

/**
 * Срез «Люди» вкладки «Права» (`docs/permissions-tab-plan.md` §1.1): учётка × доступ.
 *
 * Экран отвечает на два вопроса, ради которых сегодня читают `permissions.ts` и ходят в базу: что
 * человек может и **почему** он это может. Второй важнее: право приходит из роли, из типа
 * контрагента, из надстройки или из назначенного полномочия (ADR 0038, 0086, 0106), и при
 * пересмотре ролей решает именно это различие, а не сам факт доступа. Поэтому источники подписаны у
 * каждого права в карточке — все, а не первый найденный: право, которое даёт и должность, и набор,
 * подписанное одной должностью, отвечало бы на «что уйдёт при отзыве набора» прямо наоборот.
 *
 * **Что человек может — говорит сервер** (`permissions` учётки), а матрица объясняет, чем это
 * вызвано (`permissionSources`, `moduleAccess`, `describeAccessScope`). Со свободной сборкой
 * полномочий второе из первого не выводится: состав набора лежит в базе, матрица его не знает.
 * Отсюда и граница обязанностей — экран не считает доступ и не заводит своего представления о
 * правах: список «что может штаб», написанный на портале, разошёлся бы с моделью ровно в тот
 * момент, когда по нему принимают решение.
 *
 * Ни одного действия здесь нет: выдача и отзыв прав — предмет отдельной панели, и смешивать её с
 * анализом нельзя, пока роли не пересмотрены.
 */

/**
 * Роль и надстройки одной ячейкой (ADR 0086) — теми же пометками, что в списке учёток: строку
 * ищут глазами по цвету роли, и вторая раскраска сбивала бы. Подписи и цвета берутся из
 * контрактов; повторена здесь только вёрстка — в «Учётных записях» она внутренняя функция экрана,
 * и вытаскивать её наружу ради витрины значило бы править соседний файл.
 */
function roleTags(user: UserAccountDto) {
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

function personCell(user: UserAccountDto) {
  return (
    <Space direction="vertical" size={0}>
      <span>{user.fullName}</span>
      <Typography.Text type="secondary">{user.email}</Typography.Text>
    </Space>
  );
}

function scopeCell(user: UserAccountDto) {
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
 * Модули, открытые учётке. Цветом отмечены те, где она действует, серым — те, где только смотрит:
 * «видит» и «работает» — разные ответы, и в витрине их путать нельзя.
 *
 * Считается по серверному списку прав (`effectiveSubject`), а не по роли: модуль, открытый набором,
 * до этого показывался закрытым — то есть витрина отвечала «раздела у него нет» про человека,
 * которому раздел открыт.
 */
function moduleTags(user: UserAccountDto) {
  const subject = effectiveSubject(user);
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

/** Наборы учётки: у системных — подпись, у собранного администратором — код (имён витрина не знает). */
function grantTags(user: UserAccountDto) {
  if (user.grantCodes.length === 0) return '—';
  return (
    <Space size={4} wrap>
      {user.grantCodes.map((code) => (
        <Tag key={code}>{grantCodeLabel(code)}</Tag>
      ))}
    </Space>
  );
}

/**
 * Откуда у субъекта право — **всеми** источниками сразу, с именем роли или надстройки: «почему» без
 * имени неполно, а «почему» одним источником из четырёх — неверно.
 *
 * Набор подписан без имени: сервер отдаёт объединение прав всех наборов учётки, а не разбивку
 * «какое право из какого» (`PermissionOrigin.grantCode` не заполнен ни у кого), и придумать её
 * витрине нечем — состав набора лежит в базе. Какие наборы у человека есть, говорит соседняя
 * колонка и строка «Наборы» в карточке.
 */
function sourceText(subject: AccessSubject, permission: Permission): string {
  return permissionSources(subject, permission)
    .map((origin) => {
      if (origin.kind === 'addon') {
        return origin.addon ? `надстройка «${roleAddonLabels[origin.addon]}»` : 'надстройка';
      }
      if (origin.kind === 'grant') {
        return origin.grantCode ? `набор «${grantCodeLabel(origin.grantCode)}»` : 'набор';
      }
      if (origin.kind === 'counterparty') {
        return subject.counterpartyType
          ? `контрагент: ${counterpartyTypeLabels[subject.counterpartyType]}`
          : 'контрагент';
      }
      return subject.role ? `роль «${roleLabels[subject.role]}»` : 'роль';
    })
    .join(' · ');
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
  user: UserAccountDto | null;
  onClose: () => void;
}

/**
 * Карточка доступа: область словами, все права по модулям с источником у каждого и перечень
 * закрытых модулей. Окном просмотра, а не разворотом строки: набор прав администратора — это
 * четыре десятка строк, и в раскрытой строке таблицы он выдавил бы с экрана сам список.
 */
function AccessCard({ user, onClose }: CardProps) {
  /*
   * Два субъекта на одну карточку, и это не дублирование. Первый отвечает по правам сервера — им
   * считаются открытые модули и область; второй объясняет источники, и в нём наборам отданы только
   * те права, которых матрица объяснить не может. Подставь список сервера в источники — и «набор»
   * стал бы подписью у каждого права, включая ролевые.
   */
  const subject = user ? effectiveSubject(user) : null;
  const origins = user ? sourceSubject(user) : null;
  // Права — из ответа сервера, а не из матрицы: строка карточки обязана перечислять то, что человек
  // действительно может, а объяснение к ней стоит рядом и может быть неполным.
  const held = new Set<Permission>(user?.permissions ?? []);
  const modules = subject
    ? PERMISSION_MODULES.map((module) => ({
        module,
        access: moduleAccess(subject, module),
        granted: PERMISSIONS_BY_MODULE[module].filter((p) => held.has(p)),
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
      {user && subject && origins && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">{user.email}</Typography.Text>
            {roleTags(user)}
          </Space>

          {/* Наборы (ADR 0106) — рядом с ролью, а не в конце: с ними человек может больше, чем его
              должность, и читать список прав, не зная о них, значит приписывать всё роли. */}
          <Section title="Наборы">
            {user.grantCodes.length === 0 ? (
              <Typography.Text type="secondary">
                Наборов нет: всё, что человек может, идёт от должности.
              </Typography.Text>
            ) : (
              <Space direction="vertical" size={4}>
                {grantTags(user)}
                {/* Ограничение названо прямо: витрина знает, какие наборы выданы, но не знает их
                    состава — сервер отдаёт объединение прав, а не разбивку по наборам. Догадка «это
                    право, наверное, из этого набора» была бы хуже честного молчания: по ней решают,
                    что отзывать. */}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Какое право пришло каким набором, витрина не знает: набор подписан у тех прав,
                  которых должность не даёт.
                </Typography.Text>
              </Space>
            )}
          </Section>

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
                          {sourceText(origins, permission)}
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
  const [opened, setOpened] = useState<UserAccountDto | null>(null);

  /**
   * Параметры списка тем же хуком, что у серверных таблиц: он держит страницу и её размер
   * одинаково на телефоне и на десктопе. Запрос от них не зависит — список приходит целиком, и
   * весь отбор идёт по загруженным учёткам.
   */
  const { params, setParams, onTableChange } = useListParams<{
    role?: Role;
    permission?: Permission;
    onlyActive: boolean;
    /** Только держатели наборов — любых, а не одних системных (см. отбор ниже). */
    withGrants: boolean;
  }>({ onlyActive: true, withGrants: false }, { searchKeys: [] });

  /** Правка любого отбора возвращает на первую страницу: та же страница при другом наборе — уже другие строки. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const rows = useMemo(() => {
    const needle = (params.search ?? '').trim().toLowerCase();
    return (params.onlyActive ? activeUsers(users) : users).filter((user) => {
      if (needle && !`${user.fullName} ${user.email}`.toLowerCase().includes(needle)) return false;
      if (params.role && user.role !== params.role) return false;
      /*
       * «С наборами» спрашивает коды наборов, а не пометки надстроек: пометка отвечает только за два
       * системных набора, и собранный администратором в неё не попадает вовсе. Отбор по пометкам
       * прятал бы ровно тех держателей, ради которых его открывают.
       */
      if (params.withGrants && user.grantCodes.length === 0) return false;
      // «У кого есть право» спрашивается у серверного списка прав, а не у роли и не у матрицы: право
      // приходит и от типа контрагента, и от надстройки, и от набора, собранного в проде, — и
      // держателей от набора матрица не нашла бы вовсе.
      if (params.permission && !user.permissions.includes(params.permission)) return false;
      return true;
    });
  }, [users, params.search, params.role, params.onlyActive, params.withGrants, params.permission]);

  /** Страницу режем сами: на телефоне список показывается карточками, и там таблица его не порежет. */
  const pageRows = rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  // Сортировки в колонках нет: список приходит упорядоченным по ФИО, а свой порядок пришлось бы
  // считать на клиенте — колонка-обманка, которая на нажатие не отвечает, хуже её отсутствия.
  const columns: TableColumnType<UserAccountDto>[] = [
    textColumn<UserAccountDto>({
      key: 'fullName',
      title: 'Сотрудник',
      dataIndex: 'fullName',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => personCell(r),
    }),
    textColumn<UserAccountDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      sortable: false,
      searchable: false,
      width: 220,
      render: (_v, r) => roleTags(r),
    }),
    // Наборы (ADR 0106) отдельной колонкой, хотя пометки системных стоят и в колонке роли: там они
    // повторяют список учёток, а здесь стоит полный ответ на «что человеку выдано» — вместе с
    // наборами, собранными администратором, которых в пометках нет и быть не может.
    {
      key: 'grants',
      title: 'Наборы',
      width: 200,
      render: (_v: unknown, r: UserAccountDto) => grantTags(r),
    },
    textColumn<UserAccountDto>({
      key: 'scope',
      title: 'Область',
      dataIndex: 'constructionObjects',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => scopeCell(r),
    }),
    // Модули складываются из прав учётки, а поля с ними в записи нет — отсюда колонка без
    // `dataIndex`. Число прав берётся из самого списка: считать его матрицей значило бы показать
    // другое число, чем то, по которому сервер разрешает запросы.
    {
      key: 'modules',
      title: 'Модули',
      render: (_v: unknown, r: UserAccountDto) => moduleTags(r),
    },
    {
      key: 'permissions',
      title: 'Прав',
      width: 90,
      align: 'right',
      render: (_v: unknown, r: UserAccountDto) => r.permissions.length,
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
        checked={params.withGrants}
        onChange={(e) => applyFilter({ withGrants: e.target.checked })}
      >
        С наборами
      </Checkbox>
    </Space>
  );

  /** Строка карточкой на телефоне (ADR 0042): роль — бейджем, остальное строками под ФИО. */
  const card: CardConfig<UserAccountDto> = {
    title: (r) => r.fullName,
    badge: (r) => roleTags(r),
    primary: (r) => r.email,
    lines: [
      (r) => `Область: ${scopeText(r)}`,
      (r) => scopeAnomaly(r),
      // Наборы строкой, а не молча: на телефоне колонок нет, и без этой строки доступ, пришедший
      // набором, выглядел бы прибавкой к роли неизвестно откуда.
      (r) =>
        r.grantCodes.length > 0 ? `Наборы: ${r.grantCodes.map(grantCodeLabel).join(', ')}` : null,
      (r) => moduleTags(r),
      (r) => `Прав: ${r.permissions.length}`,
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
      <DataTable<UserAccountDto>
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
