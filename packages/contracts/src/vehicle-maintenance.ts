/**
 * Техобслуживание техники по пробегу (план «Показания техники», решения Р10—Р14, Р24).
 *
 * Три утверждения, из которых следует всё остальное:
 *
 * 1. **ТО ведётся журналом записей, а не полем «когда обслуживали».** Дата, одометр на момент,
 *    номер документа, примечание и скан акта — история хранится целиком.
 * 2. **«Пробег с ТО» приходит готовым числом.** Считает его сервер суммой разностей цепочки
 *    показаний с граничным якорем из акта (Р11); вычитание «последний одометр − одометр акта»
 *    здесь не работает — при замене счётчика оно даёт отрицательное число.
 * 3. **Незнание бывает двух видов, и флага поэтому два** (Р11в). `chainBroken` — в интервале был
 *    сброс счётчика: переход через него неизвестен и может быть большим. `lowerBound` — известного
 *    меньше, чем проехано: акт без одометра либо незакрытый хвост ожиданий.
 *
 * Модуль самодостаточен и с показаниями типами не связан: сводка ТО живёт под своим правом
 * (`vehicleMaintenance.read`) и не тянет за собой DTO показаний (Р14а).
 */

import { z } from 'zod';
import { dateOnlySchema, PAGE_SIZES, uuidSchema } from './common';
import type { AttachedFileDto } from './files';

// ── По чему ведётся ТО ──

/**
 * Основание расчёта ТО у типа техники (Р13). `none` — не ведётся вовсе.
 *
 * Признак заводится явно в справочнике, а не выводится из истории показаний: новая машина
 * показаний ещё не имеет, а временно пустой одометр не означает, что прибора нет.
 */
export const MAINTENANCE_BASES = ['none', 'odometer'] as const;
export type MaintenanceBasis = (typeof MAINTENANCE_BASES)[number];

/**
 * Состояние обслуживания машины.
 *
 * `not_tracked` — по типу техники ТО не ведётся (`basis = 'none'`), и вопроса про срок нет;
 * `unknown` — вопрос есть, а ответа нет: пробег с ТО неизвестен или известен лишь снизу.
 * Различать их обязательно: «не ведём» — это норма справочника, а «не знаем» — повод разобраться.
 */
export const MAINTENANCE_STATES = ['ok', 'due_soon', 'overdue', 'unknown', 'not_tracked'] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

// ── Норматив ──

/**
 * Норматив пробега между ТО и порог «скоро», километры (Р12).
 *
 * Константа кода, одна на весь парк: принуждения нет — подсветка приближения и превышения, никаких
 * запретов. Переезд «константа → поле у типа техники» меняет источник числа, а не расчёт: у
 * `maintenanceState` для этого есть `intervalKm` (Р24).
 */
export const MAINTENANCE_INTERVAL_KM = 10_000;
export const MAINTENANCE_DUE_SOON_KM = 1_000;

/**
 * Состояние обслуживания по готовым числам (Р24): функция принимает пробег и флаги, а не машину, —
 * иначе переезд норматива к типу техники стал бы правкой расчёта.
 *
 * Правило асимметрично, и это главное в нём (Р11в). Оба флага могут только **увеличить**
 * фактический пробег, поэтому:
 *
 *   * `kmSince >= интервала` — это `overdue` достоверно, при любых флагах: больше известного
 *     машина проехать могла, меньше — нет;
 *   * ниже интервала при поднятом флаге — `unknown` («не меньше 8 340 км»), а **не** `ok`.
 *
 * Порядок проверок поэтому такой: сначала «ведём ли вообще», затем «есть ли число», затем
 * превышение, и только потом флаги. Поставь флаги раньше превышения — и просроченная машина со
 * сбросом счётчика показывала бы «неизвестно» вместо «просрочено».
 */
export function maintenanceState(input: {
  /** `none` → `not_tracked`: тип техники ТО не ведёт, и остальные поля значения не имеют. */
  basis: MaintenanceBasis;
  /** Пробег с последнего ТО, км. `null` — записи ТО нет вовсе либо цепочку не из чего построить. */
  kmSince: number | null;
  /** В интервале был сброс счётчика: переход через него неизвестен (Р11в). */
  chainBroken: boolean;
  /** Известного меньше, чем проехано: акт без одометра либо незакрытый хвост ожиданий (Р11в). */
  lowerBound: boolean;
  /** Норматив, если он однажды переедет к типу техники (Р24). */
  intervalKm?: number;
}): MaintenanceState {
  if (input.basis === 'none') return 'not_tracked';
  const interval = input.intervalKm ?? MAINTENANCE_INTERVAL_KM;
  if (input.kmSince === null) return 'unknown';
  if (input.kmSince >= interval) return 'overdue';
  if (input.chainBroken || input.lowerBound) return 'unknown';
  return input.kmSince >= interval - MAINTENANCE_DUE_SOON_KM ? 'due_soon' : 'ok';
}

// ── Как состояние называется и красится ──

/**
 * Подпись состояния — одна на все экраны, как у состояния дня показаний
 * (`vehicleReadingDayStateLabels`). Рядом с типом, а не у того, кто первым его показал: колонка
 * гаража, блок карточки машины и окно сводки механика называют одно и то же состояние, и три копии
 * словаря разъехались бы при первой правке слова.
 */
export const maintenanceStateLabels: Record<MaintenanceState, string> = {
  ok: 'в норме',
  due_soon: 'скоро ТО',
  overdue: 'просрочено',
  unknown: 'неизвестно',
  not_tracked: 'не ведётся',
};

/**
 * Цвет тега. `unknown` и `not_tracked` серые оба и намеренно: незнание — не тревога, и красить его
 * в жёлтый значило бы звать механика к машине, про которую нечего сказать. Разбираются они словами
 * (`maintenanceStateHint`), а не оттенком.
 */
export const maintenanceStateColors: Record<MaintenanceState, string> = {
  ok: 'green',
  due_soon: 'gold',
  overdue: 'red',
  unknown: 'default',
  not_tracked: 'default',
};

/**
 * Почему состояние такое — человеческими словами (Р11в, Р13).
 *
 * Текст живёт рядом с расчётом по той же причине, что и подписи: «неизвестно» без объяснения
 * читается как поломка портала, хотя означает ровно две разные вещи — счётчик меняли либо известно
 * не всё. Различать их обязан тот, кто смотрит на машину, а не тот, кто пишет очередной экран.
 *
 * Пустой строки функция не возвращает никогда: у состояния всегда есть, что сказать, — даже «в
 * норме» отвечает на невысказанный вопрос «а норматив-то какой».
 */
export function maintenanceStateHint(input: {
  state: MaintenanceState;
  kmSince: number | null;
  chainBroken: boolean;
  lowerBound: boolean;
  intervalKm?: number;
}): string {
  const interval = input.intervalKm ?? MAINTENANCE_INTERVAL_KM;
  const norm = `${interval.toLocaleString('ru-RU')} км`;

  if (input.state === 'not_tracked') {
    return 'У этого типа техники ТО по пробегу не ведётся: срок обслуживания здесь не считается.';
  }
  if (input.state === 'unknown') {
    // Порядок ветвей — от худшего незнания к меньшему: сброс счётчика скрывает целый участок, а
    // незакрытый хвост занижает известное. Совпасть они могут, и назвать тогда надо больший.
    if (input.chainBroken) {
      return (
        'Ряд рвался — счётчик меняли: сколько машина прошла через сброс, неизвестно. ' +
        'Показанное — нижняя граница, на деле пробег с ТО больше.'
      );
    }
    if (input.lowerBound) {
      return (
        'Известно не всё: в акте нет одометра либо сданы не все смены. ' +
        'Показанное — нижняя граница, на деле пробег с ТО больше.'
      );
    }
    return (
      'Пробег с обслуживания посчитать не по чему: записи ТО нет либо цепочку показаний ' +
      'не из чего построить.'
    );
  }
  if (input.state === 'overdue') return `Норматив ${norm} пройден — машину пора обслужить.`;
  if (input.state === 'due_soon') {
    return `До норматива ${norm} осталось меньше ${MAINTENANCE_DUE_SOON_KM.toLocaleString('ru-RU')} км.`;
  }
  return `Пробег с ТО в пределах норматива ${norm}.`;
}

// ── Запись ТО ──

/**
 * Акт обслуживания. `odometerKm` может быть `null`: акт бывает без пробега (прибор не работал), и
 * это отсутствие якоря расчёта, а не ноль (Р11а).
 *
 * `updatedByName` пуст, пока запись не правили, — как `acceptedByName` у отчёта дня: пустая строка
 * вместо `null` там, где портал показывает подпись, а не решает по ней.
 */
export interface VehicleMaintenanceDto {
  id: string;
  vehicleId: string;
  /** `YYYY-MM-DD`. Времени у акта нет — отсюда правило Р11б: снимки дня ТО в пробег не идут. */
  performedOn: string;
  odometerKm: number | null;
  documentNumber: string;
  note: string;
  /**
   * Скан акта — с именем, типом и размером (`AttachedFileDto`, тот же тип, что у фотографий
   * показаний). Файлов может не быть вовсе: запись ведут и по бумажному документу.
   *
   * Имя здесь не украшение. Список одних идентификаторов заставлял форму подписывать вложения
   * «Скан 1», «Скан 2» — портал не знал ни имени файла, ни того, картинка это или PDF, и открыть
   * подшитое из формы было нечем.
   */
  files: AttachedFileDto[];
  /** Оптимистическая блокировка: правка и удаление идут с версией (Р30). */
  version: number;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
}

/**
 * Ответ сводки ТО по машине — самодостаточен, без DTO показаний (Р14а): карточка показаний живёт
 * под `vehicleReadings.read` и отдаёт только статистику, а сводка — под `vehicleMaintenance.read`.
 * Полную карточку диспетчера портал собирает композицией двух ответов.
 *
 * `lastOdometer` — единственное показание, видимое под правом ТО (Р14б): без него состояние
 * нечитаемо — «8 340 км с ТО» нечем проверить. Журнал, приросты, аномалии и фотографии остаются
 * закрытыми.
 */
export interface VehicleMaintenanceSummaryDto {
  vehicleId: string;
  vehicleLabel: string;
  maintenanceBasis: MaintenanceBasis;
  /** На конец периода запроса (Р16), с датой снятия: срез марта не показывает майский пробег. */
  lastOdometer: { km: number; measuredOn: string } | null;
  lastMaintenance: VehicleMaintenanceDto | null;
  /** Пробег с последнего ТО и то, насколько ему можно верить (Р11в). */
  kmSince: number | null;
  chainBroken: boolean;
  lowerBound: boolean;
  /** Ровно `maintenanceState` от полей выше: портал состояние не пересчитывает. */
  state: MaintenanceState;
}

// ── Ввод ──

/**
 * Версия записи в оптимистической блокировке (Р30). `coerce` потому, что у удаления версия
 * приходит строкой в адресе (`?version=3`) — тела у DELETE нет; тем же приёмом её принимает
 * снятие заявки с рейса (`routeVersionQuerySchema`).
 */
const versionSchema = z.coerce.number().int().min(0);

/**
 * День среза (Р16): и записи ТО, и последний одометр берутся не позже него. Параметр
 * необязательный, и умолчание считает **сервер** — сегодняшний московский день, как в гараже:
 * часы браузера бывают сбиты, а восточнее Москвы сутки начинаются раньше, и «сегодня» клиента
 * показало бы завтрашнее ТО.
 */
export const maintenanceSummaryQuerySchema = z.object({ on: dateOnlySchema.optional() }).strict();
export type MaintenanceSummaryQuery = z.infer<typeof maintenanceSummaryQuerySchema>;

/**
 * Машины пакетного запроса — строкой через запятую, тем же приёмом, что получатели рассылки и
 * фильтр действий аудита: повтор `ids=a&ids=b` Fastify разбирает в массив, только пока значений
 * больше одного, и на единственной машине схема получила бы строку.
 *
 * Потолок — размер страницы портала: снапшот заполняет колонку «ТО» видимой страницы гаража
 * (§5), и списка длиннее неё у него не бывает. Пустое значение законно («на странице нет ни одной
 * машины») и отвечает пустым списком, а не отказом.
 */
const vehicleIdsSchema = z
  .string()
  // 37 символов на UUID с запятой — с запасом на пробелы вокруг разделителя.
  .max(Math.max(...PAGE_SIZES) * 40)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(uuidSchema).max(Math.max(...PAGE_SIZES)));

export const maintenanceSnapshotQuerySchema = z
  .object({ on: dateOnlySchema.optional(), ids: vehicleIdsSchema })
  .strict();
export type MaintenanceSnapshotQuery = z.infer<typeof maintenanceSnapshotQuerySchema>;

/**
 * Запись ТО с формы: реквизиты акта и его скан. Машина в теле не повторяется — её задаёт адрес
 * (`/vehicles/:id`), и второе место, где она названа, означало бы возможность их рассогласовать.
 *
 * Дата обязательна: акт без даты не якорь расчёта, а запись «когда-то обслуживали». Одометр,
 * наоборот, необязателен и приходит `null` — акт бывает без пробега (прибор не работал), и ноль
 * вместо пустого значения дал бы «пробег с ТО» размером во всю жизнь машины (Р11а).
 *
 * Верхних границ у полей не потому, что кто-то напишет роман, а потому что текст без предела —
 * это `text` без предела: примечание длиннее страницы в форму не поместится и обратно не
 * прочитается.
 */
export const maintenanceInputSchema = z
  .object({
    performedOn: dateOnlySchema,
    odometerKm: z.number().int().nonnegative().nullable().default(null),
    documentNumber: z.string().trim().max(100).default(''),
    note: z.string().trim().max(1000).default(''),
    /** Скан акта; файлов может не быть — запись ведут и по бумажному документу. */
    fileIds: z.array(uuidSchema).max(20).default([]),
  })
  .strict();
export type MaintenanceInput = z.infer<typeof maintenanceInputSchema>;
/**
 * Тело со стороны портала: поля с умолчанием в нём необязательны — форма без скана и без номера
 * акта законна, и требовать от неё пустые строки значило бы описывать умолчание дважды.
 */
export type MaintenanceBody = z.input<typeof maintenanceInputSchema>;

/**
 * Правка — те же поля плюс версия, которую видел правящий (Р30). Версия в теле, а не в адресе:
 * PATCH и так идёт телом, и разносить два обязательных значения по разным местам незачем.
 */
export const maintenanceUpdateSchema = maintenanceInputSchema.extend({ version: versionSchema });
export type MaintenanceUpdateInput = z.infer<typeof maintenanceUpdateSchema>;
export type MaintenanceUpdateBody = z.input<typeof maintenanceUpdateSchema>;

/** Удаление — только версией: тела у DELETE нет, а удалять чужую правку вслепую нельзя (Р30). */
export const maintenanceVersionQuerySchema = z.object({ version: versionSchema }).strict();
export type MaintenanceVersionQuery = z.infer<typeof maintenanceVersionQuerySchema>;
