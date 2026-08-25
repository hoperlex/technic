import { describe, expect, it } from 'vitest';
import {
  subjectFilterOptions,
  subjectFilterPatch,
  subjectFilterValue,
  subjectKindValue,
} from '../src/pages/waste/subjectFilter';

/**
 * Фильтр «Контейнер / машина» в списке заявок на вывоз. Одно поле спрашивает две разные вещи —
 * позицию справочника и вид целиком, — и вся цена ошибки здесь тихая: выбранные «все самосвалы»,
 * уехавшие на сервер как `containerTypeId`, вернут не отказ, а пустую таблицу, которая читается
 * как «таких заявок нет».
 *
 * Поэтому проверяется дорога значения туда и обратно: что уходит в параметры списка и чем поле
 * показывает уже заданный фильтр.
 */

const cont = [
  { value: 'ct-8', label: 'Контейнер 8 м³' },
  { value: 'ct-20', label: 'Контейнер 20 м³' },
];
const truck = [{ value: 'tr-1', label: 'Самосвал 10 т' }];

describe('фильтр предмета заявки на вывоз', () => {
  it('вид уходит своим параметром, а позиция справочника — своим', () => {
    expect(subjectFilterPatch(subjectKindValue('truck'))).toEqual({
      containerKind: 'truck',
      containerTypeId: undefined,
    });
    expect(subjectFilterPatch('ct-8')).toEqual({
      containerKind: undefined,
      containerTypeId: 'ct-8',
    });
  });

  it('сброс поля снимает оба параметра разом', () => {
    expect(subjectFilterPatch(undefined)).toEqual({
      containerKind: undefined,
      containerTypeId: undefined,
    });
  });

  it('поле показывает заданный фильтр тем же значением, каким его выбрали', () => {
    expect(subjectFilterValue({ containerKind: 'cont' })).toBe(subjectKindValue('cont'));
    expect(subjectFilterValue({ containerTypeId: 'ct-20' })).toBe('ct-20');
    expect(subjectFilterValue({})).toBeUndefined();
  });

  it('весь вид стоит первым пунктом своей группы', () => {
    const groups = subjectFilterOptions({ cont, truck });
    expect(groups.map((g) => g.label)).toEqual(['Контейнеры', 'Самосвалы']);
    expect(groups[0]!.options[0]).toEqual({
      value: subjectKindValue('cont'),
      label: 'Все контейнеры',
    });
    expect(groups[1]!.options[0]).toEqual({
      value: subjectKindValue('truck'),
      label: 'Все самосвалы',
    });
    // Позиции справочника остаются на месте — «все» их не заменяет, а дополняет.
    expect(groups[0]!.options.slice(1)).toEqual(cont);
  });

  it('пустой вид не даёт ни группы, ни варианта «все»', () => {
    const groups = subjectFilterOptions({ cont, truck: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.options.map((o) => o.value)).not.toContain(subjectKindValue('truck'));
  });
});
