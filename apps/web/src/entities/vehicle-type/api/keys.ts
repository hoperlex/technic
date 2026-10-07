import { createQueryKeys, type Query } from '@shared/api';

/**
 * Type reads share one response: the classifier needs complete records, while the vehicle filter
 * sorts its own labels. Type edits invalidate this root and the trailer check with it.
 */
export const vehicleTypeKeys = createQueryKeys('vehicle-types', {
  full: () => ['full'],
});

/**
 * Виды ТС. Семейств нет, и ключ — сам корень `['vehicle-kinds']`: портал спрашивает вид одним
 * запросом из одного места, без параметров, а писать вид сервер не даёт вовсе. Заведённое ради
 * симметрии семейство `list` сдвинуло бы единственную ячейку кэша, ничего при этом не разделив.
 */
export const vehicleKindKeys = createQueryKeys('vehicle-kinds', {});

/**
 * ТТХ (ADR 0016).
 *
 * `list` без сегмента с именем семейства — ключ так и остаётся `['vehicle-specs', отбор]`. Это не
 * забытая разметка: сегмент сменил бы ячейку кэша вкладке справочника, ничего не починив, — корень
 * и сейчас накрывает список вместе с `active`.
 *
 * Отбор объектом целиком, а не полями врозь: новый фильтр вкладки попадает в ключ сам, а
 * перечисленный руками список однажды забыли бы дополнить — и вкладка показала бы прежние строки
 * под новым фильтром.
 */
export const vehicleSpecKeys = createQueryKeys('vehicle-specs', {
  list: (params: Query) => [params],
  /** Активные ТТХ для привязки к типу — отдельный вопрос, а не страница списка. */
  active: () => ['active'],
});

/**
 * Категории типа (ADR 0016): идентичность категории — набор значений ТТХ её типа, и спрашивают их
 * всегда у конкретного типа.
 *
 * Тип в ключе без сегмента с именем семейства — `['vehicle-categories', typeId]`, как собирает
 * карточка. Сегмент сменил бы её ячейку кэша, а разделять здесь нечего: других запросов к
 * категориям у портала нет.
 */
export const vehicleCategoryKeys = createQueryKeys('vehicle-categories', {
  byType: (typeId: string) => [typeId],
});

/**
 * Классификатор (ADR 0028). Данных у него своих нет — он сводит типы с категориями, — поэтому
 * гасят его правки обоих справочников, и делают это сегодня корнем целиком.
 *
 * Два семейства разведены не по прихоти: `list` — страница вкладки справочника со своим отбором,
 * `forSelect` — все активные позиции разом для полей выбора. Под общим ключом страница вкладки
 * подменяла бы списки выбора своим отбором.
 */
export const vehicleClassificationKeys = createQueryKeys('vehicle-classifications', {
  list: (params: Query) => [params],
  forSelect: () => ['for-select'],
});

/**
 * Привязанные к типу ТТХ (`GET /vehicle-types/{id}/specs`) — под СВОИМ корнем, а не семейством
 * внутри `['vehicle-types']`.
 *
 * Это сегодняшний факт, а не решение: так его собрала карточка типа, и `['vehicle-types']` до него
 * не достаёт — префиксное сравнение сличает сегменты целиком, а `vehicle-type-specs` это не
 * `vehicle-types`. Отсюда и лишняя строка в карточке, гасящая набор отдельно. Увести ключ под
 * корень типов стоило бы того, но это смена ячейки кэша, а не перенос: правка отдельная и видимая.
 */
export const vehicleTypeSpecKeys = createQueryKeys('vehicle-type-specs', {
  byType: (typeId: string) => [typeId],
});
