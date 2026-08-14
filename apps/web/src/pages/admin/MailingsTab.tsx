import { Tabs } from 'antd';
import { MailingSchedulesBlock } from './MailingSchedulesBlock';
import { MailDebugBlock } from './MailDebugBlock';
import { ServiceMailRecipientsBlock } from './ServiceMailRecipientsBlock';

/**
 * Рассылки — три разных вопроса, и поэтому три подвкладки, а не один длинный свиток.
 *
 * «Расписания» отвечают, кому из **учётных записей** и когда уходит сводка (ADR 0075, 0093).
 * «Служебные адреса» — на какой ящик уходит письмо по событию модуля: у службы, читающей почту
 * вместо портала, нет ни учётки, ни области видимости, и в расписание она не укладывается (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р64, Р71). «Отладка» — про вёрстку и доставку
 * одного письма.
 *
 * До подвкладок расписания и отладка стояли одним столбцом со своей прокруткой и вместе не
 * помещались в экран; третий блок сделал бы свиток заведомо нечитаемым.
 */
export function MailingsTab() {
  return (
    // Вкладка отдана содержимому целиком (`.full-height-tabs` прячет переполнение), поэтому
    // прокрутка здесь своя: у каждой подвкладки содержимое выше экрана.
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <Tabs
        defaultActiveKey="schedules"
        style={{ padding: '0 16px' }}
        items={[
          { key: 'schedules', label: 'Расписания', children: <MailingSchedulesBlock /> },
          { key: 'recipients', label: 'Служебные адреса', children: <ServiceMailRecipientsBlock /> },
          { key: 'debug', label: 'Отладка', children: <MailDebugBlock /> },
        ]}
      />
    </div>
  );
}
