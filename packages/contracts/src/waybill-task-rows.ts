import { type CostTarget, costTargetKey } from './cost-target';
import { type DriverDocumentGap, driverDocumentGapsWarning } from './persons';
import {
  addressKeyOf,
  brokenTripOrder,
  contactKeyOf,
  type FreightTaskRef,
  type LinearTaskRef,
  pointContacts,
  type RoutePointAction,
  type TaskRef,
  taskRefKey,
  type VehicleRoutePointDto,
} from './route-points';
import {
  BLANK_WAYBILL_CONFIRM,
  routeCargoWithNote,
  routeContactsLabel,
  routeExtraTaskLine,
  routeRequestCapacity,
} from './vehicle-routes';
import { type WaybillFormCode, waybillFormShortLabels } from './waybills';

// ── Строка задания бланка, её бюджет и то, что мешает выписке ──
// План `docs/route-trips-plan.md`, этап 1 (Р11, Р11а, Р11б, Р12, Р21, Р26). Модуль **аддитивный**:
// он стоит рядом с действующей выпиской (`vehicle-routes.ts`, `apps/api/src/services/waybill-issue.ts`)
// и ничего в ней не переключает — переключение это этап 5.
//
// Три вещи, которые обязаны считаться одинаково на сервере и в браузере:
//
//   - **строка задания** — то, что бланк печатает одной строкой: ездка грузоперевозки либо день
//     линейного заказа (Р11). Не точка: в 4-П графы «откуда» и «куда» стоят парой, а точка — одна;
//   - **бюджет бланка** — влезает ли строка в бумагу и что сворачивается первым (Р11а). Бумага
//     конечна, шрифт пропорционален, и «на глаз» этот вопрос решать нельзя: недооценка даёт
//     обрезанный посреди слова адрес (ровно эта беда уже была с наименованием машины в ЭСМ-2,
//     ADR 0060), переоценка — ложный отказ выписать лист;
//   - **чего человек не знает** — блокеры выписки и предупреждения, подтверждаемые до того, как
//     израсходуется номер строгой отчётности (Р21).
//
// Почему всё это в контрактах, а не на сервере: портал показывает непечатаемую строку **при
// сборке** маршрута, а не только при нажатии «Выписать» (Р11а), и набор предупреждений он обязан
// показать тот же, отпечаток которого потом примет сервер (Р21). Две записи одного правила
// разошлись бы на первой же правке — и окно спрашивало бы не о том, что записано в лист.

// ── Строка задания ──

interface TaskRowBase {
  /** 1..N — она же строка бланка и номер талона у первых четырёх строк 4-П (Р12). */
  slot: number;
  /** Адрес **точки** погрузки (Р11б), а не адрес, записанный в самой строке задания. */
  from: string;
  /** Адрес **точки** разгрузки; у линейного дня — его единственной точки. */
  to: string;
  /**
   * Ответственные точек строки: сначала точки погрузки, затем разгрузки, без повторов (Р11а).
   * Полный список, а не то, что влезло: что из него напечатается, решает `taskRowLayout`, а
   * задание водителю (письмо и кабинет `/driver`) печатает его целиком (§8 плана).
   */
  contacts: { name: string; phone: string }[];
  /** «ТС-40/2» либо «ТС-77 · 12.08» — для сообщений и списка «Задание листа», не для бумаги. */
  displayNumber: string;
  /** Номер заявки: третий ключ сортировки строк (Р11). */
  requestNum: number;
  /** Номер ездки внутри заявки; у линейного дня — 0. Четвёртый ключ сортировки. */
  tripNum: number;
}

/** Строка задания — ездка грузоперевозки: пара адресов, количество и примечание к нему. */
export interface FreightTripRow extends TaskRowBase {
  kind: 'freight';
  ref: FreightTaskRef;
  /** «12 м³» либо «8 т» — количество этой ездки; в бланке не режется никогда (Р11а). */
  cargoLabel: string;
  /** Примечание к грузу («песок, звонить за час») — при нехватке места отбрасывается первым. */
  cargoNote: string;
}

/**
 * День линейного заказа так, как его печатает ADR 0100 §10 и уже печатает код
 * (`apps/api/src/services/waybill-issue.ts`, ветка `special_equipment` в `taskLineOf`):
 * «откуда» **пусто** — машина выходит из гаража, а места стоянки портал не ведёт; «куда» —
 * наименование и адрес объекта; в графе груза — **комментарий заявки**: у такого заказа там стоит
 * характер работ, и другого места под него в бланке нет.
 *
 * Модель к этой строке ничего не добавляет и ничего не отнимает: переработка, тихо изменившая уже
 * выданный документооборот, — худшее, что может сделать план, обещавший «смену представления, а не
 * смысла» (Р24).
 */
export interface LinearDayRow extends TaskRowBase {
  kind: 'linear';
  ref: LinearTaskRef;
  /** Всегда пусто — типом, а не соглашением: подставить сюда объект значило бы «приехали с него же». */
  from: '';
  /** Комментарий заявки — он и есть содержимое графы «Груз» у линейного дня. */
  workNote: string;
}

/** Строка задания бланка: ездка либо день линейного заказа (Р11). */
export type WaybillTaskRow = FreightTripRow | LinearDayRow;

/**
 * Комментарии строк задания по ключу `taskRefKey`.
 *
 * Отдельным аргументом, потому что в точке маршрута их нет: `RoutePointAction` несёт роль, груз и
 * контакт своего конца, но не комментарий — он принадлежит **строке** (ездке или линейной заявке),
 * а не остановке, и одна и та же точка обслуживает строки с разными комментариями. План обещал
 * `waybillTaskRows(points)` одним аргументом; это первое место, где он разошёлся с моделью точек, и
 * дешевле передать карту, чем дублировать комментарий в каждую роль.
 *
 * Пустая карта законна и означает «комментариев нет»: строка без примечания печатается одним
 * количеством, а линейный день — с пустой графой груза, ровно как сегодня печатается заказ без
 * комментария.
 */
export type TaskRowNotes = ReadonlyMap<string, string>;

const NO_NOTES: TaskRowNotes = new Map();

/** Строка задания вместе с точками, на которых она стоит: по ним адресуется отказ (Р11б). */
interface PlacedTaskRow {
  row: WaybillTaskRow;
  /** Точка погрузки; у линейного дня — его единственная. */
  fromPointId: string;
  /** Точка разгрузки; у линейного дня — она же. */
  toPointId: string;
}

/** Строка в сборке: концы ищутся по всему маршруту, поэтому до конца обхода их может не быть. */
interface RowDraft {
  action: RoutePointAction;
  from: VehicleRoutePointDto | null;
  to: VehicleRoutePointDto | null;
}

/**
 * Ключ контакта для сведения двух точек в одну графу: тот же `contactKeyOf`, а безномерная запись
 * сравнивается именем.
 *
 * Копия правила из `pointContacts` (там оно приватное, `nameOnlyKey`), и другого выхода нет:
 * контакты приезжают сюда уже сведёнными **внутри** каждой точки, а свести их надо ещё и **между**
 * концами ездки — тот же весовщик может встречать и на погрузке, и на разгрузке (одна площадка,
 * два заезда), и печатать его дважды значит потратить единственную вторую строку графы впустую.
 */
function contactMergeKey(contact: { name: string; phone: string }): string | null {
  const key = contactKeyOf(contact.phone);
  if (key !== null) return key;
  const name = contact.name.replace(/\s+/gu, ' ').trim().toLowerCase();
  return name === '' ? null : `name:${name}`;
}

/** Ответственные обоих концов строки: сначала погрузка, затем разгрузка, без повторов (Р11а). */
function rowContacts(points: readonly VehicleRoutePointDto[]): { name: string; phone: string }[] {
  const seen = new Set<string>();
  const contacts: { name: string; phone: string }[] = [];
  for (const point of points) {
    for (const contact of pointContacts(point.actions)) {
      const key = contactMergeKey(contact);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      contacts.push(contact);
    }
  }
  return contacts;
}

/**
 * Строки задания с их точками — общий сбор для `waybillTaskRows` и `routeIssueBlockers`.
 *
 * Порядок печати детерминирован до конца (Р11), иначе он зависел бы от того, как строки вернул SQL,
 * а вместе с ним поехали бы `slot`, талоны, заказчик в шапке и отпечаток предупреждений. Ключ из
 * четырёх полей: позиция первой точки строки, позиция второй, номер заявки, номер ездки. Третий и
 * четвёртый закрывают случай, который иначе неразличим: две **повторные** ездки `A→B` стоят на
 * одних и тех же точках, и первых двух ключей им не хватает.
 *
 * Строка, у которой в маршруте нашёлся только один конец, строкой задания **не становится**:
 * печатать её нечем — «куда» неизвестно. Это не молчание, а другой отказ — `rows_unplaced`.
 */
function placedTaskRows(
  points: readonly VehicleRoutePointDto[],
  notes: TaskRowNotes,
): PlacedTaskRow[] {
  const drafts = new Map<string, RowDraft>();
  for (const point of [...points].sort((a, b) => a.position - b.position)) {
    for (const action of point.actions) {
      const key = taskRefKey(action.ref);
      const draft: RowDraft = drafts.get(key) ?? { action, from: null, to: null };
      // Роль у ездки одна на конец (`UNIQUE (trip_id, role)`); если данные пришли битыми, значима
      // самая ранняя точка — по ней же считается инвариант порядка (`brokenTripOrder`).
      if (action.kind === 'linear') {
        draft.from ??= point;
        draft.to ??= point;
      } else if (action.role === 'load') draft.from ??= point;
      else draft.to ??= point;
      drafts.set(key, draft);
    }
  }

  const placed: (PlacedTaskRow & { firstPosition: number; secondPosition: number })[] = [];
  for (const draft of drafts.values()) {
    const { action, from, to } = draft;
    if (from === null || to === null) continue;
    const base = {
      // Номер строки известен только после сортировки — до неё его у строки просто нет.
      slot: 0,
      to: to.location,
      contacts: rowContacts(from === to ? [from] : [from, to]),
      displayNumber: action.displayNumber,
      requestNum: action.requestNum,
      tripNum: action.tripNum,
    };
    const note = notes.get(taskRefKey(action.ref)) ?? '';
    const row: WaybillTaskRow =
      action.kind === 'freight'
        ? {
            ...base,
            kind: 'freight',
            ref: action.ref,
            from: from.location,
            cargoLabel: action.cargoLabel,
            cargoNote: note,
          }
        : { ...base, kind: 'linear', ref: action.ref, from: '', workNote: note };
    placed.push({
      row,
      fromPointId: from.id,
      toPointId: to.id,
      firstPosition: from.position,
      secondPosition: to.position,
    });
  }

  return placed
    .sort(
      (a, b) =>
        a.firstPosition - b.firstPosition ||
        a.secondPosition - b.secondPosition ||
        a.row.requestNum - b.row.requestNum ||
        a.row.tripNum - b.row.tripNum,
    )
    .map((item, index) => ({
      // `slot` проставляется тем же порядком, начиная с 1: это и строка бланка, и номер талона.
      row: { ...item.row, slot: index + 1 },
      fromPointId: item.fromPointId,
      toPointId: item.toPointId,
    }));
}

/** Строки задания в порядке печати — по ключу из четырёх полей (Р11). */
export function waybillTaskRows(
  points: readonly VehicleRoutePointDto[],
  notes: TaskRowNotes = NO_NOTES,
): WaybillTaskRow[] {
  return placedTaskRows(points, notes).map((placed) => placed.row);
}

// ── Геометрия бланка ──
//
// Числа ниже сняты с самого файла `apps/api/templates/waybill-4p.xlsx` и закрываются
// регрессионным тестом геометрии (§11 плана): одной ширины ячейки ему мало — на вместимость влияют
// шрифт, кегль, высота строки и перенос, поэтому тест сверяет все пять, а сверху идёт
// golden-рендер листа с заведомо широкой строкой.
//
// **Бюджет считается в ширине, а не в знаках** — и это расхождение с планом, а не вольность. План
// велел считать «сколько широких знаков помещается» по ширине объединения в единицах Excel
// (62 знака в общей ячейке строк 5–7). Единица ширины колонки — это ширина цифры «0» в шрифте
// **книги** (Arial 8 pt), а графы задания набраны кеглем 6 pt: посимвольный предел занижает
// ёмкость примерно в 1.7 раза. Практическое последствие подсчёта по знакам — свёрнутый в «+N»
// второй контакт, который сегодня печатается и помещается (`routeContactsLabel` не сворачивает
// вообще ничего), то есть регресс в уже выданном документообороте. Консервативность Р11а при этом
// не теряется: её держит не единица счёта, а ширина **неизвестного глифа** (см. `GLYPH_CLASSES`).

/**
 * Геометрия задания 4-П. Все пять величин, от которых зависит вместимость, — в одном месте: врозь
 * они разъезжаются с бумагой молча, а вместе видны одним взглядом и одним тестом.
 *
 * `wrapText` у всех перечисленных ячеек стоит в самом бланке (стиль `A75`) либо ставится разметкой
 * (`mark-waybill-templates.ts`, `wrap: ['CG76', 'CG77', 'CG78']`) — без него хвост срезался бы по
 * границе объединения, и никакой бюджет от этого не спас бы.
 */
export const TASK_ROW_GEOMETRY = {
  /** Шрифт книги: им меряется единица ширины колонки Excel (`sheetFormatPr`, `<font>` по умолчанию). */
  bookFontPt: 8,
  /** Высота строки по умолчанию при шрифте книги: `defaultRowHeight="11.45"`. */
  bookRowHeightPt: 11.45,
  /** Кегль граф задания: Arial 6 pt (`fontId` стиля `A75`). */
  fontPt: 6,
  /** Высота строк 75–78 и трёх нижних строк блока доп. задания: `ht="18.95"`. */
  rowHeightPt: 18.95,
  /** Ширина цифры «0» в Arial 8 pt: 0.556 em × 8 pt — она же единица ширины колонки. */
  widthUnitPt: 4.448,
  /** Объединения граф и их ширины в единицах Excel — суммой ширин колонок объединения. */
  cells: {
    from: { merge: 'A75:X75', widthUnits: 28.3125 },
    to: { merge: 'Y75:AS75', widthUnits: 24.7734 },
    cargo: { merge: 'AT75:BF75', widthUnits: 15.3359 },
    contacts: { merge: 'BG75:CD75', widthUnits: 30.6719 },
    extra: { merge: 'CG76:EG76', widthUnits: 62.5234 },
  },
} as const;

/** Графа задания: четыре графы таблицы плюс общая ячейка строк 5–7. */
export type TaskRowCell = keyof typeof TASK_ROW_GEOMETRY.cells;

/** Ширина графы в пунктах — то, чем меряется строка. */
export function taskCellWidthPt(cell: TaskRowCell): number {
  return TASK_ROW_GEOMETRY.cells[cell].widthUnits * TASK_ROW_GEOMETRY.widthUnitPt;
}

/**
 * Строк текста в ячейке задания — не константой, а из высоты: 18.95 pt при высоте строки
 * 11.45/8 × 6 ≈ 8.59 pt держит ровно две. Третья строка не появляется — она обрезается границей
 * ячейки, и заметит это тот, кто взял бумагу в руки.
 */
export const TASK_ROW_LINES = Math.floor(
  TASK_ROW_GEOMETRY.rowHeightPt /
    ((TASK_ROW_GEOMETRY.bookRowHeightPt / TASK_ROW_GEOMETRY.bookFontPt) * TASK_ROW_GEOMETRY.fontPt),
);

/**
 * Отступы внутри ячейки: Excel держит по 2 px слева и справа (96 dpi — 1.5 pt каждый). Мелочь на
 * общей ячейке в 278 pt, но на графе груза в 68 pt это 4% ширины, и списывать их значило бы
 * закладывать в бюджет место, которого на бумаге нет.
 */
const CELL_PADDING_PT = 3;

/** Полезная ширина графы: объединение минус отступы ячейки. */
function usableWidthPt(cell: TaskRowCell): number {
  return taskCellWidthPt(cell) - CELL_PADDING_PT;
}

// ── Ширина строки ──

/**
 * Ширины глифов Arial в долях em, классами. Значения — метрики Arial (они же Helvetica) в тысячных
 * em; там, где память о точной ширине кириллической буквы не безусловна, глиф отнесён к **более
 * широкому** классу: ошибка в сторону запаса стоит одного свёрнутого контакта, ошибка в другую
 * сторону — хвоста, срезанного границей ячейки.
 *
 * Набор — то, что реально встречается в адресах, именах и телефонах: кириллица, латиница, цифры,
 * пробел, знаки препинания, кавычки-ёлочки, «№», «³» (из «м³»), многоточие и тире.
 */
const GLYPH_CLASSES: readonly (readonly [number, string])[] = [
  [0.191, "'"],
  [0.222, 'ijl'],
  [0.278, ' !,./:;I[]\\|ft'],
  [0.333, '()-`r³°'],
  [0.355, '"'],
  [0.389, '*{}'],
  [0.469, '^'],
  [0.5, 'Jcksvxyzгзкстухэ'],
  [0.556, '0123456789$#?_Labdeghnopqu«»–абвдеёийлнопрцчъья'],
  [0.584, '+<=>~'],
  [0.611, 'FTZГТ'],
  [0.667, '&ABEKPSVXYАБВЕЁЗКРУХЧЬЯ'],
  [0.722, 'CDHNRUwДИЙЛНПСЦЭ'],
  [0.778, 'GOQОФЪжфыю'],
  [0.833, 'MmМмшщ'],
  [0.889, '%'],
  [0.944, 'WЖШЩЫ'],
  [1, '@Ю№—…'],
];

const GLYPH_WIDTH_EM = new Map<string, number>(
  GLYPH_CLASSES.flatMap(([em, chars]) => [...chars].map((char): [string, number] => [char, em])),
);

/**
 * Ширина неизвестного глифа — «W», самый широкий в наборе. Так консервативность Р11а сохраняется
 * целиком: строка из незнакомых знаков за ячейку не вылезет, а обычная не свернётся зря.
 */
const UNKNOWN_GLYPH_EM = 0.944;

/** Ширина строки в пунктах при кегле граф задания. */
function textWidthPt(text: string): number {
  let em = 0;
  for (const char of text) em += GLYPH_WIDTH_EM.get(char) ?? UNKNOWN_GLYPH_EM;
  return em * TASK_ROW_GEOMETRY.fontPt;
}

/**
 * Сколько строк займёт текст в ячейке шириной `widthPt`.
 *
 * Перенос считается по-настоящему, а не делением общей ширины на ширину ячейки: `wrapText` рвёт
 * строку по **пробелам**, и хвост, не поместившийся в конце строки, целиком уезжает на следующую —
 * место в конце строки пропадает. Деление занизило бы число строк ровно на эту потерю.
 *
 * Разрыв ищется только по пробелам и явным переводам строки: Excel рвёт ещё и по дефисам, но
 * забыть о такой возможности — ошибка в сторону запаса, а помнить о ней — в сторону обрезанного
 * хвоста. Слово шире ячейки (длинный адрес без пробелов) рвётся по границе, как это делает и сам
 * Excel.
 */
function wrappedLines(text: string, widthPt: number): number {
  const spaceWidth = textWidthPt(' ');
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/u).filter((word) => word !== '');
    if (words.length === 0) continue;
    lines += 1;
    let used = 0;
    for (const word of words) {
      let width = textWidthPt(word);
      if (used > 0) {
        if (used + spaceWidth + width <= widthPt) {
          used += spaceWidth + width;
          continue;
        }
        lines += 1;
        used = 0;
      }
      while (width > widthPt) {
        lines += 1;
        width -= widthPt;
      }
      used = width;
    }
  }
  return lines;
}

/** Помещается ли текст в графу целиком. Пустой помещается всегда — печатать нечего. */
function fitsCell(text: string, cell: TaskRowCell): boolean {
  return wrappedLines(text, usableWidthPt(cell)) <= TASK_ROW_LINES;
}

// ── Раскладка строки по бланку ──

/** Поля, которые не режутся никогда: без них ехать некуда (Р11а). */
export type TaskRowField = 'from' | 'to' | 'cargo';

/**
 * Где печатается строка: у строк 1–4 предел свой у каждой графы, у строк 5–7 блока доп. задания —
 * один на всё, потому что графы там нет ни одной (`routeExtraTaskLine`).
 */
export type TaskRowLayoutKind = 'columns' | 'single-cell';

export type TaskRowLayout =
  | {
      ok: true;
      from: string;
      to: string;
      cargo: string;
      contacts: string;
      /** Что не поместилось: по нему выписка поднимает `task_row_overflow` (Р21). */
      hidden: string[];
    }
  | { ok: false; code: 'required_fields_overflow'; fields: TaskRowField[] };

/**
 * Строк таблицы задания в 4-П четыре — столько же, сколько отрывных талонов (`WAYBILL_COUPONS`), и
 * по той же причине: у каждой строки таблицы свой талон заказчика (Р12). Строки 5–7 талона не
 * имеют и печатаются одной ячейкой блока «Дополнительное задание водителю» (ADR 0068).
 */
const TASK_TABLE_ROWS = 4;

/**
 * Как печатается строка с этим номером; `null` — не печатается вовсе.
 *
 * `null` у формы № 3 — не пробел, а решение ADR 0071: задания она не печатает, заявки легкового
 * доезжают до водителя оповещением. У ЭСМ-2 задания по строкам нет тем более: он выписывается на
 * одну заявку на неделю (ADR 0060). `null` у слота сверх ёмкости бланка означает «этой строке
 * места нет» — и отвечает за это `capacity_exceeded`, а не бюджет графы.
 */
export function taskRowLayoutKind(
  formCode: WaybillFormCode | null,
  slot: number,
): TaskRowLayoutKind | null {
  if (formCode !== '4p') return null;
  if (slot < 1 || slot > routeRequestCapacity(formCode)) return null;
  return slot <= TASK_TABLE_ROWS ? 'columns' : 'single-cell';
}

/** Подпись одного ответственного так, как её печатает бланк: «Кузнецова А.В., +7 (914) 123 45 67». */
function contactLabel(contact: { name: string; phone: string }): string {
  // Через `routeContactsLabel`, а не своей склейкой: длину контакта бюджет обязан мерить **после**
  // сокращения имени (`contactNameLabel` сокращает до «Фамилия И.О.» только запись ровно из трёх
  // слов, и «прораб Иванов» съедает больше) и после приведения номера к единому виду (ADR 0066).
  // Второй копии этого правила быть не должно: разойдясь, бюджет считал бы не ту строку, которую
  // печатает бумага.
  return routeContactsLabel([contact]);
}

/** Подписи контактов строки, из которых собирается графа; пустые записи отброшены. */
function contactLabels(row: WaybillTaskRow): string[] {
  return row.contacts.map(contactLabel).filter((label) => label !== '');
}

/**
 * Графа контактов, в которой напечатаны первые `shown` из них, а остальные свёрнуты в «+N».
 *
 * «+N» приписывается к последней напечатанной подписи, а не ставится своей строкой: строк у графы
 * две, и отдать одну из них под счётчик значило бы свернуть контакт ради сообщения о том, что он
 * свёрнут.
 */
function contactsColumn(labels: readonly string[], shown: number): string {
  const visible = labels.slice(0, shown);
  const hiddenCount = labels.length - shown;
  if (hiddenCount <= 0) return visible.join('\n');
  const mark = `+${hiddenCount}`;
  if (visible.length === 0) return mark;
  return [...visible.slice(0, -1), `${visible[visible.length - 1]!} ${mark}`].join('\n');
}

/**
 * Строка задания в том виде, в каком её примет бумага (Р11а).
 *
 * Порядок свёртывания строгий и обоснован тем, чем водитель пользуется в дороге:
 *
 *   1. **комментарий к грузу** отбрасывается первым — «песок, звонить за час» полезно, но по нему
 *      не попадают на объект;
 *   2. **контакты** сверх помещающихся сворачиваются в «+N» — приехавший на место дозвонится
 *      первому, а свёрнутое ему привезут письмо и кабинет `/driver` целиком (§8 плана);
 *   3. **количество груза и адреса** не режутся никогда. Если не помещаются они, исход второй —
 *      `required_fields_overflow`, и это **блокирующий** отказ, а не предупреждение: строка
 *      задания без адреса это документ, по которому нельзя ехать, и расходовать на него номер
 *      бланка незачем. Молча обрезать адрес по границе ячейки нельзя (ADR 0060), сокращать
 *      правилом — гадать, что в «Московская обл., Волоколамский р-н, …» лишнее.
 *
 * У линейного дня графа груза занята комментарием заявки (Р11), и в приоритете свёртывания он
 * стоит там же, где комментарий к грузу, — первым. Иначе характер работ, набранный на полторы
 * строки, блокировал бы выписку листа, хотя ехать по такому заданию можно: адрес объекта на месте,
 * а работы водителю названы в задании целиком.
 */
export function taskRowLayout(row: WaybillTaskRow, kind: TaskRowLayoutKind): TaskRowLayout {
  const from = row.kind === 'freight' ? row.from : '';
  const to = row.to;
  // Количество — только у ездки: линейная техника работает, а не возит, и выражать в этой графе
  // ей нечего (`taskLineOf`, ветка `special_equipment`).
  const amount = row.kind === 'freight' ? row.cargoLabel.trim() : '';
  const comment = row.kind === 'freight' ? row.cargoNote : row.workNote;
  // Обе строки графы собирает `routeCargoWithNote`: он же схлопывает переводы строк и режет
  // комментарий по `CARGO_NOTE_LIMIT` — предел графы по бумаге, посчитанный до этого модуля.
  const cargoWithNote = routeCargoWithNote(amount, comment);
  const note = routeCargoWithNote('', comment);
  const labels = contactLabels(row);

  if (kind === 'columns') {
    const required: TaskRowField[] = [];
    if (!fitsCell(from, 'from')) required.push('from');
    if (!fitsCell(to, 'to')) required.push('to');
    if (!fitsCell(amount, 'cargo')) required.push('cargo');
    if (required.length > 0)
      return { ok: false, code: 'required_fields_overflow', fields: required };

    const hidden: string[] = [];
    let cargo = cargoWithNote;
    if (!fitsCell(cargo, 'cargo')) {
      cargo = amount;
      if (note !== '') hidden.push(note);
    }
    let shown = labels.length;
    while (shown > 0 && !fitsCell(contactsColumn(labels, shown), 'contacts')) shown -= 1;
    hidden.push(...labels.slice(shown));
    return { ok: true, from, to, cargo, contacts: contactsColumn(labels, shown), hidden };
  }

  // Общая ячейка: адрес, груз и контакты делят одну ширину, поэтому и мерить их надо вместе — по
  // той самой строке, которую соберёт `routeExtraTaskLine`, а не по каждому полю отдельно.
  const width = usableWidthPt('extra');
  const fitsLine = (cargo: string, contacts: string): boolean =>
    wrappedLines(routeExtraTaskLine({ from, to, cargo, contacts }), width) <= TASK_ROW_LINES;
  const done = (cargo: string, shown: number, hidden: string[]): TaskRowLayout => ({
    ok: true,
    from,
    to,
    cargo,
    contacts: contactsColumn(labels, shown),
    hidden,
  });
  const all = contactsColumn(labels, labels.length);
  if (fitsLine(cargoWithNote, all)) return done(cargoWithNote, labels.length, []);
  const droppedNote = note === '' ? [] : [note];
  if (fitsLine(amount, all)) return done(amount, labels.length, droppedNote);
  for (let shown = labels.length - 1; shown >= 0; shown -= 1) {
    if (!fitsLine(amount, contactsColumn(labels, shown))) continue;
    return done(amount, shown, [...droppedNote, ...labels.slice(shown)]);
  }

  /*
   * Свёртывать больше нечего. Виноватым называется то, что не помещается в ячейку **само по себе**:
   * такой адрес человек и пойдёт сокращать. Если же по отдельности помещается всё, а вместе не
   * влезает, названы все обязательные поля строки — это честный ответ «эта строка длиннее бумаги»,
   * и решать, что из неё сокращать, человеку.
   */
  const parts: [TaskRowField, string][] = [
    ['from', from],
    ['to', to],
    ['cargo', amount],
  ];
  const filled = parts.filter(([, value]) => value.trim() !== '');
  const alone = filled.filter(([, value]) => wrappedLines(value, width) > TASK_ROW_LINES);
  return {
    ok: false,
    code: 'required_fields_overflow',
    fields: (alone.length > 0 ? alone : filled).map(([field]) => field),
  };
}

// ── Блокеры выписки ──

/**
 * Почему лист не выписать. Не строкой: по коду портал ведёт человека туда, где чинят, а API
 * отвечает тем же кодом — «строка задания не влезла» и «нет водителя» лечатся в разных местах.
 */
export type IssueBlocker =
  | { code: 'no_driver' }
  | { code: 'trip_order_broken'; refs: TaskRef[] }
  | { code: 'rows_unplaced'; refs: TaskRef[] }
  | { code: 'capacity_exceeded'; rows: number; capacity: number }
  | {
      code: 'required_fields_overflow';
      ref: TaskRef;
      slot: number;
      /** Точка, чей адрес печатается в непоместившейся графе: править надо её (Р11б). */
      pointId: string;
      fields: TaskRowField[];
    };

/** Маршрут глазами блокеров: всё, из чего считается «поедет ли по этой бумаге машина». */
export interface RouteIssueSource {
  /** Пусто — водителя ещё не назначили: маршрут собирают заранее, человека ставят утром. */
  driverPersonId: string | null;
  /** Бланк рейса: им заданы и ёмкость задания, и то, как печатается каждая строка. */
  formCode: WaybillFormCode | null;
  points: readonly VehicleRoutePointDto[];
  /**
   * Строки задания состава — все ездки живых заявок рейса и все дни линейных заказов, включая те,
   * что в маршруте ещё не разложены. Именно они считаются в ёмкость бланка (Р11): считать
   * разложенные значило бы не заметить забытую ездку — ту самую, из-за которой лист и не выписать.
   *
   * Порядок — состава: в нём же вернутся `rows_unplaced`, у которых своих номеров нет (позиции в
   * маршруте у неразложенной строки не существует).
   */
  composition: readonly TaskRef[];
  notes?: TaskRowNotes;
}

/**
 * Что мешает выписать лист по этому маршруту; пусто — не мешает ничего.
 *
 * Имя не `canIssueWaybill` намеренно: та уже есть в `vehicle-routes.ts` и проверяет другое —
 * заморозку выданным листом, коррекцию (ADR 0101), статусы состава, право на пустой бланк
 * (ADR 0071) и заявку-основание перегона. Пересекаются они в двух местах: водитель (там это первый
 * же отказ) и ёмкость бланка — но старая считает **заявки**, а здесь считаются **строки задания**,
 * то есть ездки плюс линейные дни (Р11), и это единственный правильный счёт для смешанного дня.
 * Складывать их — этапу 5: старая начнёт звать эту, отдаст ей водителя и ёмкость и оставит себе
 * то, чего точки не знают.
 *
 * Все блокеры собираются разом, а не до первого: человек, собирающий рейс, должен увидеть весь
 * список сразу — чинить их он всё равно будет в одной карточке.
 */
export function routeIssueBlockers(route: RouteIssueSource): IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  if (!route.driverPersonId) blockers.push({ code: 'no_driver' });

  const broken = brokenTripOrder(route.points);
  if (broken.length > 0) blockers.push({ code: 'trip_order_broken', refs: broken });

  const placed = placedTaskRows(route.points, route.notes ?? NO_NOTES);
  const placedKeys = new Set(placed.map((item) => taskRefKey(item.row.ref)));
  const unplaced = route.composition.filter((ref) => !placedKeys.has(taskRefKey(ref)));
  if (unplaced.length > 0) blockers.push({ code: 'rows_unplaced', refs: unplaced });

  const capacity = routeRequestCapacity(route.formCode);
  // Считается состав, а не разложенное: строка, стоящая в маршруте, всегда есть и в составе —
  // роль точки ссылается на строку заявки составными FK (§5.2 плана), и обратного не бывает.
  if (route.composition.length > capacity) {
    blockers.push({ code: 'capacity_exceeded', rows: route.composition.length, capacity });
  }

  for (const item of placed) {
    const kind = taskRowLayoutKind(route.formCode, item.row.slot);
    if (kind === null) continue;
    const layout = taskRowLayout(item.row, kind);
    if (layout.ok) continue;
    blockers.push({
      code: 'required_fields_overflow',
      ref: item.row.ref,
      slot: item.row.slot,
      pointId: overflowPointId(item, layout.fields),
      fields: layout.fields,
    });
  }
  return blockers;
}

/**
 * Куда вести человека из отказа: к точке, чей адрес не поместился (Р11б). Названы оба конца —
 * ведём к более длинному: с него сокращение и начинают. Не поместилось одно количество (случай
 * общей ячейки) — к первой точке строки: другого адресата у строки нет.
 */
function overflowPointId(placed: PlacedTaskRow, fields: readonly TaskRowField[]): string {
  const candidates: string[] = [];
  if (fields.includes('from')) candidates.push(placed.fromPointId);
  if (fields.includes('to')) candidates.push(placed.toPointId);
  if (candidates.length === 0) return placed.fromPointId;
  if (candidates.length === 1) return candidates[0]!;
  return textWidthPt(placed.row.to) > textWidthPt(placed.row.from)
    ? placed.toPointId
    : placed.fromPointId;
}

// ── Предупреждения выписки (Р21) ──

export const WAYBILL_WARNING_CODES = [
  'driver_documents',
  'address_mismatch',
  // Строка задания не поместилась в бланк целиком (Р11а).
  'task_row_overflow',
  // В листе больше одного объекта затрат — шапка называет первый (Р26).
  'multiple_cost_targets',
  'blank_task',
] as const;
export type WaybillWarningCode = (typeof WAYBILL_WARNING_CODES)[number];

/**
 * Факты предупреждения — то, **о чём** оно, а не то, как оно сформулировано.
 *
 * Отпечаток (Р21) считается от фактов по одной причине: подтверждает человек положение дел, а не
 * текст на экране. Переформулировали сообщение — подтверждение остаётся в силе; сменился факт у
 * того же объекта — рукопожатие обязано разойтись, и лист не выпишется молча.
 */
export type WaybillWarningFacts =
  | { code: 'driver_documents'; personId: string; gaps: DriverDocumentGap[] }
  | {
      code: 'address_mismatch';
      pointId: string;
      ref: TaskRef;
      role: 'load' | 'unload' | 'work';
      /**
       * Нормализованные **печатаемые строки** обоих адресов (Р9г), а не семантический ключ:
       * у объекта справочника `ref:<uuid>` не меняется, когда правят текст адреса, — а печатается
       * именно текст. Взяв ключ, портал промолчал бы ровно в том случае, ради которого
       * предупреждение и заведено.
       */
      pointText: string;
      sourceText: string;
    }
  | { code: 'task_row_overflow'; ref: TaskRef; slot: number; hidden: string[] }
  | { code: 'multiple_cost_targets'; targetKeys: string[]; headerKey: string }
  | { code: 'blank_task'; routeId: string };

export interface WaybillWarning {
  facts: WaybillWarningFacts;
  /** Что показать человеку. В отпечаток не идёт — иначе правка текста рвала бы подтверждения. */
  message: string;
  /** Номера записей, которых предупреждение касается: «ТС-40/2», «Р-12», имя водителя. */
  entities: string[];
}

/**
 * Ключ адреса строки задания в карте `sourceAddresses`: ссылка на строку плюс роль конца.
 *
 * Роль в ключе обязательна: у ездки два конца, и расходиться с точкой они могут по отдельности.
 */
export function taskAddressKey(ref: TaskRef, role: RoutePointAction['role']): string {
  return `${taskRefKey(ref)}:${role}`;
}

/** Маршрут глазами предупреждений: то, из чего они считаются, — одним чтением (Р22). */
export interface WaybillIssueSource {
  routeId: string;
  /** «Р-12» — им предупреждение называет рейс человеку. */
  routeNumber: string;
  formCode: WaybillFormCode | null;
  /** Назначенный водитель с его пробелами (ADR 0064); `null` — водителя нет, и это блокер. */
  driver: { personId: string; name: string; gaps: readonly DriverDocumentGap[] } | null;
  points: readonly VehicleRoutePointDto[];
  notes?: TaskRowNotes;
  /**
   * Адрес, записанный в самой строке задания, по ключу `taskAddressKey` — то, с чем сверяется
   * печатаемый адрес точки (Р10, Р11б).
   *
   * Картой, а не полем точки, по той же причине, что и комментарии: `RoutePointAction` несёт о
   * расхождении только флаг `addressMismatch`, а предупреждение обязано назвать **оба** текста —
   * иначе человек подтверждает «адреса разошлись», не видя, чем именно. Ключа нет — берётся пустая
   * строка: расхождение с пустым адресом заявки означает, что адреса у неё не осталось, и это
   * ровно то, что человек должен увидеть.
   */
  sourceAddresses?: ReadonlyMap<string, string>;
  /** Объект затрат заявки по её идентификатору (Р25): у ездки и линейного дня он заявкин. */
  costTargets?: ReadonlyMap<string, CostTarget>;
}

/**
 * Печатаемый адрес в сравнимом виде: регистр, лишние пробелы и «ё» — оформление записи, а не её
 * содержание, и переписанное «Сычёво» вместо «Сычево» не то расхождение, о котором стоит
 * спрашивать.
 *
 * Тем же правилом, что уровень `text:` семантического ключа (`addressKeyOf`): второй записи
 * нормализации в портале быть не должно — разойдясь, отпечаток портала не сошёлся бы с серверным.
 */
function printedAddress(location: string): string {
  return addressKeyOf({ location, address: null }).slice('text:'.length);
}

/** Роли в порядке чтения бумаги (Р9б): сначала отдающие груз, потом работа дня, потом принимающие. */
const ROLE_ORDER: Record<RoutePointAction['role'], number> = { load: 0, work: 1, unload: 2 };

/**
 * Предупреждения выписки в порядке кодов (`WAYBILL_WARNING_CODES`), а внутри кода — в порядке
 * бумаги: точки по позиции, строки по номеру строки задания.
 *
 * Порядок задан целиком, потому что список читает человек в окне подтверждения: «как вернул SQL»
 * означало бы, что при повторном открытии того же рейса предупреждения переставились местами.
 * На отпечаток порядок не влияет (`canonicalWarningPayload`) — там он и не должен.
 */
export function waybillIssueWarnings(source: WaybillIssueSource): WaybillWarning[] {
  const warnings: WaybillWarning[] = [];
  const rows = waybillTaskRows(source.points, source.notes ?? NO_NOTES);
  const formLabel = source.formCode ? waybillFormShortLabels[source.formCode] : null;

  const driver = source.driver;
  if (driver && driver.gaps.length > 0) {
    // Вид документа назван водительским жёстко, как и в карточке рейса: `driverGaps` его не несёт,
    // а 4-П и форму № 3 возит водитель (ADR 0095).
    const message = driverDocumentGapsWarning(driver.gaps, 'driver_license', formLabel);
    if (message) {
      warnings.push({
        facts: { code: 'driver_documents', personId: driver.personId, gaps: [...driver.gaps] },
        message,
        entities: [driver.name],
      });
    }
  }

  for (const point of [...source.points].sort((a, b) => a.position - b.position)) {
    const actions = [...point.actions].sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.requestNum - b.requestNum ||
        a.tripNum - b.tripNum,
    );
    for (const action of actions) {
      if (!action.addressMismatch) continue;
      const sourceText = source.sourceAddresses?.get(taskAddressKey(action.ref, action.role)) ?? '';
      warnings.push({
        facts: {
          code: 'address_mismatch',
          pointId: point.id,
          ref: action.ref,
          role: action.role,
          pointText: printedAddress(point.location),
          sourceText: printedAddress(sourceText),
        },
        // Сообщение печатает адреса как есть, а не нормализованными: человек сверяет их глазами со
        // своей заявкой, а не с ключом. Пустой адрес строки называется словами — ««»» в кавычках
        // читалось бы как потерянная подстановка, а не как незаполненное поле.
        message:
          `Печатаем адрес точки: «${point.location.trim()}». ` +
          (sourceText.trim() === ''
            ? `В строке задания ${action.displayNumber} адреса нет.`
            : `В строке задания ${action.displayNumber} записано: «${sourceText.trim()}».`),
        entities: [action.displayNumber],
      });
    }
  }

  for (const row of rows) {
    const kind = taskRowLayoutKind(source.formCode, row.slot);
    if (kind === null) continue;
    const layout = taskRowLayout(row, kind);
    // Непоместившаяся строка это блокер (`routeIssueBlockers`), а не предупреждение: подтверждать
    // документ, по которому нельзя ехать, человеку не предлагают.
    if (!layout.ok || layout.hidden.length === 0) continue;
    warnings.push({
      facts: {
        code: 'task_row_overflow',
        ref: row.ref,
        slot: row.slot,
        hidden: [...layout.hidden],
      },
      message:
        `Строка задания ${row.slot} (${row.displayNumber}) не помещается в бланк целиком: ` +
        `не напечатано — ${layout.hidden.join('; ')}. Водитель получит это в задании: в письме и в кабинете.`,
      entities: [row.displayNumber],
    });
  }

  const targets = new Map<string, CostTarget>();
  for (const row of rows) {
    const target = source.costTargets?.get(row.ref.requestId);
    if (target) targets.set(costTargetKey(target), target);
  }
  if (targets.size > 1) {
    const keys = [...targets.keys()];
    const names = [...targets.values()].map((target) => target.name);
    warnings.push({
      facts: { code: 'multiple_cost_targets', targetKeys: keys, headerKey: keys[0]! },
      message:
        `В листе объекты затрат: ${names.join(', ')}; шапка «в чьё распоряжение» называет первый — ` +
        `${names[0]}. Разносите затраты по талонам.`,
      entities: names,
    });
  }

  if (rows.length === 0) {
    warnings.push({
      facts: { code: 'blank_task', routeId: source.routeId },
      // Текст тот же, которым пустой бланк подтверждается сегодня (ADR 0071): расходиться
      // формулировкам одного и того же решения негде.
      message: BLANK_WAYBILL_CONFIRM,
      entities: [source.routeNumber],
    });
  }

  return warnings;
}

/**
 * Каноникализация набора предупреждений для отпечатка; `sha256` от неё берёт сервер — в браузере он
 * не нужен, там отпечаток только возвращается обратно (Р21).
 *
 * Канонизируется всё, что в наборе является **оформлением**, а не содержанием:
 *
 *   - текст сообщения и `entities` не участвуют вовсе — переформулировка не меняет положения дел;
 *   - порядок предупреждений между собой не значим: переставили точки местами — набор фактов тот
 *     же, и подтверждение остаётся в силе;
 *   - порядок ключей внутри факта задан сортировкой, а не порядком полей объекта: `JSON.stringify`
 *     пишет их в порядке появления, и один и тот же факт, собранный двумя ветками кода, дал бы две
 *     разные строки;
 *   - порядок внутри массивов факта (пробелы документов, свёрнутые контакты, объекты затрат) тоже
 *     не значим: те же два объекта затрат, названные в другом порядке, — то же самое положение дел.
 *     Что в шапке напечатается первый, сказано отдельным полем `headerKey`, и вот его смена
 *     отпечаток менять обязана: шапка назовёт другого заказчика.
 */
export function canonicalWarningPayload(warnings: readonly WaybillWarning[]): string {
  const facts = warnings.map((warning) => JSON.stringify(canonicalValue(warning.facts)));
  return `[${[...facts].sort().join(',')}]`;
}

/** Значение в каноническом виде: массивы отсортированы, ключи объектов — тоже. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalValue)
      .map((item) => [JSON.stringify(item), item] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]);
  }
  return value ?? null;
}
