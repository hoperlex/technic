import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { DeviceMailConfig, DeviceMailEnvelope, DeviceMailbox } from './types';

/**
 * Ящик по IMAP — рабочая реализация (Р27). Вторая, `dir`, живёт рядом и говорит тем же языком.
 *
 * Соединение поднимается на каждом тике и закрывается в его конце: тик раз в пять минут, а IDLE не
 * используется вовсе — живого канала к VPS у нас нет, и держать сессию между тиками значило бы
 * ловить разрывы вместо писем. Расписание самого аппарата здесь не задаётся и задаваться не может.
 */

/** Заголовки конверта: только они, тела в этом запросе нет — письмо может оказаться переростком. */
const ENVELOPE_QUERY = { uid: true, size: true, envelope: true } as const;

/**
 * Silence limit for one IMAP command. The library default is five minutes, and the tick runs inside
 * the worker's single loop: a mail server that stops answering would hold every queued job (ticket
 * OCR, mail, S3 deletes) that long on each tick. A minute without a byte is a dead server; a large
 * body keeps the socket busy and does not trip it.
 */
const SOCKET_TIMEOUT_MS = 60_000;

export function createImapMailbox(
  cfg: DeviceMailConfig,
  log: (meta: Record<string, unknown>, msg: string) => void,
  // Test seam: the fake server in the tests speaks plain TCP. Production always takes the default.
  newClient: (options: ImapFlowOptions) => ImapFlow = (options) => new ImapFlow(options),
): DeviceMailbox {
  let client: ImapFlow | null = null;

  function connected(): ImapFlow {
    if (!client) throw new Error('Ящик не открыт: сначала open()');
    return client;
  }

  return {
    name: 'imap',
    async open() {
      const next = newClient({
        host: cfg.imapHost,
        port: cfg.imapPort,
        // true is implicit TLS (993), false is STARTTLS on 143. Neither value allows a cleartext
        // session: the mailbox password crosses the network either way.
        secure: cfg.imapSecure,
        ...(cfg.imapSecure ? {} : { doSTARTTLS: true }),
        auth: { user: cfg.imapUser, pass: cfg.imapPassword },
        // No library log: it would carry commands with credentials, and the mailbox password must
        // not reach the journal in any line.
        logger: false,
        // Ticks are minutes apart; auto-IDLE would start in between and every command would pay
        // two extra round trips to break it.
        disableAutoIdle: true,
        socketTimeout: SOCKET_TIMEOUT_MS,
      });
      /*
       * imapflow reports through the `error` event every failure that no pending call owns: a
       * session that dies after connect() has already been rejected (the server drops the
       * connection between login and COMPRESS), or a command left unanswered past the socket
       * timeout. Without a listener Node turns that event into an uncaught exception that ends the
       * worker process, and with it the job queue (prod, 22.10.2026). The listener only records the
       * failure: the library has already closed the connection, so the call in flight fails on its
       * own and the tick reports it through its usual path.
       */
      next.on('error', (e: Error & { code?: string }) => {
        log({ err: e.message, code: e.code }, 'Ящик оргтехники: соединение оборвалось');
      });
      await next.connect();
      /*
       * A missing folder is explained in words, not by the server's code. The error text reaches
       * the queue header ("курсор ящика стоит"), and whoever set up the mail rule an hour ago has
       * to see from it that the folder was not created or was named differently.
       */
      let mailbox;
      try {
        mailbox = await next.mailboxOpen(cfg.mailbox);
      } catch (e) {
        await next.logout().catch(() => undefined);
        // A lost connection says nothing about the folder, and the hint below would send the
        // operator to recheck a name that is fine.
        if ((e as { code?: unknown }).code === 'NoConnection') throw e;
        throw new Error(
          `Папка «${cfg.mailbox}» в ящике не открывается: ${e instanceof Error ? e.message : String(e)}. ` +
            'Проверьте, что папка создана и названа ровно так же: точный путь отдаёт сам сервер по LIST, и разделитель у служб разный.',
        );
      }
      client = next;
      // The mailbox's upper bound is "next UID minus one": it arrives with SELECT, so no extra
      // round trip. That UID may be unused, which is fine: the Р32 mark means "not above", and a
      // new message gets a UID strictly above `uidNext`, so it never falls under the bound. An
      // empty mailbox has no bound: `null`, not zero.
      const maxUid = mailbox.uidNext > 1 ? mailbox.uidNext - 1 : null;
      // UIDVALIDITY is 32-bit in IMAP: it fits a number whole, no BigInt needed.
      return { uidValidity: Number(mailbox.uidValidity), maxUid };
    },
    async listEnvelopes(fromUid, limit) {
      const c = connected();
      // Сначала SEARCH, потом FETCH по перечню номеров — а не `fetch('N:*')` с обрывом по лимиту.
      // Команда, однажды отданная серверу, доигрывается до конца: обрыв на клиенте не мешает
      // серверу передать конверты всего хвоста. На дочитывании архива в пять тысяч писем при пачке
      // в пятьдесят это разница «пятьдесят конвертов против пяти тысяч» каждые пять минут.
      //
      // Числовым диапазоном `fromUid:fromUid+limit-1` резать НЕЛЬЗЯ, и это не педантизм: номера в
      // ящике не сплошные, а курсор двигает только ручка — значит дыра длиной в пачку (пятьдесят
      // подряд удалённых писем) дала бы пустой заход, курсор не сдвинулся бы, и ящик встал бы
      // навсегда. Поиск отдаёт голые номера и дыры проходит насквозь.
      const found = await c.search({ uid: `${fromUid}:*` }, { uid: true });
      const uids = (Array.isArray(found) ? found : [])
        // Сервер вправе вернуть последнее письмо, даже если его UID ниже начала диапазона, —
        // такова семантика `N:*` в IMAP. Отбрасываем: письмо ниже курсора уже принято.
        .filter((uid) => uid >= fromUid)
        .sort((a, b) => a - b)
        .slice(0, limit);
      if (uids.length === 0) return [];

      const out: DeviceMailEnvelope[] = [];
      for await (const msg of c.fetch(uids.join(','), ENVELOPE_QUERY, { uid: true })) {
        const date = msg.envelope?.date;
        out.push({
          uid: msg.uid,
          size: msg.size ?? 0,
          dateHeader: date instanceof Date ? date.toISOString() : (date ?? undefined),
          messageIdHeader: msg.envelope?.messageId ?? undefined,
          envelopeTo: msg.envelope?.to?.[0]?.address ?? undefined,
        });
      }
      return out.sort((a, b) => a.uid - b.uid);
    },
    async fetchRaw(uid) {
      const msg = await connected().fetchOne(
        String(uid),
        { uid: true, source: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;
      return msg.source;
    },
    async markProcessed(uid) {
      const c = connected();
      if (cfg.processedMailbox) {
        await c.messageMove(String(uid), cfg.processedMailbox, { uid: true });
        return;
      }
      await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    },
    async close() {
      const c = client;
      client = null;
      if (!c) return;
      try {
        await c.logout();
      } catch (e) {
        // Прощание с сервером не стоит тика: письма уже сданы и помечены, а соединение сервер
        // закроет сам. Молчать нельзя — обрыв на каждом тике означает больной канал.
        log(
          { err: e instanceof Error ? e.message : String(e) },
          'Ящик оргтехники: разрыв при выходе',
        );
      }
    },
  };
}
