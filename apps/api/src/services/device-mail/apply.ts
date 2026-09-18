import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  COMPONENT_NONE,
  isIdentifyingKind,
  normalizeIdentityValue,
  parsedDeviceMessageSchema,
  type DeviceEventInput,
  type DeviceIdentityKind,
  type DeviceMailBindResultDto,
  type DeviceMessageStatus,
  type DeviceObservationInput,
  type ParsedDeviceMessage,
  type TelemetrySource,
} from '@technic/contracts';
import { db } from '../../db/client';
import {
  deviceEvents,
  deviceMailIdentities,
  deviceMailMessages,
  deviceObservations,
  officeEquipment,
} from '../../db/schema';
// Номера событий считает разборный слой — одной функцией на горячий разбор и на применение снимка.
import { assignEventOrdinals } from './normalize';
// Соответствие «исход резолва → статус письма» тоже объявлено один раз, и объявлено рядом с самим
// резолвом: две копии этого правила разошлись бы на первом же новом исходе.
import { deviceMessageStatusForIdentity, type DeviceIdentityResolution } from './identity';

/**
 * Запись нормализованной телеметрии и применение снимка разбора (план
 * `docs/office-equipment-mail-telemetry-plan.md`, Р20, Р21, Р22, Р33).
 *
 * ЭТО ВХОД И ДЛЯ КОЛЛЕКТОРА ЭТАПА 2, поэтому у него на входе `source` и `sourceRef`, а не «письмо»
 * (Р4). Граница источника проходит по `source` и дальше не видна: ниже этого слоя ни блок карточки,
 * ни будущие месячные дельты про почту не знают вовсе. Функция, принимающая `mailMessageId` вместо
 * пары «источник плюс ссылка», закрыла бы коллектору вход в собственную таблицу — а это
 * единственное обязательство Этапа 1 перед Этапом 2.
 *
 * НАБЛЮДЕНИЯ ПИШУТСЯ ТОЛЬКО ПРИ ОДНОЗНАЧНОЙ ПРИВЯЗКЕ (Р20), и держит это не проверка, а тип:
 * `equipmentId` обязателен, взять его неоткуда, кроме исхода `matched`. Разбор непривязанного
 * письма лежит снимком `parsed_payload` в строке письма и попадает сюда, когда человек привяжет
 * аппарат.
 *
 * ПОВТОР НЕ УДВАИВАЕТ РЯД. Уникальность — `(source, source_ref, metric_code, component)` у
 * наблюдений и `(source, source_ref, event_code, ordinal)` у событий; повторное применение того же
 * источника молча ничего не добавляет. Ключ по письму отвергнут планом: у коллектора письма нет по
 * определению, а повтор его пачки после таймаута удвоил бы месячную дельту.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ЖИВЁТ ПРАВИЛОМ «КОДЫ МЕТРИК И СОБЫТИЙ — APPEND-ONLY» (Р20). Снимок читается
 * схемой контракта (`parsedDeviceMessageSchema`), то есть нынешними перечислениями, — и это
 * единственная сверка, которая здесь остаётся. Держится она ровно на том, что код из реестра не
 * исчезает: переименование кода — таблица переноса в миграции, а не тихая замена строки в
 * контрактах. Сними код — и снимок, разобранный полгода назад правильно, перестанет читаться, а
 * кнопка «привязать» тихо ничего не сделает у самых старых писем очереди, где сырья уже нет.
 * Единицу с реестром метрик здесь не сверяет никто и ничто: эта сверка живёт на горячем разборе.
 */

/** Транзакция drizzle: ровно то, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Пул тоже годится там, где транзакция не обязательна: одна вставка атомарна сама по себе. */
type Writer = typeof db | Tx;

export interface DeviceTelemetryWriteResult {
  observations: number;
  events: number;
}

export interface DeviceTelemetryApplyInput {
  /** Только однозначно опознанный аппарат: `NOT NULL` в обеих таблицах — это Р20 значением. */
  equipmentId: string;
  source: TelemetrySource;
  /** Что данные принесло: строка письма, пачка коллектора, сам ручной ввод. */
  sourceRef: string;
  /**
   * Момент приёма порталом (Р21). Задаётся снаружи, а не берётся `now()`: применение снимка через
   * месяц обязано лечь тем временем, когда письмо приехало, — иначе пакетное перечитывание
   * выстроило бы весь архив в одну секунду и порядок ряда потерялся бы.
   */
  observedAt: Date;
  /** Ссылка на строку письма — только у почты. У коллектора её нет и быть не может. */
  mailMessageId?: string | null;
  observations: readonly DeviceObservationInput[];
  events: readonly DeviceEventInput[];
}

function toDate(value: string | null | undefined): Date | null {
  return typeof value === 'string' && value !== '' ? new Date(value) : null;
}

/**
 * Разрез, приведённый к значению: пустая строка означает «разреза нет» и означает это ЗНАЧЕНИЕМ
 * (Р33). `NULL` здесь снял бы уникальный ключ у всей группы счётчиков разом.
 */
function componentOf(row: DeviceObservationInput): string {
  return row.component ?? COMPONENT_NONE;
}

/*
 * Порядковый номер вхождения кода внутри одного источника (Р33) считает ОДНА функция на весь слой —
 * `assignEventOrdinals` из `normalize.ts`. Своя копия здесь была бы вторым носителем одного
 * правила: горячий разбор кладёт номера в снимок, применение снимка считает их заново, и разойдись
 * эти две реализации — двойное нажатие «привязать» удвоило бы ленту аварий, оставив счётчики
 * целыми. Отдельного поля у `deviceEventInputSchema` нет, и заводить его «под себя» посреди волны
 * нельзя: контракт заморожен, предложение уехало отчётом пакета.
 */

/**
 * Наблюдения, приведённые к ключу: два ряда с одной парой «метрика плюс разрез» внутри одного
 * источника неразличимы по определению ключа, и второй из них не запишется никогда. Гасим его
 * здесь, а не в базе, чтобы `ON CONFLICT` отвечал только за ПОВТОРНОЕ применение, а не за форму
 * самого снимка.
 */
function dedupeObservations(rows: readonly DeviceObservationInput[]): DeviceObservationInput[] {
  const seen = new Set<string>();
  const kept: DeviceObservationInput[] = [];
  for (const row of rows) {
    const key = `${row.metricCode}|${componentOf(row)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

/**
 * Почему письмо нельзя записать в принципе — словами, либо `null`, если можно.
 *
 * Сегодня причина одна: отрицательное число. Контракт минус больше не допускает (регулярное
 * выражение ужесточено правкой по этой же волне), но снимок применяется КАК ЕСТЬ и может быть
 * старше ужесточения — то есть лежать с минусом, который тогдашняя схема пропускала. В базе такое
 * значение встречает `device_observations_value_check`, и встречает его ошибкой целостности
 * посреди транзакции.
 *
 * СПРАШИВАТЬ ЭТО НАДО ДО ЗАПИСИ, а не ловить после. Привязка по опознающему ключу применяет
 * ДВАДЦАТЬ писем одной транзакцией: отказ на девятнадцатом откатил бы и восемнадцать хороших —
 * ровно «пачку чужих писем заодно». Поэтому вызывающий спрашивает причину заранее и откладывает
 * одно письмо (`skippedMessages`), а не теряет пачку.
 */
export function unapplicableSnapshotReason(
  observations: readonly DeviceObservationInput[],
): string | null {
  for (const row of observations) {
    if (row.value.startsWith('-')) {
      return `отрицательное значение «${row.value}» у метрики ${row.metricCode}`;
    }
  }
  return null;
}

/**
 * Пишет наблюдения и события одного источника. Возвращает, сколько рядов ЛЕГЛО, — повтор вернёт
 * нули, и это законный ответ, а не ошибка.
 *
 * ЕДИНИЦА СНИМКА С РЕЕСТРОМ ЗДЕСЬ НЕ СВЕРЯЕТСЯ, и это Р20 буквально: сверка живёт на горячем
 * разборе. Пополнение словаря иначе превращало бы правильно разобранное письмо в ошибочное ровно
 * в той очереди, которая лежит дольше всех, — а сырья старше тридцати дней уже нет.
 */
export async function applyDeviceTelemetry(
  writer: Writer,
  input: DeviceTelemetryApplyInput,
): Promise<DeviceTelemetryWriteResult> {
  const mailMessageId = input.mailMessageId ?? null;
  const observations = dedupeObservations(input.observations);

  // Прямому писателю (горячий разбор, коллектор, ручной ввод) отказ приходит исключением: у него
  // на руках одно письмо или одна пачка, и молчаливая запись «сколько получилось» была бы хуже
  // громкого отказа — исход письма именно так и становится `failed`. Применение снимка пачкой
  // сюда с такой строкой не приходит вовсе: оно спрашивает `unapplicableSnapshotReason` раньше.
  const refusal = unapplicableSnapshotReason(observations);
  if (refusal) throw new Error(`телеметрия: ${refusal}`);

  let written = 0;
  if (observations.length > 0) {
    const rows = await writer
      .insert(deviceObservations)
      .values(
        observations.map((row) => ({
          equipmentId: input.equipmentId,
          metricCode: row.metricCode,
          component: componentOf(row),
          value: row.value,
          unit: row.unit,
          observedAt: input.observedAt,
          deviceTime: toDate(row.deviceTime),
          source: input.source,
          sourceRef: input.sourceRef,
          mailMessageId,
          rawLabel: row.rawLabel ?? '',
        })),
      )
      .onConflictDoNothing({
        target: [
          deviceObservations.source,
          deviceObservations.sourceRef,
          deviceObservations.metricCode,
          deviceObservations.component,
        ],
      })
      .returning({ id: deviceObservations.id });
    written = rows.length;
  }

  let eventsWritten = 0;
  const events = assignEventOrdinals(input.events);
  if (events.length > 0) {
    const rows = await writer
      .insert(deviceEvents)
      .values(
        events.map((event) => ({
          equipmentId: input.equipmentId,
          eventCode: event.eventCode,
          severity: event.severity,
          observedAt: input.observedAt,
          deviceTime: toDate(event.deviceTime),
          source: input.source,
          sourceRef: input.sourceRef,
          ordinal: event.ordinal,
          mailMessageId,
          vendorCode: event.vendorCode ?? '',
          text: event.text ?? '',
        })),
      )
      .onConflictDoNothing({
        target: [
          deviceEvents.source,
          deviceEvents.sourceRef,
          deviceEvents.eventCode,
          deviceEvents.ordinal,
        ],
      })
      .returning({ id: deviceEvents.id });
    eventsWritten = rows.length;
  }

  return { observations: written, events: eventsWritten };
}

// ── Исход разбора одного письма ──

export interface ResolvedDeviceMessageInput {
  messageId: string;
  /** Момент приёма порталом: он и становится `observed_at` всего, что письмо принесло (Р21). */
  receivedAt: Date;
  snapshot: ParsedDeviceMessage;
  resolution: DeviceIdentityResolution;
}

export interface ResolvedDeviceMessageOutcome {
  status: DeviceMessageStatus;
  equipmentId: string | null;
  observations: number;
  events: number;
}

/**
 * Записывает исход разбора одного письма: снимок в строку, статус по исходу резолва и — ТОЛЬКО при
 * однозначной привязке — наблюдения с событиями.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ПЯТЬ СТРОК В РУЧКЕ ПРИЁМА. Здесь стоит единственная дверь, за
 * которой `ambiguous` мог бы превратиться в запись: «кандидатов двое, возьмём первого» — это одна
 * правдоподобная строка, и написать её в маршруте некому будет запретить. Пока решение живёт здесь,
 * оно проверяемо db-тестом и ломается громко. Ни одна карточка при `unmatched` и `ambiguous` не
 * трогается, `equipment_id` письма остаётся пустым, а разобранное лежит снимком и ждёт человека.
 *
 * Снимок пишется в строку и при однозначной привязке тоже: перечитывание и спор «почему так
 * разобралось» работают от него, а не от сырья, которого через тридцать дней нет.
 */
export async function applyResolvedDeviceMessage(
  tx: Tx,
  input: ResolvedDeviceMessageInput,
): Promise<ResolvedDeviceMessageOutcome> {
  const status = deviceMessageStatusForIdentity(input.resolution);
  const equipmentId = input.resolution.status === 'matched' ? input.resolution.equipmentId : null;
  const observations = dedupeObservations(input.snapshot.observations);

  let written: DeviceTelemetryWriteResult = { observations: 0, events: 0 };
  if (equipmentId) {
    written = await applyDeviceTelemetry(tx, {
      equipmentId,
      source: 'email',
      sourceRef: input.messageId,
      observedAt: input.receivedAt,
      mailMessageId: input.messageId,
      observations: input.snapshot.observations,
      events: input.snapshot.events,
    });
  }

  await tx
    .update(deviceMailMessages)
    .set({
      equipmentId,
      status,
      profileCode: input.snapshot.profileCode,
      parserVersion: input.snapshot.parserVersion,
      parsedPayload: input.snapshot,
      // Счётчики — СОДЕРЖИМОЕ снимка, а не число легших рядов: у непривязанного письма рядов нет
      // вовсе, а очередь обязана показать, сколько наблюдений ждёт применения.
      observationCount: observations.length,
      eventCount: input.snapshot.events.length,
      parsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deviceMailMessages.id, input.messageId));

  return { status, equipmentId, ...written };
}

// ── Применение снимка ──

/**
 * Статусы, из которых письмо уходит в применение. Только эти два: `parsed` уже применено, а
 * `failed`, `unrecognized` и `ignored` применять нечего — снимка у них нет.
 */
const APPLICABLE_STATUSES = ['unmatched', 'ambiguous'] as const;

export interface DeviceMailBindCommand {
  /**
   * Строка очереди, на которой нажали: она применяется всегда, каким бы ни был род ключа.
   *
   * `null` — ключ завели из карточки аппарата, письма под рукой нет вовсе (план
   * `docs/office-equipment-mail-identity-ui-plan.md`, §6.1). Тогда применяется только пачка по
   * опознающему ключу, а у ключа-адреса не применяется ничего: у него пачки нет по определению, и
   * «применить нечего» — законный исход, а не отказ.
   */
  messageId: string | null;
  equipmentId: string;
  kind: DeviceIdentityKind;
  /** Значение ключа как его увидел человек; нормализует сервер той же функцией, что и резолв. */
  value: string;
  note?: string;
  /** Кто подтвердил. `null` — привязку завёл не человек (прогон, восстановление). */
  confirmedBy?: string | null;
}

/**
 * Итог привязки. Отдельного типа поверх DTO больше нет: поле о пропущенных письмах переехало в сам
 * контракт (`skippedMessages`), потому что показывать их обязан экран, а не только журнал —
 * письмо, отобранное и не применённое, остаётся в очереди, и человек должен знать, что разбор
 * неполон.
 */
export type DeviceMailBindOutcome = DeviceMailBindResultDto;

/** Поле подсказки, по которому письмо ищется пачкой. Только опознающие рода (Р20). */
const HINT_FIELD: Partial<Record<DeviceIdentityKind, string>> = {
  serial: 'serial',
  inventory: 'inventory',
  deviceName: 'deviceName',
};

/**
 * Нормализация подсказки из снимка — ТА ЖЕ, что у `normalizeIdentityValue`, и та же, что у
 * уникальных индексов номеров карточки: `upper(btrim(...))` и больше ничего. Считай её иначе, и
 * пачка не найдёт писем, которые резолв нашёл бы сам.
 *
 * ВНУТРЕННИЕ ПРОБЕЛЫ НЕ СХЛОПЫВАЮТСЯ — ни здесь, ни в контракте. У номера вида `3282 Z920584`,
 * склеенного при заводе карточки из разорванной строки учёта, схлопывание дало бы значение,
 * которого нет ни в индексе, ни в привязке.
 *
 * А `regexp_replace`, стоявший здесь до правки, схлопывал не пробелы, а БУКВУ «s»: в шаблоне JS
 * `\s` — это просто `s`, и для Postgres выражение приезжало строкой `s+`. Имя устройства вида
 * `ricoh-sales-214` превращалось в `RICOH- ALE -214`, не совпадало ни с чем, и привязка по
 * опознающему ключу применяла одну строку вместо двадцати — молча, потому что отбор просто
 * возвращал меньше.
 */
/**
 * Какие письма берёт привязка: нажатую строку, пачку по опознающему ключу или обе. `null` —
 * брать нечего вовсе (ключ завели из карточки, а род не опознающий).
 *
 * Одной функцией на применение и на предварительный счёт: второй отбор, написанный по своему
 * разумению, показывал бы человеку одно число, а применял бы другое.
 */
function pickedMessages(messageId: string | null, batch: SQL | undefined): SQL | undefined | null {
  if (messageId && batch) return or(eq(deviceMailMessages.id, messageId), batch);
  if (messageId) return eq(deviceMailMessages.id, messageId);
  return batch ?? null;
}

function normalizedHintSql(field: string) {
  return sql`upper(btrim(${deviceMailMessages.parsedPayload} -> 'identity' ->> ${field}))`;
}

/**
 * Привязка «ключ → карточка» и применение накопленных снимков — ОДНОЙ транзакцией (Р20).
 *
 * ПАЧКОЙ ПРИМЕНЯЮТСЯ ТОЛЬКО ОПОЗНАЮЩИЕ КЛЮЧИ — серийный, инвентарный, имя устройства. По адресу
 * отправителя или получателя применяется ровно одна строка, та, на которой нажали: ИТ-служба
 * сплошь и рядом прописывает парку один служебный адрес, и пачка по нему одним нажатием приписала
 * бы сотни писем разных аппаратов одной карточке — мгновенно и без отката.
 *
 * КАЖДОЕ ПИСЬМО ПРИМЕНЯЕТ СВОЙ СНИМОК. Формулировка «применить снимок ко всем письмам» читается и
 * как «записать данные одного письма от имени сотни», и такой реализации здесь не заказывали:
 * `sourceRef` у каждого письма свой, и данные каждого — свои.
 */
export async function bindDeviceMailIdentityTx(
  tx: Tx,
  command: DeviceMailBindCommand,
): Promise<DeviceMailBindOutcome> {
  const value = normalizeIdentityValue(command.value);
  if (value === '') throw new Error('привязка: пустое значение ключа');

  const [equipment] = await tx
    .select({ id: officeEquipment.id })
    .from(officeEquipment)
    .where(and(eq(officeEquipment.id, command.equipmentId), isNull(officeEquipment.deletedAt)));
  if (!equipment) throw new Error('привязка: карточка аппарата не найдена');

  // ── Сама привязка ──
  //
  // Уникальный индекс `(key_kind, key_value)` держит обещание «один ключ не может вести к двум
  // аппаратам». Повтор той же привязки — успех (человек нажал дважды), чужая — отказ словами: без
  // него ответом была бы ошибка целостности, то есть пятисотка вместо объяснения.
  const inserted = await tx
    .insert(deviceMailIdentities)
    .values({
      keyKind: command.kind,
      keyValue: value,
      equipmentId: command.equipmentId,
      confirmedBy: command.confirmedBy ?? null,
      note: command.note ?? '',
    })
    // Арбитр — ЧАСТИЧНЫЙ индекс (живые привязки), и условие обязано быть названо здесь дословно:
    // без `targetWhere` планировщик не выводит индекс вовсе и отвечает «нет ограничения под
    // ON CONFLICT», то есть пятисоткой на обычном повторном нажатии.
    .onConflictDoNothing({
      target: [deviceMailIdentities.keyKind, deviceMailIdentities.keyValue],
      // `where` у DO NOTHING — это предикат самого индекса, а не отбор строк.
      where: isNull(deviceMailIdentities.revokedAt),
    })
    .returning({ id: deviceMailIdentities.id });
  if (inserted.length === 0) {
    const [existing] = await tx
      .select({ equipmentId: deviceMailIdentities.equipmentId })
      .from(deviceMailIdentities)
      .where(
        and(
          eq(deviceMailIdentities.keyKind, command.kind),
          eq(deviceMailIdentities.keyValue, value),
          // Снятая привязка не спорит с новой: значение она освободила, и ключ вправе завести
          // другой аппарат — иначе снятие не отличалось бы от вечного запрета.
          isNull(deviceMailIdentities.revokedAt),
        ),
      );
    if (existing && existing.equipmentId !== command.equipmentId) {
      throw new Error('привязка: этот ключ уже ведёт к другому аппарату');
    }
  }

  // ── Кого применяем ──
  //
  // Нажатая строка — всегда, плюс пачка по подсказке снимка, если род ключа опознающий. Замок
  // `FOR UPDATE` берётся до чтения снимка: без него два одновременных нажатия применили бы одно
  // письмо дважды, а `ON CONFLICT` спас бы ряд наблюдений, но не счётчики в строке письма.
  const field = isIdentifyingKind(command.kind) ? HINT_FIELD[command.kind] : undefined;
  const batch = field ? sql`${normalizedHintSql(field)} = ${value}` : undefined;
  const picked = pickedMessages(command.messageId, batch);
  const messages = picked
    ? await tx
        .select({
          id: deviceMailMessages.id,
          receivedAt: deviceMailMessages.receivedAt,
          parsedPayload: deviceMailMessages.parsedPayload,
          parsedAt: deviceMailMessages.parsedAt,
        })
        .from(deviceMailMessages)
        .where(and(inArray(deviceMailMessages.status, [...APPLICABLE_STATUSES]), picked))
        .orderBy(asc(deviceMailMessages.receivedAt), asc(deviceMailMessages.id))
        .for('update')
    : [];

  const now = new Date();
  const outcome: DeviceMailBindOutcome = {
    appliedMessages: 0,
    observations: 0,
    events: 0,
    skippedMessages: 0,
  };
  for (const message of messages) {
    const snapshot = parsedDeviceMessageSchema.safeParse(message.parsedPayload);
    if (!snapshot.success) {
      outcome.skippedMessages += 1;
      continue;
    }
    // Непригодный снимок откладывается, а не роняет пачку: на девятнадцатом письме отказ унёс бы
    // и восемнадцать применённых. Строка остаётся в очереди, и человек видит по `skippedMessages`,
    // что разбор неполон.
    if (unapplicableSnapshotReason(snapshot.data.observations)) {
      outcome.skippedMessages += 1;
      continue;
    }
    const written = await applyDeviceTelemetry(tx, {
      equipmentId: command.equipmentId,
      source: 'email',
      sourceRef: message.id,
      observedAt: message.receivedAt,
      mailMessageId: message.id,
      observations: snapshot.data.observations,
      events: snapshot.data.events,
    });
    await tx
      .update(deviceMailMessages)
      .set({
        equipmentId: command.equipmentId,
        status: 'parsed',
        // Счётчики строки — это СОДЕРЖИМОЕ снимка, а не число только что легших рядов: повтор
        // применения кладёт ноль рядов, и счётчик, взятый оттуда, обнулил бы карточку письма.
        observationCount: dedupeObservations(snapshot.data.observations).length,
        eventCount: snapshot.data.events.length,
        // `parsed_at` — момент РАЗБОРА, и привязка его не переписывает: разобрано письмо было
        // тогда, а не сейчас. Пустой он у писем, доехавших до снимка мимо этой отметки.
        parsedAt: message.parsedAt ?? now,
        // Закрывающий след очереди. Обе колонки или ни одной — этого требует проверка схемы.
        reviewedBy: command.confirmedBy ?? null,
        reviewedAt: command.confirmedBy ? now : null,
        updatedAt: now,
      })
      .where(eq(deviceMailMessages.id, message.id));
    outcome.appliedMessages += 1;
    outcome.observations += written.observations;
    outcome.events += written.events;
  }
  return outcome;
}

/** Та же привязка, но со своей транзакцией: «одной транзакцией» — обещание плана, а не вызова. */
export async function bindDeviceMailIdentity(
  command: DeviceMailBindCommand,
): Promise<DeviceMailBindOutcome> {
  return db.transaction(async (tx) => bindDeviceMailIdentityTx(tx, command));
}

/**
 * Сколько накопленных писем затронет привязка — до подтверждения (Р20: «перед подтверждением
 * человеку показывается, сколько писем будет затронуто»).
 *
 * Считает тем же отбором, что и применение. Второй отбор, написанный экраном по своему разумению,
 * показывал бы человеку одно число, а применял бы другое.
 */
export async function countBindTargets(
  reader: Writer,
  command: Pick<DeviceMailBindCommand, 'messageId' | 'kind' | 'value'>,
): Promise<number> {
  const value = normalizeIdentityValue(command.value);
  const field = isIdentifyingKind(command.kind) ? HINT_FIELD[command.kind] : undefined;
  const batch = field && value !== '' ? sql`${normalizedHintSql(field)} = ${value}` : undefined;
  const picked = pickedMessages(command.messageId, batch);
  if (!picked) return 0;
  const rows = await reader
    .select({ count: sql<number>`count(*)::int` })
    .from(deviceMailMessages)
    .where(and(inArray(deviceMailMessages.status, [...APPLICABLE_STATUSES]), picked));
  return rows[0]?.count ?? 0;
}
