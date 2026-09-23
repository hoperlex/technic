/**
 * Ответы формы по набору объектов, в пределах которого работает учётка: чем сузить список, чем
 * заполнить поле и когда его запереть. `null` означает «областью не ограничен» и отличается от
 * пустого набора, как «видит всё» отличается от «не видит ничего».
 *
 * СВОЕЙ ОСИ ЗДЕСЬ НЕТ ВОВСЕ — набор приходит готовым, и в этом смысл файла. Осей у портала две, и
 * они разные: прямая привязка объектной роли (`useObjectScope`, ADR 0039) и производная площадочная
 * (`usePlaceObjectScope`, ADR 0062, ADR 0144, ADR 0201). А вот ответы формы у них одни и те же, и
 * написанные дважды они расходились бы молча: правку внесли бы в тот хук, на который наткнулись, —
 * так в одном из них и появилась бы ветка «объектов несколько», которой нет в другом.
 *
 * Правилом портала это не делает: функция знает про набор строк, а не про роли и их области.
 */
export interface ObjectScopeAnswers {
  /** Объекты области; пусто и у роли без ограничений, и у роли с пустой областью — различает их флаг хука. */
  ownObjectIds: readonly string[];
  /**
   * Единственный объект области: им заполняются фильтр списка и поле формы. `null`, когда объектов
   * несколько — тогда выбирает человек, и подставленный за него первый попавшийся завёл бы заявку
   * не на ту площадку.
   */
  soleObjectId: string | null;
  /**
   * Поле объекта заперто, когда выбирать не из чего: в области ровно один объект либо ни одного.
   * Не «область есть» — с несколькими объектами запертое поле показывало бы один из них как
   * единственно возможный.
   */
  objectFieldDisabled: boolean;
  /** Оставляет в списке только свои объекты: чужие этой учётке и выбирать незачем. */
  limitObjectOptions<T extends { value: string }>(options: T[]): T[];
}

export function objectScopeAnswers(scopeIds: readonly string[] | null): ObjectScopeAnswers {
  const isScoped = scopeIds !== null;
  const ownObjectIds = scopeIds ?? [];
  return {
    ownObjectIds,
    soleObjectId: ownObjectIds.length === 1 ? ownObjectIds[0]! : null,
    objectFieldDisabled: isScoped && ownObjectIds.length <= 1,
    limitObjectOptions<T extends { value: string }>(options: T[]): T[] {
      return isScoped ? options.filter((o) => ownObjectIds.includes(o.value)) : options;
    },
  };
}
