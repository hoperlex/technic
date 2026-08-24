import {
  serviceConsumableIssueIssue,
  type ServiceConsumableIssueInput,
  type ServiceRequestConsumableDto,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';

/**
 * Строки расходников на экране (Н9, Р3): что просили, что выдали и почему разошлось.
 *
 * Модель одна на два окна — закрытие работ и правку факта (Р6), — потому что величина у них одна и
 * та же: «сколько числится выданным по строке». Разводить её по двум фичам значило бы завести две
 * копии правила «расхождение объясняется причиной» и разойтись с сервером на первой же правке.
 *
 * Самого правила здесь нет вовсе: его считает `serviceConsumableIssueIssue` контрактов — та же
 * функция, которой отвечает маршрут и которую повторяет `CHECK` в базе. Здесь — только сборка
 * строк, разница со списанным и текст отказа.
 */
export interface ConsumableFactRow {
  /** Идентификатор СТРОКИ заявки, а не позиции справочника: им адресуется правка факта. */
  id: string;
  code: string;
  name: string;
  /** Цвет — свойство позиции (Р9): у цветной серии по позиции на цвет, у чёрно-белой пусто. */
  color: string | null;
  requestedQuantity: number;
  /** Что числится выданным на сервере: `null` — работу ещё не закрывали, и склад не двигали. */
  savedQuantity: number | null;
  savedNote: string;
  /**
   * Что стоит в поле сейчас. `null` — поле очистили руками: отправлять такую строку нельзя, у
   * ручки пустого значения нет вовсе (`serviceConsumableIssueSchema`).
   */
  issuedQuantity: number | null;
  issueNote: string;
}

/**
 * Умолчание факта — «сколько просили», и подставляет его ФОРМА, а не сервер (Р3): списывать со
 * склада по молчанию клиента он не должен и отвечает 422 «нет отметки о выдаче». Уже проставленный
 * факт умолчанием не перебивается — правку открывают, чтобы поправить его, а не завести заново.
 */
export function consumableFactRows(
  lines: readonly ServiceRequestConsumableDto[],
): ConsumableFactRow[] {
  return lines.map((line) => ({
    id: line.id,
    code: line.code,
    name: line.name,
    color: line.color,
    requestedQuantity: line.requestedQuantity,
    savedQuantity: line.issuedQuantity,
    savedNote: line.issueNote,
    issuedQuantity: line.issuedQuantity ?? line.requestedQuantity,
    issueNote: line.issueNote,
  }));
}

/**
 * Насколько правка двинет склад. Событие журнала пишется на **разницу**, а не на всё количество
 * (Р6): было выдано 2, стало 3 — со склада уйдёт одна штука, а не три. Это и есть то, что окно
 * правки обязано сказать словами.
 */
export function consumableFactDelta(row: ConsumableFactRow): number {
  return (row.issuedQuantity ?? 0) - (row.savedQuantity ?? 0);
}

/** Строку тронули: либо число другое, либо объяснение. Непотроганные правка не шлёт вовсе. */
export function consumableFactTouched(row: ConsumableFactRow): boolean {
  return row.issuedQuantity !== row.savedQuantity || row.issueNote.trim() !== row.savedNote.trim();
}

/**
 * Что мешает отправить отметку. Правило расхождения берётся у контрактов целиком — своей копии
 * портал не заводит: разойдись они, человек узнавал бы об обязательной причине из 422 после
 * нажатия, а не до него.
 */
export function consumableFactIssue(rows: readonly ConsumableFactRow[]): string | null {
  for (const row of rows) {
    if (row.issuedQuantity == null) return `Укажите, сколько выдали: ${row.name}`;
    const issue = serviceConsumableIssueIssue({
      requestedQuantity: row.requestedQuantity,
      issuedQuantity: row.issuedQuantity,
      issueNote: row.issueNote,
    });
    if (issue) return `${row.name}: ${issue}`;
  }
  return null;
}

/** Тело отметки: строки заявки с фактом. Пустое число сюда не попадает — его отсёк `…Issue`. */
export function consumableFactPayload(
  rows: readonly ConsumableFactRow[],
): ServiceConsumableIssueInput[] {
  return rows
    .filter((row) => row.issuedQuantity != null)
    .map((row) => ({
      id: row.id,
      issuedQuantity: row.issuedQuantity!,
      issueNote: row.issueNote.trim(),
    }));
}

/** Тело правки факта: только тронутые строки — `PATCH` состава заявки не касается (Р6). */
export function consumableFactChanges(
  rows: readonly ConsumableFactRow[],
): ServiceConsumableIssueInput[] {
  return consumableFactPayload(rows.filter(consumableFactTouched));
}

/**
 * Подпись позиции: наименование, цвет и код номенклатуры. Цвет стоит рядом с именем, потому что
 * различает позиции (Р9) — «Тонер 201» голубой и чёрный это разные коды и разные остатки, — а код
 * читают, когда сверяют со счётом.
 */
export function consumableLabel(line: {
  name: string;
  code: string;
  color?: string | null;
}): string {
  return [line.name, line.color, line.code].filter(Boolean).join(' · ');
}

/**
 * Текст отказа сервера — как он есть. Нехватка остатка приходит 422 с готовым предложением
 * («Тонер Ricoh 201 (Д0000093569): на складе 1, выдаётся 2. Исправьте выданное количество или
 * пополните остаток», Р7): в нём названы позиция, остаток и выход, и подменять его общим «не
 * удалось сохранить» значит отобрать у человека всё, ради чего сервер это писал.
 *
 * Своей веткой, а не общим `errorMessage`: тот дописывает к тексту имена полей из `fields`, и
 * готовое предложение получало бы бессмысленный хвост «: consumables». У пятисотки поведение
 * остаётся общим — там текста по делу нет, а есть номер обращения.
 */
export function consumableFailureText(error: unknown): string {
  if (isApiError(error) && error.status < 500 && error.message) return error.message;
  return errorMessage(error);
}
