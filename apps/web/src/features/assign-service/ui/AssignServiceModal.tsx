import { useEffect, useMemo } from 'react';
import { Alert, App, Form, Input, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  moduleMailOutcomeLabels,
  serviceIsFirstAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  serviceCompanyOptionsQuery,
  serviceExecutorCandidatesQuery,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { useAuth } from '../../../auth/AuthContext';

/**
 * Строки поля различаются приставкой, а не соседним полем (Н6): в одном списке лежат люди и
 * компании, и «третий выбранный» обязан быть опознан без оглядки на то, из какой группы его
 * взяли. Приставка при этом не идентификатор — она снимается перед отправкой.
 */
const USER = 'user:';
const SERVICE = 'service:';

const isCompany = (key: string) => key.startsWith(SERVICE);

interface Values {
  /** Исполнители одним списком: `user:<id>` — сотрудник, `service:<id>` — сервисная компания. */
  executors: string[];
  reason?: string;
  comment?: string;
}

/**
 * Первое назначение или переназначение — по **составу исполнителей**, и одним предикатом с
 * сервером (`serviceIsFirstAssignment` контрактов, Р11).
 *
 * Прежде вопрос решался статусом (`status === 'new'`), и это было верно ровно пока «Назначена»
 * существовала: статус с составом СОВПАДАЛ. После слияния статусов (Р2) «Новая» бывает и с
 * исполнителями — назначение перестало быть переходом (Р5), — и прежняя строка называла бы первым
 * назначением всякую замену исполнителя, сделанную до того, как за заявку взялись. Окно не
 * спросило бы причину, а сервер ответил бы 422 на запрос без неё.
 *
 * Пара «контрагент + число поимённых строк» собирается здесь, потому что общего типа у строки БД и
 * карточки нет: сервер читает те же два поля из своих таблиц.
 */
function isFirstAssignment(request: ServiceRequestDto): boolean {
  return serviceIsFirstAssignment({
    serviceCounterpartyId: request.service?.id ?? null,
    executorCount: request.executors.length,
  });
}

/**
 * Компания в заявке одна (Н5): назначается контрагент целиком, и «две компании сразу» — не
 * состояние заявки, а промах по списку. Поэтому вторая выбранная **заменяет** первую, а не
 * добавляется к ней: отказ после нажатия «Назначить» человек прочитал бы как поломку поля.
 *
 * Сотрудников это не касается вовсе — их назначают сколько нужно.
 */
function keepSingleCompany(next: string[] = []): string[] {
  const companies = next.filter(isCompany);
  if (companies.length < 2) return next;
  // Множественный `Select` отдаёт значения в порядке выбора, поэтому последняя компания — только
  // что выбранная: остаётся она, а прежняя уходит.
  const last = companies[companies.length - 1];
  return next.filter((key) => !isCompany(key) || key === last);
}

/**
 * Назначение исполнителей заявки (Н5, Н6) — одно окно и одно поле.
 *
 * Просьба заказчика буквальна: «нажал и выбрал, можно несколько». Поэтому исполнители — не пункт
 * меню на каждый вид исполнителя, а список из двух групп: **сотрудники** поимённо и **сервисные
 * компании** строкой. Компания строкой, а не своими людьми, — по устройству работы (Н5): кто из
 * инженеров подрядчика поедет, решает он сам, и заводить учётки его сотрудникам портал не станет.
 *
 * Смешанное назначение «наш сисадмин + КопиЛайт» — обычный случай постановки, и уходит оно **одной
 * ручкой**: разложенное на два запроса, оно давало бы промежуточное состояние, в котором заявка
 * уже переназначена, но ещё наполовину.
 *
 * Причина обязательна при переназначении: у прежнего исполнителя отбирают работу, и вместе с ним
 * уходит его объём работ.
 *
 * Переходом назначение быть перестало (Р5) — статуса оно не меняет, а состав пишет и кладёт строку
 * истории `from = to`. Исключение одно: переназначение **из «В работе»** возвращает заявку в
 * «Новую», иначе новый исполнитель унаследовал бы чужое «взялся» и никогда не нажал бы «Принять в
 * работу». Про это окно говорит вслух — заявка, ушедшая из «В работе» молча, читалась бы как
 * откат, которого никто не делал.
 */
export function AssignServiceModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const first = request ? isFirstAssignment(request) : true;

  const { data: companies = [], isFetching: companiesLoading } = useQuery({
    ...serviceCompanyOptionsQuery(),
    enabled: !!request,
  });

  /*
   * Кандидаты в поимённые исполнители спрашиваются только там, где перечень учёток разрешён:
   * `GET /users` закрыт правом `users.manage`, и у «Ведения» с «ИТ-службой» его нет. Запрос без
   * этой проверки был бы заведомым 403 при каждом открытии окна, а поле от него не наполнилось бы.
   * Уже назначенные сотрудники в списке остаются при любом ответе — они приходят самой заявкой.
   */
  const mayListUsers = can('users.manage');
  const { data: candidates = [], isFetching: candidatesLoading } = useQuery({
    ...serviceExecutorCandidatesQuery(),
    enabled: !!request && mayListUsers,
  });

  /**
   * Сотрудники: кандидаты справочника **плюс** уже назначенные на эту заявку.
   *
   * Второе слагаемое обязательно, а не вежливо: поле отправляет состав целиком, и назначенный, не
   * оказавшийся в списке вариантов, ушёл бы из заявки при первой же правке — молча и без единой
   * записи о том, что его сняли. Заявка знает его имя снимком, поэтому показать его есть чем даже
   * тогда, когда перечень учёток закрыт смотрящему.
   */
  const employeeOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const person of candidates) byId.set(person.value, person.label);
    for (const person of request?.executors ?? []) {
      if (!byId.has(person.userId)) byId.set(person.userId, person.name);
    }
    return [...byId]
      .map(([id, name]) => ({ value: `${USER}${id}`, label: name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [candidates, request]);

  /**
   * Компании: действующие сервисные контрагенты плюс назначенная сейчас. Второе — про
   * приостановленного подрядчика: справочник его не предлагает, но заявка у него, и поле обязано
   * показать имя, а не идентификатор.
   */
  const companyOptions = useMemo(() => {
    const options = companies.map((company) => ({
      value: `${SERVICE}${company.value}`,
      label: company.label,
    }));
    const assigned = request?.service;
    if (assigned && !companies.some((company) => company.value === assigned.id)) {
      options.unshift({ value: `${SERVICE}${assigned.id}`, label: assigned.name });
    }
    return options;
  }, [companies, request?.service]);

  // Пустые группы не показываются: заголовок «Сотрудники» над пустотой читался бы как «сотрудников
  // в портале нет», хотя ответ бывает другим — перечень учёток просто закрыт смотрящему.
  const options = [
    { label: 'Сотрудники', options: employeeOptions },
    { label: 'Сервисные компании', options: companyOptions },
  ].filter((group) => group.options.length > 0);

  // Окно переоткрывают на соседней заявке: состав и причина прошлой к ней отношения не имеют.
  // Нынешние исполнители подставляются намеренно — поле показывает состав, который и правят.
  useEffect(() => {
    if (!request) return;
    form.resetFields();
    form.setFieldsValue({
      executors: [
        ...request.executors.map((person) => `${USER}${person.userId}`),
        ...(request.service ? [`${SERVICE}${request.service.id}`] : []),
      ],
    });
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      serviceRequestsApi.putExecutors(request!.id, {
        // Состав уходит целиком и разобранным на два слоя: поимённые строки и контрагент — разные
        // сущности на сервере, и одним списком их принимает только это тело.
        userIds: values.executors
          .filter((key) => !isCompany(key))
          .map((key) => key.slice(USER.length)),
        serviceCounterpartyId: values.executors.find(isCompany)?.slice(SERVICE.length) ?? null,
        reason: values.reason?.trim() || undefined,
        comment: values.comment?.trim() ?? '',
        version: request!.version,
      }),
    onSuccess: (res) => {
      message.success(first ? 'Исполнители назначены' : 'Исполнители изменены');
      /*
       * Судьба письма о назначении (Н13). Оно адресовано **людям**, а не ящику службы, и адресатов
       * у него может не оказаться вовсе — тогда назначивший обязан узнать это сразу и позвонить
       * сам, а не выяснить через день, что работу никто не начинал.
       *
       * Тостом `error`, а не `warning`: правило ADR 0094 разрешает предупреждения пофайлово, и
       * единственный такой файл (`pages/service/serviceMailNotice.ts`) лежит слоем выше — feature
       * до него не дотянется. Смысл при этом не теряется: действие удалось, а письма нет, и красная
       * строка про это говорит громче тихой.
       */
      if (res.mail !== 'queued') message.error(moduleMailOutcomeLabels[res.mail]);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    // Отказ сервера здесь содержателен: учётка без полномочия исполнителя, приостановленный
    // контрагент, заявку уже подвинули (409).
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={first ? 'Назначить исполнителей' : 'Изменить исполнителей'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={first ? 'Назначить' : 'Сохранить'}
      width={520}
    >
      {/* О какой заявке речь (Р57): исполнителя выбирают по тому, что чинят и где оно стоит, —
          до этой шапки в окне не было ни техники, ни объекта. */}
      {request && <ServiceRequestContext request={request} />}
      {/*
       * Что именно теряет заявка при замене — до нажатия, а не после. Возврат в «Новую» назван
       * отдельной строкой и только там, где он случается (Р5): у заявки, которая и так «Новая»,
       * такой фразы быть не должно — она обещала бы ход, которого не будет.
       */}
      {!first && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="У снятого исполнителя заявку заберут"
          description={
            request?.status === 'in_work'
              ? 'Заявка вернётся в «Новую»: новый исполнитель сам нажмёт «Принять в работу» — чужое «взялся» он не наследует. Объём работ и согласование прежнего исполнителя будут стёрты, а отсчёт ожидания начнётся заново. Оставшиеся назначенные продолжают вести заявку.'
              : 'Его объём работ и согласование будут стёрты, а отсчёт ожидания начнётся заново: новый исполнитель не наследует чужое время. Оставшиеся назначенные продолжают вести заявку.'
          }
        />
      )}
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <Form.Item
          name="executors"
          label="Исполнители"
          normalize={keepSingleCompany}
          extra="Сотрудников можно назначить нескольких, сервисная компания — одна: вторая заменяет первую"
          rules={[
            {
              required: true,
              type: 'array',
              min: 1,
              message: 'Выберите хотя бы одного исполнителя',
            },
          ]}
        >
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            loading={companiesLoading || candidatesLoading}
            options={options}
            placeholder="Кому передать заявку"
            notFoundContent="Ни сотрудников с полномочием исполнителя, ни сервисных компаний не нашлось"
          />
        </Form.Item>
        {/* Почему список сотрудников пуст — вопрос не к человеку и не к его выбору: перечень
            учёток портал отдаёт только тому, кто ведёт учётки. Молчание здесь читалось бы как
            «своих исполнителей нет вовсе». */}
        {!mayListUsers && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            Список сотрудников виден тому, кто ведёт учётные записи; здесь остаются только уже
            назначенные. Сервисная компания выбирается всегда.
          </Typography.Paragraph>
        )}
        {!first && (
          <Form.Item
            name="reason"
            label="Причина замены"
            extra="Уйдёт в историю заявки: по ней и разбирают, почему исполнителей сменили"
            rules={[
              { required: true, message: 'Укажите причину' },
              { whitespace: true, message: 'Укажите причину' },
            ]}
          >
            <Input.TextArea rows={2} maxLength={1000} showCount />
          </Form.Item>
        )}
        <Form.Item name="comment" label="Комментарий исполнителю">
          <Input.TextArea rows={2} maxLength={1000} placeholder="Необязательно" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
