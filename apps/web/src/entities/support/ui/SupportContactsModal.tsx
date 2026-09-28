import { App, Button, Typography } from 'antd';
import { CopyOutlined, MessageOutlined, PhoneOutlined, SendOutlined } from '@ant-design/icons';
import { formatPhone } from '@technic/contracts';
import {
  SUPPORT_MAX_URL,
  SUPPORT_PHONE,
  SUPPORT_PHONE_HREF,
  SUPPORT_TELEGRAM_URL,
} from '@shared/config';
import { ViewModal } from '@shared/ui';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Куда писать, если портал повёл себя не так. До собственной переписки в портале
 * (`docs/support-plan.md`) поддержка — это человек в мессенджере, и окно говорит ровно это:
 * три способа связи и правило, каким из них пользоваться.
 *
 * Мессенджер стоит первым не из вежливости: в переписке остаётся описание проблемы, снимок
 * экрана и номер заявки, а в разговоре — только память обеих сторон. Звонок оставлен тому
 * случаю, когда работа встала и ждать ответа нельзя.
 */
export function SupportContactsModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const phone = formatPhone(SUPPORT_PHONE);

  /**
   * Номер копированием, а не только ссылкой: на рабочем месте с монитором `tel:` чаще всего не
   * открывает ничего, и без этой кнопки номер пришлось бы переписывать с экрана глазами.
   */
  const copyPhone = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      message.success('Номер скопирован');
    } catch {
      // Буфер обмена закрыт настройками браузера или недоступен без https — номер виден на
      // экране, и это не повод показывать ошибку вместо самого номера.
      message.info(`Номер: ${phone}`);
    }
  };

  return (
    <ViewModal title="Техподдержка" open={open} onClose={onClose} width={420} footer={null}>
      <Typography.Paragraph type="secondary">
        Опишите проблему в Telegram или MAX — так к ответу сразу приложены снимок экрана и номер
        заявки. Если работа встала и ждать нельзя, звоните.
      </Typography.Paragraph>

      <a
        className="support-contact"
        href={SUPPORT_TELEGRAM_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        <SendOutlined className="support-contact__icon" />
        <span className="support-contact__body">
          <span className="support-contact__title">Написать в Telegram</span>
          <span className="support-contact__hint">Ответим в рабочее время</span>
        </span>
      </a>

      <a
        className="support-contact"
        href={SUPPORT_MAX_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        <MessageOutlined className="support-contact__icon" />
        <span className="support-contact__body">
          <span className="support-contact__title">Написать в MAX</span>
          <span className="support-contact__hint">Ответим в рабочее время</span>
        </span>
      </a>

      <a className="support-contact" href={SUPPORT_PHONE_HREF}>
        <PhoneOutlined className="support-contact__icon" />
        <span className="support-contact__body">
          <span className="support-contact__title">Позвонить</span>
          <span className="support-contact__hint">{phone}</span>
        </span>
      </a>

      <Button type="link" icon={<CopyOutlined />} onClick={() => void copyPhone()}>
        Скопировать номер
      </Button>
    </ViewModal>
  );
}
