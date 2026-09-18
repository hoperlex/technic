import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEVICE_SKIP_REASONS } from '@technic/contracts';
import { config } from '../config';
import { err } from '../lib/errors';
import {
  bumpDeviceMailStuck,
  intakeDeviceMessage,
  isDeviceMailPause,
  readDeviceMailCursor,
  reparseDeviceMessage,
} from '../services/device-mail/intake';

/**
 * Внутренние маршруты приёма писем от оргтехники (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §9.1, Р2, Р23, Р26, Р28).
 *
 * ТРИ РУЧКИ И НИ ОДНОЙ БОЛЬШЕ: спросить курсор ящика, сдать письмо, перечитать принятое. Разбор
 * живёт здесь, а не в worker, по той же причине, что записана в `internal-mail.ts`: worker
 * подключён к базе голым `pg`, а словари, профили и правила опознания живут в API и в контрактах —
 * второй их экземпляр в worker разошёлся бы молча. Worker делает три вещи: спросить курсор,
 * забрать письмо из ящика и отдать его сюда целиком.
 *
 * ДОСТУП — ПО ОБЩЕМУ СЕКРЕТУ, а не по учётной записи: за приёмом письма нет человека, от чьего
 * имени он действует. Наружу префикс `/internal` не проксируется (`deploy/nginx/spa.conf`), и это
 * второй рубеж: даже с утёкшим токеном постучаться можно только из внутренней сети.
 *
 * РУБИЛЬНИК `device_mail_intake` ПРОВЕРЯЕТСЯ ЗДЕСЬ, А НЕ В WORKER (Р28). Worker не читает
 * `feature_flags` ни одной строкой и читать не должен: у него голый `pg` и своя конфигурация.
 * Выключенный рубильник отвечает 503 с кодом паузы — письмо остаётся в ящике и дождётся
 * включения.
 */

/**
 * Проверка общего секрета — та же, что у почтовых внутренних ручек. Скопирована, а не вынесена в
 * общий модуль: `internal-mail.ts` держит её приватной, а три вызова одного `if` не стоят
 * отдельного файла. Разъехаться им негде — все читают одно поле конфигурации.
 */
function assertInternalToken(req: FastifyRequest): void {
  const expected = config.mail.internalToken;
  // Пустой секрет не открывает дверь всем: он закрывает её совсем.
  if (!expected) throw err.unauthorized('Внутренний доступ не настроен');
  const got = req.headers['x-internal-token'];
  if (typeof got !== 'string' || got !== expected) {
    throw err.unauthorized('Недействительный внутренний токен');
  }
}

/**
 * Свой потолок тела — и он НЕ РАВЕН потолку письма (Р25).
 *
 * Общий лимит приложения — мегабайт, а письмо едет телом запроса и в base64: четыре байта на
 * каждые три. Лимит, равный `DEVICE_MAIL_MAX_SIZE_BYTES`, отвергал бы законную почту в четыре с
 * лишним мегабайта — и отвергал бы её до того, как в базе появится хоть строка, то есть молча и
 * без следа в очереди. Запас сверх кодирования — на имена полей конверта и сам JSON.
 */
const JSON_ENVELOPE_SLACK = 64 * 1024;
const DEVICE_MAIL_BODY_LIMIT =
  Math.ceil(config.deviceMail.maxSizeBytes / 3) * 4 + JSON_ENVELOPE_SLACK;

const cursorQuery = z.object({
  /** Имя ящика. Умолчание — настроенный ящик портала: у worker'а и у API он один и тот же. */
  account: z.string().min(1).max(100).default(config.deviceMail.account),
  /**
   * Почему прошлый заход в ящик не состоялся: неверный пароль, провал STARTTLS, обрыв посреди
   * пачки. Необязательное и приезжает не всегда — приёмник называет причину один раз, первым
   * запросом курсора после неудачи, и сам её забывает. Своей строки у такой беды в базе нет вовсе
   * (сдачи не было), и это единственная дверь, через которую она вообще попадает в портал.
   */
  mailboxError: z.string().max(500).optional(),
});

const messageBody = z.object({
  account: z.string().min(1).max(100),
  /** Эпоха и номер письма — числами: UID в IMAP тридцатидвухбитный, за точность можно не бояться. */
  uidValidity: z.coerce.number().int().nonnegative(),
  uid: z.coerce.number().int().nonnegative(),
  size: z.coerce.number().int().nonnegative(),
  messageIdHeader: z.string().max(998).optional(),
  dateHeader: z.string().max(200).nullable().optional(),
  envelopeTo: z.string().max(320).optional(),
  /**
   * Тело письма целиком. Отсутствует ВМЕСТЕ со `skipReason` — это конверт без сырья, и он бывает
   * ровно у переростка (§9.1, п. 1): такое письмо не качается вовсе, размер виден из конверта
   * IMAP.
   */
  rawBase64: z.string().optional(),
  /**
   * Почему тела нет. Сужено до `DEVICE_SKIP_REASONS`, а не до всего словаря отказов: «конверт без
   * сырья» бывает ровно у переростка (§9.1, п. 1), и широкий набор разрешал бы приёмнику
   * придумывать себе новые поводы не качать письмо.
   */
  skipReason: z.enum(DEVICE_SKIP_REASONS).optional(),
  /**
   * Верхний номер ящика на момент обхода — граница режима дочитывания архива (Р32). Его знает
   * только worker: он берёт конверты пачкой и видит максимальный UID, а API в ящик не ходит.
   * Нужен ровно в тот заход, которым сменилась эпоха; в остальных ни на что не влияет.
   */
  mailboxMaxUid: z.coerce.number().int().nonnegative().optional(),
});

type MessageBody = z.infer<typeof messageBody>;

export default async function internalDeviceMailRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * СЧЁТЧИК ЗАСТРЕВАНИЯ РАСТЁТ ЗДЕСЬ — в обработчике ошибок маршрута, отдельной закоммиченной
   * транзакцией (§9.1, п. 7).
   *
   * Не в теле ручки: необработанное исключение туда не возвращается вовсе, оно уходит в общий
   * обработчик ошибок приложения, который про UID письма не знает ничего. И не на входе
   * следующего захода: там неизвестно, почему письмо вернулось, — час недоступного хранилища
   * досчитал бы до `stuck` совершенно законное письмо.
   *
   * СЧИТАЕТСЯ ОТКАЗ, РАЗЛИЧАЮЩИЙ ПИСЬМО, И ЛЮБАЯ НЕОЖИДАННОСТЬ. Пятисотка без кода паузы —
   * заход: снаружи необработанное исключение выглядит ровно как выключенный рубильник, и не
   * считай его — ящик стоял бы навсегда на одном кривом письме.
   *
   * НЕ СЧИТАЮТСЯ ТРИ ОТКАЗА, КОТОРЫЕ НЕ ПРО ПИСЬМО: пауза (рубильник, хранилище), закрытая дверь
   * (401/403) и потолок частоты (429). Дверь закрыта для всех писем одинаково, и счётчик,
   * набежавший на неверном секрете, закрыл бы `stuck` первое же невиновное письмо сразу после
   * того, как секрет починят, — то есть наказал бы за чужую беду ровно так, как запрещает Р28.
   */
  app.addHook('onError', async (req, _reply, error) => {
    if (isDeviceMailPause(error)) return;
    const status = Number((error as { statusCode?: number }).statusCode ?? 500);
    if (status === 401 || status === 403 || status === 429) return;
    const body = req.body as Partial<MessageBody> | undefined;
    if (!body || typeof body.account !== 'string') return;
    const uidValidity = Number(body.uidValidity);
    const uid = Number(body.uid);
    if (!Number.isInteger(uidValidity) || !Number.isInteger(uid)) return;
    const reason = `${(error as { code?: string }).code ?? error.name}: ${error.message}`;
    try {
      await bumpDeviceMailStuck(body.account, BigInt(uidValidity), BigInt(uid), reason);
    } catch (e) {
      // Счётчик — страховка, а не сам приём: его отказ не имеет права подменить собой причину
      // исходной ошибки, ради которой сюда и зашли.
      req.log.error({ err: e }, 'Счётчик застревания письма аппарата не обновился');
    }
  });

  /**
   * Курсор ящика: его worker спрашивает перед каждым заходом (Р23).
   *
   * Строки ящика нет — заводится с нулями. Отдаются и отметка сброса, и счётчик застревания:
   * первая нужна worker'у, чтобы понимать, дочитывается ли архив, второй — чтобы видеть, что
   * голова пачки стоит.
   */
  r.get('/cursor', { schema: { querystring: cursorQuery } }, async (req) => {
    assertInternalToken(req);
    const state = await readDeviceMailCursor(req.query.account, req.query.mailboxError);
    const num = (value: bigint | null): number | null => (value === null ? null : Number(value));
    return {
      uidValidity: Number(state.uidValidity),
      lastUid: Number(state.lastUid),
      resetUidValidity: num(state.resetUidValidity),
      resetMaxUid: num(state.resetMaxUid),
      stuckUidValidity: num(state.stuckUidValidity),
      stuckUid: num(state.stuckUid),
      stuckAttempts: state.stuckAttempts,
    };
  });

  /**
   * Сдача письма. Ответ различает «создано» и «уже было» отдельным полем: без него приёмник,
   * молча съедающий всё подряд, проходит тесты идеально (§9.1, п. 5).
   *
   * Помечать письмо прочитанным в ящике worker обязан ПОСЛЕ этого ответа, а не до: потерянный
   * ответ иначе терял бы письмо навсегда, а §2 плана прямо говорит, что событие не
   * восстанавливается.
   */
  r.post(
    '/messages',
    { bodyLimit: DEVICE_MAIL_BODY_LIMIT, schema: { body: messageBody } },
    async (req) => {
      assertInternalToken(req);
      const raw =
        typeof req.body.rawBase64 === 'string' ? Buffer.from(req.body.rawBase64, 'base64') : null;
      return intakeDeviceMessage({
        account: req.body.account,
        uidValidity: BigInt(req.body.uidValidity),
        uid: BigInt(req.body.uid),
        size: req.body.size,
        messageIdHeader: req.body.messageIdHeader ?? '',
        dateHeader: req.body.dateHeader ?? null,
        envelopeTo: req.body.envelopeTo ?? '',
        raw,
        skipReason: req.body.skipReason ?? null,
        mailboxMaxUid: req.body.mailboxMaxUid === undefined ? null : BigInt(req.body.mailboxMaxUid),
      });
    },
  );

  /**
   * Перечитать одно письмо нынешними правилами разбора (Р26). Её зовёт задача очереди
   * `reparse_device_message`, и она же — кнопка «перечитать» в очереди разбора.
   *
   * Курсор ящика при этом не двигается ни на шаг: это работа по уже принятому письму, а не приём.
   */
  r.post(
    '/messages/:id/reparse',
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      assertInternalToken(req);
      const status = await reparseDeviceMessage(req.params.id);
      return { status };
    },
  );
}
