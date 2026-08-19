import { and, eq, inArray, or, type AnyColumn, type SQL } from 'drizzle-orm';
import { isClassificationFilterEmpty, type ClassificationFilter } from '@technic/contracts';

// ── Отбор по позициям классификатора: набор и прежняя пара ──
//
// Фильтр «Тип ТС» стоит в пяти выдачах — список заказов, лента раздела, журнал, «На объекте» и
// перечень гаража, — и спрашивают его двумя формами сразу: свежий портал шлёт набор
// `classifications`, открытая со вчера вкладка — старую пару `vehicleTypeId` / `vehicleCategoryId`.
// Формы разные не по написанию, а по смыслу: набор объединяет позиции по ИЛИ, пара сужала по И.
// Поэтому веток две и одной им не стать — сведи их, и одна из двух получила бы чужой ответ.
//
// Вся совместимость собрана здесь намеренно: снятие старой пары (когда-нибудь и только под
// принудительным гейтом версии сборки) — это удалить из модуля одну функцию и поправить по строке
// в пяти местах, а не вспоминать, как условие было написано в каждом маршруте.

/**
 * Набор позиций (ADR 0028): `typeIds` — типы целиком со всеми категориями, `categoryIds` — одна
 * категория. Ветки объединяются по **ИЛИ**, потому что вопрос человека такой и есть: «покажи
 * автокраны и самосвалы» — один список, а не пересечение, которое всегда пусто.
 *
 * Пустая ветка условием не становится: одиночный выбор даёт голый `IN (...)` по тому же индексу,
 * по которому раньше ходило `=`, — лишняя обёртка `or` ничего не сообщала бы ни читателю, ни
 * планировщику.
 *
 * «Весь тип» вместе с его же категорией не сворачивается (Р6): по ИЛИ тип категорию поглощает сам,
 * а вычищать присланный набор значило бы отвечать не на то, о чём спросили.
 */
export function classificationWhere(
  typeCol: AnyColumn,
  categoryCol: AnyColumn,
  filter: ClassificationFilter | undefined,
): SQL | undefined {
  if (filter === undefined || isClassificationFilterEmpty(filter)) return undefined;
  return or(
    filter.typeIds.length > 0 ? inArray(typeCol, filter.typeIds) : undefined,
    filter.categoryIds.length > 0 ? inArray(categoryCol, filter.categoryIds) : undefined,
  );
}

/**
 * Прежняя форма — одна позиция парой полей, и условие у неё **«И»**, буква в букву как было:
 * только тип → `type = t`, только категория → `category = c`, оба поля → оба условия сразу.
 *
 * Приводить пару к набору запрещено. Несовпадающее сочетание «тип A + категория B» в базе не
 * встречается вовсе (составные ключи `vehicle_requests_category_type_fk` и
 * `vehicles_category_type_fk`), и сегодня такой запрос отвечает пустым списком. Переписанный через
 * ИЛИ, он вернул бы весь тип A плюс всю категорию B: старая вкладка получила бы новый ответ на
 * прежний вопрос — ровно то, чего расширение сервера обещает не делать.
 */
export function legacyClassificationWhere(
  typeCol: AnyColumn,
  categoryCol: AnyColumn,
  q: { vehicleTypeId?: string | undefined; vehicleCategoryId?: string | undefined },
): SQL | undefined {
  return and(
    q.vehicleTypeId ? eq(typeCol, q.vehicleTypeId) : undefined,
    q.vehicleCategoryId ? eq(categoryCol, q.vehicleCategoryId) : undefined,
  );
}

/** Что из списочного запроса нужно отбору; остальные его поля здесь безразличны. */
interface ClassificationQuery {
  classifications?: ClassificationFilter | undefined;
  vehicleTypeId?: string | undefined;
  vehicleCategoryId?: string | undefined;
}

/**
 * Вход маршрутов: набор задан — отбираем по нему, иначе по прежней паре. Приоритет здесь не
 * выбирается и выбираться не должен — обе формы сразу схема отвергает 400-м
 * (`withSingleClassificationForm`), и такой запрос до SQL не доезжает.
 */
export function queryClassificationWhere(
  typeCol: AnyColumn,
  categoryCol: AnyColumn,
  q: ClassificationQuery,
): SQL | undefined {
  return isClassificationFilterEmpty(q.classifications)
    ? legacyClassificationWhere(typeCol, categoryCol, q)
    : classificationWhere(typeCol, categoryCol, q.classifications);
}
