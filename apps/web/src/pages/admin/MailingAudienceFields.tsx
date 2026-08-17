import { useState } from 'react';
import { Button, Form, Modal, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { roleLabels, type AudienceMode, type Permission } from '@technic/contracts';
import { CheckboxPicker, type CheckboxPickerItem, type CheckboxPickerValue } from '@shared/ui';
import { departmentOptionsQuery } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import { mailingsApi } from '../../api/resources';
import { GrantPermissionPicker } from './GrantPermissionPicker';
import { PERMISSION_MODULE_GROUPS, permissionLabel } from './grantModel';

/**
 * Аудитория сводки: три оси отбора и каскад между ними (план `docs/role-mailings-refactor-plan.md`,
 * решения Р5–Р8; адресация правом — ADR 0111).
 *
 * Оси именно выбираются, а не исключаются: исключение молча ломается на каждой новой записи —
 * заведённая завтра площадка в рассылку не попадёт, и узнается это ненаступившим письмом. Поэтому у
 * площадок и получателей есть режим «все и будущие», а у прав его нет: словарь прав закрытый и
 * меняется выкатом, а «все права» означало бы «вообще всем» — то есть отсутствие адреса.
 *
 * Каскад односторонний: права и области сужают список людей, но не сужают справочник площадок —
 * область рассылки задаётся независимо от того, есть ли на площадке получатели.
 *
 * Права выбираются тем же компонентом, что и в конструкторе наборов (`GrantPermissionPicker`):
 * группировка по модулям и поиск по подписи и коду. Плоский список чекбоксов по полусотне прав
 * непригоден одинаково в обеих задачах, и решать это второй раз незачем. Список при этом свой —
 * весь словарь, а не выдаваемая его часть: расписание право не выдаёт, а спрашивает, у кого оно уже
 * есть.
 */

/** Отмеченные области рассылки: две оси в одном окне, потому что выбирают их вместе. */
export interface AudienceScopeValue {
  mode: AudienceMode;
  objectIds: string[];
  departmentIds: string[];
}

export interface AudienceRecipientsValue {
  mode: AudienceMode;
  ids: string[];
}

/**
 * Часть значений формы, которой распоряжается этот блок. Форма расписания её расширяет: поля
 * аудитории живут в том же `Form`, и читаются они отсюда через контекст, а не через переданный
 * экземпляр — так блок нельзя случайно повесить рядом с формой, а не внутри неё.
 */
export interface AudienceFormValues {
  permissions: Permission[];
  scope: AudienceScopeValue;
  recipients: AudienceRecipientsValue;
}

/** Ключ списка кандидатов; хвост ключа — сам отбор, из-за которого список пересобирается. */
const CANDIDATES_KEY = ['mailing-recipient-candidates'];

interface PickerFieldProps {
  /** Приходит от `Form.Item`: им подпись поля связана с кнопкой, открывающей окно. */
  id?: string;
  title: string;
  items: CheckboxPickerItem[];
  loading?: boolean;
  allowAll?: boolean;
  missingLabel?: string;
  emptyText?: string;
  filterToggle?: { label: string; predicate: (item: CheckboxPickerItem) => boolean };
  /** Что написано на кнопке: объём набора словами. Читается вместо перечня — перечень в окне. */
  summary: string;
  value?: CheckboxPickerValue;
  onChange?: (value: CheckboxPickerValue) => void;
}

/**
 * Поле-кнопка: показывает объём набора и открывает окно выбора. Кнопка, а не `Select`, потому что
 * набор бывает и «все, включая будущих» — состояние, которого лентой отмеченных тегов не выразить.
 */
function PickerField({ id, title, summary, value, onChange, ...picker }: PickerFieldProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button id={id} block style={{ textAlign: 'left' }} onClick={() => setOpen(true)}>
        {summary}
      </Button>
      <CheckboxPicker
        {...picker}
        title={title}
        open={open}
        value={value ?? { mode: 'all', ids: [] }}
        onCancel={() => setOpen(false)}
        onSubmit={(next) => {
          onChange?.(next);
          setOpen(false);
        }}
      />
    </>
  );
}

/** Подпись набора прав: первые два по имени, остальные числом — в строку кнопки больше не влезает. */
function permissionsSummary(permissions: Permission[]): string {
  if (permissions.length === 0) return 'Права не выбраны';
  const named = permissions.slice(0, 2).map(permissionLabel);
  const rest = permissions.length - named.length;
  return `${named.join('; ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

/**
 * Окно выбора прав-адресатов. Своё, а не `CheckboxPicker`, потому что плоским списком полсотни прав
 * не выбрать: нужны группировка по модулям и поиск — то самое, что уже умеет конструктор наборов.
 */
function PermissionPickerField({
  id,
  value,
  onChange,
}: {
  /** Приходит от `Form.Item`: им подпись поля связана с кнопкой, открывающей окно. */
  id?: string;
  value?: Permission[];
  onChange?: (next: Permission[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Черновик: правка внутри окна применяется по «Готово», как и в остальных окнах формы, — иначе
  // «Отмена» не отменяла бы ничего.
  const [draft, setDraft] = useState<Permission[]>([]);
  const current = value ?? [];
  return (
    <>
      <Button
        id={id}
        block
        style={{ textAlign: 'left' }}
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        {permissionsSummary(current)}
      </Button>
      <Modal
        title="Права-адресаты"
        open={open}
        okText="Готово"
        cancelText="Отмена"
        onCancel={() => setOpen(false)}
        onOk={() => {
          onChange?.(draft);
          setOpen(false);
        }}
      >
        <GrantPermissionPicker
          groups={PERMISSION_MODULE_GROUPS}
          value={draft}
          onChange={(next) => setDraft(next)}
        />
      </Modal>
    </>
  );
}

interface Props {
  /**
   * Форма открыта. Справочники и список кандидатов спрашиваются только тогда: в кандидатах ФИО
   * действующих сотрудников, и держать их в кэше ради закрытого окна незачем.
   */
  active: boolean;
}

export function MailingAudienceFields({ active }: Props) {
  const form = Form.useFormInstance<AudienceFormValues>();
  const permissions = Form.useWatch<Permission[] | undefined>('permissions') ?? [];
  const scope = Form.useWatch<AudienceScopeValue | undefined>('scope');
  const recipients = Form.useWatch<AudienceRecipientsValue | undefined>('recipients');

  const scopeMode: AudienceMode = scope?.mode ?? 'all';
  const objectIds = scope?.objectIds ?? [];
  const departmentIds = scope?.departmentIds ?? [];

  // Справочники площадок и отделов — общие запросы: ключ у них общий с прочими экранами, и
  // открытая форма чаще всего берёт их из кэша. Правами они не сужаются (Р7): справочник отвечает
  // за область рассылки, а не за то, кто в неё попал.
  const objectsQuery = useQuery({ ...objectOptionsQuery(), enabled: active });
  const departmentsQuery = useQuery({ ...departmentOptionsQuery(), enabled: active });
  const objectOptions = objectsQuery.data ?? [];
  const departmentOptions = departmentsQuery.data ?? [];

  /**
   * Кого зацепит расписание при таком наборе. Считает сервер тем же отбором, каким рассылка
   * выбирает адресатов: правило «нет площадко-отдельной оси — фильтр по площадкам не применяется»
   * (Р8) в справочник учёток не встроить, а цифра под формой обязана совпасть с планировщиком.
   */
  const candidatesQuery = useQuery({
    queryKey: [...CANDIDATES_KEY, permissions, scopeMode, objectIds, departmentIds],
    queryFn: () =>
      mailingsApi.recipientCandidates({
        permissions: permissions.join(','),
        scopeMode,
        ...(objectIds.length > 0 ? { objectIds: objectIds.join(',') } : {}),
        ...(departmentIds.length > 0 ? { departmentIds: departmentIds.join(',') } : {}),
      }),
    // Без прав отбор пуст, и спрашивать нечего: сервер такой запрос всё равно отвергает.
    enabled: active && permissions.length > 0,
  });
  const candidates = candidatesQuery.data ?? [];

  /**
   * Тот же отбор, но без сужения площадками, — только ради счётчиков у строк справочника.
   *
   * Считать их по основному ответу нельзя: при режиме «перечисленные» он уже сужен отмеченными
   * областями, и у неотмеченной площадки счётчик всегда был бы нулём — ровно там, где по нему и
   * решают, отмечать ли её. Счётчик обязан отвечать «сколько получателей у этой площадки при
   * выбранных ролях», а не «сколько из уже отмеченного».
   *
   * Вторым запросом это оборачивается только в режиме «перечисленные»: при «все» ключ и параметры
   * совпадают с основным запросом, и оба потребителя берут один ответ из кэша.
   */
  const scopeCountsQuery = useQuery({
    queryKey: [
      ...CANDIDATES_KEY,
      permissions,
      'all' as AudienceMode,
      [] as string[],
      [] as string[],
    ],
    queryFn: () =>
      mailingsApi.recipientCandidates({ permissions: permissions.join(','), scopeMode: 'all' }),
    enabled: active && permissions.length > 0,
  });

  /** Сколько кандидатов задевает каждая площадка и каждый отдел; человек с двумя — в обоих. */
  const scopeCounts = new Map<string, number>();
  for (const c of scopeCountsQuery.data ?? []) {
    for (const id of [...c.objectIds, ...c.departmentIds]) {
      scopeCounts.set(id, (scopeCounts.get(id) ?? 0) + 1);
    }
  }
  const scopeCount = (id: string): number => scopeCounts.get(id) ?? 0;

  /**
   * Отмеченные вручную, но выпавшие из отбора: сняли право — и человек, выбранный по нему, остался
   * в наборе. Молча выкинуть его нельзя (вернуть право — значит вернуть и его), а промолчать —
   * значит оставить в расписании получателя, которому письмо уже не уйдёт.
   */
  const stale =
    recipients?.mode === 'selected' && candidatesQuery.isSuccess
      ? recipients.ids.filter((id) => !candidates.some((c) => c.userId === id))
      : [];

  /**
   * Счётчик в подсказке строки: справочник площадок правами не сужается (Р7), и без него не видно,
   * кого именно отметка задевает. Пока ответа с идентификаторами нет, подсказки нет тоже — ноль,
   * напечатанный до загрузки, читался бы как «получателей здесь не бывает».
   */
  const scopeHint = (id: string): string | undefined =>
    scopeCountsQuery.isSuccess ? `получателей: ${scopeCount(id)}` : undefined;

  const scopeItems: CheckboxPickerItem[] = [
    // Группы выражены подписью и порядком: строки окна плоские, и отдельной колонки под
    // «площадка или отдел» у них нет.
    ...objectOptions.map((o) => ({
      value: o.value,
      label: `Площадка · ${o.label}`,
      hint: scopeHint(o.value),
    })),
    ...departmentOptions.map((d) => ({
      value: d.value,
      label: `Отдел · ${d.label}`,
      hint: scopeHint(d.value),
    })),
  ];

  const scopeSummary =
    scope?.mode === 'all'
      ? 'Все площадки и отделы (и будущие)'
      : `Отмечено: площадок ${objectIds.length}, отделов ${departmentIds.length}`;

  const recipientsSummary =
    recipients?.mode === 'all'
      ? `Все получатели (и будущие)${candidatesQuery.isSuccess ? ` — сейчас ${candidates.length}` : ''}`
      : `Отмечено получателей: ${recipients?.ids.length ?? 0}`;

  /**
   * Обратный разбор набора областей: окно возвращает один перечень, а хранятся они двумя. Отдел
   * узнаётся по справочнику отделов и по прежнему значению — сохранённый идентификатор, которого в
   * справочнике уже нет, иначе переехал бы из отделов в площадки при первом же открытии окна.
   */
  const splitScope = (next: CheckboxPickerValue, prev: AudienceScopeValue): AudienceScopeValue => {
    const departments = new Set([
      ...departmentOptions.map((d) => d.value),
      ...(prev?.departmentIds ?? []),
    ]);
    return {
      mode: next.mode,
      objectIds: next.ids.filter((id) => !departments.has(id)),
      departmentIds: next.ids.filter((id) => departments.has(id)),
    };
  };

  return (
    <>
      <Form.Item
        name="permissions"
        label="Права-адресаты"
        extra="Письмо уйдёт тем, у кого есть хотя бы одно из этих прав — неважно, дала его должность или назначенный набор. Что человек в нём увидит, решает его собственная область видимости"
        rules={[
          {
            validator: (_rule, v: Permission[] | undefined) =>
              v && v.length > 0
                ? Promise.resolve()
                : Promise.reject(new Error('Выберите хотя бы одно право-адресат')),
          },
        ]}
      >
        <PermissionPickerField />
      </Form.Item>

      <Form.Item
        name="scope"
        label="Площадки и отделы"
        extra="Область рассылки: ею сужается список получателей, а при охвате «Все площадки и отделы рассылки» — и данные письма"
        getValueProps={(v: AudienceScopeValue | undefined) => ({
          value: {
            mode: v?.mode ?? 'all',
            ids: [...(v?.objectIds ?? []), ...(v?.departmentIds ?? [])],
          },
        })}
        normalize={(v: CheckboxPickerValue, prev: AudienceScopeValue) => splitScope(v, prev)}
        rules={[
          {
            validator: (_rule, v: AudienceScopeValue | undefined) =>
              !v || v.mode === 'all' || v.objectIds.length + v.departmentIds.length > 0
                ? Promise.resolve()
                : Promise.reject(new Error('Отметьте хотя бы одну площадку или отдел')),
          },
        ]}
      >
        <PickerField
          title="Площадки и отделы"
          items={scopeItems}
          loading={objectsQuery.isLoading || departmentsQuery.isLoading}
          missingLabel="Запись вне справочника"
          emptyText="Справочник пуст"
          summary={scopeSummary}
          // Переключатель появляется только со счётчиками: без них он свернул бы список до пустого
          // и читался бы как «получателей нет нигде».
          filterToggle={
            scopeCountsQuery.isSuccess
              ? {
                  label: 'Только с получателями',
                  predicate: (item) => scopeCount(item.value) > 0,
                }
              : undefined
          }
        />
      </Form.Item>

      <Form.Item
        name="recipients"
        label="Получатели"
        extra={
          stale.length > 0 ? (
            <span>
              <Typography.Text type="warning">
                {stale.length} отмеченных больше не подходят под отбор
              </Typography.Text>
              <Button
                type="link"
                size="small"
                onClick={() =>
                  form.setFieldValue('recipients', {
                    mode: 'selected',
                    ids: (recipients?.ids ?? []).filter((id) => !stale.includes(id)),
                  })
                }
              >
                Снять
              </Button>
            </span>
          ) : (
            'Учётные записи, прошедшие отбор по правам и областям. Адрес без подтверждения письма не получает (ADR 0072)'
          )
        }
        rules={[
          {
            validator: (_rule, v: AudienceRecipientsValue | undefined) =>
              !v || v.mode === 'all' || v.ids.length > 0
                ? Promise.resolve()
                : Promise.reject(new Error('Отметьте хотя бы одного получателя')),
          },
        ]}
      >
        <PickerField
          title="Получатели"
          items={candidates.map((c) => ({
            value: c.userId,
            label: c.fullName,
            hint: [roleLabels[c.role], c.scopeLabel].filter((s) => !!s).join(' · '),
            // Неподтверждённый адрес виден вместе с причиной: письмо такому человеку не уйдёт, и
            // узнать об этом надо в форме, а не в статистике запуска.
            disabledReason: c.emailVerified ? undefined : 'адрес не подтверждён',
          }))}
          loading={candidatesQuery.isLoading}
          missingLabel="Учётная запись вне отбора"
          emptyText="Под этот отбор не подходит ни одна учётная запись"
          summary={recipientsSummary}
        />
      </Form.Item>
    </>
  );
}
