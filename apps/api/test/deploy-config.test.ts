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
