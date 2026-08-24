import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Серверная проверка токена Yandex SmartCaptcha (план `docs/smart-captcha-plan.md`, §5, §7, §8).
 *
 * Своей капчи больше нет, и проверять «узнаётся ли картинка» здесь нечего: вся серверная работа —
 * один запрос к чужой ручке и решение по её ответу. Стережётся именно решение, потому что каждая
 * его ветка ломается молча.
 *
 * - **Сверка домена.** Токен, добытый на чужом сайте с той же капчей, обязан быть отвергнут, а
 *   свой — принят. Сравнение идёт по `URL.host`, то есть вместе с портом. Подмена его на
 *   `hostname` не уронила бы в проде ни одной проверки (`auto.su10.ru` порта не имеет), зато
 *   закрыла бы стенд `http://localhost:8080` целиком — отсюда отдельный тест именно про порт.
 * - **Fail-open.** Пропуск при недоступности сервиса — сознательное решение (§7), и цена ему —
 *   окно, в котором серверная капча не защищает. Оно допустимо ровно потому, что каждый такой
 *   пропуск считается отдельным счётчиком, по которому заведён алерт. Если пропуск начнёт
 *   считаться как `ok`, поведение портала не изменится ни на йоту, а алерт замолчит — снаружи это
 *   не видно ничем, кроме этих тестов.
 * - **Fail-closed на пустом токене.** «Пропускать пустой токен при включённой капче» означало бы
 *   капчу, которую отключает любой клиент, поэтому отказ проверяется вместе с тем, что в сеть при
 *   этом не ходили вовсе.
 * - **Canary (§8).** Исход последней попытки и факт того, что попытка была, — два разных сигнала.
 *   Слить их в одно значение значило бы сделать «canary молчит» неотличимым от «canary отвечает
 *   плохо».
 *
 * В сеть тест не ходит никогда: `fetch` подменён. Доказать unit-тестом, что по ту сторону живая
 * капча, нельзя в принципе — это дело preflight `check:captcha`, canary в работе и живого E2E (§8).
 */

// Конфигурация читается при импорте модуля, а сценариям нужны разные ключи и разный
// `PUBLIC_ORIGIN`, — отсюда `vi.resetModules()` и отложенный импорт вместо статического
// (ср. `trust-proxy.test.ts`). Здесь же только типы: `await import` в типовой позиции нельзя.
import type * as CaptchaModule from '../src/auth/captcha';
import type { AppError } from '../src/lib/errors';

/** Ручка сервиса зафиксирована в коде: в конфигурацию она не вынесена и вынесена быть не должна. */
const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';

/**
 * Пара ключей одной капчи: первые 20 символов после префикса совпадают — иначе конфигурация не
 * пройдёт проверку при старте (её стережёт `captcha-config.test.ts`).
 */
const KEY_TAIL = 'PZTBoyoWVGA9Kdz2ZLcA';
const CLIENT_KEY = `ysc1_${KEY_TAIL}client`;
const SERVER_KEY = `ysc2_${KEY_TAIL}server`;

/** Минимум, без которого конфигурация не собирается; капча добавляется поверх — своим сценарием. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://portal.test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
  JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
  COOKIE_SECRET: 'test-cookie-secret-value',
  CSRF_SECRET: 'test-csrf-secret-value',
  S3_ENDPOINT: 'https://s3.test.local',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  // Иначе каждый fail-open печатает `warn` в вывод прогона: они здесь ожидаемы и шумят.
  LOG_LEVEL: 'fatal',
};

/**
 * Свой экземпляр модуля на сценарий: конфигурация захватывается при импорте, и «выключенная капча»
 * с «капчей на localhost» — это разные загрузки, а не разные аргументы.
 */
async function loadCaptcha(overrides: Record<string, string> = {}): Promise<typeof CaptchaModule> {
  vi.resetModules();
  Object.assign(process.env, BASE_ENV);
  delete process.env.SMARTCAPTCHA_CLIENT_KEY;
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
  Object.assign(process.env, overrides);
  return import('../src/auth/captcha');
}

/** Ключи исправной пары — в сценарии, где капча включена. */
const ENABLED_KEYS = {
  SMARTCAPTCHA_CLIENT_KEY: CLIENT_KEY,
  SMARTCAPTCHA_SERVER_KEY: SERVER_KEY,
};

/**
 * Ответ сервиса — настоящим `Response`: разбор тела должен быть тем же, что в работе, а битый JSON
 * должен ломаться там же, где сломается в проде.
 */
const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const nowSeconds = () => Math.floor(Date.now() / 1000);

let captcha: typeof CaptchaModule;
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** Последний запрос, ушедший в подменённый `fetch`. */
function lastRequest(): { url: string; body: URLSearchParams; headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1);
  expect(call, 'запроса к SmartCaptcha не было').toBeDefined();
  const [url, init] = call!;
  return {
    url: String(url),
    body: new URLSearchParams(String(init.body)),
    headers: (init.headers ?? {}) as Record<string, string>,
  };
}

/**
 * Отказ проверки — вместе с самой ошибкой: утверждать надо про код и поле, а не только про факт
 * броска. Форма отказа общая для клиента (400 и `captchaToken`), и расхождение в ней сломало бы
 * показ ошибки в форме, ничего не сломав в тесте на `toThrow()`.
 */
async function rejection(promise: Promise<void>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('проверка прошла, хотя ожидался отказ');
    },
    (e: unknown) => e as AppError,
  );
}

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  captcha.resetCaptchaMetrics();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Окружение — общее на весь процесс прогона, а соседний файл может грузить конфигурацию своим
 * импортом: оставленные здесь ключи включили бы ему капчу там, где её никто не ждёт.
 */
afterAll(() => {
  delete process.env.SMARTCAPTCHA_CLIENT_KEY;
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
});

describe('проверка токена: капча включена, портал на https://portal.test', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  it('ответ `ok` с нашим доменом пропускает и растит счётчик `ok`', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'portal.test' }));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 1, failed: 0, fail_open: 0 });
  });

  it('токен, выданный чужим доменом, отвергается', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'evil.example.com' }));

    const error = await rejection(captcha.verifyCaptcha('token-1'));

    expect(error.statusCode).toBe(400);
    expect(error.fields?.captchaToken).toBeTruthy();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });

  it('ответ `failed` — отказ с 400 и пометкой поля', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'failed', host: 'portal.test' }));

    const error = await rejection(captcha.verifyCaptcha('token-1'));

    expect(error.statusCode).toBe(400);
    expect(error.fields?.captchaToken).toBeTruthy();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });

  it('пустой токен при включённой капче отвергается, не спрашивая сервис', async () => {
    const error = await rejection(captcha.verifyCaptcha(''));

    expect(error.statusCode).toBe(400);
    expect(error.fields?.captchaToken).toBeTruthy();
    // Ходить за подтверждением пустоты некуда и незачем: отказ здесь свой, не сервиса.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });
});

describe('сверка домена идёт по `host`, а не по `hostname`', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha({ ...ENABLED_KEYS, PUBLIC_ORIGIN: 'http://localhost:8080' });
  }, 60_000);

  /**
   * Ключевой тест волны. SmartCaptcha возвращает в `host` порт, когда он нестандартный
   * (`example.com:8080` — пример из документации), а стенд (§11) работает как раз на
   * `http://localhost:8080`. `new URL(...).host` даёт `localhost:8080` и сходится с ответом;
   * `hostname` дал бы `localhost`, и сверка `localhost:8080 !== localhost` отвергала бы **каждую
   * собственную валидную проверку** — при этом в проде, где порт стандартный, всё выглядело бы
   * исправным, и разошлись бы стенд с продом ровно там, где стенд и нужен.
   */
  it('`host: "localhost:8080"` при `PUBLIC_ORIGIN=http://localhost:8080` проходит', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'localhost:8080' }));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 1, failed: 0, fail_open: 0 });
  });

  it('тот же стенд без порта в ответе — чужой домен, отказ', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'localhost' }));

    const error = await rejection(captcha.verifyCaptcha('token-1'));

    expect(error.statusCode).toBe(400);
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });
});

describe('капча выключена: серверного ключа нет', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha();
  }, 60_000);

  it('любой токен проходит, и в сеть за проверкой не ходят', async () => {
    await expect(captcha.verifyCaptcha('какой-угодно-мусор')).resolves.toBeUndefined();
    await expect(captcha.verifyCaptcha('')).resolves.toBeUndefined();

    // Проверять нечем — серверного ключа нет; запрос без секрета был бы бессмысленным и платным.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 0 });
  });

  it('canary при выключенной капче молчит', async () => {
    await captcha.runCaptchaCanary();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(captcha.captchaMetrics().invalidTokenRejected).toBe(0);
  });
});

describe('fail-open: проверить не удалось — пропускаем и считаем отдельно', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  /** Ожидание, общее для всех пяти случаев: не бросили и записали именно `fail_open`. */
  const expectFailOpen = async (): Promise<void> => {
    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 1 });
  };

  it('код ответа не 200 и пустое тело — вердикта в ответе нет', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expectFailOpen();
  });

  it('нечитаемый JSON в теле ответа', async () => {
    // Испорченное тело не должно превращаться в случайную пятисотку у человека перед формой.
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    await expectFailOpen();
  });

  it('сеть не отдала ответа вовсе', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expectFailOpen();
  });

  it('таймаут запроса', async () => {
    // Ровно то, чем `AbortSignal.timeout` срывает запрос: имя ошибки `TimeoutError`.
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await expectFailOpen();
  });

  it('неизвестное значение `status`', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'что-то новое', host: 'portal.test' }));
    await expectFailOpen();
  });

  /**
   * `ok` с пустым `host` — не норма: один из двух случаев в документации, заблокированное облако,
   * означает, что `ok` приходит в том числе роботам. Пропустить приходится (иначе сбой на стороне
   * Яндекса закрывает формы), но записать это как успешную проверку нельзя: тогда самый опасный
   * случай — «капча отвечает `ok` вообще всем» — попал бы в счётчик успехов и не поднял бы алерт.
   */
  it('`ok` с пустым `host` проходит веткой `fail_open`, а не `ok`', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: '' }));
    await expectFailOpen();
  });
});

describe('тело запроса к /validate', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  beforeEach(() => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'portal.test' }));
  });

  it('уходят `secret`, `token` и `ip`, когда адрес известен', async () => {
    await captcha.verifyCaptcha('token-1', '203.0.113.7');

    const { url, body, headers } = lastRequest();
    expect(url).toBe(VALIDATE_URL);
    expect(body.get('secret')).toBe(SERVER_KEY);
    expect(body.get('token')).toBe('token-1');
    expect(body.get('ip')).toBe('203.0.113.7');
    // Ручка принимает форму, а не JSON: с чужим content-type сервис отвечает отказом на всё.
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('без адреса поле `ip` не отправляется вовсе', async () => {
    await captcha.verifyCaptcha('token-1');

    // Пустая строка была бы заведомо неверным адресом вместо отсутствующего: сервис учитывает
    // репутацию `ip`, и подсовывать ему пустоту — значит просить оценить неизвестно кого.
    expect(lastRequest().body.has('ip')).toBe(false);
  });
});

describe('canary: мусорный токен и отметка о попытке', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  it('сервис отверг мусорный токен — единица в gauge', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'failed' }));

    await captcha.runCaptchaCanary();

    expect(captcha.captchaMetrics().invalidTokenRejected).toBe(1);
  });

  /**
   * `ok` на заведомо мусорный токен означает ограниченный режим (§8): неактивный платёжный
   * аккаунт, при котором SmartCaptcha пропускает всех, а метрики проверок выглядят здоровыми.
   * Ноль здесь — единственный признак, по которому это видно снаружи.
   */
  it('сервис принял мусорный токен — ноль: это ограниченный режим', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'portal.test' }));

    await captcha.runCaptchaCanary();

    expect(captcha.captchaMetrics().invalidTokenRejected).toBe(0);
  });

  it('сервис недоступен — тоже ноль, а не прежняя единица', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'failed' }));
    await captcha.runCaptchaCanary();
    expect(captcha.captchaMetrics().invalidTokenRejected).toBe(1);

    // Устаревшая единица выглядела бы здоровьем сервиса, о котором мы уже час ничего не знаем.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await captcha.runCaptchaCanary();

    expect(captcha.captchaMetrics().invalidTokenRejected).toBe(0);
  });

  /**
   * Отметка времени отвечает не на «всё ли хорошо», а на «была ли попытка». Двигайся она только
   * при успехе — это было бы время последнего успеха, и молчащий canary (умер таймер, завис
   * процесс) стал бы неотличим от canary, который час подряд честно докладывает о беде.
   */
  it('отметка о попытке двигается при любом исходе, включая неудачу', async () => {
    const cases: Array<[string, () => void]> = [
      ['отвергнут', () => fetchMock.mockResolvedValue(respond({ status: 'failed' }))],
      ['принят', () => fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'portal.test' }))],
      ['сервис недоступен', () => fetchMock.mockResolvedValue(new Response('', { status: 500 }))],
      ['сеть отказала', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ];

    for (const [name, arrange] of cases) {
      captcha.resetCaptchaMetrics();
      arrange();
      const before = nowSeconds();

      await captcha.runCaptchaCanary();

      const { canaryLastRunSeconds } = captcha.captchaMetrics();
      expect(canaryLastRunSeconds, name).toBeGreaterThanOrEqual(before);
      expect(canaryLastRunSeconds, name).toBeLessThanOrEqual(nowSeconds());
    }
  });

  it('canary не подмешивается в счётчик проверок', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'failed' }));

    await captcha.runCaptchaCanary();

    // Иначе служебные запросы раз в час размывали бы долю `failed` у живых проверок, а на пустом
    // портале и вовсе составляли бы её целиком.
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 0 });
  });
});

describe('вердикт даёт тело ответа, а не код HTTP', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  /**
   * Неверный серверный ключ SmartCaptcha отвечает не двухсоткой, а `403` с телом
   * `{"status":"failed","message":"Authentication failed. Invalid secret."}` — это выяснилось
   * вживую. Пока код смотрел на `res.ok` раньше тела, такой ответ уходил веткой «сервис
   * недоступен», то есть в fail-open: портал с опечаткой в `prod.env` пропускал бы **всех**,
   * никого не проверив, и выглядел бы при этом исправным — форма отправляется, люди регистрируются,
   * жалоб нет. Отказ здесь дороже пропуска ровно поэтому: закрытые формы замечают за час, а
   * открытую настежь регистрацию не замечают вовсе.
   */
  it('`403` с телом `failed` — отказ, а не недоступность', async () => {
    fetchMock.mockResolvedValue(
      respond({ status: 'failed', message: 'Authentication failed. Invalid secret.' }, 403),
    );

    const error = await rejection(captcha.verifyCaptcha('token-1'));

    expect(error.statusCode).toBe(400);
    expect(error.fields?.captchaToken).toBeTruthy();
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });

  it('`500` с телом `failed` — тоже отказ: код остаётся диагностикой', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'failed' }, 500));

    const error = await rejection(captcha.verifyCaptcha('token-1'));

    expect(error.statusCode).toBe(400);
    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 1, fail_open: 0 });
  });

  /**
   * Обратная граница того же решения: вердикт берётся из тела, поэтому там, где тела с вердиктом
   * нет, ничего не меняется — не-200 остаётся недоступностью. Иначе «разбираем тело всегда»
   * превратилось бы в «любая пятисотка чужого прокси закрывает формы».
   */
  it('`403` с пустым телом — по-прежнему fail-open: вердикта в ответе нет', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 1 });
  });

  it('`403` с чужим JSON без `status` — тоже fail-open', async () => {
    fetchMock.mockResolvedValue(respond({ error: 'quota exceeded' }, 403));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 1 });
  });
});

describe('регистр домена в ответе', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  /**
   * `URL.host` приводит к нижнему регистру только нашу половину сверки, а `host` из ответа
   * приходит как есть. Сравнение «как есть» означало бы отказ на валидной проверке у всех, кому
   * сервис ответил с заглавной буквой, — поломка, которая воспроизводится не везде и потому ищется
   * дольше всего. Домены регистронезависимы, и сверка обязана быть такой же.
   */
  it('`host: "Portal.Test"` при `PUBLIC_ORIGIN=https://portal.test` проходит', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 'Portal.Test' }));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 1, failed: 0, fail_open: 0 });
  });

  /**
   * `host` не строкой — не отказ, а fail-open, и это решение, а не случайность: строкой его делает
   * чужой контракт, и ответ, в котором тип поля вдруг другой, означает не «токен с чужого домена»,
   * а «мы не понимаем ответ». Отказывать в таком случае значило бы закрывать формы по причине,
   * которую никто не сможет объяснить человеку перед ними.
   */
  it('`ok` с не-строковым `host` идёт веткой fail_open, а не отказом', async () => {
    fetchMock.mockResolvedValue(respond({ status: 'ok', host: 123 }));

    await expect(captcha.verifyCaptcha('token-1')).resolves.toBeUndefined();

    expect(captcha.captchaMetrics().checks).toEqual({ ok: 0, failed: 0, fail_open: 1 });
  });
});

describe('canary отличает отвергнутый запрос от отвергнутого токена', () => {
  beforeAll(async () => {
    captcha = await loadCaptcha(ENABLED_KEYS);
  }, 60_000);

  /**
   * `403` с телом `failed` означает не «мусорный токен отвергнут», а «сервис отверг сам запрос» —
   * то есть неверный серверный ключ. Засчитать это единицей значило бы рапортовать о здоровье
   * ровно в том единственном случае, когда капча не работает совсем: формы закрыты наглухо, а
   * метрика зелёная. Такой исход хуже честного нуля при недоступности — по нулю хотя бы идут
   * смотреть.
   */
  it('`403` с телом `failed` — ноль, а не единица', async () => {
    fetchMock.mockResolvedValue(
      respond({ status: 'failed', message: 'Authentication failed. Invalid secret.' }, 403),
    );
    const before = nowSeconds();

    await captcha.runCaptchaCanary();

    const { invalidTokenRejected, canaryLastRunSeconds } = captcha.captchaMetrics();
    expect(invalidTokenRejected).toBe(0);
    // Попытка состоялась — отметка двигается и здесь: она про живость canary, а не про исход.
    expect(canaryLastRunSeconds).toBeGreaterThanOrEqual(before);
    expect(canaryLastRunSeconds).toBeLessThanOrEqual(nowSeconds());
  });
});
