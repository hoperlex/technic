import { Space, Typography } from 'antd';
import { PhoneLink } from './PhoneField';

/**
 * Контакт в карточке: ФИО и телефон ссылкой `tel:`. Пусто — запись заведена до появления контакта
 * (миграция 0062).
 *
 * Живёт рядом со ссылкой, а не в слайсе заявки, хотя зовут его именно карточки заявок: домена
 * заявки в нём нет — только имя и номер. В слайсе заявки ссылку пришлось бы передавать пропом
 * (сосед по слою), и шесть мест вызова платили бы за адрес, который ничего не объясняет.
 */
export function ResponsibleValue({ name, phone }: { name: string; phone: string }) {
  if (!name && !phone) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={8} wrap>
      <span>{name || '—'}</span>
      {!!phone && <PhoneLink phone={phone} />}
    </Space>
  );
}
