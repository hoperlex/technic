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
     * Признак линейности **этой ручкой не правится**: у переключения свой протокол —
     * предпросмотр, отпечаток подтверждения и ответ с номерами замороженных заявок
     * (`POST /vehicle-types/:id/linear`). Полем общей правки подтверждение обходилось бы молча:
     * старым клиентом, скриптом, вкладкой, открытой со вчера.
     *
     * Поле оставлено в схеме намеренно, хотя обработчик отвечает на него `422`. Убери его — и
     * `strict()` отдал бы `400 validation_error` «Ошибка валидации данных», которое старый клиент
     * прочитает как поломку портала, а не как инструкцию, куда идти.
     *
     * Отказ временный: он живёт ровно столько, сколько существует своя ручка. Когда запрет
     * переключения под работающими заказами вернётся, `/linear` снимется, а обработка `isLinear`
     * вернётся сюда — иначе не осталось бы ни одного пути переключить признак даже у типа без
     * единой заявки.
     */
    isLinear: z.boolean().optional(),
  })
  .strict();
export type UpdateVehicleTypeInput = z.infer<typeof updateVehicleTypeSchema>;

// ── Переключение признака линейности: своя ручка, свой протокол подтверждения ──

/**
 * Тело `POST /vehicle-types/:id/linear`.
 *
 * `fingerprint` — отпечаток множества заявок, показанного предпросмотром. Необязателен **в
 * схеме** и спрашивается обработчиком: решение «нужно ли подтверждение» принимается по данным под
 * блокировкой, а не по телу запроса. Обязательное поле схемы отдавало бы `400` там, где ответом
 * должно быть `422` с числом заявок, — а у типа без работающих заказов подтверждать нечего вовсе.
 */
export const switchVehicleTypeLinearSchema = z
  .object({
    isLinear: z.boolean(),
    fingerprint: z.string().min(1).optional(),
  })
  .strict();
export type SwitchVehicleTypeLinearInput = z.infer<typeof switchVehicleTypeLinearSchema>;

/** Заявка в перечне предпросмотра: столько, сколько нужно, чтобы узнать свой заказ. */
export interface VehicleTypeLinearSwitchRequestDto {
  num: number;
  objectName: string;
  dateFrom: string;
  dateTo: string | null;
}

/**
 * Что случится, если признак переключить: `GET /vehicle-types/:id/linear-switch-preview`.
 *
 * Счётчики и перечень разведены не для красоты. Отпечаток и `count` считаются по **полному**
 * множеству — включая архивные заявки и невидимые этому человеку по области, — иначе
 * подтверждение защищало бы не то, что записывается. А перечень номеров показывает только то, что
 * человек и так видит в списке заявок: переключают признак менеджер и диспетчер, тогда как архив
 * в портале — администраторская область, и предпросмотр не место для её раскрытия.
 */
export interface VehicleTypeLinearSwitchPreviewDto {
  /** Значение, к которому готовятся: `true` — заказы пойдут днями, `false` — неделями. */
  next: boolean;
  /** Сколько заявок останется на прежнем режиме — по полному множеству. */
  count: number;
  /** Сколько из них лежит в архиве: число, а не строки. */
  archivedCount: number;
  requests: VehicleTypeLinearSwitchRequestDto[];
  fingerprint: string;
}

/** Ответ переключения. */
export interface VehicleTypeLinearSwitchResultDto {
  type: VehicleTypeDto;
  /** Сколько заявок заморозила **эта** операция. Повтор уже сделанного переключения даёт 0. */
  frozenNow: number;
  /** Их номера — ими говорит интерфейс и пишется журнал. */
  frozenNums: number[];
  /**
   * Сколько снимков у типа осталось всего, включая поставленные прежними переключениями. С
   * `frozenNow` путать нельзя: при втором переключении первое число считает только новых, это —
   * всех, кто ещё дорабатывает по записанному режиму.
   */
  frozenTotal: number;
}

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
  /**
   * Сколько заявок этого типа дорабатывает по прежнему режиму — их застигло переключение
   * признака (миграция 0137). Ноль у всех типов, которых не переключали под работающими заказами.
   *
   * Показывается в справочнике и отвечает на вопрос «можно ли убирать костыль»: колонки снимка
   * удаляются, когда это число обнулится по всем типам, и спрашивать об этом базу человек не
   * должен. Поле временное и уходит вместе с ними.
   */
  frozenRequests: number;
  /** Сколько ТТХ привязано к типу (ADR 0016): 0 — у типа нет и не может быть категорий. */
  specCount: number;
  /** Сколько категорий (комбинаций значений ТТХ) заведено у типа. */
  categoryCount: number;
  createdAt: string;
  updatedAt: string;
}
