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

/**
 * Список выбора, в котором сохранённое у записи значение остаётся видимым, даже если из
 * действующего справочника оно выпало.
 *
 * Списки формы собираются из того, что действует сейчас: активные объекты и отделы, типы с живым
 * тарифом, контейнеры, стоящие на объекте. Правят же запись и через месяц — к тому времени объект
 * закрыт, тариф выключен, контейнер снят. Без этой добавки правка начиналась бы с пустого
 * обязательного поля: человек видит «не выбрано» там, где выбор давно сделан, и либо молча меняет
 * заказчика или предмет записи, либо не может её сохранить вовсе.
 *
 * Добавленный вариант — обычный, а не выключенный: значение у записи законное, и запрещать
 * оставить его как есть нечем. Там, где сохранённое выбрать заново уже нельзя (позиция
 * классификатора ТС — её не примет сервер), список собирается своим правилом
 * (`withSavedClassification`) и помечает вариант недоступным.
 */
export function withSavedOption<T extends { value: string; label: string }>(
  options: T[],
  saved: { id: string | null | undefined; name: string | null | undefined },
): (T | { value: string; label: string })[] {
  if (!saved.id || options.some((o) => o.value === saved.id)) return options;
  return [{ value: saved.id, label: saved.name ?? saved.id }, ...options];
}

/** Пусто ли поле: у обычного списка это `undefined | null | ''`, у множественного — пустой массив. */
export function isBlankValue(value: unknown): boolean {
  if (value == null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}
