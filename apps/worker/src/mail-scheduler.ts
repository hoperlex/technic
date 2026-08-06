/**
 * Часы рассылок (ADR 0075): worker раз в минуту спрашивает API, чьё время наступило, и просит
 * выполнить запуск.
 *
 * Почему часы здесь, а сборка письма — в API. Тикать раз в минуту должен процесс, который живёт
 * фоном и которому не мешает ждать: у API на это есть только запросы. А собирать письмо должен тот,
 * кто знает права и область видимости получателя, — то есть API. Отсюда разделение: worker знает
 * время, API знает содержание.
 *
 * Планировщик не хранит состояния: наступившее время лежит в `mailing_schedules.next_run_at`, а
 * защита от двойной рассылки — в уникальном индексе `(schedule_id, planned_at)`. Поэтому два
 * worker'а, проснувшиеся одновременно, безопасны: второй получит «запуск уже создан» и ничего не
 * сделает.
 */

export interface SchedulerDeps {
  /** База API: внутри сети это `http://technic-api:3000`. */
  apiBaseUrl: string;
  internalToken: string;
  log: (meta: Record<string, unknown>, msg: string) => void;
}

interface DueSchedule {
  id: string;
  plannedAt: string;
}

interface RunResult {
  created: boolean;
  runId: string | null;
  stats: Record<string, number> | null;
}

async function callApi<T>(
  deps: SchedulerDeps,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const res = await fetch(`${deps.apiBaseUrl}${path}`, {
    method: init.method,
    headers: {
      'x-internal-token': deps.internalToken,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`API ответил ${res.status} на ${init.method} ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * Один тик планировщика. Ошибка одного расписания не отменяет остальные: рассылка заданий не должна
 * пропадать из-за того, что рядом сломался дайджест.
 */
export async function tickMailings(deps: SchedulerDeps): Promise<number> {
  if (!deps.internalToken) return 0;

  const due = await callApi<DueSchedule[]>(deps, '/internal/mail/schedules/due', { method: 'GET' });
  let started = 0;

  for (const schedule of due) {
    try {
      const result = await callApi<RunResult>(deps, '/internal/mail/runs', {
        method: 'POST',
        body: { scheduleId: schedule.id, plannedAt: schedule.plannedAt },
      });
      // `created: false` — запуск уже завёл кто-то другой. Это штатный исход при нескольких
      // worker'ах, а не ошибка, и в лог он идёт только для наблюдения.
      if (result.created) {
        started += 1;
        deps.log(
          { scheduleId: schedule.id, runId: result.runId, ...result.stats },
          'Рассылка выполнена',
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Расписание остаётся с прежним `next_run_at` только если API не дошёл до его пересчёта;
      // тогда следующий тик повторит попытку. Двойной рассылки при этом не будет — её держит
      // уникальность запуска.
      deps.log({ scheduleId: schedule.id, err: message }, 'Запуск рассылки не удался');
    }
  }
  return started;
}
