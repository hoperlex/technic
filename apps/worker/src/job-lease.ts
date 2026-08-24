/**
 * Аренда фоновой задачи: кто держит строку `jobs`, до какого момента и что происходит, когда срок
 * вышел.
 *
 * Отдельным модулем от цикла воркера по той же причине, что и `retention.ts`: здесь всё решение —
 * это условия отбора и `WHERE` у завершающих запросов, а проверить их можно только на живой схеме.
 * Цикл же должен читаться как последовательность шагов, а не как четыре похожих `UPDATE` подряд.
 *
 * Почему аренды до сих пор фактически не было (план `docs/waste-ticket-ocr-plan.md`, Р5). Поле
 * `locked_until` заполнялось, но не читал его никто: выборка брала только `status='pending'`, так
 * что задача, взятая упавшим процессом, оставалась `running` навсегда — ни один воркер её больше не
 * видел. Завершение писалось по одному `id`, без владельца: вернувшийся к жизни «зомби» дописывал
 * результат поверх работы того, кто задачу уже переделал. А сам срок ставился один на всю пачку из
 * десяти задач, выполняемых последовательно, — десять задач по минуте переживали собственную
 * пятиминутную аренду, ничего при этом не нарушив.
 *
 * Отсюда три части: возврат просроченных в очередь (`reclaimExpiredJobs`), захват с настраиваемым
 * сроком (`claimJobs`) и завершающие запросы, которые пишут результат ТОЛЬКО если задача всё ещё
 * принадлежит этому воркеру. Продление аренды живёт в цикле (`index.ts`), но опирается на
 * `extendLease` отсюда — по тому же условию владельца.
 */

export interface JobLeaseClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Строка задачи в том виде, в каком её выполняет воркер. Псевдоним, а не `interface`: строку из БД
 * принимает только тип с индексной сигнатурой (та же причина, что у `ExpiredRegistration`).
 */
export type JobRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/** Что стало с задачей, у которой истекла аренда: вернулась в очередь или исчерпала попытки. */
export type ReclaimedJob = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  status: 'pending' | 'dead';
};

/**
 * Возврат в очередь задач, чья аренда истекла.
 *
 * Отдельным запросом, а не расширением условия выборки (`status='pending' OR аренда истекла`),
 * ровно из-за счётчика попыток. Истёкшая аренда — это не «задача подождала», это «взявший её
 * процесс не дожил до конца»: чаще всего перезапуск при выкате, но ровно так же выглядит и задача,
 * которая этот процесс убивает (память, зависший вызов, падение рантайма). Если возвращать её в
 * очередь как есть, портал получает вечный цикл: воркер берёт задачу, умирает, поднимается, берёт
 * ту же задачу. Поэтому возврат СЧИТАЕТ попытку — и когда попытки кончились, кладёт задачу в
 * `dead`, как это делает обычный отказ. Обнулять `attempts` нельзя тем более: тогда бы цикл стал
 * вечным при любом раскладе.
 *
 * `next_run_at` ставится в `now()`: отсрочка уже случилась — задача пролежала в `running` всю
 * аренду, то есть минуты, и второй backoff поверх неё ничего не добавит, кроме задержки выката,
 * когда воркер перезапустили штатно.
 *
 * Строки берутся `FOR UPDATE SKIP LOCKED`: воркеров может быть несколько, и возврат одной и той же
 * задачи двумя из них — это две потраченные попытки вместо одной.
 */
export async function reclaimExpiredJobs(
  client: JobLeaseClient,
  opts: { limit: number },
): Promise<ReclaimedJob[]> {
  const res = await client.query<ReclaimedJob>(
    `UPDATE jobs
        SET status = CASE
              WHEN attempts + 1 >= max_attempts THEN 'dead'::job_status
              ELSE 'pending'::job_status
            END,
            attempts = attempts + 1,
            next_run_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = 'Аренда истекла: ' || COALESCE(locked_by, 'неизвестный воркер') ||
                         ' не довёл задачу до конца',
            updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'running' AND locked_until < now()
         ORDER BY locked_until
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts, status`,
    [opts.limit],
  );
  return [...res.rows];
}

/**
 * Захват порции задач. Срок аренды приходит параметром, а не зашит в запрос: раньше здесь стояли
 * фиксированные пять минут, и «сколько задача может выполняться» оказывалось решением, принятым
 * один раз за всю очередь — от удаления объекта в S3 (доли секунды) до распознавания скана (до
 * двух минут на страницу).
 */
export async function claimJobs(
  client: JobLeaseClient,
  opts: { workerId: string; limit: number; leaseMs: number },
): Promise<JobRow[]> {
  const res = await client.query<JobRow>(
    `UPDATE jobs
        SET status = 'running',
            locked_by = $1,
            locked_until = now() + ($3::double precision * interval '1 millisecond'),
            updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending' AND next_run_at <= now()
         ORDER BY next_run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts, max_attempts`,
    [opts.workerId, opts.limit, opts.leaseMs],
  );
  return [...res.rows];
}

/**
 * Продление аренды у задач, которые воркер держит прямо сейчас. Возвращает число продлённых строк:
 * если оно меньше запрошенного, часть задач уже отобрана — и это единственный способ узнать об
 * этом до того, как их результат попытается записаться.
 *
 * Условие владельца здесь такое же, как у завершающих запросов, и по той же причине: продлевать
 * аренду задачи, которую уже забрал другой воркер, значит отнимать её обратно посреди выполнения.
 */
export async function extendLease(
  client: JobLeaseClient,
  opts: { workerId: string; jobIds: string[]; leaseMs: number },
): Promise<number> {
  if (opts.jobIds.length === 0) return 0;
  const res = await client.query(
    `UPDATE jobs
        SET locked_until = now() + ($3::double precision * interval '1 millisecond'),
            updated_at = now()
      WHERE id = ANY($1::uuid[]) AND locked_by = $2 AND status = 'running'`,
    [opts.jobIds, opts.workerId, opts.leaseMs],
  );
  return res.rowCount ?? 0;
}

/**
 * Общая часть всех завершающих запросов: писать результат можно, только если задача всё ещё наша.
 *
 * `locked_by = $2` — это и есть проверка владельца. Без неё воркер, у которого аренда истекла
 * (завис на сети, встал на паузу, потерял базу), возвращался бы и писал `done` поверх задачи,
 * которую в это время выполняет кто-то другой: результат второго воркера потерялся бы молча, а
 * при провале — ещё и попытка была бы посчитана дважды.
 *
 * Ответ `false` означает ровно одно: «задача больше не наша». Что с этим делать — решает вызвавший:
 * побочное действие уже произошло (письмо ушло, объект удалён), и второй воркер его повторит. Это
 * цена доставки «хотя бы раз», а не дефект: обе операции идемпотентны по построению.
 */
async function finishOwned(
  client: JobLeaseClient,
  sql: string,
  params: unknown[],
): Promise<boolean> {
  const res = await client.query(sql, params);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Задача выполнена. `locked_by` намеренно не обнуляется: строка уже вышла из очереди по статусу, а
 * отметка «кто выполнил» — это единственное, что потом отвечает на вопрос, чей это был процесс.
 */
export function completeJob(
  client: JobLeaseClient,
  opts: { jobId: string; workerId: string },
): Promise<boolean> {
  return finishOwned(
    client,
    `UPDATE jobs
        SET status = 'done', updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [opts.jobId, opts.workerId],
  );
}

/**
 * Задача отложена: попытки не тратятся. Так растягивается во времени рассылка, упершаяся в потолок
 * отправки, и так ждёт настройки письмо канала, которого на этом сервере ещё нет.
 */
export function deferJob(
  client: JobLeaseClient,
  opts: { jobId: string; workerId: string; nextRunAt: Date },
): Promise<boolean> {
  return finishOwned(
    client,
    `UPDATE jobs
        SET status = 'pending', next_run_at = $3, locked_by = NULL, locked_until = NULL,
            updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [opts.jobId, opts.workerId, opts.nextRunAt],
  );
}

/** Задача упала, но попытки ещё есть: обратно в очередь с отсрочкой. */
export function retryJob(
  client: JobLeaseClient,
  opts: { jobId: string; workerId: string; attempts: number; nextRunAt: Date; error: string },
): Promise<boolean> {
  return finishOwned(
    client,
    `UPDATE jobs
        SET status = 'pending', attempts = $3, next_run_at = $4, last_error = $5,
            locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [opts.jobId, opts.workerId, opts.attempts, opts.nextRunAt, opts.error],
  );
}

/** Задача больше не будет выполняться: попытки кончились или отказ окончательный. */
export function killJob(
  client: JobLeaseClient,
  opts: { jobId: string; workerId: string; attempts: number; error: string },
): Promise<boolean> {
  return finishOwned(
    client,
    `UPDATE jobs
        SET status = 'dead', attempts = $3, last_error = $4, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [opts.jobId, opts.workerId, opts.attempts, opts.error],
  );
}
