import { sql } from 'drizzle-orm';
import { moscowDateKeyOf } from '@technic/contracts';
import { captchaMetrics } from '../auth/captcha';
import { config } from '../config';
import { db } from '../db/client';
import { assignmentBackstopCounters, assignmentBackstopRefusals } from './assignment-backstop';
import { countLegacyPeriodCalls } from './assignment-legacy-calls';
import { assignmentCommandCounters } from './assignment-command';
import { readAssignmentModeState, readAssignmentPopulation } from './assignment-readiness';

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
 *
 * ВТОРАЯ ЧАСТЬ — МОДУЛЬ ИСТОРИИ НАЗНАЧЕНИЯ (план `docs/assignment-periods-plan.md`, этап 4,
 * волна 4.2; нормы и разбор — [assignment-periods-observability.md](../../../../docs/assignment-periods-observability.md)).
 * Причина та же, что у почты, но с другой стороны: до переключения чтения модуль **молчит по
 * замыслу** — бэкстоп не отказывает, а пишет тень; готовность копится в колонках заявок; режим
 * меняется командой, которую никто не видит. Всё это состояния, о которых узнают последними,
 * а после cutover — от диспетчера. Наружу выведено то, по чему настраивается алерт и то, чем
 * меряется ход миграции:
 *
 * - **режим и время в нём** — заморозка, которую забыли снять, выглядит как «портал сломался»;
 * - **состояния готовности** — сколько заявок осталось довести до `ready` (предикат Р20);
 * - **метки загрязнения и устаревания** — незаконченная ревалидация;
 * - **тень бэкстопа и его боевые отказы** — до и после переключения соответственно;
 * - **исходы команд истории по видам**, и среди них конфликты сериализации: спайк §4.3 назвал их
 *   главным риском многопоточности, а пока протокола повторов нет, каждый такой отказ увидел
 *   человек.
 *
 * Чего здесь **нет** намеренно. Поколения теневого сравнения (его цели считает оператор своей
 * командой в окне выката — держать ради этого два запроса в каждом скрейпе незачем) и «готов ли
 * cutover» одним числом: предикат многосоставный, ответ на него — перечень препятствий, и живёт
 * он в сводке `assignment:report`, а не в графике, на который смотрят раз в квартал.
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
  const asOf = moscowDateKeyOf(new Date());
  const [mail, jobs, runs, overdue, assignmentMode, assignmentPopulation, legacyPeriodCalls] =
    await Promise.all([
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
    /*
     * Управляющая строка — чтение по первичному ключу одной строки, дешевле в этом файле нет
     * ничего. Отсутствие строки означает остановленную запись (fail-closed автомата), и метрика
     * обязана показать это нулём режима, а не пропуском.
     */
    readAssignmentModeState(db),
    /*
     * Готовность — один проход по `vehicle_requests` с восемью `FILTER`. Индекса под него нет и он
     * не нужен: в заказах спецтехники счёт идёт на тысячи (репетиционная база — 5,5 тыс. заявок,
     * 3,4 тыс. в предикате), а один seq scan такой таблицы стоит единицы миллисекунд. Заведись
     * индекс — он всё равно не помог бы: считаются почти все строки, и планировщик выбрал бы скан.
     */
    readAssignmentPopulation(db, asOf),
    /*
     * Клиентский гейт cutover (И5): вызовы старого широкого маршрута с датами за неделю. Считается
     * по журналу, а не процессным счётчиком, — аттестация деплоя снимается через минуту после
     * перезапуска, и счётчик процесса доказывал бы свежесть процесса, а не отсутствие клиентов.
     */
    countLegacyPeriodCalls(db),
  ]);

  const byStatus = (rows: { status: string; count: string }[]) =>
    rows.map((r) => ({ labels: { status: r.status }, value: Number(r.count) }));

  /**
   * Распознавание талонов (ADR 0114, Р30/Р31). Причина та же, что у почты: контур работает без
   * человека, а его отказ выглядит как тишина — «талонов нет» неотличимо от «талоны в порядке».
   *
   * Все окна суточные и считаются по `created_at`: попытка принадлежит содержимому страницы и не
   * привязана к календарю заявки, поэтому «за вчера» здесь означает «вчера читали», а не «вчера
   * возили».
   */
  const [attempts, tokens, blind, review] = await Promise.all([
    db.execute<{ engine: string; status: string; scope: string; count: string }>(
      sql`SELECT engine, status, error_scope AS scope, count(*)::text AS count
            FROM waste_ticket_recognition_attempts
           WHERE created_at > now() - interval '24 hours'
           GROUP BY engine, status, error_scope`,
    ),
    db.execute<{ input: string; output: string }>(
      sql`SELECT coalesce(sum(input_tokens), 0)::text AS input,
                 coalesce(sum(output_tokens), 0)::text AS output
            FROM waste_ticket_recognition_attempts
           WHERE created_at > now() - interval '24 hours' AND engine = 'proxy'`,
    ),
    db.execute<{ status: string; count: string }>(
      sql`SELECT status, count(*)::text AS count FROM waste_ticket_blind_checks GROUP BY status`,
    ),
    // Тот же предикат, что у реестра «требуют разбора» (Р24): график и список обязаны показывать
    // одно число, иначе один из них молча соврёт.
    db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM waste_requests wr
           WHERE wr.deleted_at IS NULL AND (
             EXISTS (SELECT 1 FROM waste_tickets wt
                      WHERE wt.request_id = wr.id
                        AND (wt.status = 'unconfirmed' OR array_length(wt.needs_review_fields, 1) > 0))
             OR EXISTS (SELECT 1 FROM waste_ticket_files wf
                         WHERE wf.request_id = wr.id AND wf.status IN ('unsupported', 'failed'))
             OR EXISTS (SELECT 1 FROM waste_ticket_pages wp
                         WHERE wp.request_id = wr.id AND wp.status = 'failed')
             OR EXISTS (SELECT 1 FROM waste_ticket_blind_checks bc
                          JOIN waste_tickets wt2 ON wt2.id = bc.ticket_id
                         WHERE wt2.request_id = wr.id AND bc.status IN ('pending', 'mismatch'))
           )`,
    ),
  ]);

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
      /*
       * Попытки за сутки в разрезе «чем читали × чем кончилось × чей сбой». Две оси ошибки здесь
       * не для красоты (Р29): `subsystem` означает «сервис не работает» и требует человека,
       * `item` — «эта бумага не читается» и означает лишь работу разбирающему. Алерт ставится на
       * первую; смешай их в одно число — и один упёршийся в лимит файл поднимал бы тревогу.
       */
      name: 'technic_ticket_attempts_24h',
      help: 'Попытки распознавания талонов за сутки: движок, исход, область сбоя',
      type: 'gauge',
      values: attempts.rows.map((r) => ({
        labels: { engine: r.engine, status: r.status, scope: r.scope || 'none' },
        value: Number(r.count),
      })),
    },
    {
      // Расход считается по попытке (Р30). Счёт оператора приходит в конце месяца, а вопрос
      // «сколько мы тратим» задают в середине.
      name: 'technic_ticket_tokens_24h',
      help: 'Токены боевых вызовов распознавания за сутки',
      type: 'gauge',
      values: [
        { labels: { direction: 'input' }, value: Number(tokens.rows[0]?.input ?? 0) },
        { labels: { direction: 'output' }, value: Number(tokens.rows[0]?.output ?? 0) },
      ],
    },
    {
      /*
       * Слепые перепроверки по состоянию (Р31). `pending` — ждут второго человека, `mismatch` —
       * ждут арбитра; растущий `mismatch` означает не плохую модель, а неразобранную очередь: без
       * арбитража расхождение остаётся сигналом «здесь смотреть», а не оценкой точности.
       */
      name: 'technic_ticket_blind_checks',
      help: 'Слепые перепроверки талонов по состоянию',
      type: 'gauge',
      values: byStatus([...blind.rows]),
    },
    {
      name: 'technic_ticket_review_pending',
      help: 'Заявки, чьи талоны ждут человека (реестр «Требуют разбора»)',
      type: 'gauge',
      values: [{ value: Number(review.rows[0]?.count ?? 0) }],
    },
    {
      name: 'technic_mailing_runs_24h',
      help: 'Запуски рассылок за сутки по состоянию',
      type: 'gauge',
      values: byStatus([...runs.rows]),
    },
    {
      /*
       * Теневая диагностика бэкстопа чужих дверей (план `assignment-periods-plan.md`, Р21/Р22,
       * фаза Ж5): сколько раз дверь, машиниста не спрашивающая, задела заказ, у которого история
       * назначения неполна. Пока `read_mode = legacy`, такие операции проходят — счётчик и есть
       * единственный способ узнать о них, не заглядывая в журнал.
       *
       * Значение процессное, а не `count(*)` по `audit_log`: журнал растёт от всего портала,
       * индекса по `action` у него нет, и скрейп раз в десятки секунд просматривал бы его целиком.
       * Ненулевое значение — повод открыть журнал: `action = 'assignment.backstop_shadow'`,
       * `entity_type = 'vehicle_request'`, и в `metadata` лежат те самые `requiredAnchors`.
       */
      name: 'technic_assignment_backstop_shadow',
      help: 'Срабатывания теневого бэкстопа истории назначения по дверям (с запуска процесса)',
      type: 'counter',
      values: assignmentBackstopCounters().map((c) => ({
        labels: { door: c.door },
        value: c.count,
      })),
    },
    {
      /*
       * Боевые отказы того же бэкстопа. Отдельная метрика, а не метка у прежней: счётчик тени в
       * режиме `history` замолкает по построению (отказ бросается до записи диагностики), и одна
       * метрика на оба состояния показывала бы падение до нуля ровно тогда, когда двери начали
       * отказывать. Разбор — риски §11 плана, пп. 12, 15, 16, 23.
       */
      name: 'technic_assignment_backstop_refusals',
      help: 'Отказы бэкстопа истории назначения по дверям после переключения чтения (с запуска процесса)',
      type: 'counter',
      values: assignmentBackstopRefusals().map((c) => ({
        labels: { door: c.door },
        value: c.count,
      })),
    },
    {
      /*
       * Исходы команд истории (каркас §8). Метка `outcome = serialization` — то самое исчерпание
       * повторов: спайк §4.3 показал, что общей строкой портала является в том числе счётчик
       * номеров бланков, и `W` считается по всему порталу, а не по заявке. `frozen` вне окна
       * выката означает забытую заморозку.
       */
      name: 'technic_assignment_command',
      help: 'Исходы команд истории назначения по дверям (с запуска процесса)',
      type: 'counter',
      values: assignmentCommandCounters().map((c) => ({
        labels: { door: c.door, outcome: c.outcome },
        value: c.count,
      })),
    },
    {
      /*
       * Режим модуля значением метки, а не числом: значений у него три и два, и график «сколько
       * сейчас 2» не читается никем. Единица на живой комбинации, ноль на остальных — обычный для
       * Prometheus приём info-метрики, по нему пишется и алерт («не `normal` дольше часа»), и
       * подпись на графике.
       */
      name: 'technic_assignment_mode',
      help: 'Режим модуля истории назначения: 1 у действующей пары «запись/чтение»',
      type: 'gauge',
      values: assignmentMode
        ? [{ labels: { write: assignmentMode.writeMode, read: assignmentMode.readMode }, value: 1 }]
        : // Строки нет — запись остановлена fail-closed, и молчать об этом нельзя.
          [{ labels: { write: 'missing', read: 'missing' }, value: 0 }],
    },
    {
      /*
       * Сколько секунд запись не в обычном режиме. Ноль при `normal`.
       *
       * Это главный алерт модуля до cutover: заморозка — операция на десятки минут, и забытая
       * означает портал, который «не сохраняет заявки» без единой ошибки в логах. Считается от
       * `updated_at` управляющей строки: её двигает только дверь режима.
       */
      name: 'technic_assignment_write_frozen_seconds',
      help: 'Сколько секунд запись модуля истории назначения не в обычном режиме (0 — норма)',
      type: 'gauge',
      values: [
        {
          value:
            assignmentMode && assignmentMode.writeMode !== 'normal'
              ? Math.max(0, Math.round((Date.now() - assignmentMode.updatedAt.getTime()) / 1000))
              : 0,
        },
      ],
    },
    {
      /*
       * Клиентский гейт cutover (И5): сколько раз за последнюю неделю срок работ правили **старым**
       * широким маршрутом вместо двери `/period`. Ноль — условие переключения чтения: после него
       * такой запрос получает `409 CLIENT_UPGRADE_REQUIRED`, и ненулевое значение означает живого
       * клиента, который разреза не знает.
       *
       * Gauge со скользящим окном, а не counter: вопрос здесь не «сколько было всего», а «есть ли
       * они сейчас», и ответ обязан со временем возвращаться к нулю сам.
       */
      name: 'technic_assignment_legacy_period_calls',
      help: 'Правок срока старым широким маршрутом за 7 дней (0 — клиентский гейт cutover пройден)',
      type: 'gauge',
      values: [{ value: legacyPeriodCalls }],
    },
    {
      /*
       * Ход миграции: заявки предиката Р20 + Р28 по состоянию истории. Сумма трёх значений и есть
       * популяция, требующая готовности; `ready` растёт прогоном бэкфилла и дверьми, `materialized`
       * убывает ремонтом. Метка `state` — те же три слова, что в колонке.
       */
      name: 'technic_assignment_history_requests',
      help: 'Заявки, требующие готовности истории (Р20 + Р28), по состоянию',
      type: 'gauge',
      values: [
        { labels: { state: 'empty' }, value: assignmentPopulation.empty },
        { labels: { state: 'materialized' }, value: assignmentPopulation.materialized },
        { labels: { state: 'ready' }, value: assignmentPopulation.ready },
      ],
    },
    {
      /*
       * Пометки поверх состояний, и они пересекаются с ним и друг с другом — поэтому отдельная
       * метрика, а не четвёртое значение `state`:
       *
       * - `dirty` — внутри дня история разошлась с бумагой (К4). Вне окна выката ненулевое
       *   значение — тревога: метка снимается тем же пересчётом, что и состояние;
       * - `stale` — состояние считалось не на сегодня. Вне окна выката это **норма** (границу
       *   изменяемого двигает календарь, пересчёт ленивый, З1), и алерта на нём нет; в окне выката
       *   это шкала ревалидации, которую доводят до нуля;
       * - `no_assignment` — заявка в работе без назначенной машины: истории не из чего строить, и
       *   прогон её не починит ни в первый раз, ни в десятый (Ю64 — 9,4 % репетиционной базы).
       */
      name: 'technic_assignment_history_flags',
      help: 'Пометки готовности истории: dirty — загрязнение, stale — пересчёт не на сегодня, no_assignment — нечего восстанавливать',
      type: 'gauge',
      values: [
        { labels: { flag: 'dirty' }, value: assignmentPopulation.dirty },
        { labels: { flag: 'stale' }, value: assignmentPopulation.stale },
        { labels: { flag: 'no_assignment' }, value: assignmentPopulation.emptyWithoutAssignment },
      ],
    },
    {
      // Растёт только если планировщик молчит: обычный запуск сдвигает время сразу.
      name: 'technic_mailing_schedules_overdue',
      help: `Включённые расписания, чьё время прошло более ${OVERDUE_MINUTES} минут назад`,
      type: 'gauge',
      values: [{ value: Number(overdue.rows[0]?.count ?? '0') }],
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
