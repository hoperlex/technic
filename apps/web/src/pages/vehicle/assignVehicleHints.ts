import {
  assignmentRateLabel,
  type VehicleDto,
  vehicleLabel,
  type VehicleOwnership,
  type VehicleSubstitution,
  vehicleSubstitutionHint,
} from '@technic/contracts';

/**
 * Что окно назначения говорит про саму машину: чем подписана строка списка и чем объяснён пустой
 * список.
 *
 * Второй такой же модуль рядом с `assignDriverHints`, и разделены они по тому же принципу: здесь
 * формулировки, а не состояние формы. Ветки принадлежности, подстановка ставок и сброс полей
 * остались в `VehicleAssignModal` — эти же функции ничего не знают, кроме своих аргументов, и
 * читаются целиком, не сползая в соседний экран.
 *
 * Не слиты с подсказками про человека нарочно: список техники и список водителей объясняются
 * разными правилами (ADR 0059, ADR 0064 против ADR 0055, ADR 0083), и общий файл склеил бы два
 * разговора, у которых нет ни одного общего аргумента.
 */

/**
 * Строка выбора: подпись машины плюс то, чем одна единица отличается от другой. Тип и категория —
 * первое, чем они различаются в списке вида, поэтому у собственной машины позиция классификатора
 * стоит рядом с моделью, а не вместо неё. Расхождение с заказанным проговаривается прямо в строке
 * и с направлением («крупнее», «меньше заказанного»): подходит ли эта машина, решает человек — по
 * названию модели и по тому, что он о ней знает.
 */
export function vehicleOptionLabel(v: VehicleDto, substitution: VehicleSubstitution): string {
  const title = vehicleLabel(v);
  const extra = [
    v.ownership === 'own' ? v.modelName : null,
    // Наименование категории уже содержит тип (ADR 0016 §11); без категории тип называется сам.
    v.categoryName ?? v.typeName,
    vehicleSubstitutionHint(substitution),
    assignmentRateLabel(v) || null,
  ].filter((s): s is string => !!s && s !== title);
  return extra.length > 0 ? `${title} — ${extra.join(' · ')}` : title;
}

/**
 * Чем объяснён пустой список техники. Пусто — значит пусто в парке целиком: список не сужен ни
 * типом, ни видом (ADR 0064), и обещать, что техника найдётся где-то ещё, нечем.
 */
export function emptyVehicleListText(input: {
  isFetching: boolean;
  ownership: VehicleOwnership;
  lessorId: string | undefined;
}): string {
  return input.isFetching
    ? 'Загружаем технику…'
    : input.ownership === 'own'
      ? 'Собственной техники в работе нет — возьмите её в аренду'
      : input.lessorId
        ? 'У этого арендодателя нет активных предложений'
        : 'Активных предложений аренды нет';
}
