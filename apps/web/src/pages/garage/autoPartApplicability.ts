import { useQuery } from '@tanstack/react-query';
import type { AutoPartApplicabilityDto, AutoPartApplicabilityInput } from '@technic/contracts';
import { autoPartRefKeys } from '@entities/auto-part';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { vehicleModelsApi, vehicleTypesApi } from '../../api/resources';

/**
 * Применимость автозапчасти для полей портала (план `docs/auto-parts-plan.md`, Р8): к каким
 * моделям и типам техники подходит деталь.
 *
 * Разметка **одна**, а ссылок в ней две — либо модель, либо тип, ровно одна из двух. Поэтому и
 * поле одно: два списка рядом («модели» и «типы») заставили бы человека решать, в каком из них
 * искать «Самосвалы», ещё до того, как он ответил на вопрос «к чему подходит эта деталь».
 * Значение поля несёт вид ссылки в самом себе (`m:` / `t:`), а не рядом с ним: разложенные по
 * двум полям, они разошлись бы при первой правке.
 *
 * Модуль общий у трёх мест: отбор вкладки, форма позиции и подпись выбранного. Один и тот же
 * перечень, собранный в двух местах, разъехался бы на первой же правке подписи — а подпись здесь
 * значащая: имя модели уникально **в пределах типа**, и одинокое «65115» не отвечает, чей это
 * самосвал.
 */

/** Опция списка выбора — тот вид, в котором её принимают и antd `Select`, и `withSavedOption`. */
export interface ApplicabilityOption {
  value: string;
  label: string;
}

/** Значение поля: вид ссылки плюс идентификатор. Разбирается обратно `applicabilityBody`. */
export const modelValue = (id: string): string => `m:${id}`;
export const typeValue = (id: string): string => `t:${id}`;

/** Значение поля по строке разметки, пришедшей с сервера, — для заполнения формы правки. */
export function applicabilityValue(row: AutoPartApplicabilityDto): string {
  return row.vehicleModel ? modelValue(row.vehicleModel.id) : typeValue(row.vehicleType?.id ?? '');
}

/**
 * Набор значений поля обратно в тело запроса. Обе ссылки называются явно, включая пустую: схема
 * `.strict()` и требует ровно одну заполненную, а «поля нет» и «поле пустое» — разные просьбы, и
 * полагаться здесь на умолчание значило бы держать это правило в двух местах.
 */
export function applicabilityBody(values: string[] | undefined): AutoPartApplicabilityInput[] {
  return (values ?? []).map((value) => {
    const id = value.slice(2);
    return value.startsWith('m:')
      ? { vehicleModelId: id, vehicleTypeId: null }
      : { vehicleModelId: null, vehicleTypeId: id };
  });
}

/**
 * Перечень для выбора: сперва типы, потом модели.
 *
 * Порядок не алфавитный намеренно. Типов десятки, моделей сотни, и утверждение о типе («всем
 * самосвалам») покрывает больше машин, чем утверждение о модели, — половина расходуемого (масло,
 * антифриз, фильтры общего применения) размечается именно так (Р8). Наверху списка стоит то, чем
 * размечают чаще.
 *
 * Погашенные не показываются: размечать новую деталь моделью, на которую машин больше не заводят,
 * незачем. Уже сохранённые ссылки поле добавляет к списку само (`withSavedOption`), иначе правка
 * комментария снимала бы разметку молча.
 */
export function useApplicabilityOptions(enabled = true): {
  options: ApplicabilityOption[];
  loading: boolean;
} {
  const types = useQuery({
    queryKey: autoPartRefKeys.vehicleTypes(),
    queryFn: () =>
      vehicleTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        // Алфавит просится явно: умолчание списочной схемы — «последний заведённый сверху», и
        // перечень пришёл бы задом наперёд.
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled,
  });
  const models = useQuery({
    queryKey: autoPartRefKeys.vehicleModels(),
    queryFn: () =>
      vehicleModelsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled,
  });

  const activeTypes = (types.data?.items ?? []).filter((t) => t.isActive);
  // Тип модели называется рядом с ней: имя модели уникально в пределах типа (`vehicle_models_type_name_unique`),
  // и в общем перечне две строки «3309» — от разных типов — были бы неразличимы.
  const typeNames = new Map((types.data?.items ?? []).map((t) => [t.id, t.name]));

  return {
    options: [
      ...activeTypes.map((t) => ({ value: typeValue(t.id), label: `Тип · ${t.name}` })),
      ...(models.data?.items ?? []).map((m) => ({
        value: modelValue(m.id),
        label: `Модель · ${m.name}${typeNames.has(m.vehicleTypeId) ? ` (${typeNames.get(m.vehicleTypeId)})` : ''}`,
      })),
    ],
    loading: types.isFetching || models.isFetching,
  };
}
