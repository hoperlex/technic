import type { DriverReportDto } from '@technic/contracts';
import type { DraftFile, DraftItem } from './api';
import type { DraftChange, DraftPatch, DraftView } from './draftStore';
import type { TransferTarget } from './DriverOrphanBlock';

/**
 * Черновик глазами формы показаний: чем строка адресуется, что показать в полях и что делать с
 * записью, которая ни к какой строке не привязалась (план кабинета водителя — Р11, Р14, Р14а).
 *
 * Отдельным модулем от страницы не по смыслу, а по размеру: вместе они переваливают за 400
 * строк — порог бюджета качества (`scripts/quality.mjs`). Граница проведена там, где она честная:
 * здесь чистые превращения «отчёт + черновик → то, что на экране», там — запись, сеть и порядок
 * шагов при отказе хранилища.
 */

export const emptyItem = (): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  fuelFilledLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
});

/**
 * Ключ строки черновика — источник выезда, а не `itemId` (Р11). Перенос источника между
 * черновиками пересоздаёт строку ожидания с другим идентификатором, а рейс остаётся тем же
 * рейсом: по `itemId` введённое терялось от одного нажатия чужого водителя.
 *
 * Тем же ключом строка ожидания сходится со строкой задания: `itemId` в задании появляется только
 * после открытия отчёта, а `sourceKind` с `sourceId` есть в обоих всегда.
 */
export const sourceKey = (entry: { sourceKind: string; sourceId: string }): string =>
  `${entry.sourceKind}:${entry.sourceId}`;

/** Число из уже сохранённого показания — обратно в строку поля. */
const show = (value: number | null): string => (value === null ? '' : String(value));

/**
 * Что показать в блоках: сохранённое сервером, поверх — незавершённый черновик. Черновик главнее
 * намеренно: он новее отправленного и содержит именно то, что не доехало.
 */
export function seedValues(
  report: DriverReportDto,
  draft: DraftView['items'],
): Record<string, DraftItem> {
  const values: Record<string, DraftItem> = {};
  for (const item of report.items) {
    const reading = item.reading;
    // Строка, закрытая персоналом видом `no_data`, приходит без чисел — и поля остаются пустыми:
    // причину её закрытия водитель читает, но не редактирует (Р4).
    const base: DraftItem = reading
      ? {
          odometerKm: show(reading.odometerKm),
          engineHours: show(reading.engineHours),
          fuelFilledLiters: show(reading.fuelFilledLiters),
          comment: reading.comment,
          // Уже привязанные файлы сюда не попадают: отправка принимает только непривязанные
          // (Р18), и повтор их идентификаторов был бы отказом сервера.
          files: [],
          // Подтверждение не наследуется от прошлой отправки: подтверждают показанную аномалию,
          // а показывают её заново — вместе с числами, к которым она относится.
          confirmAnomaly: false,
        }
      : emptyItem();
    const key = sourceKey(item);
    values[key] = draft[key]?.item ?? base;
  }
  return values;
}

/**
 * Введённое, потерявшее свою строку (Р14): источник ушёл из отчёта, `itemId` сменился между
 * сохранением и открытием, запись пришла из прежнего формата. Отбросить её нельзя — она
 * единственная копия того, что человек ввёл, — а угадать, к какому рейсу относились цифры, портал
 * не имеет права.
 */
export interface Orphan {
  /** Ключ отрисовки; он же различает две записи, показанные рядом. */
  id: string;
  item: DraftItem;
  savedAt: number;
  /** Откуда взялась: страница сопоставляла ключи и знает это, блок текст не выдумывает. */
  origin: string;
  /**
   * Чем гасится источник в той же записи, что кладёт значение цели (Р14а п. 4). Своя строка — её
   * надгробием: удали её из ветки просто так, и слияние вернуло бы её из соседней. Чужой формат
   * трогать нечем вовсе — новая сборка в него не пишет, и запись гасится пометкой в журнале.
   */
  erase: Pick<DraftPatch, 'items' | 'legacy'>;
}

export function orphansOf(report: DriverReportDto | null, draft: DraftView): Orphan[] {
  // Отчёта может не быть вовсе — день без строк тоже показывает введённое: «неизвестно, к чему
  // это относилось» не равно «этого не было» (Р14).
  const known = new Set((report?.items ?? []).map(sourceKey));
  const rows: Orphan[] = Object.entries(draft.items)
    .filter(([key]) => !known.has(key))
    .map(([key, row]) => ({
      id: key,
      item: row.item,
      savedAt: row.savedAt,
      origin: 'Строка ушла из задания',
      erase: { items: [{ key, item: null }] },
    }));
  const legacy: Orphan[] = draft.legacy.map((record) => ({
    id: `legacy:${record.itemId}`,
    item: record.item,
    savedAt: record.savedAt,
    origin: 'Введено в прежней версии портала',
    erase: { legacy: [record.fingerprint] },
  }));
  return [...rows, ...legacy];
}

/** Пустая запись — это отсутствие записи: занятой цель делает введённое, а не сам факт строки. */
const filled = (item: DraftItem): boolean =>
  Boolean(item.odometerKm || item.engineHours || item.fuelFilledLiters || item.comment) ||
  item.files.length > 0;

/**
 * Куда переносить разрешено (Р14а п. 1). Цель — только строка, открытую правку которой водитель
 * имеет: перенос в принятый или аннулированный день сменил бы ключ записи, блок исчез бы как
 * «сопоставленный», а показать его содержимое было бы уже нечем. Отвечает за это `submittable`
 * состояния дня — тот же признак, которым живёт кнопка «Передать».
 */
export function transferTargets(
  report: DriverReportDto,
  values: Record<string, DraftItem>,
  allowed: boolean,
): TransferTarget[] {
  if (!allowed) return [];
  return report.items.map((item) => {
    const key = sourceKey(item);
    const current = values[key];
    return {
      key,
      label: `${item.sourceLabel} · ${item.vehicleLabel}`,
      occupied: current && filled(current) ? current : null,
    };
  });
}

/**
 * Что записать переносом и какие файлы после этого удалить (Р14а п. 3, п. 4).
 *
 * Значение цели и гашение источника собираются ОДНОЙ правкой: порознь они дали бы либо задвоение,
 * либо потерю (Р11г). Подтверждение аномалии сбрасывается — подтверждают показанное, а показывают
 * его заново. Файлы здесь не удаляются, а возвращаются: порядок жёсткий — сначала запись черновика,
 * и только при её успехе снимки, вытесненные заменой (Р14а п. 5).
 */
export function transferPatch(
  orphan: Orphan,
  targetKey: string,
  replace: boolean,
  values: Record<string, DraftItem>,
): { patch: DraftPatch; displaced: readonly DraftFile[] } {
  return {
    patch: {
      items: [
        { key: targetKey, item: { ...orphan.item, confirmAnomaly: false } },
        ...(orphan.erase.items ?? []),
      ],
      legacy: orphan.erase.legacy,
    },
    displaced: replace ? (values[targetKey]?.files ?? []) : [],
  };
}

/**
 * Введённое, но не переданное (Р10): значения строк, которые в отчёте есть, а в учёт не попали.
 *
 * Отдельным списком, а не подменой значений полей, потому что показывать их надо РЯДОМ с числами
 * сервера: окно записи закрыто, сдать день водитель уже не может — но продиктовать свои цифры
 * диспетчеру обязан мочь, и для этого нужны оба числа сразу. Стереть их за него значило бы
 * уничтожить данные ради чистоты состояния.
 *
 * Пустая запись сюда не попадает: «ничего не введено» — не новость, а лишняя тревога на экране.
 */
export interface PendingRow {
  /** `itemId` строки отчёта: пометка стоит у своего блока, а не общим списком под формой. */
  itemId: string;
  /** Числа и комментарий одной строкой: отдельными полями они заняли бы экран второй формой. */
  text: string;
  savedAt: number;
}

/** Числа введённого — словами и с единицами: читают их глазами, а не сверяют по подписям полей. */
function pendingText(item: DraftItem): string {
  const parts: string[] = [];
  if (item.odometerKm) parts.push(`одометр ${item.odometerKm} км`);
  if (item.engineHours) parts.push(`моточасы ${item.engineHours} ч`);
  if (item.fuelFilledLiters) parts.push(`заправлено ${item.fuelFilledLiters} л`);
  if (item.comment) parts.push(item.comment);
  if (item.files.length > 0) parts.push(`файлов: ${item.files.length}`);
  return parts.join(' · ');
}

export function pendingRows(
  report: DriverReportDto | null,
  draft: DraftView['items'],
): Map<string, PendingRow> {
  const rows = (report?.items ?? []).flatMap((item) => {
    const row = draft[sourceKey(item)];
    return row && filled(row.item)
      ? [[item.id, { itemId: item.id, text: pendingText(row.item), savedAt: row.savedAt }] as const]
      : [];
  });
  return new Map(rows);
}

/**
 * Чем успешная отправка гасит свои строки (Р12). Надгробием, а не удалением из ветки: вычеркнутая
 * строка вернулась бы из соседней при следующем слиянии (Р11г). Общей очисткой дня тоже нельзя —
 * она унесла бы вместе с ними введённое по источнику, которого в отчёте уже нет (Р14).
 *
 * Часы берутся из снимка, сделанного ПЕРЕД запросом: пока он был в пути, строку могли переписать,
 * и такая правка сделана позже отправленной. Разошлись часы — строка остаётся значением и уйдёт
 * следующей попыткой, со своим ключом (Р12а).
 */
export function sentTombstones(
  report: DriverReportDto,
  sentIds: ReadonlySet<string>,
  sent: DraftView,
): DraftChange[] {
  return report.items
    .filter((item) => sentIds.has(item.id))
    .flatMap((item) => {
      const key = sourceKey(item);
      const row = sent.items[key];
      // Строки, которой в черновике не было вовсе, гасить нечем: её числа пришли из отчёта.
      return row ? [{ key, item: null, ifClock: row.clock }] : [];
    });
}
