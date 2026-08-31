import { Descriptions, Space, Tag, Typography } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';

/**
 * Шапка окна действия: о какой заявке речь (план модернизации, Р57).
 *
 * До неё окна действий — назначение исполнителей, согласование объёма работ, закрытие работ,
 * приёмка — показывали номер заявки в заголовке и больше ничего о предмете. Человек, открывший
 * окно из списка, помнит, что нажал; человек, пришедший по ссылке из письма или из очереди, —
 * нет, а решение принимает именно он: везти ли мастера на площадку, за какие деньги и к какому
 * аппарату.
 *
 * Объект и место стоят здесь наравне с номером и техникой намеренно: это единственное место, где
 * «Согласовать объём работ на 7 100 ₽» перестаёт быть решением вслепую — видно, что чинят и где
 * оно стоит. Реквизиты берутся из снимка заявки, а не из справочника: карточку могли переименовать
 * и перенести, а решение принимается по тому, что чинили тогда.
 *
 * Компонент слоя сущностей: он знает форму заявки, но не знает ни прав, ни того, какое действие
 * сейчас подтверждают, — подпись действия остаётся заголовком самого окна.
 */
export function ServiceRequestContext({ request }: { request: ServiceRequestDto }) {
  const { equipment, object } = request;
  const numbers = [
    equipment.inventoryNumber && `инв. ${equipment.inventoryNumber}`,
    equipment.serialNumber && `SN ${equipment.serialNumber}`,
  ].filter(Boolean);

  return (
    <Descriptions
      size="small"
      column={1}
      style={{ marginBottom: 16 }}
      labelStyle={{ width: 110 }}
      items={[
        {
          key: 'equipment',
          label: 'Какой аппарат',
          children: (
            <Space size={8} wrap>
              <span>{equipment.name}</span>
              {numbers.length > 0 && (
                <Typography.Text type="secondary">{numbers.join(' · ')}</Typography.Text>
              )}
              {request.isUrgent && <Tag color="red">Срочная</Tag>}
            </Space>
          ),
        },
        {
          key: 'object',
          label: 'Где стоит',
          children: (
            <Space size={8} wrap>
              <span>
                {object.code} — {object.name}
              </span>
              {/* Место внутри объекта — снимок на момент заведения: мастер едет по нему. */}
              {equipment.location && (
                <Typography.Text type="secondary">{equipment.location}</Typography.Text>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
