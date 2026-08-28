import { wasteObjectScopeIds } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';

/**
 * Область учётки в модуле «Вывоз мусора» (ADR 0062): у объектной роли — свои объекты, у роли
 * отдела — площадки её отделов (с ADR 0144 их бывает несколько). Устроена как `useObjectScope` и
 * отвечает на те же три вопроса: чем сузить список объектов, чем заполнить поле и когда его
 * запереть — и ветки «объектов несколько» ей не добавлялось: набор она принимала с самого начала,
 * потому что у объектной роли объектов всегда бывало много.
 *
 * Отдельным хуком, а не веткой внутри `useObjectScope`: тот спрашивают вкладки «Заказа ТС», где
 * у роли отдела заказчик — отдел, а не площадка. Подмешать производные объекты туда значило бы
 * подставить в фильтр списка объект рядом с отделом — заявки с двумя заказчиками не бывает, и
 * список вышел бы заведомо пустым.
 *
 * Портал сужает выбор, но не решает доступ: чужой объект сервер всё равно отдаёт как 403
 * (`assertWasteObjectScope`), а список — как пустую выборку (`wasteRequestVisibilityWhere`).
 */
export function useWasteObjectScope() {
  const { user } = useAuth();
  const scopeIds = wasteObjectScopeIds(user);
  /** `null` — «областью не ограничен»: диспетчер, менеджер, наблюдатель, администратор. */
  const isScoped = scopeIds !== null;
  const ownObjectIds = scopeIds ?? [];

  return {
    isScoped,
    ownObjectIds,
    /**
     * Единственный объект области: им заполняются фильтр списка и поле формы. `null`, когда
     * объектов несколько — тогда выбирает человек, и подставленный за него первый попавшийся
     * завёл бы заявку не на ту площадку.
     */
    soleObjectId: ownObjectIds.length === 1 ? ownObjectIds[0]! : null,
    /** Поле объекта заперто, когда выбирать не из чего: в области ровно один объект. */
    objectFieldDisabled: isScoped && ownObjectIds.length <= 1,
    /** Оставляет в списке только свои объекты: чужие этой учётке и выбирать незачем. */
    limitObjectOptions<T extends { value: string }>(options: T[]): T[] {
      return isScoped ? options.filter((o) => ownObjectIds.includes(o.value)) : options;
    },
  };
}
