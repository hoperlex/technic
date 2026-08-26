import {
  ticketAuditEventsQuerySchema,
  type TicketAuditEventsQuery,
  type TicketAuditPeriod,
} from '@technic/contracts';

/**
 * Отбор ленты: что стоит в адресе, что уходит в ручку и что уносит выгрузка (§5.3, §4.3 плана).
 *
 * Отдельным модулем от строки ленты (`eventRows.ts`), потому что вопросы разные: здесь — «какие
 * события показывать», там — «как прочитать показанное». Разметка не читает адрес и не собирает
 * запрос: она получает готовый отбор и рисует его.
 *
 * ФИЛЬТРЫ ЖИВУТ В АДРЕСЕ, а не в состоянии компонента, — по той же причине, что период и экран
 * (ADR 0120): разбор промпта начинается со слов «посмотри, что модель делает с объёмом» и
 * заканчивается пересланной ссылкой. Ссылка, открывающая ленту без фильтров, показала бы
 * собеседнику не то, о чём речь, а «назад» после каждой правки фильтра уводила бы из окна.
 */

/**
 * Имена параметров адреса — те же, что у ручки (`ticketAuditEventsQuerySchema`).
 *
 * Совпадение намеренное: адрес окна и строка запроса описывают один и тот же отбор, и второе имя
 * для того же фильтра означало бы таблицу перевода, которую однажды забудут дополнить. Заодно
 * адрес читается глазами: `?ticketAudit=1&view=events&field=volumeM3` — ровно то, о чём спросят
 * сервер.
 *
 * Имена общие, а не с приставкой окна, и это безопасно ровно потому, что окно убирает за собой
 * именно их (`AUDIT_PARAMS`): под ним живёт реестр вывоза, и в адресе у него один ключ — `tab`.
 * Заведись у реестра своя `page`, разойтись им придётся здесь, а не в закрытии окна.
 */
export const FIELD_PARAM = 'field';
export const EVENT_PARAM = 'event';
export const MODEL_PARAM = 'model';
export const PROMPT_PARAM = 'promptVersion';
export const PREPROCESSING_PARAM = 'preprocessingVersion';
export const REQUEST_NUM_PARAM = 'requestNum';
export const PAGE_PARAM = 'page';

/** Всё, что лента пишет в адрес: окно обязано убрать за собой ровно эти ключи при закрытии. */
export const EVENTS_PARAMS: readonly string[] = [
  FIELD_PARAM,
  EVENT_PARAM,
  MODEL_PARAM,
  PROMPT_PARAM,
  PREPROCESSING_PARAM,
  REQUEST_NUM_PARAM,
  PAGE_PARAM,
];

/**
 * Отбор без периода и страницы: период у окна общий (его задаёт `useTicketAudit`), а страница —
 * не фильтр, а место в уже отобранном. Тип берётся из контракта вычитанием, а не переписывается
 * руками: новый фильтр ручки тогда сам становится ошибкой сборки здесь, а не тихо теряется.
 */
export type TicketAuditEventFilters = Omit<
  TicketAuditEventsQuery,
  'from' | 'to' | 'page' | 'pageSize'
>;

/** Пустой отбор: «все поля» и «поле не выбрано» — одно и то же, как и на сервере. */
export const NO_EVENT_FILTERS: TicketAuditEventFilters = {};

/** Первая страница. Числом, а не единицей в трёх местах: их разошлись бы при первой же правке. */
export const FIRST_PAGE = 1;

/**
 * Размер страницы ленты. Совпадает с умолчанием контракта и не выносится в адрес: страницу читают
 * глазами, а двести строк в окне 960 px — это прокрутка, а не чтение. Кому нужен весь отбор
 * целиком, тот берёт выгрузку, и она полная (§4.3).
 */
export const EVENTS_PAGE_SIZE = 50;

/**
 * Форма разбора, которой довольно чтению адреса.
 *
 * Структурным типом, а не типами zod: пакет схем — зависимость контрактов, а не портала, и импорт
 * `zod` в слое features завёл бы у фронта вторую копию правил разбора вместо одной, живущей в
 * контракте.
 */
interface Parses<T> {
  safeParse: (value: unknown) => { success: boolean; data?: T };
}

const shape = ticketAuditEventsQuerySchema.shape;

/**
 * Значение фильтра из адреса. Проверяется схемой КОНТРАКТА, а не глазами: адрес правят руками и
 * присылают в письмах, и `field=объём` или `promptVersion=-3` обязаны кончиться отсутствием
 * фильтра, а не запросом, который сервер отвергнет целиком.
 *
 * Порча одного ключа не роняет остальные: разбор поштучный. Разбирай мы весь объект разом, чужая
 * опечатка в одном параметре стирала бы все фильтры ссылки — и человек читал бы ленту не того
 * отбора, ничего об этом не зная.
 */
function fromAddress<T>(schema: Parses<T>, raw: string | null): T | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function readTicketAuditEventFilters(params: URLSearchParams): TicketAuditEventFilters {
  return {
    field: fromAddress(shape.field, params.get(FIELD_PARAM)),
    event: fromAddress(shape.event, params.get(EVENT_PARAM)),
    model: fromAddress(shape.model, params.get(MODEL_PARAM)),
    promptVersion: fromAddress(shape.promptVersion, params.get(PROMPT_PARAM)),
    preprocessingVersion: fromAddress(shape.preprocessingVersion, params.get(PREPROCESSING_PARAM)),
    requestNum: fromAddress(shape.requestNum, params.get(REQUEST_NUM_PARAM)),
  };
}

/**
 * Страница из адреса. Испорченная кончается первой, а не пустым экраном: `page=абв` из чужой
 * раскладки должен показать начало ленты, а не белый прямоугольник без объяснения.
 */
export function readTicketAuditEventsPage(raw: string | null): number {
  const parsed = shape.page.safeParse(raw ?? undefined);
  return parsed.success ? parsed.data : FIRST_PAGE;
}

/** Пустое значение стирает ключ, а не пишет пустую строку: `?model=` — это мусор в ссылке. */
function put(params: URLSearchParams, name: string, value: string | number | undefined): void {
  if (value === undefined || value === '') params.delete(name);
  else params.set(name, String(value));
}

/**
 * Записать отбор в адрес. Рядом с чтением намеренно: разъедься эти две функции именами ключей, и
 * ссылка перестала бы открывать то, что видел отправитель, — молча.
 */
export function writeTicketAuditEventFilters(
  params: URLSearchParams,
  filters: TicketAuditEventFilters,
): void {
  put(params, FIELD_PARAM, filters.field);
  put(params, EVENT_PARAM, filters.event);
  put(params, MODEL_PARAM, filters.model);
  put(params, PROMPT_PARAM, filters.promptVersion);
  put(params, PREPROCESSING_PARAM, filters.preprocessingVersion);
  put(params, REQUEST_NUM_PARAM, filters.requestNum);
}

/** Выбран ли хоть один фильтр: от этого зависит только кнопка сброса — показывать её всегда незачем. */
export function hasEventFilters(filters: TicketAuditEventFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== '');
}

/**
 * Запрос к ручке: период окна, отбор из адреса и страница.
 *
 * Собирается в одном месте, потому что спрашивают им дважды — экран и выгрузка (§4.3). Разойдись
 * они хоть одним ключом, человек уносил бы файл не того отбора, который читал на экране, и узнать
 * об этом было бы неоткуда.
 */
export function ticketAuditEventsRequest(
  period: TicketAuditPeriod,
  filters: TicketAuditEventFilters,
  page: number,
): TicketAuditEventsQuery {
  return { ...filters, from: period.from, to: period.to, page, pageSize: EVENTS_PAGE_SIZE };
}

/**
 * Подпись рядом с кнопкой выгрузки. Стоит на экране постоянно, а не прячется в подсказку: файл
 * уносит из портала адреса площадок и фамилии тех, кто правил, — человек должен понимать, что
 * забирает, и знать, что это записано (§4.3).
 */
export const EVENTS_EXPORT_NOTE =
  'В файл идут адреса площадок и фамилии — выгрузка записывается в журнал. ' +
  'Период не длиннее 92 дней и не больше 50 000 строк: не уместилось — сузьте отбор.';
