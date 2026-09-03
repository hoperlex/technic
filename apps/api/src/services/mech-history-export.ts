import {
  dateKeySpan,
  formatMechRequestNumber,
  mechRateUnitLabels,
  mechRequesterOf,
  type MechRequestDto,
  type MechRequestHistorySummaryDto,
  requestStatusLabels,
} from '@technic/contracts';
import { writeWorkbook } from '../lib/xlsx';

/**
 * Выгрузка журнала закрытых аренд механизации (план `docs/mechanization-module-plan.md`, Э3).
 *
 * Книга собирается **той же выборкой и той же областью**, что экран: расхождение здесь означало бы
 * файл, показывающий больше, чем портал, — то есть утечку через выгрузку. Поэтому строки приезжают
 * сюда готовыми DTO журнала, а не собираются вторым запросом.
 *
 * Отработанное разложено по ДВУМ колонкам — «ч» и «смен», — и это то же решение, что и в итоге
 * (Э3): ставка задаётся за час либо за смену (Р7), одна колонка сложила бы их в «120», которое не
 * значит ничего. Разложенные по колонкам, они складываются каждая сама с собой — и итоговой
 * строкой, и рукой в редакторе таблиц.
 */

/**
 * Потолок строк. Журнал выгружают целиком, без страниц: файл сверяют со счетами арендодателей, а
 * отчёт, у которого «есть ещё», для сверки не годится. Но запрос за все годы обязан упереться в
 * число, а не в память процесса, — и, упёршись, сказать об этом последней строкой.
 */
export const MECH_HISTORY_EXPORT_LIMIT = 5000;

/** Календарный день человеку: `2026-09-04` → «04.09.2026»; через `Date` он поехал бы на день. */
function ru(dateKey: string | null): string {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-');
  return y && m && d ? `${d}.${m}.${y}` : dateKey;
}

/** Деньги — с копейками всегда: «9600» и «9600.00» в одном столбце читаются как разные величины. */
function money(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

/** Число без хвоста: отработанное бывает и дробным («2,5 смены»), и целым («8 ч»). */
function amount(value: number | null): string {
  return value === null ? '' : String(value);
}

const HEADER = [
  '№',
  'Статус',
  'Заявитель',
  'Площадка',
  'Модель',
  'Арендодатель',
  'Ставка, ₽',
  'Единица ставки',
  'План с',
  'План по',
  'Выдана',
  'Возвращена',
  'Дней',
  'Отработано, ч',
  'Отработано, смен',
  'Стоимость, ₽',
  'Ответственный',
  'Комментарий',
  'Автор',
];

/** Столько ячеек в строке — служебные строки книги обязаны быть той же ширины, что и шапка. */
const EMPTY_ROW = HEADER.map(() => '');

function rowOf(request: MechRequestDto): string[] {
  const hour = request.rateUnit === 'hour';
  return [
    formatMechRequestNumber(request.num),
    requestStatusLabels[request.status],
    // Заявитель выводится, а не хранится (Р20): отдел, если он заполнен, иначе площадка.
    mechRequesterOf(request)?.name ?? '',
    // Площадка кодом и наименованием: по коду её ищут в счёте, по наименованию узнают.
    [request.objectCode, request.objectName].filter(Boolean).join(' · '),
    // Модель из справочника (ADR 0156). У заявки старше Э2, не нашедшей своей модели, ячейка
    // ПУСТА: уборка Э3 сняла написания по решению заказчика, и подставить сюда больше нечего.
    // Пустая ячейка в книге, которую сверяют со счетами, читается как «предмет аренды не назван» —
    // так оно и есть; выдумывать заполнение вместо этого значило бы прятать цену того решения.
    request.mechModelName ?? '',
    request.lessorName ?? '',
    money(request.rate),
    request.rateUnit ? mechRateUnitLabels[request.rateUnit] : '',
    ru(request.plannedFrom),
    ru(request.plannedTo),
    ru(request.actualFrom),
    ru(request.actualTo),
    // Дни — той же функцией, что и итог: включительно, «с 1-го по 1-е» это один день. У отменённой
    // заявки фактических дат нет вовсе, и колонка у неё пуста, а не «0».
    request.actualFrom && request.actualTo
      ? String(dateKeySpan(request.actualFrom, request.actualTo))
      : '',
    hour ? amount(request.actualUnits) : '',
    request.rateUnit === 'shift' ? amount(request.actualUnits) : '',
    money(request.finalCost),
    request.responsibleName,
    request.comment,
    request.createdByName,
  ];
}

/**
 * Итоговая строка — тот же итог, что и над таблицей в портале, включая раздельные часы и смены.
 * Числом, а не формулой: книгу открывают и в LibreOffice, и в просмотрщике почты, и число обязано
 * быть числом, а не пересчитываться при открытии.
 *
 * Счётчики стоят в первых текстовых колонках со СВОИМ словом каждый: «закрытых», «аренд»,
 * «отменено» отвечают на разные вопросы, и цифра без подписи в чужой колонке читалась бы как номер
 * заявки.
 */
function totalsRow(summary: MechRequestHistorySummaryDto): string[] {
  const row = [...EMPTY_ROW];
  row[0] = 'Итого';
  row[1] = `закрытых: ${summary.closed}`;
  row[2] = `аренд: ${summary.rentals}`;
  row[3] = `отменено: ${summary.cancelled}`;
  row[12] = String(summary.days);
  row[13] = String(summary.hours);
  row[14] = String(summary.shifts);
  row[15] = summary.cost;
  return row;
}

export interface MechHistoryExportInput {
  rows: MechRequestDto[];
  summary: MechRequestHistorySummaryDto;
  /** Строк в отборе больше потолка: показаны не все, и книга обязана это сказать. */
  truncated: boolean;
  /** Границы фильтра «Период» — они же различают два файла, выгруженных подряд. */
  periodFrom?: string;
  periodTo?: string;
}

export function mechHistoryWorkbook(input: MechHistoryExportInput): {
  filename: string;
  bytes: Uint8Array;
} {
  const rows: string[][] = [HEADER, ...input.rows.map(rowOf), totalsRow(input.summary)];

  // Обрезанный отчёт обязан говорить, что он обрезан: молча урезанная выгрузка читается как весь
  // журнал, и спор с арендодателем строят на ней. Итог при этом верный — он считается по всему
  // отбору, тем же запросом, что и сводка над таблицей.
  if (input.truncated) {
    const note = [...EMPTY_ROW];
    note[2] =
      'Показаны не все строки: выгрузка ограничена по объёму. Итог посчитан по всему отбору';
    rows.push(note);
  }

  const period = [input.periodFrom, input.periodTo].filter(Boolean).join(' – ');
  return {
    filename: `Механизация, журнал закрытых${period ? ` ${period}` : ''}.xlsx`,
    bytes: writeWorkbook([
      {
        name: 'Журнал закрытых',
        rows,
        widths: [10, 12, 24, 28, 24, 24, 12, 14, 12, 12, 12, 12, 8, 14, 16, 14, 22, 40, 24],
        freezeHeader: true,
      },
    ]),
  };
}
