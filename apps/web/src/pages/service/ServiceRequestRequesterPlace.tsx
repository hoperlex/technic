import type { ReactNode } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { departmentOptionsQuery } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import { AutoSelect } from '@shared/ui';

/** Учётка заводящего: из её привязок и собирается поле. */
interface Requester {
  departmentIds: string[];
  constructionObjectIds: string[];
}

/** Что уходит в тело заведения: заполнено не больше одного поля, чаще — ни одного. */
interface RequesterPlaceBody {
  requesterDepartmentId?: string;
  requesterObjectId?: string;
}

type RequesterPlaceAxis = 'department' | 'object' | null;

/**
 * Какое подразделение заявителя форма обязана спросить (Н11).
 *
 * `null` — не спрашивать вовсе: сервер подставит единственную привязку учётки сам, а у учётки без
 * привязок подразделения нет и не будет (администратор портала) — это законное состояние, а не
 * пробел. Обязательное поле с единственным вариантом стоило бы человеку клика и ничего не решало.
 *
 * Площадка — запасная ось, а не вторая равноправная: у учётки с отделами подразделением остаётся
 * отдел, и выбор площадки в обход него сервер отбивает 422 («у заявителя есть отдел»). Поэтому
 * объекты спрашиваются только там, где отделов нет совсем.
 */
function requesterPlaceAxis(user: Requester | null | undefined): RequesterPlaceAxis {
  if (!user) return null;
  if (user.departmentIds.length > 1) return 'department';
  if (user.departmentIds.length === 0 && user.constructionObjectIds.length > 1) return 'object';
  return null;
}

/**
 * Подразделение заявителя в форме заведения (Н11) — «откуда человек», а не «от чьего имени
 * просят»: заказчика выбирают («чужой» принтер соседнего отдела), а здесь записано, где числится
 * сам подавший.
 *
 * Поле появляется ровно тогда, когда одного ответа у учётки нет: два отдела (или две площадки при
 * отсутствии отделов). Иначе сервер отвечает 422 «Укажите отдел, в котором числится заявитель», и
 * заявка не заводится вовсе — а человек видит отказ по полю, которого в форме не было.
 *
 * Состав — **только свои** привязки: сервер сверяет присланное с учёткой `created_by` и на чужое
 * отвечает 422. Предложи форма весь справочник — выбор оказался бы отказом после заполнения.
 *
 * Хуком, а не компонентом: у формы два дела с этим полем — показать его и собрать тело запроса, —
 * и оба зависят от одной оси. Разложенные по двум местам, они разошлись бы на первой же правке:
 * поле спрашивало бы отдел, а тело уходило бы с площадкой.
 */
export function useRequesterPlace({
  user,
  open,
}: {
  /** `null` — правка заявки: подразделение снято снимком при заведении и задним числом не меняется. */
  user: Requester | null | undefined;
  open: boolean;
}): { field: ReactNode; body: (placeId: string | undefined) => RequesterPlaceBody } {
  const axis = requesterPlaceAxis(user);
  const ids =
    axis === 'department' ? (user?.departmentIds ?? []) : (user?.constructionObjectIds ?? []);
  const departments = useQuery({
    ...departmentOptionsQuery(),
    enabled: open && axis === 'department',
  });
  // Закрытые площадки тоже показываются: человек на такой числится, и «моей площадки в списке
  // нет» означало бы заявку, которую он не заведёт вовсе.
  const objects = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    enabled: open && axis === 'object',
  });

  const source = axis === 'department' ? departments : objects;
  const options = (source.data ?? []).filter((option) => ids.includes(option.value));

  return {
    // Пропуск поля — не «не заполнили», а «выбирать было не из чего»: сервер отвечает на него
    // подстановкой единственной привязки учётки, и пустое значение вместо пропуска отняло бы
    // подразделение у того, у кого отдел есть.
    body: (placeId) =>
      axis === 'department'
        ? { requesterDepartmentId: placeId }
        : axis === 'object'
          ? { requesterObjectId: placeId }
          : {},
    field: axis && (
      <Form.Item
        name="requesterPlaceId"
        label={axis === 'department' ? 'Отдел заявителя' : 'Площадка заявителя'}
        extra={
          axis === 'department'
            ? 'Где числится тот, кто заводит заявку: заказчик выше — про то, от чьего имени просят'
            : 'На какой площадке работает тот, кто заводит заявку'
        }
        rules={[{ required: true, message: 'Выберите подразделение заявителя' }]}
      >
        <AutoSelect
          showSearch
          optionFilterProp="label"
          loading={source.isFetching}
          options={options}
          placeholder={axis === 'department' ? 'Ваш отдел' : 'Ваша площадка'}
          notFoundContent="Привязок учётки не видно — обратитесь к администратору портала"
        />
      </Form.Item>
    ),
  };
}
