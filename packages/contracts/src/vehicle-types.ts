import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import {
  DEFAULT_TYPE_WAYBILL_FORM,
  typeWaybillFormCodeSchema,
  type WaybillFormCode,
} from './waybills';

export const VEHICLE_TYPE_SORT_FIELDS = [
  'code',
  'kindName',
  'name',
  'sortOrder',
  'isActive',
] as const;

/** Системный код: строчные латинские, цифры и `_`; первый символ — буква. Неизменяем после создания. */
export const vehicleTypeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'Код: только строчные латинские, цифры и _, первый символ — буква');

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/**
 * Подпись и пояснение признака «линейная техника» (ADR 0100, миграция 0127).
 *
 * В контрактах, а не только в форме справочника, как подпись «легкового транспорта»: тот же вопрос
 * задаёт колонка обмена справочников файлом, а её подсказку собирает сервер. Формулировка одна на
 * оба входа — человек, ставящий галочку в портале, и человек, заполняющий xlsx, включают одно и то
 * же и должны прочитать об этом одно и то же.
 *
 * Пояснение называет область (заказ на объект), а не вид техники: признак доступен типам любого
 * вида (ADR 0100 §1) — самосвал под вывоз грунта неделями стоит на площадке, а точно такой же
 * самосвал в другом парке вечером уезжает в гараж.
 */
export const LINEAR_VEHICLE_TYPE_LABEL = 'Линейная техника';
export const LINEAR_VEHICLE_TYPE_HINT =
  'Заказы такой техники на объект ведутся по дням: 4-П на каждый день, ЭСМ-2 — по требованию';

export const vehicleTypeListQuerySchema = baseListQuery(VEHICLE_TYPE_SORT_FIELDS).extend({
  kindId: uuidSchema.optional(),
  isActive: boolFromQuery,
});

// ── Создание (плоская модель, ADR 0005) ──
// Клиент шлёт kindId и описательные поля; структурные ключи (code/kindId) неизменяемы после создания.
export const createVehicleTypeSchema = z
  .object({
    kindId: uuidSchema,
    code: vehicleTypeCodeSchema,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).optional().default(''),
    sortOrder: z.coerce.number().int().optional().default(100),
    isActive: z.boolean().optional().default(true),
    /**
     * Каким бланком выписывается лист на машины типа (ADR 0065). Не передан — 4-П: у собственной
     * техники лист есть всегда, а форма № 3 включается признаком «легковой транспорт» в форме
     * справочника. Пустого значения у поля нет — оно молча отключало документ у каждого типа,
     * заведённого через портал.
     */
    waybillFormCode: typeWaybillFormCodeSchema.optional().default(DEFAULT_TYPE_WAYBILL_FORM),
    /**
     * Линейная ли это техника (ADR 0100). Не передан — нет: признак меняет документооборот заказа
     * (дни вместо недель, ЭСМ-2 по требованию), и включаться молча он не вправе — умолчание
     * повторяет `false` колонки, чтобы тип, заведённый старым клиентом, вёл себя как прежде.
     */
    isLinear: z.boolean().optional().default(false),
  })
  .strict();
export type CreateVehicleTypeInput = z.infer<typeof createVehicleTypeSchema>;

// ── Обновление: описательные поля, активность и бланк. code/kindId менять нельзя (strict отклоняет). ──
export const updateVehicleTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
    /**
     * Бланк правится наравне с описательными полями — иначе тип, заведённый не тем бланком,
     * чинился бы только миграцией, а это и есть тот софтлок, ради которого поле открыли.
     */
    waybillFormCode: typeWaybillFormCodeSchema.optional(),
    /**
     * Признак линейности правится, но не всегда: сервер отвечает 422, пока у типа есть заявки в
     * работе (ADR 0100 §1). Причина — признак читается живым, снимка в заявке нет: переключение под
     * работающим заказом мгновенно сменило бы ему режим документооборота. Схема этого не знает и
     * знать не может — вопрос к базе, а не к телу запроса.
     */
    isLinear: z.boolean().optional(),
  })
  .strict();
export type UpdateVehicleTypeInput = z.infer<typeof updateVehicleTypeSchema>;

/** Плоский тип ТС (ADR 0005): один уровень, ссылается на вид (kind). */
export interface VehicleTypeDto {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  /**
   * Каким бланком выписывается лист на машины этого типа (ADR 0065). Пустым не бывает: «лист не
   * выписывается» — это про принадлежность машины, а не про её тип. В форме справочника поле
   * стоит признаком «легковой транспорт» (`isPassengerTypeForm`).
   */
  waybillFormCode: WaybillFormCode;
  /**
   * Линейная техника (ADR 0100): вечером возвращается на базу и за день работает на нескольких
   * объектах. Заказ такого типа на объект ведётся по дням — 4-П на каждый день, ЭСМ-2 только по
   * требованию. Признак стоит у типа, а не у машины: как вести заявку, решает заказ, а не то,
   * какую единицу под него потом нашли (ADR 0100 §1).
   */
  isLinear: boolean;
  /** Сколько ТТХ привязано к типу (ADR 0016): 0 — у типа нет и не может быть категорий. */
  specCount: number;
  /** Сколько категорий (комбинаций значений ТТХ) заведено у типа. */
  categoryCount: number;
  createdAt: string;
  updatedAt: string;
}
