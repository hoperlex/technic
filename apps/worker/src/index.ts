import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import { archiveUnverifiedRegistrations, purgeExpiredRegistrations } from './retention';
import { createMailTransport, PermanentMailError } from './mail-transport';
import { tickMailings } from './mail-scheduler';
import { MailRateLimiter } from './mail-rate';

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

const JOB_DELETE_S3_OBJECT = 'delete_s3_object';
const JOB_SEND_EMAIL = 'send_email';

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
 * Настройка проверяется на старте, а не при первом письме: письмо ждёт очереди часами, и отказ
 * «не задан SMTP_HOST» обнаружился бы вечером на рассылке заданий, а не при выкатке.
 */
function mailConfig() {
  if (!MAIL_ENABLED) return null;
  const cfg = {
    transport: MAIL_TRANSPORT as 'log' | 'smtp',
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.MAIL_FROM ?? '',
    replyTo: process.env.MAIL_REPLY_TO ?? '',
  };
  if (cfg.transport === 'smtp') {
    const missing = (['host', 'user', 'password', 'from'] as const).filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new Error(
        `MAIL_ENABLED=true с MAIL_TRANSPORT=smtp требует SMTP_HOST, SMTP_USER, SMTP_PASSWORD и MAIL_FROM (не заданы: ${missing.join(', ')})`,
      );
    }
  }
  return cfg;
}

const mailCfg = mailConfig();
const mailTransport = mailCfg
  ? createMailTransport(mailCfg, (msg, meta) => logger.info(meta, msg))
  : null;
const mailRate = new MailRateLimiter(MAIL_MAX_PER_MINUTE);

if (mailCfg) {
  // Без секретов: видно, куда и чем отправляем, — этого хватает, чтобы заметить чужой SMTP в проде.
  logger.info(
    { transport: mailCfg.transport, host: mailCfg.host, port: mailCfg.port, from: mailCfg.from },
    'Почтовый транспорт worker',
  );
  /**
   * Почтовые службы общего назначения (Яндекс, Mail.ru) отправляют письмо только от адреса самого
   * ящика: чужой `From` они отвергают ответом 550, и произойдёт это на первом же письме, ночью, а
   * выглядеть будет как «рассылка не работает». Предупреждение, а не отказ старта: у транзакционных
   * провайдеров отправка от произвольного адреса подтверждённого домена — норма.
   */
  if (mailCfg.transport === 'smtp' && mailCfg.user && !mailCfg.from.includes(mailCfg.user)) {
    logger.warn(
      { from: mailCfg.from, user: mailCfg.user },
      'MAIL_FROM не содержит адрес SMTP-ящика: почтовые службы общего назначения такие письма отвергают',
    );
  }
} else {
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

interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

interface MailRow {
  id: string;
  to_email: string;
  /** Свой обратный адрес письма; пусто — общий `MAIL_REPLY_TO` (миграция 0141). */
  reply_to: string;
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
  if (!mailTransport) {
    // Почту выключили уже после того, как письмо встало в очередь. Это не ошибка задачи: письмо
    // подождёт включения, а не потратит попытки и не уйдёт в dead.
    return { deferUntil: new Date(Date.now() + 15 * 60_000) };
  }

  const res = await pool.query<MailRow>(
    `SELECT id, to_email, reply_to, subject, body_text, body_html, status
       FROM mail_messages WHERE id = $1`,
    [mailId],
  );
  const mail = res.rows[0];
  // Письма нет или оно уже отправлено — задача сделана. Так повторный заход после падения между
  // отправкой и фиксацией не шлёт письмо второй раз.
  if (!mail || mail.status === 'sent') return;

  if (!mailRate.take()) return { deferUntil: mailRate.freeAt() };

  const { providerId } = await mailTransport.send({
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
    default:
      throw new Error(`Неизвестный тип задачи: ${job.type}`);
  }
}

/**
 * Письмо, которое уже не уйдёт: адрес не существует, домен не принимает почту или кончились
 * попытки. Журнал обязан это показывать — иначе `pending` в нём означало бы и «ждёт очереди», и
 * «никогда не отправится», а разбирают их по-разному.
 */
async function markMailFailed(job: JobRow, error: string): Promise<void> {
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

async function processJobs(): Promise<number> {
  const claimed = await pool.query<JobRow>(
    `UPDATE jobs SET status='running', locked_by=$1, locked_until=now() + interval '5 minutes', updated_at=now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status='pending' AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [WORKER_ID, BATCH],
  );

  for (const job of claimed.rows) {
    try {
      const outcome = await handleJob(job);
      if (outcome?.deferUntil) {
        // Отложено, а не выполнено и не провалено: попытки не тратятся. Так упирается в потолок
        // отправки рассылка на сотню адресов — она растягивается во времени, а не сгорает.
        await pool.query(
          `UPDATE jobs SET status='pending', next_run_at=$2, locked_by=NULL, locked_until=NULL, updated_at=now() WHERE id=$1`,
          [job.id, outcome.deferUntil],
        );
        continue;
      }
      await pool.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
    } catch (e) {
      const attempts = job.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      // Окончательный отказ SMTP (5xx): повторять нечего, а пять заходов по несуществующему адресу
      // портят репутацию отправителя у провайдера.
      if (e instanceof PermanentMailError) {
        await pool.query(
          `UPDATE jobs SET status='dead', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`,
          [job.id, attempts, message],
        );
        await markMailFailed(job, message);
        logger.error({ jobId: job.id, type: job.type }, `Письмо не будет отправлено: ${message}`);
        continue;
      }
      if (attempts >= job.max_attempts) {
        await pool.query(
          `UPDATE jobs SET status='dead', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`,
          [job.id, attempts, message],
        );
        await markMailFailed(job, message);
        logger.error({ jobId: job.id, type: job.type }, `Задача переведена в dead: ${message}`);
      } else {
        const next = new Date(Date.now() + backoffMs(attempts));
        await pool.query(
          `UPDATE jobs SET status='pending', attempts=$2, next_run_at=$3, last_error=$4, updated_at=now() WHERE id=$1`,
          [job.id, attempts, next, message],
        );
        logger.warn({ jobId: job.id, attempts }, `Повтор задачи: ${message}`);
      }
    }
  }
  return claimed.rows.length;
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

async function loop(): Promise<void> {
  logger.info({ workerId: WORKER_ID }, 'Worker запущен');
  while (!stopping) {
    try {
      const processed = await processJobs();
      if (Date.now() - lastMailingTick > MAILING_TICK_MS) {
        lastMailingTick = Date.now();
        await tickMailingsSafely();
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
      }
      if (processed === 0) await sleep(POLL_INTERVAL_MS);
    } catch (e) {
      logger.error({ err: e }, 'Ошибка в цикле worker');
      await sleep(POLL_INTERVAL_MS);
    }
  }
  await mailTransport?.close();
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
