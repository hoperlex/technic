import { Table, Tag, Typography, type TableColumnsType } from 'antd';
import type { ServiceRequestConsumableDto } from '@technic/contracts';

/**
 * Строки расходников на чтение (Н9, Р10): что просили, что выдали и почему разошлось.
 *
 * Три величины рядом, а не «выдано вместо просили»: спор по заявке начинается с вопроса «а
 * сколько заказывали», и подменённое запрошенное количество на него уже не отвечает. У закрытой
 * заявки таблица та же — правится факт только до «Закрыта» (Р6), но читается всегда.
 *
 * Реквизиты позиции приходят живыми, а не снимком (в отличие от реквизитов техники): строка
 * ссылается на карточку справочника, и переименование позиции обязано читаться в заявке новым
 * именем — склад это действующий перечень, а не история заявки.
 */
export function ServiceConsumablesTable({
  lines,
}: {
  lines: readonly ServiceRequestConsumableDto[];
}) {
  const columns: TableColumnsType<ServiceRequestConsumableDto> = [
    {
      key: 'name',
      title: 'Позиция',
      dataIndex: 'name',
      render: (_v, line) => (
        <span>
          {line.name}
          {/* Цвет — свойство позиции (Р9): у цветной серии по позиции на цвет, со своим кодом и
              своим остатком, и различать их в таблице приходится глазами. */}
          {line.color && (
            <Tag style={{ marginInlineStart: 8 }} color="processing">
              {line.color}
            </Tag>
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {line.code}
            </Typography.Text>
          </div>
        </span>
      ),
    },
    {
      key: 'requestedQuantity',
      title: 'Просили',
      dataIndex: 'requestedQuantity',
      width: 100,
      align: 'right',
    },
    {
      key: 'issuedQuantity',
      title: 'Выдано',
      dataIndex: 'issuedQuantity',
      width: 110,
      align: 'right',
      /*
       * «Нет отметки» и «выдали ноль» — разные состояния, и показывать их одинаково нельзя: первое
       * ждёт исполнителя, второе — законченная работа («съездили, тонер оказался цел», В9б).
       */
      render: (_v, line) =>
        line.issuedQuantity == null ? (
          <Typography.Text type="secondary">не отмечено</Typography.Text>
        ) : (
          line.issuedQuantity
        ),
    },
    {
      key: 'issueNote',
      title: 'Причина расхождения',
      dataIndex: 'issueNote',
      render: (_v, line) =>
        line.issueNote || <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <Table
      rowKey="id"
      size="small"
      pagination={false}
      columns={columns}
      dataSource={[...lines]}
    />
  );
}
