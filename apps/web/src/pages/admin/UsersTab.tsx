import { useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Checkbox,
  DatePicker,
  Dropdown,
  Form,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import { DeleteFilled, MoreOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  EMAIL_VERIFICATION_ENABLED,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  REGISTRATION_ROLE_REQUESTS,
  registrationRequestDetail,
  registrationRoleRequestLabels,
  ROLES,
  roleColors,
  roleLabels,
  type UserDto,
} from '@technic/contracts';
import { counterpartiesApi, usersApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { PasswordField } from '../../components/PasswordField';
import { PersonNameFields } from '../../components/PersonNameFields';
import { PhoneField, PhoneLink } from '../../components/PhoneField';
import { ReasonModal } from '../../components/CancelReasonModal';
import { actionsColumn, badgeColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { UserAvatar } from '../../components/UserAvatar';
import { errorMessage } from '../../utils/format';
import { objectsApi, objectKeys } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';

interface UserFormValues {
  email: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  /** Контактный телефон (ADR 0043) — необязателен: у заведённых до него учёток его нет. */
  phone?: string;
  role: (typeof ROLES)[number];
  password?: string;
  /** Объекты учётки (ADR 0039): объектная роль работает сразу на нескольких площадках. */
  constructionObjectIds?: string[];
  /** Отделы учётки (ADR 0040): вторая ось области — вместо объектов, а не вместе с ними. */
  departmentIds?: string[];
  /**
   * Контрагент учётки: обязателен для внешнего исполнителя (ADR 0010). Его тип задаёт модуль,
   * в котором учётка работает, — вывоз мусора или заказ ТС (ADR 0038).
   */
  counterpartyId?: string | null;
  isActive: boolean;
}

/** Заявка на регистрацию: человек зарегистрировался сам, роли ему ещё не назначили. */
const isPendingRegistration = (u: UserDto) => !u.isActive && !u.role;

/**
 * Уточнение из заявки — свободный текст, а не ссылка на справочник: список объектов
 * неаутентифицированному не отдаётся (ADR 0034), сопоставляет его администратор.
 */
function requestedDetailText(u: UserDto): string | undefined {
  if (!u.requestedRole) return undefined;
  const detail = registrationRequestDetail[u.requestedRole];
  if (detail === 'object' && u.requestedObject) return `Объект: ${u.requestedObject}`;
  if (detail === 'company' && u.requestedCompany) return `Компания: ${u.requestedCompany}`;
  return undefined;
}

export function UsersTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { user: currentUser, can } = useAuth();
  const { params, setParams, setSort, onTableChange } = useListParams<{
    role?: string;
    isActive?: string;
    pending?: string;
    constructionObjectId?: string;
    counterpartyId?: string;
    requestedRole?: string;
    createdFrom?: string;
    createdTo?: string;
    includeDeleted?: string;
    // Все фильтры задаются панелью над таблицей: объект и контрагент выбирают поиском по списку,
    // а в выпадашку заголовка столбца такой список не помещается — и на телефоне её нет вовсе.
    // Дублировать их там же нельзя: в onChange таблицы приходит пустой фильтр, и любая сортировка
    // сбрасывала бы выбранное.
  }>({}, { searchKeys: [] });

  /** Правка любого фильтра возвращает на первую страницу: та же страница при другом наборе — уже другие записи. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const showPending = params.pending === 'true';
  const canSeeArchive = can('archive.read');
  // Видеть архив и распоряжаться им — разные права (ADR 0021): восстановление отдельно.
  const canRestore = can('archive.restore');

  const { data, isFetching } = useQuery({
    queryKey: ['users', params],
    queryFn: () => usersApi.list(params),
  });

  // Счётчик нерассмотренных заявок: он же рисуется бейджем в меню администрирования.
  const { data: pending } = useQuery({
    queryKey: ['users', 'pending-count'],
    queryFn: () => usersApi.pendingCount(),
  });

  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const { data: departmentOptions, isLoading: departmentsLoading } =
    useQuery(departmentOptionsQuery());
  // Учётку исполнителя привязываем к контрагенту, за которого в портале работают: оператор
  // вывоза и арендодатель ТС (ADR 0038). У подрядчика заявок нет ни в одном модуле.
  const { data: executors, isLoading: executorsLoading } = useQuery({
    queryKey: ['counterparties', 'executors-for-select'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const objectOptions = (objects?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));
  // Группами по типу: тип решает, что учётка сможет делать, поэтому выбор идёт «сначала кем,
  // потом кого», а не по одному плоскому списку, где два вида исполнителей перемешаны.
  const executorGroups = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((type) => ({
    label: counterpartyTypeLabels[type],
    options: (executors?.items ?? [])
      .filter((c) => c.type === type)
      .map((c) => ({ value: c.id, label: `${c.name} (ИНН ${c.inn})` })),
  })).filter((g) => g.options.length > 0);
  const executorCount = executorGroups.reduce((n, g) => n + g.options.length, 0);
  const roleOptions = ROLES.map((r) => ({ value: r, label: roleLabels[r] }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<UserDto | null>(null);
  const [form] = Form.useForm<UserFormValues>();
  const watchRole = Form.useWatch('role', form);

  const [pwUser, setPwUser] = useState<UserDto | null>(null);
  const [pwForm] = Form.useForm<{ newPassword: string }>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      constructionObjectIds: [],
      departmentIds: [],
    } as Partial<UserFormValues>);
    setOpen(true);
  };
  const openEdit = (r: UserDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      email: r.email,
      lastName: r.lastName,
      firstName: r.firstName,
      middleName: r.middleName,
      phone: r.phone,
      // Роль по умолчанию не подставляем: у зарегистрировавшегося самостоятельно её нет,
      // а активация без осознанно выбранной роли запрещена — пусть выберет администратор.
      role: r.role ?? undefined,
      constructionObjectIds: r.constructionObjects.map((o) => o.id),
      departmentIds: r.departments.map((d) => d.id),
      counterpartyId: r.counterpartyId,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: UserFormValues) => {
      const payload = {
        ...values,
        // Пустое поле уходит пустой строкой, а не `undefined`: у правки это разные вещи —
        // «телефон стёрли» и «телефон не трогали» (ADR 0043).
        phone: values.phone ?? '',
        // Область чужой оси обнуляется здесь же: сменив роль с объектной на отдельскую, форма
        // не должна отправлять оставшийся от прежней роли набор — сервер его всё равно отвергнет
        // как несовместимую пару (ADR 0040).
        constructionObjectIds: isObjectScopedRole(values.role)
          ? (values.constructionObjectIds ?? [])
          : [],
        departmentIds: isDepartmentScopedRole(values.role) ? (values.departmentIds ?? []) : [],
        counterpartyId: isCounterpartyScopedRole(values.role)
          ? (values.counterpartyId ?? null)
          : null,
      };
      if (record) {
        const { password: _pw, email: _email, ...rest } = payload;
        return usersApi.update(record.id, rest);
      }
      return usersApi.create(payload as Required<UserFormValues>);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['users'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const toggleActiveMut = useMutation({
    mutationFn: (r: UserDto) => usersApi.update(r.id, { isActive: !r.isActive }),
    onSuccess: () => {
      message.success('Готово');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      message.success('Пользователь удалён');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Возврат из архива (ADR 0063). Гасится тот же ключ `['users']`, что и остальными действиями:
   * им же накрыт счётчик заявок — восстановленный отказ возвращается в очередь, и бейдж обязан
   * это показать.
   */
  const restoreMut = useMutation({
    mutationFn: (id: string) => usersApi.restore(id),
    onSuccess: () => {
      message.success('Учётная запись восстановлена — она осталась неактивной');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0063) — общий хук справочников: подтверждение необратимого действия
  // должно звучать везде одинаково.
  const purge = usePurgeAction({
    subject: 'учётную запись',
    purge: usersApi.purge,
    invalidate: [['users']],
  });

  const [rejecting, setRejecting] = useState<UserDto | null>(null);
  const rejectMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) => usersApi.reject(v.id, v.reason),
    onSuccess: () => {
      message.success('Заявка отклонена');
      setRejecting(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const passwordMut = useMutation({
    mutationFn: (v: { id: string; newPassword: string }) =>
      usersApi.setPassword(v.id, v.newPassword),
    onSuccess: () => {
      message.success('Пароль изменён. Пользователь должен сменить его при входе.');
      setPwUser(null);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Что можно сделать со строкой. Список один на оба режима: на десктопе он раскрывается меню,
   * на телефоне — шитом с подписями (ADR 0030 п. 6, ADR 0042). Расходиться им нельзя — иначе
   * «Отклонить заявку» существовало бы только с мышью.
   */
  const rowActions = (r: UserDto) => {
    const isSelf = r.id === currentUser?.id;
    const pendingRegistration = isPendingRegistration(r);
    const remove = () =>
      modal.confirm({
        title: `Удалить пользователя ${r.email}?`,
        content: 'Аккаунт будет деактивирован (soft-delete).',
        okText: 'Удалить',
        okButtonProps: { danger: true },
        cancelText: 'Отмена',
        onOk: () => removeMut.mutateAsync(r.id),
      });
    return [
      {
        key: 'edit',
        label: pendingRegistration ? 'Рассмотреть заявку' : 'Редактировать',
        onClick: () => openEdit(r),
      },
      {
        key: 'password',
        label: 'Сменить пароль',
        onClick: () => {
          pwForm.resetFields();
          setPwUser(r);
        },
      },
      {
        key: 'toggle',
        label: r.isActive ? 'Деактивировать' : 'Активировать',
        disabled: isSelf && r.isActive,
        onClick: () => {
          // Активация без роли запрещена (сервер её отклонит): у самостоятельно
          // зарегистрировавшегося пользователя роли нет, поэтому активируем через форму.
          if (!r.isActive && !r.role) {
            message.info('Назначьте роль — без неё учётку активировать нельзя');
            openEdit(r);
          } else {
            void toggleActiveMut.mutate(r);
          }
        },
      },
      // Отказ по нерассмотренной заявке и удаление сотрудника — разные события: в аудите
      // остаётся причина отказа, и путать их не нужно ни администратору, ни разбору потом.
      ...(pendingRegistration
        ? [
            {
              key: 'reject',
              label: 'Отклонить заявку',
              danger: true,
              onClick: () => setRejecting(r),
            },
          ]
        : [{ key: 'delete', label: 'Удалить', danger: true, disabled: isSelf, onClick: remove }]),
    ];
  };

  /**
   * Что можно сделать с архивной строкой (ADR 0063): вернуть из архива и снести насовсем. Список
   * тот же, что рисуют кнопки в таблице, — и права те же, каждое своё.
   */
  const archivedRowActions = (r: UserDto) => [
    ...(canRestore
      ? [{ key: 'restore', label: 'Восстановить', onClick: () => restoreMut.mutate(r.id) }]
      : []),
    ...(purge.allowed
      ? [
          {
            key: 'purge',
            label: 'Удалить окончательно',
            danger: true,
            onClick: () => purge.confirm(r.id, r.email),
          },
        ]
      : []),
  ];

  const rowMenu = (r: UserDto) => {
    const actions = rowActions(r);
    return {
      items: actions.map(({ key, label, danger, disabled }) => ({
        key,
        label,
        danger,
        disabled,
      })),
      onClick: ({ key }: { key: string }) => actions.find((a) => a.key === key)?.onClick(),
    };
  };

  const columns = [
    textColumn<UserDto>({
      key: 'email',
      title: 'Email',
      dataIndex: 'email',
      searchable: false,
      width: 220,
    }),
    textColumn<UserDto>({
      key: 'fullName',
      title: 'ФИО',
      dataIndex: 'fullName',
      searchable: false,
      render: (_v, r) => (
        <Space size={8}>
          <UserAvatar name={r.fullName} size="small" />
          <span>{r.fullName}</span>
          {isPendingRegistration(r) ? (
            <Badge
              color="gold"
              text={
                r.requestedRole
                  ? `Заявка: ${registrationRoleRequestLabels[r.requestedRole]}`
                  : 'Заявка'
              }
            />
          ) : null}
        </Space>
      ),
    }),
    // Телефон (ADR 0043): администратор рассматривает заявку и звонит с этой же страницы, поэтому
    // номер стоит в списке, а не только в карточке. Сортировки нет — по номеру не упорядочивают,
    // и `USER_SORT_FIELDS` его не принимает.
    textColumn<UserDto>({
      key: 'phone',
      title: 'Телефон',
      dataIndex: 'phone',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_v, r) => (r.phone ? <PhoneLink phone={r.phone} /> : '—'),
    }),
    badgeColumn<UserDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      labels: roleLabels,
      colors: roleColors,
      width: 150,
    }),
    textColumn<UserDto>({
      key: 'scope',
      title: 'Область',
      dataIndex: 'constructionObjects',
      // Одна колонка на обе оси, а не две: они взаимоисключающие (ADR 0040), и вторая стояла бы
      // пустой у всех, кроме отделов. Сортировать по набору нечем — «Объект1, Объект7» и
      // «Объект2» сравнимы только выбранным наугад представителем (ADR 0039).
      sortable: false,
      searchable: false,
      // Отделы стоят кодами, объекты — наименованиями: так их и называют в работе. Полные
      // наименования отделов — подсказкой наведения, они нужны для сверки, а не для узнавания.
      render: (_v, r) => {
        if (r.departments.length > 0) {
          return (
            <span title={r.departments.map((d) => d.name).join(' · ')}>
              {r.departments.map((d) => d.code).join(' · ')}
            </span>
          );
        }
        const objects = r.constructionObjects;
        return objects.length === 0 ? '—' : objects.map((o) => o.name).join(' · ');
      },
    }),
    textColumn<UserDto>({
      key: 'counterpartyName',
      title: 'Контрагент',
      dataIndex: 'counterpartyName',
      searchable: false,
      // Тип рядом с наименованием: у исполнителя он и есть ответ на «что эта учётка ведёт».
      render: (_v, r) =>
        r.counterpartyName
          ? counterpartyTypeHasAccounts(r.counterpartyType)
            ? `${r.counterpartyName} — ${counterpartyTypeLabels[r.counterpartyType]}`
            : r.counterpartyName
          : '—',
    }),
    boolBadgeColumn<UserDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      width: 120,
    }),
    // Подтверждение адреса (ADR 0072): пока его нет, заявку не активировать — и администратор
    // должен видеть это в списке, а не узнавать из отказа при попытке выдать доступ. Пока
    // подтверждение выключено (EMAIL_VERIFICATION_ENABLED), колонки нет: активации она не мешает,
    // а «не подтверждён» у свежей заявки означало бы то, чего портал уже не требует.
    ...(EMAIL_VERIFICATION_ENABLED
      ? [
          textColumn<UserDto>({
            key: 'emailVerifiedAt',
            title: 'Адрес',
            dataIndex: 'emailVerifiedAt',
            sortable: false,
            searchable: false,
            width: 140,
            render: (_v, r) =>
              r.emailVerifiedAt ? (
                <Tag color="green">подтверждён</Tag>
              ) : (
                <Tag color="orange">не подтверждён</Tag>
              ),
          }),
        ]
      : []),
    // Дата регистрации: по ней фильтруют период, и без колонки фильтр не на что опереть —
    // отобранные строки выглядели бы отобранными неизвестно по чему.
    textColumn<UserDto>({
      key: 'createdAt',
      title: 'Зарегистрирован',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_v, r) => dayjs(r.createdAt).format('DD.MM.YYYY'),
    }),
    actionsColumn<UserDto>(
      (r) =>
        r.deletedAt ? (
          // Архивная строка (ADR 0063): вернуть из архива и снести насовсем. Восстановление не
          // активирует — отклонённая заявка возвращается в очередь и рассматривается заново.
          <Space size={4}>
            <Tag>в архиве</Tag>
            {canRestore ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                title="Восстановить"
                loading={restoreMut.isPending}
                onClick={() => restoreMut.mutate(r.id)}
              />
            ) : null}
            {purge.allowed ? (
              <Button
                size="small"
                danger
                icon={<DeleteFilled />}
                title="Удалить окончательно"
                loading={purge.pending}
                onClick={() => purge.confirm(r.id, r.email)}
              />
            ) : null}
          </Space>
        ) : (
          <Dropdown menu={rowMenu(r)} trigger={['click']}>
            <Button size="small" icon={<MoreOutlined />} />
          </Dropdown>
        ),
      140,
    ),
  ];

  const statusOptions = [
    { value: 'true', label: 'Активные' },
    { value: 'false', label: 'Неактивные' },
  ];
  // Пожелание указывают при саморегистрации (ADR 0034): у заведённых администратором его нет,
  // поэтому фильтр показывается только в режиме заявок — в общем списке он молча отрезал бы всех.
  const requestedRoleOptions = REGISTRATION_ROLE_REQUESTS.map((v) => ({
    value: v,
    label: registrationRoleRequestLabels[v],
  }));

  const setPending = (next: boolean) =>
    applyFilter({
      pending: next ? 'true' : undefined,
      // Пожелание уходит вместе с режимом заявок: контрола, которым его снять, на общем списке
      // уже нет, а оставленный фильтр сузил бы список молча.
      requestedRole: next ? params.requestedRole : undefined,
    });

  /* Заявки лежат в общем списке вперемешку с сотрудниками, а рассматривают их отдельным
     заходом — поэтому переключатель во всю ширину, а не ещё один выпадающий список. */
  const pendingSwitch = (
    <Segmented
      value={showPending ? 'pending' : 'all'}
      onChange={(v) => setPending(v === 'pending')}
      options={[
        { value: 'all', label: 'Все' },
        {
          value: 'pending',
          label: (
            <Space size={6}>
              Ожидают активации
              {pending?.count ? <Badge count={pending.count} color="gold" /> : null}
            </Space>
          ),
        },
      ]}
    />
  );

  const filters = (
    <Space wrap size={8}>
      {pendingSwitch}
      <Input.Search
        allowClear
        // Номер ищется по цифрам: написание — «+7», «8», скобки — значения не имеет.
        placeholder="Email, ФИО или телефон"
        style={{ width: 240 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v || undefined })}
      />
      <Select
        allowClear
        placeholder="Все роли"
        style={{ width: 190 }}
        options={roleOptions}
        value={params.role}
        onChange={(v: string | undefined) => applyFilter({ role: v })}
      />
      <Select
        allowClear
        placeholder="Активные и нет"
        style={{ width: 150 }}
        options={statusOptions}
        value={params.isActive}
        onChange={(v: string | undefined) => applyFilter({ isActive: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 220 }}
        options={objectOptions}
        loading={objectsLoading}
        value={params.constructionObjectId}
        onChange={(v: string | undefined) => applyFilter({ constructionObjectId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все контрагенты"
        style={{ width: 240 }}
        options={executorGroups}
        loading={executorsLoading}
        value={params.counterpartyId}
        onChange={(v: string | undefined) => applyFilter({ counterpartyId: v })}
      />
      {showPending ? (
        <Select
          allowClear
          placeholder="Любое пожелание"
          style={{ width: 220 }}
          options={requestedRoleOptions}
          value={params.requestedRole}
          onChange={(v: string | undefined) => applyFilter({ requestedRole: v })}
        />
      ) : null}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Зарегистрирован с', 'по']}
        value={[
          params.createdFrom ? dayjs(params.createdFrom) : null,
          params.createdTo ? dayjs(params.createdTo) : null,
        ]}
        onChange={(range) =>
          applyFilter({
            createdFrom: range?.[0]?.format('YYYY-MM-DD'),
            createdTo: range?.[1]?.format('YYYY-MM-DD'),
          })
        }
      />
      {canSeeArchive ? (
        <Checkbox
          checked={params.includeDeleted === 'true'}
          onChange={(e) => applyFilter({ includeDeleted: e.target.checked ? 'true' : undefined })}
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'toggle',
      key: 'pending',
      label: 'Только ожидающие активации',
      value: showPending,
      onChange: setPending,
    },
    {
      kind: 'select',
      key: 'role',
      label: 'Роль',
      value: params.role,
      options: roleOptions,
      placeholder: 'Все роли',
      onChange: (v) => applyFilter({ role: v }),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Статус',
      value: params.isActive,
      options: statusOptions,
      placeholder: 'Активные и нет',
      onChange: (v) => applyFilter({ isActive: v }),
    },
    {
      kind: 'select',
      key: 'constructionObjectId',
      label: 'Объект',
      value: params.constructionObjectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      loading: objectsLoading,
      onChange: (v) => applyFilter({ constructionObjectId: v }),
    },
    {
      kind: 'select',
      key: 'counterpartyId',
      label: 'Контрагент',
      value: params.counterpartyId,
      options: executorGroups,
      placeholder: 'Все контрагенты',
      loading: executorsLoading,
      onChange: (v) => applyFilter({ counterpartyId: v }),
    },
    ...(showPending
      ? [
          {
            kind: 'select' as const,
            key: 'requestedRole',
            label: 'Пожелание при регистрации',
            value: params.requestedRole,
            options: requestedRoleOptions,
            placeholder: 'Любое пожелание',
            onChange: (v: string | undefined) => applyFilter({ requestedRole: v }),
          },
        ]
      : []),
    {
      kind: 'dateRange',
      key: 'createdAt',
      label: 'Зарегистрирован',
      from: params.createdFrom,
      to: params.createdTo,
      onChange: (createdFrom, createdTo) => applyFilter({ createdFrom, createdTo }),
    },
    ...(canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              applyFilter({ includeDeleted: checked ? 'true' : undefined }),
          },
        ]
      : []),
  ];

  /**
   * Карточка учётной записи на телефоне (ADR 0042). Заголовок — ФИО: список читают по людям, а
   * email нужен вторым. Нерассмотренная заявка на регистрацию помечена прямо в шапке: в общем
   * списке она лежит вперемешку с сотрудниками и отличается только этим.
   */
  const card: CardConfig<UserDto> = {
    title: (r) => (
      <Space size={8}>
        <UserAvatar name={r.fullName} size="small" />
        <span>{r.fullName}</span>
      </Space>
    ),
    badge: (r) =>
      isPendingRegistration(r) ? (
        <Tag color="gold">Ждёт активации</Tag>
      ) : (
        <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Активен' : 'Отключён'}</Tag>
      ),
    primary: (r) => (r.role ? <Tag color={roleColors[r.role]}>{roleLabels[r.role]}</Tag> : '—'),
    lines: [
      (r) => r.email,
      // Номер нажимается: карточку читают с телефона, и звонок — то, ради чего его и оставляли.
      (r) => (r.phone ? <PhoneLink phone={r.phone} /> : null),
      (r) => {
        // Область: отделы (ADR 0040) либо объекты — показывается то, что у учётки заполнено.
        const places = r.departments.length > 0 ? r.departments : r.constructionObjects;
        return places.length > 0 ? places.map((p) => p.name).join(' · ') : null;
      },
      (r) =>
        r.counterpartyName
          ? counterpartyTypeHasAccounts(r.counterpartyType)
            ? `${r.counterpartyName} — ${counterpartyTypeLabels[r.counterpartyType]}`
            : r.counterpartyName
          : null,
      (r) =>
        r.requestedRole ? `Пожелание: ${registrationRoleRequestLabels[r.requestedRole]}` : null,
      (r) => (r.deletedAt ? 'В архиве' : null),
    ],
    // Карточка архивной строки не открывается на правку, но действия у неё те же, что в таблице
    // (ADR 0063): расходиться режимам нельзя — иначе восстановление существовало бы только с мышью.
    onOpen: (r) => (r.deletedAt ? undefined : openEdit(r)),
    actions: (r) => (r.deletedAt ? archivedRowActions(r) : rowActions(r)),
  };

  return (
    <PageTableLayout
      filters={filters}
      // На телефоне список читается карточками, поиск — строкой в панели, остальные фильтры и
      // сортировка — шитами (ADR 0042).
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Email, ФИО или телефон',
          onChange: (v) => applyFilter({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { fullName: 'ФИО' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: {
          label: 'Добавить пользователя',
          icon: <PlusOutlined />,
          onClick: openCreate,
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
      }
    >
      <DataTable<UserDto>
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

      <FormModal
        title={record ? 'Редактирование пользователя' : 'Новый пользователь'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        // Шире стандартных 480: набор полей здесь задан заранее и целиком, и в 480 px подписи
        // вида «Объекты (для роли «Руководитель строительства»)» и подсказка о пожелании
        // заявителя переносились по слогам. Плотный ритм полей — по той же причине: окно
        // рассмотрения заявки читают целиком, а не листают.
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          className="form-dense"
          onFinish={(v) => saveMut.mutate(v)}
        >
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите email' }]}
          >
            <Input disabled={!!record} />
          </Form.Item>
          <PersonNameFields />
          {/* Контакт сотрудника (ADR 0043): необязателен и здесь — заведённые администратором
              учётки живут без него, а дозаполняется он той же формой. */}
          <PhoneField extra="Не обязательно. Портал писем не шлёт — связываются звонком" />
          {/* Пожелание заявителя (ADR 0034) — справка, а не подстановка: роль остаётся выбором
              администратора, иначе «Сохранить» не глядя выдавало бы права по чужому заявлению. */}
          {record?.requestedRole ? (
            // Одной строкой, а не парой «заголовок + описание»: справка на полторы строки
            // занимала блоком высоту целого поля и выдавливала конец формы под прокрутку.
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={[
                `При регистрации указал: ${registrationRoleRequestLabels[record.requestedRole]}`,
                requestedDetailText(record),
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          ) : null}
          <Form.Item
            name="role"
            label="Роль"
            rules={[{ required: true, message: 'Выберите роль' }]}
          >
            <AutoSelect options={roleOptions} />
          </Form.Item>
          {/* Объектные роли («Штаб», «Руководитель строительства») работают в пределах своих
              объектов — без них учётку не активировать (ADR 0025, ADR 0039). Список, а не один
              объект: штаб ведёт несколько площадок, и вторая учётка на того же человека была бы
              вторым паролем и вторым входом ради одной строки в справочнике. */}
          {isObjectScopedRole(watchRole) ? (
            <Form.Item
              name="constructionObjectIds"
              label={`Объекты (для роли «${roleLabels[watchRole!]}»)`}
              rules={[
                {
                  validator: (_rule, value: string[] | undefined) =>
                    value && value.length > 0
                      ? Promise.resolve()
                      : Promise.reject(new Error('Выберите хотя бы один объект')),
                },
              ]}
            >
              <Select
                mode="multiple"
                options={objectOptions}
                loading={objectsLoading}
                showSearch
                optionFilterProp="label"
                placeholder="Выберите объекты"
              />
            </Form.Item>
          ) : null}
          {/* Отделы — вторая ось области (ADR 0040): офисное подразделение вместо площадки.
              Показывается вместо поля объектов, а не рядом: учётка работает на одной оси. */}
          {isDepartmentScopedRole(watchRole) ? (
            <Form.Item
              name="departmentIds"
              label={`Отделы (для роли «${roleLabels[watchRole!]}»)`}
              rules={[
                {
                  validator: (_rule, value: string[] | undefined) =>
                    value && value.length > 0
                      ? Promise.resolve()
                      : Promise.reject(new Error('Выберите хотя бы один отдел')),
                },
              ]}
            >
              <Select
                mode="multiple"
                options={departmentOptions ?? []}
                loading={departmentsLoading}
                showSearch
                optionFilterProp="label"
                placeholder="Выберите отделы"
              />
            </Form.Item>
          ) : null}
          {isCounterpartyScopedRole(watchRole) ? (
            <Form.Item
              name="counterpartyId"
              label={`Контрагент (для роли «${roleLabels[watchRole!]}»)`}
              tooltip="Тип контрагента задаёт раздел: оператор вывоза ведёт заявки на вывоз мусора, арендодатель — заявки на технику, куда вышли его машины"
              rules={[{ required: true, message: 'Выберите контрагента' }]}
              extra={
                executorCount === 0
                  ? 'Нет активных контрагентов-исполнителей — заведите оператора вывоза или арендодателя в справочнике'
                  : undefined
              }
            >
              <AutoSelect
                options={executorGroups}
                loading={executorsLoading}
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          ) : null}
          {!record ? (
            <PasswordField name="password" identityFields={['email', 'lastName', 'firstName']} />
          ) : null}
          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal
        title={`Смена пароля: ${pwUser?.email ?? ''}`}
        open={!!pwUser}
        onCancel={() => setPwUser(null)}
        onSubmit={() => pwForm.submit()}
        confirmLoading={passwordMut.isPending}
        width={520}
      >
        <Form
          form={pwForm}
          layout="vertical"
          onFinish={(v) =>
            pwUser && passwordMut.mutate({ id: pwUser.id, newPassword: v.newPassword })
          }
        >
          <PasswordField name="newPassword" label="Новый пароль" />
        </Form>
      </FormModal>

      <ReasonModal
        open={!!rejecting}
        title="Отклонение заявки"
        label={rejecting ? `Причина отказа по заявке ${rejecting.email}` : 'Причина отказа'}
        okText="Отклонить"
        cancelText="Не отклонять"
        placeholderHint="Причина попадёт в аудит — по ней потом видно, почему доступ не дали."
        onCancel={() => setRejecting(null)}
        onSubmit={(reason) => rejecting && rejectMut.mutate({ id: rejecting.id, reason })}
        confirmLoading={rejectMut.isPending}
      />
    </PageTableLayout>
  );
}
