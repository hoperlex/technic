import { Button, InputNumber, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import {
  officeEquipmentPurchaseStatusLabels,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentPurchaseItemDto,
  type OfficeEquipmentPurchaseItemInput,
  type OfficeEquipmentPurchasePrefillRowDto,
  type OfficeEquipmentPurchaseRefDto,
  type OfficeEquipmentPurchaseSnapshotConflictDto,
} from '@technic/contracts';

/**
 * Строка формы плановой закупки: позиция, количество и СНИМОК РАСЧЁТА, из которого это количество
 * вышло (план `docs/office-equipment-consumables-and-purchase-plan.md`, Р16, Р17).
 *
 * Снимок здесь не для показа, а для сверки: сервер пересчитывает те же три числа под блокировкой и
 * сравнивает их с присланными. Взял бы он свои же свежие — сверял бы их сам с собой. Поэтому три
 * числа едут в форму, живут в её состоянии и возвращаются обратно нетронутыми, а «предложено»
 * среди них нет: оно выводится из трёх первых одной формулой, и четвёртое присланное число могло
 * бы им противоречить.
 */
export interface PurchaseFormRow {
  consumableId: string;
  code: string;
  name: string;
  color: string | null;
  /** Потребность, какой её видел человек. */
  required: number;
  /** Остаток, каким его видел человек. */
  stock: number;
  /** «Уже заказано» открытыми закупками, каким его видел человек. */
  alreadyOrdered: number;
  /** `max(0, потребность − остаток − уже заказано)` на тот же момент. */
  suggested: number;
  /** Сколько заказываем: предложенное человек мог поправить. */
  quantity: number;
  /** Открытые закупки по этой позиции — «заказ уже идёт» (Р15). */
  openPurchases: OfficeEquipmentPurchaseRefDto[];
  /**
   * Числа, которые человек видел ДО ответа 409 по снимку; `null` — снимок не переспрашивали.
   *
   * Хранится вместе со строкой, а не отдельным списком «что изменилось»: показать надо именно
   * «было → стало» в той строке, где это произошло, а список сбоку человек сопоставлял бы с
   * таблицей глазами.
   */
  stale: { required: number; stock: number; alreadyOrdered: number } | null;
}

/** Строка предзаполнения — то, что портал предлагает заказать (Р16): количество равно «к закупке». */
export function rowFromPrefill(row: OfficeEquipmentPurchasePrefillRowDto): PurchaseFormRow {
  return {
    consumableId: row.consumableId,
    code: row.code,
    name: row.name,
    color: row.color,
    required: row.required,
    stock: row.stock,
    alreadyOrdered: row.alreadyOrdered,
    suggested: row.suggested,
    quantity: row.suggested,
    openPurchases: row.openPurchases,
    stale: null,
  };
}

/**
 * Строка, дописанная руками подбором по справочнику (Р16).
 *
 * Снимок берётся из самой позиции: те же три числа стоят в её строке перечня, считает их тот же
 * сервер тем же выражением. Количество — «к закупке», а если заказывать нечего (позиция добавлена
 * сверх дефицита), то единица: строка с нулём схему не пройдёт, а «добавил и не заказал» — это не
 * строка, а её отсутствие.
 */
export function rowFromConsumable(c: OfficeEquipmentConsumableDto): PurchaseFormRow {
  return {
    consumableId: c.id,
    code: c.code,
    name: c.name,
    color: c.color,
    required: c.requiredQuantity,
    stock: c.quantity,
    alreadyOrdered: c.alreadyOrdered,
    suggested: c.deficit,
    quantity: c.deficit > 0 ? c.deficit : 1,
    openPurchases: [],
    stale: null,
  };
}

/**
 * Строка заведённой закупки — для правки черновика (Р18).
 *
 * СНИМОК БЕРЁТСЯ ИЗ САМОЙ СТРОКИ, а не считается заново, и это не экономия запроса. Снимок в
 * строке записан на том же основании, на котором сервер сверяет правку: собственный вклад закупки
 * из «уже заказано» вычтен и там, и там. Значит, пока склад не двигался, присланное сойдётся точно;
 * а если двигался — сервер ответит 409 с новыми числами, и это ровно тот разговор, ради которого
 * протокол и заведён.
 */
export function rowFromItem(item: OfficeEquipmentPurchaseItemDto): PurchaseFormRow {
  return {
    consumableId: item.consumableId,
    code: item.code,
    name: item.name,
    color: item.color,
    required: item.requiredSnapshot,
    stock: item.stockSnapshot,
    alreadyOrdered: item.alreadyOrderedSnapshot,
    suggested: item.suggestedQuantity,
    quantity: item.quantity,
    openPurchases: [],
    stale: null,
  };
}

/** Тело запроса: количество и три числа снимка — ровно то, что сверяет сервер (Р17, шаг 0). */
export function toItemsInput(rows: PurchaseFormRow[]): OfficeEquipmentPurchaseItemInput[] {
  return rows.map((r) => ({
    consumableId: r.consumableId,
    quantity: r.quantity,
    expectedRequired: r.required,
    expectedStock: r.stock,
    expectedAlreadyOrdered: r.alreadyOrdered,
  }));
}

/**
 * Ответ 409 по снимку переписывает числа строк на сегодняшние (Р17, шаг 6).
 *
 * КОЛИЧЕСТВО ПРИ ЭТОМ НЕ ТРОГАЕТСЯ, и это решение, а не упущение. Человек уже принял решение
 * «заказать двенадцать»; новые числа могут его изменить, а могут и нет — осознанное превышение
 * разрешено. Подставь портал `actualSuggested` в поле, он молча отменил бы чужое решение ровно в
 * тот момент, когда просит его перепроверить.
 *
 * Отдельной галочки «подтверждаю» при этом нет: повторная отправка со свежим снимком и есть
 * подтверждение (Р17). Поэтому от формы требуется одно — вернуть эти числа обратно.
 */
export function applySnapshotConflict(
  rows: PurchaseFormRow[],
  conflict: OfficeEquipmentPurchaseSnapshotConflictDto,
): PurchaseFormRow[] {
  const fresh = new Map(conflict.rows.map((r) => [r.consumableId, r]));
  return rows.map((row) => {
    const now = fresh.get(row.consumableId);
    if (!now) return row;
    return {
      ...row,
      // «Было» запоминается ровно один раз: на второй 409 подряд человеку важно, что он видел в
      // прошлый раз, а не что стояло три отправки назад.
      stale: { required: row.required, stock: row.stock, alreadyOrdered: row.alreadyOrdered },
      required: now.actualRequired,
      stock: now.actualStock,
      alreadyOrdered: now.actualAlreadyOrdered,
      suggested: now.actualSuggested,
    };
  });
}

/** «Из чего сложилось число» одной ячейкой (Р16): остаток, потребность, уже заказано. */
function basisCell(row: PurchaseFormRow) {
  const line = `потребность ${row.required} · на складе ${row.stock} · уже заказано ${row.alreadyOrdered}`;
  return (
    <>
      <Typography.Text type={row.stale ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
        {line}
      </Typography.Text>
      {row.stale && (
        <>
          <br />
          {/* «Было» рядом с «стало», а не вместо него: человек обязан увидеть, что именно уехало,
              иначе новые числа читаются как первые. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            было: потребность {row.stale.required} · на складе {row.stale.stock} · уже заказано{' '}
            {row.stale.alreadyOrdered}
          </Typography.Text>
        </>
      )}
    </>
  );
}

/** Открытые закупки по позиции — со ссылкой на номер: запрета на вторую нет, но знать о ней надо. */
function openPurchasesCell(row: PurchaseFormRow) {
  if (row.openPurchases.length === 0) return null;
  return (
    <div>
      {row.openPurchases.map((p) => (
        <Tooltip
          key={p.id}
          title={`${officeEquipmentPurchaseStatusLabels[p.status]}: ${p.quantity} шт`}
        >
          <Tag color="blue">{p.displayNumber}</Tag>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Колонки таблицы строк формы. Своей сортировки и страниц у неё нет: это состав одного документа,
 * а не список, и «страница 2 закупки» была бы приглашением забыть половину заказа.
 */
export function purchaseRowColumns(
  onQuantity: (consumableId: string, quantity: number) => void,
  onRemove: (consumableId: string) => void,
): TableColumnType<PurchaseFormRow>[] {
  return [
    {
      key: 'name',
      title: 'Позиция',
      render: (_v: unknown, r: PurchaseFormRow) => (
        <>
          <div>{r.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.color ? `${r.code} · ${r.color}` : r.code}
          </Typography.Text>
          {openPurchasesCell(r)}
        </>
      ),
    },
    {
      key: 'basis',
      title: 'Из чего сложилось',
      width: 280,
      render: (_v: unknown, r: PurchaseFormRow) => basisCell(r),
    },
    {
      key: 'suggested',
      title: 'Предложено',
      width: 110,
      render: (_v: unknown, r: PurchaseFormRow) => (
        <Typography.Text type="secondary">{r.suggested}</Typography.Text>
      ),
    },
    {
      key: 'quantity',
      title: 'Заказываем',
      width: 130,
      render: (_v: unknown, r: PurchaseFormRow) => (
        <InputNumber
          min={1}
          max={1_000_000}
          precision={0}
          value={r.quantity}
          aria-label={`Количество: ${r.name}`}
          style={{ width: '100%' }}
          onChange={(v) => onQuantity(r.consumableId, typeof v === 'number' ? v : 1)}
        />
      ),
    },
    {
      key: 'remove',
      title: '',
      width: 60,
      render: (_v: unknown, r: PurchaseFormRow) => (
        <Space>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            aria-label={`Убрать: ${r.name}`}
            onClick={() => onRemove(r.consumableId)}
          />
        </Space>
      ),
    },
  ];
}
