import { DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  auditActionLabels,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeLabels,
  ROLES,
  roleLabels,
  USER_TARGET_AUDIT_ACTIONS,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import type { FilterDefinition } from '@shared/ui';
import { withSavedOption } from '@shared/lib';
import { objectKeys, objectsApi } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { counterpartyKeys } from '@entities/counterparty';
import { userAccountKeys } from '@entities/user-account';
import { counterpartiesApi, usersApi } from '../../api/resources';

/**
 * Отбор журнала изменений (ADR 0109): по самим событиям — период, действие, администратор — и по
 * данным учётной записи, над которой действовали.
 *
 * Второе и есть то, ради чего экран переделан: вопросы к журналу задают про людей — «что меняли у
 * механиков», «кому открыли СУ-10», — а раньше отобрать по ним было нечем. Отбор идёт по состоянию
 * учётки **сейчас**: снимка на момент события журнал не хранит, и обещать машину времени полосе
 * фильтров нельзя.
 *
 * Вынесено из подвкладки отдельным модулем: полей десяток, и каждое живёт дважды — полосой на
 * десктопе и описанием для шита на телефоне (ADR 0030).
 */

/** Учётка, которой сужен журнал: идентификатор для запроса, имя — для подписи в поле. */
export interface AuditFilterTarget {
  id: string;
  name: string;
}

export interface AuditFilterParams {
  // Индекс-сигнатура — от `useListParams`: набор фильтров уходит в запрос как есть, и параметры
  // списка (страница, сортировка) живут в том же объекте.
  [key: string]: unknown;
  search?: string;
  actions?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  targetRole?: string;
  targetIsActive?: string;
  targetObjectId?: string;
  targetDepartmentId?: string;
  targetCounterpartyId?: string;
  targetArchive?: string;
}

const DATE = 'YYYY-MM-DD';

/**
 * Галочки отбора — по действиям, цель которых учётная запись: те же, что отдаёт срез журнала на
 * сервере. Выдача и отзыв полномочия (ADR 0106) в ленте видны, и отобрать их читателю нужно тем же
 * полем — фильтр, который короче ленты, заставляет искать событие глазами.
 */
const actionOptions = USER_TARGET_AUDIT_ACTIONS.map((action) => ({
  value: action,
  label: auditActionLabels[action],
}));
const roleOptions = ROLES.map((r) => ({ value: r, label: roleLabels[r] }));
const accessOptions = [
  { value: 'true', label: 'Доступ открыт' },
  { value: 'false', label: 'Доступ закрыт' },
];
/**
 * Архив тремя положениями, а не галочкой «показать архив», как в списке учёток: журнал по
 * построению рассказывает о прошлом, и умолчание, скрывающее архивные учётки, отрезало бы самый
 * частый вопрос к нему — что стало с человеком, которого уже уволили.
 */
const archiveOptions = [
  { value: 'include', label: 'Любые учётки' },
  { value: 'exclude', label: 'Только действующие' },
  { value: 'only', label: 'Только из архива' },
];

interface Args {
  params: AuditFilterParams;
  apply: (patch: AuditFilterParams) => void;
  target: AuditFilterTarget | null;
  onTargetChange: (target: AuditFilterTarget | null) => void;
}

export function useUserAuditFilters({ params, apply, target, onTargetChange }: Args) {
  /**
   * Люди для обоих списков выбора — один запрос: и действующим лицом, и целью бывает одна и та же
   * учётка. Неактивные из списка не убраны: журнал читают как раз про тех, кого выключили, и
   * фильтр без них отвечал бы «записей нет» на самый частый вопрос.
   */
  const { data: people, isFetching: peopleLoading } = useQuery({
    queryKey: userAccountKeys.options(),
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const personOptions = (people?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }));
  // Учётка из архива в списке действующих не значится, а историю у неё спрашивают чаще прочих —
  // имя её приезжает вместе с выбором, поэтому поле показывает человека, а не голый идентификатор.
  const targetOptions = withSavedOption(personOptions, { id: target?.id, name: target?.name });

  // Площадки берутся все, включая закрытые: журнал рассказывает о прошлом, и по учёткам закрытой
  // площадки спрашивают ровно тогда, когда разбирают, куда делись её люди.
  const { data: objects, isFetching: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: false }),
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const objectOptions = (objects?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));
  const { data: departmentOptions, isFetching: departmentsLoading } =
    useQuery(departmentOptionsQuery());
  const { data: counterparties, isFetching: counterpartiesLoading } = useQuery({
    queryKey: counterpartyKeys.options(),
    queryFn: () =>
      counterpartiesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  // Группами по типу, как в форме учётки: тип контрагента решает, чем учётка в портале занята.
  const counterpartyGroups = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((type) => ({
    label: counterpartyTypeLabels[type],
    options: (counterparties?.items ?? [])
      .filter((c) => c.type === type)
      .map((c) => ({ value: c.id, label: c.name })),
  })).filter((g) => g.options.length > 0);

  const selectedActions = params.actions ? params.actions.split(',') : [];

  const filters = (
    <Space wrap size={8}>
      <Input.Search
        allowClear
        placeholder="ФИО или адрес"
        style={{ width: 220 }}
        defaultValue={params.search}
        onSearch={(v) => apply({ search: v || undefined })}
      />
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Действия с', 'по']}
        value={[params.from ? dayjs(params.from) : null, params.to ? dayjs(params.to) : null]}
        onChange={(range) =>
          apply({ from: range?.[0]?.format(DATE), to: range?.[1]?.format(DATE) })
        }
      />
      <Select
        allowClear
        mode="multiple"
        // Отмеченное сворачивается в «+N», когда не помещается: набор бывает и в десяток
        // действий, и растянутое поле выдавило бы остальные фильтры на другую строку.
        maxTagCount="responsive"
        // Поиск по подписи: действий в списке под два десятка, и нужное — «пароль сброшен»,
        // «полномочие выдано» — иначе ищется прокруткой. По подписи, а не по коду действия:
        // кода читатель не видит нигде, он и в строке журнала не показывается.
        showSearch
        optionFilterProp="label"
        placeholder="Все действия"
        style={{ width: 260 }}
        options={actionOptions}
        value={selectedActions}
        onChange={(v: string[]) => apply({ actions: v.length > 0 ? v.join(',') : undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой администратор"
        style={{ width: 220 }}
        options={personOptions}
        loading={peopleLoading}
        value={params.actorUserId}
        onChange={(v: string | undefined) => apply({ actorUserId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любая учётная запись"
        style={{ width: 240 }}
        options={targetOptions}
        loading={peopleLoading}
        value={target?.id}
        onChange={(id: string | undefined) =>
          onTargetChange(
            id ? { id, name: targetOptions.find((o) => o.value === id)?.label ?? id } : null,
          )
        }
      />
      <Select
        allowClear
        placeholder="Любая роль"
        style={{ width: 180 }}
        options={roleOptions}
        value={params.targetRole}
        onChange={(v: string | undefined) => apply({ targetRole: v })}
      />
      <Select
        allowClear
        placeholder="Любой доступ"
        style={{ width: 160 }}
        options={accessOptions}
        value={params.targetIsActive}
        onChange={(v: string | undefined) => apply({ targetIsActive: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой объект"
        style={{ width: 220 }}
        options={objectOptions}
        loading={objectsLoading}
        value={params.targetObjectId}
        onChange={(v: string | undefined) => apply({ targetObjectId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой отдел"
        style={{ width: 200 }}
        options={departmentOptions ?? []}
        loading={departmentsLoading}
        value={params.targetDepartmentId}
        onChange={(v: string | undefined) => apply({ targetDepartmentId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой контрагент"
        style={{ width: 220 }}
        options={counterpartyGroups}
        loading={counterpartiesLoading}
        value={params.targetCounterpartyId}
        onChange={(v: string | undefined) => apply({ targetCounterpartyId: v })}
      />
      <Select
        style={{ width: 190 }}
        options={archiveOptions}
        value={params.targetArchive ?? 'include'}
        onChange={(v: string) => apply({ targetArchive: v })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'dateRange',
      key: 'period',
      label: 'Действия за период',
      from: params.from,
      to: params.to,
      onChange: (from, to) => apply({ from, to }),
    },
    {
      kind: 'select',
      key: 'actorUserId',
      label: 'Администратор',
      value: params.actorUserId,
      options: personOptions,
      placeholder: 'Любой администратор',
      loading: peopleLoading,
      onChange: (v) => apply({ actorUserId: v }),
    },
    {
      kind: 'select',
      key: 'target',
      label: 'Учётная запись',
      value: target?.id,
      options: targetOptions,
      placeholder: 'Любая учётная запись',
      loading: peopleLoading,
      onChange: (id) =>
        onTargetChange(
          id ? { id, name: targetOptions.find((o) => o.value === id)?.label ?? id } : null,
        ),
    },
    {
      kind: 'select',
      key: 'targetRole',
      label: 'Роль учётной записи',
      value: params.targetRole,
      options: roleOptions,
      placeholder: 'Любая роль',
      onChange: (v) => apply({ targetRole: v }),
    },
    {
      kind: 'select',
      key: 'targetIsActive',
      label: 'Доступ',
      value: params.targetIsActive,
      options: accessOptions,
      placeholder: 'Любой доступ',
      onChange: (v) => apply({ targetIsActive: v }),
    },
    {
      kind: 'select',
      key: 'targetObjectId',
      label: 'Объект',
      value: params.targetObjectId,
      options: objectOptions,
      placeholder: 'Любой объект',
      loading: objectsLoading,
      onChange: (v) => apply({ targetObjectId: v }),
    },
    {
      kind: 'select',
      key: 'targetDepartmentId',
      label: 'Отдел',
      value: params.targetDepartmentId,
      options: departmentOptions ?? [],
      placeholder: 'Любой отдел',
      loading: departmentsLoading,
      onChange: (v) => apply({ targetDepartmentId: v }),
    },
    {
      kind: 'select',
      key: 'targetCounterpartyId',
      label: 'Контрагент',
      value: params.targetCounterpartyId,
      options: counterpartyGroups,
      placeholder: 'Любой контрагент',
      loading: counterpartiesLoading,
      onChange: (v) => apply({ targetCounterpartyId: v }),
    },
    {
      kind: 'select',
      key: 'targetArchive',
      label: 'Архивные учётки',
      value: params.targetArchive ?? 'include',
      options: archiveOptions,
      onChange: (v) => apply({ targetArchive: v ?? 'include' }),
    },
  ];

  return { filters, mobileFilters };
}
