import { useMemo, useState } from 'react';
import { Alert, Checkbox, Input, Select, Space, type TableColumnType } from 'antd';
import {
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  roleLabels,
  ROLES,
  type Permission,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { DataTable, PageTableLayout, textColumn, type CardConfig } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  activeUsers,
  grantCodeLabel,
  scopeAnomaly,
  scopeText,
  useAccessUsers,
} from './accessOverview';
import { AccessCard } from './AccessPersonCard';
import { grantTags, moduleTags, personCell, roleTags, scopeCell } from './accessPeopleCells';

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
            title={`Учётных записей ${total}, показаны первые ${users.length}: витрина берёт список одной страницей.`}
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
