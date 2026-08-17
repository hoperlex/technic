import { useMemo, useState } from 'react';
import { Alert, Checkbox, Input, Select, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS,
  permissionActionLabels,
  permissionModuleLabels,
  permissionsFor,
  profilesWith,
  type Permission,
  type PermissionAction,
  type PermissionModule,
  type UserAccountDto,
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
import {
  activeUsers,
  grantOnlyPermissions,
  hasAllPermissions,
  permissionHolders,
  subjectOf,
  useAccessUsers,
} from './accessOverview';

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

/**
 * Профили матрицы, которым открыто всё, — сегодня это один администратор.
 *
 * Выводятся из матрицы, а не задаются именем роли. Пометка отвечает на «право заперто у того, кому
 * и так можно всё», и держаться она должна на самой модели: сравнение с `'admin'` строкой было бы
 * второй копией знания о ролях на витрине — ровно тем, чего вкладка избегает. Заведут вторую
 * всесильную роль или сузят администратора — пометка ответит правильно без правки этого файла.
 *
 * Одной матрицы для пометки, однако, **уже недостаточно**: живая учётка получает права набором, и
 * профиль «Штаб» с выданным «Аудитором» в этот список не попадёт никогда. Поэтому матрица здесь
 * отвечает только за подпись и за первую половину условия, а вторую — «нет ли держателя за пределами
 * полного доступа» — считает `buildRows` по фактическим правам живых учёток.
 */
const FULL_ACCESS_LABELS = ACCESS_PROFILES.filter(
  (subject) => permissionsFor(subject).length === PERMISSIONS.length,
).map(accessProfileLabel);
const FULL_ACCESS = new Set(FULL_ACCESS_LABELS);

/** Пометки строки: то, ради чего таблицу и читают. */
type Mark = 'locked' | 'granted' | 'unused';

const markLabels: Record<Mark, string> = {
  // Подпись собирается из самих профилей полного доступа: имя администратора в ней — вывод из
  // матрицы, а не слово, набранное в вёрстке.
  locked: `Только ${FULL_ACCESS_LABELS.map((label) => `«${label}»`).join(' и ')}`,
  // Право, которое кому-то дала не должность, а набор. Пометка не предупреждение, а ответ на вопрос
  // пересмотра «что уже раздают полномочиями»: с §10.1 плана этот срез — единственное место, где
  // такую выдачу видно, потому что перебирать субъектов статически больше нельзя.
  granted: 'Выдано набором',
  unused: 'Ни у кого из живых',
};

const markColors: Record<Mark, string> = { locked: 'orange', granted: 'blue', unused: 'red' };

const moduleOptions = PERMISSION_MODULES.map((module) => ({
  value: module,
  label: permissionModuleLabels[module],
}));

const actionOptions = PERMISSION_ACTIONS.map((action) => ({
  value: action,
  label: permissionActionLabels[action],
}));

/**
 * Держатель права: учётка и ответ на «должность ли это». Признак считается один раз на всю таблицу
 * (`grantOnlyPermissions` перебирает права учётки), а не в ячейке на каждую перерисовку.
 */
interface PermissionHolder {
  user: UserAccountDto;
  /** Право у него есть, а должность его не даёт: единственный доказуемо наборный случай. */
  byGrant: boolean;
}

interface PermissionRow {
  permission: Permission;
  label: string;
  module: PermissionModule;
  action: PermissionAction;
  /** Субъекты матрицы с этим правом — подписями. */
  profiles: string[];
  /** Живые учётки с этим правом — по списку прав, который посчитал сервер. */
  holders: PermissionHolder[];
  locked: boolean;
  /** Хотя бы одному держателю право дала не должность, а набор. */
  byGrant: boolean;
}

interface PermissionTable {
  rows: PermissionRow[];
  locked: number;
  granted: number;
  unused: number;
}

/**
 * Разбор всего словаря разом: держатели раскладываются одним проходом по учёткам
 * (`permissionHolders`), и делать это в ячейке значило бы пересобирать всю раскладку на каждую
 * перерисовку.
 */
function buildRows(users: readonly UserAccountDto[]): PermissionTable {
  // Держатели — только живые учётки: срез отвечает на «кто сейчас владеет правом», выключенная
  // учётка права не занимает, а удалённых пакетные читатели сервера не отсекают вовсе.
  const live = activeUsers(users);
  const holders = permissionHolders(live);
  /*
   * Учётки, которым открыто всё, — по их правам, а не по имени роли. Ради этого множества пометка и
   * переписана: «второй всесильный субъект», собранный наборами, в `ACCESS_PROFILES` не появится
   * никогда, и матрица про него промолчала бы — то есть инвариант защищённых прав (§8, инвариант 5)
   * остался бы без единственного экрана, который его проверяет.
   */
  const omnipotent = new Set(live.filter(hasAllPermissions).map((user) => user.id));
  // Доказуемо наборные права каждой учётки — один раз на список, а не на каждую строку словаря:
  // иначе тот же перебор повторялся бы пятьдесят семь раз.
  const byGrant = new Map(live.map((user) => [user.id, new Set(grantOnlyPermissions(user))]));

  const rows = PERMISSIONS.map((permission) => {
    const profiles = profilesWith(permission).map(accessProfileLabel);
    const held = (holders.get(permission) ?? []).map((user) => ({
      user,
      byGrant: byGrant.get(user.id)?.has(permission) ?? false,
    }));
    return {
      permission,
      ...PERMISSION_CATALOG[permission],
      profiles,
      holders: held,
      byGrant: held.some((holder) => holder.byGrant),
      /*
       * «Заперто у полного доступа» — утверждение о двух половинах модели сразу, и обе обязаны его
       * подтвердить: право положено только всесильным профилям **и** ни одна живая учётка за
       * пределами полного доступа им не владеет. Проверь одну матрицу — и пометка промолчит о
       * держателе от набора, ровно там, ради чего заведена; проверь одних держателей — и она
       * пропадёт на праве, которого пока ни у кого нет, хотя матрица уже заперла его в
       * администраторе.
       *
       * Пустой список профилей пометкой не считается: право без единого профиля — это не «заперто у
       * администратора», а строка, до которой не дотянулась ни одна роль.
       */
      locked:
        profiles.length > 0 &&
        profiles.every((label) => FULL_ACCESS.has(label)) &&
        held.every((holder) => omnipotent.has(holder.user.id)),
    };
  });

  return {
    rows,
    locked: rows.filter((row) => row.locked).length,
    granted: rows.filter((row) => row.byGrant).length,
    unused: rows.filter((row) => row.holders.length === 0).length,
  };
}

/** Пометки строки. Пока список учёток не приехал, «ни у кого» означало бы загрузку, а не вывод. */
function marksOf(row: PermissionRow, pending: boolean): Mark[] {
  const marks: Mark[] = [];
  if (row.locked) marks.push('locked');
  if (row.byGrant) marks.push('granted');
  if (!pending && row.holders.length === 0) marks.push('unused');
  return marks;
}

/** Число держателей. Ноль — это вывод, а не пустая клетка, и выглядеть он должен пометкой. */
function holdersCell(row: PermissionRow, pending: boolean) {
  if (pending) return '…';
  return row.holders.length > 0 ? row.holders.length : <Tag>нет</Tag>;
}

/** Кто владеет правом: профили матрицы и живые учётки под ними. */
function PermissionDetails({ row, pending }: { row: PermissionRow; pending: boolean }) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Text type="secondary">
          {row.permission} · {permissionModuleLabels[row.module]} ·{' '}
          {permissionActionLabels[row.action]}
        </Typography.Text>
      </div>

      <div>
        <Typography.Text strong>Профили матрицы ({row.profiles.length})</Typography.Text>
        <div style={{ marginTop: 4 }}>
          {row.profiles.length > 0 ? (
            <Space size={[4, 4]} wrap>
              {row.profiles.map((label) => (
                <Tag key={label} color={FULL_ACCESS.has(label) ? 'magenta' : undefined}>
                  {label}
                </Tag>
              ))}
            </Space>
          ) : (
            // «Ни у одного профиля» больше не значит «ни у кого»: право может прийти набором,
            // которого в матрице нет. Ответ на «пользуется ли им кто-нибудь» стоит ниже, в списке
            // держателей, и путать эти два ответа нельзя.
            <Typography.Text type="secondary">
              Права нет ни у одного профиля матрицы: по должности оно не положено никому.
            </Typography.Text>
          )}
        </div>
      </div>

      <div>
        <Typography.Text strong>Учётки ({pending ? '…' : row.holders.length})</Typography.Text>
        <div style={{ marginTop: 4 }}>
          {row.holders.length > 0 ? (
            // Роль рядом с каждым именем: держателей одного права набирают несколько профилей
            // сразу, и без неё список не отвечает, кто из них кто. Держателю, которому право дала не
            // должность, дописано «набором» — это ответ на «почему он здесь», и без него строка
            // выглядела бы ошибкой матрицы.
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              {row.holders.map(({ user, byGrant }) => (
                <div key={user.id}>
                  {user.fullName}{' '}
                  <Typography.Text type="secondary">
                    — {accessProfileLabel(subjectOf(user))}
                    {byGrant ? ', набором' : ''}
                  </Typography.Text>
                </div>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {pending
                ? 'Учётки ещё загружаются'
                : 'Живых учёток с этим правом нет: право заведено, но им никто не пользуется.'}
            </Typography.Text>
          )}
        </div>
      </div>
    </Space>
  );
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
        <Space direction="vertical" size={0}>
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
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
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
          message={`Учтены не все учётки: показаны первые ${users.length} из ${total}`}
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
