import { z } from 'zod';
import { baseListQuery, dateOnlySchema, type ListResult, uuidSchema } from './common';
import type { ReadingSourceKind } from './driver-cabinet';
import type { AttachedFileDto } from './files';

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

// ── Пакетный приём (Р8, Р9) ──

/**
 * Сколько отчётов уходит в пакет за раз.
 *
 * Число взято из предметной границы, а не из общих соображений о размере тела запроса: отчёт
 * принадлежит паре «работник + день», поэтому отчётов за день не бывает больше, чем людей за рулём
 * парка, а парк — около 200 машин, активных меньше (Р3). Двести покрывают самый людный день
 * целиком, и кнопка «Принять N отчётов» ни на одном настоящем дне в потолок не упирается.
 *
 * Потолок при этом обязан быть: пакет — это N последовательных транзакций (Р9), и запрос на десять
 * тысяч строк занял бы соединение с базой на минуты. Совпадение с одним из размеров страницы
 * (`PAGE_SIZES`) не случайно — реестр за период длиннее дня режется страницами, и порция пакета
 * ложится ровно на порцию списка.
 */
export const REPORT_ACCEPT_BATCH_LIMIT = 200;

/**
 * Пакетный приём: список пар «отчёт + версия, которую видел принимающий».
 *
 * Версия у каждой строки своя и обязательна по той же причине, что у одиночного приёма: приём
 * подтверждает данные, а не факт нажатия. Один список без версий означал бы «принять всё, что там
 * сейчас», — то есть подтвердить не глядя и то, что успели поправить в соседней вкладке.
 *
 * Повтор одного отчёта в списке — ошибка запроса, а не отказ строки: второй заход по тому же
 * идентификатору всё равно упёрся бы в «отчёт уже принят», и ответ, где один и тот же отчёт стоит
 * разом в принятых и в непринятых, читался бы как противоречие.
 */
export const reportAcceptBatchSchema = z.object({
  reports: z
    .array(z.object({ id: uuidSchema, version: z.number().int().nonnegative() }))
    .max(REPORT_ACCEPT_BATCH_LIMIT)
    .superRefine((rows, ctx) => {
      if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        ctx.addIssue({ code: 'custom', message: 'Отчёт указан в списке дважды' });
      }
    }),
});
export type ReportAcceptBatchInput = z.infer<typeof reportAcceptBatchSchema>;

/**
 * Почему отчёт не принят — грубым кодом для портала. Подробность живёт в тексте `reason`: его
 * пишет сам приём, и второго перечня причин рядом с ним заводить нельзя — разъедься они, и портал
 * объяснял бы отказ не тем, чем он случился.
 *
 * - `version` — версия разошлась: отчёт правили после того, как его показали;
 * - `blocked` — приём не прошёл по условиям (уже принят, появилось расхождение, не закрыта строка);
 * - `gone` — отчёта больше нет;
 * - `error` — сбой, о котором говорит лог сервера, а не пользователь.
 */
export const REPORT_ACCEPT_FAILURE_CODES = ['version', 'blocked', 'gone', 'error'] as const;
export type ReportAcceptFailureCode = (typeof REPORT_ACCEPT_FAILURE_CODES)[number];

/**
 * Код 409, которым приём отвечает «условия не выполнены» (Р22), — тем же приёмом, что и
 * `WAYBILL_ACK_REQUIRED_CODE` у выписки.
 *
 * Отказов у приёма два, и лечатся они разным: разошедшаяся версия проходит после перечитывания
 * реестра, невыполненное условие требует разбора дня. Общий `version_conflict` их не различает, а
 * отличать по тексту сообщения («Отчёт принять нельзя: …») значило бы держать разбор ответа на
 * приставке фразы: правка формулировки молча превращала бы `blocked` в `version`.
 */
export const REPORT_ACCEPT_BLOCKED_CODE = 'report_accept_blocked';

/** Непринятый отчёт: код для разбора порталом и готовый текст причины — тот же, что у одиночного приёма. */
export interface ReportAcceptFailureDto {
  id: string;
  code: ReportAcceptFailureCode;
  reason: string;
}

/**
 * Итог пакета (Р9): что принято и что нет, с причиной по каждому непринятому.
 *
 * Принятые перечислены идентификаторами, а не отчётами целиком: экран приёма после пакета
 * перечитывает реестр (счётчики дня меняются у всех строк сразу), и сотня полных `DriverReportDto`
 * в ответе была бы данными, которые никто не читает. Порядок обоих списков — порядок запроса.
 */
export interface ReportAcceptBatchDto {
  accepted: string[];
  failed: ReportAcceptFailureDto[];
}

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

/**
 * Куда уедет строка, если снимок привести к источнику (ADR 0103, решение 11).
 *
 * Цель считает сервер, и это не удобство, а необходимость: `rebase` берёт работника и день **у
 * живого источника**, а портал источника не читает — у него есть только снимок строки и готовый
 * текст расхождения. Вывести цель из вида расхождения нельзя ни в одном из трёх случаев: у `driver`
 * меняется человек, у `date` — день, у `vehicle` не меняется ни то ни другое.
 *
 * Отчёт цели назван отдельно от человека и дня, потому что его может **не быть**: день, который
 * никто не открывал, шапки не имеет, и заводит её сам перенос. Есть — и его версия обязана уехать в
 * теле `rebase` наравне с версией исходного отчёта: перенос двигает обе шапки, и без второй версии
 * два диспетчера молча перезаписали бы перенос друг друга.
 */
export interface DiscrepancyTargetDto {
  /** Кто по документу едет сейчас: у `vehicle` — тот же работник, что и в отчёте. */
  personId: string;
  personName: string;
  /** День источника; у недельного ЭСМ-2 своего дня нет, и строка остаётся в дне отчёта. */
  date: string;
  /** Отчёт цели, если он уже заведён. `null` — день ещё не открывали, шапку заведёт перенос. */
  reportId: string | null;
  reportVersion: number | null;
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
  /**
   * Цель переноса — только у видов, которым есть что переносить (`driver`, `vehicle`, `date`). У
   * `missing_source` строки нет вовсе, у `source_state` нет самого источника — переносить не к
   * чему, и цель у них `null`.
   *
   * В отпечаток цель не входит намеренно: расхождение — это разошедшиеся снимок и источник, а
   * появление у цели своей шапки их не меняет. Войди она туда, и открытие соседнего дня молча
   * обесценивало бы уже записанные решения по расхождению.
   */
  target: DiscrepancyTargetDto | null;
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

/**
 * Строка журнала машины: чей день, какая смена и что с показанием. Ключ строки — `itemId`, а не
 * идентификатор показания: журнал открывают ради смен, по которым числа как раз и не сдали.
 */
export interface VehicleReadingJournalRow {
  itemId: string;
  reportId: string;
  reportDate: string;
  shiftOrder: number;
  reportState: DriverReportState;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  /** «Р-142» либо номер бланка ЭСМ-2 — тем же правилом, каким источник зовут везде. */
  sourceLabel: string;
  personId: string;
  personName: string;
  /** Пусто — смена была, а показания по ней нет: ровно то, ради чего журнал и открывают. */
  reading: VehicleReadingDto | null;
  /**
   * Фотографии показания с именем, типом и размером — общий `AttachedFileDto` (`files.ts`), тот же
   * тип, каким отдаёт свои сканы акт ТО: «подшитый файл» читающий экран рисует одинаково везде, и
   * второго описания у него быть не должно. Одних идентификаторов (`VehicleReadingDto.fileIds`)
   * мало — снимок открывают прямо из строки журнала, а безымянную ссылку показать нечем.
   */
  files: AttachedFileDto[];
  /** История правок показания: кто, когда и с какой причиной трогал чужие числа. */
  edits: { event: string; changedAt: string; changedByName: string; reason: string }[];
}

/**
 * Журнал одной машины — обычный списочный ответ портала (Р25): страница строк и общее их число.
 *
 * Прежнего флага «хвост обрезан» здесь нет и быть не должно: он описывал предел сервера, а не
 * данные, и заставлял читающего сужать период вместо того, чтобы листать. Общее число отвечает на
 * тот же вопрос честнее — сколько строк в периоде всего.
 */
export interface VehicleReadingJournalDto extends ListResult<VehicleReadingJournalRow> {
  vehicleId: string;
  vehicleLabel: string;
  from: string;
  to: string;
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
   * Последний снимок счётчика **внутри периода** (Р17): само число на приборе и день, за который
   * его сняли. Стоит рядом с суммой того же счётчика намеренно — снимок и разность читаются вместе.
   *
   * `null` — числового показания в периоде не было; это не ноль и не «счётчик на нуле». Дата рядом
   * с числом обязательна по той же причине, что и в колонке гаража: снимок без даты читают как
   * сегодняшний, и у месяц простоявшей машины он врёт на весь простой.
   */
  lastOdometer: { value: number; measuredOn: string } | null;
  lastEngineHours: { value: number; measuredOn: string } | null;
  /**
   * Заправлено за период, литры. Производных показателей рядом нет намеренно: цифра, поделённая
   * на пробег, называлась бы расходом независимо от того, как её подписать в колонке.
   */
  fuelFilledLiters: number;
  /**
   * Сколько раз ряд разрывался: смена без числового показания либо сброс счётчика. Колонка считает
   * **строки**, на каждой из которых ряд прервался, и считает каждую один раз (Р28а).
   *
   * Из трёх чисел `ReadingTotals` она поэтому не выводится: `odometerGaps + engineHoursGaps` теряет
   * смены, по которым чисел нет вовсе, и дважды считает строку со сбросом обоих счётчиков, а
   * `missingReadings` живёт на другой координате — он про ожидаемые смены, а разрыв про строку, в
   * которой ряд оборвался.
   */
  gaps: number;
}

/** Отрезок, за который спрашивают показания: его границы одинаковы у сводки, карточки и журнала. */
const readingPeriodShape = { from: dateOnlySchema, to: dateOnlySchema };

/**
 * Порядок границ. Потолка длины схема не знает намеренно — он свой у каждой ручки и живёт на
 * сервере (`MAX_PERIOD_DAYS`), а эта схема общая с порталом.
 */
function checkPeriodOrder(v: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (v.to < v.from) {
    ctx.addIssue({ code: 'custom', message: 'Конец периода раньше начала', path: ['to'] });
  }
}

export const readingStatsQuerySchema = z
  .object(readingPeriodShape)
  .strict()
  .superRefine(checkPeriodOrder);
export type ReadingStatsQuery = z.infer<typeof readingStatsQuerySchema>;

/**
 * Период плюс страница (Р25) — форма запроса у всякого листаемого списка показаний.
 *
 * Страница описана не своими числами, а взятыми у `baseListQuery`: правила листания в портале
 * одни — те же размеры страницы, та же нумерация с единицы, — и второй их набор разъехался бы с
 * первым при первой же правке.
 *
 * Сортировки в схеме нет намеренно: порядок этих списков задан сервером, и параметр, которого он
 * не слышит, обещал бы отбор, которого не происходит.
 */
function periodPageQuery() {
  return baseListQuery([])
    .pick({ page: true, pageSize: true })
    .extend(readingPeriodShape)
    .strict()
    .superRefine(checkPeriodOrder);
}

/** Запрос журнала машины: период и страница. */
export const readingJournalQuerySchema = periodPageQuery();
export type ReadingJournalQuery = z.infer<typeof readingJournalQuerySchema>;

// ── Выгрузки (Р18) ──

/**
 * Вариант выгрузки. Ручка одна, вариант приходит параметром (Р18): пять книг из плана плюс
 * `fleetSummary` — та самая сводка, которую портал выгружает сегодня своей ручкой
 * (`/stats/export`). Шестым он стоит не для полноты: без него старая ручка осталась бы со своей,
 * второй реализацией той же книги, а двух сборщиков одной выгрузки быть не должно.
 *
 * Значения — коды, а не подписи: подписи ниже, и меняются они, не трогая адресов, которые уже
 * отправили соседу.
 */
export const READING_EXPORT_KINDS = [
  'fleetSummary',
  'fleetMonths',
  'vehicleJournal',
  'vehicleMonths',
  'snapshot',
  'fleetJournal',
] as const;
export type ReadingExportKind = (typeof READING_EXPORT_KINDS)[number];
export const readingExportKindSchema = z.enum(READING_EXPORT_KINDS);

/** Как вариант зовут в окне выбора. Подпись одна на портал и на имя файла. */
export const readingExportKindLabels: Record<ReadingExportKind, string> = {
  fleetSummary: 'Сводка по парку',
  fleetMonths: 'Помесячно по парку',
  vehicleJournal: 'Журнал машины',
  vehicleMonths: 'Журнал машины по месяцам',
  snapshot: 'Срез на дату',
  fleetJournal: 'Журнал всего парка',
};

/**
 * Варианты про одну машину. Машина у них не уточнение отбора, а предмет книги: журнал «по всему
 * парку без машины» и журнал «одной машины» — разные выгрузки, и склеивать их необязательным
 * параметром значило бы отдавать книгу парка тому, кто просил одну машину и забыл её выбрать.
 */
export const READING_EXPORT_VEHICLE_KINDS: readonly ReadingExportKind[] = [
  'vehicleJournal',
  'vehicleMonths',
];

export function readingExportNeedsVehicle(kind: ReadingExportKind): boolean {
  return READING_EXPORT_VEHICLE_KINDS.includes(kind);
}

/**
 * Запрос выгрузки: вариант, период и — у вариантов про одну машину — сама машина.
 *
 * Правило машины стоит в схеме, а не в обработчике, и потому одно на портал и сервер: окно выбора
 * гасит кнопку по тому же условию, по которому сервер отвечает отказом. Лишний `vehicleId` —
 * тоже отказ, а не молча забытый параметр: «журнал всего парка по машине А123БВ777» звучит как
 * отбор, которого не произойдёт.
 *
 * Потолка длины периода здесь нет по той же причине, что у соседей: он свой у каждой ручки и
 * живёт на сервере.
 */
export const readingExportQuerySchema = z
  .object({
    ...readingPeriodShape,
    kind: readingExportKindSchema,
    vehicleId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    checkPeriodOrder(v, ctx);
    if (readingExportNeedsVehicle(v.kind)) {
      if (v.vehicleId === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Выберите машину', path: ['vehicleId'] });
      }
      return;
    }
    if (v.vehicleId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Эта выгрузка идёт по всему парку: машина в запросе лишняя',
        path: ['vehicleId'],
      });
    }
  });
export type ReadingExportQuery = z.infer<typeof readingExportQuerySchema>;

// ── Реестр приёма (Р5, Р6, Р7, Р9а) ──

/**
 * Со скольких дней ожидание становится просрочкой (Р6). Дни считает сервер по московскому дню
 * (Р23): красная строка не должна зависеть от часов телефона в кабине.
 */
export const READING_OVERDUE_DAYS = 3;

/**
 * Пометка строки приёма: код для портала, уровень и **готовый текст** (Р5, Р7).
 *
 * Текст приходит с сервера, а не собирается на экране, и это следствие обещанных формулировок:
 * «прирост 3 400 км за 1 день при пороге 1 500» и «рейс Р-142 переназначен Петрову П. П.» из
 * перечня видов не выводятся — нужны значения, даты и готовое `ReportDiscrepancyDto.message`.
 * Портал не сочиняет ни текстов, ни уровней: он их показывает.
 *
 * Зелёного уровня у пометки нет намеренно: зелёная строка — это **пустой список** пометок (Р6), а
 * не пометка «всё хорошо». Уровень строки собирает `intakeLevel`.
 */
export interface IntakeIssue {
  /** Что случилось: `overdue`, `waiting`, `no_data`, `anomaly_*` либо вид расхождения. */
  code: string;
  level: 'yellow' | 'red';
  message: string;
}

/**
 * Уровень строки — максимум уровней её пометок (Р5), и считается он **только здесь**: ни в SQL, ни
 * на портале второй формулы быть не должно. Разойдись они, и кнопка пакетного приёма предлагала бы
 * принять день, который экран красит жёлтым.
 */
export function intakeLevel(issues: readonly IntakeIssue[]): 'green' | 'yellow' | 'red' {
  if (issues.some((issue) => issue.level === 'red')) return 'red';
  return issues.length === 0 ? 'green' : 'yellow';
}

/**
 * Строка реестра приёма — **ожидаемая смена** (Р26, Р32), а не строка ожидания отчёта: у дня,
 * который никто не открывал, строк нет вовсе, а показания с него ждут — ровно ради таких дней
 * экран и нужен.
 *
 * Отсюда виртуальная строка: источник есть, строки ожидания нет. Ключ у неё `route:<id>` /
 * `esm2:<id>`, `itemId` и `reading` пусты, а действие — «открыть отчёт за работника». Она же
 * закрывает `missing_source`: расхождение уровня отчёта, не принадлежащее ни одной строке, — это
 * ровно источник, которого в отчёте нет.
 *
 * Координат у смены две и они не сворачиваются в одну (Р32): `reportDate`/`vehicleId` — живые,
 * то есть день и машина источника **сегодня**; показание же принадлежит своей, снимочной. Разошлись
 * они — это и есть расхождение, и о нём говорит пометка.
 */
export interface ReadingIntakeRow {
  /** `itemId` либо `route:<id>` / `esm2:<id>` у виртуальной строки. Уникален в ответе. */
  key: string;
  itemId: string | null;
  reportId: string | null;
  reportDate: string;
  vehicleId: string;
  vehicleLabel: string;
  personId: string | null;
  personName: string;
  sourceKind: ReadingSourceKind;
  /** «Р-142» либо «ЭСМ-2 № 000123» — тем же правилом, каким источник зовут везде. */
  sourceLabel: string;
  reading: VehicleReadingDto | null;
  issues: IntakeIssue[];
}

/**
 * Отчёт дня рядом со строками — со счётчиками по **всем** своим строкам (Р9а).
 *
 * Пригодность к пакету считает сервер и считает по всему отчёту, а не по видимым строкам:
 * пагинация делит отчёт между страницами, и кнопка, считающая по странице, предложила бы принять
 * отчёт с невидимой жёлтой строкой.
 */
export interface ReadingIntakeReport {
  reportId: string;
  personName: string;
  state: DriverReportState;
  /** Версия шапки: пакетный приём отправляет её обратно оптимистической блокировкой. */
  version: number;
  batchEligible: boolean;
  /** Строк реестра у этого отчёта — вместе с виртуальными (`missing_source`). */
  itemCount: number;
  greenCount: number;
}

/**
 * Ответ реестра: страница строк, отчёты периода целиком и серверное «сегодня».
 *
 * `today` приходит в ответе не для красоты (Р23): по нему посчитаны все пометки просрочки, и портал
 * обязан подписывать строки тем же днём, каким их посчитали, — а не тем, который показывают часы
 * телефона в кабине.
 */
export interface ReadingIntakeDto extends ListResult<ReadingIntakeRow> {
  from: string;
  to: string;
  today: string;
  reports: ReadingIntakeReport[];
}

/**
 * Запрос реестра: период и страница — той же формы, что у журнала (Р25). Границы отрезка, за
 * который спрашивают показания, одинаковы у сводки, карточки, журнала и реестра.
 */
export const readingIntakeQuerySchema = periodPageQuery();
export type ReadingIntakeQuery = z.infer<typeof readingIntakeQuerySchema>;

// ── Карточка машины ──

/**
 * Числа периода. Месяц и итог описаны одним типом намеренно (Р4): пара разностей засчитывается в
 * месяц текущего снимка, поэтому сумма месяцев равна итогу — разойдись формы, и первое же новое
 * поле пришлось бы добавлять дважды.
 *
 * Разрывов три числа, а не одно (Р28): цепочки одометра и моточасов независимы, и общий счётчик не
 * отвечает ни на один вопрос диаграммы, которую переключают по счётчику. Сводная колонка списка
 * (`VehicleReadingStatsRow.gaps`) из этих трёх при этом **не выводится** — см. её описание.
 */
export interface ReadingTotals {
  /** Прочерк, а не ноль: период, где не осталось ни одной пары снимков, о пробеге не говорит. */
  distanceKm: number | null;
  engineHours: number | null;
  fuelFilledLiters: number;
  odometerGaps: number;
  engineHoursGaps: number;
  /** Ожидаемая смена без числового показания — по живой координате источника (Р32). */
  missingReadings: number;
  /** Ожидаемые смены (Р26в), а не строки отчёта: у неоткрытого дня строк нет, а смены были. */
  shifts: number;
  /**
   * Качество данных (Р27): статистика оперативная, считает всё непринятое наравне с принятым.
   * Цифра рядом с итогом честнее предупреждения мелким шрифтом — она называет, сколько именно.
   */
  unacceptedShifts: number;
}

export interface ReadingMonthRow extends ReadingTotals {
  /** `YYYY-MM` — месяц снимка, а не его предшественника (Р4). */
  month: string;
}

export interface VehicleReadingCardDto {
  vehicleId: string;
  vehicleLabel: string;
  from: string;
  to: string;
  /** Ровно сумма месяцев (Р4); поля `month` у итога нет, потому что называть его нечем. */
  total: ReadingTotals;
  months: ReadingMonthRow[];
  /** «Последние» — на конец периода (`to`, Р16), иначе карточка марта показывала бы майский пробег. */
  lastOdometer: { km: number; measuredOn: string } | null;
  lastEngineHours: { value: number; measuredOn: string } | null;
}
// Блока ТО здесь нет: сводка обслуживания приходит своей ручкой под своим правом (Р14а). Поле,
// исчезающее по чужому праву, — то же смешение прав, только спрятанное в сериализатор.
