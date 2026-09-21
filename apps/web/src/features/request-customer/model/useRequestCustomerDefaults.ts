import { useDepartmentScope } from '../../../hooks/useDepartmentScope';
import { useObjectScope } from '../../../hooks/useObjectScope';
import { usePlaceObjectScope } from '../../../hooks/usePlaceObjectScope';

/**
 * Умолчание фильтра «Заказчик» в списках модуля «Заказ ТС»: с чего список открывается, пока
 * человек ничего не выбрал.
 *
 * Правило одно — **предрешённый заказчик**: сужать список сразу имеет смысл только там, где выбора
 * всё равно нет. У объектной роли с одним объектом это он (ADR 0039), у отдела с одним отделом —
 * отдел (ADR 0040).
 *
 * Отдел с площадками умолчания не получает вовсе (ADR 0201). Его область шире отдела: рядом с
 * собственными заявками в списке стоят заявки его площадок, и предрешённый фильтр по отделу спрятал
 * бы половину — в том числе заказ спецтехники, который человек только что завёл и пришёл проверить.
 *
 * Одним хуком на две вкладки (лента и «История»), а не двумя копиями: правило про область, и
 * разошедшись, копии открывали бы один и тот же список по-разному.
 */
export interface RequestCustomerDefaults {
  objectId: string | undefined;
  departmentId: string | undefined;
}

export function useRequestCustomerDefaults(): RequestCustomerDefaults {
  const { soleObjectId } = useObjectScope();
  const { soleDepartmentId } = useDepartmentScope();
  const { ownObjectIds: ownPlaceObjectIds } = usePlaceObjectScope();

  return {
    objectId: soleObjectId ?? undefined,
    // Роль спрашивать незачем: единственный отдел бывает только у отдельской оси, а площадки у
    // объектной равны её же объектам — и там условие ниже ни на что не влияет.
    departmentId:
      soleDepartmentId !== null && ownPlaceObjectIds.length === 0 ? soleDepartmentId : undefined,
  };
}
