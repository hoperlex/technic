/**
 * Разбор набора опций выпадающего списка. Чистые функции без React и без antd: ими пользуется
 * хук автоподстановки (useSoleOptionAutoSelect) и тесты.
 */

export type SelectValue = string | number;

/**
 * Опция списка в том виде, в каком её принимает antd `Select`: либо лист со значением, либо
 * группа с вложенными листьями (`OptGroup`). Метка не типизируется — для разбора она не нужна.
 */
export interface OptionLike {
  value?: SelectValue | null;
  disabled?: boolean;
  options?: readonly OptionLike[];
  [key: string]: unknown;
}

/** Раскрывает группы в плоский список листьев; вложенность у antd ровно одна. */
export function flattenOptions(options: readonly OptionLike[] | undefined): OptionLike[] {
  if (!options) return [];
  const flat: OptionLike[] = [];
  for (const o of options) {
    if (o.options) flat.push(...o.options);
    else flat.push(o);
  }
  return flat;
}

/** Листья, которые человек действительно может выбрать: со значением и не выключенные. */
export function selectableOptions(options: readonly OptionLike[] | undefined): OptionLike[] {
  return flattenOptions(options).filter((o) => o.value != null && !o.disabled);
}

/**
 * Единственный доступный вариант — или `undefined`, если их ноль либо больше одного.
 * Выключенные варианты не в счёт: их выбрать нельзя (тип самосвала без вместимости, статус
 * «Активна» у предложения неактивного арендодателя).
 */
export function soleOption(options: readonly OptionLike[] | undefined): OptionLike | undefined {
  const selectable = selectableOptions(options);
  return selectable.length === 1 ? selectable[0] : undefined;
}

/**
 * Сигнатура набора доступных значений. По ней автоподстановка отличает «список тот же самый»
 * от «список сменился» — например когда смена типа ТС перезаполняет список категорий.
 */
export function optionsKey(options: readonly OptionLike[] | undefined): string {
  return selectableOptions(options)
    .map((o) => String(o.value))
    .join('\u0000');
}

/** Пусто ли поле: у обычного списка это `undefined | null | ''`, у множественного — пустой массив. */
export function isBlankValue(value: unknown): boolean {
  if (value == null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}
