import { useState } from 'react';
import {
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
  Tabs,
  Tag,
} from 'antd';
import {
  DeleteFilled,
  HistoryOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
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
  isPersonScopedRole,
  isRetiringRole,
  normalizeEmail,
  REGISTRATION_ROLE_REQUESTS,
  registrationRoleRequestLabels,
  requestRoleTitle,
  ROLES,
  roleLabels,
  type RejectUserBody,
} from '@technic/contracts';
import {
  counterpartiesApi,
  usersApi,
  type RestoreUserBody,
  type UserAccountDto,
} from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { PasswordField } from '../../components/PasswordField';
import { PersonNameFields } from '../../components/PersonNameFields';
import { PhoneField, PhoneLink } from '../../components/PhoneField';
import { useChangeEmailAction } from './ChangeEmailModal';
import {
  DriverPersonField,
  DriverRestoreModal,
  personFactsOf,
  restoreNeedsPerson,
} from './DriverPersonField';
import { RejectRegistrationModal } from './RejectRegistrationModal';
import { UserDepartmentsField } from './UserDepartmentsField';
import { useUserGrantsField } from './UserGrantsField';
import { UsersAuditTab } from './UsersAuditTab';
import { UserAuditPathDrawer, type AuditTarget } from './UserAuditPathDrawer';
import {
  approvesRegistration,
  asksAboutMail,
  HALF_APPROVAL,
  isPendingRegistration,
  withMailOutcome,
} from './registrationApproval';
import { roleIssue, useActivationDefaults } from './useActivationDefaults';
import { emailCell, roleNote, roleTags } from './userAccountLabels';
import { userAuditKeys } from '@entities/user-audit';
import { isApiError } from '@shared/api';
import { actionsColumn, boolBadgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { UserAvatar } from '../../components/UserAvatar';
import { errorMessage } from '../../utils/format';
import { objectsApi, objectKeys } from '@entities/object';
import { departmentKeys, departmentOptionsQuery } from '@entities/department';

export interface UserFormValues {
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
  /**
   * Работник справочника (ADR 0102): четвёртая ось области и обязательное условие активации
   * водителя. Объектов, отделов и контрагента у этой роли нет — она работает от карточки человека.
   */
  personId?: string;
  /** Подтверждение расхождения ФИО (Р30): показывается только когда расхождение есть. */
  confirmNameMismatch?: boolean;
  isActive: boolean;
  /** Сообщить ли человеку о выданном доступе. Спрашивается не всегда — см. `asksAboutMail`. */
  notifyUser: boolean;
}

interface AccountsProps {
  /**
   * Открыть журнал по этой учётке. Не передан — права на журнал у роли нет, и пункта меню тоже:
   * недоступное портал не показывает даже выключенным (ADR 0033 §6).
   */
  onShowHistory?: (user: UserAccountDto) => void;
}

function UsersAccountsTab({ onShowHistory }: AccountsProps) {
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
  const [record, setRecord] = useState<UserAccountDto | null>(null);
  /**
   * Роли, доступные **выбору** в карточке, — без упраздняемых (план §13.2, ADR 0113).
   *
   * Отдельно от `roleOptions`, которым строятся фильтры списка, и это не дубль: фильтр обязан
   * искать по старым ролям, пока на них кто-то есть, а форма обязана их не предлагать — сервер
   * такую смену отклоняет (`retiringRoleIssue`). Роль редактируемой учётки остаётся в списке даже
   * упразднённой: иначе её карточка открывалась бы с пустым выбором, а любое сохранение требовало
   * бы перевода, которого этот релиз ещё не делает.
   */
  const formRoleOptions = ROLES.filter((r) => !isRetiringRole(r) || r === record?.role).map(
    (r) => ({
      value: r,
      label: isRetiringRole(r) ? `${roleLabels[r]} (упраздняется)` : roleLabels[r],
    }),
  );
  const [form] = Form.useForm<UserFormValues>();
  const watchRole = Form.useWatch('role', form);
  // Роль и активность читаются из формы вживую, а не из записи: чекбокс письма и намерение
  // рассмотреть заявку следуют из того, что администратор набрал прямо сейчас, а запись показывает
  // состояние до правки.
  const watchIsActive = Form.useWatch('isActive', form);
  /** Заявка, открытая на рассмотрение: у неё роль и активация ходят парой (Р8). */
  const pendingRecord = !!record && isPendingRegistration(record);
  const notifyShown = asksAboutMail(record, watchRole, watchIsActive);

  /**
   * Полномочия учётки (ADR 0106; план «полномочия назначаются в окне учётки») — на месте прежних
   * надстроек и вместо них (Р1): две системные надстройки и есть наборы, и два выключателя одного
   * доступа не имели бы старшего. Тип контрагента читается из формы вживую: строка «Добавится»
   * считается по итоговому субъекту правки, а запись описывает прежнего (§6).
   */
  const watchCounterpartyId = Form.useWatch('counterpartyId', form);
  const watchCounterpartyType = isCounterpartyScopedRole(watchRole)
    ? (executors?.items.find((c) => c.id === watchCounterpartyId)?.type ?? null)
    : null;
  // Заполнение формы по пожеланию заявителя (§3.5–§3.8): роль, область, коды наборов и баннер о
  // сделанном. Считается своим файлом; здесь важно одно — правятся поля, а не тело запроса, и
  // «Активен» подстановка не трогает никогда.
  const activation = useActivationDefaults({
    open,
    record,
    form,
    objects: objects?.items,
    counterparties: executors?.items,
  });
  const grants = useUserGrantsField({
    open,
    isSelf: !!record && record.id === currentUser?.id,
    role: watchRole ?? null,
    counterpartyType: watchCounterpartyType,
    record,
    // Предложенные — третьим множеством гидратации (§3.6), а не присваиванием в поле.
    suggestedCodes: activation.grantCodes,
    onReload: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const [pwUser, setPwUser] = useState<UserAccountDto | null>(null);
  const [pwForm] = Form.useForm<{ newPassword: string }>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      constructionObjectIds: [],
      departmentIds: [],
      // Умолчание — «сообщить»: учётку заводят, чтобы человек ею пользовался, и узнать об этом он
      // должен не со слов администратора.
      notifyUser: true,
    } as Partial<UserFormValues>);
    setOpen(true);
  };
  const openEdit = (r: UserAccountDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      email: r.email,
      lastName: r.lastName,
      firstName: r.firstName,
      middleName: r.middleName,
      phone: r.phone,
      // Роль записи, а не пожелания: умолчание по заявке ставит автомат — однажды и только в
      // пустое поле (§3.5), а решение остаётся за администратором.
      role: r.role ?? undefined,
      constructionObjectIds: r.constructionObjects.map((o) => o.id),
      departmentIds: r.departments.map((d) => d.id),
      counterpartyId: r.counterpartyId,
      // Работник (ADR 0102): у водителя связь уже стоит, и поле открывается с ней — сверка ФИО
      // повторяется только при выборе другого человека.
      personId: r.person?.id,
      confirmNameMismatch: false,
      isActive: r.isActive,
      notifyUser: true,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: UserFormValues) => {
      // Работник вынут из общего набора: у не-водительской роли его в теле быть не должно вовсе,
      // а не «пустым» — пустой означал бы просьбу отвязать (Р6).
      const { notifyUser, personId, confirmNameMismatch, ...fields } = values;
      // Оба флага считаются по отправляемым значениям, а не по подсмотренным в форме: тело запроса
      // и показанный чекбокс обязаны говорить об одном и том же решении.
      const approving = approvesRegistration(record, values.role, values.isActive);
      const notifying = asksAboutMail(record, values.role, values.isActive);
      /*
       * Подставленное уходит на сервер только вместе с одобрением (§3.6): сервер отвечает 400 на
       * заявку с ролью в теле без объявленного рассмотрения, и правка ФИО в очереди упёрлась бы в
       * отказ, причину которого создал бы сам экран. Подстановка — предложение экрана, а не
       * значение заявки, и несохранённая соберётся заново при следующем открытии.
       */
      const role = pendingRecord && !approving ? undefined : values.role;
      // Полномочия молчат вместе с ролью не за компанию: набор без роли планировщик отвергает
      // отдельно (`role_required`) — полномочия выдаются поверх должности.
      const grantStatements = role ? grants.statements() : undefined;
      const payload = {
        ...fields,
        role,
        // Пустое поле уходит пустой строкой, а не `undefined`: у правки это разные вещи —
        // «телефон стёрли» и «телефон не трогали» (ADR 0043).
        phone: values.phone ?? '',
        // Область чужой оси обнуляется здесь же: сменив роль с объектной на отдельскую, форма
        // не должна отправлять оставшийся от прежней роли набор — сервер его всё равно отвергнет
        // как несовместимую пару (ADR 0040).
        constructionObjectIds: isObjectScopedRole(role) ? (values.constructionObjectIds ?? []) : [],
        departmentIds: isDepartmentScopedRole(role) ? (values.departmentIds ?? []) : [],
        counterpartyId: isCounterpartyScopedRole(role) ? (values.counterpartyId ?? null) : null,
        /*
         * Полномочия — высказыванием о каждом показанном наборе (Р3), а не списком оставшихся:
         * снимаемого в таком списке нет по построению, и ни версии его состава, ни факта показа
         * передать было бы нечем. Собирает его отдельный шаг, а не значение группы чекбоксов:
         * строку про гасимый сменой роли набор из группы не получить — он там не показан (§6).
         * `undefined` — поля в теле нет вовсе (§4.1); молчание при этом законно, пока роль не
         * переключает действие назначений, и поле роли тогда заперто (§4.2). `addons` не уходит
         * никогда: оба поля правят одно множество, и тело с обоими — 400.
         */
        ...(grantStatements ? { grants: grantStatements } : {}),
        // Работник уходит только у своей роли (ADR 0102). Отправить его вместе с другой ролью
        // нельзя даже пустым: `null` означает «отвяжите», а отвязка живой водительской учётки
        // запрещена (Р6) — у прочих ролей связь справочная и правится не здесь.
        ...(isPersonScopedRole(role)
          ? { personId, confirmNameMismatch: confirmNameMismatch ?? false }
          : {}),
      };
      if (record) {
        const { password: _pw, email: _email, ...rest } = payload;
        return usersApi.update(record.id, {
          ...rest,
          // Просьба о письме и объявленное намерение уходят только вместе со своим случаем: на
          // обычной правке серверу незачем получать ни то, ни другое, а умолчания схемы
          // («сообщить», «это не одобрение») описывают её точнее, чем присланные вслепую поля.
          ...(notifying ? { notifyUser } : {}),
          ...(approving ? { approveRegistration: true } : {}),
        });
      }
      return usersApi.create({
        ...(payload as Required<Omit<UserFormValues, 'notifyUser'>>),
        // Высказывание приведения не переживает: `UserFormValues` о нём не знает — полномочия
        // собираются вне формы (§6), и без повтора поле ушло бы из типа тела.
        ...(grantStatements ? { grants: grantStatements } : {}),
        ...(notifying ? { notifyUser } : {}),
      });
    },
    onSuccess: ({ notified }) => {
      message.success(withMailOutcome('Сохранено', notified, 'пользователю отправлено письмо'));
      void qc.invalidateQueries({ queryKey: ['users'] });
      // Отделы — та же привязка, что держит признак руководителя (миграция 0149): отдел, убранный
      // из набора, уносит и руководство им. Справочник об этом не спрашивали, но показывает он то
      // же самое — и в карточке отдела, и подсказкой в этой форме. Ответное гашение стоит в
      // карточке отдела, здесь — обратное.
      void qc.invalidateQueries({ queryKey: departmentKeys.root });
      setOpen(false);
    },
    onError: (e) => {
      /*
       * Отказ по полномочиям разбирает само поле (Р8): 400 с деталями ложится на «Полномочия» —
       * там видно, какая галочка виновата, — а 409 по версии набора уводит перечитывать карточку.
       * Общие сообщения ниже отвечают за всё остальное: отказ по молчанию виноват не галочкой, а
       * устаревшим экраном, и подсвечивать в нём нечего.
       */
      if (grants.handleError(e)) return;
      // 409 приходит на одно: заявку успел рассмотреть другой администратор, и сервер не дал
      // переписать его решение. Повторять своё не по чему — сначала нужно увидеть чужое, поэтому
      // список перезапрашивается тут же.
      if (isApiError(e) && e.status === 409) {
        message.error('Заявку уже рассмотрел другой администратор — обновите список');
        void qc.invalidateQueries({ queryKey: ['users'] });
        return;
      }
      message.error(errorMessage(e));
    },
  });

  const toggleActiveMut = useMutation({
    mutationFn: (r: UserAccountDto) => usersApi.update(r.id, { isActive: !r.isActive }),
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
    mutationFn: (v: { id: string; body?: RestoreUserBody }) => usersApi.restore(v.id, v.body),
    onSuccess: () => {
      message.success('Учётная запись восстановлена — она осталась неактивной');
      setRestoring(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Восстановление водителя спрашивает работника (Р8) — окном, а не отказом сервера: живая учётка
   * без карточки невозможна, а у архивной связь могла обнулиться вместе с удалённым человеком.
   * Остальные учётки возвращаются как прежде, одной кнопкой.
   */
  const [restoring, setRestoring] = useState<UserAccountDto | null>(null);
  const restore = (r: UserAccountDto) =>
    restoreNeedsPerson(r) ? setRestoring(r) : restoreMut.mutate({ id: r.id });

  // Удаление насовсем (ADR 0063) — общий хук справочников: подтверждение необратимого действия
  // должно звучать везде одинаково.
  const purge = usePurgeAction({
    subject: 'учётную запись',
    purge: usersApi.purge,
    invalidate: [['users']],
  });

  const [rejecting, setRejecting] = useState<UserAccountDto | null>(null);
  const rejectMut = useMutation({
    mutationFn: (v: { id: string; body: RejectUserBody }) => usersApi.reject(v.id, v.body),
    onSuccess: ({ notified }) => {
      message.success(withMailOutcome('Заявка отклонена', notified, 'заявителю отправлено письмо'));
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

  // Смена адреса (ADR 0092) — своим хуком: у неё два письма, архивная тень и выход из портала при
  // смене себе, и разбирать это посреди вкладки о ролях и области значит смешать два разговора.
  const changeEmail = useChangeEmailAction({
    currentUserId: currentUser?.id,
    onChanged: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  /**
   * Что можно сделать со строкой. Список один на оба режима: на десктопе он раскрывается меню,
   * на телефоне — шитом с подписями (ADR 0030 п. 6, ADR 0042). Расходиться им нельзя — иначе
   * «Отклонить заявку» существовало бы только с мышью.
   */
  const rowActions = (r: UserAccountDto) => {
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
      // Смена адреса — он же логин (ADR 0092). Пункта нет там, где сервер откажет: у заявки на
      // регистрацию (её рассматривают целиком, а не правят адрес заявителя) и у чужой
      // администраторской учётки — такую уводит только её владелец. Недоступное портал не
      // показывает даже выключенным (ADR 0033 §6): выключенный пункт обещал бы действие, которого
      // не бывает.
      ...(!pendingRegistration && (isSelf || r.role !== 'admin')
        ? [{ key: 'email', label: 'Сменить email', onClick: () => changeEmail.openFor(r) }]
        : []),
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
      // История учётки (ADR 0088) — отсюда, а не поиском в общем журнале: искать человека там
      // руками и есть та работа, от которой экран должен избавлять. Пункт открывает подвкладку
      // «Аудит», уже суженную до этой учётки.
      ...(onShowHistory
        ? [{ key: 'history', label: 'История', onClick: () => onShowHistory(r) }]
        : []),
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
  const archivedRowActions = (r: UserAccountDto) => [
    // История у архивной учётки спрашивается чаще, чем у действующей: в списке от неё осталась
    // одна строка, а чем всё кончилось — рассказывает только журнал.
    ...(onShowHistory
      ? [{ key: 'history', label: 'История', onClick: () => onShowHistory(r) }]
      : []),
    ...(canRestore ? [{ key: 'restore', label: 'Восстановить', onClick: () => restore(r) }] : []),
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

  const rowMenu = (r: UserAccountDto) => {
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
    textColumn<UserAccountDto>({
      key: 'email',
      title: 'Email',
      dataIndex: 'email',
      searchable: false,
      width: 220,
      // Пометка о чужом домене стоит у самого адреса, а не отдельным столбцом: она бывает у одной
      // строки из десятка, и столбец под неё стоял бы пустым.
      render: (_v, r) => emailCell(r),
    }),
    textColumn<UserAccountDto>({
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
              text={r.requestedRole ? `Заявка: ${requestRoleTitle(r.requestedRole)}` : 'Заявка'}
            />
          ) : null}
        </Space>
      ),
    }),
    // Телефон (ADR 0043): администратор рассматривает заявку и звонит с этой же страницы, поэтому
    // номер стоит в списке, а не только в карточке. Сортировки нет — по номеру не упорядочивают,
    // и `USER_SORT_FIELDS` его не принимает.
    textColumn<UserAccountDto>({
      key: 'phone',
      title: 'Телефон',
      dataIndex: 'phone',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_v, r) => (r.phone ? <PhoneLink phone={r.phone} /> : '—'),
    }),
    // Роль с надстройками (ADR 0086) рисуется сама, а не `badgeColumn`: тег там один на ячейку, а
    // здесь их бывает несколько. Сортировка остаётся по роли — `USER_SORT_FIELDS` знает только её,
    // и надстройка порядка строк не задаёт.
    textColumn<UserAccountDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      searchable: false,
      width: 200,
      render: (_v, r) => roleTags(r),
    }),
    textColumn<UserAccountDto>({
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
    textColumn<UserAccountDto>({
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
    boolBadgeColumn<UserAccountDto>({
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
          textColumn<UserAccountDto>({
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
    textColumn<UserAccountDto>({
      key: 'createdAt',
      title: 'Зарегистрирован',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_v, r) => dayjs(r.createdAt).format('DD.MM.YYYY'),
    }),
    actionsColumn<UserAccountDto>(
      (r) =>
        r.deletedAt ? (
          // Архивная строка (ADR 0063): вернуть из архива и снести насовсем. Восстановление не
          // активирует — отклонённая заявка возвращается в очередь и рассматривается заново.
          <Space size={4}>
            <Tag>в архиве</Tag>
            {onShowHistory ? (
              <Button
                size="small"
                icon={<HistoryOutlined />}
                title="История"
                onClick={() => onShowHistory(r)}
              />
            ) : null}
            {canRestore ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                title="Восстановить"
                loading={restoreMut.isPending}
                onClick={() => restore(r)}
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
  const card: CardConfig<UserAccountDto> = {
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
    // Роль и надстройки (ADR 0086) — тем же тегом, что и в таблице: карточка на телефоне не должна
    // рассказывать о человеке меньше, чем строка списка на десктопе.
    primary: (r) => roleTags(r),
    lines: [
      (r) => emailCell(r),
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
      (r) => (r.requestedRole ? `Пожелание: ${requestRoleTitle(r.requestedRole)}` : null),
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
      <DataTable<UserAccountDto>
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
        {/*
         * Смена роли молча ничего не снимает — и сказать об этом должна форма, а не отсутствие
         * сообщения: несовместимый набор остаётся выданным, но прав по нему нет (Р4). Сообщение
         * поэтому живёт в самом поле полномочий: пока не пришёл каталог новой роли, какие именно
         * наборы перестают действовать, неизвестно — совместимость считает сервер, а не экран.
         */}
        <Form
          form={form}
          layout="vertical"
          className="form-dense"
          onFinish={(v) => saveMut.mutate(v)}
        >
          <Form.Item
            name="email"
            label="Email"
            normalize={normalizeEmail}
            rules={[{ required: true, type: 'email', message: 'Введите email' }]}
          >
            <Input disabled={!!record} />
          </Form.Item>
          <PersonNameFields />
          {/* Контакт сотрудника (ADR 0043): необязателен и здесь — заведённые администратором
              учётки живут без него, а дозаполняется он той же формой. Подписи про «портал писем не
              шлёт» здесь больше нет: почтовый контур работает (ADR 0093), и обещание тишины было
              бы неправдой. */}
          <PhoneField />
          {/* Пожелание заявителя (ADR 0034) и то, что по нему заполнено (§3.8). Вторая строка
              баннера — в прошедшем времени, поэтому правка роли её не делает ложью. */}
          {activation.banner}
          {/* Роль у заявки обязательна не всегда: исправить в ней опечатку в ФИО или телефон
              можно, не рассматривая её, — заявка остаётся в очереди. А вот назначить роль,
              не активируя, нельзя: запись перестала бы быть заявкой, и следующая правка
              активировала бы «обычную учётку с ролью» мимо журнала одобрений (Р8). */}
          <Form.Item
            name="role"
            label="Роль"
            // Звёздочка обязательности — по тому же правилу: у заявки роль ждёт решения, а не
            // заполнения, и помеченной обязательной она обещала бы, что без неё не сохранить.
            required={!pendingRecord}
            /*
             * Неполный каталог полномочий запирает и роль (§6): смена роли переключает действие
             * назначений, а высказаться о них форма в этом состоянии не может — сервер ответил бы
             * отказом, причину которого создал бы сам экран.
             */
            extra={
              grants.blocked
                ? 'Роль не меняется, пока не загрузился список полномочий: смена роли переключает их действие'
                : roleNote(watchRole)
            }
            dependencies={pendingRecord ? ['isActive'] : undefined}
            rules={[
              {
                // Оба правила рассмотрения — ответом расчёта: целиком и не раньше каталога (§3.6).
                validator: (_rule, value: UserFormValues['role'] | undefined) => {
                  const issue = roleIssue(record, value, form.getFieldValue('isActive'), grants);
                  return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
                },
              },
            ]}
          >
            <AutoSelect options={formRoleOptions} disabled={grants.blocked} />
          </Form.Item>
          {/* Объектные роли («Штаб», «Руководитель строительства») работают в пределах своих
              объектов — без них учётку не активировать (ADR 0025, ADR 0039). Список, а не один
              объект: штаб ведёт несколько площадок, и вторая учётка на того же человека была бы
              вторым паролем и вторым входом ради одной строки в справочнике. */}
          {isObjectScopedRole(watchRole) ? (
            <Form.Item
              name="constructionObjectIds"
              label={`Объекты (для роли «${roleLabels[watchRole!]}»)`}
              extra={activation.hint('constructionObjectIds')}
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
              Показывается вместо поля объектов, а не рядом: учётка работает на одной оси. Своим
              файлом — вместе с ответом на «руководит ли он ими» (§11.1 плана реструктуризации
              прав): признак руководителя переехал из роли в привязку, ставится из карточки отдела,
              и молчать о нём здесь значило бы оставить администратора без объяснения. */}
          {isDepartmentScopedRole(watchRole) ? (
            <UserDepartmentsField
              roleLabel={roleLabels[watchRole!]}
              departments={record?.departments ?? []}
              isNew={!record}
              options={departmentOptions ?? []}
              loading={departmentsLoading}
            />
          ) : null}
          {/* Кандидаты отдела — снаружи поля и при его условии: разметку поля держит свой файл. */}
          {isDepartmentScopedRole(watchRole) ? activation.hint('departmentIds') : null}
          {isCounterpartyScopedRole(watchRole) ? (
            <Form.Item
              name="counterpartyId"
              label={`Контрагент (для роли «${roleLabels[watchRole!]}»)`}
              tooltip="Тип контрагента задаёт раздел: оператор вывоза ведёт заявки на вывоз мусора, арендодатель — заявки на технику, куда вышли его машины"
              rules={[{ required: true, message: 'Выберите контрагента' }]}
              extra={
                executorCount === 0
                  ? 'Нет активных контрагентов-исполнителей — заведите оператора вывоза или арендодателя в справочнике'
                  : activation.hint('counterpartyId')
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
          {/* Работник справочника — четвёртая ось области (ADR 0102): у водителя вместо объектов,
              отделов и контрагента стоит человек, чьё задание показывает кабинет. Поле на том же
              месте, что остальные оси, и по тому же правилу — показывается только своей роли. */}
          {isPersonScopedRole(watchRole) ? (
            <DriverPersonField form={form} account={personFactsOf(record)} />
          ) : null}
          {/* Полномочия (ADR 0106) — что человек умеет сверх своей должности. Место прежних
              надстроек и вместо них (Р1): после блока области, до пароля и активности — сначала
              «кто и где», потом «что ещё». Поля нет у роли без полномочий, у водителя и у своей
              учётки; своим файлом — вместе с гидратацией галочек и сборкой высказывания. */}
          {grants.field}
          {!record ? (
            <PasswordField name="password" identityFields={['email', 'lastName', 'firstName']} />
          ) : null}
          <Form.Item
            name="isActive"
            label="Активен"
            valuePropName="checked"
            dependencies={pendingRecord ? ['role'] : undefined}
            rules={
              pendingRecord
                ? [
                    {
                      // Требует активации роль, выбранная **руками**: подставленная — предложение
                      // экрана, и без одобрения она в тело не уходит вовсе (§3.6), так что правка
                      // заявки в очереди половинчатым решением не становится.
                      validator: (_rule, value: boolean | undefined) =>
                        !value && form.isFieldTouched('role') && form.getFieldValue('role')
                          ? Promise.reject(new Error(HALF_APPROVAL))
                          : Promise.resolve(),
                    },
                  ]
                : undefined
            }
          >
            <Switch />
          </Form.Item>
          {/* Письмо о выданном доступе — по чекбоксу, включённому по умолчанию: портал не рассылает
              писем сам по себе, их отправляет человек, понимая, что делает. Поля нет там, где
              письма не бывает вовсе (Р7), — выключенный чекбокс обещал бы отправку, которой не
              случится. */}
          {notifyShown ? (
            <Form.Item
              name="notifyUser"
              valuePropName="checked"
              extra="Письмо с адресом портала и назначенной ролью. Пароль в письме не отправляется"
            >
              <Checkbox>Сообщить пользователю по почте</Checkbox>
            </Form.Item>
          ) : null}
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

      <RejectRegistrationModal
        open={!!rejecting}
        email={rejecting?.email}
        onCancel={() => setRejecting(null)}
        onSubmit={(body) => rejecting && rejectMut.mutate({ id: rejecting.id, body })}
        confirmLoading={rejectMut.isPending}
      />

      {/* Восстановление водителя без работника (Р8): человек выбирается тем же действием, что и
          возврат из архива, — живой учётки без него не бывает. */}
      <DriverRestoreModal
        account={restoring ? personFactsOf(restoring) : null}
        onCancel={() => setRestoring(null)}
        onSubmit={(body) => restoring && restoreMut.mutate({ id: restoring.id, body })}
        confirmLoading={restoreMut.isPending}
      />

      {changeEmail.modal}
    </PageTableLayout>
  );
}

/**
 * Вкладка «Пользователи»: учётные записи и журнал действий над ними (ADR 0088).
 *
 * Подвкладки живут здесь, а не вторым уровнем в `AdministrationPage`: журнал читают по ходу
 * разбора конкретной учётки, и уводить за ним на соседнюю вкладку раздела значит терять контекст —
 * а заодно разровнять по глубине «Рассылки» и «Обмен справочниками», которым делиться не на что.
 *
 * Полоса всегда компактная, а не только на телефоне: второй уровень навигации не должен спорить
 * по весу с первым — две одинаковые полосы подряд читаются как одна, и непонятно, какая из них
 * где находится.
 */
export function UsersTab() {
  const { can } = useAuth();
  // Журнал закрыт своим правом, а не ролью (ADR 0021): вкладка целиком открывается `users.manage`,
  // и разъехаться этим правам ничто не мешает — тем же порядком отделены «Рассылки».
  const canReadAudit = can('audit.read');

  const [tab, setTab] = useState('accounts');
  // Чей путь открыт панелью. Историю спрашивают прямо из строки списка, не уходя с него (ADR 0109):
  // раньше пункт «История» переключал на соседнюю подвкладку, и разбирающий учётку человек терял и
  // её строку, и отбор, которым он до неё добрался.
  const [pathUser, setPathUser] = useState<AuditTarget | null>(null);

  const qc = useQueryClient();
  /**
   * Скрытая подвкладка не размонтируется и по возвращении показала бы кэш — а журнал прирастает от
   * каждого действия портала, в том числе от только что сделанного на соседней подвкладке. Переход
   * на журнал означает «покажи, как сейчас», поэтому запрос обновляется, а фильтры сохраняются;
   * тем же приёмом устроены вкладки разделов (`PageTabs`).
   */
  const openTab = (key: string) => {
    if (key === 'audit') void qc.invalidateQueries({ queryKey: userAuditKeys.root });
    setTab(key);
  };

  const showHistory = (user: UserAccountDto) => setPathUser({ id: user.id, name: user.fullName });

  const items = [
    {
      key: 'accounts',
      label: 'Учётные записи',
      children: <UsersAccountsTab onShowHistory={canReadAudit ? showHistory : undefined} />,
    },
    ...(canReadAudit
      ? [
          {
            key: 'audit',
            label: 'Аудит',
            children: <UsersAuditTab />,
          },
        ]
      : []),
  ];

  return (
    <div style={{ height: '100%' }}>
      <UserAuditPathDrawer target={pathUser} onClose={() => setPathUser(null)} />
      <Tabs
        className="full-height-tabs"
        size="small"
        activeKey={tab}
        onChange={openTab}
        items={items}
      />
    </div>
  );
}
