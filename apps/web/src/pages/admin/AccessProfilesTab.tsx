import { useMemo, useState } from 'react';
import { Alert, Space, Tag, Typography } from 'antd';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  describeAccessScope,
  moduleAccess,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  permissionsFor,
  type AccessSubject,
  type Permission,
  type UserDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import {
  DataTable,
  PageTableLayout,
  SummaryBar,
  textColumn,
  ViewModal,
  type CardConfig,
} from '@shared/ui';
import { activeUsers, profileUsage, useAccessUsers } from './accessOverview';

/**
 * Срез «Профили» вкладки «Права» (`docs/permissions-tab-plan.md` §1.2): сколько живых учёток стоит
 * за каждой строкой матрицы.
 *
 * Строка здесь — профиль доступа, а не учётка: людей под одной ролью бывают десятки, а вопрос
 * пересмотра ролей задают о самой роли. Отсюда три ответа, которых в списке учёток не видно ни
 * при какой сортировке: профиль, не занятый никем; профили, совпадающие по набору прав («Менеджер»
 * и «Диспетчер» — совпадение, зафиксированное в матрице осознанно, и здесь видно, стоит ли оно
 * двух ролей); вес роли — сколько прав она несёт и скольким людям выдана.
 *
 * Действий на срезе нет ни одного, и своего представления о правах — тоже: и набор профилей, и их
 * права приходят вызовами матрицы. Список ролей, переписанный сюда, разошёлся бы с моделью и врал
 * бы ровно в тот момент, когда по витрине принимают решение.
 */

/** Чем профиль отличается от голой роли — третья ось субъекта (ADR 0038, 0086). */
type ProfileAxis = 'role' | 'counterparty' | 'addon';

const axisLabels: Record<ProfileAxis, string> = {
  role: 'роль',
  counterparty: 'роль + тип контрагента',
  addon: 'роль + надстройка',
};

/**
 * Ось выводится из самого субъекта, а не из списка ролей: заведут вторую надстройку или откроют
 * учётки ещё одному типу контрагента — строка ответит правильно без правки витрины.
 */
function axisOf(subject: AccessSubject): ProfileAxis | null {
  if (!subject.role) return null;
  if (subject.counterpartyType) return 'counterparty';
  if ((subject.addons ?? []).length > 0) return 'addon';
  return 'role';
}

/**
 * Ключ субъекта — то, чем он различим для матрицы: роль, тип контрагента и набор надстроек.
 * Субъекты с одинаковым ключом отвечают на `can` одинаково, и по нему профиль матрицы стыкуется с
 * живыми учётками.
 *
 * Своя функция, а не `profileKey` из `accessOverview`: та считает то же самое, но по учётке, а
 * профиль матрицы учёткой не притворяется. Обе стороны сопоставления ключуются здесь одной и той
 * же функцией — двум разным разъехаться было бы нечем.
 */
function subjectKey(subject: AccessSubject): string {
  return [
    subject.role ?? 'none',
    subject.counterpartyType ?? '-',
    [...(subject.addons ?? [])].sort().join('+'),
  ].join('|');
}

/** Производная часть строки: считается одинаково и для профиля матрицы, и для строки вне её. */
function describeSubject(subject: AccessSubject) {
  return {
    axis: axisOf(subject),
    permissions: permissionsFor(subject),
    openModules: PERMISSION_MODULES.filter((module) => moduleAccess(subject, module) !== 'none')
      .length,
  };
}

interface ProfileRow {
  key: string;
  subject: AccessSubject;
  label: string;
  axis: ProfileAxis | null;
  permissions: readonly Permission[];
  openModules: number;
  users: UserDto[];
  /** Профили с ровно тем же набором прав — подписями. */
  twins: string[];
  /** Строки в матрице нет: так показываются живые учётки, которым в модели нет соответствия. */
  offMatrix: boolean;
}

interface ProfileTable {
  rows: ProfileRow[];
  /** Профилей матрицы без единой живой учётки. */
  unused: number;
  /** Групп профилей, совпадающих по набору прав; в группе всегда больше одного. */
  twinGroups: number;
}

function buildRows(users: readonly UserDto[]): ProfileTable {
  // Занятость — по живым учёткам: срез отвечает на «кто сейчас под этой ролью», и выключенная
  // учётка роль не занимает.
  const usage = new Map(
    profileUsage(activeUsers(users)).map((entry) => [subjectKey(entry.subject), entry]),
  );

  const profiles = ACCESS_PROFILES.map((subject) => {
    const described = describeSubject(subject);
    return {
      subject,
      key: subjectKey(subject),
      label: accessProfileLabel(subject),
      // Отпечаток набора прав: `permissionsFor` отдаёт права в порядке объявления матрицы, одном
      // для любого субъекта, — значит одинаковым наборам отвечает одинаковая строка.
      signature: described.permissions.join('|'),
      ...described,
    };
  });

  // Совпадения ищутся группировкой по отпечатку, а не сравнением каждого профиля с каждым:
  // перебор пар в рендере пересчитывался бы на каждую перерисовку и рос бы квадратом от их числа.
  const labelsBySignature = new Map<string, string[]>();
  for (const profile of profiles) {
    labelsBySignature.set(profile.signature, [
      ...(labelsBySignature.get(profile.signature) ?? []),
      profile.label,
    ]);
  }

  const rows = profiles.map(({ signature, ...profile }) => ({
    ...profile,
    users: usage.get(profile.key)?.users ?? [],
    // Подпись у каждого профиля своя (роль, роль — контрагент, роль + надстройка), поэтому себя
    // из группы довольно отсечь по ней.
    twins: (labelsBySignature.get(signature) ?? []).filter((label) => label !== profile.label),
    offMatrix: false,
  }));

  /**
   * Живые учётки, которым в матрице соответствия нет. Сегодня это учётка без роли: активной такой
   * быть не должно — API её не активирует, — и промолчать о ней витрина не может. Смысл среза в
   * том, чтобы показывать расхождения, а не подтверждать, что их не бывает.
   */
  const known = new Set(profiles.map((profile) => profile.key));
  const strays: ProfileRow[] = [...usage.values()]
    .filter((entry) => !known.has(subjectKey(entry.subject)))
    .map((entry) => ({
      key: subjectKey(entry.subject),
      subject: entry.subject,
      label: entry.label,
      users: entry.users,
      // Совпадения считаются только между строками матрицы: строка вне её — сообщение о
      // расхождении, и «совпадает с» у неё означало бы, что такой профиль в модели есть.
      twins: [],
      offMatrix: true,
      ...describeSubject(entry.subject),
    }));

  return {
    // Расхождения — первыми: в хвосте таблицы предупреждение прочитают последним, если вообще.
    rows: [...strays, ...rows],
    unused: rows.filter((row) => row.users.length === 0).length,
    twinGroups: [...labelsBySignature.values()].filter((group) => group.length > 1).length,
  };
}

/** Занятость профиля. Ноль — это вывод, а не пустая клетка, и выглядеть он должен пометкой. */
function usersCell(row: ProfileRow, pending: boolean) {
  if (pending) return '…';
  if (row.users.length === 0) return <Tag>не занят</Tag>;
  return row.users.length;
}

/**
 * Карточка профиля: что он может и кому выдан. Права сгруппированы по модулям и названы подписями
 * каталога — код права здесь не показывается, читают карточку не по нему.
 */
function ProfileDetails({ row }: { row: ProfileRow }) {
  const granted = new Set(row.permissions);
  const modules = PERMISSION_MODULES.map((module) => ({
    module,
    permissions: PERMISSIONS_BY_MODULE[module].filter((permission) => granted.has(permission)),
  })).filter((group) => group.permissions.length > 0);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Область стоит рядом с правами намеренно: совпадение по набору прав ещё не делает профили
          одинаковыми — «Менеджер» и «Диспетчер» различаются как раз тем, над какими строками эти
          права действуют, и без области вывод «роли одинаковы» был бы неверным. */}
      <div>
        <Typography.Text strong>Область</Typography.Text>
        <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
          {describeAccessScope(row.subject).map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </div>

      {modules.map(({ module, permissions }) => (
        <div key={module}>
          <Typography.Text strong>{permissionModuleLabels[module]}</Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Space size={[4, 4]} wrap>
              {permissions.map((permission) => (
                <Tag key={permission}>{PERMISSION_CATALOG[permission].label}</Tag>
              ))}
            </Space>
          </div>
        </div>
      ))}
      {modules.length === 0 && (
        <Typography.Text type="secondary">
          Прав нет ни одного: в портале такая учётка не может ничего.
        </Typography.Text>
      )}

      <div>
        <Typography.Text strong>Учётки ({row.users.length})</Typography.Text>
        <div style={{ marginTop: 4 }}>
          {row.users.length > 0 ? (
            <Typography.Text>{row.users.map((user) => user.fullName).join(', ')}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">
              Профиль не занят: живых учёток с ним нет.
            </Typography.Text>
          )}
        </div>
      </div>
    </Space>
  );
}

export function AccessProfilesTab() {
  const { users, total, truncated, isFetching } = useAccessUsers();
  /** Список ещё не приехал: «не занят» на пустом списке означал бы не пустой профиль, а загрузку. */
  const pending = isFetching && users.length === 0;
  const { rows, unused, twinGroups } = useMemo(() => buildRows(users), [users]);

  const [openedKey, setOpenedKey] = useState<string | null>(null);
  // Открытая строка ищется по ключу, а не запоминается объектом: список учёток перечитывается, и
  // запомненная строка осталась бы с прежним числом людей.
  const opened = rows.find((row) => row.key === openedKey) ?? null;

  const columns = [
    textColumn<ProfileRow>({
      key: 'label',
      title: 'Профиль',
      dataIndex: 'label',
      // Ни сортировки, ни поиска: строки — сама матрица, они приходят целиком и в порядке её
      // объявления. Порядок тут содержательный — варианты одной роли стоят рядом с ней.
      sortable: false,
      searchable: false,
      width: 280,
      render: (_v, r) => (
        <Space size={4} wrap>
          <span>{r.label}</span>
          {r.offMatrix && <Tag color="red">вне матрицы</Tag>}
        </Space>
      ),
    }),
    textColumn<ProfileRow>({
      key: 'axis',
      title: 'Ось',
      dataIndex: 'axis',
      sortable: false,
      searchable: false,
      width: 200,
      render: (_v, r) => (r.axis ? axisLabels[r.axis] : '—'),
    }),
    textColumn<ProfileRow>({
      key: 'permissions',
      title: 'Прав',
      dataIndex: 'permissions',
      sortable: false,
      searchable: false,
      width: 80,
      render: (_v, r) => r.permissions.length,
    }),
    textColumn<ProfileRow>({
      key: 'modules',
      title: 'Модули',
      dataIndex: 'openModules',
      sortable: false,
      searchable: false,
      width: 110,
      // Со знаменателем: «5» без него читается как пять закрытых ровно так же, как пять открытых.
      render: (_v, r) => `${r.openModules} из ${PERMISSION_MODULES.length}`,
    }),
    textColumn<ProfileRow>({
      key: 'users',
      title: 'Учёток',
      dataIndex: 'users',
      sortable: false,
      searchable: false,
      width: 110,
      render: (_v, r) => usersCell(r, pending),
    }),
    textColumn<ProfileRow>({
      key: 'twins',
      title: 'Совпадает с',
      dataIndex: 'twins',
      sortable: false,
      searchable: false,
      render: (_v, r) => (r.twins.length > 0 ? r.twins.join(', ') : '—'),
    }),
  ];

  /** Строка профиля карточкой на телефоне (ADR 0042). */
  const card: CardConfig<ProfileRow> = {
    title: (r) => r.label,
    // Справа — занятость: ради неё срез и открывают, и первой она должна читаться и здесь.
    badge: (r) => usersCell(r, pending),
    primary: (r) =>
      `Прав: ${r.permissions.length} · модулей: ${r.openModules} из ${PERMISSION_MODULES.length}`,
    lines: [
      (r) => (r.offMatrix ? 'Такого профиля в матрице нет' : null),
      (r) => (r.axis ? `Ось: ${axisLabels[r.axis]}` : null),
      (r) => (r.twins.length > 0 ? `Совпадает с: ${r.twins.join(', ')}` : null),
    ],
    onOpen: (r) => setOpenedKey(r.key),
  };

  /**
   * Сводка — то, ради чего срез открывают: ответы «сколько ролей пустует» и «сколько профилей
   * дублируют друг друга» не должны требовать чтения всей таблицы.
   */
  const summary = (
    <SummaryBar
      title="Профилей"
      items={[
        { label: 'Всего', value: ACCESS_PROFILES.length },
        { label: 'Не заняты', value: pending ? '…' : unused },
        { label: 'Совпадают', value: twinGroups },
      ]}
    />
  );

  return (
    <PageTableLayout filters={summary}>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`Учтены не все учётки: показаны первые ${users.length} из ${total}`}
          description="Счётчики людей и пометка «не занят» посчитаны по этой части списка — профиль мог остаться пустым только из-за среза."
        />
      )}
      <DataTable<ProfileRow>
        rowKey="key"
        columns={columns}
        card={card}
        data={rows}
        total={rows.length}
        loading={isFetching}
        page={1}
        pageSize={DICTIONARY_PAGE_SIZE}
        onChange={() => {
          /* Матрица приходит целиком и уже упорядоченной: листать и сортировать нечего. */
        }}
        onRowClick={(row) => setOpenedKey(row.key)}
      />
      <ViewModal
        title={opened?.label ?? ''}
        open={!!opened}
        onClose={() => setOpenedKey(null)}
        destroyOnHidden
      >
        {opened && <ProfileDetails row={opened} />}
      </ViewModal>
    </PageTableLayout>
  );
}
