import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';
import type {
  OfficeEquipmentItemWarrantyDto,
  OfficeEquipmentMovementDto,
} from './office-equipment';
import type { RequestChangeDto } from './request-history';
import {
  projectByAudiencePolicy,
  type AudiencePolicy,
  type ServiceRequestAudience,
  type ServiceRequestKind,
  type ServiceRequestStatus,
  type WarrantyClaimSource,
} from './service-requests';

// ── История единицы оргтехники тремя бизнес-блоками (план
//    `docs/office-equipment-history-blocks-plan.md`, §4, Р1–Р5, Р8–Р10) ──
//
// Рядом с лентой (`office-equipment-history.ts`), а НЕ вместо неё. Лента остаётся каноническим
// аудитом: шесть источников, ни один не снят (§4, К2). Здесь — три read model поверх тех же
// таблиц, отвечающие на три разных вопроса: «что с аппаратом делали и чем кончилось», «кто и что
// поправил в карточке», «где стоял и почему уехал».
//
// ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ, а не строками в контрактах ленты. У блоков нет ни общего события, ни
// общего порядка, ни общего курсора с лентой: там размеченное объединение шести видов с номером
// вида в ключе сортировки, здесь — три плоские строки, у каждой своя пара «дата + идентификатор»
// (Н8). Сложенные в один файл, эти две модели через полгода начали бы делить утилиты, и «сумма
// ремонта видна не всем» пришлось бы держать в двух местах вместо одного.
//
// ПОЧЕМУ ТРИ ТИПА СТРОКИ, А НЕ ОДИН С ПОЛЕМ `block` (Р1). Одна форма ответа на четыре вопроса
// заставила бы портал разбирать размеченное объединение ради каждой вкладки, а сервер — держать
// четыре курсора одного вида. Это три read model, и называть их одной дороже, чем тремя.

/**
 * Размер страницы блока (§6). Двадцать, а не пятьдесят как у ленты: строка блока крупнее — у
 * заявки семь колонок с исполнителями и гарантиями, — и вкладку открывают, чтобы прочитать первые
 * строки, а не пролистать всё.
 */
export const EQUIPMENT_BLOCK_PAGE_SIZE = 20;
export const EQUIPMENT_BLOCK_MAX_PAGE_SIZE = 100;

export const equipmentBlockQuerySchema = z.object({
  // Потолок длины — как у курсора ленты: разбирать строку в килобайт незачем, а отказ по длине
  // дешевле отказа по разбору.
  cursor: z.string().max(400).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(EQUIPMENT_BLOCK_MAX_PAGE_SIZE)
    .optional()
    .default(EQUIPMENT_BLOCK_PAGE_SIZE),
});
export type EquipmentBlockQuery = z.infer<typeof equipmentBlockQuerySchema>;

/**
 * Страница блока. Форма одна на все три — общего у блоков ровно столько: строки, признак «есть ещё»
 * и курсор продолжения. Признак `serviceVisible` сюда НЕ переехал: у ленты он объясняет пустоту
 * одного из шести источников внутри общего потока, а у блоков право решает судьбу целой вкладки
 * (Р1, Р11) — без `serviceRequests.read` ручка заявок отвечает `403`, и объяснять внутри ответа
 * нечего.
 */
export interface EquipmentBlockPageDto<T> {
  items: T[];
  hasMore: boolean;
  /** Курсор следующей страницы; `null` — дальше ничего нет. */
  nextCursor: string | null;
}

// ── Блок «Связанные заявки» ──

/**
 * Чем кончилась заявка — НЕФИНАНСОВЫМ кодом (Р2, находка Н12).
 *
 * Кодом, а не собранной сервером фразой: собери мы «Принято, 12 500 ₽», а потом обнули только
 * `totalAmount`, сумма осталась бы в тексте и уехала бы заявителю мимо всей проекции. Поэтому итог
 * — перечень значений, подпись к нему берётся из словаря ниже, а деньги остаются единственным
 * отдельно проецируемым полем строки (Р5).
 */
export const EQUIPMENT_REQUEST_OUTCOMES = [
  'open',
  'awaiting_acceptance',
  'accepted',
  'cancelled',
  'replacement_recommended',
  'warranty_repair',
] as const;
export type EquipmentRequestOutcomeCode = (typeof EQUIPMENT_REQUEST_OUTCOMES)[number];

/**
 * Подписи итогов. Ни в одной нет ни суммы, ни знака валюты, ни слова «рублей» — и это требование
 * (§10.1, тест 8), а не стиль: подпись приходит вместе со скрытой суммой в одной строке.
 */
export const equipmentRequestOutcomeLabels: Record<EquipmentRequestOutcomeCode, string> = {
  open: 'Ещё идёт',
  awaiting_acceptance: 'Ждёт приёмки',
  accepted: 'Принята',
  cancelled: 'Отменена',
  replacement_recommended: 'Рекомендована замена',
  warranty_repair: 'Гарантийный ремонт',
};

export interface EquipmentRequestOutcomeDto {
  code: EquipmentRequestOutcomeCode;
  /** Подпись из словаря; сумму или валюту не содержит никогда (Н12). */
  label: string;
}

/**
 * Итог заявки по её реквизитам (Р2). Правило живёт в контрактах, а не в сервисе: тот же итог
 * рисует портал в секции карточки (Р7) и печатает выгрузка (Р12), и три копии приоритета
 * разошлись бы молча — первым же новым признаком закрытия.
 *
 * ПОРЯДОК ВЕТВЕЙ ЗНАЧИМ, и «решение отмены» стоит выше гарантии не для красоты: отменённая
 * гарантийная заявка с решением («меняем аппарат») обязана отвечать «Отменена», а не
 * «Гарантийный ремонт», — иначе строка рассказывала бы, по чьей гарантии обращались, вместо того
 * чтобы ответить, чем дело кончилось.
 */
export function equipmentRequestOutcomeOf(row: {
  status: ServiceRequestStatus;
  replacementRecommended: boolean;
  rejectionResolution: string;
  warrantyClaimSource: WarrantyClaimSource | null;
}): EquipmentRequestOutcomeDto {
  const code = outcomeCodeOf(row);
  return { code, label: equipmentRequestOutcomeLabels[code] };
}

function outcomeCodeOf(row: {
  status: ServiceRequestStatus;
  replacementRecommended: boolean;
  rejectionResolution: string;
  warrantyClaimSource: WarrantyClaimSource | null;
}): EquipmentRequestOutcomeCode {
  if (row.replacementRecommended) return 'replacement_recommended';
  if (row.rejectionResolution.trim() !== '') return 'cancelled';
  if (row.warrantyClaimSource !== null) return 'warranty_repair';
  switch (row.status) {
    case 'accepted':
      return 'accepted';
    case 'cancelled':
      return 'cancelled';
    // «Выполнена» — это ещё не итог: работу сдали, но заказчик её не принял, и разница между
    // «приняли» и «ждём приёмки» — ровно то, ради чего человек в этот столбец и смотрит.
    case 'done':
      return 'awaiting_acceptance';
    default:
      return 'open';
  }
}

/**
 * Сколько символов описания уходит в строку блока (Р2). Обрезка БЕЗ многоточия: хвост дорисует
 * портал, если решит, а в выгрузке многоточие внутри ячейки читалось бы как часть текста.
 */
export const EQUIPMENT_REQUEST_SUMMARY_LIMIT = 160;

/**
 * Краткое содержание заявки. Режется по кодовым точкам, а не по единицам UTF-16: `slice` на 160-м
 * символе разрубил бы суррогатную пару пополам и отдал бы в ячейку сломанный символ.
 */
export function equipmentRequestSummary(description: string): string {
  const text = description.trim();
  const points = [...text];
  return points.length <= EQUIPMENT_REQUEST_SUMMARY_LIMIT
    ? text
    : points.slice(0, EQUIPMENT_REQUEST_SUMMARY_LIMIT).join('');
}

/**
 * Одна заявка — одна строка (§1, К1). Ровно то, чего в ленте нет: там заявка занимает до четырёх
 * строк (событие плюс шаги `in_work`/`accepted`/`cancelled`, Н2), и у аппарата с десятью ремонтами
 * лента открывается сорока строками, где половина повторяет номер соседней.
 */
export interface EquipmentRequestRowDto {
  id: string;
  /** «СО-142» — тот же номер, что в реестре заявок и в ссылке на карточку (ADR 0074). */
  displayNumber: string;
  kind: ServiceRequestKind;
  /** Первые {@link EQUIPMENT_REQUEST_SUMMARY_LIMIT} символов описания, без хвоста. */
  summary: string;
  /**
   * Кто выполняет: контрагент-исполнитель первым, за ним поимённые (Р2). Строками, а не ссылками:
   * блок отвечает на вопрос «кто этим занимался», а переход к учётке исполнителя из истории
   * аппарата не нужен никому — за составом идут в саму заявку.
   */
  executors: string[];
  createdAt: string;
  /**
   * Дата последнего изменения (Н4) — `service_requests.updated_at`, то есть последняя ПРАВКА
   * заявки. Реплики обсуждения её не двигают (ADR 0141), и колонка называется именно так, чтобы не
   * обещать «последнюю активность», которой она не показывает (В2).
   */
  updatedAt: string;
  status: ServiceRequestStatus;
  outcome: EquipmentRequestOutcomeDto;
  /**
   * Сумма акта; `null` — либо её нет, либо не положено видеть (аудитория строки, Р5). Ноль сюда не
   * подставляется никогда: «починили бесплатно» и «сумму не показываем» — разные утверждения.
   */
  totalAmount: number | null;
  /**
   * Только ДЕЙСТВУЮЩИЕ сейчас гарантии позиций этой заявки (Р6, К5). Выдача, снятие и истечение
   * остаются событиями полной истории: строка заявки прошлого не восстанавливает.
   */
  warranties: OfficeEquipmentItemWarrantyDto[];
  /**
   * «Заявляли, что аппарат стоит не там, и до сих пор не разобрали» (план п. 12, Р8). Не деньги и
   * не значение справочника — факт о самой заявке, и читает его в первую очередь тот, кто аппарат
   * повезёт.
   */
  objectMismatch: boolean;
}

/**
 * Что видит заявитель в блоке «Связанные заявки» (ADR 0160; план п. 13, Р5).
 *
 * Карта, а не одиночная подстановка `totalAmount: null` в сервисе: `AudiencePolicy` требует
 * решения на КАЖДОЕ поле строки, и новое денежное поле (скидка, аванс, стоимость запчастей) не
 * скомпилируется, пока автор не скажет, кому оно видно. Одиночная замена была бы fail-open — ровно
 * тот класс ошибки, ради которого написан весь ADR 0160.
 *
 * Вход сюда — тот же самый неочевидный канал, что у секции карточки: открывает его
 * `officeEquipment.read`, которое у заказчика есть, а сумма ремонта стоит прямо в строке.
 */
export const EQUIPMENT_REQUEST_ROW_AUDIENCE = {
  id: 'all',
  displayNumber: 'all',
  kind: 'all',
  // Описание поломки написал сам заявитель: скрывать от него его же текст незачем. Сумму,
  // названную в нём словами, проекция не вычищает и не обещает.
  summary: 'all',
  executors: 'all',
  createdAt: 'all',
  updatedAt: 'all',
  status: 'all',
  // Итог нефинансовый по построению (Н12): подпись берётся из словаря, где нет ни одной цифры, —
  // поэтому он остаётся целым и не требует второй, «безденежной» формы.
  outcome: 'all',
  totalAmount: { requester: null },
  // Цен в гарантии нет ни одной, а обращаться по ней будет как раз заявитель.
  warranties: 'all',
  objectMismatch: 'all',
} satisfies AudiencePolicy<EquipmentRequestRowDto>;

/** Строка блока в объёме аудитории ЭТОЙ заявки (Р5): считается по строке, применяется к странице. */
export function projectEquipmentRequestRowForAudience(
  row: EquipmentRequestRowDto,
  audience: ServiceRequestAudience,
): EquipmentRequestRowDto {
  return projectByAudiencePolicy(row, audience, EQUIPMENT_REQUEST_ROW_AUDIENCE);
}

// ── Блок «Ручные правки» ──

/**
 * Поле синтезированной правки гарантии поставщика (Р3, закрывает Н7).
 *
 * `officeEquipmentDiff` намеренно выносит срок гарантии из `changes` и отдаёт отдельным полем —
 * иначе в ЛЕНТЕ одно действие дало бы две строки. Но блок «Ручные правки» отвечает на вопрос «что
 * правил человек», и срок гарантии — ровно такая правка: здесь он приводится к общей форме
 * `RequestChangeDto` и встаёт строкой блока. Двоения нет: это разные экраны с разными вопросами
 * (К5).
 *
 * Ключ поля объявлен константой, а не вписан строкой в сервисе: подписи полей держат два словаря —
 * `officeEquipmentFieldLabels` на сервере (выгрузка) и `fieldLabels` в портале, — и обоим нужен
 * один и тот же ключ, иначе на экране появится сырое имя поля.
 */
export const EQUIPMENT_WARRANTY_CHANGE_FIELD = 'warrantyUntil';

/**
 * Подпись строки, у которой подробностей не сохранилось (Р3, закрывает Н5). Одна на портал и
 * выгрузку: «правок не было» и «правки были, но подробностей нет» — разные утверждения, и второе
 * обязано звучать одинаково везде.
 */
export const EQUIPMENT_CHANGE_NO_DETAILS_LABEL = 'Правка без подробностей';

/**
 * Ручная правка карточки: что изменилось, кто и когда (Р3).
 *
 * ПУСТОЙ `changes` — ЭТО ЗНАЧЕНИЕ, а не пропуск. Записи аудита, сделанные до появления
 * `officeEquipmentDiff`, деталей не несут, и лента их пропускает молча (Н5). Блок их показывает
 * строкой {@link EQUIPMENT_CHANGE_NO_DETAILS_LABEL}: скрыв такую запись, экран утверждал бы «в
 * карточке нет ни одной правки» — а это неправда.
 *
 * Денег в блоке нет ни в одном поле, поэтому и проекции по аудиториям у него нет (Р5).
 */
export interface EquipmentChangeRowDto {
  id: string;
  at: string;
  /** `null` — правка сделана системой либо автор снесён (`actor_user_id` обнуляется). */
  actorName: string | null;
  changes: RequestChangeDto[];
}

// ── Блок «Перемещения» ──

/**
 * Строка перемещения = строка журнала (Р4): единственный из трёх блоков, где событие и строка
 * совпадают один в один — блок ничего к журналу не добавляет и ничего из него не прячет.
 *
 * ПСЕВДОНИМ, А НЕ КОПИЯ ПОЛЕЙ, и это решение. Второй список тех же четырнадцати полей разошёлся бы
 * с первым на первой же правке журнала — ровно так, как это чуть не случилось с уточнением
 * состояния и признаком подтверждения места (план п. 12,
 * `office-equipment-move-from-request-plan.md`, Р5 и Р8): пока их не было в журнальном DTO, блок
 * объявлял их сам, а с миграцией 0275 они пришли в `OfficeEquipmentMovementDto` — и расширение
 * стало пустым. Имя типа при этом остаётся своё: у ручки блока свой контракт, и назови её ответ
 * журнальным типом напрямую, следующее поле, нужное только блоку, снова уехало бы в чужой DTO.
 */
export type EquipmentMovementRowDto = OfficeEquipmentMovementDto;

export type EquipmentRequestsPageDto = EquipmentBlockPageDto<EquipmentRequestRowDto>;
export type EquipmentChangesPageDto = EquipmentBlockPageDto<EquipmentChangeRowDto>;
export type EquipmentMovementsPageDto = EquipmentBlockPageDto<EquipmentMovementRowDto>;

// ── Курсоры: у каждого блока свой ключ порядка и своя метка (Р8) ──
//
// Ключ порядка = дата, специфичная для блока, плюс `id` разрывом ничьей. Ни один блок не
// сортируется по полю, которое может измениться у уже показанной строки: заявки идут по
// `created_at`, а не по `updated_at`, именно поэтому — правка старой заявки перетасовала бы уже
// прочитанные страницы (§10.1, тест 5).
//
// КУРСОР РАЗМЕЧЕН ВИДОМ БЛОКА И ВЕРСИЕЙ, и это не украшение. У заявок и правок ключ одинаков по
// форме — «отметка времени плюс uuid», — и без метки курсор одной вкладки молча открыл бы другую с
// середины. Чужой курсор обязан быть НЕЧИТАЕМЫМ: ответ «ссылка на продолжение не читается —
// откройте заново» честнее молчаливой первой страницы.
//
// Текстом через `~`, а не base64: контракты живут и в браузере, и на сервере, а `btoa`/`Buffer`
// есть только в одном из двух. Скрывать в курсоре нечего — в нём нет ничего, кроме порядка, — зато
// читаемая строка видна глазами в логе, когда разбираются, почему страница вернула не то.

const CURSOR_SEPARATOR = '~';
const CURSOR_VERSION = 1;

/**
 * ТОЧНОСТЬ ОТМЕТКИ В КУРСОРЕ — ПОЛНАЯ ТОЧНОСТЬ БАЗЫ: шесть знаков долей секунды.
 *
 * `timestamptz` в PostgreSQL хранит микросекунды, а `Date` в JS заканчивается миллисекундой.
 * Курсор, собранный из `toISOString()`, оказывался МЛАДШЕ строки, которой принадлежал, и строгое
 * сравнение с границей выбрасывало соседей по той же миллисекунде с бо́льшим хвостом: страница
 * молча теряла строки — прямое нарушение К4 («страницы не теряют и не повторяют строк»). Поэтому
 * сервер печатает отметку прямо из базы (`to_char(..., 'US')`), а не из `Date`.
 *
 * ВЕРСИЯ КУРСОРА ПРИ ЭТОМ НЕ МЕНЯЕТСЯ, И ЭТО РЕШЕНИЕ. Новая версия сделала бы нечитаемыми курсоры
 * уже открытых вкладок, то есть отвечала бы `422` и «откройте заново» человеку, который просто
 * нажал «показать ещё». Обе точности — законный ISO, и схема разбора принимает их одинаково
 * (`z.string().datetime()` доли секунды не ограничивает); разницу отрабатывает сравнение в сервисе,
 * и вот по этому признаку оно её и узнаёт.
 *
 * Признак живёт РЯДОМ С КОДЕКОМ, а не в сервисе: «сколько знаков несёт отметка» — свойство формата
 * курсора, и решать его обязано то же место, которое курсор собирает.
 */
export function equipmentCursorInstantIsExact(at: string): boolean {
  return /\.\d{6}Z$/.test(at);
}

/**
 * Разбор payload'ов курсоров. Версия и метка блока — часть СХЕМЫ, а не проверка в коде: разбор
 * чужой строки обязан падать в одном месте и одинаково для всех трёх блоков.
 */
const requestsCursorPayload = z.object({
  v: z.literal(CURSOR_VERSION),
  block: z.literal('requests'),
  createdAt: z.string().datetime(),
  id: uuidSchema,
});
const changesCursorPayload = z.object({
  v: z.literal(CURSOR_VERSION),
  block: z.literal('changes'),
  at: z.string().datetime(),
  id: uuidSchema,
});
const movementsCursorPayload = z.object({
  v: z.literal(CURSOR_VERSION),
  block: z.literal('movements'),
  // Дата переезда — бизнес-дата, и порядок записи она не задаёт: два перемещения одного дня
  // различает только `created_at`, а совпадение и его — `id`. Отсюда тройка, а не пара.
  movedOn: dateOnlySchema,
  createdAt: z.string().datetime(),
  id: uuidSchema,
});

/**
 * Курсор наружу — непрозрачная строка, внутрь — ключ порядка без служебных полей: версию и метку
 * блока приписывает и проверяет сам кодек, и вызывающему не приходится повторять их в каждом
 * вызове (а значит, и ошибиться в них негде).
 */
export interface EquipmentRequestsCursor {
  createdAt: string;
  id: string;
}
export interface EquipmentChangesCursor {
  at: string;
  id: string;
}
export interface EquipmentMovementsCursor {
  movedOn: string;
  createdAt: string;
  id: string;
}

export function encodeEquipmentRequestsCursor(cursor: EquipmentRequestsCursor): string {
  return [CURSOR_VERSION, 'requests', cursor.createdAt, cursor.id].join(CURSOR_SEPARATOR);
}

/** Возвращает `null` на любом мусоре — включая курсор ленты и курсоры соседних блоков. */
export function decodeEquipmentRequestsCursor(raw: string): EquipmentRequestsCursor | null {
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 4) return null;
  const parsed = requestsCursorPayload.safeParse({
    v: Number(parts[0]),
    block: parts[1],
    createdAt: parts[2],
    id: parts[3],
  });
  return parsed.success ? { createdAt: parsed.data.createdAt, id: parsed.data.id } : null;
}

export function encodeEquipmentChangesCursor(cursor: EquipmentChangesCursor): string {
  return [CURSOR_VERSION, 'changes', cursor.at, cursor.id].join(CURSOR_SEPARATOR);
}

export function decodeEquipmentChangesCursor(raw: string): EquipmentChangesCursor | null {
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 4) return null;
  const parsed = changesCursorPayload.safeParse({
    v: Number(parts[0]),
    block: parts[1],
    at: parts[2],
    id: parts[3],
  });
  return parsed.success ? { at: parsed.data.at, id: parsed.data.id } : null;
}

export function encodeEquipmentMovementsCursor(cursor: EquipmentMovementsCursor): string {
  return [CURSOR_VERSION, 'movements', cursor.movedOn, cursor.createdAt, cursor.id].join(
    CURSOR_SEPARATOR,
  );
}

export function decodeEquipmentMovementsCursor(raw: string): EquipmentMovementsCursor | null {
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 5) return null;
  const parsed = movementsCursorPayload.safeParse({
    v: Number(parts[0]),
    block: parts[1],
    movedOn: parts[2],
    createdAt: parts[3],
    id: parts[4],
  });
  return parsed.success
    ? { movedOn: parsed.data.movedOn, createdAt: parsed.data.createdAt, id: parsed.data.id }
    : null;
}
