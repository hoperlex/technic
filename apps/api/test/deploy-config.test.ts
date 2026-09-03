import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Content-Security-Policy живёт в репозитории **двумя копиями** одной строки: боевой vhost
 * `deploy/nginx/technic.conf` и конфиг стенда `deploy/nginx/stand.conf`. Этот тест держит копии
 * равными.
 *
 * **Почему копии, а не общий `include`.** Вынос политики во фрагмент nginx рассматривался и был
 * отклонён (`docs/smart-captcha-plan.md` §11): `sync_vhost` в `deploy/deploy-auto.sh` сравнивает и
 * раскатывает ровно один файл — `LIVE_VHOST=/opt/infra/nginx/conf.d/technic.conf`, — и правка
 * отдельного фрагмента осталась бы в репозитории, а состояние vhost показало бы «актуален»: CSP в
 * проде осталась бы старой при внешне успешном деплое, и предупреждением дело бы и кончилось.
 * Плюс фрагмент в `conf.d/*.conf` подхватывается автоматически, а `add_header` вне блока `server`
 * уронил бы `nginx -t` общего `infra-nginx` — то есть reload соседних порталов.
 *
 * **Почему это стоит теста.** Стенд существует ради приёмки CSP: под боевой политикой проверяется,
 * что сторонний скрипт капчи грузится, а лишнего не разрешено. Приёмка на стенде доказывает
 * что-либо о проде ровно до тех пор, пока политики совпадают — а расходятся они молча, одной
 * правкой в одном файле, и увидеть это можно только сверкой двух длинных строк глазами. Прогон
 * делает это надёжнее человека: политику правят в обоих файлах одной правкой, иначе тест падает и
 * показывает обе строки.
 *
 * Третья копия той же строки лежит в `deploy/nginx/portal.conf.example` — это справочный образец
 * edge-vhost, он ничего не отдаёт ни браузеру, ни приёмке, и потому здесь не сверяется.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Боевой vhost: единственный файл, который деплой синхронизирует на VPS. */
const PROD_CONF = 'deploy/nginx/technic.conf';
/** Внешний nginx стенда (`deploy/docker-compose.stand.yml`), роль infra-nginx локально. */
const STAND_CONF = 'deploy/nginx/stand.conf';

type CspDirective = {
  /** Значение политики — то, что уходит в браузер. */
  value: string;
  /** Директива целиком, вместе с флагом `always`; попадает в сообщение о расхождении. */
  directive: string;
};

/**
 * Достаёт директивы `add_header Content-Security-Policy` из конфига nginx.
 *
 * Закомментированные строки пропускаются намеренно: nginx их не применяет, и старая политика,
 * оставленная в комментарии «на всякий случай», не должна сходить за действующую.
 */
function readCspDirectives(relPath: string): CspDirective[] {
  const text = readFileSync(join(repoRoot, relPath), 'utf8');
  const found: CspDirective[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const match = /^add_header\s+Content-Security-Policy\s+"([^"]*)"(.*);$/.exec(line);
    if (match) found.push({ value: match[1]!, directive: line });
  }
  return found;
}

const prod = readCspDirectives(PROD_CONF);
const stand = readCspDirectives(STAND_CONF);

/** Сообщение о расхождении: обе строки целиком, чтобы разницу было видно из вывода прогона. */
function mismatchMessage(what: string, prodText: string, standText: string): string {
  return [
    `${what} боевого nginx и nginx стенда разошлись.`,
    'Политика правится в обоих файлах одной правкой: общего include у них нет и не будет',
    '(деплой раскатывает только technic.conf — docs/smart-captcha-plan.md §11).',
    `${PROD_CONF}:`,
    `  ${prodText}`,
    `${STAND_CONF}:`,
    `  ${standText}`,
  ].join('\n');
}

describe('CSP: боевой nginx и nginx стенда держат одну политику', () => {
  it('в каждом конфиге ровно одна директива Content-Security-Policy', () => {
    // Две директивы в одном файле — это не «усиление политики», а тихая подмена: nginx применит
    // ту, что задана последней в этом уровне конфигурации, и сверять пришлось бы уже не строки.
    expect(prod.map((d) => d.directive)).toHaveLength(1);
    expect(stand.map((d) => d.directive)).toHaveLength(1);
  });

  it('политика стенда совпадает с боевой посимвольно', () => {
    const prodValue = prod[0]!.value;
    const standValue = stand[0]!.value;
    expect(standValue, mismatchMessage('Content-Security-Policy', prodValue, standValue)).toBe(
      prodValue,
    );
  });

  it('обе директивы помечены always — политика доходит и на ответах об ошибке', () => {
    // Без `always` nginx не ставит заголовок на 4xx/5xx: страница ошибки портала оказалась бы без
    // политики, и разошлись бы уже не строки, а поведение стенда и прода.
    const prodDirective = prod[0]!.directive;
    const standDirective = stand[0]!.directive;
    const message = mismatchMessage('Флаг always директивы CSP', prodDirective, standDirective);
    expect(prodDirective.endsWith('always;'), message).toBe(true);
    expect(standDirective.endsWith('always;'), message).toBe(true);
  });
});

/**
 * ─── Режим технических работ: веб-слой (`docs/maintenance-mode-plan.md` §4.4, этап Э4) ─────────
 *
 * Объявление в окне выката держит не портал, а три файла развёртывания сразу: маунт каталога со
 * статусом в двух compose, путь флаг-файла в `spa.conf` и страница объявления, положенная в образ
 * `Dockerfile.web`. Ни один из трёх не проверяется ни типами, ни сборкой, а разъезжаются они молча
 * и всегда с одним исходом: `deploy-auto --maintenance=on` отчитается об успехе (файл на хост он
 * положил), а человек в окне увидит форму входа и сетевые ошибки — ровно то, ради чего режим и
 * заводился. Отдельно неприятно, что проверить это можно только в окне, то есть на проде и
 * однажды.
 *
 * Поэтому здесь сверяются не строки сами по себе, а СТЫКИ файлов: тот ли путь у маунта и у
 * локации, лежит ли он вне корня nginx, попадает ли страница в образ и не в тот каталог, который
 * в бою перекрыт маунтом.
 */

/** nginx контейнера веба: статика SPA, прокси `/api` и — с Э4 — оба канала режима техработ. */
const WEB_CONF = 'deploy/nginx/spa.conf';
/** Боевой compose: `technic-web` монтирует сюда каталог со статусом. */
const PROD_COMPOSE = 'deploy/docker-compose.yml';
/** Стенд приёмки: тот же маунт, иначе проверки режима на стенде невоспроизводимы. */
const STAND_COMPOSE = 'deploy/docker-compose.stand.yml';
/** Образ веба: сюда кладётся статическая заглушка. */
const WEB_DOCKERFILE = 'deploy/Dockerfile.web';
/** Сама заглушка — единственная страница портала, которая обязана работать без API. */
const MAINTENANCE_PAGE = 'deploy/nginx/maintenance.html';

/** Каталог со статусом ВНУТРИ контейнера веба — общая точка compose и `spa.conf`. */
const MAINTENANCE_DIR = '/etc/nginx/maintenance';
/** Флаг-файл: его наличие и есть «портал закрыт», отсутствие — «режима нет» (404). */
const MAINTENANCE_FLAG = `${MAINTENANCE_DIR}/maintenance.json`;
/** Каталог на хосте, откуда статус приезжает в бою (`root:docker`, проходим для nginx). */
const PROD_MAINTENANCE_SOURCE = '/etc/technic-portal/maintenance';

function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

/** Строки без комментариев: закомментированная директива не должна сходить за действующую. */
function nginxLines(conf: string): string[] {
  return conf.split('\n').map((line) => line.replace(/#.*$/, ''));
}

/**
 * Тело блока `location` со счётом скобок.
 *
 * Приём повторён из `print-budget.test.ts` намеренно: общий помощник ради двух вызовов — это
 * третий файл, который придётся открыть, разбираясь в упавшем прогоне конфигурации.
 */
function locationBody(conf: string, header: RegExp): string | null {
  const lines = nginxLines(conf);
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

/** Корень статики из `spa.conf`. Берётся из файла, а не из константы: сверять надо с тем, что есть. */
function nginxRoot(conf: string): string {
  const match = /^\s*root\s+(\S+);/m.exec(nginxLines(conf).join('\n'));
  if (!match) throw new Error(`${WEB_CONF}: не найдена директива root — сверять маунт не с чем`);
  return match[1]!;
}

/**
 * Блок сервиса из compose: от строки `  <имя>:` до следующего ключа того же уровня.
 *
 * Разбор построчный, а не YAML-парсером: тест обязан падать и на файле, который парсер прочитать
 * уже не может, — а строку с маунтом в нём видно и так. Комментарии выброшены: путь, упомянутый в
 * пояснении рядом, не есть маунт.
 */
function composeServiceBlock(text: string, service: string): string | null {
  const lines = text.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => line.trimEnd() === `  ${service}:`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** Список маунтов сервиса — как они записаны, вместе с режимом доступа. */
function serviceMounts(relPath: string, service: string): string[] {
  const block = composeServiceBlock(readRepoFile(relPath), service);
  if (block === null) return [];
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^\s*volumes:\s*$/.test(line));
  if (start < 0) return [];
  const mounts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s+(\S.*?)\s*$/.exec(line);
    if (!item) break; // список кончился — дальше другой ключ сервиса
    mounts.push(item[1]!.replace(/^['"]|['"]$/g, ''));
  }
  return mounts;
}

type Mount = { source: string; target: string; mode: string };

/**
 * Разбор записи маунта `источник:цель[:режим]`.
 *
 * Цель отделяется С КОНЦА: источник на стенде задан подстановкой `${MAINTENANCE_DIR:-…}`, внутри
 * которой есть своё двоеточие, и разбиение слева направо развалило бы строку не там.
 */
function parseMount(entry: string): Mount | null {
  const match = /^(.*):(\/[^:]+)(?::(\w+))?$/.exec(entry);
  if (!match) return null;
  return { source: match[1]!, target: match[2]!, mode: match[3] ?? '' };
}

/**
 * Путь флаг-файла, каким его читает nginx: берётся из `alias` локации `/maintenance.json`.
 *
 * Из конфига, а не из константы этого файла: сверять маунт надо с тем, что nginx действительно
 * откроет. Разъехаться могут ровно два места — маунт и локация, — и падать тест обязан на их
 * расхождении.
 */
function statusFlagFromConf(): string {
  const block = locationBody(readRepoFile(WEB_CONF), /location\s+=\s+\/maintenance\.json\b/);
  const alias = /^\s*alias\s+(\S+);/m.exec(block ?? '');
  if (!alias) throw new Error(`${WEB_CONF}: у локации = /maintenance.json нет alias`);
  return alias[1]!;
}

/** Маунт каталога со статусом у `technic-web` — тот, чья цель совпала с путём из `spa.conf`. */
function maintenanceMount(relPath: string): Mount | null {
  const dir = dirname(statusFlagFromConf());
  return (
    serviceMounts(relPath, 'technic-web')
      .map(parseMount)
      .find((mount): mount is Mount => mount !== null && mount.target === dir) ?? null
  );
}

describe.each([
  ['боевой compose', PROD_COMPOSE],
  ['compose стенда', STAND_COMPOSE],
])('режим техработ: %s монтирует статус в контейнер веба', (_name, relPath) => {
  it('маунт есть у technic-web и смонтирован только на чтение', () => {
    // Стенд сверяется наравне с боем не для симметрии: без маунта на нём невозможны обе проверки
    // режима — заглушка при остановленном api и снятие режима по 404 (план §4.4). Проверить их
    // больше негде: гейт в API в окне молчит именно потому, что контейнер остановлен.
    const mount = maintenanceMount(relPath);
    expect(
      mount,
      `${relPath}: у technic-web нет маунта ${MAINTENANCE_DIR} — веб не увидит статус режима, ` +
        'и в окне выката портал покажет форму входа вместо объявления',
    ).not.toBe(null);
    // `ro` — не украшение: писать в статус имеет право только команда режима на хосте. Контейнер,
    // которому статус можно править, однажды снял бы режим сам (или не снял бы никогда).
    expect(mount!.mode, `${relPath}: маунт статуса обязан быть :ro`).toBe('ro');
  });

  it('цель маунта лежит вне корня статики', () => {
    // Внутри /usr/share/nginx/html файл попал бы под try_files и раздавался как часть SPA — то
    // есть статус зависел бы от сборки, а не от хоста, и локация с alias была бы не нужна вовсе.
    const root = nginxRoot(readRepoFile(WEB_CONF));
    const target = maintenanceMount(relPath)!.target;
    expect(
      target.startsWith(`${root}/`),
      `${relPath}: каталог статуса ${target} оказался внутри корня nginx ${root}`,
    ).toBe(false);
  });
});

describe('режим техработ: боевой источник статуса', () => {
  it('в бою монтируется каталог на хосте, а не файл', () => {
    // Каталог, а не файл: команда режима подменяет статус на месте (пишет рядом и переименовывает
    // поверх), а bind-mount ФАЙЛА привязан к inode — после подмены контейнер до конца своей жизни
    // показывал бы прежнее состояние. Проверяется это единственным доступным здесь способом: у
    // источника нет расширения файла и он совпадает с оговорённым в плане каталогом.
    expect(maintenanceMount(PROD_COMPOSE)!.source).toBe(PROD_MAINTENANCE_SOURCE);
  });
});

describe('режим техработ: spa.conf раздаёт статус и заглушку', () => {
  const conf = readRepoFile(WEB_CONF);

  it('статус отдаётся локацией с alias, а не root', () => {
    // Найденная ревью ошибка: `root` дописал бы URI к своему значению и nginx искал бы
    // /etc/nginx/maintenance/maintenance.json/maintenance.json — то есть режим не включался бы
    // никогда, а выглядело бы это как «файл положили, а объявления нет».
    const block = locationBody(conf, /location\s+=\s+\/maintenance\.json\b/);
    expect(
      block,
      `${WEB_CONF}: нет локации = /maintenance.json — статус режима не раздаётся`,
    ).not.toBe(null);
    expect(block).toMatch(new RegExp(`alias\\s+${MAINTENANCE_FLAG};`));
    expect(
      block,
      `${WEB_CONF}: у локации статуса появился root — путь считается неверно`,
    ).not.toMatch(/^\s*root\s+/m);
    // Без default_type ответ ушёл бы с типом по умолчанию, и клиент разбирал бы его как текст.
    expect(block).toMatch(/default_type\s+application\/json;/);
    // add_header внутри location отменяет наследование с уровня server — заголовки обязаны быть
    // продублированы здесь же, иначе статус уедет кэшируемым и без nosniff.
    expect(block).toMatch(/add_header\s+Cache-Control\s+"no-store"\s+always;/);
    expect(block).toMatch(/add_header\s+X-Content-Type-Options\s+nosniff\s+always;/);
  });

  it('навигация в окне отдаёт заглушку вместо оболочки SPA', () => {
    // §3 плана: это и есть «дешёвое усиление» — перезагрузка страницы показывает объявление
    // независимо от возраста сборки вкладки и от того, жив ли technic-api.
    const block = locationBody(conf, /location\s+\/\s*\{/);
    expect(block, `${WEB_CONF}: нет catch-all локации — SPA-fallback потерян целиком`).not.toBe(
      null,
    );
    expect(
      block,
      `${WEB_CONF}: навигация не проверяет ${MAINTENANCE_FLAG} — в окне вкладка получит index.html`,
    ).toMatch(new RegExp(`if\\s+\\(-f\\s+${MAINTENANCE_FLAG}\\)\\s*\\{\\s*return\\s+503;\\s*\\}`));
    expect(
      block,
      `${WEB_CONF}: без error_page 503 человек увидит служебную страницу nginx вместо объявления`,
    ).toMatch(/error_page\s+503\s+\/maintenance\.html;/);
    // Fallback обязан остаться: без него все маршруты портала вне окна отвечали бы 404.
    expect(block).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });

  it('заглушка живёт в собственной точной локации', () => {
    // Иначе внутренний редирект error_page возвращается в `location /`, снова встречает `if` и
    // получает 503, а повторно обрабатывать error_page nginx по умолчанию не станет
    // (recursive_error_pages off). Проверено на nginx:1.27-alpine: без этой локации навигация в
    // окне отвечает служебной страницей «503 Service Temporarily Unavailable» — объявления нет.
    const block = locationBody(conf, /location\s+=\s+\/maintenance\.html\b/);
    expect(block, `${WEB_CONF}: нет локации = /maintenance.html — error_page зациклится`).not.toBe(
      null,
    );
    expect(block).toMatch(/add_header\s+Cache-Control\s+"no-store"\s+always;/);
  });

  it('проверка флага стоит ровно в одном месте', () => {
    // Скопированная в /assets/, /api/ или в локацию самого статуса, она сломала бы в окне то, что
    // обязано работать: дозагрузку статики, 503 `maintenance_mode` с телом от API и единственный
    // ответ, по которому вкладка узнаёт, что режим снят.
    const gates = nginxLines(conf).filter((line) => /if\s*\(-f/.test(line));
    expect(gates, `${WEB_CONF}: проверок флага должно быть ровно одна`).toHaveLength(1);
    for (const forbidden of [
      /location\s+=\s+\/maintenance\.json\b/,
      /location\s+\/assets\/\s*\{/,
      /location\s+\/api\/\s*\{/,
      /location\s+=\s+\/version\.json\b/,
    ]) {
      expect(locationBody(conf, forbidden), `${WEB_CONF}: ${forbidden} потеряна`).not.toBe(null);
      expect(locationBody(conf, forbidden)).not.toMatch(/if\s*\(-f/);
    }
  });
});

describe('режим техработ: заглушка едет в образе веба', () => {
  it('Dockerfile кладёт страницу в корень статики, а не в каталог статуса', () => {
    // Каталог статуса в бою перекрыт bind-mount'ом с хоста: всё, что образ положил внутрь него, в
    // контейнере не видно — заглушка исчезла бы ровно в том окне, ради которого заводится.
    const root = nginxRoot(readRepoFile(WEB_CONF));
    const copy = readRepoFile(WEB_DOCKERFILE)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .map((line) => new RegExp(`^COPY\\s+${MAINTENANCE_PAGE}\\s+(\\S+)`).exec(line))
      .find((match) => match !== null);
    expect(
      copy,
      `${WEB_DOCKERFILE}: заглушка не копируется в образ — error_page отдаст 500`,
    ).not.toBe(undefined);
    expect(copy![1]).toBe(`${root}/maintenance.html`);
  });

  it('страница самодостаточна: ни одного внешнего ресурса', () => {
    // Она обязана работать в единственном сценарии, ради которого заведена: API остановлен, сеть
    // портала закрыта, политика CSP разрешает только 'self'. Любой внешний шрифт или скрипт
    // означал бы страницу без оформления (или без смысла) ровно тогда, когда объяснять
    // происходящее особенно нужно. Инлайновый скрипт добавить тоже нельзя: script-src портала —
    // 'self' без 'unsafe-inline', браузер его не выполнит.
    const page = readRepoFile(MAINTENANCE_PAGE);
    for (const forbidden of [
      /https?:\/\//i,
      /<script/i,
      /<link\b/i,
      /<img\b/i,
      /\bsrc\s*=/i,
      /@import/i,
      /url\(/i,
    ]) {
      expect(
        page,
        `${MAINTENANCE_PAGE}: внешний ресурс ${forbidden} — страница перестала быть автономной`,
      ).not.toMatch(forbidden);
    }
    // Текст объявления по-русски и на месте: пустая страница формально прошла бы проверки выше.
    expect(page).toMatch(/Технические работы/);
  });
});
