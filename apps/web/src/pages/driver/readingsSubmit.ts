import {
  readingInputSchema,
  type DriverPreviousReading,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemDto,
  type ReportItemSubmit,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';
import { parseReadingNumber, readingWarnings } from '@entities/vehicle-reading';
import type { DraftItem } from './api';
import { emptyItem, sourceKey } from './readingsDraft';

/**
 * Тело отправки показаний: что уходит на сервер и что вместо этого показывается отказом на блоке
 * (ADR 0103; план кабинета водителя, Р6).
 *
 * Отдельным модулем от страницы по той же причине, что и `readingsDraft`: вместе они переваливают
 * за 400 строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь чистая
 * проверка введённого, там — запись черновика, сеть и порядок шагов при отказе.
 */

/** Что вышло из блока: строка отправки, отказы по полям или «эта строка отправке не подлежит». */
type BuiltItem = { submit: ReportItemSubmit } | { errors: Record<string, string> } | { skip: true };

/** Сообщения схемы — по именам полей блока: их и подсвечивает форма. */
function issueMessages(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const result: Record<string, string> = {};
  for (const issue of issues) result[String(issue.path[0] ?? 'form')] = issue.message;
  return result;
}

/**
 * Строка отправки: показание, вновь загруженные файлы и подтверждение показанных аномалий.
 *
 * Флаг один на оба счётчика намеренно: подтверждают не «одометр» и «моточасы» по отдельности, а
 * показанное предупреждение целиком — и сервер применяет подтверждение только там, где аномалия
 * действительно есть.
 */
function submitItem(itemId: string, reading: ReadingInput, value: DraftItem): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: value.files.map((file) => file.id),
    confirmOdometerAnomaly: value.confirmAnomaly,
    confirmEngineHoursAnomaly: value.confirmAnomaly,
  };
}

/**
 * Собирает строку отправки либо ошибки блока: числа проверяет схема контракта, правдоподобие —
 * предупреждения при вводе (Р6). Вида `no_data` здесь больше нет: строку без показаний закрывает
 * только персонал (Р4), и сервер отправку водителя с таким видом отклоняет.
 */
function buildItem(
  item: ReportItemDto,
  value: DraftItem,
  previous: DriverPreviousReading | null,
): BuiltItem {
  const numbers = {
    odometerKm: parseReadingNumber(value.odometerKm),
    engineHours: parseReadingNumber(value.engineHours),
    fuelFilledLiters: parseReadingNumber(value.fuelFilledLiters),
  };
  const broken = Object.entries(numbers).filter(([, v]) => v === 'invalid');
  if (broken.length > 0)
    return { errors: Object.fromEntries(broken.map(([field]) => [field, 'Введите число'])) };

  // Строку, уже закрытую персоналом видом `no_data`, водитель не переоткрывает и пустой не
  // заполняет: иначе один блок без чисел — а чисел там и не бывает — не давал бы сдать весь день.
  const untouched = !value.odometerKm && !value.engineHours && !value.fuelFilledLiters;
  if (item.reading?.kind === 'no_data' && untouched) return { skip: true };

  // Грубое (вне абсолютных границ) отправку не пропускает вовсе: подтверждать опечатку в разряде
  // бессмысленно — её подтвердят так же, как набрали. Мягкое снимается галочкой: странное число
  // бывает правдой (Р6).
  const warnings = readingWarnings(numbers, previous);
  const hard = warnings.filter((w) => w.hard);
  if (hard.length > 0) return { errors: Object.fromEntries(hard.map((w) => [w.field, w.text])) };
  const soft = warnings.filter((w) => !w.hard);
  if (soft.length > 0 && !value.confirmAnomaly)
    return { errors: { [soft[0]!.field]: 'Подтвердите значение галочкой «Всё верно»' } };

  const parsed = readingInputSchema.safeParse({
    kind: 'values',
    ...numbers,
    comment: value.comment,
  });
  if (!parsed.success) return { errors: issueMessages(parsed.error.issues) };
  return { submit: submitItem(item.id, parsed.data, value) };
}

/**
 * Тело отправки по всем строкам отчёта — и отказы по блокам, если хоть один не прошёл. Отказы
 * возвращаются вместе со строками, а не вместо них: страница подсвечивает блок и приводит к
 * первому неправильному, а не показывает одно сообщение на весь день (ADR 0094).
 *
 * Значения адресуются источником — тем же ключом, что и черновик (Р11): `itemId` строки живёт
 * только в отчёте и переживает не всё.
 */
export function buildSubmitBody(
  report: DriverReportDto,
  values: Record<string, DraftItem>,
  previousOf: (item: ReportItemDto) => DriverPreviousReading | null,
): { items: ReportItemSubmit[]; errors: Record<string, Record<string, string>> } {
  const items: ReportItemSubmit[] = [];
  const errors: Record<string, Record<string, string>> = {};
  for (const item of report.items) {
    const built = buildItem(item, values[sourceKey(item)] ?? emptyItem(), previousOf(item));
    if ('submit' in built) items.push(built.submit);
    else if ('errors' in built) errors[item.id] = built.errors;
  }
  return { items, errors };
}

/** Что делать с неудачной отправкой: сказать словами, закрывать ли попытку и перечитывать ли день. */
export interface SubmitFailure {
  message: string;
  /** Исход назван сервером — попытка закрывается, следующая отправка получит свой ключ (Р12а). */
  settled: boolean;
  /** Строки разошлись с сервером: их надо перечитать, иначе следующая отправка даст тот же 409. */
  stale: boolean;
}

/**
 * Р12а различает «сервер сказал об исходе» и «ответа не было», и различие это не про вежливость: у
 * попытки, оставшейся `pending`, повтор уходит ТЕМ ЖЕ ключом и той же версией — иначе он станет
 * второй отправкой того же дня.
 *
 * Ответом самого API считается только отказ с кодом и статусом ниже 500: проверка, конфликт версий,
 * занятый ключ. Всё остальное исхода не называет — 502, 503 и 504 приходят от шлюза, за которым
 * транзакция API могла и закоммититься, а обрыв связи не приходит вовсе. Пятисотка самого API
 * читается тем же обрывом: отличить её от шлюзовой нечем, а размен очевиден — лишний повтор
 * идемпотентного ключа не стоит ничего, сервер отвечает на него текущим состоянием.
 */
export function submitFailure(e: unknown): SubmitFailure {
  const answered = isApiError(e) && e.status < 500 ? e : null;
  return {
    message: errorMessage(e),
    settled: answered !== null,
    // 409 — либо расхождение версий (состав дня успели изменить), либо тот же ключ с другим телом;
    // и то, и другое лечится одним: перечитать строки.
    stale: answered?.status === 409,
  };
}
