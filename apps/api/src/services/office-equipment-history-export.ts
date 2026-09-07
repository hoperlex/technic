import {
  can,
  EQUIPMENT_CHANGE_NO_DETAILS_LABEL,
  EQUIPMENT_HISTORY_EXPORT_LIMIT,
  equipmentHistoryKindLabels,
  officeEquipmentStateLabels,
  officeEquipmentTitle,
  serviceRequestKindLabels,
  serviceRequestStatusLabels,
  type EquipmentChangeRowDto,
  type EquipmentHistoryEventDto,
  type EquipmentMovementRowDto,
  type EquipmentRequestRowDto,
  type OfficeEquipmentState,
} from '@technic/contracts';
import { writeWorkbook, type SheetInput } from '../lib/xlsx';
import {
  loadEquipmentChangesPage,
  loadEquipmentMovementsPage,
  loadEquipmentRequestsPage,
} from './office-equipment-blocks';
import { officeEquipmentFieldLabels } from './office-equipment-diff';
import { loadEquipmentHistoryAll } from './office-equipment-history';
import type { Principal } from '../auth/principal';

/**
 * Выгрузка истории единицы книгой из четырёх листов (план
 * `docs/office-equipment-history-blocks-plan.md`, Р12; лента — `office-equipment-mail-and-history-plan.md`,
 * Р80).
 *
 * ЛИСТОВ РОВНО ЧЕТЫРЕ, И ЭТО ЧЕТЫРЕ ВКЛАДКИ ЭКРАНА: «Заявки», «Правки», «Перемещения», «Полная
 * история». Книга собирается теми же выборками, что и вкладки (`office-equipment-blocks.ts`,
 * `office-equipment-history.ts`), а не своими запросами: второй экземпляр правила «что показывать»
 * разошёлся бы с первым молча, и файл начал бы показывать больше, чем портал, — то есть стал бы
 * утечкой через выгрузку.
 *
 * ЛИСТ «ПОЛНАЯ ИСТОРИЯ» ЗАМОРОЖЕН (§10.3): значения, порядок, типы и форматы его ячеек обязаны
 * остаться прежними — на этом файле строят инвентаризацию и спор с подрядчиком, и «мы заодно
 * поправили колонку» здесь означает, что прошлогодняя выгрузка и сегодняшняя об одном и том же
 * событии говорят по-разному. Побайтовое совпадение книги не обещается и не проверяется: три новых
 * листа меняют связи и оглавление книги, но не ячейки этого листа.
 *
 * ТОПОЛОГИЯ КНИГИ ФИКСИРОВАНА, А ДОСТУП — НЕТ. Без `serviceRequests.read` лист «Заявки» всё равно
 * существует, но несёт одну строку «Нет доступа к заявкам»: набор листов не должен рассказывать,
 * что бывает в портале, а данные на них — ровно те, что человек видит на экране.
 *
 * СОБЫТИЕ И СТРОКА ЛОЖАТСЯ В ФАЙЛ СЛОВАМИ, а не набором колонок под каждый вид: у шести видов
 * ленты поля разные, и таблица из объединения полей была бы наполовину пустой в каждой строке.
 * Инвентаризация и спор с подрядчиком читают колонку «что произошло», а не сверяют идентификаторы.
 */

/** Дата без времени в человеческом виде; через JS Date она бы поехала на день. */
function ru(date: string | null): string {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

function money(value: number | null): string {
  return value === null ? '' : `${value.toFixed(2)} ₽`;
}

/**
 * Момент времени по Москве. Сервер живёт в UTC, а читают файл в Москве: без сдвига правка,
 * сделанная в девять вечера, помечена вчерашним числом и встаёт в файле раньше утренней. Смещение
 * постоянное — переходов на летнее время в зоне нет с 2014 года (тот же приём и по той же причине,
 * что в `office-equipment-consumable-usage.ts`).
 */
function moscow(iso: string): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const msk = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  return {
    date: `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()}`,
    time: `${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`,
  };
}

function moscowDate(iso: string): string {
  return moscow(iso).date;
}

function moscowDateTime(iso: string): string {
  const { date, time } = moscow(iso);
  return `${date} ${time}`;
}

/** Место одной строкой: объект, уточнение внутри него и состояние — по ним технику и ищут. */
function placeOf(objectCode: string, location: string, state: string): string {
  return [objectCode, location, state].filter(Boolean).join(' · ');
}

/**
 * Состояние стороны перемещения. «На месте» словом не называется вовсе: место уже названо объектом
 * и кабинетом, и «на месте» рядом с ними ничего не добавляет.
 *
 * Уточнение (`note`) — то самое «у сотрудника (Иванов)»: в журнале перемещений оно есть, в ленте
 * его нет вовсе (у события ленты такого поля не заведено), поэтому лист полной истории зовёт эту
 * функцию с пустым уточнением — и остаётся прежним.
 */
function stateOf(state: OfficeEquipmentState, note: string): string {
  if (state === 'on_site') return '';
  const label = officeEquipmentStateLabels[state];
  return note ? `${label} (${note})` : label;
}

/** Части ячейки одной строкой: пустые не оставляют висящих разделителей. */
function joined(parts: (string | false | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join('; ');
}

function textOf(event: EquipmentHistoryEventDto): string {
  switch (event.kind) {
    case 'card_lifecycle':
      return event.action === 'created'
        ? 'Карточка заведена'
        : event.action === 'archived'
          ? 'Карточка отправлена в архив'
          : 'Карточка восстановлена из архива';
    case 'movement': {
      const from = placeOf(event.fromObject.code, event.fromLocation, stateOf(event.fromState, ''));
      const to = placeOf(event.toObject.code, event.toLocation, stateOf(event.toState, ''));
      return `${from} → ${to}`;
    }
    case 'service_request':
      return `${event.displayNumber}: ${serviceRequestStatusLabels[event.status]}`;
    case 'service_step':
      return `${event.displayNumber}: ${serviceRequestStatusLabels[event.toStatus]}`;
    case 'card_change':
      return event.changes
        .map(
          (change) =>
            `${officeEquipmentFieldLabels[change.field] ?? change.field}: ${change.from ?? ''} → ${change.to ?? ''}`,
        )
        .join('; ');
    case 'warranty':
      switch (event.action) {
        case 'set':
          return `Гарантия на «${event.subject}» до ${ru(event.until)}`;
        case 'moved':
          return `Гарантия на «${event.subject}»: ${ru(event.from)} → ${ru(event.until)}`;
        case 'cleared':
          return `Гарантия на «${event.subject}» снята (была до ${ru(event.from)})`;
        case 'expired':
          return `Гарантия на «${event.subject}» истекла`;
      }
  }
}

/** Подробности: то, что не влезло в «что произошло», но нужно при разборе. */
function detailsOf(event: EquipmentHistoryEventDto): string {
  switch (event.kind) {
    case 'movement':
      return [
        event.reason,
        event.comment,
        event.toDepartmentName ? `отдел: ${event.toDepartmentName}` : '',
        event.serviceRequestNum ? `по заявке СО-${event.serviceRequestNum}` : '',
      ]
        .filter(Boolean)
        .join('; ');
    case 'service_request':
      return [
        event.description,
        event.serviceName ?? 'сервис не назначен',
        money(event.totalAmount),
      ]
        .filter(Boolean)
        .join('; ');
    case 'service_step':
      return event.comment;
    case 'warranty':
      return event.displayNumber ? `заявка ${event.displayNumber}` : '';
    default:
      return '';
  }
}

const HEADER = ['Дата', 'Событие', 'Что произошло', 'Подробности', 'Кто'];

/**
 * Обрезанный отчёт обязан говорить, что он обрезан: молча урезанная выгрузка читается как полная
 * история, и спор с подрядчиком строят на ней.
 *
 * У полной истории своя редакция этой фразы, и слово «события» в ней не случайно: лист заморожен
 * §10.3 целиком, включая последнюю строку. Блокам считать нечего, кроме строк, и общий текст для
 * них честнее.
 */
const FEED_TRUNCATED = 'Показаны не все события: выгрузка ограничена по объёму';
const BLOCK_TRUNCATED = 'Показаны не все строки: выгрузка ограничена по объёму';

/**
 * Строка из одного текста: остальные ячейки пусты, а колонку выбирает вызывающий — предупреждение
 * об обрезке читают в самой широкой, отказ в доступе — в первой.
 */
function noticeRow(width: number, column: number, text: string): string[] {
  const row = new Array<string>(width).fill('');
  row[column] = text;
  return row;
}

/**
 * Имена листов — подписи вкладок окна истории (Р11, Р12), а не «История <модель>»: в книге из
 * четырёх листов название аппарата повторялось бы четырежды, а какой это лист — не сказал бы ни
 * один. Аппарат назван именем файла, как и раньше.
 */
const SHEET_TITLES = {
  requests: 'Заявки',
  changes: 'Правки',
  movements: 'Перемещения',
  full: 'Полная история',
} as const;

// ── Лист «Полная история»: замороженный §10.3 ──

/**
 * Прежняя однолистовая выгрузка — строка в строку.
 *
 * Ни одна ячейка этого листа планом не менялась, поэтому и код её сборки перенесён сюда как есть:
 * §10.3 требует доказательства, что значения, порядок, типы и форматы остались теми же, и любая
 * «заодно» причёсанная строка это доказательство ломает.
 */
function fullHistorySheet(events: EquipmentHistoryEventDto[], truncated: boolean): SheetInput {
  const rows: string[][] = [
    HEADER,
    ...events.map((event) => [
      ru(event.occurredOn),
      equipmentHistoryKindLabels[event.kind],
      textOf(event),
      detailsOf(event),
      event.actorName ?? '',
    ]),
  ];
  if (truncated) rows.push(noticeRow(HEADER.length, 2, FEED_TRUNCATED));

  return {
    name: SHEET_TITLES.full,
    rows,
    widths: [12, 18, 60, 50, 24],
    freezeHeader: true,
  };
}

// ── Три блока: те же строки и те же подписи, что на вкладках экрана ──

/** Что человек увидел бы на вкладке, не будь у него права её открыть (Р12). */
const REQUESTS_FORBIDDEN = 'Нет доступа к заявкам';

const REQUESTS_HEADER = ['Заявка', 'Что делали', 'Даты', 'Итог'];

/**
 * Лист «Заявки»: одна заявка — одна строка, и колонки те же четыре, что на вкладке (К1).
 *
 * `null` вместо строк — не «заявок не было», а «право не открывает вкладку»: у такого читателя
 * ручка блока отвечает `403` и вкладки нет вовсе, поэтому лист существует, но сервисных данных на
 * нём нет ни одной — ни номера, ни суммы (Р12).
 *
 * Сумма приходит уже спроецированной по аудитории строки (Р5): выгрузка её не считает и не
 * восстанавливает, а `null` печатается пустой ячейкой — «её нет» и «не положено видеть» снаружи
 * неразличимы, и придумывать различие файл не станет.
 */
function requestsSheet(
  block: { rows: EquipmentRequestRowDto[]; truncated: boolean } | null,
): SheetInput {
  const rows: string[][] = [REQUESTS_HEADER];
  if (block === null) {
    rows.push(noticeRow(REQUESTS_HEADER.length, 0, REQUESTS_FORBIDDEN));
  } else {
    for (const row of block.rows) {
      rows.push([
        joined([
          row.displayNumber,
          serviceRequestStatusLabels[row.status],
          serviceRequestKindLabels[row.kind],
        ]),
        joined([
          row.summary,
          row.executors.length > 0 ? row.executors.join(', ') : 'Исполнитель не назначен',
          ...row.warranties.map((w) => `${w.name} — гарантия до ${ru(w.warrantyUntil)}`),
          row.objectMismatch && 'Место не подтверждено',
        ]),
        joined([moscowDate(row.createdAt), `изменена ${moscowDate(row.updatedAt)}`]),
        joined([row.outcome.label, money(row.totalAmount)]),
      ]);
    }
    if (block.truncated) rows.push(noticeRow(REQUESTS_HEADER.length, 1, BLOCK_TRUNCATED));
  }

  return { name: SHEET_TITLES.requests, rows, widths: [26, 70, 26, 28], freezeHeader: true };
}

const CHANGES_HEADER = ['Дата', 'Что изменилось', 'Кто'];

/**
 * Лист «Правки»: что человек менял в карточке, кто и когда (Р3).
 *
 * Со временем, а не одной датой: правок карточки в один день бывает несколько, и порядок внутри
 * дня без времени читается как случайный.
 *
 * Запись без подробностей — это строка, а не пропуск (Н5): «правок не было» и «правки были, но
 * подробностей не сохранилось» — разные утверждения, и подпись у второго одна на портал и файл.
 */
function changesSheet(block: { rows: EquipmentChangeRowDto[]; truncated: boolean }): SheetInput {
  const rows: string[][] = [CHANGES_HEADER];
  for (const row of block.rows) {
    rows.push([
      moscowDateTime(row.at),
      row.changes.length === 0
        ? EQUIPMENT_CHANGE_NO_DETAILS_LABEL
        : row.changes
            .map(
              (change) =>
                `${officeEquipmentFieldLabels[change.field] ?? change.field}: ${change.from ?? '—'} → ${change.to ?? '—'}`,
            )
            .join('; '),
      row.actorName ?? '—',
    ]);
  }
  if (block.truncated) rows.push(noticeRow(CHANGES_HEADER.length, 1, BLOCK_TRUNCATED));

  return { name: SHEET_TITLES.changes, rows, widths: [18, 70, 26], freezeHeader: true };
}

const MOVEMENTS_HEADER = ['Дата', 'Откуда → куда', 'Почему', 'Кто'];

/**
 * Лист «Перемещения»: единственный блок, где строка и событие журнала совпадают один в один (Р4).
 *
 * Поэтому и уточнения состояния обеими сторонами здесь есть, а на листе полной истории их нет: там
 * лента, у события которой таких полей не заведено вовсе. Дата — бизнес-дата переезда: технику
 * увозят в пятницу, а заносят в понедельник.
 */
function movementsSheet(block: {
  rows: EquipmentMovementRowDto[];
  truncated: boolean;
}): SheetInput {
  const rows: string[][] = [MOVEMENTS_HEADER];
  for (const row of block.rows) {
    const from = placeOf(
      row.fromObject.code,
      row.fromLocation,
      stateOf(row.fromState, row.fromStateNote),
    );
    const to = placeOf(row.toObject.code, row.toLocation, stateOf(row.toState, row.toStateNote));
    rows.push([
      ru(row.movedOn),
      joined([
        `${from} → ${to}`,
        `Отдел: ${row.fromDepartment?.name ?? 'не закреплена'} → ${row.toDepartment?.name ?? 'не закреплена'}`,
      ]),
      joined([
        row.reason,
        row.comment,
        row.serviceRequestNum !== null && `СО-${row.serviceRequestNum}`,
        row.confirmsDeclaredPlace && 'Место подтверждено',
      ]),
      row.movedByName || '—',
    ]);
  }
  if (block.truncated) rows.push(noticeRow(MOVEMENTS_HEADER.length, 1, BLOCK_TRUNCATED));

  return { name: SHEET_TITLES.movements, rows, widths: [12, 60, 44, 24], freezeHeader: true };
}

// ── Книга ──

/**
 * Всё, что печатает книга. Собранным заранее, а не принципалом и картой: сборка листов ничего не
 * решает про доступ — она печатает уже отобранное, и проверить её можно без базы, чем §10.3 и
 * пользуется.
 */
export interface EquipmentHistoryBookData {
  events: EquipmentHistoryEventDto[];
  eventsTruncated: boolean;
  /** `null` — у читателя нет `serviceRequests.read`, и сервисных данных на листе не будет ни одной. */
  requests: { rows: EquipmentRequestRowDto[]; truncated: boolean } | null;
  changes: { rows: EquipmentChangeRowDto[]; truncated: boolean };
  movements: { rows: EquipmentMovementRowDto[]; truncated: boolean };
}

/**
 * Книга из четырёх листов. Порядок листов — порядок вкладок экрана: открывший файл видит первым то
 * же, что видит первым, открыв историю.
 */
export function equipmentHistoryBookWorkbook(data: EquipmentHistoryBookData): Uint8Array {
  return writeWorkbook([
    requestsSheet(data.requests),
    changesSheet(data.changes),
    movementsSheet(data.movements),
    fullHistorySheet(data.events, data.eventsTruncated),
  ]);
}

/**
 * Выгрузка целиком: те же четыре выборки, что кормят четыре вкладки, и тот же потолок.
 *
 * ПОТОЛОК ОДИН НА ВСЕ ЧЕТЫРЕ ЛИСТА — `EQUIPMENT_HISTORY_EXPORT_LIMIT`, тот самый, которым сегодня
 * ограничена лента: страницами отчёт не собирают (инвентаризация требует всей истории разом), но и
 * тянуть без предела нельзя. Упёршийся в потолок лист говорит об этом последней строкой — каждый
 * про себя, потому что предел у каждого свой и «есть ли ещё» каждый блок знает точно.
 *
 * ПРАВО СПРАШИВАЕТСЯ ТЕМ ЖЕ `can`, ЧТО И У ЛЕНТЫ: без `serviceRequests.read` заявки не читаются
 * вовсе — ни строкой, ни ради счётчика, — и лист остаётся с одной объясняющей строкой. Область
 * заявок и область карточки внутри выборок прежние: выгрузка не расширяет их ни на строку.
 *
 * `rows` и `truncated` наружу — для записи аудита о выгрузке: она считает событиями ленты, как и
 * до появления трёх листов, иначе метрика «сколько выгрузили» сменила бы смысл задним числом.
 */
export async function equipmentHistoryBook(
  p: Principal,
  equipment: {
    id: string;
    name: string;
    inventoryNumber: string;
    serialNumber: string;
    warrantyUntil: string | null;
    objectId: string;
  },
): Promise<{ bytes: Uint8Array; rows: number; truncated: boolean }> {
  const opts = { cursor: null, pageSize: EQUIPMENT_HISTORY_EXPORT_LIMIT };
  const [feed, requests, changes, movements] = await Promise.all([
    loadEquipmentHistoryAll(p, equipment, EQUIPMENT_HISTORY_EXPORT_LIMIT),
    can(p, 'serviceRequests.read')
      ? loadEquipmentRequestsPage(p, { id: equipment.id, objectId: equipment.objectId }, opts)
      : null,
    loadEquipmentChangesPage(equipment.id, opts),
    loadEquipmentMovementsPage(equipment.id, opts),
  ]);

  const bytes = equipmentHistoryBookWorkbook({
    events: feed.items,
    eventsTruncated: feed.truncated,
    requests: requests && { rows: requests.items, truncated: requests.hasMore },
    changes: { rows: changes.items, truncated: changes.hasMore },
    movements: { rows: movements.items, truncated: movements.hasMore },
  });
  return { bytes, rows: feed.items.length, truncated: feed.truncated };
}

/**
 * ПЕРЕХОДНАЯ однолистовая выгрузка: её всё ещё зовёт маршрут `history.xlsx`.
 *
 * Остаётся здесь ровно до того выката, в котором маршрут перейдёт на {@link equipmentHistoryBook}:
 * книгу нельзя собрать без принципала (лист заявок отбирается областью читателя), а принципал
 * приходит только из маршрута — то есть переключение обязано быть правкой самого маршрута, и
 * сводится оно к одной строке `const { bytes, rows, truncated } = await equipmentHistoryBook(p,
 * equipment)` вместо пары «загрузить ленту — собрать книгу».
 *
 * Своей правды у неё нет — лист собирает та же {@link fullHistorySheet}, — поэтому разойтись с
 * книгой она не может; отличается только именем листа, которое до плана несло модель аппарата.
 */
export function equipmentHistoryWorkbook(
  equipment: { name: string; inventoryNumber: string; serialNumber: string },
  events: EquipmentHistoryEventDto[],
  truncated: boolean,
): Uint8Array {
  const sheet = fullHistorySheet(events, truncated);
  return writeWorkbook([
    { ...sheet, name: `История ${officeEquipmentTitle(equipment)}`.slice(0, 31) },
  ]);
}
