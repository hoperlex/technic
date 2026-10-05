import { App, Button, Typography } from 'antd';
import { CopyOutlined, MessageOutlined, PhoneOutlined, SendOutlined } from '@ant-design/icons';
import { formatPhone } from '@technic/contracts';
import {
  SUPPORT_MAX_URL,
  SUPPORT_PHONE,
  SUPPORT_PHONE_HREF,
  SUPPORT_TELEGRAM_URL,
} from '@shared/config';
/**
 * Messaging comes first because it preserves the problem, screenshot and request number.
 * A call leaves only both people's memories, so it is reserved for work that cannot wait.
 */
export function SupportContactsBody() {
  const { message } = App.useApp();
  const phone = formatPhone(SUPPORT_PHONE);

  /**
   * Copying complements tel: links, which often open nothing on a desktop workstation. Without
   * this action the user would have to transcribe the phone number from the screen.
   */
  const copyPhone = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      message.success('Номер скопирован');
    } catch {
      // Clipboard access may be blocked by browser settings or unavailable without HTTPS.
      // The number is still usable, so show it instead of treating copying as a failed contact.
      message.info(`Номер: ${phone}`);
    }
  };

  return (
    <>
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
    </>
  );
}
