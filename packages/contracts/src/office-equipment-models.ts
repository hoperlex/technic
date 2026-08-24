import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import type { OfficeEquipmentTypeRefDto } from './office-equipment';

// ── Модели аппаратов (план `docs/office-equipment-consumables-plan.md`, Р1; выпуск A) ──
//
// Модель — это то, к чему подходит картридж: «Тонер Ricoh 201» годится всем карточкам Ricoh Aficio
// MP 201SPF и любой следующей, которую заведут завтра. Пока модель была текстом в карточке техники,
// на вопрос «чем заправить этот аппарат» отвечал бы поиск по подстроке — и промахивался на каждом
// разнописании.
//
// Справочник существует независимо от парка: картридж лежит на складе и для аппарата, которого в
// портале нет вовсе, — требовать «сначала заведите технику» значило бы отказаться внести то, что
// уже есть. Ведётся окном из вкладки «Оргтехника», как перечень типов (Р8), правами самого
// справочника техники (Р10).

// Сортировки по счётчику карточек здесь намеренно нет: он считается подзапросом и в области
// смотрящего (Р12), то есть порядок строк зависел бы от того, кто смотрит, — двое за одним столом
// увидели бы разные списки и разошлись бы в том, «какая модель первая».
export const OFFICE_EQUIPMENT_MODEL_SORT_FIELDS = [
  'name',
  'manufacturer',
  'type',
  'isActive',
  'createdAt',
] as const;

/**
 * Наименование модели. Схема снимает только края: свернуть внутренние пробелы обязан маршрут —
 * функцией базы `office_equipment_model_name_normalize`, той же, что стоит в уникальном индексе и
 * в CHECK `office_equipment_models_name_normalized_check` (миграция 0171). Своя нормализация на
 * TypeScript была бы второй копией правила, а разойдясь с первой, завела бы в справочник
 * «Ricoh␣␣IM 350» — ровно то разнописание, ради которого правило и заведено.
 */
const modelNameSchema = z.string().trim().min(2, 'Укажите наименование модели').max(255);
const manufacturerSchema = z.string().trim().max(255);
const commentSchema = z.string().trim().max(2000);

/**
 * Срез «модели без расходника» (Р15). Портал обязан показывать дыру сам: присланный список
 * закрывает 15 моделей из 39 — 264 карточки из 353, — а по остальным 24 (89 аппаратов) картридж не
 * назван вовсе, и узнать это иначе можно только глазами по всему перечню.
 *
 * Перечнем, а не булевым флагом, — по той же причине, что `stock` у расходников и `warranty` у
 * техники: `false` у флага неотличим от «параметра нет вовсе», и снятый переключатель начал бы
 * означать «покажи покрытые» вместо «не фильтруй».
 *
 * Значение одно, и обратного («покрытые») здесь нет намеренно. Вопрос Р15 задаётся в одну сторону —
 * работа идёт по дыре, а «покрытые» это ровно «весь перечень минус срез», и решений по такому
 * списку никто не принимает. Перечень оставляет дверь открытой: понадобится обратный вопрос —
 * добавится второе значение, и ни адрес, ни имя параметра от этого не меняются.
 *
 * Погашенный расходник считается заведённым: «больше не покупаем» модель непокрытой не делает — это
 * другой разговор и другой срез (в окне расходников).
 */
export const OFFICE_EQUIPMENT_MODEL_COVERAGE_FILTERS = ['uncovered'] as const;
export type OfficeEquipmentModelCoverageFilter =
  (typeof OFFICE_EQUIPMENT_MODEL_COVERAGE_FILTERS)[number];

// Поиск — по наименованию и производителю (Р9): спрашивают и «Ricoh», и «IM 350», и обе половины
// названия обязаны находить одну и ту же строку.
export const officeEquipmentModelListQuerySchema = baseListQuery(
  OFFICE_EQUIPMENT_MODEL_SORT_FIELDS,
).extend({
  /** «Модели МФУ» — тип задаёт вопрос целиком: одноимённые принтер и МФУ это разные модели (Р1). */
  equipmentTypeId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** «Чем это заправлять — неизвестно»: модели, к которым не привязан ни один расходник (Р15). */
  coverage: z.enum(OFFICE_EQUIPMENT_MODEL_COVERAGE_FILTERS).optional(),
});

export const createOfficeEquipmentModelSchema = z.object({
  equipmentTypeId: uuidSchema,
  name: modelNameSchema,
  manufacturer: manufacturerSchema.optional().default(''),
  /** Гашение вместо удаления (Р11): погашенную модель не предлагают, но у ссылающихся она есть. */
  isActive: z.boolean().optional().default(true),
  comment: commentSchema.optional().default(''),
});
export type CreateOfficeEquipmentModelInput = z.infer<typeof createOfficeEquipmentModelSchema>;

/**
 * Тип модели правкой не меняется — тот же приём, что у категорий техники: пару «модель + тип»
 * держит составной ключ в режиме «замок» (Р1), и смена типа у модели, на которую уже ссылаются
 * карточки, была бы отказом целостности вместо слов сервера. Не тот тип — заводят модель заново.
 *
 * Схема тип **принимает**, хотя менять его нельзя, — и это не противоречие. `z.never()` отбивал бы
 * его раньше маршрута, но словами zod: «Invalid input: expected never, received string». Человек,
 * приславший тип, заслуживает ответа о предмете — «тип модели не меняется, заведите модель нужного
 * типа», — а сказать это может только маршрут, до которого запрос обязан дойти (422).
 *
 * `.partial()` снимает обязательность, но не `.default()` — поля со значением по умолчанию
 * объявляются заново, иначе PATCH без поля затирал бы значение (тот же подвох, что у типов).
 */
export const updateOfficeEquipmentModelSchema = createOfficeEquipmentModelSchema.partial().extend({
  equipmentTypeId: uuidSchema.optional(),
  manufacturer: manufacturerSchema.optional(),
  isActive: z.boolean().optional(),
  comment: commentSchema.optional(),
});
export type UpdateOfficeEquipmentModelInput = z.infer<typeof updateOfficeEquipmentModelSchema>;

export interface OfficeEquipmentModelDto {
  id: string;
  type: OfficeEquipmentTypeRefDto;
  name: string;
  manufacturer: string;
  isActive: boolean;
  comment: string;
  /**
   * Ссылается ли на модель хоть что-нибудь: карточка техники — **любая**, живая, архивная или
   * неактивная, — либо расходник. Это ответ на «удаляема ли модель» (Р11): архивная карточка
   * возвращается `restore` и обязана вернуться к своей модели, поэтому архив здесь считается
   * наравне с парком.
   *
   * Признак булев, и это не экономия: числом он раскрыл бы масштаб парка тому, кому видна лишь
   * своя площадка (Р12), а на вопрос об удалении «сколько» не отвечает — отвечает «хоть одна».
   * Области у признака поэтому нет и быть не должно: удаление запрещает чужая карточка так же,
   * как своя.
   */
  isUsed: boolean;
  /**
   * Сколько карточек модели видит смотрящий: живые и активные, **в его области** — тем же
   * предикатом `officeEquipmentScopeWhere`, что и список техники (Р12), а не похожим на него.
   * Право `officeEquipment.read` сквозной видимости не даёт, и роль одной площадки, увидев
   * сквозное число, узнала бы размер чужого парка.
   *
   * Считает маршрут — в контракте это просто число. Ноль здесь означает «у вас таких нет», а не
   * «модель свободна»: на вопрос об удалении отвечает `isUsed`, и подменять одно другим нельзя.
   */
  equipmentCount: number;
  createdAt: string;
  updatedAt: string;
}
