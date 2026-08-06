import { sql } from 'drizzle-orm';
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
  ]);
}
