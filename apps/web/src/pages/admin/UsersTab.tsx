import { useState } from 'react';
import { Alert, App, Badge, Button, Dropdown, Form, Input, Segmented, Space, Switch } from 'antd';
import { MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  isCounterpartyScopedRole,
  isObjectScopedRole,
  registrationRequestDetail,
  registrationRoleRequestLabels,
  ROLES,
  roleColors,
  roleLabels,
  type UserDto,
} from '@technic/contracts';
import { counterpartiesApi, objectsApi, usersApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { PasswordField } from '../../components/PasswordField';
import { PersonNameFields } from '../../components/PersonNameFields';
import { ReasonModal } from '../../components/CancelReasonModal';
import { actionsColumn, badgeColumn, boolBadgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { UserAvatar } from '../../components/UserAvatar';
import { errorMessage } from '../../utils/format';

interface UserFormValues {
  email: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  role: (typeof ROLES)[number];
  password?: string;
  constructionObjectId?: string | null;
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
  const { user: currentUser } = useAuth();
  const { params, setParams, onTableChange } = useListParams<{
    role?: string;
    isActive?: string;
    pending?: string;
  }>(
    {},
    {
      searchKeys: ['email', 'fullName'],
      mapFilters: (f) => ({
        role: f.role?.[0] as string | undefined,
        isActive: f.isActive?.[0] as string | undefined,
      }),
    },
  );

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
    queryKey: ['objects', 'for-select'],
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
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
    form.setFieldsValue({ isActive: true } as UserFormValues);
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
      // Роль по умолчанию не подставляем: у зарегистрировавшегося самостоятельно её нет,
      // а активация без осознанно выбранной роли запрещена — пусть выберет администратор.
      role: r.role ?? undefined,
      constructionObjectId: r.constructionObjectId,
      counterpartyId: r.counterpartyId,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: UserFormValues) => {
      const payload = {
        ...values,
        constructionObjectId: isObjectScopedRole(values.role)
          ? (values.constructionObjectId ?? null)
          : null,
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

  const rowMenu = (r: UserDto) => {
    const isSelf = r.id === currentUser?.id;
    const pendingRegistration = isPendingRegistration(r);
    return {
      items: [
        { key: 'edit', label: pendingRegistration ? 'Рассмотреть заявку' : 'Редактировать' },
        { key: 'password', label: 'Сменить пароль' },
        {
          key: 'toggle',
          label: r.isActive ? 'Деактивировать' : 'Активировать',
          disabled: isSelf && r.isActive,
        },
        { type: 'divider' as const },
        // Отказ по нерассмотренной заявке и удаление сотрудника — разные события: в аудите
        // остаётся причина отказа, и путать их не нужно ни администратору, ни разбору потом.
        ...(pendingRegistration
          ? [{ key: 'reject', label: 'Отклонить заявку', danger: true }]
          : [{ key: 'delete', label: 'Удалить', danger: true, disabled: isSelf }]),
      ],
      onClick: ({ key }: { key: string }) => {
        if (key === 'edit') openEdit(r);
        if (key === 'password') {
          pwForm.resetFields();
          setPwUser(r);
        }
        // Активация без роли запрещена (сервер её отклонит): у самостоятельно
        // зарегистрировавшегося пользователя роли нет, поэтому активируем через форму.
        if (key === 'toggle') {
          if (!r.isActive && !r.role) {
            message.info('Назначьте роль — без неё учётку активировать нельзя');
            openEdit(r);
          } else {
            void toggleActiveMut.mutate(r);
          }
        }
        if (key === 'reject') setRejecting(r);
        if (key === 'delete') {
          modal.confirm({
            title: `Удалить пользователя ${r.email}?`,
            content: 'Аккаунт будет деактивирован (soft-delete).',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            onOk: () => removeMut.mutateAsync(r.id),
          });
        }
      },
    };
  };

  const columns = [
    textColumn<UserDto>({ key: 'email', title: 'Email', dataIndex: 'email', width: 220 }),
    textColumn<UserDto>({
      key: 'fullName',
      title: 'ФИО',
      dataIndex: 'fullName',
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
    badgeColumn<UserDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      labels: roleLabels,
      colors: roleColors,
      filters: true,
      width: 150,
    }),
    textColumn<UserDto>({
      key: 'constructionObjectName',
      title: 'Объект',
      dataIndex: 'constructionObjectName',
      searchable: false,
      render: (v) => (v ? String(v) : '—'),
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
      filters: true,
      width: 120,
    }),
    actionsColumn<UserDto>(
      (r) => (
        <Dropdown menu={rowMenu(r)} trigger={['click']}>
          <Button size="small" icon={<MoreOutlined />} />
        </Dropdown>
      ),
      90,
    ),
  ];

  return (
    <PageTableLayout
      // Фильтры этого справочника живут в заголовках столбцов и на телефоне работают там же:
      // таблица со своей прокруткой остаётся (ADR 0030). В шит выносить нечего.
      mobile={{
        primaryAction: {
          label: 'Добавить пользователя',
          icon: <PlusOutlined />,
          onClick: openCreate,
        },
      }}
      extra={
        <Space size={8} wrap>
          {/* Заявки лежат в общем списке вперемешку с сотрудниками, а рассматривают их
              отдельным заходом — поэтому переключатель, а не ещё один фильтр в столбце. */}
          <Segmented
            value={params.pending === 'true' ? 'pending' : 'all'}
            onChange={(v) =>
              setParams((prev) => ({
                ...prev,
                pending: v === 'pending' ? 'true' : undefined,
                page: 1,
              }))
            }
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить
          </Button>
        </Space>
      }
    >
      <DataTable<UserDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />

      <FormModal
        title={record ? 'Редактирование пользователя' : 'Новый пользователь'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите email' }]}
          >
            <Input disabled={!!record} />
          </Form.Item>
          <PersonNameFields />
          {/* Пожелание заявителя (ADR 0034) — справка, а не подстановка: роль остаётся выбором
              администратора, иначе «Сохранить» не глядя выдавало бы права по чужому заявлению. */}
          {record?.requestedRole ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`При регистрации указал: ${registrationRoleRequestLabels[record.requestedRole]}`}
              description={requestedDetailText(record)}
            />
          ) : null}
          <Form.Item
            name="role"
            label="Роль"
            rules={[{ required: true, message: 'Выберите роль' }]}
          >
            <AutoSelect options={roleOptions} />
          </Form.Item>
          {/* Объектные роли («Штаб», «Руководитель строительства») работают в пределах своего
              объекта — без него учётку не активировать (ADR 0025). */}
          {isObjectScopedRole(watchRole) ? (
            <Form.Item
              name="constructionObjectId"
              label={`Объект (для роли «${roleLabels[watchRole!]}»)`}
              rules={[{ required: true, message: 'Выберите объект' }]}
            >
              <AutoSelect
                options={objectOptions}
                loading={objectsLoading}
                showSearch
                optionFilterProp="label"
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
