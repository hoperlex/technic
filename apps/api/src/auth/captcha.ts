import { config } from '../config';
import { err } from '../lib/errors';
import { logger } from '../logger';

// ── Проверка токена Yandex SmartCaptcha (план `docs/smart-captcha-plan.md`, §5, §7, §8) ──
//
// Своей капчи больше нет: подписанный челлендж, растровую картинку и одноразовость `jti` заменил
// внешний сервис. От прежних 155 строк осталась одна операция — спросить у Яндекса, настоящий ли
// токен виджета, — и всё, что вокруг неё построено, построено ради одного: внешняя зависимость в
// цепочке регистрации не должна превращаться ни в открытую дверь, ни в отказ портала.
//
// Всё состояние модуля — счётчики проверок и последний результат canary. Оно process-local и
// намеренно: в БД метрикам делать нечего, API работает одним экземпляром, а рестарт для счётчика
// Prometheus — штатное событие (см. `services/metrics.ts`).

/** Ручка проверки токена; адрес фиксирован документацией и в конфигурацию не выносится. */
const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';

/**
 * Заведомо не токен виджета. Отправляется canary в ту же ручку: настоящий сервис обязан ответить
 * на него `failed`, а SmartCaptcha в ограниченном режиме (неактивный платёжный аккаунт, §8)
 * отвечает `ok` на всё подряд — включая вот это.
 */
const CANARY_TOKEN = 'technic-canary-invalid-token';

/**
 * Ожидаемый домен — из `PUBLIC_ORIGIN`, посчитанный один раз: значение статично на весь процесс, а
 * `verifyCaptcha` зовётся на каждую регистрацию.
 */
let expectedHostCache: string | undefined;
function expectedHost(): string {
  expectedHostCache ??= new URL(config.publicOrigin).host.toLowerCase();
  return expectedHostCache;
}

/**
 * Раз в час: ограниченный режим включается не ежеминутно, а проверки тарифицируются — частить
 * незачем.
 */
const CANARY_INTERVAL_MS = 3_600_000;

export type CaptchaCheckResult = 'ok' | 'failed' | 'fail_open';

/**
 * Счётчик исходов проверки. Отказ по пустому токену и по чужому `host` считается как `failed`:
 * метрика отвечает на вопрос «пропустили или не пропустили», а не «какой веткой кода», и дробить
 * отказ на подвиды значило бы заводить алерты, которые нечем закрыть.
 */
const checks: Record<CaptchaCheckResult, number> = { ok: 0, failed: 0, fail_open: 0 };

/** 1 — мусорный токен отвергнут; 0 — принят **или** проверить не удалось (§8). */
let canaryInvalidTokenRejected = 0;

/** Unix-время последней завершённой попытки canary; 0 — не отработал ни разу. */
let canaryLastRunSeconds = 0;

interface ValidateBody {
  /** `ok` | `failed`; тип намеренно широкий — это разбор чужого JSON, а не наш контракт. */
  status?: unknown;
  /** Домен, на котором виджет выдал токен. Пустым бывает — §7. */
  host?: unknown;
  /** Документация разрешает использовать только для диагностики, контрактом не является. */
  message?: unknown;
}

type ValidateOutcome =
  /**
   * `requestRejected` — сервис ответил не-200, но телом с вердиктом (`403` на неверный серверный
   * ключ). Для проверки токена это обычный отказ, а вот canary обязан отличать такой ответ от
   * честного «мусор отвергнут»: иначе портал с чужим ключом показывал бы здоровую единицу при
   * наглухо закрытых формах.
   */
  | { kind: 'body'; body: ValidateBody; requestRejected: boolean }
  /** Ответа, пригодного к разбору, нет: сеть, таймаут, код не 200, нечитаемый JSON. */
  | { kind: 'unavailable'; reason: string; error?: unknown };

/**
 * Один запрос к `/validate`. Ошибки не бросает — возвращает их исходом: решение «пропустить или
 * отказать» принимается уровнем выше, и `throw` отсюда смешал бы отказ капчи со сбоем связи.
 */
async function callValidate(token: string, ip?: string): Promise<ValidateOutcome> {
  const form = new URLSearchParams({ secret: config.captcha.serverKey, token });
  // `ip` необязателен: без него сервис просто не учитывает репутацию адреса. Пустую строку не
  // шлём — это был бы заведомо неверный адрес вместо отсутствующего.
  if (ip) form.set('ip', ip);

  try {
    const res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // Таймаут обязателен и невелик: проверка стоит перед регистрацией, которая и так ждёт
      // argon2, и висеть на чужом сервере минутами формой человек не согласится.
      signal: AbortSignal.timeout(config.captcha.timeoutMs),
    });
    // Тело разбирается ДО проверки кода — и это не аккуратность, а исправление опасной ошибки.
    // Неверный серверный ключ SmartCaptcha возвращает не 200, а `403` с телом
    // `{"status":"failed","message":"Authentication failed. Invalid secret."}` (проверено вживую
    // при написании `scripts/check-captcha.ts`). С проверкой `res.ok` впереди такой ответ уходил
    // бы веткой «сервис недоступен», то есть fail-open: портал с опечаткой в `prod.env` пропускал
    // бы ВСЕХ, никого не проверив, и выглядел бы при этом исправным.
    //
    // Поэтому вердикт сервиса определяется телом, а код ответа — только диагностикой. Отказ по
    // `failed` (§7) остаётся отказом независимо от кода, и порталу с неверным ключом закрывает
    // формы вместо того, чтобы молча открыть их настежь.
    const raw = await res.text();
    let body: ValidateBody;
    try {
      body = JSON.parse(raw) as ValidateBody;
    } catch {
      // Тело в лог не идёт, только длина: нечитаемый ответ приходит не от сервиса, а от кого-то по
      // дороге, и такие страницы ошибок регулярно повторяют в себе исходный запрос — вместе с
      // `secret=` в теле.
      return {
        kind: 'unavailable',
        reason: `ответ SmartCaptcha (код ${res.status}, ${raw.length} Б) не разбирается как JSON`,
      };
    }
    if (!res.ok && body.status !== 'failed') {
      return { kind: 'unavailable', reason: `SmartCaptcha ответил ${res.status}` };
    }
    if (!res.ok) {
      // Единственный случай, когда чинить надо конфигурацию, а не связь. Отдельная запись — чтобы
      // это было видно в логе прямо, а не выводилось из потока отказов на форме.
      logger.error(
        { code: res.status },
        'SmartCaptcha отвергла сам запрос — проверьте SMARTCAPTCHA_SERVER_KEY',
      );
    }
    return { kind: 'body', body, requestRejected: !res.ok };
  } catch (e) {
    // Сюда приходят сеть, таймаут (`TimeoutError` от `AbortSignal.timeout`) и нечитаемый JSON.
    // Различать их незачем: исход у всех трёх один, а в лог уходит сама ошибка.
    return { kind: 'unavailable', reason: 'запрос к SmartCaptcha не удался', error: e };
  }
}

/**
 * Проверить не удалось — пропускаем.
 *
 * Fail-open здесь сознательный и односторонний. Документация Яндекса прямо рекомендует
 * обрабатывать HTTP-ошибки проверки как `ok`; мы расширили это на битый ответ и неизвестный
 * `status`, иначе испорченный JSON давал бы человеку случайную пятисотку вместо формы. Цена
 * известна: пока Яндекс недоступен, серверная проверка не защищает, и единственное, что остаётся
 * против перебора, — IP-лимиты портала (потому подмена `X-Forwarded-For` и чинилась до капчи, §6).
 *
 * Асимметрия с браузером намеренная: браузерная недоступность виджета остаётся **fail-closed** —
 * без токена сервер не отличает бота от жертвы сбоя, и «пропускать пустой токен при включённой
 * капче» означало бы капчу, которую отключает любой клиент.
 *
 * Каждый такой пропуск виден снаружи: `warn` в логе и `result="fail_open"` в метрике, по которой
 * заведён алерт (§7).
 */
function failOpen(reason: string, error?: unknown): void {
  checks.fail_open += 1;
  logger.warn({ err: error, reason }, 'SmartCaptcha: проверка пропущена (fail-open)');
}

/**
 * Проверяет токен виджета. Молча возвращается при успехе, бросает `badRequest` при отказе.
 *
 * @param token — одноразовый токен из поля `captchaToken`; пустая строка допустима транспортом.
 * @param ip — адрес клиента (`req.ip`); передаётся сервису как сигнал репутации.
 */
export async function verifyCaptcha(token: string, ip?: string): Promise<void> {
  // Выключенная капча — свойство состояния сервиса, а не формы и не схемы (§5). Присланный токен
  // при этом игнорируется, и в сеть мы не идём: проверять его нечем — серверного ключа нет.
  if (!config.captcha.enabled) return;

  // Пустой токен при включённой капче — отказ. Текст свой, но форма отказа та же, что у `failed`
  // (400 и поле `captchaToken`): у клиента должен быть один случай «проверка не пройдена», а не
  // два с разной обработкой.
  if (!token) {
    checks.failed += 1;
    throw err.badRequest('Подтвердите, что вы не робот', {
      captchaToken: 'Подтвердите, что вы не робот',
    });
  }

  const outcome = await callValidate(token, ip);
  if (outcome.kind === 'unavailable') {
    failOpen(outcome.reason, outcome.error);
    return;
  }

  const { status, host } = outcome.body;

  if (status === 'ok') {
    if (typeof host === 'string' && host !== '') {
      // Токен настоящий — но выдан ли он нашей странице? Без этой сверки токен, добытый на любом
      // чужом сайте с той же капчей, проходил бы у нас.
      //
      // Сравнивается именно `URL.host`, а не `hostname`: SmartCaptcha возвращает в `host` порт,
      // когда он нестандартный (`example.com:8080` — пример из документации), а стенд §11 работает
      // на `http://localhost:8080`. С `hostname` вышло бы `localhost:8080 !== localhost`, то есть
      // отказ на каждой собственной валидной проверке. Регистр `URL.host` нормализует сам.
      // Регистр нормализуется с ОБЕИХ сторон: `URL.host` приводит к нижнему только нашу половину,
      // а `host` из ответа приходит как есть, и `Portal.Test` дал бы отказ на валидной проверке.
      const expected = expectedHost();
      if (host.toLowerCase() !== expected) {
        checks.failed += 1;
        logger.warn({ host, expected }, 'SmartCaptcha: токен выдан чужим доменом');
        throw err.badRequest('Проверка не пройдена — попробуйте ещё раз', {
          captchaToken: 'Пройдите проверку заново',
        });
      }
      checks.ok += 1;
      return;
    }
    // `ok` с пустым `host` — не норма: документация называет два случая, и один из них,
    // заблокированное облако, означает, что `ok` приходит в том числе роботам. Считать такую
    // проверку успешной нельзя, поэтому она проходит, но веткой fail-open — с тем же алертом.
    // В лог — что именно пришло: по одному тексту не отличить заблокированное облако (там `ok` с
    // пустым `host` штатен) от обрезанного ответа по дороге, а лог здесь единственный след.
    failOpen(`SmartCaptcha ответила ok с пустым host (host=${JSON.stringify(host)})`);
    return;
  }

  if (status === 'failed') {
    checks.failed += 1;
    throw err.badRequest('Проверка не пройдена — попробуйте ещё раз', {
      captchaToken: 'Пройдите проверку заново',
    });
  }

  failOpen(`неизвестный status "${String(status)}"`);
}

/**
 * Canary: шлёт заведомо мусорный токен и ждёт `failed`.
 *
 * Что он показывает: сервер дотягивается до `/validate`, и мусор отвергается — то есть
 * ограниченный режим (§8) не включён и метрики не состоят из сплошных фальшивых `ok`.
 *
 * Чего он **не** показывает: что капча защищает. `failed` возвращается и роботу, и при ошибке
 * самого запроса — в том числе при неверном серверном ключе («Authentication failed»), и чужой
 * ключ даст здесь ту же единицу, что и исправная пара. Такие ключи ловят проверки конфигурации
 * при старте (`config.ts`, §8) и живой E2E после релиза; из canary «капча работает» не следует.
 *
 * Разделение двух сигналов строгое и обязательное: gauge — исход последней попытки, отметка
 * времени — факт того, что попытка вообще была. Отметка двигается и при неудаче, иначе это было бы
 * время последнего успеха, и «canary молчит» стало бы неотличимо от «canary отвечает плохо».
 */
export async function runCaptchaCanary(): Promise<void> {
  // Без серверного ключа проверять нечем: gauge остаются нулями, и это честно — в production ключи
  // обязательны (§8), поэтому там ноль означает именно молчащий canary, а не выключенную капчу.
  if (!config.captcha.enabled) return;

  const outcome = await callValidate(CANARY_TOKEN);
  // Невозможность проверить — это ноль, а не сохранение прежней единицы: устаревшая единица
  // выглядела бы здоровьем сервиса, о котором мы уже час ничего не знаем.
  // Единица — только если сервис принял запрос и сам отверг мусорный токен. Ответ `403` с телом
  // `failed` (неверный серверный ключ) единицей не считается: проверка при этом не работает вовсе,
  // и рапортовать о здоровье было бы худшим из возможных исходов — формы закрыты, а метрика
  // зелёная.
  canaryInvalidTokenRejected =
    outcome.kind === 'body' && !outcome.requestRejected && outcome.body.status === 'failed' ? 1 : 0;
  canaryLastRunSeconds = Math.floor(Date.now() / 1000);

  if (canaryInvalidTokenRejected === 0) {
    logger.warn(
      {
        reason:
          outcome.kind === 'body'
            ? outcome.requestRejected
              ? 'SmartCaptcha отвергла сам запрос — проверьте SMARTCAPTCHA_SERVER_KEY'
              : `status="${String(outcome.body.status)}"`
            : outcome.reason,
      },
      'SmartCaptcha canary: мусорный токен не отвергнут — проверьте платёжный аккаунт и ключи',
    );
  }
}

let canaryTimer: NodeJS.Timeout | undefined;

/**
 * Запускает canary сразу и дальше раз в час. Вызывается из `server.ts` после старта listen.
 *
 * Таймер `unref()` — процесс он держать не должен: в тестах и одноразовых скриптах висящий час
 * интервал не давал бы Node завершиться. Повторный вызов ничего не делает — второй таймер удвоил
 * бы расход бесплатных проверок и ничего не добавил.
 */
export function startCaptchaCanary(): void {
  if (canaryTimer) return;
  void runCaptchaCanary();
  canaryTimer = setInterval(() => void runCaptchaCanary(), CANARY_INTERVAL_MS);
  canaryTimer.unref();
}

/**
 * Гасит таймер. `unref()` спасает от зависшего процесса, но не от таймера, пережившего закрытие
 * приложения: при плавной остановке (и в тестах, импортирующих `server.ts`) остановить его иначе
 * нечем.
 */
export function stopCaptchaCanary(): void {
  if (!canaryTimer) return;
  clearInterval(canaryTimer);
  canaryTimer = undefined;
}

/** Снимок для `/metrics`: счётчики и последний результат canary (§7). */
export function captchaMetrics(): {
  checks: Record<CaptchaCheckResult, number>;
  invalidTokenRejected: number;
  canaryLastRunSeconds: number;
} {
  return {
    checks: { ...checks },
    invalidTokenRejected: canaryInvalidTokenRejected,
    canaryLastRunSeconds,
  };
}

/** Только для тестов: состояние модульное, между сценариями его надо обнулять. */
export function resetCaptchaMetrics(): void {
  checks.ok = 0;
  checks.failed = 0;
  checks.fail_open = 0;
  canaryInvalidTokenRejected = 0;
  canaryLastRunSeconds = 0;
}
