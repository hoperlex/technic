import { parseCostTargetKey } from '@technic/contracts';
import { flattenOptions } from '@shared/lib';
import { AutoSelect, type AutoSelectProps } from '@shared/ui';
import type { RequestCustomerGroup } from '../model/useRequestCustomerOptions';

export interface RequestCustomerSelectProps extends Omit<AutoSelectProps, 'options'> {
  /** Группы подбора — как их собрал `useRequestCustomerOptions`. */
  options: RequestCustomerGroup[];
}

/**
 * Поле «Объект/отдел»: заказчик заявки одним списком с группами (план
 * `docs/department-requests-plan.md`, Р2).
 *
 * Обычный `AutoSelect`, поэтому работает и внутри `Form.Item` (значение приходит от неё), и с
 * ручными `value`/`onChange` — так его берут фильтры списков. Единственный вариант поле подставит
 * себе само, пока оно не заперто; запертое заполняет форма ключом `soleCustomerKey` (Р3а, К6) —
 * решать это за неё компонент не может, потому что не знает, почему поле заперто.
 */
export function RequestCustomerSelect({ options, value, ...props }: RequestCustomerSelectProps) {
  return (
    <AutoSelect
      showSearch
      optionFilterProp="label"
      placeholder="Выберите объект или отдел"
      style={{ width: '100%' }}
      {...props}
      value={shownValue(value, options)}
      options={options}
    />
  );
}

/**
 * Что показать в поле. Значение из своих опций — как есть; чужое проверяется разбором и, не
 * оказавшись ключом, показывается пустым (Р2а).
 *
 * Разбор стоит здесь, а не на горячем пути формы: сюда значение приходит извне — из записи, из
 * параметра адресной строки, из соседнего поля, сменившего состав списка, — и «не ключ» тут
 * обычный ответ. Пройденный молча, он превратился бы в поле, которое показывает выбор, а
 * отправляет пустоту.
 *
 * Ключ, которого в списке нет, поле показывает: это либо сохранённое значение записи (К7), либо
 * заказчик, выпавший из состава поля, — и подменять его пустотой значило бы менять запись за
 * человека.
 */
function shownValue(value: unknown, options: RequestCustomerGroup[]): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const known = flattenOptions(options).some((o) => o.value === value);
  return known || parseCostTargetKey(value) ? value : undefined;
}
