import {
  readingInputSchema,
  reportRequiresDriverTimes,
  type DriverAssignmentEntry,
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
import { stopsOf, type ShownStop } from './readingStops';
import { buildTimes, timeFields } from './readingsTimes';

/**
 * Тело отправки показаний: что уходит на сервер и что вместо этого показывается отказом на блоке
 * (ADR 0103; план кабинета водителя, Р6).
 *
 * Отдельным модулем от страницы по той же причине, что и `readingsDraft`: вместе они переваливают
 * за 400 строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь чистая
 * проверка введённого, там — запись черновика, сеть и порядок шагов при отказе.
 */

/**
 * Что вышло из блока: строка отправки, отказы по полям или «эта строка отправке не подлежит».
 *
 * У пропуска два разных повода, и различать их обязан не только автор кода: `closed` — строку
 * закрыл персонал, водителю сдавать по ней нечего; `blank` — сдавать было что, но человек ничего
 * не ввёл. День, состоящий из одних `closed`, и день из одних `blank` дают одинаково пустое тело и
 * совершенно разные новости человеку (Р6).
 */
type BuiltItem =
  { submit: ReportItemSubmit } | { errors: Record<string, string> } | { skip: 'closed' | 'blank' };

/**
 * Сообщения схемы — по именам полей блока: их и подсвечивает форма. A refusal about the stop set
 * as a whole stands under the route block: no single field is named by it.
 */
function issueMessages(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const result: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? 'form');
    result[key === 'points' ? timeFields.route : key] = issue.message;
  }
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
 *
 * **Пустой блок пропускается только у НОВОЙ строки, и это не оптимизация, а разные события в
 * учёте** (Р6). У строки без сохранённого показания пусто означает «в эту машину ещё не смотрели»:
 * день с двумя машинами, из которых заполнена одна, обязан уйти — иначе поэтапная сдача не
 * работает вовсе, и утром одну машину не передать. У уже существующего показания вида `values`
 * та же пустота означает противоположное: человек СТЁР последнее число, и это команда, а не
 * молчание. Пропусти её — тело уедет без строки, сервер оставит в базе прежнее значение, а портал
 * покажет успех: очистка исчезнет молча. Поэтому опустошённый `values` идёт в схему и получает
 * оттуда отказ «заполните хотя бы одно значение».
 */
function buildItem(
  item: ReportItemDto,
  value: DraftItem,
  previous: DriverPreviousReading | null,
  stops: readonly ShownStop[],
  timesRequired: boolean,
): BuiltItem {
  const numbers = {
    odometerKm: parseReadingNumber(value.odometerKm),
    engineHours: parseReadingNumber(value.engineHours),
    fuelStartLiters: parseReadingNumber(value.fuelStartLiters),
    fuelFilledLiters: parseReadingNumber(value.fuelFilledLiters),
    fuelEndLiters: parseReadingNumber(value.fuelEndLiters),
  };
  // Time refusals stand next to the number refusals, not after them: a driver fixing an odometer
  // typo should not learn only on the next tap that the end time is missing too (ADR 0234, D11).
  const times = buildTimes({ item, value, stops, required: timesRequired, numbers });
  const broken = Object.entries(numbers).filter(([, v]) => v === 'invalid');
  if (broken.length > 0) {
    const refused = Object.fromEntries(broken.map(([field]) => [field, 'Введите число']));
    return { errors: { ...times.errors, ...refused } };
  }

  /*
   * «Ни одного числа» — не то же самое, что «блок пуст»: комментарий и файл пустотой не считаются
   * намеренно (Р6). Человек, приложивший фото щитка или написавший «одометр не работает», ждёт,
   * что это уедет; пропусти такой блок — и вложение с текстом исчезли бы без единого слова. Ему
   * отвечает схема отказом «заполните хотя бы одно значение», и отказ этот стоит на его блоке.
   */
  const noNumbers =
    !value.odometerKm &&
    !value.engineHours &&
    !value.fuelStartLiters &&
    !value.fuelFilledLiters &&
    !value.fuelEndLiters;

  // Строка, закрытая персоналом видом `no_data`, — первая ветка и до общего правила пустоты не
  // доходит: её сохранённый комментарий приезжает в поля вместе с показанием, и по общему правилу
  // она перестала бы считаться пустой — то есть один чужой блок снова держал бы весь день.
  // Водитель эту строку не редактирует; набранное же в ней число уедет как обычное показание.
  if (item.reading?.kind === 'no_data' && noNumbers && !times.typed) return { skip: 'closed' };

  // Новая строка, в которой не тронуто ничего, — это «сюда ещё не дошли», а не команда. Условие
  // проверяет отсутствие сохранённого показания, а не его пустоту: `values` с числами в базе,
  // очищенный на экране, выглядит отсюда так же — и обязан дойти до схемы (см. заголовок).
  // A typed time is input too: alone it does not make a reading (ADR 0234), so it goes on to the
  // schema and comes back as "fill in at least one value" instead of vanishing as a blank row.
  const untouched = noNumbers && !times.typed && !value.comment.trim() && value.files.length === 0;
  if (!item.reading && untouched) return { skip: 'blank' };

  // Грубое (вне абсолютных границ) отправку не пропускает вовсе: подтверждать опечатку в разряде
  // бессмысленно — её подтвердят так же, как набрали. Мягкое снимается галочкой: странное число
  // бывает правдой (Р6).
  const warnings = readingWarnings(numbers, previous);
  const hard = warnings.filter((w) => w.hard);
  if (hard.length > 0) {
    return {
      errors: { ...times.errors, ...Object.fromEntries(hard.map((w) => [w.field, w.text])) },
    };
  }
  const soft = warnings.filter((w) => !w.hard);
  if (soft.length > 0 && !value.confirmAnomaly) {
    const confirm = 'Подтвердите значение галочкой «Всё верно»';
    return { errors: { ...times.errors, [soft[0]!.field]: confirm } };
  }
  if (Object.keys(times.errors).length > 0) return { errors: times.errors };

  const parsed = readingInputSchema.safeParse({
    kind: 'values',
    ...numbers,
    ...times.keys,
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
export interface SubmitBody {
  items: ReportItemSubmit[];
  errors: Record<string, Record<string, string>>;
  /**
   * Тело пустое, хотя заполнить было что: хотя бы одна открытая строка пропущена как нетронутая
   * (Р6). Признак считается здесь, а не угадывается страницей заново: только сборка знает, почему
   * строк не осталось, — «весь день закрыл персонал» и «день просто не заполнен» отсюда выглядят
   * одинаково пустым телом, а человеку это две разные новости.
   *
   * Отказы полей при этом старше признака: если хоть один блок отказал, страница показывает
   * отказы и до подвала не доходит.
   */
  emptyOpenDay: boolean;
}

export function buildSubmitBody(
  report: DriverReportDto,
  values: Record<string, DraftItem>,
  entryOf: (item: ReportItemDto) => DriverAssignmentEntry | null,
): SubmitBody {
  const items: ReportItemSubmit[] = [];
  const errors: Record<string, Record<string, string>> = {};
  // The rule follows the report's stored format, not this build (ADR 0234, decision 6).
  const timesRequired = reportRequiresDriverTimes(report.draftFormat);
  let blank = false;
  for (const item of report.items) {
    const entry = entryOf(item);
    const value = values[sourceKey(item)] ?? emptyItem();
    const stops = stopsOf(item, entry);
    const built = buildItem(item, value, entry?.previous ?? null, stops, timesRequired);
    if ('submit' in built) items.push(built.submit);
    else if ('errors' in built) errors[item.id] = built.errors;
    else if (built.skip === 'blank') blank = true;
  }
  return { items, errors, emptyOpenDay: items.length === 0 && blank };
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
