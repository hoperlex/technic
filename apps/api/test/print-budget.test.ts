import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  converterBudgetMs,
  PRINT_BUDGET,
  PRINT_BUDGET_LADDER,
  WAYBILL_PRINT_BATCH_LIMIT,
} from '@technic/contracts';

/**
 * Лестница сроков печати (ADR 0148) живёт в трёх языках сразу: числа объявлены в контрактах
 * (TypeScript), применяются в конфигах nginx и читаются вкладкой. Типы связывают из этого только
 * первое и третье — конфиг деплоя типами не проверишь, а разъезжается он молча.
 *
 * **Что именно защищает этот тест.** Дефект, ради которого лестница заведена, выглядел безобидно:
 * сервер отводил конвертеру `30 с × число листов`, nginx рвал соединение через 60 с. Каждое число
 * по отдельности было разумным, неразумным было их сочетание — а сочетание не видно, пока числа
 * лежат в разных файлах. Печать пачки поэтому обрывалась у человека всегда, и обрыв этот приходил
 * от того, кто про печать не знает ничего и умеет только закрыть соединение.
 *
 * Поэтому здесь проверяются не значения сами по себе («165 — правильное число»), а отношения между
 * ними: порядок ступеней, равенство конфигов контракту и то, что предельная пачка ещё умещается в
 * отведённое. Такой тест переживает изменение чисел — он падает, только если слои разошлись.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Внешний vhost: единственный файл, который деплой синхронизирует на VPS. */
const EDGE_CONF = 'deploy/nginx/technic.conf';
/** nginx внутри контейнера web: статика SPA и прокси `/api` на контейнер API. */
const WEB_CONF = 'deploy/nginx/spa.conf';
/**
 * Внешний nginx стенда приёмки — в деплое не участвует, но играет роль боевого.
 *
 * Сверяется наравне с боевыми по причине из `deploy-config.test.ts`: приёмка на стенде доказывает
 * что-либо о проде ровно до тех пор, пока конфигурации совпадают. Разойдись сроки — стенд показывал
 * бы обрыв печати там, где в бою его уже нет, и следующий разбор пошёл бы искать дефект в коде.
 */
const STAND_CONF = 'deploy/nginx/stand.conf';

function readConf(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

/**
 * Тело блока `location`, начиная с заголовка, до его закрывающей скобки.
 *
 * Скобки считаются, а не ищется первая закрывающая: внутри блока могут появиться вложенные
 * конструкции, и наивный поиск закончил бы блок раньше времени, спрятав от проверки его хвост.
 * Комментарии при этом отбрасываются — nginx их не исполняет, и директива, оставленная в
 * комментарии «на потом», не должна сходить за действующую.
 */
function locationBody(conf: string, header: RegExp): string | null {
  const lines = conf.split('\n').map((line) => line.replace(/#.*$/, ''));
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;
  let depth = 0;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    body.push(line);
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (i > start && depth <= 0) break;
  }
  return body.join('\n');
}

/** `proxy_read_timeout 165s;` → 165000. Секунды и миллисекунды пишут по-разному, а сравнивать надо. */
function readTimeoutMs(block: string): number | null {
  const match = /proxy_read_timeout\s+(\d+)(m?s)\s*;/.exec(block);
  if (!match) return null;
  return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * 1000;
}

/** Заголовок локации печати. Кавычки обязательны — почему, проверяется отдельным случаем ниже. */
const PRINT_LOCATION = /location\s+~\s+"\^\/api\/v1\/waybills\//;

describe('лестница сроков печати', () => {
  it('ступени убывают сверху вниз: первым сдаётся тот, кто ближе к работе', () => {
    // Равенство соседних ступеней запрещено наравне с обратным порядком: совпавшие сроки — это
    // гонка, в которой заранее неизвестно, кто ответит человеку, а лестница затем и нужна, чтобы
    // это было известно.
    for (let i = 1; i < PRINT_BUDGET_LADDER.length; i += 1) {
      const lower = PRINT_BUDGET_LADDER[i - 1]!;
      const upper = PRINT_BUDGET_LADDER[i]!;
      expect(
        lower.ms,
        `${lower.name} (${lower.where}) обязан истекать раньше, чем ${upper.name} (${upper.where})`,
      ).toBeLessThan(upper.ms);
    }
  });

  it('предельная пачка умещается в потолок конвертера', () => {
    // Иначе печать полусотни листов упиралась бы в срок всегда — то есть предел пачки обещал бы
    // человеку то, чего портал не делает.
    const budget = converterBudgetMs(WAYBILL_PRINT_BATCH_LIMIT);
    expect(budget).toBeLessThanOrEqual(PRINT_BUDGET.converterMaxMs);
    expect(budget).toBeLessThan(PRINT_BUDGET.handlerMs);
  });

  it('срок растёт с числом листов и упирается в потолок', () => {
    expect(converterBudgetMs(1)).toBeLessThan(converterBudgetMs(10));
    expect(converterBudgetMs(10)).toBeLessThan(converterBudgetMs(50));
    // Потолок — не украшение: без него большая пачка снова получила бы право занимать сервер
    // дольше, чем его готов ждать кто бы то ни было.
    expect(converterBudgetMs(100_000)).toBe(PRINT_BUDGET.converterMaxMs);
  });

  it('одиночный лист не ждёт столько же, сколько пачка', () => {
    // Не уложившийся в свой срок одиночный лист — поломка, и сказать о ней надо сразу, а не через
    // две минуты «на всякий случай».
    expect(converterBudgetMs(1)).toBeLessThan(PRINT_BUDGET.converterMaxMs / 2);
  });
});

describe.each([
  ['внешний nginx', EDGE_CONF],
  ['nginx контейнера web', WEB_CONF],
  ['внешний nginx стенда', STAND_CONF],
])('%s знает про печать', (_name, relPath) => {
  it('держит для печати ровно тот срок, что объявлен лестницей', () => {
    const block = locationBody(readConf(relPath), PRINT_LOCATION);
    expect(block, `в ${relPath} нет локации печати — её срок вернулся к умолчанию nginx`).not.toBe(
      null,
    );
    expect(readTimeoutMs(block!), `${relPath}: proxy_read_timeout разошёлся с PRINT_BUDGET`).toBe(
      PRINT_BUDGET.proxyReadMs,
    );
  });

  it('покрывает оба пути печати — и лист, и пачку', () => {
    const block = locationBody(readConf(relPath), PRINT_LOCATION)!;
    // Пачка и одиночный лист — разные маршруты API, и забыть один значит оставить его с прежним
    // умолчанием: обрыв вернётся ровно там.
    expect(block).toContain('print-batch');
    expect(block).toContain('/print');
  });

  it('выражение локации взято в кавычки', () => {
    // Без кавычек nginx принимает `{36}` из UUID за начало блока и не поднимается вовсе. На общем
    // infra-nginx это не «печать сломалась», а «reload не прошёл» — вместе с соседними порталами.
    const conf = readConf(relPath);
    expect(conf).toMatch(/location\s+~\s+"[^"]*waybills[^"]*"\s*\{/);
  });

  it('не заводит внутри локации печати своих proxy_set_header', () => {
    // Ловушка nginx: заголовки не наследуются, если в location есть хоть один свой — весь набор с
    // уровня server отбрасывается целиком. Потерять здесь X-Forwarded-For значит сломать и
    // IP-лимиты, и secure-cookie, причём только на печати и молча.
    const block = locationBody(readConf(relPath), PRINT_LOCATION)!;
    expect(block).not.toMatch(/proxy_set_header/);
  });
});

describe('обычные ручки', () => {
  it('остаются с коротким сроком', () => {
    // Печать — исключение, а не новое общее правило. Висящая минутами обычная ручка означает
    // поломку, и держать её соединение столько же, сколько печать, незачем.
    const conf = readConf(WEB_CONF);
    const outsidePrint = conf.replace(locationBody(conf, PRINT_LOCATION)!, '');
    const ordinary = readTimeoutMs(outsidePrint);
    expect(ordinary).not.toBe(null);
    expect(ordinary!).toBeLessThan(PRINT_BUDGET.proxyReadMs);
  });
});
