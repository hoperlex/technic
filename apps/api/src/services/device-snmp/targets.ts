import { devicePollKeySchema } from '@technic/contracts';

/**
 * РЕЕСТР ЦЕЛЕЙ ОПРОСА — одной настройкой окружения, без таблицы и без экрана.
 *
 * ПОЧЕМУ ТАК, А НЕ В БАЗЕ. Это первый, тестовый контур: аппарат один, и до ручных проверок неясно
 * ни что аппараты отвечают на самом деле, ни какие поля цели вообще нужны. Таблица, заведённая до
 * этого знания, стоила бы миграции на каждое уточнение — а форма настройки здесь меняется
 * перезапуском.
 *
 * ПОЧЕМУ НЕ КОНСТАНТА В КОДЕ, РАЗ «ВСЁ ЗАХАРДКОЖЕНО». Способ доставки до аппарата ещё не выбран:
 * сегодня это может быть проброшенный порт на белом адресе офиса, завтра — туннель и настоящий
 * `192.168.5.71:161`. Адрес в коде означал бы выкат на каждую смену маршрута, а выкат ради строки
 * подключения — худший вид выката.
 *
 * COMMUNITY ЖИВЁТ ЗДЕСЬ ЖЕ И НИКОГДА НЕ ПОКАЗЫВАЕТСЯ. В SNMP v2c она и есть пароль чтения: её
 * место — рядом с прочими секретами окружения, а не в ответе ручки (см. `DevicePollTargetDto`).
 *
 * Формат строки — цели через `;`, поля через `|`:
 *
 *   ключ|название|хост[:порт]|community|серийный-номер
 *   ricoh-1|RICOH MP C2011SP, приёмная|192.168.5.71:161|public|Y505P400123
 *
 * Серийный номер необязателен, и его отсутствие — осознанный режим: цель опрашивается, но
 * показание не пишется, потому что писать его некуда и не на чем сверить (см. `poll.ts`).
 */

export interface PollTarget {
  key: string;
  label: string;
  host: string;
  port: number;
  community: string;
  /** Пусто — карточка не ищется и сверка не делается. */
  expectedSerial: string;
}

export interface ParsedTargets {
  targets: PollTarget[];
  /** Строки, которые разобрать не удалось: их показывают в журнале, а не роняют ими портал. */
  problems: string[];
}

const DEFAULT_PORT = 161;

/**
 * Разбор реестра.
 *
 * БИТАЯ СТРОКА НЕ РОНЯЕТ ПРИЛОЖЕНИЕ. Опечатка в необязательной настройке не должна стоить портала
 * целиком: цель пропускается, причина уезжает в журнал, остальные цели работают. Обратное решение
 * («падать на старте») выглядит строже, но означает, что правка адреса принтера в проде может
 * оставить без портала всех, включая тех, кто про опрос не знает.
 */
export function parsePollTargets(raw: string): ParsedTargets {
  const targets: PollTarget[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const chunk of raw.split(';')) {
    const line = chunk.trim();
    if (!line) continue;

    const parts = line.split('|').map((p) => p.trim());
    const [key = '', label = '', address = '', community = '', serial = ''] = parts;

    const keyCheck = devicePollKeySchema.safeParse(key);
    if (!keyCheck.success) {
      problems.push(`«${line}»: ключ цели не подходит (латиница, цифры и дефис)`);
      continue;
    }
    if (seen.has(key)) {
      // Два описания одной цели — это два разных ответа на вопрос «куда идти»: молча взять первое
      // значило бы спрятать вторую строку от того, кто её только что дописал.
      problems.push(`«${line}»: ключ «${key}» уже встречался`);
      continue;
    }
    if (!label) {
      problems.push(`«${line}»: у цели нет названия`);
      continue;
    }

    const parsedAddress = parseAddress(address);
    if (!parsedAddress) {
      problems.push(`«${line}»: адрес не разобран, ожидается «хост» или «хост:порт»`);
      continue;
    }
    if (!community) {
      problems.push(`«${line}»: не задана community`);
      continue;
    }

    seen.add(key);
    targets.push({
      key,
      label,
      host: parsedAddress.host,
      port: parsedAddress.port,
      community,
      expectedSerial: serial,
    });
  }

  return { targets, problems };
}

function parseAddress(raw: string): { host: string; port: number } | null {
  if (!raw || /\s/.test(raw)) return null;
  const at = raw.lastIndexOf(':');
  if (at < 0) return { host: raw, port: DEFAULT_PORT };
  const host = raw.slice(0, at);
  const port = Number(raw.slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

/** Адрес для показа человеку: то же, что в настройке, но без community. */
export function targetAddress(target: PollTarget): string {
  return `${target.host}:${target.port}`;
}
