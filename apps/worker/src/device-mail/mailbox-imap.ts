import { ImapFlow } from 'imapflow';
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

export function createImapMailbox(
  cfg: DeviceMailConfig,
  log: (meta: Record<string, unknown>, msg: string) => void,
): DeviceMailbox {
  let client: ImapFlow | null = null;

  function connected(): ImapFlow {
    if (!client) throw new Error('Ящик не открыт: сначала open()');
    return client;
  }

  return {
    name: 'imap',
    async open() {
      const next = new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        // true — implicit TLS (993); false — STARTTLS на 143. Открытого соединения нет ни при
        // каком значении: пароль ящика уходит по сети в обоих случаях.
        secure: cfg.imapSecure,
        ...(cfg.imapSecure ? {} : { doSTARTTLS: true }),
        auth: { user: cfg.imapUser, pass: cfg.imapPassword },
        // Своего журнала библиотеки не заводим: в нём оказались бы команды с учётными данными, а
        // пароль ящика в журнал не попадает ни одной строкой.
        logger: false,
        // Пауза между тиками — минуты; авто-IDLE успел бы начаться и его пришлось бы прерывать
        // каждой командой, платя двумя лишними обходами.
        disableAutoIdle: true,
      });
      await next.connect();
      const mailbox = await next.mailboxOpen(cfg.mailbox);
      client = next;
      // Верхняя граница ящика — «следующий номер минус один»: она приезжает вместе с SELECT, и
      // лишнего обхода за ней не нужно. Номер может оказаться незанятым — и пусть: отметка Р32
      // говорит «не выше», а новое письмо получит номер СТРОГО выше `uidNext`, то есть за
      // границу не попадёт никогда. Пустой ящик границы не имеет — это `null`, а не ноль.
      const maxUid = mailbox.uidNext > 1 ? mailbox.uidNext - 1 : null;
      // UIDVALIDITY в IMAP 32-разрядный: в число он помещается целиком, и BigInt дальше не нужен.
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
