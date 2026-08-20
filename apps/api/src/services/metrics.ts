import { sql } from 'drizzle-orm';
import { captchaMetrics } from '../auth/captcha';
import { config } from '../config';
import { db } from '../db/client';

/**
 * Метрики для мониторинга (§20, ADR 0075/0078).
 *
 * Почта — единственная часть портала, которая работает без человека: письмо составляется ночью,
 * отправляется фоном и о своей неудаче никому не рассказывает. Ошибку в интерфейсе кто-нибудь
 * заметит и позвонит; молчащую рассылку — нет, и узнают о ней тогда, когда водитель не приедет.
 * Поэтому наружу выведено ровно то, по чему настраиваются алерты: письма, которые уже не уйдут,
 * задачи, исчерпавшие попытки, и расписания, чьё время прошло, — последнее означает, что worker
 * не тикает вовсе.
 *
 * Формат — текстовый Prometheus. Значения считаются на каждый скрейп: запросы идут по индексам
 * (`mail_messages_status_idx`, `jobs_due_idx`), а частота скрейпа — раз в десятки секунд.
 */

interface MetricSample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  values: { labels?: Record<string, string>; value: number }[];
}

function render(samples: MetricSample[]): string {
  const lines: string[] = [];
  for (const metric of samples) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const point of metric.values) {
      const labels = point.labels
        ? `{${Object.entries(point.labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',')}}`
        : '';
      lines.push(`${metric.name}${labels} ${point.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Расписание считается просроченным не в момент наступления времени, а спустя запас: планировщик
 * тикает раз в минуту, и мгновенная тревога срабатывала бы на каждом штатном запуске.
 */
const OVERDUE_MINUTES = 10;

export async function collectMetrics(): Promise<string> {
  const captcha = captchaMetrics();
  const [mail, jobs, runs, overdue] = await Promise.all([
    db.execute<{ status: string; count: string }>(
      sql`SELECT status::text AS status, count(*)::text AS count
            FROM mail_messages
           WHERE NOT is_test
           GROUP BY status`,
    ),
    db.execute<{ status: string; count: string }>(
      sql`SELECT status::text AS status, count(*)::text AS count
            FROM jobs
           GROUP BY status`,
    ),
    db.execute<{ status: string; count: string }>(
      sql`SELECT status::text AS status, count(*)::text AS count
            FROM mailing_runs
           WHERE created_at > now() - interval '24 hours'
           GROUP BY status`,
    ),
    db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count
            FROM mailing_schedules
           WHERE is_enabled
             AND next_run_at IS NOT NULL
             AND next_run_at < now() - (${OVERDUE_MINUTES} || ' minutes')::interval`,
    ),
  ]);

  const byStatus = (rows: { status: string; count: string }[]) =>
    rows.map((r) => ({ labels: { status: r.status }, value: Number(r.count) }));

  return render([
    {
      name: 'technic_up',
      help: '1 если сервис жив',
      type: 'gauge',
      values: [{ value: 1 }],
    },
    {
      // Отладочные письма исключены: проверка вёрстки не должна выглядеть сбоем доставки.
      name: 'technic_mail_messages',
      help: 'Письма в журнале по состоянию (без отладочных)',
      type: 'gauge',
      values: byStatus([...mail.rows]),
    },
    {
      name: 'technic_jobs',
      help: 'Фоновые задачи по состоянию; dead — исчерпаны попытки',
      type: 'gauge',
      values: byStatus([...jobs.rows]),
    },
    {
      name: 'technic_mailing_runs_24h',
      help: 'Запуски рассылок за сутки по состоянию',
      type: 'gauge',
      values: byStatus([...runs.rows]),
    },
    {
      // Растёт только если планировщик молчит: обычный запуск сдвигает время сразу.
      name: 'technic_mailing_schedules_overdue',
      help: `Включённые расписания, чьё время прошло более ${OVERDUE_MINUTES} минут назад`,
      type: 'gauge',
      values: [{ value: Number(overdue.rows[0]?.count ?? '0') }],
    },
    {
      // Первая метрика портала, которая считается не из БД, а из памяти процесса: проверка капчи
      // никуда не записывается, и заводить ради счётчика таблицу значило бы писать в базу на
      // каждую регистрацию. Рестарт API обнуляет counter — для Prometheus это штатно (`rate()`
      // сброс распознаёт), тем более что API работает одним экземпляром.
      //
      // Все три исхода выводятся всегда, включая нулевые: иначе ряд появлялся бы только после
      // первого события, и алерт на `fail_open` не с чем было бы сравнивать до первого сбоя.
      name: 'technic_captcha_checks_total',
      help: 'Проверки SmartCaptcha по исходу; fail_open — проверить не удалось, запрос пропущен',
      type: 'counter',
      values: Object.entries(captcha.checks).map(([result, value]) => ({
        labels: { result },
        value,
      })),
    },
    {
      // Без этого ряда «капча выключена правкой env» снаружи неотличимо от «капча включена, но
      // регистраций не было»: у выключенной все счётчики нули, и узнать правду можно только
      // дёрнув `GET /auth/captcha`. В production капча обязана быть включена (config.ts), поэтому
      // ноль здесь — сам по себе повод для тревоги.
      name: 'technic_captcha_enabled',
      help: '1 — ключи SmartCaptcha заданы и проверка работает; 0 — капча выключена',
      type: 'gauge',
      values: [{ value: config.captcha.enabled ? 1 : 0 }],
    },
    {
      // Имя названо ровно тем, что проверяется: мусорный токен отвергается. «Капча защищает» из
      // этого не следует — тот же `failed` вернётся и на неверный серверный ключ.
      name: 'technic_captcha_invalid_token_rejected',
      help: '1 — заведомо мусорный токен отвергнут; 0 — принят или проверить не удалось',
      type: 'gauge',
      values: [{ value: captcha.invalidTokenRejected }],
    },
    {
      // Без отметки времени единица могла бы навсегда остаться от давнего прогона. Двигается после
      // каждой попытки — и удачной, и нет: возраст говорит о живости самого canary, исход — гаугом
      // выше. Смешивать эти два сигнала в одном значении нельзя.
      name: 'technic_captcha_canary_last_run_seconds',
      help: 'Unix-время последней завершённой попытки canary; 0 — не отработал ни разу',
      type: 'gauge',
      values: [{ value: captcha.canaryLastRunSeconds }],
    },
  ]);
}
