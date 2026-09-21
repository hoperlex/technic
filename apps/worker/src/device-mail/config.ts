import type { DeviceMailConfig } from './types';

/**
 * Настройки приёма писем от оргтехники читаются здесь, и только здесь.
 *
 * Своя функция, а не разбор в `index.ts` рядом с прочими константами: имена и умолчания обязаны
 * совпасть с `apps/api/src/config.ts` до буквы — ящик один, а читают его настройки два процесса.
 * Разъехавшееся умолчание потолка размера стоило бы отвергнутой почты, разъехавшийся
 * `DEVICE_MAIL_ACCOUNT` — второй строки курсора и вечного перечитывания ящика с нуля.
 */

function num(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Признак читается ровно так же, как в `apps/api/src/config.ts` (`boolFromEnv`): с приведением к
 * нижнему регистру. Прямое сравнение строк разводило бы два процесса на `DEVICE_MAIL_ENABLED=True`
 * — API считал бы контур включённым, а worker молча не ходил бы в ящик.
 */
function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true';
}

/**
 * Собрать настройки из окружения. `null` — контур на этом сервере не настроен
 * (`DEVICE_MAIL_ENABLED=false` или транспорт задан без обязательного адреса), и тогда worker в
 * ящик не ходит вовсе.
 *
 * Выключенный контур — это `null`, а не «настройки с пустым хостом»: тогда «ходить или не ходить»
 * решается один раз на старте, а не в каждом тике, и включение контура без адреса ящика не
 * превращается в предупреждение раз в пять минут навсегда.
 *
 * Для транспорта `imap` обязательны ДВА значения — адрес сервера и имя папки. Почему папка
 * обязательна, сказано ниже, у самой строки.
 */
export function readDeviceMailConfig(env: NodeJS.ProcessEnv): DeviceMailConfig | null {
  if (!bool(env.DEVICE_MAIL_ENABLED, false)) return null;

  const transport = env.DEVICE_MAIL_TRANSPORT === 'dir' ? 'dir' : 'imap';
  const dir = env.DEVICE_MAIL_DIR ?? '';
  const imapHost = env.DEVICE_MAIL_IMAP_HOST ?? '';
  /**
   * ПАПКА НАЗЫВАЕТСЯ ЯВНО, УМОЛЧАНИЯ У НЕЁ НЕТ — и это не педантизм, а защита чужой почты.
   *
   * Раньше здесь стоял `INBOX`, и забытая строка в окружении означала бы вот что: приёмник
   * вычерпывает входящие целиком. На выделенном ящике это безобидно, а на общем ящике проекта —
   * нет: каждое письмо людей уехало бы в хранилище сырьём на тридцать дней (сырьё кладётся ДО
   * проверки отправителя), получило бы отметку «прочитано» и всплыло бы строкой в очереди разбора,
   * открытой ИТ-службе. Поэтому папку обязан назвать человек: `INBOX` — тоже законный ответ, но
   * данный вслух.
   */
  const mailbox = (env.DEVICE_MAIL_IMAP_MAILBOX ?? '').trim();
  if (transport === 'dir' && !dir) return null;
  if (transport === 'imap' && (!imapHost || mailbox === '')) return null;

  return {
    account: env.DEVICE_MAIL_ACCOUNT || 'default',
    transport,
    dir,
    imapHost,
    imapPort: num(env.DEVICE_MAIL_IMAP_PORT, 993),
    // true только для implicit TLS (993); false — STARTTLS на 143. Открытого соединения нет ни при
    // каком значении: пароль ящика уходит по сети в обоих случаях.
    imapSecure: bool(env.DEVICE_MAIL_IMAP_SECURE, true),
    imapUser: env.DEVICE_MAIL_IMAP_USER ?? '',
    imapPassword: env.DEVICE_MAIL_IMAP_PASSWORD ?? '',
    mailbox,
    processedMailbox: env.DEVICE_MAIL_IMAP_PROCESSED_MAILBOX ?? '',
    pollIntervalMs: num(env.DEVICE_MAIL_POLL_INTERVAL_MS, 300_000),
    batch: num(env.DEVICE_MAIL_BATCH, 50),
    maxSizeBytes: num(env.DEVICE_MAIL_MAX_SIZE_BYTES, 5_242_880),
  };
}
