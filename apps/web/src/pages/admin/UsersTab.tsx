import { useState } from 'react';
import { App, Button, Dropdown, Form, Input, Select, Switch } from 'antd';
import { MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, roleColors, roleLabels, type UserDto } from '@technic/contracts';
import { objectsApi, usersApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, badgeColumn, boolBadgeColumn, textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

interface UserFormValues {
  email: string;
  fullName: string;
  role: (typeof ROLES)[number];
  password?: string;
  constructionObjectId?: string | null;
  isActive: boolean;
}

export function UsersTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();
  const { params, onTableChange } = useListParams<{ role?: string; isActive?: string }>(
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

  const { data: objects } = useQuery({
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
  const objectOptions = (objects?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));
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
      fullName: r.fullName,
      role: (r.role ?? 'dispatcher') as UserFormValues['role'],
      constructionObjectId: r.constructionObjectId,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: UserFormValues) => {
      const payload = {
        ...values,
        constructionObjectId:
          values.role === 'shtab' ? (values.constructionObjectId ?? null) : null,
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
    return {
      items: [
        { key: 'edit', label: 'Редактировать' },
        { key: 'password', label: 'Сменить пароль' },
        {
          key: 'toggle',
          label: r.isActive ? 'Деактивировать' : 'Активировать',
          disabled: isSelf && r.isActive,
        },
        { type: 'divider' as const },
        { key: 'delete', label: 'Удалить', danger: true, disabled: isSelf },
      ],
      onClick: ({ key }: { key: string }) => {
        if (key === 'edit') openEdit(r);
        if (key === 'password') {
          pwForm.resetFields();
          setPwUser(r);
        }
        if (key === 'toggle') void toggleActiveMut.mutate(r);
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
    textColumn<UserDto>({ key: 'fullName', title: 'ФИО', dataIndex: 'fullName' }),
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
      title: 'Объект (Штаб)',
      dataIndex: 'constructionObjectName',
      searchable: false,
      sortable: false,
      render: (v) => (v ? String(v) : '—'),
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
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
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
          <Form.Item
            name="fullName"
            label="ФИО"
            rules={[{ required: true, message: 'Укажите ФИО' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="role"
            label="Роль"
            rules={[{ required: true, message: 'Выберите роль' }]}
          >
            <Select options={roleOptions} />
          </Form.Item>
          {watchRole === 'shtab' ? (
            <Form.Item
              name="constructionObjectId"
              label="Объект (для роли «Штаб»)"
              rules={[{ required: true, message: 'Выберите объект' }]}
            >
              <Select options={objectOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          ) : null}
          {!record ? (
            <Form.Item
              name="password"
              label="Пароль"
              rules={[{ required: true, min: 10, message: 'Не менее 10 символов' }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
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
          <Form.Item
            name="newPassword"
            label="Новый пароль"
            rules={[{ required: true, min: 10, message: 'Не менее 10 символов' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
