import { Select, type SelectProps } from 'antd';
import { useSoleOptionAutoSelect } from '@shared/lib';

type AntdOption = NonNullable<SelectProps['options']>[number];

export interface AutoSelectProps extends SelectProps {
  /**
   * Подставлять единственный доступный вариант; по умолчанию — да, за этим компонент и нужен.
   * Выключается там, где пустое значение — осмысленный ответ: фильтр («все») и необязательное
   * поле («не указано»).
   */
  autoSelectSole?: boolean;
}

/**
 * `Select` с одним отличием: обязательное поле с единственным доступным вариантом выбирает его
 * само. Поле при этом остаётся обычным — открывается, ищется, показывает свой единственный
 * пункт; человек видит, из чего выбор, и не тратит клик на предрешённое.
 *
 * Подстановка идёт тем же `onChange`, который получил бы `Select`, поэтому и форма, и побочные
 * действия поля (сброс зависимых списков) отрабатывают как при обычном выборе. Замена штатного
 * `Select` — на месте: компонент принимает те же свойства и работает как внутри `Form.Item`,
 * так и с ручным `value`/`onChange`.
 */
export function AutoSelect({ autoSelectSole = true, ...props }: AutoSelectProps) {
  useSoleOptionAutoSelect<AntdOption>({
    value: props.value,
    options: props.options,
    onChange: props.onChange,
    // Заблокированное поле не заполняем: обычно оно ждёт выбора в поле-родителе.
    enabled: autoSelectSole && !props.disabled,
    loading: props.loading,
    multiple: props.mode === 'multiple' || props.mode === 'tags',
    respectManualClear: !!props.allowClear,
  });

  return <Select {...props} />;
}
