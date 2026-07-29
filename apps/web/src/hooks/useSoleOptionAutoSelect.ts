import { useEffect, useRef } from 'react';
import {
  isBlankValue,
  optionsKey,
  soleOption,
  type OptionLike,
  type SelectValue,
} from '../utils/selectOptions';

interface Params<O extends OptionLike> {
  /** Текущее значение поля (в форме приходит от `Form.Item`). */
  value: unknown;
  options: readonly O[] | undefined;
  /** Тот же `onChange`, что получил бы `Select`: вызов проходит и по цепочке формы. */
  onChange: ((value: SelectValue | SelectValue[], option: O) => void) | undefined;
  /** Выключено — поведения нет вовсе (необязательное поле, фильтр, заблокированное поле). */
  enabled: boolean;
  /** Список ещё грузится: подставлять по неполным данным нельзя. */
  loading?: boolean;
  /** Множественный режим: значение подставляется массивом из одного элемента. */
  multiple?: boolean;
  /**
   * Поле можно очистить руками (`allowClear`). Тогда очищенное значение не возвращаем обратно —
   * иначе поле стало бы неочищаемым. Для полей без крестика (а обязательные у нас такие)
   * пустое значение означает сброс формы, и подставлять нужно снова.
   */
  respectManualClear?: boolean;
}

/**
 * Обязательный список с единственным доступным вариантом заполняет себя сам: выбирать там
 * нечего, а незаполненное поле стоит человеку лишнего клика и отказа валидации.
 *
 * Уже выбранное значение не трогается никогда — иначе правка записи молча меняла бы её данные.
 */
export function useSoleOptionAutoSelect<O extends OptionLike>({
  value,
  options,
  onChange,
  enabled,
  loading = false,
  multiple = false,
  respectManualClear = false,
}: Params<O>): void {
  // Опции и onChange задаются инлайном (`.map()` прямо в теле компонента) и меняются по ссылке
  // каждый рендер. Эффект держится за сигнатуру набора, а сами значения читает из ref — иначе он
  // перезапускался бы на каждый рендер родителя.
  const latest = useRef({ options, onChange });
  latest.current = { options, onChange };

  // Набор, для которого подстановка уже выполнялась. Нужен только очищаемым полям.
  const appliedKeyRef = useRef<string | null>(null);

  const key = optionsKey(options);
  const blank = isBlankValue(value);

  useEffect(() => {
    if (!enabled || loading) return;
    const sole = soleOption(latest.current.options) as O | undefined;
    if (!sole || sole.value == null) return;
    if (!blank) {
      // Значение есть (выбрали руками или пришло из записи) — набор считаем отработанным.
      appliedKeyRef.current = key;
      return;
    }
    if (respectManualClear && appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    latest.current.onChange?.(multiple ? [sole.value] : sole.value, sole);
  }, [enabled, loading, blank, key, multiple, respectManualClear]);
}
