import { placeObjectScopeIds } from '@technic/contracts';
import { objectScopeAnswers } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';

/**
 * **Площадочная** область учётки (ADR 0062): у объектной роли — свои объекты, у роли отдела —
 * площадки её отделов (с ADR 0144 их бывает несколько).
 *
 * Имя называет ось, а не модуль: по ней ходят вывоз мусора, механизация и — с ADR 0201 — заказ
 * спецтехники, то есть всё, где заказчиком стоит объект. Второй такой хук на модуль означал бы
 * второе описание одной области; правило живёт в контрактах (`placeObjectScopeIds`), а ответы
 * формы — в общем `objectScopeAnswers`, там же, откуда их берёт вторая ось портала.
 *
 * Отдельным хуком, а не веткой внутри `useObjectScope`: тот отвечает за **прямую** привязку
 * объектной роли и спрашивается там, где у роли отдела заказчиком стоит её отдел, — в заказе
 * грузоперевозки. Подмешать производные объекты туда значило бы подставить в фильтр списка объект
 * рядом с отделом, а заявки с двумя заказчиками не бывает: список вышел бы заведомо пустым.
 *
 * Портал сужает выбор, но не решает доступ: чужой объект сервер всё равно отдаёт как 403
 * (`assertPlaceObjectScope`, `assertRequestScope`), а список — как пустую выборку
 * (`placeObjectVisibilityWhere`, `vehicleRequestVisibilityWhere`).
 */
export function usePlaceObjectScope() {
  const { user } = useAuth();
  const scopeIds = placeObjectScopeIds(user);
  return {
    /** Есть ли у учётки площадочная ось вовсе: у диспетчера, менеджера, наблюдателя и админа её нет. */
    isScoped: scopeIds !== null,
    ...objectScopeAnswers(scopeIds),
  };
}
