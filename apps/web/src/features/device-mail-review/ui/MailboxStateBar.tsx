import { Alert, Space, Typography } from 'antd';
import type { DeviceMailboxStateDto } from '@technic/contracts';
import { formatDateTime } from '../../../utils/format';

/**
 * Состояние почтовых ящиков в шапке очереди (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §9.1, п. 8).
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ, ЕСЛИ НИЖЕ ЕСТЬ САМА ОЧЕРЕДЬ. Письмо может застрять, НЕ ДОЙДЯ ДО БАЗЫ: тело не
 * принято ни разу, строки нет вовсе, и очередь при этом честно пуста. Без этой шапки мёртвый приём
 * выглядит ровно как разобранный ящик — и выглядит так ровно столько, сколько никто не заметит.
 *
 * ПУСТОЙ ОБХОД — ТОЖЕ НОВОСТЬ. «Последний обход был вчера» отвечает на вопрос, которого строки
 * очереди не касаются вовсе: жив ли приёмник. Поэтому строка ящика показывается всегда, а не
 * только при беде.
 */
export function MailboxStateBar({ mailbox }: { mailbox: DeviceMailboxStateDto[] }) {
  if (mailbox.length === 0) return null;
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
      {mailbox.map((box) =>
        box.cursorStuckAt ? (
          <StuckBox key={box.account} box={box} />
        ) : (
          <LiveBox key={box.account} box={box} />
        ),
      )}
    </Space>
  );
}

/**
 * Курсор стоит. ПРИЧИНА ПОКАЗЫВАЕТСЯ ДОСЛОВНО (`last_error` ящика): у застрявшего письма своей
 * строки может не быть, и эта строка — единственное, по чему вообще можно понять, что случилось.
 * Пересказ «что-то пошло не так» здесь стоил бы ровно того разбирательства, ради которого поле и
 * заведено.
 */
function StuckBox({ box }: { box: DeviceMailboxStateDto }) {
  return (
    <Alert
      type="warning"
      showIcon
      title={`${MAILBOX_STUCK_PREFIX}${formatDateTime(box.cursorStuckAt!)}`}
      description={
        <>
          <div>{box.account}</div>
          <div>
            {box.lastError || 'причина не записана'} · попыток: {box.stuckAttempts}
          </div>
        </>
      }
    />
  );
}

function LiveBox({ box }: { box: DeviceMailboxStateDto }) {
  return (
    <Typography.Text type="secondary">
      {box.account}:{' '}
      {box.lastPollAt ? `последний обход ${formatDateTime(box.lastPollAt)}` : MAILBOX_NEVER_POLLED}
    </Typography.Text>
  );
}

/** Обещание шапки, проверяемое дословно: «курсор стоит с такого-то времени» (§9.1, п. 8). */
export const MAILBOX_STUCK_PREFIX = 'Курсор ящика стоит с ';

/**
 * Ящик ещё ни разу не спрашивали. Не ошибка: выкат едет выключенным (`DEVICE_MAIL_ENABLED=false`),
 * и до включения приёмника это законное состояние — но сказать о нём надо, иначе пустая очередь
 * прочитается как «всё разобрано».
 */
export const MAILBOX_NEVER_POLLED = 'приёмник ящик ещё не спрашивал';
