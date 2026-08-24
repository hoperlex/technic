import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  formatServiceRequestNumber,
  officeEquipmentTitle,
  type OfficeEquipmentConsumableUsageDto,
  type OfficeEquipmentConsumableUsageQuery,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipment,
  officeEquipmentConsumableStockEntries,
  officeEquipmentConsumables,
  serviceRequests,
  users,
} from '../db/schema';
import { writeWorkbook } from '../lib/xlsx';

/**
 * Отчёт по расходу расходников за период (наброски `office-equipment-requests-rework-draft.md`,
 * Р10; опрос В18; план переработки заявок, §7.3).
 *
 * ОДИН ИСТОЧНИК С ОСТАТКОМ, И ЭТО ГЛАВНОЕ РЕШЕНИЕ ФАЙЛА. Расход считается по журналу движения
 * склада — сумма событий `issue` за вычетом `return`, — то есть ровно по тем строкам, которыми
 * двигается сам остаток. Соблазн посчитать иначе велик и выглядит проще: в строке заявки лежит
 * готовое `issued_quantity`, и «сумма выданного по заявкам периода» пишется одним `sum`. Но это
 * второй счётчик, и разойдётся он с остатком на первом же сторно: правка факта вниз (В23, Р6) не
 * переписывает историю, а дописывает событие `return` на разницу, и строка заявки после неё знает
 * только итог. Отчёт по строкам показал бы «выдано 2» там, где со склада ушло 3 и вернулась 1, —
 * в сумме то же самое, но в периоде, где выдача и возврат разъехались по месяцам, суммы разные, и
 * сверять такой отчёт с остатком нечем.
 *
 * ОБЛАСТИ У ОТЧЁТА НЕТ — намеренно, и это следствие того же решения. Остаток на складе один на
 * компанию и виден всякому, у кого есть `officeEquipment.read` (Р10 плана расходников): склад не
 * разложен по площадкам. Отчёт — это разложение того же остатка по причинам его движения, и сузь
 * мы его областью смотрящего, он перестал бы сходиться с числом, которое тот же человек видит в
 * справочнике. Счётчик парка в карточке позиции — обратный случай (там область есть), и разница
 * не в аккуратности, а в предмете: парк стоит по площадкам, склад — нет.
 *
 * СТРОКА ОТЧЁТА — «заявка × позиция × человек» (см. контракт): не событие и не строка заявки.
 */

/**
 * Потолок строк. Отчёт собирается целиком, без страниц: его выгружают файлом и сверяют со счетами,
 * а отчёт, у которого «есть ещё», для сверки не годится. Но полугодовой запрос по большому складу
 * обязан упереться в число, а не в память процесса, — и, упёршись, сказать об этом (`truncated`).
 *
 * Итоги при этом считаются по всему периоду отдельным запросом: обрезанный список с обрезанной
 * суммой читался бы как весь расход.
 */
export const CONSUMABLE_USAGE_LIMIT = 5000;

/** Полночь начала и конец последних суток периода по Москве. */
function periodBounds(from: string, to: string): { fromAt: Date; toAt: Date } {
  return {
    // Границы суток заданы явно и по Москве: `created_at` хранит момент времени, и «с 1 августа»
    // по UTC отрезало бы утро первого числа (тот же приём, что у отбора учёток по дате).
    fromAt: new Date(`${from}T00:00:00.000+03:00`),
    toAt: new Date(`${to}T23:59:59.999+03:00`),
  };
}

/**
 * Отбор событий: только движение по заявкам и только внутри периода.
 *
 * Ручная правка кладовщика (`manual`) в расход не идёт. Она тоже двигает остаток, но отвечает на
 * другой вопрос — «пересчитали полку», «приняли поставку», — и, попав в отчёт, превратила бы
 * приход в отрицательный расход. Что ручных правок в журнале нет вовсе, отчёт не предполагает:
 * их там ровно столько же, сколько выдач.
 */
function usageWhere(query: OfficeEquipmentConsumableUsageQuery): SQL | undefined {
  const { fromAt, toAt } = periodBounds(query.from, query.to);
  return and(
    inArray(officeEquipmentConsumableStockEntries.entryKind, ['issue', 'return']),
    gte(officeEquipmentConsumableStockEntries.createdAt, fromAt),
    lte(officeEquipmentConsumableStockEntries.createdAt, toAt),
    query.consumableId
      ? eq(officeEquipmentConsumableStockEntries.consumableId, query.consumableId)
      : undefined,
  );
}

/**
 * Сколько штук ушло и сколько вернулось. Направление берётся из ВИДА события, а не из знака
 * разницы: `CHECK` `…direction_check` держит их согласованными (`issue` уменьшает остаток,
 * `return` увеличивает), и считать по знаку значило бы завести вторую копию того же правила —
 * ту, которая молча разойдётся с первой, если вид когда-нибудь добавят.
 */
const issuedExpr = sql<number>`sum(CASE WHEN ${officeEquipmentConsumableStockEntries.entryKind} = 'issue'
    THEN ${officeEquipmentConsumableStockEntries.quantityBefore} - ${officeEquipmentConsumableStockEntries.quantityAfter}
    ELSE 0 END)::int`;
const returnedExpr = sql<number>`sum(CASE WHEN ${officeEquipmentConsumableStockEntries.entryKind} = 'return'
    THEN ${officeEquipmentConsumableStockEntries.quantityAfter} - ${officeEquipmentConsumableStockEntries.quantityBefore}
    ELSE 0 END)::int`;
/** Позднейшее событие группы: по нему отчёт упорядочен и по нему же читается «когда это было». */
const lastAtExpr = sql<Date>`max(${officeEquipmentConsumableStockEntries.createdAt})`;

export async function loadConsumableUsage(
  query: OfficeEquipmentConsumableUsageQuery,
): Promise<OfficeEquipmentConsumableUsageDto> {
  const where = usageWhere(query);

  const [rows, totals] = await Promise.all([
    db
      .select({
        requestId: serviceRequests.id,
        num: serviceRequests.num,
        equipmentId: officeEquipment.id,
        equipmentName: officeEquipment.name,
        inventoryNumber: officeEquipment.inventoryNumber,
        serialNumber: officeEquipment.serialNumber,
        consumableId: officeEquipmentConsumables.id,
        code: officeEquipmentConsumables.code,
        name: officeEquipmentConsumables.name,
        color: officeEquipmentConsumables.color,
        actorName: users.fullName,
        issued: issuedExpr,
        returned: returnedExpr,
        at: lastAtExpr,
      })
      .from(officeEquipmentConsumableStockEntries)
      /*
       * Все соединения внутренние, и ни одно из них строк не теряет: у события вида `issue`/`return`
       * ссылка на заявку обязательна (`…request_links_check`) и стоит внешним ключом, заявка всегда
       * привязана к единице техники, а автор события — `NOT NULL` с `RESTRICT`. Поэтому итоги,
       * посчитанные по голой таблице журнала (ниже), сходятся с суммой строк отчёта.
       */
      .innerJoin(
        officeEquipmentConsumables,
        eq(officeEquipmentConsumableStockEntries.consumableId, officeEquipmentConsumables.id),
      )
      .innerJoin(
        serviceRequests,
        eq(officeEquipmentConsumableStockEntries.serviceRequestId, serviceRequests.id),
      )
      .innerJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
      .innerJoin(users, eq(officeEquipmentConsumableStockEntries.changedBy, users.id))
      .where(where)
      // Группировка по ключам таблиц, а не по всем показанным колонкам: остальные поля от них
      // функционально зависят, и Postgres это знает — перечисление наименований в `GROUP BY`
      // только прятало бы, по чему на самом деле идёт свёртка.
      .groupBy(serviceRequests.id, officeEquipment.id, officeEquipmentConsumables.id, users.id)
      // Свежее сверху — как всякая лента портала. Второй и третий ключи не украшение: у выдачи по
      // одной заявке время события совпадает до миллисекунды, и без них порядок строк менялся бы
      // от прогона к прогону, то есть файл, выгруженный дважды, различался бы.
      .orderBy(desc(lastAtExpr), desc(serviceRequests.num), asc(officeEquipmentConsumables.code))
      .limit(CONSUMABLE_USAGE_LIMIT + 1),
    db
      .select({ issued: issuedExpr, returned: returnedExpr })
      .from(officeEquipmentConsumableStockEntries)
      .where(where),
  ]);

  const truncated = rows.length > CONSUMABLE_USAGE_LIMIT;
  return {
    from: query.from,
    to: query.to,
    rows: rows.slice(0, CONSUMABLE_USAGE_LIMIT).map((row) => ({
      requestId: row.requestId,
      displayNumber: formatServiceRequestNumber(row.num),
      equipmentId: row.equipmentId,
      equipmentName: row.equipmentName,
      equipmentInventoryNumber: row.inventoryNumber,
      equipmentSerialNumber: row.serialNumber,
      consumableId: row.consumableId,
      code: row.code,
      name: row.name,
      color: row.color,
      issued: row.issued,
      returned: row.returned,
      quantity: row.issued - row.returned,
      actorName: row.actorName,
      at: row.at.toISOString(),
    })),
    // Пустой период даёт `NULL` в обеих суммах — это «ничего не двигали», а не «неизвестно».
    totalIssued: totals[0]?.issued ?? 0,
    totalReturned: totals[0]?.returned ?? 0,
    truncated,
  };
}

/** Дата события в человеческом виде: файл читают рядом с накладными, где дата русская. */
function ru(at: string): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  // По Москве, как и границы периода: файл, где событие 1 августа помечено 31 июля, спорит сам с
  // собой — оно попало в отбор именно как августовское.
  const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`;
}

const HEADER = [
  'Дата',
  'Заявка',
  'Аппарат',
  'Код',
  'Позиция',
  'Цвет',
  'Выдано',
  'Возврат',
  'Расход',
  'Кто выдал',
];

/**
 * Книга отчёта — теми же строками и в том же порядке, что и экран (Р80 у соседней выгрузки, и по
 * той же причине): файл, показывающий не то, что портал, спорит с ним, а спор разбирают глазами.
 *
 * Итог отдельной строкой внизу, а не суммой формулой: книгу открывают и в LibreOffice, и в
 * просмотрщике почты, и число обязано быть числом, а не пересчитываться при открытии.
 */
export function consumableUsageWorkbook(report: OfficeEquipmentConsumableUsageDto): {
  filename: string;
  bytes: Uint8Array;
} {
  const period = report.from === report.to ? report.from : `${report.from} – ${report.to}`;
  const rows: string[][] = [
    HEADER,
    ...report.rows.map((row) => [
      ru(row.at),
      row.displayNumber,
      officeEquipmentTitle({
        name: row.equipmentName,
        inventoryNumber: row.equipmentInventoryNumber,
        serialNumber: row.equipmentSerialNumber,
      }),
      row.code,
      row.name,
      row.color ?? '',
      String(row.issued),
      String(row.returned),
      String(row.quantity),
      row.actorName,
    ]),
    [
      'Итого за период',
      '',
      '',
      '',
      '',
      '',
      String(report.totalIssued),
      String(report.totalReturned),
      String(report.totalIssued - report.totalReturned),
      '',
    ],
  ];

  // Обрезанный отчёт обязан говорить, что он обрезан: молча урезанная выгрузка читается как полная,
  // и заказ на квартал составят по ней. Итог при этом верный — он считается по всему периоду.
  if (report.truncated) {
    rows.push([
      '',
      '',
      'Показаны не все строки: выгрузка ограничена по объёму. Итог посчитан по всему периоду',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  }

  return {
    filename: `Расход расходников ${period}.xlsx`,
    bytes: writeWorkbook([
      {
        name: `Расход ${period}`.slice(0, 31),
        rows,
        widths: [17, 12, 40, 16, 40, 14, 9, 9, 9, 24],
        freezeHeader: true,
      },
    ]),
  };
}
