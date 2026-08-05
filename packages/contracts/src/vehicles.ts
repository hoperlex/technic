import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import type { WaybillFormCode } from './waybills';

// ── Справочник «Техника»: конкретные ТС (ADR 0007) ──
// Тип обязателен, марка/модель опциональна (в источнике есть машины без марки). Согласованность
// «тип ТС = тип модели» гарантирует составной FK в БД. Госномер нормализуется и уникален среди живых.

export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired'] as const;
export const vehicleStatusSchema = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const vehicleStatusLabels: Record<VehicleStatus, string> = {
  active: 'Активна',
  inactive: 'Неактивна',
  maintenance: 'Обслуживание',
  retired: 'Списана',
};
export const vehicleStatusColors: Record<VehicleStatus, string> = {
  active: 'green',
  inactive: 'default',
  maintenance: 'gold',
  retired: 'red',
};

// ── Принадлежность: собственная техника и аренда (ADR 0018) ──
// Ветки не пересекаются ни одним содержательным реквизитом: у своей машины — марка/модель,
// госномер и ПТС, у аренды — арендодатель, цены и короткий срез-идентификатор.

export const VEHICLE_OWNERSHIPS = ['own', 'rental'] as const;
export const vehicleOwnershipSchema = z.enum(VEHICLE_OWNERSHIPS);
export type VehicleOwnership = (typeof VEHICLE_OWNERSHIPS)[number];

export const vehicleOwnershipLabels: Record<VehicleOwnership, string> = {
  own: 'Собственная',
  rental: 'Аренда',
};
export const vehicleOwnershipColors: Record<VehicleOwnership, string> = {
  own: 'blue',
  rental: 'purple',
};

/** У предложения аренды нет состояний машины: «Обслуживание» и «Списана» к нему не применимы. */
export const RENTAL_STATUSES = ['active', 'inactive'] as const satisfies readonly VehicleStatus[];

export function isRentalStatus(s: VehicleStatus): boolean {
  return (RENTAL_STATUSES as readonly VehicleStatus[]).includes(s);
}

/** Цена в рублях: две цифры после запятой (numeric(12,2) в БД), строго положительная. */
export const vehiclePriceSchema = z.coerce.number().positive().max(9_999_999_99).multipleOf(0.01);

/**
 * Часов в смене: столько же, сколько в сутках, и не меньше часа. Схема общая со ставками
 * назначенной техники (ADR 0027) — «смена» в справочнике и в заявке значит одно и то же.
 */
export const shiftHoursSchema = z.coerce.number().int().min(1).max(24);

// Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки.
export const VEHICLE_SORT_FIELDS = [
  'ownership',
  'registrationNumber',
  'typeName',
  'categoryName',
  'modelName',
  'lessorName',
  'description',
  'pricePerHour',
  'pricePerShift',
  'status',
  'createdAt',
] as const;

export const vehicleListQuerySchema = baseListQuery(VEHICLE_SORT_FIELDS).extend({
  ownership: vehicleOwnershipSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  /**
   * Вся техника вида, а не одного типа. Границей замены вид быть перестал (ADR 0064), но окно
   * назначения спрашивает им заказанный вид отдельным запросом: страница списка ограничена 500
   * строками, и парк, в неё не поместившийся, обрезал бы как раз то, что заказывали.
   */
  vehicleKindId: uuidSchema.optional(),
  vehicleCategoryId: uuidSchema.optional(),
  lessorId: uuidSchema.optional(),
  status: vehicleStatusSchema.optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** Общее у веток: классификация, статус, комментарий. Тип обязателен всегда, категория — нет. */
const vehicleCommonFields = {
  vehicleTypeId: uuidSchema,
  vehicleCategoryId: uuidSchema.nullish(),
  status: vehicleStatusSchema.optional().default('active'),
  note: z.string().trim().max(2000).optional().default(''),
};

const createOwnVehicleSchema = z
  .object({
    ownership: z.literal('own'),
    ...vehicleCommonFields,
    vehicleModelId: uuidSchema.nullish(),
    registrationNumber: z.string().trim().max(50).nullish(),
    passportNumber: z.string().trim().max(100).nullish(),
  })
  .strict();

const createRentalVehicleSchema = z
  .object({
    ownership: z.literal('rental'),
    ...vehicleCommonFields,
    status: z.enum(RENTAL_STATUSES).optional().default('active'),
    lessorId: uuidSchema,
    /** Короткий срез вида «Автокран 70 тн»; входит в ключ уникальности предложения. */
    description: z.string().trim().max(120).optional().default(''),
    pricePerHour: vehiclePriceSchema.nullish(),
    pricePerShift: vehiclePriceSchema.nullish(),
    shiftHours: shiftHoursSchema.nullish(),
  })
  .strict()
  .refine((v) => v.pricePerHour != null || v.pricePerShift != null, {
    message: 'Укажите хотя бы одну цену — за час или за смену',
    path: ['pricePerHour'],
  });

// Строгие ветки союза физически отсекают «госномер у аренды» и «цену у своей машины» ещё
// на валидации: чужое поле не пройдёт `.strict()`.
export const createVehicleSchema = z.discriminatedUnion('ownership', [
  createOwnVehicleSchema,
  createRentalVehicleSchema,
]);
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type CreateOwnVehicleInput = z.infer<typeof createOwnVehicleSchema>;
export type CreateRentalVehicleInput = z.infer<typeof createRentalVehicleSchema>;

// `ownership` в PATCH не принимается: смена принадлежности — другая сущность, а не правка.
// `.partial()` не снимает `.default()`, поэтому поля с дефолтом переобъявлены без него — иначе
// PATCH со сменой одного статуса затирал бы note пустой строкой.
const updateOwnVehicleSchema = z
  .object({
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    vehicleModelId: uuidSchema.nullish(),
    registrationNumber: z.string().trim().max(50).nullish(),
    passportNumber: z.string().trim().max(100).nullish(),
    status: vehicleStatusSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const updateRentalVehicleSchema = z
  .object({
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    lessorId: uuidSchema.optional(),
    description: z.string().trim().max(120).optional(),
    pricePerHour: vehiclePriceSchema.nullish(),
    pricePerShift: vehiclePriceSchema.nullish(),
    shiftHours: shiftHoursSchema.nullish(),
    status: z.enum(RENTAL_STATUSES).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Ветку PATCH определяет не тело, а сама запись: клиент не должен сообщать принадлежность,
 * чтобы не было соблазна её «поправить». Маршрут выбирает схему по существующей строке.
 */
export const updateVehicleSchema = z.union([updateOwnVehicleSchema, updateRentalVehicleSchema]);
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export const updateVehicleSchemaByOwnership: Record<
  VehicleOwnership,
  typeof updateOwnVehicleSchema | typeof updateRentalVehicleSchema
> = {
  own: updateOwnVehicleSchema,
  rental: updateRentalVehicleSchema,
};
export type UpdateOwnVehicleInput = z.infer<typeof updateOwnVehicleSchema>;
export type UpdateRentalVehicleInput = z.infer<typeof updateRentalVehicleSchema>;

// Поля чужой ветки приходят как null, а не отсутствуют: справочник — один список с одним набором
// колонок, и клиенту не нужно ветвиться при отрисовке строки.
export interface VehicleDto {
  id: string;
  ownership: VehicleOwnership;
  /**
   * Вид ТС типа этой машины. Приезжает строкой справочника, потому что заявку закрывают машиной
   * любого вида (ADR 0064): вид перестал сужать список и стал последним ключом его порядка, а
   * считать порядок форме нечем, если вида в строке нет.
   */
  vehicleKindId: string;
  kindName: string;
  vehicleTypeId: string;
  typeName: string;
  /**
   * Бланк, закреплённый за типом машины (ADR 0037). Приезжает строкой справочника, потому что
   * заявку закрывают и машиной другого типа (ADR 0059): бланк рейса задаёт та единица, которая
   * поедет, а не тип, который заказали, — и форма назначения обязана назвать смену бланка сразу.
   * Пустым не бывает (ADR 0065).
   */
  waybillFormCode: WaybillFormCode;
  vehicleCategoryId: string | null;
  categoryName: string | null;
  /**
   * Значения ТТХ категории машины (ADR 0016): `{ lift_capacity: 10 }`. Ими считается «крупнее или
   * меньше заказанного» (`compareVehicleSize`); `null` — категории нет либо у типа нет ТТХ.
   */
  categorySpecs: VehicleSpecValues | null;
  vehicleModelId: string | null;
  modelName: string | null;
  registrationNumber: string | null;
  passportNumber: string | null;
  lessorId: string | null;
  lessorName: string | null;
  /**
   * Активен ли арендодатель. У неактивного не может быть активных предложений (ADR 0018 §15):
   * интерфейс по этому полю блокирует включение и объясняет причину, не дожидаясь отказа сервера.
   */
  lessorIsActive: boolean | null;
  /**
   * Выключено каскадом от арендодателя, а не отдельным решением. Такие позиции вернутся сами,
   * когда арендодателя активируют; выключенные вручную — нет (ADR 0018 §14).
   */
  deactivatedWithLessor: boolean;
  description: string;
  pricePerHour: number | null;
  pricePerShift: number | null;
  shiftHours: number | null;
  status: VehicleStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Почему предложение аренды нельзя включить, или null — если можно. Текст один и тот же в
 * подсказке у переключателя и в отказе сервера, чтобы человек не гадал, что именно не так.
 */
export function rentalActivationBlockReason(v: {
  ownership: VehicleOwnership;
  lessorIsActive: boolean | null;
  lessorName: string | null;
  deactivatedWithLessor?: boolean;
}): string | null {
  if (v.ownership !== 'rental' || v.lessorIsActive !== false) return null;
  const who = `Арендодатель${v.lessorName ? ` «${v.lessorName}»` : ''} неактивен`;
  // Выключенным вместе с арендодателем возвращаться не нужно вручную — они поднимутся сами.
  return v.deactivatedWithLessor
    ? `${who} — техника включится обратно вместе с ним`
    : `${who} — активируйте его в справочнике контрагентов`;
}

/**
 * Как машина называется в списках и подтверждениях. Ветки различаются тем, чем их различает
 * человек: аренду — коротким срезом предложения, свою машину — госномером. Реквизиты, которых
 * может не быть, перебираются до типа ТС: он есть всегда.
 */
export function vehicleLabel(v: {
  ownership: VehicleOwnership;
  description: string;
  categoryName: string | null;
  typeName: string;
  registrationNumber: string | null;
  modelName: string | null;
}): string {
  if (v.ownership === 'rental') {
    return v.description || v.categoryName || v.typeName;
  }
  return v.registrationNumber || v.modelName || v.categoryName || v.typeName;
}

/** Как строка справочника техники называется в списках и подтверждениях. */
export function vehicleTitle(v: VehicleDto): string {
  return vehicleLabel(v);
}

// ── Замена заказанной техники: вид, тип, категория и «крупнее или меньше» (ADR 0045, 0059, 0063) ──
//
// Заявка заказывает позицию классификатора — тип ТС и, если у типа есть ТТХ, его категорию
// (ADR 0028). Исполняет диспетчер тем, что есть в парке: категория перестала быть фильтром в
// ADR 0045, тип — в ADR 0059, вид — в ADR 0064. Границы у замены больше нет вовсе: заказанная
// позиция задаёт порядок списка, а не его состав.
//
// Причина — качество данных, а не убеждение, что вид неважен (ADR 0064): классификатор заполнен
// неровно, заявку заводит один человек, а парк ведёт другой, и запрет по неверной строке
// справочника прячет машину, которой работу как раз и делают. Портал обязан назвать обе стороны
// расхождения и сказать, в какую сторону разошлось, но ничего не запрещает. Правило живёт здесь,
// а не на сервере: одна формулировка на строку списка, предупреждение и тесты — расходиться нечему.

/** Значения ТТХ категории (ADR 0016): код характеристики → число, `{ lift_capacity: 25 }`. */
export type VehicleSpecValues = Readonly<Record<string, number>>;

/**
 * Как техника соотносится с заказанной по **общим** ТТХ.
 *
 * `same` — общие характеристики равны, `bigger` / `smaller` — все не меньше (не больше) и хотя бы
 * одна строго больше (меньше), `mixed` — часть больше, часть меньше (у манипулятора г/п машины
 * выше, а г/п стрелы ниже). `unknown` — сравнивать не с чем: категория не проставлена (в
 * справочнике она необязательна) либо у типов нет ни одной общей характеристики.
 */
export type VehicleSizeRelation = 'same' | 'bigger' | 'smaller' | 'mixed' | 'unknown';

/**
 * Сравнение по ТТХ, а не по названию типа: «крупнее» — измеримая величина, и выдумывать её порядок
 * порталу нечем. Справочник ТТХ глобальный именно ради такого кросс-типового сравнения (ADR 0016
 * §1): грузоподъёмность у бортового и у малотоннажного — одна и та же характеристика.
 *
 * Где общих характеристик нет (самосвал меряется объёмом кузова, а бортовой — грузоподъёмностью;
 * у тягачей и легковых ТТХ не заведены вовсе), ответ честный — `unknown`: это состояние
 * справочника, а не повод угадать.
 */
export function compareVehicleSize(
  ordered: VehicleSpecValues | null | undefined,
  actual: VehicleSpecValues | null | undefined,
): VehicleSizeRelation {
  if (!ordered || !actual) return 'unknown';
  let bigger = false;
  let smaller = false;
  let common = 0;
  for (const [code, orderedValue] of Object.entries(ordered)) {
    const actualValue = actual[code];
    if (actualValue === undefined) continue;
    common += 1;
    if (actualValue > orderedValue) bigger = true;
    if (actualValue < orderedValue) smaller = true;
  }
  if (common === 0) return 'unknown';
  if (bigger && smaller) return 'mixed';
  if (bigger) return 'bigger';
  if (smaller) return 'smaller';
  return 'same';
}

/** Чем выбранная машина разошлась с заказом. `ok` — не разошлась ничем. */
export interface VehicleSubstitution {
  /**
   * Вид ТС другой: заказывали спецтехнику, а берут грузовик. Самое крупное расхождение, какое
   * бывает, — и с ADR 0064 оно тоже не запрет, а предупреждение: классификатор заполнен неровно,
   * и «другой вид» нередко означает не другую работу, а другую строку справочника.
   */
  kindMismatch: boolean;
  /** Тип машины другой. При `kindMismatch` он другой всегда: типы принадлежат видам. */
  typeMismatch: boolean;
  /** Категория другая. У машины другого типа категории всегда разные — поле про свой тип. */
  categoryMismatch: boolean;
  /**
   * Заказана категория, а у машины её нет. Не расхождение (ADR 0045 §6): «не разнесли» — не то же
   * самое, что «не подходит», но и сравнить в этом случае нечего.
   */
  categoryMissing: boolean;
  relation: VehicleSizeRelation;
}

/** Заказанная позиция и то, чем её закрывают, — обе стороны сравнения. */
export interface VehicleClassificationPosition {
  /** Вид ТС: он больше не граница замены (ADR 0064), но остаётся первым, чем позиции различаются. */
  vehicleKindId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  categorySpecs: VehicleSpecValues | null;
}

export function vehicleSubstitutionOf(
  ordered: VehicleClassificationPosition,
  actual: VehicleClassificationPosition,
): VehicleSubstitution {
  return {
    kindMismatch: ordered.vehicleKindId !== actual.vehicleKindId,
    typeMismatch: ordered.vehicleTypeId !== actual.vehicleTypeId,
    categoryMismatch:
      !!ordered.vehicleCategoryId &&
      !!actual.vehicleCategoryId &&
      ordered.vehicleCategoryId !== actual.vehicleCategoryId,
    categoryMissing: !!ordered.vehicleCategoryId && !actual.vehicleCategoryId,
    relation: compareVehicleSize(ordered.categorySpecs, actual.categorySpecs),
  };
}

/** Разошлась ли машина с заказом хоть чем-нибудь — коротко, для условий показа. */
export function isVehicleSubstitution(s: VehicleSubstitution): boolean {
  return s.kindMismatch || s.typeMismatch || s.categoryMismatch;
}

/**
 * Короткая пометка в строке выбора — техники, рейса, чего угодно, где строку читают глазами.
 * Направление называется здесь же: «другой тип» без «крупнее» заставляет открывать справочник.
 *
 * У чужого вида направления нет и быть не может: «крупнее» считается по общим ТТХ, а у самосвала
 * с автокраном их не бывает. Пометка называет само расхождение — оно и есть главное, что о такой
 * строке нужно знать.
 */
export function vehicleSubstitutionHint(s: VehicleSubstitution): string | null {
  const size = VEHICLE_SIZE_HINTS[s.relation];
  if (s.kindMismatch) return 'другой вид техники';
  if (s.typeMismatch) return size ? `другой тип, ${size}` : 'другой тип';
  if (s.categoryMismatch) return size ?? 'другая категория';
  if (s.categoryMissing) return 'категория не указана';
  return null;
}

const VEHICLE_SIZE_HINTS: Record<VehicleSizeRelation, string | null> = {
  bigger: 'крупнее',
  smaller: 'меньше заказанного',
  mixed: 'ТТХ расходятся',
  same: null,
  unknown: null,
};

/**
 * Развёрнутое предупреждение там, где машину выбирают: пометки в строке мало — её читают при
 * выборе и забывают, а предупреждение под полем видно до самого нажатия «Взять в работу»
 * (ADR 0045 §4). Названы обе стороны: что заказывали и что берут.
 *
 * Уровень отвечает на «есть ли риск»: техника меньше заказанной или расходится по ТТХ — жёлтое
 * предупреждение (груз может не поместиться), крупнее или «сравнить нечем» — нейтральная справка.
 * Подтверждения не требуется ни там, ни там (ADR 0045 §5): назначение именное, а чекбокс
 * превращается в кнопку, которую жмут не читая.
 */
export function vehicleSubstitutionWarning(input: {
  substitution: VehicleSubstitution;
  /** «Автокраны, г/п 130 т» — заказанная позиция целиком (`vehicleClassificationLabel`). */
  orderedLabel: string;
  actualTypeName: string;
  actualCategoryName: string | null;
}): { level: 'info' | 'warning'; text: string } | null {
  const s = input.substitution;
  if (!isVehicleSubstitution(s)) return null;
  // Наименование категории уже содержит тип («Автокраны, г/п 25 т», ADR 0016 §11) — тип рядом с
  // ней не повторяется, тем же правилом, что и у заказанной стороны (`vehicleClassificationLabel`).
  const actualLabel = input.actualCategoryName || input.actualTypeName;
  // Чужой вид — всегда жёлтое: ТТХ у него сравнивать не с чем, а расхождение самое крупное из
  // возможных. Заявку он не отменяет (ADR 0064), но и нейтральной справкой быть не может.
  if (s.kindMismatch) {
    return {
      level: 'warning',
      text:
        `Заказано «${input.orderedLabel}», а выбрана «${actualLabel}» — это техника другого вида. ` +
        'Заявка возьмётся в работу как есть — проверьте, что работу выполнят именно этой машиной.',
    };
  }
  return {
    level: s.relation === 'smaller' || s.relation === 'mixed' ? 'warning' : 'info',
    text: `Заказано «${input.orderedLabel}», а выбрана «${actualLabel}». ${VEHICLE_SIZE_WARNINGS[s.relation]}`,
  };
}

const VEHICLE_SIZE_WARNINGS: Record<VehicleSizeRelation, string> = {
  bigger: 'Техника крупнее заказанной — заявка возьмётся в работу как есть.',
  smaller: 'Техника меньше заказанной — проверьте, что работа выполнима и груз поместится.',
  mixed: 'Характеристики расходятся с заказанными — проверьте, что техника подходит.',
  same: 'Характеристики те же — заявка возьмётся в работу как есть.',
  unknown: 'Сравнить характеристики не с чем — проверьте, что техника подходит.',
};

/**
 * Куда строка попадёт в списке: заказанный тип, крупнее, меньше, «прочее вида» или чужой вид.
 * Группы задают и порядок (`vehicleSubstitutionRank`) — им же упорядочена подсказка рейсов:
 * сначала соответствие, потом близкое к нему, и только в конце далёкое.
 *
 * Свой тип — одна группа независимо от категории: внутри типа расхождение помечается в строке
 * (ADR 0045), и дробить парк на четыре группы там, где привыкли видеть один список, незачем.
 *
 * Чужой вид — последняя группа, и это единственное, что от снятой границы осталось (ADR 0064):
 * список от неё не сужается, но и предлагать автокран под заявку на самосвал раньше самосвалов
 * нельзя. Порядок групп и есть та «релевантность», ради которой границу можно было снять.
 */
export type VehicleSubstitutionGroup = 'ordered' | 'bigger' | 'other' | 'smaller' | 'kind';

export function vehicleSubstitutionGroup(s: VehicleSubstitution): VehicleSubstitutionGroup {
  if (s.kindMismatch) return 'kind';
  if (!s.typeMismatch) return 'ordered';
  if (s.relation === 'bigger') return 'bigger';
  if (s.relation === 'smaller' || s.relation === 'mixed') return 'smaller';
  return 'other';
}

export const vehicleSubstitutionGroupLabels: Record<VehicleSubstitutionGroup, string> = {
  ordered: 'Заказанный тип',
  bigger: 'Крупнее заказанного',
  other: 'Другие типы вида',
  smaller: 'Меньше заказанного',
  kind: 'Другой вид техники',
};

const VEHICLE_SUBSTITUTION_ORDER: readonly VehicleSubstitutionGroup[] = [
  'ordered',
  'bigger',
  'other',
  'smaller',
  'kind',
];

/** Порядок группы в списке: 0 — заказанный тип, дальше по убыванию пригодности. */
export function vehicleSubstitutionRank(s: VehicleSubstitution): number {
  return VEHICLE_SUBSTITUTION_ORDER.indexOf(vehicleSubstitutionGroup(s));
}

// ── Марки/модели: read-only список для выбора в форме техники (не отдельный справочник) ──
export const VEHICLE_MODEL_SORT_FIELDS = ['name', 'createdAt'] as const;

export const vehicleModelListQuerySchema = baseListQuery(VEHICLE_MODEL_SORT_FIELDS).extend({
  vehicleTypeId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export interface VehicleModelDto {
  id: string;
  vehicleTypeId: string;
  name: string;
  manufacturerName: string;
  isActive: boolean;
}
