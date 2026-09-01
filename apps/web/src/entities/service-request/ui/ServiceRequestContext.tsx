import { Descriptions, Space, Tag, Typography } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceRequestEquipmentName, serviceRequestObjectLabel } from '../model/subject';

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
  const { equipment } = request;
  const numbers = [
    equipment?.inventoryNumber && `инв. ${equipment.inventoryNumber}`,
    equipment?.serialNumber && `SN ${equipment.serialNumber}`,
  ].filter(Boolean);
  /*
   * «Где стоит» у заявки без аппарата не существует: снимка места нет, а площадки может не быть
   * вовсе (заявка «от отдела», Р8). Вопрос окна при этом остаётся — деньги согласуют, зная, ДЛЯ
   * КОГО работа, — и на него отвечает отдел-заказчик: у заявки без аппарата заказчик ровно один,
   * площадка либо отдел (`CHECK` предмета, Р7). Поэтому строка не пропадает, а меняет подпись:
   * пустая «Где стоит» читалась бы как недогруженная карточка.
   */
  const objectLabel = serviceRequestObjectLabel(request);
  const customer = objectLabel ?? request.customerDepartment?.name ?? null;

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
              {/* Слова, а не пустое место: заявка без аппарата — законное состояние, и молчание
                  здесь прочиталось бы как «реквизиты не догрузились» (Р8). */}
              <span>{serviceRequestEquipmentName(request)}</span>
              {numbers.length > 0 && (
                <Typography.Text type="secondary">{numbers.join(' · ')}</Typography.Text>
              )}
              {request.isUrgent && <Tag color="red">Срочная</Tag>}
            </Space>
          ),
        },
        ...(customer
          ? [
              {
                key: 'object',
                label: objectLabel ? 'Где стоит' : 'Для кого',
                children: (
                  <Space size={8} wrap>
                    <span>{customer}</span>
                    {/* Место внутри объекта — снимок на момент заведения: мастер едет по нему.
                        У заявки без аппарата снимка нет — показывать нечего. */}
                    {equipment?.location && (
                      <Typography.Text type="secondary">{equipment.location}</Typography.Text>
                    )}
                  </Space>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
