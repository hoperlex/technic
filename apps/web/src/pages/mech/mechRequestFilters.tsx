import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { REQUEST_STATUSES, requestStatusLabels } from '@technic/contracts';
import { mechKindOptionsQuery, mechLessorOptionsQuery } from '@entities/mech-request';
import { objectOptionsQuery } from '@entities/object';
import { useRequestCustomerOptions } from '@features/request-customer';
import { FilterReset, type FilterDefinition } from '@shared/ui';
import { flattenOptions, usePruneMissingFilters } from '@shared/lib';

const DATE = 'YYYY-MM-DD';

/**
 * Отбор списка аренд — **одним описанием** на десктоп и телефон (ADR 0030).
 *
 * Обычно панель над таблицей собирается разметкой, а шит на телефоне — списком описаний, и две
 * копии расходятся при первой же правке. Здесь описание одно, а панель десктопа рисуется по нему
 * же (`MechFilterBar`) — забыть половину нельзя.
 *
 * Главное здесь — **два независимых фильтра вместо привычного одного** (Р20). У соседних модулей
 * заказчик один, и его пара колонок взаимоисключающа; у механизации площадка заполнена **всегда**
 * (это место эксплуатации), а заявителя различает отдел. Один `objectId` не может быть
 * одновременно фильтром места и половиной фильтра заявителя — поэтому и параметров два:
 * `placeObjectId` возвращает обе заявки площадки, `requester` — по одной. Готовый
 * `useRequestCustomerFilter` соседей сюда не годится ровно по этой причине, и переиспользован из
 * него только подбор опций.
 */

export interface MechListFilters {
  status?: string;
  /** Площадка — место эксплуатации (Р17), а не заказчик. */
  placeObjectId?: string;
  /** Заявитель ключом `object:<id>` / `department:<id>` (Р20). */
  requester?: string;
  /** Вид техники: сервер сравнивает по нормализованному ключу, а не по введённой строке (Р5). */
  kind?: string;
  lessorId?: string;
  /** Окно вопроса «что стояло на площадке в эти дни», а не срок самой заявки. */
  periodFrom?: string;
  periodTo?: string;
  /**
   * Просрочен возврат (Р12): действующая аренда, у которой плановая дата уже позади.
   *
   * Строкой `'true'`, а не булевым: значением отбора распоряжаются трое сразу — запрос
   * (`booleanFlagSchema` ждёт `true`/`false`), память набора (ADR 0139 пишет только строки) и
   * «Сбросить» (снимает в `undefined`). Булево `false` из хранилища не вернулось бы, и утром
   * отбор молча оказывался бы снятым.
   */
  overdue?: string;
}

/**
 * Ключи отборов — те же поля, но перечнем: по ним хук списка запоминает набор между сеансами
 * (ADR 0139), строит «Сбросить» и решает, задан ли отбор вообще. Тип сторожит совпадение — поле,
 * добавленное в отбор и забытое здесь, перестало бы запоминаться молча.
 *
 * Номера заявки здесь нет намеренно: он живёт отдельной строкой поиска и набором отборов не
 * является — «МХ-42» ищут разово, а не работают в этом срезе.
 */
export const MECH_FILTER_FIELDS = [
  'status',
  'placeObjectId',
  'requester',
  'kind',
  'lessorId',
  'periodFrom',
  'periodTo',
  'overdue',
] as const satisfies readonly (keyof MechListFilters)[];

/**
 * Статусы перечисляются коридором целиком, кроме «Завершена»: у аренды её не бывает вовсе (Р8), и
 * вариант фильтра, на который сервер отвечает пустотой, хуже его отсутствия.
 */
const statusOptions = REQUEST_STATUSES.filter((s) => s !== 'completed').map((value) => ({
  value,
  label: requestStatusLabels[value],
}));

export function useMechRequestFilters({
  params,
  apply,
  status = true,
}: {
  params: MechListFilters;
  apply: (patch: MechListFilters) => void;
  /**
   * Показывать ли отбор по статусу. Рабочему списку он нужен, вкладке «В аренде» — нет: там все
   * строки в «В работе» по построению отбора (Р2), и выбор «Новая» отвечал бы пустотой на верно
   * заданный вопрос. Прятать отбор честнее, чем оставлять вариант, которого в выдаче не бывает.
   */
  status?: boolean;
}): FilterDefinition[] {
  const { data: objectOptions = [], isSuccess: objectsReady } = useQuery(
    objectOptionsQuery({ activeOnly: false }),
  );
  const {
    data: lessorOptions = [],
    isFetching: lessorsLoading,
    isSuccess: lessorsReady,
  } = useQuery(mechLessorOptionsQuery());
  // Подсказка видов строится по той же области, что и список: чужих позиций в ней не бывает.
  const { data: kindOptions = [] } = useQuery(mechKindOptionsQuery(''));

  /*
   * Заявитель — тем же подбором «Объект/отдел», что и в форме (Р20): формат ключа один, и второй
   * его реализации в портале нет. Сужение по оси учётки считает сам подбор — объектной роли
   * отделы не показываются вовсе, отдельской не показываются объекты.
   */
  const requester = useRequestCustomerOptions({ objects: 'scope', departments: 'scope' });

  /**
   * Восстановленный набор мог пережить сам предмет отбора: площадку закрыли, арендодателя
   * приостановили (ADR 0139). Такое значение уходит в запрос, но в поле показывается сырым
   * идентификатором — человек остаётся с пустым списком и без причины. Снимаем.
   *
   * Заявитель проверяется по **раскрытым** группам: подбор отдаёт список группами, а проверка
   * читает листья — по группам она не нашла бы ни одного значения и снесла бы отбор целиком.
   */
  usePruneMissingFilters(
    [
      // Скрытый отбор не проверяется: вкладка без него статуса и не задаёт, а сообщение «отбор
      // снят, потому что значение исчезло» о невидимом поле человек прочесть не сможет.
      {
        key: 'status',
        value: status ? params.status : undefined,
        options: statusOptions,
        ready: true,
      },
      {
        key: 'placeObjectId',
        value: params.placeObjectId,
        options: objectOptions,
        ready: objectsReady,
      },
      {
        key: 'lessorId',
        value: params.lessorId,
        options: lessorOptions,
        ready: lessorsReady,
      },
      {
        key: 'requester',
        value: params.requester,
        options: flattenOptions(requester.options) as { value: string }[],
        ready: !requester.loading && requester.options.length > 0,
      },
    ],
    (keys) => apply(Object.fromEntries(keys.map((key) => [key, undefined]))),
  );

  return [
    {
      kind: 'select',
      key: 'requester',
      label: 'Заявитель',
      value: params.requester,
      options: requester.options,
      placeholder: 'Все заявители',
      loading: requester.loading,
      onChange: (v) => apply({ requester: v }),
    },
    {
      kind: 'select',
      key: 'placeObjectId',
      label: 'Площадка',
      value: params.placeObjectId,
      options: objectOptions,
      placeholder: 'Все площадки',
      onChange: (v) => apply({ placeObjectId: v }),
    },
    {
      kind: 'select',
      key: 'kind',
      label: 'Вид техники',
      value: params.kind,
      options: kindOptions,
      placeholder: 'Любая техника',
      onChange: (v) => apply({ kind: v }),
    },
    ...(status
      ? [
          {
            kind: 'select' as const,
            key: 'status',
            label: 'Статус',
            value: params.status,
            options: statusOptions,
            placeholder: 'Все статусы',
            onChange: (v: string | undefined) => apply({ status: v }),
          },
        ]
      : []),
    {
      kind: 'select',
      key: 'lessorId',
      label: 'Арендодатель',
      value: params.lessorId,
      options: lessorOptions,
      loading: lessorsLoading,
      placeholder: 'Все арендодатели',
      onChange: (v) => apply({ lessorId: v }),
    },
    {
      // Период — окно вопроса «что стояло на площадке в эти дни»: в него попадает заявка, чей срок
      // с ним пересекается, а не та, что начата ровно в этот день.
      kind: 'dateRange',
      key: 'period',
      label: 'Период аренды',
      from: params.periodFrom,
      to: params.periodTo,
      onChange: (periodFrom, periodTo) => apply({ periodFrom, periodTo }),
    },
    {
      /*
       * «Просрочен возврат» — отбор сервера, а не подсветка строк (Р12): просрочка считается
       * предикатом по московскому дню, и посчитать её на клиенте можно было бы только по той
       * странице, что уже приехала, — то есть ответить «просроченных нет», пока они на второй.
       */
      kind: 'toggle',
      key: 'overdue',
      label: 'Просрочен возврат',
      value: params.overdue === 'true',
      onChange: (checked) => apply({ overdue: checked ? 'true' : undefined }),
    },
  ];
}

/**
 * Один фильтр в панели десктопа. Обычная функция, а не компонент: она вызывается прямо из разметки
 * панели и своего состояния не имеет — объявленный внутри компонент пересоздавался бы на каждый
 * рендер и терял бы фокус поля при вводе.
 */
function renderFilter(filter: FilterDefinition): ReactNode {
  switch (filter.kind) {
    case 'select':
      return (
        <Select
          key={filter.key}
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder={filter.placeholder ?? filter.label}
          options={filter.options}
          loading={filter.loading}
          disabled={filter.disabled}
          value={filter.value}
          onChange={(v) => filter.onChange(v)}
        />
      );
    case 'toggle':
      // Флажком, а не переключателем: в панели десктопа он стоит в одном ряду с полями отбора, и
      // подпись должна читаться слева направо вместе с ними — как у архива в реестре техники.
      return (
        <Checkbox
          key={filter.key}
          checked={filter.value}
          disabled={filter.disabled}
          onChange={(e) => filter.onChange(e.target.checked)}
        >
          {filter.label}
        </Checkbox>
      );
    case 'dateRange':
      return (
        <DatePicker.RangePicker
          key={filter.key}
          format="DD.MM.YYYY"
          style={{ width: 250 }}
          allowEmpty={[true, true]}
          placeholder={['Аренда с', 'по']}
          value={[filter.from ? dayjs(filter.from) : null, filter.to ? dayjs(filter.to) : null]}
          onChange={(range) =>
            filter.onChange(
              range?.[0] ? range[0].format(DATE) : undefined,
              range?.[1] ? range[1].format(DATE) : undefined,
            )
          }
        />
      );
    default:
      // Прочих видов у этого списка нет: описания собираются здесь же, и ветка-заглушка ловила бы
      // только собственную опечатку — молча и на экране.
      return null;
  }
}

/**
 * Панель фильтров десктопа из тех же описаний, что уходят в шит телефона, плюс поиск по номеру.
 *
 * Номер стоит в панели, а не в шите: «МХ-42» набирают, придя из переписки, — это разовый вопрос к
 * списку, а не срез, в котором работают.
 */
export function MechFilterBar({
  filters,
  num,
  reset,
}: {
  filters: FilterDefinition[];
  num: { text: string; onChange: (raw: string) => void };
  reset?: { active: boolean; onClick: () => void };
}) {
  return (
    <Space wrap>
      {filters.map(renderFilter)}
      <Input
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={num.text}
        onChange={(e) => num.onChange(e.target.value)}
      />
      {reset ? <FilterReset {...reset} /> : null}
    </Space>
  );
}
