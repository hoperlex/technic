import { Space, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import {
  serviceRequestKindLabels,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type EquipmentRequestRowDto,
  type OfficeEquipmentItemWarrantyDto,
} from '@technic/contracts';
import { WarrantyTag } from '@entities/office-equipment';
import { formatDate, formatMoney } from '../../../utils/format';

/**
 * Из чего сложена строка заявки — одинаково в блоке окна и в секции карточки (Р7, К7).
 *
 * Общие куски, а не два похожих рассказа: до этого плана про заявки по аппарату говорили три
 * места и говорили по-разному (Н1). Смысл сведения пропал бы, останься у секции своя редакция той
 * же строки, — она разошлась бы с блоком на первой же правке.
 */

/**
 * Ссылка в карточку заявки (ADR 0074).
 *
 * Адрес — `?tab=requests&open=<id>`: параметр `open` читает `useOpenedRecord` списка заявок, и
 * этим же адресом ходят все остальные ссылки портала (журнал остатка, отчёт по расходу, окно
 * кандидата). У самой ленты в этом месте стоит `id=` — параметр, которого не читает никто, — и
 * повторять её опечатку в новых блоках незачем.
 */
export function EquipmentRequestLink({ row }: { row: EquipmentRequestRowDto }) {
  return <Link to={`/office-equipment?tab=requests&open=${row.id}`}>{row.displayNumber}</Link>;
}

/** Действующие сейчас гарантии позиций заявки (Р6): что ещё покрыто и до какого числа. */
export function EquipmentRequestWarranties({
  warranties,
}: {
  warranties: OfficeEquipmentItemWarrantyDto[];
}) {
  return (
    <>
      {warranties.map((warranty) => (
        <div key={warranty.itemId}>
          <Space size={6}>
            <Typography.Text type="secondary">{warranty.name}</Typography.Text>
            <WarrantyTag until={warranty.warrantyUntil} />
          </Space>
        </div>
      ))}
    </>
  );
}

/**
 * Итог и деньги (Р2, Н12). Подпись итога приходит с сервера и суммы не содержит никогда; сумма —
 * отдельное поле, и `null` в нём значит либо «её нет», либо «не положено видеть».
 *
 * Прочерка «сумма скрыта» здесь нет намеренно: две причины пустоты снаружи неразличимы, и
 * рисовать вместо них одну придуманную значило бы сообщать заявителю, что сумма существует и от
 * него спрятана.
 */
export function EquipmentRequestOutcome({ row }: { row: EquipmentRequestRowDto }) {
  return (
    <Space size={6} wrap>
      <Typography.Text>{row.outcome.label}</Typography.Text>
      {row.totalAmount !== null && (
        <Typography.Text strong>{formatMoney(row.totalAmount)}</Typography.Text>
      )}
    </Space>
  );
}

/** Кто занимался: контрагент-исполнитель и поимённые (Р2). */
export function EquipmentRequestExecutors({ executors }: { executors: string[] }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {executors.length > 0 ? executors.join(', ') : 'Исполнитель не назначен'}
    </Typography.Text>
  );
}

/** Статус заявки и вид работ — тем же тегом и словами, что в реестре заявок. */
export function EquipmentRequestStatus({ row }: { row: EquipmentRequestRowDto }) {
  return (
    <Space size={6} wrap>
      <Tag color={serviceRequestStatusColors[row.status]}>
        {serviceRequestStatusLabels[row.status]}
      </Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {serviceRequestKindLabels[row.kind]}
      </Typography.Text>
    </Space>
  );
}

/**
 * «Заявляли, что аппарат стоит не там, и до сих пор не разобрали» (план п. 12). Читает это в
 * первую очередь тот, кто аппарат повезёт, поэтому пометка стоит в строке, а не в подсказке.
 */
export function EquipmentRequestMismatch({ row }: { row: EquipmentRequestRowDto }) {
  if (!row.objectMismatch) return null;
  return <Tag color="orange">Место не подтверждено</Tag>;
}

/** Обе даты (Н4): заведения и последней правки заявки — не активности (Р2, В2). */
export function EquipmentRequestDates({ row }: { row: EquipmentRequestRowDto }) {
  return (
    <div style={{ lineHeight: 1.4 }}>
      <div>{formatDate(row.createdAt)}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        изменена {formatDate(row.updatedAt)}
      </Typography.Text>
    </div>
  );
}

/**
 * Компактная строка для секции карточки (Р7): та же заявка, тот же блок, первые пять строк.
 * Таблицы там нет — секция стоит внутри окна правки, и четыре колонки в неё не влезают.
 */
export function EquipmentRequestLine({ row }: { row: EquipmentRequestRowDto }) {
  return (
    <div>
      <Space size={8} wrap>
        <EquipmentRequestLink row={row} />
        <EquipmentRequestStatus row={row} />
        <Typography.Text type="secondary">{formatDate(row.createdAt)}</Typography.Text>
        <EquipmentRequestOutcome row={row} />
        <EquipmentRequestMismatch row={row} />
      </Space>
      <div>
        <EquipmentRequestExecutors executors={row.executors} />
      </div>
      <EquipmentRequestWarranties warranties={row.warranties} />
    </div>
  );
}
