import type { ReactNode } from 'react';
import { costTargetKey, type CostTargetKey } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import { RequestCustomerSelect } from '../ui/RequestCustomerSelect';
import { useRequestCustomerOptions } from './useRequestCustomerOptions';

/**
 * Фильтр списка по заказчику «Объект/отдел» — тем же подбором, что и в форме (план
 * `docs/department-requests-plan.md`, Р9).
 *
 * Списков с ним три — лента заказов, «История» и «Архив», — и в каждом фильтр устроен одинаково:
 * значение поля собирается из пары параметров `{ objectId, departmentId }`, а выбор раскладывается
 * обратно и **той же правкой чистит вторую половину**. Оставленный объект продолжал бы сужать
 * выдачу вместе с выбранным отделом, и список отвечал бы пустым по обоим сразу; повторённое трижды,
 * это правило разъехалось бы по вкладкам — а стоит оно ровно там, где собирается ключ.
 *
 * Хук отдаёт и десктопный контрол, и описание фильтра для шита на телефоне (ADR 0030) — так же,
 * как соседи по панели (`useVehicleFilter`, `useVehicleClassificationFilter`): одно значение,
 * посчитанное один раз, и два его вида.
 *
 * Умолчания фильтра (единственный объект или отдел учётки) остаются за списком: они про то, с чего
 * список открывается, а не про то, как устроен выбор, — и задаются там же, где прочие умолчания
 * параметров.
 */

export interface RequestCustomerFilterInput {
  /**
   * Текущая пара параметров списка: заполнена не больше чем одна половина — у заявки заказчик
   * один. Не `RequestCustomerPair`, потому что в параметрах списка «не задан» — это `undefined`
   * («все»), а не `null`.
   */
  objectId: string | undefined;
  departmentId: string | undefined;
  /**
   * Применение выбора. Патч приходит **обеими** половинами сразу, и вторая в нём — `undefined`:
   * так вызов работает и через `setParams((p) => ({ ...p, ...patch }))`, где ключ, которого в
   * патче нет, остался бы прежним.
   */
  onChange: (patch: { objectId?: string; departmentId?: string }) => void;
  /** Подпись фильтра в шите на телефоне. */
  label?: string;
  placeholder?: string;
  /** Ширина десктопного контрола. */
  width?: number;
}

export interface RequestCustomerFilter {
  /** Поле для панели фильтров над таблицей. */
  controls: ReactNode;
  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  mobileFilter: FilterDefinition;
}

export function useRequestCustomerFilter({
  objectId,
  departmentId,
  onChange,
  label = 'Заказчик',
  placeholder = 'Все заказчики',
  width = 240,
}: RequestCustomerFilterInput): RequestCustomerFilter {
  // Состав тот же, что в форме (Р3): своя ось у заявителя, обе группы у офиса и у тех, кто заявки
  // только читает. Сохранённого значения у фильтра нет — он спрашивает справочник, а не запись.
  const customer = useRequestCustomerOptions();

  const value: CostTargetKey | undefined = departmentId
    ? costTargetKey({ kind: 'department', id: departmentId })
    : objectId
      ? costTargetKey({ kind: 'object', id: objectId })
      : undefined;

  // Род выбранного решает, в какой параметр писать; вторая половина уходит пустой всегда, в том
  // числе при очистке поля, — и «все заказчики» означает именно всех, а не пересечение двух осей.
  const apply = (next: string | undefined) => {
    const pair = customer.customerPairOf(next);
    onChange({
      objectId: pair.objectId ?? undefined,
      departmentId: pair.departmentId ?? undefined,
    });
  };

  const controls = (
    <RequestCustomerSelect
      allowClear
      // Пустое значение фильтра означает «все», и предрешать его единственным вариантом нечем:
      // подставленный сам собой, он читался бы как выбор, которого человек не делал.
      autoSelectSole={false}
      placeholder={placeholder}
      style={{ width }}
      options={customer.options}
      loading={customer.loading}
      // Вариант один (свой объект у штаба, свой отдел у сотрудника) — выбирать не из чего.
      disabled={customer.disabled}
      value={value}
      onChange={apply}
    />
  );

  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'customer',
    label,
    value,
    options: customer.options,
    placeholder,
    loading: customer.loading,
    disabled: customer.disabled,
    onChange: apply,
  };

  return { controls, mobileFilter };
}
