import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import { archiveUnverifiedRegistrations, purgeExpiredRegistrations } from './retention';
import { PermanentMailError } from './mail-transport';
import { RateLimiter } from './mail-rate';
import { createMailAccounts } from './mail-accounts';
import { tickMailings } from './mail-scheduler';
import {
  createEngineFrom,
  preprocessOptionsFrom,
  readTicketOcrConfig,
  runTicketRecognitionJob,
} from './ticket-ocr';
import {
  claimJobs,
  completeJob,
  deferJob,
  extendLease,
  killJob,
  reclaimExpiredJobs,
  retryJob,
  type JobRow,
} from './job-lease';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// ── Конфигурация (минимальная; секреты приложения воркеру не нужны) ──
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
}

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const BATCH = Number(process.env.WORKER_BATCH ?? 10);
const CLEANUP_INTERVAL_MS = Number(process.env.WORKER_CLEANUP_INTERVAL_MS ?? 3_600_000); // 1 час
/**
 * Срок хранения отклонённых заявок на регистрацию (ADR 0063): неделя на исправление ошибочного
 * отказа, дальше персональные данные того, кого в портал не пустили, не хранятся. Ноль и меньше —
 * уборка выключена: срок хранения ПДн задаёт эксплуатация, и «выключить» должно быть выразимо.
 */
const REGISTRATION_TTL_DAYS = Number(process.env.USER_REJECTED_REGISTRATION_TTL_DAYS ?? 7);
/**
 * Через сколько дней закрывается заявка, так и не подтвердившая адрес (ADR 0072). Ноль и меньше —
 * выключено: как и у уборки отклонённых, срок задаёт эксплуатация.
 */
const REGISTRATION_EXPIRY_DAYS = Number(process.env.MAIL_REGISTRATION_EXPIRY_DAYS ?? 7);
const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Аренда задачи: сколько времени строка `jobs` считается занятой этим воркером. По истечении её
 * забирает обратно очередь (`reclaimExpiredJobs`), поэтому аренда — это ответ на вопрос «через
 * сколько после смерти процесса задача снова кому-то достанется», а не «сколько она выполняется».
 *
 * Пять минут остаются основой: столько стояло в запросе захвата с самого начала, и для всего, что
 * очередь делает сегодня (удалить объект из S3, отдать письмо SMTP), этого с запасом. Настройка
 * нужна для другого — эксплуатация должна уметь развести две беды, которые тянут срок в разные
 * стороны: слишком короткая аренда отдаёт задачу второму воркеру, пока её делает первый, слишком
 * длинная оставляет очередь стоять после падения процесса.
 *
 * Ниже получаса не берём вовсе: аренда короче интервала опроса и разумного продления — это не
 * настройка, а способ уронить очередь опечаткой в `prod.env`.
 */
const DEFAULT_LEASE_MS = 5 * 60_000;
const MIN_LEASE_MS = 30_000;

function readLeaseMs(): number {
  const raw = process.env.WORKER_LEASE_MS;
  if (!raw) return DEFAULT_LEASE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_LEASE_MS) {
    logger.warn(
      { WORKER_LEASE_MS: raw, minMs: MIN_LEASE_MS, usedMs: DEFAULT_LEASE_MS },
      'WORKER_LEASE_MS задан неверно — берётся значение по умолчанию',
    );
    return DEFAULT_LEASE_MS;
  }
  return value;
}

const LEASE_MS = readLeaseMs();

/**
 * Как часто продлевается аренда взятых задач. Треть срока — чтобы одно неудавшееся продление
 * (сеть моргнула, база перезапустилась) не стоило задаче аренды: до истечения останется ещё две
 * попытки. Пять секунд снизу — чтобы при короткой аренде продление не превратилось в поток
 * запросов к базе.
 */
const LEASE_HEARTBEAT_MS = Math.max(5_000, Math.floor(LEASE_MS / 3));

/**
 * Сколько просроченных задач возвращается в очередь за один заход. С размером пачки не связано:
 * вернуть задачу в очередь — это одна строка `UPDATE`, а выполнить её — секунды и сеть.
 */
const RECLAIM_BATCH = 50;

const JOB_DELETE_S3_OBJECT = 'delete_s3_object';
const JOB_SEND_EMAIL = 'send_email';
/**
 * Прочитать талоны приложенного файла (ADR 0114). Единица работы — файл, а не страница: в
 * транзакции закрытия заявки страниц ещё не существует, есть только `fileId`, и раскладывает файл
 * на страницы уже сам воркер (Р11).
 */
const JOB_RECOGNIZE_WASTE_TICKET_FILE = 'recognize_waste_ticket_file';

// ── Почта ──
//
// Worker знает про письма ровно две вещи: как отдать готовое тело SMTP-серверу и сколько писем в
// минуту разрешено. Составляет письма API — там же, где живут права и область видимости
// получателя; сюда приходит задача с идентификатором строки `mail_messages`.
const MAIL_ENABLED = (process.env.MAIL_ENABLED ?? 'false') === 'true';
const MAIL_TRANSPORT = process.env.MAIL_TRANSPORT === 'smtp' ? 'smtp' : 'log';
const MAIL_MAX_PER_MINUTE = Number(process.env.MAIL_MAX_PER_MINUTE ?? 60);
/** Часы рассылок (ADR 0075): раз в минуту спрашиваем API, чьё время наступило. */
const MAILING_TICK_MS = Number(process.env.MAILING_TICK_INTERVAL_MS ?? 60_000);
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://technic-api:3000';
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
/**
 * Часы автозакрытия заявок оргтехники (план `docs/office-equipment-requests-rework-plan.md`, §7.3,
 * решение Н7): раз в пять минут просим API добрать созревшие заявки «Решена» и закрыть их.
 *
 * Минута здесь была бы лишней точностью: срок молчания заказчика — сутки, и опоздание закрытия на
 * пять минут не значит ничего. Само правило (кого закрывать, с какой даты считать сутки и сколько
 * штук за раз) живёт в API — worker знает только время, как и у рассылок.
 */
const SERVICE_AUTO_CLOSE_TICK_MS = Number(
  process.env.SERVICE_AUTO_CLOSE_TICK_INTERVAL_MS ?? 300_000,
);

/**
 * Каналы поднимаются на старте, а не при первом письме: письмо ждёт очереди часами, и отказ «не
 * задан SMTP_HOST» обнаружился бы вечером на рассылке заданий, а не при выкатке.
 *
 * Каналов может быть несколько (план `docs/office-equipment-mail-and-history-plan.md`, Р83–Р87): у
 * службы ремонта свой ящик на своём сервере, и письмо от её имени через провайдерский транспорт не
 * уйдёт — чужой `From` отвергают. Какой канал у письма, написано в самом письме.
 */
const mailAccounts = createMailAccounts(
  {
    enabled: MAIL_ENABLED,
    transport: MAIL_TRANSPORT as 'log' | 'smtp',
    defaultMaxPerMinute: MAIL_MAX_PER_MINUTE,
  },
  (msg, meta) => logger.info(meta, msg),
);

if (mailAccounts.size === 0) {
  logger.info('Почта выключена (MAIL_ENABLED=false): задачи send_email не обрабатываются');
}

const caPath = process.env.PGSSLROOTCERT;
const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
const dbUrl = new URL(required('DATABASE_URL'));
dbUrl.searchParams.delete('sslmode');

const pool = new pg.Pool({
  connectionString: dbUrl.toString(),
  ssl: ca ? { ca, rejectUnauthorized: true } : false,
  max: Number(process.env.WORKER_DB_POOL_MAX ?? 4),
});

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'ru-central-1',
  endpoint: required('S3_ENDPOINT'),
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  // Отключаем авто-checksum AWS SDK v3 (см. apps/api/src/lib/s3-client.ts).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const bucket = required('S3_BUCKET');

// Диагностика: без секретов; помогает заметить неверный bucket/endpoint в проде.
logger.info(
  {
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Region: process.env.S3_REGION ?? 'ru-central-1',
    s3Bucket: bucket,
    s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
  },
  'S3 конфигурация worker',
);

async function deleteObject(objectKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return; // идемпотентно
    throw e;
  }
}

interface MailRow {
  id: string;
  to_email: string;
  /** Свой обратный адрес письма; пусто — общий `MAIL_REPLY_TO` (миграция 0141). */
  reply_to: string;
  /** Каким каналом отправлять (миграция 0144); у писем прошлых выпусков — основной. */
  account: string;
  subject: string;
  body_text: string;
  body_html: string;
  status: 'pending' | 'sent' | 'failed';
}

/**
 * Отправка одного письма. Тело уже составлено API и лежит в `mail_messages` — worker его не
 * пересобирает: повтор упавшей отправки обязан отправить ровно то, что было составлено, а не
 * пересчитанное по изменившимся с тех пор данным.
 */
async function sendEmail(job: JobRow): Promise<void | { deferUntil: Date }> {
  const mailId = String(job.payload.mailMessageId ?? '');
  if (!mailId) throw new Error('В задаче send_email нет mailMessageId');
  if (mailAccounts.size === 0) {
    // Почту выключили уже после того, как письмо встало в очередь. Это не ошибка задачи: письмо
    // подождёт включения, а не потратит попытки и не уйдёт в dead.
    return { deferUntil: new Date(Date.now() + 15 * 60_000) };
  }

  const res = await pool.query<MailRow>(
    `SELECT id, to_email, reply_to, account, subject, body_text, body_html, status
       FROM mail_messages WHERE id = $1`,
    [mailId],
  );
  const mail = res.rows[0];
  // Письма нет или оно уже отправлено — задача сделана. Так повторный заход после падения между
  // отправкой и фиксацией не шлёт письмо второй раз.
  if (!mail || mail.status === 'sent') return;

  /**
   * Канал письма не настроен на этом сервере — письмо ждёт настройки, а не тратит попытки: чаще
   * всего это выкат, где ящик службы ещё не прописан в `prod.env`. Откладывается **только это**
   * письмо: у остальных каналов свои транспорты, и они идут своим ходом.
   */
  const runtime = mailAccounts.get(mail.account);
  if (!runtime) {
    logger.warn(
      { mailId: mail.id, account: mail.account },
      'Канал письма не настроен на этом сервере — письмо ждёт настройки',
    );
    return { deferUntil: new Date(Date.now() + 15 * 60_000) };
  }

  // Потолок писем в минуту — свой у каждого канала: у корпоративного сервера пределы не те, что у
  // транзакционного провайдера, и общий счётчик душил бы один канал ради другого.
  if (!runtime.rate.take()) return { deferUntil: runtime.rate.freeAt() };

  const { providerId } = await runtime.transport.send({
    to: mail.to_email,
    // Пустой адрес передаётся как есть: правило «своё побеждает общее» живёт в транспорте, и
    // повторять его здесь вторым условием значило бы завести две копии одного решения.
    replyTo: mail.reply_to,
    subject: mail.subject,
    text: mail.body_text,
    html: mail.body_html,
  });

  await pool.query(
    `UPDATE mail_messages
        SET status = 'sent', provider_id = $2, sent_at = now(), last_error = '', updated_at = now()
      WHERE id = $1`,
    [mail.id, providerId],
  );
}

async function handleJob(job: JobRow): Promise<void | { deferUntil: Date }> {
  switch (job.type) {
    case JOB_DELETE_S3_OBJECT: {
      const objectKey = String(job.payload.objectKey ?? '');
      if (objectKey) await deleteObject(objectKey);
      return;
    }
    case JOB_SEND_EMAIL:
      return sendEmail(job);
    case JOB_RECOGNIZE_WASTE_TICKET_FILE:
      return recognizeWasteTicketFile(job);
    default:
      throw new Error(`Неизвестный тип задачи: ${job.type}`);
  }
}

/**
 * Распознавание талонов одного файла. Порядок транзакций и все проверки живут в
 * `ticket-ocr/job.ts` — здесь только сборка зависимостей и признак «модуль выключен».
 *
 * Выключенный модуль не роняет задачу и не тратит попытку: талон мог быть приложен, пока
 * распознавание было включено, а к моменту разбора его выключили — это состояние конфигурации, а
 * не сбой задачи.
 */
/**
 * Потолок обращений к прокси (`TICKET_OCR_MAX_PER_MINUTE`, этап 0).
 *
 * Очередь у прокси общая с чужими сервисами, и лимиты (`maxConcurrency`, `maxPending`) оператор
 * называет для каждого клиента отдельно. Наша вежливость — единственное, что мешает порталу занять
 * её целиком: страница читается за минуты, а задач в очереди бывает десятки.
 *
 * Считается по ЗАДАЧАМ, а не по страницам, и это осознанное упрощение: файл — единица работы, у
 * него от одной до пяти страниц, и точный счёт вызовов потребовал бы состояния в базе на каждый
 * вызов. Значение по умолчанию (30) заведомо ниже любого разумного лимита; узнав настоящий,
 * ставят своё.
 *
 * Счётчик живёт в процессе — как у почты (`RateLimiter`) и по той же причине: воркер в проде
 * один, а точный общий потолок стоил бы записи в БД на каждое обращение.
 */
const ticketRate = new RateLimiter(readTicketOcrConfig().maxPerMinute);

async function recognizeWasteTicketFile(job: JobRow): Promise<void | { deferUntil: Date }> {
  const cfg = readTicketOcrConfig();
  if (!cfg.enabled) {
    logger.info({ jobId: job.id }, 'Распознавание талонов выключено: задача пропущена');
    return;
  }
  // Квота проверяется ДО скачивания файла и до всякой транзакции: ждать внутри неё значило бы
  // держать соединение и замок ключа кэша всё время ожидания. Отложенная задача попытки не тратит.
  if (!ticketRate.take()) {
    const deferUntil = ticketRate.freeAt();
    logger.info(
      { jobId: job.id, deferUntil },
      'Потолок обращений к прокси на минуту исчерпан: задача отложена',
    );
    return { deferUntil };
  }
  const requestId = String(job.payload.requestId ?? '');
  const fileId = String(job.payload.fileId ?? '');
  if (!requestId || !fileId) throw new Error('Задача распознавания без requestId или fileId');

  return runTicketRecognitionJob(
    {
      pool,
      s3,
      bucket,
      engine: createEngineFrom(cfg),
      model: cfg.model,
      escalationModel: cfg.escalationModel,
      preprocess: preprocessOptionsFrom(cfg),
      log: (meta, msg) => logger.info(meta, msg),
    },
    { requestId, fileId, forced: job.payload.forced === true },
    job.id,
  );
}

/**
 * Письмо, которое уже не уйдёт: адрес не существует, домен не принимает почту или кончились
 * попытки. Журнал обязан это показывать — иначе `pending` в нём означало бы и «ждёт очереди», и
 * «никогда не отправится», а разбирают их по-разному.
 */
async function markMailFailed(job: Pick<JobRow, 'type' | 'payload'>, error: string): Promise<void> {
  if (job.type !== JOB_SEND_EMAIL) return;
  const mailId = String(job.payload.mailMessageId ?? '');
  if (!mailId) return;
  await pool.query(
    `UPDATE mail_messages SET status = 'failed', last_error = $2, updated_at = now()
      WHERE id = $1 AND status <> 'sent'`,
    [mailId, error],
  );
}

function backoffMs(attempts: number): number {
  const base = Math.min(300, 5 * 2 ** attempts); // сек, максимум 5 минут
  const jitter = Math.floor(Math.random() * 1000);
  return base * 1000 + jitter;
}

/**
 * Задача, которую у воркера отобрали, пока он её выполнял: аренда истекла, очередь вернула строку,
 * и делает её теперь кто-то другой. Результат в базу не пишется — иначе он затёр бы чужую работу.
 * В журнал это идёт предупреждением, а не ошибкой: сама задача не потеряна, но частота таких
 * записей — прямой сигнал, что аренда короче, чем реальная длительность задач.
 */
function warnJobTaken(job: JobRow, what: string): void {
  logger.warn(
    { jobId: job.id, type: job.type, workerId: WORKER_ID },
    `Задача больше не принадлежит этому воркеру: ${what} не записан`,
  );
}

/**
 * Продление аренды всех задач, которые воркер держит прямо сейчас (ADR-плана Р5: «аренда
 * продлевается на время длинного вызова»).
 *
 * Почему продление, а не «захват долгих типов по одной с увеличенной арендой» — из двух
 * предложенных планом решений выбрано это:
 *
 *   1. увеличенная аренда требует знать длительность ЗАРАНЕЕ, а именно это знание сегодня и
 *      подводит: пять минут были выбраны как «с запасом», и запаса не хватило. Внешний вызов
 *      растягивается провайдером, растеризация — размером файла, отправка — почтовым сервером;
 *      любое новое число окажется таким же угаданным, только больше;
 *   2. одиночный захват лечит только «долгий тип». Пачка из десяти обычных задач по минуте
 *      переживает пятиминутную аренду, не будучи долгой ни в одной из них: срок ставится при
 *      захвате всей пачке разом, а выполняется она последовательно. Поэтому продлеваются ВСЕ
 *      удерживаемые задачи — и та, что выполняется сейчас, и те, что ждут своей очереди;
 *   3. продление опирается на факт («процесс жив и работает»), а не на прогноз, и потому
 *      единственное, что оставляет аренду выполняющей свою работу: умер процесс — продлений нет,
 *      и задача уходит обратно в очередь ровно через срок аренды.
 *
 * Захват долгих типов по одной остаётся полезным, но по другой причине — не корректности, а
 * пропускной способности: двухминутное распознавание не должно держать за собой девять писем.
 * Это делается размером пачки в момент, когда такие типы появятся, и аренды не касается.
 */
function startLeaseHeartbeat(held: Set<string>): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    // Пропуск такта, если предыдущее продление ещё идёт: медленная база не должна получать
    // очередь запросов, каждый из которых делает то же самое.
    if (inFlight || held.size === 0) return;
    const ids = [...held];
    inFlight = true;
    void extendLease(pool, { workerId: WORKER_ID, jobIds: ids, leaseMs: LEASE_MS })
      .then((extended) => {
        if (extended < ids.length) {
          logger.warn(
            { held: ids.length, extended },
            'Аренда продлена не у всех задач: часть уже отобрана очередью',
          );
        }
      })
      .catch((err: unknown) => {
        // Неудавшееся продление — не отказ задачи: она продолжает выполняться, а если база не
        // вернётся до конца аренды, задачу подберёт другой воркер, и записать результат нам уже
        // не дадут. Ронять из-за этого цикл нечем и незачем.
        logger.warn({ err }, 'Не удалось продлить аренду задач');
      })
      .finally(() => {
        inFlight = false;
      });
  }, LEASE_HEARTBEAT_MS);
  // Таймер не держит процесс: при остановке воркер не должен ждать очередного такта продления.
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Возврат в очередь задач, чью аренду никто не продлил. Первым делом в такте — до захвата: иначе
 * задача, брошенная упавшим процессом, ждала бы своей очереди на такт дольше без всякой причины.
 *
 * Отдельно разбирается случай, когда возврат исчерпал попытки: письмо, задача которого ушла в
 * `dead`, обязано перестать быть `pending` в журнале — иначе `pending` там означает и «ждёт
 * очереди», и «уже никогда не уйдёт», а разбирают их по-разному (см. `markMailFailed`).
 */
async function reclaimExpiredSafely(): Promise<void> {
  try {
    const reclaimed = await reclaimExpiredJobs(pool, { limit: RECLAIM_BATCH });
    if (reclaimed.length === 0) return;
    const dead = reclaimed.filter((job) => job.status === 'dead');
    logger.warn(
      { count: reclaimed.length, dead: dead.length, ids: reclaimed.map((job) => job.id) },
      'Задачи с истёкшей арендой возвращены в очередь',
    );
    for (const job of dead) {
      await markMailFailed(job, 'Аренда задачи истекла, попытки исчерпаны');
      logger.error(
        { jobId: job.id, type: job.type, attempts: job.attempts },
        'Задача переведена в dead: аренда истекала столько раз, сколько было попыток',
      );
    }
  } catch (e) {
    // Уборка не должна ронять такт: захват и выполнение задач от неё не зависят.
    logger.warn({ err: e }, 'Не удалось вернуть в очередь задачи с истёкшей арендой');
  }
}

async function processJobs(): Promise<number> {
  await reclaimExpiredSafely();

  const claimed = await claimJobs(pool, { workerId: WORKER_ID, limit: BATCH, leaseMs: LEASE_MS });
  if (claimed.length === 0) return 0;

  // Пачка удерживается целиком, пока не выполнена: задача, ждущая своей очереди внутри пачки,
  // занимает аренду ровно так же, как выполняющаяся, — очередь её уже никому не отдаст.
  const held = new Set(claimed.map((job) => job.id));
  const stopHeartbeat = startLeaseHeartbeat(held);
  try {
    for (const job of claimed) {
      try {
        const outcome = await handleJob(job);
        if (outcome?.deferUntil) {
          // Отложено, а не выполнено и не провалено: попытки не тратятся. Так упирается в потолок
          // отправки рассылка на сотню адресов — она растягивается во времени, а не сгорает.
          const owned = await deferJob(pool, {
            jobId: job.id,
            workerId: WORKER_ID,
            nextRunAt: outcome.deferUntil,
          });
          if (!owned) warnJobTaken(job, 'перенос');
          continue;
        }
        const owned = await completeJob(pool, { jobId: job.id, workerId: WORKER_ID });
        if (!owned) warnJobTaken(job, 'результат');
      } catch (e) {
        const attempts = job.attempts + 1;
        const message = e instanceof Error ? e.message : String(e);
        // Окончательный отказ SMTP (5xx): повторять нечего, а пять заходов по несуществующему
        // адресу портят репутацию отправителя у провайдера.
        if (e instanceof PermanentMailError) {
          const owned = await killJob(pool, {
            jobId: job.id,
            workerId: WORKER_ID,
            attempts,
            error: message,
          });
          if (!owned) {
            warnJobTaken(job, 'отказ SMTP');
            continue;
          }
          // Журнал письма правится только после того, как задача признана нашей: иначе воркер,
          // у которого аренда истекла, пометил бы `failed` письмо, которое второй воркер прямо
          // сейчас успешно отправляет.
          await markMailFailed(job, message);
          logger.error({ jobId: job.id, type: job.type }, `Письмо не будет отправлено: ${message}`);
          continue;
        }
        if (attempts >= job.max_attempts) {
          const owned = await killJob(pool, {
            jobId: job.id,
            workerId: WORKER_ID,
            attempts,
            error: message,
          });
          if (!owned) {
            warnJobTaken(job, 'исчерпание попыток');
            continue;
          }
          await markMailFailed(job, message);
          logger.error({ jobId: job.id, type: job.type }, `Задача переведена в dead: ${message}`);
        } else {
          const next = new Date(Date.now() + backoffMs(attempts));
          const owned = await retryJob(pool, {
            jobId: job.id,
            workerId: WORKER_ID,
            attempts,
            nextRunAt: next,
            error: message,
          });
          if (!owned) {
            warnJobTaken(job, 'повтор');
            continue;
          }
          logger.warn({ jobId: job.id, attempts }, `Повтор задачи: ${message}`);
        }
      } finally {
        // Задача разобрана — продлевать её аренду больше нечем и незачем: следующий такт
        // продления должен видеть только то, что воркер действительно держит.
        held.delete(job.id);
      }
    }
  } finally {
    stopHeartbeat();
  }
  return claimed.length;
}

// ── Уборка брошенных файлов (Р18) ──
//
// Проходов два, протокол один. Первый убирает незавершённые загрузки (`pending` старше суток):
// сессию открыли, файл в хранилище не доложили или доложили, но `complete` не позвали. Второй —
// завершённые загрузки, так и не попавшие никуда (`active` старше недели): форму заполнили,
// фотографию приложили, заявку не сохранили. До появления второго прохода такой файл оставался в
// S3 навсегда — платным и никому не видимым.
//
// Почему протокол общий и почему он именно такой. Прежний проход по `pending` выбирал строки БЕЗ
// блокировки и СНАЧАЛА сносил объект из S3, а метку `deleted` ставил потом. Между этими двумя
// шагами `/files/:id/complete` успевал перевести файл в `active`, а сохранение заявки — привязать
// его: воркер удалял из хранилища уже подшитый документ, оставляя в базе живую ссылку. Чинить один
// новый проход, оставив старый конкурентным, бессмысленно — гонка та же.
//
// Отсюда четыре правила, общие для обоих проходов:
//   1. кандидаты отбираются сразу без связанных (`NOT file_is_linked`), а не фильтруются после
//      выборки: иначе две сотни старых связанных файлов заняли бы `LIMIT` целиком и до настоящих
//      сирот очередь не дошла бы никогда;
//   2. строки берутся `FOR UPDATE SKIP LOCKED` — той же блокировкой, которой сериализует себя
//      привязка (`assertFilesAttachable` берёт `files` `FOR UPDATE`). Порядок по `id` одинаков у
//      всех воркеров, так что взаимной блокировки двух проходов не возникает;
//   3. под блокировкой статус и связанность проверяются ЗАНОВО: между снимком первого запроса и
//      захватом блокировки файл могли и завершить, и привязать;
//   4. метка `deleted` и задача на удаление объекта ставятся ОДНОЙ транзакцией БД, а физически
//      удаляет объект только задача. Так не остаётся окна, в котором файл жив в базе и мёртв в
//      хранилище (или наоборот): либо откатится всё, либо задача уже стоит в очереди.
interface FileCleanupPass {
  /** Статус, в котором файл считается брошенным. */
  status: 'pending' | 'active';
  /** Возраст, после которого файл убирается: интервал PostgreSQL. */
  age: string;
  /** Задержка перед физическим удалением объекта из S3. */
  s3DelayMs: number;
  /** Строка в журнале: проходы разбираются по-разному, и различать их надо без чтения кода. */
  label: string;
}

/** Столько же, сколько было у старого прохода: уборка не должна занимать соединение надолго. */
const FILE_CLEANUP_BATCH = 200;

/** Отсрочка удаления документа в API (`softDeleteFile`): 30 дней на «удалили по ошибке». */
const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const FILE_CLEANUP_PASSES: FileCleanupPass[] = [
  {
    status: 'pending',
    age: '24 hours',
    // Немедленно: `pending` — это незавершённая загрузка, документом она не была ни секунды, и
    // восстанавливать из неё нечего. Так же вёл себя и прежний проход.
    s3DelayMs: 0,
    label: 'незавершённые загрузки',
  },
  {
    status: 'active',
    age: '7 days',
    // С отсрочкой, как у удаления файла из портала. Файл был загружен целиком, и единственное, что
    // отличает брошенный от подшитого, — полнота перечня в `file_is_linked`. Забытая в нём таблица
    // означала бы удаление настоящего документа; тридцать дней в хранилище — цена возможности это
    // заметить и вернуть объект.
    s3DelayMs: S3_DELETE_DELAY_MS,
    label: 'завершённые загрузки без единой связи',
  },
];

/** Один проход уборки. Возвращает число убранных файлов. */
async function cleanupUnlinkedFiles(pass: FileCleanupPass): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM files
        WHERE status = $1
          AND created_at < now() - $2::interval
          AND NOT file_is_linked(id)
        ORDER BY id
        LIMIT ${FILE_CLEANUP_BATCH}
        FOR UPDATE SKIP LOCKED`,
      [pass.status, pass.age],
    );
    if (candidates.rows.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }

    // Повторная проверка под блокировкой — отдельным запросом, а не по данным первого: в
    // READ COMMITTED каждый оператор берёт свой снимок, поэтому здесь видно всё, что успело
    // зафиксироваться, пока мы ждали блокировку. Строки уже наши, и новая привязка встанет в
    // очередь за нашей транзакцией.
    const ids = candidates.rows.map((r) => r.id);
    const confirmed = await client.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM files
        WHERE id = ANY($1::uuid[]) AND status = $2 AND NOT file_is_linked(id)`,
      [ids, pass.status],
    );
    if (confirmed.rows.length > 0) {
      await client.query(
        `UPDATE files SET status='deleted', deleted_at=now() WHERE id = ANY($1::uuid[])`,
        [confirmed.rows.map((r) => r.id)],
      );
      await client.query(
        `INSERT INTO jobs (type, payload, next_run_at)
         SELECT $1, jsonb_build_object('objectKey', k), $3::timestamptz
           FROM unnest($2::text[]) AS k`,
        [
          JOB_DELETE_S3_OBJECT,
          confirmed.rows.map((r) => r.object_key),
          new Date(Date.now() + pass.s3DelayMs),
        ],
      );
    }
    await client.query('COMMIT');
    return confirmed.rows.length;
  } catch (e) {
    // Откат отдельно от ошибки прохода: соединение возвращается в пул чистым, а причину покажет
    // тот, кто звал.
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Оба прохода подряд. Падение одного не отменяет второй: они независимы. */
async function cleanupFiles(): Promise<void> {
  for (const pass of FILE_CLEANUP_PASSES) {
    try {
      const cleaned = await cleanupUnlinkedFiles(pass);
      if (cleaned > 0) {
        logger.info({ count: cleaned, status: pass.status }, `Убраны ${pass.label}`);
      }
    } catch (e) {
      logger.warn({ status: pass.status, err: e }, `Не удалось убрать ${pass.label}`);
    }
  }
}

/**
 * Брошенные черновики отчётов водителей (ADR 0103). Открытие кабинета заводит шапку и строки
 * ожидания, а строка ожидания ЗАНИМАЕТ источник глобально: рейс стоит ровно в одном отчёте на
 * портал. Черновик, который никто не заполнил, держал бы этот рейс вечно — второй отчёт его уже не
 * получит, а окончательное удаление рейса упрётся в ссылку.
 *
 * Условия сноса два, и оба обязательны: отчёт всё ещё `draft` и по нему нет НИ ОДНОГО показания.
 * Отправленный отчёт не трогается никогда, даже пустой: его состав заморожен, и убирать оттуда
 * нечего — изменения задания живут расхождениями.
 *
 * Уборка берёт только суффикс общего протокола блокировок (отчёт → строки) и машину после этого не
 * блокирует ВОВСЕ: цепочку она не трогает, потому что удаляет черновик без единого показания.
 * Кандидаты отбираются без блокировок, затем каждый берётся `FOR UPDATE SKIP LOCKED` и под
 * блокировкой перепроверяется — иначе снос столкнётся с открытием или отправкой того же отчёта.
 */
const DRAFT_REPORT_TTL_DAYS = 7;

async function cleanupAbandonedReports(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Строки ожидания уходят каскадом вместе с шапкой (`ON DELETE CASCADE`), поэтому условие
    // «показаний нет» проверяется по ним, а не по самой шапке: показание ссылается на строку.
    const removed = await client.query<{ id: string }>(
      `DELETE FROM driver_daily_reports r
        WHERE r.id IN (
          SELECT c.id FROM driver_daily_reports c
           WHERE c.state = 'draft'
             AND c.created_at < now() - ($1 || ' days')::interval
             AND NOT EXISTS (
               SELECT 1 FROM vehicle_readings vr WHERE vr.report_id = c.id
             )
           ORDER BY c.id
           LIMIT 200
           FOR UPDATE SKIP LOCKED
        )
          AND r.state = 'draft'
          AND NOT EXISTS (SELECT 1 FROM vehicle_readings vr WHERE vr.report_id = r.id)
        RETURNING r.id`,
      [DRAFT_REPORT_TTL_DAYS],
    );
    await client.query('COMMIT');
    return removed.rows.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Попытки распознавания по сроку (ADR 0114, Р31).
 *
 * Строка уходит целиком, а не «худеет» очисткой ответа модели. Так решено не ради места: попытка
 * со статусом `done` и пустым ответом остаётся ЖИВЫМ КЛЮЧОМ КЭША (Р12) — тот же лист, приложенный
 * заново, попал бы в неё и вернул пустой результат, то есть страницу без единого талона. Молча.
 * Удалённая попытка кэшем просто не находится, и страница читается заново: это стоит одного
 * платного вызова и не стоит ни одной потерянной бумаги.
 *
 * Исключение одно: попытка, на которую ссылается ЖИВОЙ талон, не убирается никогда. Её ответ —
 * происхождение цифры, стоящей в талоне, и стереть его значит потерять единственное объяснение
 * того, откуда взялось «20» на бумаге, где человек видит «28».
 *
 * Предложение перераспознавания такой защиты не даёт намеренно: оно само по себе снимок, обе его
 * ссылки объявлены `ON DELETE SET NULL`, и после уборки оно читается по-прежнему — теряя лишь
 * возможность заглянуть в исходный ответ. Иначе непринятое предложение держало бы попытки вечно.
 */
const ATTEMPT_CLEANUP_BATCH = 500;

async function cleanupTicketAttempts(ttlDays: number): Promise<number> {
  const removed = await pool.query<{ id: string }>(
    `DELETE FROM waste_ticket_recognition_attempts a
      WHERE a.id IN (
        SELECT c.id FROM waste_ticket_recognition_attempts c
         WHERE c.created_at < now() - ($1 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM waste_tickets wt
              WHERE wt.primary_attempt_id = c.id OR wt.escalation_attempt_id = c.id
           )
         ORDER BY c.created_at
         LIMIT ${ATTEMPT_CLEANUP_BATCH}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING a.id`,
    [ttlDays],
  );
  return removed.rows.length;
}

async function cleanupTicketAttemptsSafely(): Promise<void> {
  const cfg = readTicketOcrConfig();
  try {
    const removed = await cleanupTicketAttempts(cfg.attemptTtlDays);
    if (removed > 0) logger.info({ count: removed }, 'Убраны попытки распознавания талонов');
  } catch (e) {
    // Уборка сырья не обязана удаваться: она про место, а не про работу портала.
    logger.warn({ err: e }, 'Не удалось убрать попытки распознавания');
  }
}

async function cleanupDraftReportsSafely(): Promise<void> {
  try {
    const removed = await cleanupAbandonedReports();
    if (removed > 0) logger.info({ count: removed }, 'Убраны брошенные черновики отчётов');
  } catch (e) {
    logger.warn({ err: e }, 'Не удалось убрать брошенные черновики отчётов');
  }
}

/**
 * Заявки, не подтвердившие адрес в срок (ADR 0072), уходят в архив. Отдельно от уборки
 * отклонённых: там снос по сроку хранения ПДн, здесь — закрытие незавершённой регистрации, после
 * которого адрес снова свободен и человек может подать заявку заново.
 */
async function archiveUnverified(): Promise<void> {
  if (!Number.isFinite(REGISTRATION_EXPIRY_DAYS) || REGISTRATION_EXPIRY_DAYS <= 0) return;
  const archived = await archiveUnverifiedRegistrations(pool, {
    expiryDays: REGISTRATION_EXPIRY_DAYS,
  });
  // В лог идут только идентификаторы: адрес — персональные данные, кого закрыли, знает аудит.
  if (archived.length > 0) {
    logger.info({ count: archived.length }, 'Заявки без подтверждения адреса отправлены в архив');
  }
}

/** Уборка отклонённых заявок на регистрацию по сроку (ADR 0063). */
async function cleanupRejectedRegistrations(): Promise<void> {
  if (!Number.isFinite(REGISTRATION_TTL_DAYS) || REGISTRATION_TTL_DAYS <= 0) return;
  const client = await pool.connect();
  try {
    const { purged, skipped } = await purgeExpiredRegistrations(client, {
      ttlDays: REGISTRATION_TTL_DAYS,
    });
    // В лог идут идентификаторы, но не адреса: email — персональные данные, и уборка заводится
    // ровно затем, чтобы их не хранить. Кого удалили — знает журнал аудита.
    if (purged.length > 0) {
      logger.info({ count: purged.length }, 'Удалены отклонённые заявки на регистрацию');
    }
    if (skipped.length > 0) {
      logger.warn(
        { count: skipped.length, ids: skipped.map((r) => r.id) },
        'Заявки не удалены: на учётки ссылаются данные',
      );
    }
  } finally {
    client.release();
  }
}

let stopping = false;
let lastCleanup = 0;
let lastMailingTick = 0;
let lastServiceAutoCloseTick = 0;

/**
 * Тик планировщика рассылок. Пропускается молча, когда почта выключена или секрет не задан: без
 * него `/internal/mail/*` всё равно откажет, и стучаться туда каждую минуту незачем.
 */
async function tickMailingsSafely(): Promise<void> {
  if (!MAIL_ENABLED || !INTERNAL_API_TOKEN) return;
  try {
    await tickMailings({
      apiBaseUrl: INTERNAL_API_URL,
      internalToken: INTERNAL_API_TOKEN,
      log: (meta, msg) => logger.info(meta, msg),
    });
  } catch (e) {
    // API может быть недоступен при выкатке: расписание никуда не денется, следующий тик повторит.
    logger.warn({ err: e }, 'Планировщик рассылок не смог обратиться к API');
  }
}

/**
 * Тик автозакрытия заявок оргтехники (Н7). Пропускается молча без секрета: `/internal/*` без него
 * всё равно откажет.
 *
 * От почты не зависит вовсе — это движение статуса, а не рассылка: при `MAIL_ENABLED=false` заявки
 * обязаны закрываться так же, иначе выключенная почта тихо остановила бы цикл заявок.
 */
async function tickServiceAutoCloseSafely(): Promise<void> {
  if (!INTERNAL_API_TOKEN) return;
  try {
    const res = await fetch(`${INTERNAL_API_URL}/internal/service-requests/auto-close`, {
      method: 'POST',
      headers: { 'x-internal-token': INTERNAL_API_TOKEN },
    });
    if (!res.ok) throw new Error(`API ответил ${res.status}`);
    const stats = (await res.json()) as {
      taken: number;
      closed: number;
      skipped: number;
      failed: number;
    };
    // В лог — только прогоны, которые что-то сделали: пустых здесь большинство, и они превратили бы
    // журнал worker в шум по строке каждые пять минут.
    if (stats.closed > 0 || stats.failed > 0) {
      logger.info(stats, 'Автозакрытие заявок оргтехники');
    }
  } catch (e) {
    // API может быть недоступен при выкатке. Заявка никуда не денется: отбор смотрит на состояние,
    // а не на задачу, и следующий тик возьмёт её снова (Н7).
    logger.warn({ err: e }, 'Автозакрытие заявок оргтехники: API не ответил');
  }
}

async function loop(): Promise<void> {
  // Аренда и продление — в журнал старта: когда задача «выполнилась дважды», первым делом
  // спрашивают именно эти два числа, а они приходят из окружения и могут отличаться от кода.
  logger.info(
    {
      workerId: WORKER_ID,
      batch: BATCH,
      leaseMs: LEASE_MS,
      leaseHeartbeatMs: LEASE_HEARTBEAT_MS,
    },
    'Worker запущен',
  );
  while (!stopping) {
    try {
      const processed = await processJobs();
      if (Date.now() - lastMailingTick > MAILING_TICK_MS) {
        lastMailingTick = Date.now();
        await tickMailingsSafely();
      }
      if (Date.now() - lastServiceAutoCloseTick > SERVICE_AUTO_CLOSE_TICK_MS) {
        lastServiceAutoCloseTick = Date.now();
        await tickServiceAutoCloseSafely();
      }
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        await cleanupFiles();
        // Черновики — до файлов? Нет: наоборот. Снос черновика освобождает источник, но файлов у
        // него нет по построению (показаний-то нет), а вот файлы, брошенные незавершённой
        // отправкой, к моменту этой уборки уже разобраны предыдущим проходом.
        await cleanupDraftReportsSafely();
        // Порядок важен: сначала закрываем незавершённые регистрации, потом сносим отклонённые.
        // Так заявка проходит путь «не подтвердил → архив → снос» в один проход уборки, а не
        // ждёт следующего часа между шагами.
        await archiveUnverified();
        await cleanupRejectedRegistrations();
        // Последней: она ничего не освобождает для других проходов и ни от кого не зависит.
        await cleanupTicketAttemptsSafely();
      }
      if (processed === 0) await sleep(POLL_INTERVAL_MS);
    } catch (e) {
      logger.error({ err: e }, 'Ошибка в цикле worker');
      await sleep(POLL_INTERVAL_MS);
    }
  }
  await Promise.all([...mailAccounts.values()].map((a) => a.transport.close()));
  await pool.end();
  logger.info('Worker остановлен');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

void loop();
