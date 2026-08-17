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
  type UserAccountDto,
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
import {
  accessGroups,
  accessKey,
  activeUsers,
  grantCodeLabel,
  useAccessUsers,
} from './accessOverview';

/**
 * Срез «Профили» вкладки «Права» (`docs/permissions-tab-plan.md` §1.2): сколько живых учёток стоит
 * за каждой строкой матрицы — и сколько их стоит за доступом, которого в матрице нет.
 *
 * Строка здесь — профиль доступа, а не учётка: людей под одной ролью бывают десятки, а вопрос
 * пересмотра ролей задают о самой роли. Отсюда три ответа, которых в списке учёток не видно ни
 * при какой сортировке: профиль, не занятый никем; профили, совпадающие по набору прав («Менеджер»
 * и «Диспетчер» — совпадение, зафиксированное в матрице осознанно, и здесь видно, стоит ли оно
 * двух ролей); вес роли — сколько прав она несёт и скольким людям выдана.
 *
 * **Перебор `ACCESS_PROFILES` остался, а вот множество субъектов перестало быть перечислимым**
 * (ADR 0106; §10.1 плана реструктуризации). Профили матрицы никуда не исчезли — они по-прежнему
 * отвечают, что даёт должность, — но живая учётка с назначенным полномочием ни в один из них не
 * попадает **по построению**: набор собирают в проде, и матрица о нём не знает. Поэтому занятость и
 * совпадения считаются по фактическим правам живых учёток (`accessKey`), а строки, которым в
 * матрице соответствия нет, — обычный вид работы, а не расхождение модели. Красным здесь помечается
 * только настоящая поломка: активная учётка без роли.
 *
 * Действий на срезе нет ни одного, и своего представления о правах — тоже: набор профилей и права
 * должности приходят вызовами матрицы, права людей — ответом сервера.
 */

/** Чем профиль отличается от голой роли — оси субъекта (ADR 0038, 0086, 0106). */
type ProfileAxis = 'role' | 'counterparty' | 'addon' | 'grant';

const axisLabels: Record<ProfileAxis, string> = {
  role: 'роль',
  counterparty: 'роль + тип контрагента',
  addon: 'роль + надстройка',
  // Четвёртая ось строки: доступ собран из роли и назначенных наборов. Профиля матрицы за ней нет —
  // и не будет, пока наборы заводят в проде.
  grant: 'роль + набор',
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
 * Производная часть строки. Права передаются, а не выводятся из субъекта: у профиля матрицы их
 * считает `permissionsFor`, у живой группы они пришли с сервера, и второй расчёт по роли вернул бы
 * группе не её права.
 */
function describeAccess(subject: AccessSubject, permissions: readonly Permission[]) {
  return {
    permissions,
    openModules: PERMISSION_MODULES.filter((module) => moduleAccess(subject, module) !== 'none')
      .length,
  };
}

interface ProfileRow {
  key: string;
  /**
   * Субъект строки. У профиля матрицы — он сам; у живой группы — её матричная тройка плюс
   * фактические права в `grantPermissions`: `moduleAccess` и `describeAccessScope` спрашивают права
   * через `can`, и на голой тройке они рассказали бы про группу не то, что она может.
   */
  subject: AccessSubject;
  label: string;
  axis: ProfileAxis | null;
  permissions: readonly Permission[];
  openModules: number;
  users: UserAccountDto[];
  /** Строки с ровно тем же набором прав — подписями. */
  twins: string[];
  /** Строки в матрице нет: доступ собран наборами (норма) либо у учётки нет роли (поломка). */
  offMatrix: boolean;
  /** Наборы, которые есть у учёток группы, — объяснение, откуда взялась строка вне матрицы. */
  grantCodes: string[];
  /**
   * Сколько живых учёток носит эту роль — с любым набором прав. Стоит рядом с «не занят» и держит
   * его от неверного чтения: незанятый профиль больше не значит «роль пустует», потому что учётки
   * этой роли могли уйти в собранные строки выше.
   */
  roleUsers: number;
}

interface ProfileTable {
  rows: ProfileRow[];
  /** Профилей матрицы без единой живой учётки. */
  unused: number;
  /** Строк, собранных наборами: профиля матрицы у них нет по построению. */
  assembled: number;
  /** Групп строк, совпадающих по набору прав; в группе всегда больше одного. */
  twinGroups: number;
}

function buildRows(users: readonly UserAccountDto[]): ProfileTable {
  /*
   * Занятость — по живым учёткам и по их фактическим правам: срез отвечает на «кто сейчас может
   * ровно это». Выключенная учётка профиль не занимает; удалённых пакетные читатели сервера не
   * отсекают, поэтому отбор делает витрина.
   *
   * Ключ у обеих сторон сопоставления один (`accessKey`) — роль, тип контрагента и отпечаток прав.
   * Прежняя тройка «роль + контрагент + надстройки» здесь стала бы ложью: два штаба с одним ключом
   * получают разные права, если одному выдали набор.
   */
  const live = activeUsers(users);
  const usage = new Map(accessGroups(live).map((group) => [group.key, group]));
  // Учётки по ролям — знаменатель для «не занят»: роль, ушедшая в собранные строки, не пустует.
  const roleCounts = new Map<string, number>();
  for (const user of live) {
    const role = user.role ?? 'none';
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }

  const profiles = ACCESS_PROFILES.map((subject) => {
    const permissions = permissionsFor(subject);
    return {
      subject,
      // Ключ профиля считается по правам, которые даёт матрица: попадёт в него живая группа или
      // нет — вопрос совпадения прав, а не совпадения надстроек.
      key: accessKey({ ...subject, permissions }),
      label: accessProfileLabel(subject),
      axis: axisOf(subject),
      ...describeAccess(subject, permissions),
    };
  });

  /**
   * Живые группы, которым в матрице соответствия нет. Их два вида, и путать их нельзя: доступ,
   * собранный наборами, — обычное дело (профиля матрицы у него нет по построению), а активная
   * учётка без роли — поломка, о которой витрина обязана сказать. Смысл среза в том, чтобы
   * показывать и то и другое, а не подтверждать, что расхождений не бывает.
   */
  const known = new Set(profiles.map((profile) => profile.key));
  const strays = [...usage.values()]
    .filter((group) => !known.has(group.key))
    .map((group) => {
      // Права группы — в субъекте: только с ними `moduleAccess` покажет модуль, открытый набором, а
      // `describeAccessScope` не соврёт про доступ к удалённым записям.
      const subject: AccessSubject = { ...group.subject, grantPermissions: group.permissions };
      const grantCodes = [...new Set(group.users.flatMap((user) => user.grantCodes))].sort();
      return {
        key: group.key,
        subject,
        label: group.label,
        users: group.users,
        // Ось строки: наборы объясняют её появление здесь, и называть её «ролью» значило бы
        // умолчать о единственной причине, по которой она не сошлась с матрицей.
        axis: grantCodes.length > 0 ? ('grant' as const) : axisOf(subject),
        offMatrix: true,
        grantCodes,
        ...describeAccess(subject, group.permissions),
      };
    });

  /*
   * Совпадения ищутся группировкой по отпечатку прав, а не сравнением каждой строки с каждой:
   * перебор пар в рендере пересчитывался бы на каждую перерисовку и рос бы квадратом от их числа.
   *
   * В группировку входят и живые строки: «у штаба с набором ровно права диспетчера» — тот же вывод
   * пересмотра, что «Менеджер и Диспетчер совпадают», и добывается он только так. Отпечаток берётся
   * от прав без роли: роль в ключе строки стоит ради области, а совпадение — про сами права.
   */
  const labelsBySignature = new Map<string, string[]>();
  for (const row of [...profiles, ...strays]) {
    const signature = row.permissions.join('|');
    labelsBySignature.set(signature, [...(labelsBySignature.get(signature) ?? []), row.label]);
  }
  const twinsOf = (row: { label: string; permissions: readonly Permission[] }) =>
    // Подпись у каждой строки своя (роль, роль — контрагент, роль + надстройка), поэтому себя из
    // группы довольно отсечь по ней.
    (labelsBySignature.get(row.permissions.join('|')) ?? []).filter((label) => label !== row.label);

  const matrixRows: ProfileRow[] = profiles.map((profile) => ({
    ...profile,
    users: usage.get(profile.key)?.users ?? [],
    twins: twinsOf(profile),
    offMatrix: false,
    // Наборы профиля матрицы — не его свойство: он описывает должность, а наборы выдают людям.
    grantCodes: [],
    roleUsers: roleCounts.get(profile.subject.role ?? 'none') ?? 0,
  }));
  const strayRows: ProfileRow[] = strays.map((stray) => ({
    ...stray,
    twins: twinsOf(stray),
    // У собранной строки знаменатель не нужен: её учётки — вот они, в самой строке.
    roleUsers: stray.users.length,
  }));

  return {
    // Строки вне матрицы — первыми: они про живых людей, а профили матрицы никуда не денутся.
    rows: [...strayRows, ...matrixRows],
    unused: matrixRows.filter((row) => row.users.length === 0).length,
    assembled: strayRows.filter((row) => row.grantCodes.length > 0).length,
    twinGroups: [...labelsBySignature.values()].filter((group) => group.length > 1).length,
  };
}

/**
 * Занятость профиля. Ноль — это вывод, а не пустая клетка, и выглядеть он должен пометкой; рядом
 * стоит число учёток самой роли, если они есть. Без него «не занят» читалось бы как «роль никому не
 * выдана», хотя выдана она может быть многим — просто с другим набором прав, и все они собрались в
 * строке выше.
 */
function usersCell(row: ProfileRow, pending: boolean) {
  if (pending) return '…';
  if (row.users.length > 0) return row.users.length;
  return (
    <Space direction="vertical" size={0}>
      <Tag>не занят</Tag>
      {row.roleUsers > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          у роли учёток: {row.roleUsers}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

/**
 * Строка вне матрицы бывает трёх видов, и в один тег их сводить нельзя: собранный наборами доступ —
 * норма, учётка без роли — поломка, а роль без наборов, права которой всё равно не совпали с
 * матрицей, — расхождение, о котором стоит спросить (право сняли выкатом, набор отвязали в базе).
 */
const offMatrixMarks = {
  noRole: { label: 'роль не назначена', color: 'red' },
  // Цвет спокойный, и слово выбрано так, чтобы не читаться как ошибка: профиля матрицы у такого
  // доступа нет по построению — наборы собирают в проде, а матрица о них не знает.
  assembled: { label: 'собран наборами', color: 'blue' },
  drift: { label: 'не сходится с матрицей', color: 'orange' },
} as const;

/** Пометка строки — одна на таблицу и на карточку: два слова про одно и то же разъехались бы. */
function offMatrixMark(row: ProfileRow): { label: string; color: string } | null {
  if (!row.offMatrix) return null;
  if (!row.subject.role) return offMatrixMarks.noRole;
  return row.grantCodes.length > 0 ? offMatrixMarks.assembled : offMatrixMarks.drift;
}

function offMatrixTag(row: ProfileRow) {
  const mark = offMatrixMark(row);
  return mark ? <Tag color={mark.color}>{mark.label}</Tag> : null;
}

/** Тот же ответ словами — первой строкой карточки: её открывают как раз с вопросом «что это такое». */
function offMatrixText(row: ProfileRow): string {
  if (!row.subject.role) {
    return 'У учётки не назначена роль: для портала она никто, а активной такой быть не должно.';
  }
  if (row.grantCodes.length > 0) {
    return `Профиля матрицы у этого доступа нет: он собран из должности и наборов (${row.grantCodes
      .map(grantCodeLabel)
      .join(', ')}). Так и работает свободная сборка полномочий — расхождением это не является.`;
  }
  return 'Права этих учёток не совпали ни с одним профилем матрицы, хотя наборов у них нет: стоит проверить, не снято ли право выкатом и не правили ли выдачи в базе.';
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
      {/* Строка вне матрицы объясняется первой строкой карточки: администратор открывает её как раз
          с вопросом «что это такое», и ответ «доступ собран наборами» должен стоять до прав. */}
      {row.offMatrix ? (
        <Typography.Text type="secondary">{offMatrixText(row)}</Typography.Text>
      ) : null}

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
              Профиль не занят: живых учёток ровно с этим набором прав нет.
              {row.roleUsers > 0
                ? ` Саму роль носят ${row.roleUsers} — с другим набором прав, и они стоят в строках выше.`
                : ''}
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
  const { rows, unused, assembled, twinGroups } = useMemo(() => buildRows(users), [users]);

  const [openedKey, setOpenedKey] = useState<string | null>(null);
  // Открытая строка ищется по ключу, а не запоминается объектом: список учёток перечитывается, и
  // запомненная строка осталась бы с прежним числом людей.
  const opened = rows.find((row) => row.key === openedKey) ?? null;

  const columns = [
    textColumn<ProfileRow>({
      key: 'label',
      title: 'Профиль',
      dataIndex: 'label',
      // Ни сортировки, ни поиска: строки приходят целиком и в содержательном порядке — сперва
      // собранные наборами (они про живых людей), затем профили матрицы в порядке её объявления,
      // где варианты одной роли стоят рядом с ней.
      sortable: false,
      searchable: false,
      width: 280,
      render: (_v, r) => (
        <Space size={4} wrap>
          <span>{r.label}</span>
          {offMatrixTag(r)}
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
      (r) => offMatrixMark(r)?.label ?? null,
      (r) => (r.axis ? `Ось: ${axisLabels[r.axis]}` : null),
      (r) => (r.twins.length > 0 ? `Совпадает с: ${r.twins.join(', ')}` : null),
    ],
    onOpen: (r) => setOpenedKey(r.key),
  };

  /**
   * Сводка — то, ради чего срез открывают: ответы «сколько ролей пустует», «сколько доступов собрано
   * наборами» и «сколько строк дублируют друг друга» не должны требовать чтения всей таблицы.
   */
  const summary = (
    <SummaryBar
      title="Профилей"
      items={[
        { label: 'Всего в матрице', value: ACCESS_PROFILES.length },
        { label: 'Не заняты', value: pending ? '…' : unused },
        // Собранные строки — числом, а не только тегами в таблице: с назначаемыми полномочиями это
        // самая живая часть среза, и её рост — то, что смотрят при пересмотре ролей.
        { label: 'Собраны наборами', value: pending ? '…' : assembled },
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
