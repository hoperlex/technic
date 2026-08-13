import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';
import type { ReadingSourceKind } from './driver-cabinet';

/**
 * Показания техники (ADR 0103): одометр, моточасы и заправленное за смену.
 *
 * Три утверждения, из которых следует вся модель:
 *
 * 1. **Показание принадлежит выезду, а не дню.** Оно привязано к строке ожидания отчёта, а та —
 *    к рейсу или недельному листу: только источник отвечает, в каком порядке шли смены, кому
 *    относится разница и с чем сравнивать следующий снимок.
 * 2. **Хранится снимок счётчика**, а не работа за смену: водитель списывает цифру с прибора, а
 *    не вычитает. Пробег и наработка считаются разностями соседних снимков.
 * 3. **Портал считает заправленное топливо, и только его.** Ни расхода, ни производных «на сто
 *    километров» — фактический расход требует остатков в баке, которых у нас нет, а показатель,
 *    похожий на расход, читался бы как расход в первый же день. Учёт топлива по этим данным не
 *    строится: строится учёт заправленного.
 */

// ── Состояния и перечисления ──

/**
 * Состояние отчёта дня. `needs_reacceptance` — принятый отчёт, который после этого правили:
 * `accepted_*` сохраняются, а расхождение версий показывает, насколько принятое разошлось с
 * текущим. `voided` — отчёт, из которого перенос унёс последнюю строку: приёмке не подлежит,
 * историю хранит.
 */
export const DRIVER_REPORT_STATES = [
  'draft',
  'submitted',
  'accepted',
  'needs_reacceptance',
  'voided',
] as const;
export type DriverReportState = (typeof DRIVER_REPORT_STATES)[number];
export const driverReportStateSchema = z.enum(DRIVER_REPORT_STATES);

export const driverReportStateLabels: Record<DriverReportState, string> = {
  draft: 'Черновик',
  submitted: 'Передан',
  accepted: 'Принят',
  needs_reacceptance: 'Требует повторного приёма',
  voided: 'Аннулирован',
};

/**
 * Вид показания. `no_data` — «работали, но снять нечего»: счётчик неисправен, машину увёл
 * сменщик, кабина опечатана. Это закрытие строки, а не пропуск, и причина у него обязательна.
 */
export const READING_KINDS = ['values', 'no_data'] as const;
export type ReadingKind = (typeof READING_KINDS)[number];
export const readingKindSchema = z.enum(READING_KINDS);

/** Кто внёс: сам работник из кабинета или сотрудник за него (ADR 0103). */
export const READING_SOURCES = ['driver', 'staff'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];
export const readingSourceSchema = z.enum(READING_SOURCES);

/**
 * Аномалия счётчика. Начала ряда здесь нет намеренно: «предшественника не было» — это состояние
 * (`previous* = null`), а не отклонение, иначе первое показание каждой машины навсегда осталось
 * бы расхождением.
 */
export const READING_ANOMALIES = ['counter_reset', 'implausible_jump'] as const;
export type ReadingAnomaly = (typeof READING_ANOMALIES)[number];
export const readingAnomalySchema = z.enum(READING_ANOMALIES);

export const readingAnomalyLabels: Record<ReadingAnomaly, string> = {
  counter_reset: 'счётчик сброшен или заменён',
  implausible_jump: 'невероятный прирост',
};

/** Расхождение снимка с живым источником (ADR 0103). */
export const DISCREPANCY_KINDS = [
  'driver',
  'vehicle',
  'date',
  'source_state',
  'missing_source',
] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];
export const discrepancyKindSchema = z.enum(DISCREPANCY_KINDS);

export const discrepancyKindLabels: Record<DiscrepancyKind, string> = {
  driver: 'источник переназначен другому работнику',
  vehicle: 'у источника другая машина',
  date: 'источник перенесён на другую дату',
  source_state: 'источник удалён или аннулирован',
  missing_source: 'источник дня не вошёл в отчёт',
};

/**
 * Исход разбора. `revoked` отменяет прежнее решение при неизменном отпечатке — без него
 * расхождение, однажды признанное допустимым, нельзя было бы снова сделать неразобранным.
 */
export const DISCREPANCY_RESOLUTIONS = ['accepted_as_is', 'source_added', 'revoked'] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];
export const discrepancyResolutionSchema = z.enum(DISCREPANCY_RESOLUTIONS);

// ── Пороги сверки ──

/**
 * Пороги невероятного прироста между снимками, отстоящими на `d` суток. `max(1, d)` существенно:
 * у двух смен одного дня `d = 0`, и без нижней границы любой прирост второй смены стал бы
 * аномалией.
 */
export const ODOMETER_JUMP_PER_DAY_KM = 1500;
export const ENGINE_HOURS_JUMP_PER_DAY = 24;

export function jumpLimit(perDay: number, daysBetween: number): number {
  return perDay * Math.max(1, daysBetween);
}

// ── Ввод ──

/** Числа приходят строками с портала — запятая нормализуется до точки на вводе. */
const readingNumber = z.number().nonnegative();

export const readingValuesSchema = z
  .object({
    kind: z.literal('values'),
    odometerKm: z.number().int().nonnegative().nullable().default(null),
    engineHours: readingNumber.nullable().default(null),
    fuelFilledLiters: readingNumber.nullable().default(null),
    comment: z.string().trim().max(500).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.odometerKm === null && v.engineHours === null && v.fuelFilledLiters === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Заполните хотя бы одно значение или отметьте «нет возможности снять показания»',
        path: ['odometerKm'],
      });
    }
  });

export const readingNoDataSchema = z.object({
  kind: z.literal('no_data'),
  noDataReason: z.string().trim().min(1, 'Укажите причину').max(500),
  comment: z.string().trim().max(500).default(''),
});

export const readingInputSchema = z.discriminatedUnion('kind', [
  readingValuesSchema,
  readingNoDataSchema,
]);
export type ReadingInput = z.infer<typeof readingInputSchema>;

/** Строка отправки: показание по конкретной строке ожидания плюс её файлы. */
export const reportItemSubmitSchema = z.object({
  itemId: uuidSchema,
  reading: readingInputSchema,
  /** Файлы, загруженные до отправки: связываются той же транзакцией, что создаёт показание. */
  fileIds: z.array(uuidSchema).max(20).default([]),
  /** Подтверждение аномалии, показанной порталом при предыдущей попытке. */
  confirmOdometerAnomaly: z.boolean().default(false),
  confirmEngineHoursAnomaly: z.boolean().default(false),
});
export type ReportItemSubmit = z.infer<typeof reportItemSubmitSchema>;

export const reportSubmitSchema = z.object({
  /** Версия шапки, которую видел отправляющий: оптимистическая блокировка. */
  version: z.number().int().nonnegative(),
  items: z.array(reportItemSubmitSchema).min(1),
  /**
   * Причина правки. У водителя её нет и быть не должно — он сдаёт своё; у персонала, правящего
   * чужое показание, она обязательна, и требует её сервис, а не схема: пустая причина законна,
   * пока правят ещё не существующую строку (ввод за водителя, у которого учётки нет).
   */
  reason: z.string().trim().max(500).default(''),
});
export type ReportSubmitInput = z.infer<typeof reportSubmitSchema>;
/**
 * Тело отправки со стороны портала. Отличается от `ReportSubmitInput` тем, что поля с умолчаниями
 * в нём необязательны: у водителя причины правки нет и быть не должно, и требовать от него пустую
 * строку значило бы просить назвать причину того, что он делает впервые.
 */
export type ReportSubmitBody = z.input<typeof reportSubmitSchema>;

export const reportAcceptSchema = z.object({ version: z.number().int().nonnegative() });

export const reportItemOrderSchema = z.object({
  vehicleId: uuidSchema,
  date: dateOnlySchema,
  /** Ожидаемый прежний порядок: без него два диспетчера молча перезаписывают перестановку. */
  expectedOrder: z.array(uuidSchema).min(1),
  order: z.array(z.object({ itemId: uuidSchema, shiftOrder: z.number().int().positive() })).min(1),
  reportVersions: z.record(uuidSchema, z.number().int().nonnegative()),
  reason: z.string().trim().min(1).max(500),
});
export type ReportItemOrderInput = z.infer<typeof reportItemOrderSchema>;

export const discrepancyResolveSchema = z.object({
  kind: discrepancyKindSchema,
  /** Предмет: строка ожидания либо (у `missing_source`) сам источник. */
  itemId: uuidSchema.nullable().default(null),
  sourceKind: z.enum(['route', 'esm2']).nullable().default(null),
  sourceId: uuidSchema.nullable().default(null),
  /** Отпечаток расхождения, показанный порталом: решение действует, только пока он тот же. */
  fingerprint: z.string().min(1).max(200),
  resolution: discrepancyResolutionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
});
export type DiscrepancyResolveInput = z.infer<typeof discrepancyResolveSchema>;

export const readingRebaseSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  reportVersions: z.record(uuidSchema, z.number().int().nonnegative()),
});
export type ReadingRebaseInput = z.infer<typeof readingRebaseSchema>;

// ── Чтение ──

export interface ReadingAnomalyDto {
  kind: ReadingAnomaly;
  confirmed: boolean;
  /** Значение предшественника — то, с чем сравнивали. */
  previousValue: number | null;
  previousDate: string | null;
}

export interface VehicleReadingDto {
  id: string;
  itemId: string;
  kind: ReadingKind;
  odometerKm: number | null;
  engineHours: number | null;
  fuelFilledLiters: number | null;
  noDataReason: string;
  comment: string;
  source: ReadingSource;
  recordedAt: string;
  odometerAnomaly: ReadingAnomalyDto | null;
  engineHoursAnomaly: ReadingAnomalyDto | null;
  /** Прирост к предшественнику: разности считает сервер, портал их только показывает. */
  odometerDelta: number | null;
  engineHoursDelta: number | null;
  fileIds: string[];
}

export interface ReportDiscrepancyDto {
  kind: DiscrepancyKind;
  itemId: string | null;
  sourceKind: ReadingSourceKind | null;
  sourceId: string | null;
  fingerprint: string;
  /** Человеческое объяснение: «рейс Р-142 переназначен Петрову П. П.». */
  message: string;
  resolved: boolean;
  resolvedReason: string;
}

export interface ReportItemDto {
  id: string;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  sourceLabel: string;
  vehicleId: string;
  vehicleLabel: string;
  shiftOrder: number;
  reading: VehicleReadingDto | null;
}

export interface DriverReportDto {
  id: string;
  personId: string;
  personName: string;
  reportDate: string;
  state: DriverReportState;
  contentVersion: number;
  version: number;
  acceptedContentVersion: number | null;
  acceptedAt: string | null;
  acceptedByName: string;
  items: ReportItemDto[];
  discrepancies: ReportDiscrepancyDto[];
  /** Можно ли принять день прямо сейчас: четыре условия приёма (ADR 0103). */
  canAccept: boolean;
  blockers: string[];
}

// ── Состояние машины в гараже ──

/**
 * Что с показаниями машины за день. Значения упорядочены по старшинству: у одной машины их
 * бывает несколько сразу, и колонка обязана называть главное — то, с чем надо что-то делать.
 */
export const VEHICLE_READING_DAY_STATES = [
  'discrepancy',
  'needs_reacceptance',
  'partial',
  'reported',
  'none',
] as const;
export type VehicleReadingDayState = (typeof VEHICLE_READING_DAY_STATES)[number];

export const vehicleReadingDayStateLabels: Record<VehicleReadingDayState, string> = {
  discrepancy: 'расхождение',
  needs_reacceptance: 'на повторный приём',
  partial: 'частично',
  reported: 'сданы',
  none: 'нет',
};

export const vehicleReadingDayStateColors: Record<VehicleReadingDayState, string> = {
  discrepancy: 'red',
  needs_reacceptance: 'orange',
  partial: 'gold',
  reported: 'green',
  none: 'default',
};

/**
 * Состояние дня по трём числам строк ожидания. Условия писаны числами намеренно: формулировка
 * «частично — есть строка без показания» отправляла бы в «частично» и день, где не сдано ничего.
 */
export function vehicleReadingDayState(counts: {
  itemCount: number;
  closedCount: number;
  hasDiscrepancy: boolean;
  hasNeedsReacceptance: boolean;
}): VehicleReadingDayState {
  if (counts.hasDiscrepancy) return 'discrepancy';
  if (counts.hasNeedsReacceptance) return 'needs_reacceptance';
  const pending = counts.itemCount - counts.closedCount;
  if (counts.closedCount > 0 && pending > 0) return 'partial';
  if (counts.itemCount > 0 && pending === 0) return 'reported';
  return 'none';
}

// ── Статистика парка ──

export interface VehicleReadingStatsRow {
  vehicleId: string;
  vehicleLabel: string;
  /** Пробег и наработка — суммы разностей по непрерывным участкам ряда. */
  distanceKm: number | null;
  engineHours: number | null;
  /**
   * Заправлено за период, литры. Производных показателей рядом нет намеренно: цифра, поделённая
   * на пробег, называлась бы расходом независимо от того, как её подписать в колонке.
   */
  fuelFilledLiters: number;
  /** Сколько раз ряд разрывался: сброс счётчика или пропущенный день. */
  gaps: number;
}

export const readingStatsQuerySchema = z
  .object({ from: dateOnlySchema, to: dateOnlySchema })
  .strict()
  .superRefine((v, ctx) => {
    if (v.to < v.from) {
      ctx.addIssue({ code: 'custom', message: 'Конец периода раньше начала', path: ['to'] });
    }
  });
export type ReadingStatsQuery = z.infer<typeof readingStatsQuerySchema>;
