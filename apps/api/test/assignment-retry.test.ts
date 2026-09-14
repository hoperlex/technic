import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Только типы: значения обоих модулей берутся через `await import` уже после того, как выставлено
// окружение, — протокол читает настройки, а каркас тянет клиент базы, и оба падают без env.
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentRetry from '../src/services/assignment-retry';

/**
 * Протокол повторов на ошибке сериализации — решение В4 плана
 * (`docs/assignment-periods-plan.md`, §14c В4, «Протокол повторов (В4)», «Исчерпание повторов (В4,
 * уточнено спайком)»; закон конкуренции — [спайк](../../../docs/assignment-periods-spike.md), §4.3).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Три вопроса, и ни на один из них ответа не видно в предметных тестах
 * дверей: они гоняют дверь на одном соединении, где конкуренции нет по построению.
 *
 * 1. **повтор действительно перепланирует** — вторая попытка считает план заново и по НОВОМУ
 *    состоянию. Это главное требование В4 и самое дорогое, если нарушить: повтор, применивший план
 *    с устаревшего снимка, оформит бумагу строгой отчётности по решению, которого человек не
 *    принимал, — и ни один тест двери этого не заметит, потому что каждая дверь по отдельности
 *    отработает правильно;
 * 2. **исчерпание отличается от изменившегося состояния** — 503 с `Retry-After` против 409 по
 *    отпечатку. Перепутанные в любую сторону, они дают либо «обновите данные» там, где обновлять
 *    нечего (человек ищет несуществующее изменение), либо «повторите позже» там, где состояние
 *    действительно ушло из-под ног, — и повтор пишет не то, что видел человек;
 * 3. **повторяется только конкуренция** — отказ по существу выходит наружу первым же броском, а не
 *    после пяти попыток одного и того же ответа.
 *
 * ПОЧЕМУ БЕЗ БАЗЫ. Предмет файла — само правило повтора, а оно про поведение обёртки, а не про
 * PostgreSQL: ошибки здесь синтетические, зато сцены — те, которые в живой базе собираются долго и
 * не всякая собирается вовсе (исчерпание потолка требует `W` писателей одновременно). Настоящий
 * `40001` от настоящего PostgreSQL, включая обёртку drizzle, проверяет свой файл на своей базе —
 * `assignment-retry.db.test.ts`.
 */

let retry: typeof AssignmentRetry;
let command: typeof AssignmentCommand;

/*
 * Окружение выставляется до импорта, а импорт отложен — тем же приёмом и по той же причине, что у
 * `assignment-command-preview.test.ts`: протокол читает `config`, а конфигурация проверяет весь env
 * при загрузке. Адрес базы заведомо нерабочий: соединения не будет, пул `pg` при создании никуда
 * не ходит.
 */
beforeAll(async () => {
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  retry = await import('../src/services/assignment-retry');
  command = await import('../src/services/assignment-command');
});

/**
 * Политика прогона: потолок маленький и пауза нулевая.
 *
 * Пауза именно ноль, а не «поменьше»: боевое умолчание случайное (полный джиттер), и тест,
 * зависящий от случайной задержки, платил бы за неё временем прогона и однажды заплатил бы
 * мерцанием. Потолок задан здесь, а не взят из настроек, по той же причине: иначе проверка
 * протокола зависела бы от `prod.env` того, кто её запускает.
 */
const POLICY = { attempts: 3, backoffMs: 0 } as const;

/** Отказ PostgreSQL, каким его отдаёт драйвер: код в пять символов и текст сервера. */
function pgFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `40001` — конфликт сериализации: снимок транзакции устарел, пока она ждала чужой блокировки. */
const serializationFailure = (): Error =>
  pgFailure('40001', 'could not serialize access due to concurrent update');

/** Отказ как объект: `toThrow` не даёт посмотреть ни код, ни статус, а проверяются именно они. */
async function refusalOf(
  run: () => Promise<unknown>,
): Promise<
  Error & { statusCode?: number; code?: string; attempts?: number; retryAfterSeconds?: number }
> {
  try {
    await run();
  } catch (e) {
    return e as Error & { statusCode?: number; code?: string };
  }
  throw new Error('ожидался отказ, а протокол вернул результат');
}

beforeEach(() => {
  retry.resetAssignmentRetryCounters();
  command.resetAssignmentCommandCounters();
});

describe('протокол повторов: повтор с новым планированием (В4)', () => {
  it('вторая попытка считает план заново и по новому состоянию', async () => {
    /*
     * Сцена — та самая, ради которой В4 требует повторять транзакцию ЦЕЛИКОМ: пока первая попытка
     * стояла в очереди, соседняя команда сменила машину. Состояние читается внутри замыкания, как
     * читает его шаг 4 канона, и «коммит соседа» происходит ровно между попытками.
     */
    let vehicleInDb = 'машина A';
    const planned: string[] = [];

    const result = await retry.withAssignmentRetry(
      'assignment-changes',
      async () => {
        const plan = `лист на ${vehicleInDb}`;
        planned.push(plan);
        if (planned.length === 1) {
          vehicleInDb = 'машина B';
          throw serializationFailure();
        }
        return plan;
      },
      POLICY,
    );

    // Обе попытки планировали, и вторая увидела новый снимок. Повтори протокол один упавший запрос
    // вместо всей транзакции — здесь стояло бы «лист на машина A», то есть бумага по решению,
    // которого никто не принимал.
    expect(planned).toEqual(['лист на машина A', 'лист на машина B']);
    expect(result).toBe('лист на машина B');
  });

  it('успешный повтор человеку не виден: исход команды остаётся обычным', async () => {
    let attempt = 0;
    await retry.withAssignmentRetry(
      'assignment-changes',
      async () => {
        attempt += 1;
        if (attempt < 3) throw serializationFailure();
        return 'готово';
      },
      POLICY,
    );

    // Два повтора на одну дверь и ни одного исчерпания: именно так выглядит норма под конкуренцией.
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: 2, exhaustions: 0 },
    ]);
  });

  it('взаимоблокировка повторяется наравне с конфликтом сериализации', async () => {
    let attempt = 0;
    const result = await retry.withAssignmentRetry(
      'assignment-changes',
      async () => {
        attempt += 1;
        if (attempt === 1) throw pgFailure('40P01', 'deadlock detected');
        return 'готово';
      },
      POLICY,
    );
    expect(result).toBe('готово');
  });

  it('обёртка drizzle протоколу не мешает: код ищется по всей цепочке причин', async () => {
    // Драйвер кладёт код в свою ошибку, а drizzle заворачивает её в `DrizzleQueryError`: проверка
    // `e.code === '40001'` на верхнем объекте молча не срабатывает, и повтор не случился бы вовсе.
    let attempt = 0;
    const result = await retry.withAssignmentRetry(
      'assignment-changes',
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Failed query', { cause: serializationFailure() });
        }
        return 'готово';
      },
      POLICY,
    );
    expect(result).toBe('готово');
    expect(attempt).toBe(2);
  });
});

describe('протокол повторов: исчерпание против изменившегося состояния', () => {
  it('исчерпание потолка — 503 с Retry-After и своим кодом, а не 500', async () => {
    let attempts = 0;
    const refusal = await refusalOf(() =>
      retry.withAssignmentRetry(
        'assignment-changes',
        async () => {
          attempts += 1;
          throw serializationFailure();
        },
        POLICY,
      ),
    );

    // Попыток ровно столько, сколько велела настройка: потолок — это «всего попыток», включая
    // первую, и прочтение «три ПОВТОРА после первой попытки» дало бы порталу вчетверо больше
    // работы под блокировкой, чем считает настройка.
    expect(attempts).toBe(POLICY.attempts);
    expect(refusal.statusCode).toBe(503);
    expect(refusal.code).toBe(retry.ASSIGNMENT_RETRY_EXHAUSTED_CODE);
    expect(refusal.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refusal.attempts).toBe(POLICY.attempts);
    // Последний `40001` остаётся в `cause`: по нему исход команды относится к `serialization`, и
    // метрика исходов не разрывается на «до протокола» и «после».
    expect((refusal.cause as { code?: string } | undefined)?.code).toBe('40001');

    expect(retry.assignmentRetryCounters()).toEqual([
      // Повторов на один меньше попыток: первая попытка повтором не считается.
      { door: 'assignment-changes', retries: POLICY.attempts - 1, exhaustions: 1 },
    ]);
  });

  it('изменившееся состояние выходит 409 по отпечатку и повторов не тратит', async () => {
    /*
     * Сцена разделения исходов. Первая попытка проиграла гонку (`40001`), вторая пересчитала план
     * на новом снимке и увидела, что отпечаток предпросмотра разошёлся, — шаг 7 канона отвечает
     * 409. Это ответ по существу: человек видел одни последствия, а состояние стало другим, и
     * никакой повтор этого не исправит.
     */
    let attempts = 0;
    const stale = Object.assign(new Error('Последствия изменились с момента предпросмотра'), {
      statusCode: 409,
      code: 'assignment_preview_stale',
    });

    const refusal = await refusalOf(() =>
      retry.withAssignmentRetry(
        'assignment-changes',
        async () => {
          attempts += 1;
          throw attempts === 1 ? serializationFailure() : stale;
        },
        POLICY,
      ),
    );

    expect(refusal).toBe(stale);
    expect(refusal.statusCode).toBe(409);
    // Третья попытка не делалась: потолок остался нетронутым, а 409 ушёл человеку сразу.
    expect(attempts).toBe(2);
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: 1, exhaustions: 0 },
    ]);
  });

  it('отказ по существу повторами не размножается', async () => {
    // 422 «нет машиниста на границе» и `23505` «две актуальные строки на дату» — разные беды, но
    // обе одинаково не лечатся повтором: первая ждёт человека, вторая означает нарушенный порядок
    // захвата (спайк §4.4), и заглушив её повтором, мы спрятали бы единственное, что о ней
    // сообщает.
    for (const error of [
      Object.assign(new Error('Не назван машинист'), { statusCode: 422 }),
      pgFailure('23505', 'duplicate key value violates unique constraint'),
    ]) {
      let attempts = 0;
      const refusal = await refusalOf(() =>
        retry.withAssignmentRetry(
          'assignment-changes',
          async () => {
            attempts += 1;
            throw error;
          },
          POLICY,
        ),
      );
      expect(refusal).toBe(error);
      expect(attempts).toBe(1);
    }
    expect(retry.assignmentRetryCounters()).toEqual([]);
  });

  it('потолок в одну попытку выключает протокол, но не теряет отказ', async () => {
    // Значение на случай, когда повторы придётся выключить боевой настройкой: команда обязана
    // отказать сразу — и отказать тем же понятным 503, а не пятисоткой, которую разбирают как
    // поломку портала.
    let attempts = 0;
    const refusal = await refusalOf(() =>
      retry.withAssignmentRetry(
        'assignment-changes',
        async () => {
          attempts += 1;
          throw serializationFailure();
        },
        { attempts: 1, backoffMs: 0 },
      ),
    );
    expect(attempts).toBe(1);
    expect(refusal.statusCode).toBe(503);
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: 0, exhaustions: 1 },
    ]);
  });

  it('счётчики разведены по дверям: у каждой своя строка метрики', async () => {
    await retry
      .withAssignmentRetry(
        'assignment-changes',
        async () => Promise.reject(serializationFailure()),
        {
          attempts: 2,
          backoffMs: 0,
        },
      )
      .catch(() => undefined);
    await retry
      .withAssignmentRetry('preview', async () => Promise.reject(serializationFailure()), {
        attempts: 2,
        backoffMs: 0,
      })
      .catch(() => undefined);

    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: 1, exhaustions: 1 },
      { door: 'preview', retries: 1, exhaustions: 1 },
    ]);
  });
});

describe('протокол повторов в каркасе команд (§8)', () => {
  /**
   * Спецификация-заглушка: каркас до её колбэков не доходит — исполнитель падает раньше, чем
   * открылась транзакция. Здесь проверяется не предмет двери, а то, что повтор обнимает **всю**
   * транзакцию и что исход попадает в метрику один раз, а не по разу на попытку.
   */
  function probeSpec(
    policy: AssignmentRetry.AssignmentRetryPolicy,
  ): Parameters<typeof command.runAssignmentCommand>[1] {
    return {
      door: 'history',
      journalDoor: 'retry-probe',
      requestId: '00000000-0000-0000-0000-000000000000',
      actor: { id: '00000000-0000-0000-0000-000000000001' },
      expectedVersion: 0,
      body: {},
      operation: null,
      retry: policy,
    } as unknown as Parameters<typeof command.runAssignmentCommand>[1];
  }

  function executorOf(
    transaction: () => Promise<unknown>,
  ): Parameters<typeof command.runAssignmentCommand>[0] {
    return { transaction } as unknown as Parameters<typeof command.runAssignmentCommand>[0];
  }

  it('каркас открывает транзакцию заново, а не повторяет её тело', async () => {
    // Транзакция объявлена функцией именно ради этого: тело абортированной транзакции уже не
    // выполняется, её снимок не оживить, и каждое чтение обязано повториться в новой.
    let opened = 0;
    const outcome = await command.runAssignmentCommand(
      executorOf(async () => {
        opened += 1;
        if (opened === 1) throw serializationFailure();
        return {
          repeated: false,
          operation: null,
          applied: null,
          paper: null,
          effects: null,
          version: 8,
        };
      }),
      probeSpec(POLICY),
    );

    expect(opened).toBe(2);
    expect(outcome.version).toBe(8);
    // Успешная со второй попытки команда — обычный `ok`: человек о гонке не узнал.
    expect(command.assignmentCommandCounters()).toEqual([
      { door: 'retry-probe', outcome: 'ok', count: 1 },
    ]);
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'retry-probe', retries: 1, exhaustions: 0 },
    ]);
  });

  it('исчерпание считается исходом `serialization` — ровно один раз на команду', async () => {
    let opened = 0;
    const refusal = await refusalOf(() =>
      command.runAssignmentCommand(
        executorOf(async () => {
          opened += 1;
          throw serializationFailure();
        }),
        probeSpec(POLICY),
      ),
    );

    expect(opened).toBe(POLICY.attempts);
    expect(refusal.statusCode).toBe(503);
    /*
     * Метка та же, что была до протокола, и это условие, а не совпадение: `outcome="serialization"`
     * означает «конфликт дошёл до человека», и до появления повторов им был каждый `40001`, а
     * теперь — только исчерпание. Счёт при этом ведётся по КОМАНДАМ: три попытки — одна запись в
     * метрике, иначе график исходов рос бы втрое быстрее числа отказов.
     */
    expect(command.assignmentCommandCounters()).toEqual([
      { door: 'retry-probe', outcome: 'serialization', count: 1 },
    ]);
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'retry-probe', retries: POLICY.attempts - 1, exhaustions: 1 },
    ]);
  });
});
