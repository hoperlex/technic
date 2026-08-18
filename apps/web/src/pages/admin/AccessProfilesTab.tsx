import { useMemo, useState } from 'react';
import { Alert, Space, Tag, Typography } from 'antd';
import {
  ACCESS_PROFILES,
  describeAccessScope,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
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
import { grantCodeLabel, useAccessUsers } from './accessOverview';
import { axisLabels, buildRows, type ProfileRow } from './profileRows';

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
