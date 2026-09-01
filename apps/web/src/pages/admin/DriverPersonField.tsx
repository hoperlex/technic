import { useEffect, useMemo, useState } from 'react';
import { Alert, Checkbox, Form, Select, Space, Tag, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { formatPhone, isPersonScopedRole } from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { userAccountKeys } from '@entities/user-account';
import {
  usersApi,
  type PersonCandidateDto,
  type PersonCandidateMatch,
  type RestoreUserBody,
  type UserAccountDto,
  type UserPersonRefDto,
} from '../../api/resources';

/**
 * Выбор работника для учётки водителя (ADR 0102, Р30) — своим файлом, а не блоком внутри
 * `UsersTab`: у поля своя выдача с сервера, своя сверка с карточкой и своя галочка подтверждения,
 * и лежать это должно там же, где живёт, — иначе форма учётки прирастает третьим разговором
 * поверх ролей, области и писем.
 *
 * Портал кандидатов **предлагает, но не выбирает**: личность заявителя система не подтверждает
 * (Р32), и вся тяжесть проверки лежит на администраторе. Отсюда и устройство поля — оно
 * показывает, чем именно совпал каждый кандидат, а расхождение ФИО выносит отдельной строкой с
 * галочкой: молчаливая привязка отдала бы заявителю чужие задания вместе с телефонами заказчиков.
 */

/** Приметы учётки: ими ищут работника и с ними же его сверяют. */
export interface DriverAccountFacts {
  /** `null` — учётку только заводят: подсказка идёт по набранному в форме ФИО. */
  id: string | null;
  lastName: string;
  firstName: string;
  middleName: string;
  phone: string;
  email: string;
  /** Уже привязанный работник: поле обязано показывать имя, а не идентификатор. */
  person: UserPersonRefDto | null;
}

/**
 * Приметы учётки для подсказки кандидатов. ФИО и телефон поле дочитывает из формы вживую —
 * администратор правит их в том же окне, — а здесь лежит то, чего в форме нет: сама учётка и уже
 * привязанный работник.
 */
export const personFactsOf = (u: UserAccountDto | null): DriverAccountFacts => ({
  id: u?.id ?? null,
  lastName: u?.lastName ?? '',
  firstName: u?.firstName ?? '',
  middleName: u?.middleName ?? '',
  phone: u?.phone ?? '',
  email: u?.email ?? '',
  person: u?.person ?? null,
});

/**
 * Архивная учётка водителя без живой карточки работника (Р8): восстановление такой требует выбрать
 * человека тем же действием — живой учётки без него не бывает, и «вернуть, а починить потом»
 * упёрлось бы в CHECK базы.
 */
export const restoreNeedsPerson = (u: UserAccountDto): boolean =>
  isPersonScopedRole(u.role) && (!u.person || !!u.person.deletedAt);

const matchLabels: Record<PersonCandidateMatch, string> = {
  phone: 'телефон',
  email: 'почта',
  name: 'ФИО',
};

/**
 * Одно ли это имя — тем же правилом, что на сервере: без регистра и лишних пробелов. Разойдись
 * они, и форма просила бы подтверждения там, где сервер его не ждёт (или наоборот молчала бы
 * ровно перед отказом).
 */
const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru');

const isBlank = (v: string): boolean => v.trim() === '';

/** Строка кандидата: имя, чем совпал, должность и номер — по ним и узнают своего работника. */
function candidateLabel(p: {
  fullName: string;
  phone: string;
  jobTitle?: string;
  matchedBy?: PersonCandidateMatch[];
}) {
  const details = [p.jobTitle, p.phone ? formatPhone(p.phone) : ''].filter(Boolean).join(' · ');
  return (
    <Space size={6} wrap>
      <span>{p.fullName}</span>
      {details ? <span style={{ color: 'rgba(0,0,0,.45)' }}>{details}</span> : null}
      {(p.matchedBy ?? []).map((m) => (
        <Tag key={m} color={m === 'name' ? 'default' : 'green'}>
          {matchLabels[m]}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * Что портал перенесёт молча при привязке (Р31): пусто с одной стороны — заполняется из другой,
 * заполнено с обеих и различается — не трогается. Показывается заранее, а не постфактум: перенос
 * идёт без спроса, и увидеть его администратор должен до нажатия «Сохранить».
 */
function fillNotice(account: DriverAccountFacts, person: PersonCandidateDto): string | null {
  const toAccount: string[] = [];
  const toPerson: string[] = [];
  if (isBlank(account.middleName) && !isBlank(person.middleName)) toAccount.push('отчество');
  if (isBlank(account.phone) && !isBlank(person.phone)) toAccount.push('телефон');
  if (!isBlank(account.middleName) && isBlank(person.middleName)) toPerson.push('отчество');
  if (!isBlank(account.phone) && isBlank(person.phone)) toPerson.push('телефон');
  // Адрес переносится только в карточку: на `persons.email` шлёт письма рассылка «Задание
  // водителю», и пустой адрес там означает, что задание не уйдёт вовсе.
  if (isBlank(person.email)) toPerson.push('почту');
  const parts = [
    toAccount.length > 0 ? `в учётку из карточки — ${toAccount.join(', ')}` : '',
    toPerson.length > 0 ? `в карточку из учётки — ${toPerson.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `Незаполненное перенесётся при сохранении: ${parts.join('; ')}` : null;
}

interface FieldProps {
  /** Форма учётки: поле читает из неё выбранного работника, а пишет туда же, где остальные поля. */
  form: FormInstance;
  account: DriverAccountFacts;
  /** Имя поля с идентификатором работника — у формы учётки и у окна восстановления оно одно. */
  name?: string;
}

export function DriverPersonField({ form, account: base, name = 'personId' }: FieldProps) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  /*
   * ФИО и телефон дочитываются из формы вживую: администратор правит их в том же окне, и подсказка
   * с расхождением обязаны следовать за набранным, а не за тем, что лежало в базе до правки.
   * Подписка живёт здесь, а не в форме учётки: иначе каждая буква перерисовывала бы вкладку вместе
   * с таблицей. В окне восстановления этих полей нет — там остаются значения самой учётки.
   */
  const account: DriverAccountFacts = {
    ...base,
    lastName: Form.useWatch<string | undefined>('lastName', form) ?? base.lastName,
    firstName: Form.useWatch<string | undefined>('firstName', form) ?? base.firstName,
    middleName: Form.useWatch<string | undefined>('middleName', form) ?? base.middleName,
    phone: Form.useWatch<string | undefined>('phone', form) ?? base.phone,
    email: Form.useWatch<string | undefined>('email', form) ?? base.email,
  };
  /*
   * Пока ничего не набрали, ищем по приметам самой заявки: у заведённой учётки это делает сервер
   * (телефон, адрес, похожее ФИО), а у новой примет на сервере ещё нет — подставляем ФИО, которое
   * администратор только что набрал в форме.
   */
  const typedName = [account.lastName, account.firstName].filter(Boolean).join(' ').trim();
  const query = term || (account.id ? '' : typedName);
  const { data, isFetching } = useQuery({
    queryKey: userAccountKeys.personCandidates({ userId: account.id, query }),
    queryFn: () =>
      usersApi.personCandidates({ query: query || undefined, userId: account.id ?? undefined }),
    enabled: !!query || !!account.id,
  });
  const candidates = useMemo(() => data?.items ?? [], [data]);

  const personId = Form.useWatch<string | undefined>(name, form);
  const options = useMemo(() => {
    const list = candidates.map((c) => ({
      value: c.id,
      label: candidateLabel(c),
      title: c.fullName,
    }));
    // Привязанный работник добавляется, если его нет в выдаче: подсказка отвечает на «кого
    // выбрать», а поле обязано показать и того, кто уже выбран, — иначе на месте имени осталась
    // бы строка идентификатора. Уволенного не добавляем: сервер его всё равно не примет, и
    // предлагать выбор, который закончится отказом, незачем.
    const bound = account.person?.deletedAt ? null : account.person;
    if (bound && !list.some((o) => o.value === bound.id)) {
      list.unshift({ value: bound.id, label: candidateLabel(bound), title: bound.fullName });
    }
    return list;
  }, [candidates, account.person]);

  /*
   * Выбранный кандидат помнится отдельно, а не ищется каждый раз в текущей выдаче: следующий
   * набранный запрос выдачу меняет, и выбранный из неё пропал бы вместе с разбором расхождения —
   * галочка «это один человек» снялась бы молча, а отказ пришёл бы уже с сервера.
   */
  const [picked, setPicked] = useState<PersonCandidateDto | null>(null);
  const selected: PersonCandidateDto | null =
    (picked?.id === personId ? picked : null) ??
    candidates.find((c) => c.id === personId) ??
    (account.person && account.person.id === personId
      ? { ...account.person, jobTitle: '', matchedBy: [] }
      : null);
  /*
   * Расхождение разбирается только у нового выбора. У связи, которая уже стоит, сверка не
   * повторяется и на сервере: после привязки владелец ФИО — справочник (Р31), и спрашивать
   * подтверждение при каждом сохранении карточки значило бы приучить ставить галочку не глядя.
   */
  const changed = !!selected && selected.id !== account.person?.id;
  const nameMismatch =
    changed &&
    (!sameName(selected.lastName, account.lastName) ||
      !sameName(selected.firstName, account.firstName));
  const notice = changed ? fillNotice(account, selected) : null;

  // Снятая привязка снимает и подтверждение: галочка, пережившая смену работника, подтверждала бы
  // расхождение, которого администратор не видел, — и делала бы это молча.
  useEffect(() => {
    if (!nameMismatch) form.setFieldValue('confirmNameMismatch', false);
  }, [nameMismatch, form]);

  return (
    <>
      <Form.Item
        name={name}
        label="Работник"
        tooltip="Кабинет водителя показывает задание работника: рейсы и путевые листы записаны на карточку справочника, а не на учётную запись"
        rules={[{ required: true, message: 'Выберите работника' }]}
        extra="Работник с действующей учётной записью в списке не показывается — у человека она одна"
      >
        <Select
          showSearch
          allowClear
          // Отбор идёт на сервере: справочник целиком порталу не отдаётся, и фильтровать здесь
          // нечего — своим фильтром список молча резал бы то, что сервер уже нашёл.
          filterOption={false}
          onSearch={setSearch}
          // Свой обработчик не подменяет форменный: `Form.Item` вызывает оба, и поле формы
          // заполняется как обычно, а здесь остаётся сам кандидат — с ФИО для сверки.
          onChange={(value: string | undefined) =>
            setPicked(candidates.find((c) => c.id === value) ?? null)
          }
          loading={isFetching}
          options={options}
          optionLabelProp="title"
          placeholder="ФИО, телефон или почта"
          notFoundContent={
            query
              ? 'Никого не нашлось — проверьте написание или заведите работника в справочнике'
              : 'Начните вводить ФИО или телефон'
          }
        />
      </Form.Item>
      {notice ? <Alert type="info" showIcon style={{ marginBottom: 16 }} title={notice} /> : null}
      {nameMismatch ? (
        // Отдельной строкой, а не одной из ошибок поля: смена фамилии — обычное дело, случайный
        // однофамилец — редкое, и различить их может только человек. Сервер без этой галочки
        // привязку не выполнит (Р30), а факт подтверждения уходит в аудит.
        <Form.Item
          name="confirmNameMismatch"
          valuePropName="checked"
          rules={[
            {
              validator: (_rule, value: boolean | undefined) =>
                value
                  ? Promise.resolve()
                  : Promise.reject(new Error('Подтвердите, что это один человек')),
            },
          ]}
          extra={`В учётке «${account.lastName} ${account.firstName}», в карточке «${selected?.fullName ?? ''}». ФИО учётки останется как есть — его владелец справочник`}
        >
          <Checkbox>Это один человек</Checkbox>
        </Form.Item>
      ) : null}
    </>
  );
}

interface RestoreProps {
  /** Учётка из архива; `null` — окно закрыто. */
  account: DriverAccountFacts | null;
  onCancel: () => void;
  onSubmit: (body: RestoreUserBody) => void;
  confirmLoading?: boolean;
}

/**
 * Восстановление архивной учётки водителя (Р8).
 *
 * Отдельное окно, а не тихий запрос, потому что у водителя восстановление — это привязка заново:
 * `person_id` архивной учётки мог обнулиться вместе с удалённым работником, а живая без него
 * невозможна (CHECK `users_driver_person_check`). Вслепую такую учётку не вернуть — и спросить
 * человека нужно до того, как сервер ответит отказом.
 */
export function DriverRestoreModal({ account, onCancel, onSubmit, confirmLoading }: RestoreProps) {
  const [form] = Form.useForm<RestoreUserBody>();

  useEffect(() => {
    if (account) form.resetFields();
  }, [account, form]);

  return (
    <FormModal
      title={`Восстановление учётной записи${account ? `: ${account.lastName} ${account.firstName}` : ''}`}
      open={!!account}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      width={560}
    >
      <Form form={form} layout="vertical" className="form-dense" onFinish={(v) => onSubmit(v)}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Учётная запись водителя живёт при карточке работника — выберите его. Учётка вернётся неактивной: доступ включает обычная правка карточки"
        />
        {account ? <DriverPersonField form={form} account={account} /> : null}
      </Form>
    </FormModal>
  );
}
