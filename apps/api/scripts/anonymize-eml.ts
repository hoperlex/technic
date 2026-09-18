import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEncodedWords, decodeText } from '../src/services/device-mail/mime';

/**
 * Обезличиватель живых `.eml` перед коммитом в публичный репозиторий — решение Р19 плана
 * `docs/office-equipment-mail-telemetry-plan.md` (§12).
 *
 * ЗАЧЕМ. Фикстуры разборщика — настоящие письма с аппаратов пилота, а в них адреса сотрудников,
 * внутренние имена и IP, реальные серийные номера. Репозиторий публичный, и обезличивание руками —
 * это тот вид работы, который делается внимательно ровно первые три файла: письмо аппарата — это
 * двести строк base64 с HTML-таблицей внутри, и глазами оно не чистится.
 *
 * ГЛАВНОЕ ПРАВИЛО ФАЙЛА: **обезличиватель обязан видеть письмо не хуже, чем его же разборщик.**
 * Первая редакция этого скрипта чистила `.eml` как плоский текст в UTF-8 — и пропускала целиком
 * ровно то, что разборщик читает штатно: тему в `encoded-word` (RFC 2047) и часть в
 * `windows-1251`. В обоих случаях улика уезжала в публичный репозиторий, а счётчики показывали
 * «письмо почти чистое». Поэтому раскодирование здесь взято из самого разборщика —
 * [`decodeEncodedWords` и `decodeText`](../src/services/device-mail/mime.ts), — а не написано
 * заново: две реализации разошлись бы, и разошлись бы молча.
 *
 * ФОРМА СОХРАНЯЕТСЯ, ЗНАЧЕНИЕ НЕТ. Серийный номер заменяется вымышленным той же длины и того же
 * чередования букв и цифр (кириллическая буква — кириллической), адрес — адресом, хост — хостом,
 * IPv6 — IPv6. Форма нужна тому, ради чего фикстура и заводится: резолв (§6) ищет серийник телом
 * письма и сравнивает его с карточкой нормализованной формой, а профиль вендора достаёт его
 * шаблоном поля. Подмена «звёздочками» сделала бы фикстуру непригодной для проверки того самого
 * места, где ошибка приписывает чужую наработку живой карточке.
 *
 * ПОДМЕНА УСТОЙЧИВА, И ЭТО НЕ УДОБСТВО, А ТРЕБОВАНИЕ. Вымышленное значение выводится хешем от
 * исходного и соли, поэтому один и тот же серийник даёт один и тот же вымышленный — и в теме
 * письма, и в текстовой части, и в base64-таблице HTML. Случайная подмена превратила бы два
 * письма одного аппарата в письма двух разных, а на таких фикстурах проверяется дедупликация и
 * повторный резолв: тест позеленел бы, ничего не проверив.
 *
 * ПОДМЕНЁННОЕ БОЛЬШЕ НЕ ТРОГАЕТСЯ. Каждая замена уезжает в текст не значением, а метко́й из
 * области частного использования Unicode, и разворачивается обратно в самом конце. Иначе правила
 * наступают друг на друга: номер, снятый списком `--serial`, во второй раз подменялся бы правилом
 * по подписи поля — и один аппарат становился бы двумя. Метка не совпадает ни с одним классом
 * знаков в правилах ниже, поэтому порядок правил перестал быть хрупким.
 *
 * ТИХИХ ПРОПУСКОВ НЕТ. Три случая, где скрипт обязан не «сделать что может», а **отказаться**
 * (ненулевой код возврата, ни одного байта на выход): кодировка части не раскодируется; письмо
 * объявлено `multipart`, а границы нет или она не встретилась в теле; перечисленное руками
 * значение (`--serial`, `--host`, `--domain`) не применилось или осталось в тексте. Причина одна
 * и та же: «я не понял письмо» и «письмо чистое» обязаны различаться. Тихий откат к плоскому
 * тексту — это и есть та утечка, которую нельзя увидеть по выводу.
 *
 * ПРОГОН — ОДИН, ПО ОРИГИНАЛУ. Выход помечается заголовком `X-Anonymized-By`, и повторный прогон
 * по уже обезличенному файлу **отказывается работать**. Причина: отличить вымышленное значение от
 * настоящего нельзя ничем, кроме догадки, и второй прогон честно принял бы свою же подмену за
 * улику — бесподписный хост и серийник переименовались бы заново, развязав письма одного аппарата.
 * Нужны другие ключи — прогон делается заново по оригиналу, а не по выходу.
 *
 * ЧИСТИТСЯ ЛИ ВСЁ. Нет, и об этом честно: скрипт снимает то, что опознаётся формой или подписью.
 * Значение, стоящее голым словом (имя аппарата в теме, номер без подписи, домен заказчика в URL),
 * формой не опознаётся ничем — такие значения перечисляются руками (`--serial`, `--host`,
 * `--domain`), и скрипт проверяет, что каждое из них применилось. Поэтому обезличенное письмо
 * всё равно читают глазами один раз, но читают уже вычищенное.
 *
 * Использование:
 *   pnpm --filter @technic/api exec tsx scripts/anonymize-eml.ts <вход.eml> <выход.eml> \
 *     [--serial=НОМЕР]... [--host=ИМЯ]... [--domain=ДОМЕН]... [--salt=СОЛЬ]
 */

/** Соль подмены по умолчанию — одна на весь набор фикстур (см. шапку). */
const DEFAULT_SALT = 'technic-device-mail-fixtures';

/** Домен, на который переезжают все адреса и имена хостов: RFC 2606 отводит его под примеры. */
const SAFE_DOMAIN = 'example.net';

/** Сеть подмены IPv4 — TEST-NET-2 (RFC 5737), отведённая под документацию. */
const SAFE_IP_PREFIX = '198.51.100.';

/** Сеть подмены IPv6 — `2001:db8::/32` (RFC 3849), отведённая под документацию. */
const SAFE_IPV6_PREFIX = ['2001', 'db8'];

/** Диапазон подмены MAC — документационный (RFC 7042, `00:00:5E:00:53:xx`). */
const SAFE_MAC_PREFIX = ['00', '00', '5E', '00', '53'];

/** Пометка выхода: по ней повторный прогон узнаёт уже обезличенное письмо и отказывается. */
const MARKER_FIELD = 'X-Anonymized-By';
/* Значение пометки — только ASCII: блок заголовков уезжает байтами, и кириллица в нём стала бы мусором. */
const MARKER_VALUE = 'anonymize-eml (fictional values, original shape)';

/** Домены внутренней сети: имя с таким окончанием — внутреннее по построению. */
const INTERNAL_TLDS = [
  'local',
  'lan',
  'intranet',
  'internal',
  'corp',
  'localdomain',
  'home\\.arpa',
];

/** Заголовки, значение которых разбирается как список `display-name <адрес>`. */
const ADDRESS_FIELDS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'resent-from',
  'resent-to',
  'return-path',
  'x-original-from',
]);

/** Имена-заглушки в `Received`: подменять их нечего, а шума они дают больше, чем пользы. */
const HOST_PLACEHOLDERS = new Set(['unknown', 'localhost', 'unknown-host']);

/*
 * Метка подмены: `U+E000` + знак области частного использования + `U+E001`. Ни цифр, ни букв —
 * поэтому ни одно правило ниже внутрь метки не заглянет и уже подменённое второй раз не тронет.
 */
const MARK_OPEN = '\uE000';
const MARK_CLOSE = '\uE001';
const MARK_BASE = 0xe100;
const MARK_LIMIT = 0xf8ff - MARK_BASE;
const MARKED = /\uE000([\uE100-\uF8FF])\uE001/gu;
/** Класс знаков, который правила обязаны пропускать внутрь себя, чтобы видеть остаток значения. */
const MARK_CLASS = '\\uE000-\\uF8FF';

/**
 * Разделитель между подписью поля и его значением. Одной строкой закрывает три представления, в
 * которых аппараты присылают одно и то же: текст (`Serial Number: V508…`), HTML-таблицу
 * (`Serial Number</td><td>V508…`) и XML (`<serialNumber>V508…`). Квантификатор ленивый — иначе
 * разделитель съедал бы само значение и тянулся до следующего похожего.
 */
const LABEL_SEP = '(?:[\\s:=|>\\u00a0]|<[^>]{0,120}>|&nbsp;|&#160;){0,60}?';

/**
 * Значение серийного номера. Класс знаков нарочно широкий: аппараты пишут номер с пробелом
 * (`C1460 400123`), со слэшем (`0468-172/123`) и с кириллической буквой-двойником цифры
 * (`V5О85400123`) — на узком классе `[A-Za-z0-9-]` номер обрезался по первому такому знаку, и
 * живые цифры оставались в файле, а слитно написанный тот же номер получал другую подмену.
 *
 * Пробел допускается ровно один и только между группами: «значение до конца строки» съело бы
 * половину предложения. Группа после пробела оставляется лишь тогда, когда в ней есть цифра, —
 * иначе это уже следующее слово («Serial Number: V5085400123 модель»), и оно отрезается.
 */
const SERIAL_HEAD = `[\\p{L}\\d${MARK_CLASS}]`;
const SERIAL_BODY = `[\\p{L}\\d._/${MARK_CLASS}-]`;
const SERIAL_VALUE = `${SERIAL_HEAD}${SERIAL_BODY}{2,30}(?:[ ]${SERIAL_HEAD}${SERIAL_BODY}{1,30})?`;

const SERIAL_LABEL = new RegExp(
  `((?:Serial[\\s_-]*(?:Number|No\\.?|Num|#)?|S/N|Machine[\\s_-]*(?:ID|Serial)|` +
    `Серийный[\\s_-]*(?:номер|№)?|Заводской[\\s_-]*номер)${LABEL_SEP})(${SERIAL_VALUE})`,
  'giu',
);

const HOST_LABEL = new RegExp(
  `((?:Host[\\s_-]*Name|Hostname|Device[\\s_-]*Name|Machine[\\s_-]*Name|Computer[\\s_-]*Name|` +
    `Node[\\s_-]*Name|NetBIOS[\\s_-]*Name|Domain[\\s_-]*Name|` +
    `Имя[\\s_-]*(?:устройства|хоста|компьютера)|Сетевое[\\s_-]*имя)${LABEL_SEP})` +
    `([\\p{L}\\d${MARK_CLASS}][\\p{L}\\d._${MARK_CLASS}-]{2,63})`,
  'giu',
);

/**
 * Адрес электронной почты. `\p{L}` по обе стороны собаки, а не `[A-Za-z]`: адрес с кириллической
 * локальной частью и адрес в зоне `.рф` — такие же адреса сотрудников, и ASCII-правило их не
 * видело вовсе.
 */
const DOMAIN_PART =
  `(?:[\\p{L}\\d${MARK_CLASS}-]+(?:\\.[\\p{L}\\d${MARK_CLASS}-]+)+` +
  `|${MARK_OPEN}[\\uE100-\\uF8FF]${MARK_CLOSE})`;

/*
 * Домен адреса — либо имя с точкой, либо **целиком метка**. Второй случай не экзотика, а норма:
 * домен заказчика снимается ключом `--domain` раньше правила адресов, и без этой ветви правило
 * перестало бы узнавать адрес вовсе — локальная часть, то есть фамилия сотрудника, осталась бы в
 * файле при обезличенном домене. Проверено на живом прогоне: так уцелели пять адресов.
 */
const EMAIL = new RegExp(`[\\p{L}\\d._%+${MARK_CLASS}-]+@${DOMAIN_PART}`, 'gu');

/** Логин и пароль в URL (`http://admin:secret@хост/`): такая же улика, как адрес. */
const URL_USERINFO = new RegExp(`(?<=://)[^/@\\s]+(?=@${DOMAIN_PART})`, 'gu');

const INTERNAL_HOST = new RegExp(
  `\\b[\\p{L}\\d${MARK_CLASS}][\\p{L}\\d${MARK_CLASS}-]*` +
    `(?:\\.[\\p{L}\\d${MARK_CLASS}-]+)*\\.(?:${INTERNAL_TLDS.join('|')})\\b`,
  'giu',
);

/**
 * IPv4 целиком, а не только RFC 1918. Внутренний адрес легко опознаётся диапазоном, но белый адрес
 * шлюза площадки — такая же улика, и решать за читателя, какой из них «не страшно», обезличиватель
 * права не имеет. Побочный эффект известен: версия прошивки вида `1.05.2.3` неотличима от адреса и
 * тоже будет заменена. Это осознанный перекос в сторону лишнего вычищенного: пропущенный адрес
 * уезжает в публичный репозиторий навсегда, а испорченная версия прошивки видна в первом же тесте
 * разбора.
 */
const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g;

/**
 * IPv6 — строго: либо восемь групп, либо сжатие `::`. Нестрогая запись ловила бы время
 * (`09:12:44`) и ломала бы дату письма. Чистятся все адреса, включая `fd00::/8` — это внутренняя
 * сеть площадки — и `fe80::/10`.
 */
const H16 = '[0-9A-Fa-f]{1,4}';
const IPV6 = new RegExp(
  `(?<![:.\\w])(?:(?:${H16}:){7}${H16}|(?:${H16}:){1,7}:|(?:${H16}:){1,6}:${H16}` +
    `|(?:${H16}:){1,5}(?::${H16}){1,2}|(?:${H16}:){1,4}(?::${H16}){1,3}` +
    `|(?:${H16}:){1,3}(?::${H16}){1,4}|(?:${H16}:){1,2}(?::${H16}){1,5}` +
    `|${H16}:(?::${H16}){1,6}|:(?:(?::${H16}){1,7}|:))(?![:.\\w])`,
  'g',
);

/** MAC стоит в письмах рядом с серийником и опознаёт аппарат так же однозначно. */
const MAC = /(?<![\w:-])[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}(?![\w:-])/g;

/** Параметр RFC 2231 (`filename*=utf-8''%D0%9F…`): в нём приезжает имя аппарата и имя сотрудника. */
const PARAM_2231 = /([A-Za-z0-9-]+)\*=\s*([\w-]*)'([\w-]*)'([^;\s]+)/g;

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Для букв вне ASCII: кириллический двойник остаётся буквой того же регистра, но другой. */
const CYRILLIC_LOWER = 'абвгдежзиклмнопрстуфхцчшэюя';
const CYRILLIC_UPPER = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ';

/** Кодировки UTF-8 и ASCII: их кодировать обратно умеет `Buffer`, таблица байтов не нужна. */
const UTF8_NAMES = new Set(['', 'utf-8', 'utf8', 'unicode-1-1-utf-8', 'us-ascii', 'ascii']);

/** Отказ обезличивателя: письмо не понято целиком, и на выход не уходит ни один байт. */
export class AnonymizeRefusal extends Error {}

export interface AnonymizeOptions {
  /** Соль устойчивой подмены; по умолчанию — общая соль набора фикстур. */
  salt?: string;
  /** Серийные номера, которые в письме стоят без подписи и формой не опознаются. */
  serials?: readonly string[];
  /** Имена хостов и аппаратов, стоящие голым словом (тема письма, текст без подписи поля). */
  hosts?: readonly string[];
  /** Домены заказчика: переезжают в `example.net` всюду, включая URL и обратную зону. */
  domains?: readonly string[];
}

export interface AnonymizeStats {
  emails: number;
  serials: number;
  /** Сколько различных серийных номеров встретилось: столько же различных подмен. */
  distinctSerials: number;
  hosts: number;
  ips: number;
  ipv6: number;
  macs: number;
  /** Снятых отображаемых имён в адресных заголовках. */
  names: number;
  /** Раскрытых `encoded-word`-заголовков (RFC 2047) — в них улика лежит в base64. */
  encodedWords: number;
  /** Перекодированных частей письма не в UTF-8 (`windows-1251` и прочие). */
  recodedParts: number;
}

export interface AnonymizeResult {
  output: Buffer;
  stats: AnonymizeStats;
  /** Перечисленные руками значения, которые не применились ни разу: повод для отказа. */
  unapplied: string[];
}

interface Codec {
  decode(bytes: Buffer): string;
  encode(text: string): Buffer;
  /** Имя кодировки как его объявила часть письма — для сообщений об отказе. */
  charset: string;
  utf8: boolean;
}

interface Context {
  salt: string;
  stats: AnonymizeStats;
  memo: Map<string, string>;
  marks: string[];
  serials: readonly string[];
  hosts: readonly string[];
  domains: readonly string[];
  /** Какие из перечисленных руками значений хоть раз сработали. */
  applied: Set<string>;
  /** Весь обезличенный текст письма в открытом виде — по нему проверяется, что улик не осталось. */
  cleaned: string[];
}

function createContext(options: AnonymizeOptions): Context {
  return {
    salt: options.salt ?? DEFAULT_SALT,
    stats: {
      emails: 0,
      serials: 0,
      distinctSerials: 0,
      hosts: 0,
      ips: 0,
      ipv6: 0,
      macs: 0,
      names: 0,
      encodedWords: 0,
      recodedParts: 0,
    },
    memo: new Map(),
    marks: [],
    serials: options.serials ?? [],
    hosts: options.hosts ?? [],
    domains: options.domains ?? [],
    applied: new Set(),
    cleaned: [],
  };
}

/* ------------------------------------------------------------------ подмена */

function mark(ctx: Context, value: string): string {
  let index = ctx.marks.indexOf(value);
  if (index < 0) {
    ctx.marks.push(value);
    index = ctx.marks.length - 1;
  }
  if (index >= MARK_LIMIT) {
    throw new AnonymizeRefusal(`подмен больше ${MARK_LIMIT}: письмо для скрипта слишком велико`);
  }
  return `${MARK_OPEN}${String.fromCodePoint(MARK_BASE + index)}${MARK_CLOSE}`;
}

/**
 * Метки разворачиваются до последней, а не одним проходом: подмена может содержать метку внутри
 * себя. Так бывает штатно — имя аппарата, снятое списком `--host`, входит потом в состав хоста
 * `<имя>.corp.local`, и его метка уезжает внутрь подмены этого хоста. Одиночный проход оставил бы
 * в тексте половину метки, а дальше её встретил бы кодировщик части — и письмо получило бы отказ
 * из-за знака, которого в нём нет.
 */
function reveal(ctx: Context, text: string): string {
  let out = text;
  for (let pass = 0; pass < 8 && out.includes(MARK_OPEN); pass += 1) {
    out = out.replace(
      MARKED,
      (_whole, ch: string) => ctx.marks[(ch.codePointAt(0) ?? 0) - MARK_BASE] ?? '',
    );
  }
  if (out.includes(MARK_OPEN)) {
    throw new AnonymizeRefusal('метки подмены вложены слишком глубоко: письмо не обезличено');
  }
  return out;
}

function shapeOnce(salt: string, kind: string, source: string, round: number): string {
  const digest = createHash('sha256')
    .update(`${salt} ${kind} ${round} ${source.toLowerCase()}`)
    .digest();
  let taken = 0;
  const pick = (alphabet: string): string => {
    const byte = digest[taken++ % digest.length] ?? 0;
    return alphabet[byte % alphabet.length] ?? alphabet[0]!;
  };
  return [...source]
    .map((ch) => {
      if (ch >= '0' && ch <= '9') return pick(DIGITS);
      if (ch >= 'a' && ch <= 'z') return pick(LOWER);
      if (ch >= 'A' && ch <= 'Z') return pick(UPPER);
      // Буква вне ASCII меняется на кириллическую того же регистра: иначе знак-двойник цифры
      // (`V5О85400123`) остался бы в файле куском настоящего номера.
      if (/\p{Lu}/u.test(ch)) return pick(CYRILLIC_UPPER);
      if (/\p{Ll}/u.test(ch)) return pick(CYRILLIC_LOWER);
      // Разделители (`-`, `.`, `_`, `/`, пробел) и метки остаются на месте: они и есть форма.
      return ch;
    })
    .join('');
}

/**
 * Вымышленное значение той же формы. Хеш берётся от значения в нижнем регистре — резолв сравнивает
 * серийники нормализованной формой (`upper(btrim(...))`, §6), и `V508…`/`v508…` обязаны остаться
 * одним аппаратом, а не стать двумя.
 */
function shaped(ctx: Context, kind: string, source: string): string {
  const key = `${kind} ${source}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit;
  let value = source;
  // Совпадение с оригиналом маловероятно, но «заменено» обязано означать «отличается».
  for (let round = 0; round < 8 && value === source; round += 1) {
    value = shapeOnce(ctx.salt, kind, source, round);
  }
  ctx.memo.set(key, value);
  return value;
}

/** Уже вымышленное имя — только `example.*` (RFC 2606); прочие зоны чистятся как живые. */
function isExampleDomain(domain: string): boolean {
  return /(^|\.)example(\.|$)/iu.test(domain);
}

function fakeEmail(ctx: Context, address: string): string {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (isExampleDomain(domain)) return address;
  ctx.stats.emails += 1;
  return mark(ctx, `${shaped(ctx, 'local', local)}@${SAFE_DOMAIN}`);
}

function fakeHost(ctx: Context, host: string): string {
  const bare = host.replace(/\.$/u, '');
  if (isExampleDomain(bare)) return host;
  ctx.stats.hosts += 1;
  const labels = bare.split('.');
  if (labels.length === 1) return mark(ctx, shaped(ctx, 'host', bare));
  // Метки подменяются поимённо: одно и то же внутреннее имя в разных хостах остаётся одним именем.
  const head = labels
    .slice(0, -1)
    .map((label) => shaped(ctx, 'host', label))
    .join('.');
  return mark(ctx, `${head}.${SAFE_DOMAIN}`);
}

function fakeIp(ctx: Context, ip: string): string {
  ctx.stats.ips += 1;
  const digest = createHash('sha256').update(`${ctx.salt} ip ${ip}`).digest();
  return mark(ctx, `${SAFE_IP_PREFIX}${((digest[0] ?? 0) % 254) + 1}`);
}

/**
 * IPv6 с сохранением формы: число групп и сжатие `::` остаются как были, меняются значения, а два
 * первых хекстета становятся документационной сетью `2001:db8::/32`.
 */
function fakeIpv6(ctx: Context, address: string): string {
  ctx.stats.ipv6 += 1;
  const digest = createHash('sha256').update(`${ctx.salt}\u0000ipv6\u0000${address}`).digest();
  let taken = 0;
  const hextet = (length: number): string => {
    const value =
      ((digest[taken++ % digest.length] ?? 0) << 8) | (digest[taken++ % digest.length] ?? 0);
    return value.toString(16).padStart(4, '0').slice(-Math.max(1, length));
  };
  const [left, right] = address.includes('::') ? address.split('::') : [address, undefined];
  const leftGroups = (left ?? '').split(':').filter((group) => group !== '');
  /*
   * Два первых хекстета адреса обязаны стать `2001:db8` — иначе подмена уезжает не в
   * документационную сеть. У короткой записи (`fe80::1`) их меньше двух, поэтому они дописываются:
   * группой больше, зато адрес остаётся адресом и лежит там, где положено.
   */
  const head = [...SAFE_IPV6_PREFIX, ...leftGroups.slice(2).map((group) => hextet(group.length))];
  if (right === undefined) return mark(ctx, head.join(':'));
  const tail = right
    .split(':')
    .filter((group) => group !== '')
    .map((group) => hextet(group.length));
  return mark(ctx, `${head.join(':')}::${tail.join(':')}`);
}

function fakeMac(ctx: Context, address: string): string {
  ctx.stats.macs += 1;
  const separator = address.includes('-') ? '-' : ':';
  const digest = createHash('sha256').update(`${ctx.salt} mac ${address}`).digest();
  const tail = (digest[0] ?? 0).toString(16).padStart(2, '0');
  const upper = address === address.toUpperCase();
  const value = [...SAFE_MAC_PREFIX, tail].join(separator);
  return mark(ctx, upper ? value.toUpperCase() : value.toLowerCase());
}

function fakeSerial(ctx: Context, serial: string): string {
  const before = ctx.memo.size;
  const value = shaped(ctx, 'serial', serial.toUpperCase());
  if (ctx.memo.size > before) ctx.stats.distinctSerials += 1;
  ctx.stats.serials += 1;
  // Регистр возвращается исходный: профиль вендора ищет номер шаблоном поля, а не по-словарному.
  return mark(ctx, serial === serial.toLowerCase() ? value.toLowerCase() : value);
}

function pseudonym(ctx: Context, phrase: string): string {
  ctx.stats.names += 1;
  const digest = createHash('sha256').update(`${ctx.salt} name ${phrase}`).digest();
  return mark(ctx, `"user-${digest.toString('hex').slice(0, 8)}"`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/* ------------------------------------------------------------------ правила */

/**
 * Замены, законные в любом месте письма: и в заголовках, и в теле любой части.
 *
 * Порядок начинается с перечисленного руками — это требование, а не вкус. Правило по подписи
 * поля, отработав первым, отдавало бы список `--serial` уже испорченному тексту: номер с пробелом
 * (`C1460 400123`) обрезан по первой группе, перечисленное значение не находится, и код возврата
 * остаётся нулевым. Дальше порядок не хрупок: каждая замена уезжает меткой и повторно не ловится.
 */
function anonymizeText(ctx: Context, text: string): string {
  let out = text;

  for (const serial of ctx.serials) {
    out = out.replace(new RegExp(escapeRegExp(serial), 'giu'), (found) => {
      ctx.applied.add(serial);
      return fakeSerial(ctx, found);
    });
  }
  for (const host of ctx.hosts) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`, 'giu'), (found) => {
      ctx.applied.add(host);
      return fakeHost(ctx, found);
    });
  }
  for (const domain of ctx.domains) {
    // Домен заказчика вместе с любыми поддоменами: он стоит и в URL, и в обратной зоне `Received`,
    // и в адресе, чью локальную часть правило адресов снимет следом по метке домена.
    out = out.replace(
      new RegExp(`(?<![\\w.-])(?:[\\p{L}\\d-]+\\.)*${escapeRegExp(domain)}(?![\\w-])`, 'giu'),
      (found) => {
        ctx.applied.add(domain);
        return fakeHost(ctx, found);
      },
    );
  }

  out = out.replace(URL_USERINFO, (userinfo) => mark(ctx, shaped(ctx, 'local', userinfo)));
  out = out.replace(EMAIL, (address) => fakeEmail(ctx, address));
  out = out.replace(INTERNAL_HOST, (host) => fakeHost(ctx, host));
  out = out.replace(SERIAL_LABEL, (whole, label: string, value: string) => {
    const [head, tail] = value.split(' ');
    // Группа после пробела остаётся только с цифрой: иначе это уже следующее слово.
    const serial = tail !== undefined && !/\d/u.test(tail) ? (head ?? '') : value;
    if (!/\d/u.test(serial)) return whole;
    return `${label}${fakeSerial(ctx, serial)}${serial === value ? '' : value.slice(serial.length)}`;
  });
  out = out.replace(HOST_LABEL, (whole, label: string, value: string) =>
    isExampleDomain(value) ? whole : `${label}${fakeHost(ctx, value)}`,
  );
  out = out.replace(MAC, (address) => fakeMac(ctx, address));
  out = out.replace(IPV6, (address) => fakeIpv6(ctx, address));
  out = out.replace(IPV4, (whole, ...octets: string[]) =>
    octets.slice(0, 4).every((octet) => Number(octet) <= 255) ? fakeIp(ctx, whole) : whole,
  );

  const done = reveal(ctx, out);
  ctx.cleaned.push(done);
  return done;
}

/** Деление списка адресов по запятым вне кавычек и вне угловых скобок. */
function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angled = true;
    if (!quoted && ch === '>') angled = false;
    if (ch === ',' && !quoted && !angled) {
      entries.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  entries.push(current);
  return entries;
}

/**
 * Отображаемое имя в адресном заголовке — это фамилия сотрудника, и она такая же улика, как адрес.
 *
 * Значение разбирается списком, а не заглядыванием вперёд на `<`: `Кузнецова Ольга<адрес>` пишется
 * без пробела, а `Petrov, "Иванов" <адрес>` читался бы как начало следующего адреса — в обоих
 * случаях адрес подменялся, фамилия оставалась, и строка выглядела обезличенной.
 */
function maskAddressList(ctx: Context, value: string): string {
  return splitAddressList(value)
    .map((entry) => {
      const at = entry.indexOf('<');
      if (at >= 0) {
        const phrase = entry.slice(0, at).trim();
        return phrase === '' ? entry : ` ${pseudonym(ctx, phrase)} ${entry.slice(at)}`;
      }
      // Обрывок без скобок и без собаки — это тоже отображаемое имя, просто с запятой внутри.
      if (!entry.includes('@') && entry.trim() !== '') return ` ${pseudonym(ctx, entry.trim())}`;
      return entry;
    })
    .join(',');
}

function maskReceived(ctx: Context, value: string): string {
  const host = (name: string): string =>
    HOST_PLACEHOLDERS.has(name.toLowerCase()) ? name : fakeHost(ctx, name);
  return (
    value
      .replace(
        /\b(from|by)\s+([\p{L}\d][\p{L}\d._-]*[\p{L}\d])/giu,
        (_whole, keyword: string, name: string) => `${keyword} ${host(name)}`,
      )
      // Имя из обратной зоны стоит в скобках перед адресом: `from mfp (reverse.name [10.0.0.1])`.
      .replace(
        /\(([\p{L}\d][\p{L}\d._-]*[\p{L}\d])(\s*\[)/gu,
        (_whole, name: string, tail: string) => `(${host(name)}${tail}`,
      )
  );
}

/* -------------------------------------------------------------- кодировки */

function charsetKey(raw: string | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/gu, '');
}

/**
 * Кодек части письма. Раскодирование берётся у разборщика (`decodeText` знает синонимы вида
 * `cp1251`), а обратная таблица строится тем же `decodeText` из всех 256 байтов: `TextEncoder` в
 * node умеет только UTF-8, а часть обязана уехать в той же кодировке, в какой пришла.
 *
 * Здесь же — единственное место, где скрипт отказывается из-за кодировки. Прежняя редакция на
 * незнакомой кодировке молча пропускала часть целиком (и адрес в `windows-1251` уезжал живым),
 * а на попытке прочитать её как UTF-8 — превращала кириллицу в U+FFFD, то есть портила фикстуру.
 * Оба исхода тихие, поэтому теперь это отказ.
 */
function codecFor(charset: string | undefined): Codec {
  const key = charsetKey(charset);
  if (UTF8_NAMES.has(key)) {
    return {
      charset: key === '' ? 'utf-8' : key,
      utf8: true,
      decode: (bytes) => decodeText(bytes, 'utf-8'),
      encode: (text) => Buffer.from(text, 'utf8'),
    };
  }
  const table = [
    ...decodeText(Buffer.from(Array.from({ length: 256 }, (_unused, index) => index)), key),
  ];
  // Однобайтовая кодировка описывает все 256 байтов. Незнакомое имя `decodeText` читает как UTF-8,
  // и таблица приходит с U+FFFD — именно так распознаётся «кодировку я не знаю».
  if (table.length !== 256 || table.includes('�')) {
    throw new AnonymizeRefusal(
      `кодировка «${key}» обезличивателю неизвестна: письмо не обезличено`,
    );
  }
  const reverse = new Map(table.map((ch, index) => [ch, index]));
  return {
    charset: key,
    utf8: false,
    decode: (bytes) => decodeText(bytes, key),
    encode: (text) =>
      Buffer.from(
        [...text].map((ch) => {
          const byte = reverse.get(ch);
          if (byte === undefined) {
            throw new AnonymizeRefusal(
              `знак «${ch}» не кодируется в «${key}»: письмо не обезличено`,
            );
          }
          return byte;
        }),
      ),
  };
}

export function decodeQuotedPrintable(text: string): Buffer {
  const source = text.replace(/=\n/gu, '');
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const hex = source.slice(i + 1, i + 3);
    if (source[i] === '=' && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push((source.charCodeAt(i) ?? 0) & 0xff);
  }
  return Buffer.from(bytes);
}

export function encodeQuotedPrintable(bytes: Buffer): string {
  const lines: string[] = [];
  let line = '';
  // Хвостовой пробел на строке теряется при пересылке — кодируется всегда.
  const seal = (value: string): string =>
    value.replace(/[ \t]$/u, (ch) => (ch === ' ' ? '=20' : '=09'));
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(seal(line));
      line = '';
      continue;
    }
    const printable = (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9;
    const token = printable
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line.length + token.length > 75) {
      lines.push(`${line}=`);
      line = '';
    }
    line += token;
  }
  lines.push(seal(line));
  return lines.join('\n');
}

function wrapBase64(bytes: Buffer): string {
  return (bytes.toString('base64').match(/.{1,76}/gu) ?? []).join('\n');
}

/* ---------------------------------------------------------------- заголовки */

/** Значение параметра MIME как quoted-string или токена: `boundary="=_part 1"` законен. */
function mimeParam(header: string, name: string): string | undefined {
  const found = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'iu').exec(header);
  if (!found) return undefined;
  return found[1] ?? found[2];
}

/** Поля блока заголовков со своими продолжениями: свёрнутая строка остаётся при своём поле. */
function splitHeaderFields(block: string): string[] {
  const fields: string[] = [];
  for (const line of block.split('\n')) {
    if (/^[ \t]/u.test(line) && fields.length > 0) {
      fields[fields.length - 1] += `\n${line}`;
      continue;
    }
    fields.push(line);
  }
  return fields;
}

function unfold(value: string): string {
  return value.replace(/\n[ \t]+/gu, ' ');
}

/**
 * Значение заголовка обратно в строку. Неascii уезжает **одним** `encoded-word` в UTF-8: письмо
 * после обезличивания обязано остаться письмом, а `Subject` с сырой кириллицей им не является.
 */
function encodeHeaderValue(value: string): string {
  if (!/[^ -~]/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Параметр RFC 2231: процентная запись раскрывается, чистится и складывается обратно в UTF-8. */
function maskParams2231(ctx: Context, value: string): string {
  return value.replace(
    PARAM_2231,
    (whole, name: string, charset: string, language: string, payload: string) => {
      const bytes = Buffer.from(
        payload.replace(/%([0-9A-Fa-f]{2})/gu, (_m, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
        'latin1',
      );
      let text: string;
      try {
        text = codecFor(charset).decode(bytes);
      } catch {
        return whole;
      }
      const cleaned = anonymizeText(ctx, text);
      const encoded = [...Buffer.from(cleaned, 'utf8')]
        .map((byte) =>
          /[A-Za-z0-9!#$&+^_`{}~.-]/u.test(String.fromCharCode(byte))
            ? String.fromCharCode(byte)
            : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
        )
        .join('');
      return `${name}*=utf-8'${language}'${encoded}`;
    },
  );
}

/**
 * Восьмибитный заголовок, написанный сырыми байтами в нарушение RFC 5322 (прошивки так делают).
 * Раскрывается только строгий UTF-8: законный latin1-текст проверку не пройдёт и останется собой.
 */
function recoverRawBytes(latin: string): string | null {
  if (!/[-ÿ]/u.test(latin)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(latin, 'latin1'));
  } catch {
    return null;
  }
}

function anonymizeHeaderBlock(ctx: Context, block: string): string {
  return splitHeaderFields(block)
    .map((field) => {
      const colon = field.indexOf(':');
      if (colon < 0) return field;
      const name = field.slice(0, colon).trim().toLowerCase();
      const rawValue = unfold(field.slice(colon + 1));
      const recovered = recoverRawBytes(rawValue);
      const expanded = decodeEncodedWords(recovered ?? rawValue);
      if (expanded !== rawValue) ctx.stats.encodedWords += 1;

      let value = expanded;
      if (ADDRESS_FIELDS.has(name)) value = maskAddressList(ctx, value);
      if (name === 'received') value = maskReceived(ctx, value);
      if (/\*=/u.test(value)) value = maskParams2231(ctx, value);
      value = anonymizeText(ctx, value);

      // Поле, в котором ничего не менялось, остаётся байт в байт — вместе со своей свёрткой.
      if (value === rawValue) return field;
      // Пробел после двоеточия ставится своим: краевой пробел, уехавший ВНУТРЬ encoded-word, стал
      // бы частью значения — тема письма начиналась бы с пробела у всякого, кто её прочтёт.
      return `${field.slice(0, colon)}: ${encodeHeaderValue(value.trim())}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------- письмо */

function isTextualPart(contentType: string): boolean {
  if (contentType.trim() === '') return true; // Умолчание MIME — `text/plain`.
  return /^\s*(text\/|message\/|application\/(xml|json|xhtml\+xml|rtf|csv))/iu.test(contentType);
}

function anonymizeLeafBody(
  ctx: Context,
  body: string,
  contentType: string,
  encoding: string,
): string {
  // Вложение (картинка, PDF, архив) не трогается вовсе: чистить в нём нечего, а сломать можно всё.
  if (!isTextualPart(contentType)) return body;
  const codec = codecFor(mimeParam(contentType, 'charset'));
  if (!codec.utf8) ctx.stats.recodedParts += 1;
  const trailing = /\n*$/u.exec(body)?.[0] ?? '';
  const payload = body.replace(/\n*$/u, '');
  if (encoding === 'base64') {
    const cleaned = anonymizeText(ctx, codec.decode(Buffer.from(payload, 'base64')));
    return `${wrapBase64(codec.encode(cleaned))}${trailing}`;
  }
  if (encoding === 'quoted-printable') {
    const cleaned = anonymizeText(ctx, codec.decode(decodeQuotedPrintable(payload)));
    return `${encodeQuotedPrintable(codec.encode(cleaned))}${trailing}`;
  }
  // `7bit`, `8bit`, `binary`: байты лежат в письме как есть — и читаются кодировкой части.
  const cleaned = anonymizeText(ctx, codec.decode(Buffer.from(payload, 'latin1')));
  return `${codec.encode(cleaned).toString('latin1')}${trailing}`;
}

function anonymizeMultipart(ctx: Context, body: string, boundary: string): string {
  const chunks: string[] = [];
  let buffered: string[] = [];
  let started = false;
  let seen = 0;
  const flush = (): void => {
    // Пустая пачка строк — это стык двух границ: своей строки у неё нет, и пустой кусок в сборке
    // добавил бы письму перевод строки, которого в оригинале не было.
    if (buffered.length === 0) return;
    const chunk = buffered.join('\n');
    // Преамбула и эпилог письмом не являются — к ним применимы только общие правила.
    chunks.push(started ? anonymizeMessage(ctx, chunk, false) : anonymizeText(ctx, chunk));
    buffered = [];
  };
  for (const line of body.split('\n')) {
    const marker = line.trimEnd();
    if (marker === `--${boundary}` || marker === `--${boundary}--`) {
      flush();
      chunks.push(line);
      started = true;
      seen += 1;
      continue;
    }
    buffered.push(line);
  }
  flush();
  if (seen === 0) {
    /*
     * «multipart объявлен, а маркеров нет» — это «я не понял письмо», и читать это как «письмо
     * простое» нельзя: части не раскодируются, а счётчики покажут почти чистое письмо.
     */
    throw new AnonymizeRefusal(`граница «${boundary}» в теле не встретилась: письмо не обезличено`);
  }
  return chunks.join('\n');
}

/** Письмо или часть письма: заголовки, затем тело — своё у каждой ветви MIME. */
function anonymizeMessage(ctx: Context, message: string, top: boolean): string {
  const split = message.indexOf('\n\n');
  if (split < 0) return anonymizeHeaderBlock(ctx, message);
  const block = message.slice(0, split);
  const body = message.slice(split + 2);
  const contentType = unfold(
    /^content-type\s*:(.*(?:\n[ \t].*)*)/imu.exec(block)?.[1] ?? '',
  ).trim();
  const encoding = unfold(
    /^content-transfer-encoding\s*:(.*(?:\n[ \t].*)*)/imu.exec(block)?.[1] ?? '',
  )
    .trim()
    .toLowerCase();
  const multipart = /^\s*multipart\//iu.test(contentType);
  const boundary = mimeParam(contentType, 'boundary');
  if (multipart && (boundary === undefined || boundary === '')) {
    throw new AnonymizeRefusal(
      'тип multipart объявлен, а граница не разобралась: письмо не обезличено',
    );
  }
  const outBody =
    multipart && boundary !== undefined
      ? anonymizeMultipart(ctx, body, boundary)
      : anonymizeLeafBody(ctx, body, contentType, encoding);
  const outBlock = anonymizeHeaderBlock(ctx, block);
  const marked = top ? `${MARKER_FIELD}: ${MARKER_VALUE}\n${outBlock}` : outBlock;
  return `${marked}\n\n${outBody}`;
}

/**
 * Обезличивает письмо целиком. Вход и выход — `Buffer`: чтение строкой в UTF-8 портит байты
 * `windows-1251` ещё до всякой обработки, и фикстура после такого негодна, причём молча.
 */
export function anonymizeEml(raw: Buffer, options: AnonymizeOptions = {}): AnonymizeResult {
  const ctx = createContext(options);
  /*
   * `latin1` — не кодировка письма, а способ держать байты в строке обратимо: структура MIME
   * (границы, имена полей, base64) вся в ASCII, а тело каждой части читается своей кодировкой.
   */
  const latin = raw.toString('latin1');
  const crlf = latin.includes('\r\n');
  const normalized = latin.replace(/\r\n/gu, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  if (
    new RegExp(`^${MARKER_FIELD}\\s*:`, 'imu').test(
      headerEnd < 0 ? normalized : normalized.slice(0, headerEnd),
    )
  ) {
    throw new AnonymizeRefusal(
      `письмо уже обезличено (${MARKER_FIELD}): второй прогон принял бы подмену за улику`,
    );
  }

  const text = anonymizeMessage(ctx, normalized, true);
  const cleaned = ctx.cleaned.join('\n').toLowerCase();
  const explicit = [...ctx.serials, ...ctx.hosts, ...ctx.domains];
  const unapplied = explicit.filter(
    (value) => !ctx.applied.has(value) || cleaned.includes(value.toLowerCase()),
  );
  return {
    output: Buffer.from(crlf ? text.replace(/\n/gu, '\r\n') : text, 'latin1'),
    stats: ctx.stats,
    unapplied,
  };
}

const HELP = `Обезличиватель .eml (решение Р19 плана office-equipment-mail-telemetry-plan.md)

  pnpm --filter @technic/api exec tsx scripts/anonymize-eml.ts <вход.eml> <выход.eml> \\
    [--serial=НОМЕР]... [--host=ИМЯ]... [--domain=ДОМЕН]... [--salt=СОЛЬ]

  --serial=  серийный номер, стоящий в письме без подписи поля (можно повторять)
  --host=    имя аппарата или узла, стоящее голым словом (можно повторять)
  --domain=  домен заказчика: переезжает в example.net всюду, включая URL (можно повторять)
  --salt=    соль подмены; менять только вместе со всем набором фикстур сразу

Коды возврата: 0 — обезличено; 1 — ошибка вызова; 2 — отказ, выход не записан.
`;

const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;

export function runCli(argv: readonly string[]): number {
  const positional: string[] = [];
  const serials: string[] = [];
  const hosts: string[] = [];
  const domains: string[] = [];
  let salt: string | undefined;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (arg.startsWith('--serial=')) serials.push(arg.slice('--serial='.length));
    else if (arg.startsWith('--host=')) hosts.push(arg.slice('--host='.length));
    else if (arg.startsWith('--domain=')) domains.push(arg.slice('--domain='.length));
    else if (arg.startsWith('--salt=')) salt = arg.slice('--salt='.length);
    else if (arg.startsWith('-')) {
      process.stdout.write(`неизвестный ключ: ${arg}\n\n${HELP}`);
      return EXIT_USAGE;
    } else positional.push(arg);
  }
  const [input, output] = positional;
  if (input === undefined || output === undefined) {
    process.stdout.write(HELP);
    return EXIT_USAGE;
  }
  if (resolve(input) === resolve(output)) {
    // Оригинал — единственная улика: затерев его на месте, проверить работу скрипта уже нечем.
    process.stdout.write('выход обязан отличаться от входа: оригинал не переписывается\n');
    return EXIT_USAGE;
  }

  let result: AnonymizeResult;
  try {
    result = anonymizeEml(readFileSync(input), { salt, serials, hosts, domains });
  } catch (error) {
    if (!(error instanceof AnonymizeRefusal)) throw error;
    process.stdout.write(`отказ: ${error.message}\n`);
    return EXIT_REFUSED;
  }
  if (result.unapplied.length > 0) {
    /*
     * Перечисленное руками значение, которое не сработало, — это опечатка оператора, и молчать о
     * ней нельзя: человек считает улику вычищенной, а она в файле.
     */
    process.stdout.write(
      `отказ: не применилось (или осталось в тексте): ${result.unapplied.join(', ')}\n` +
        'проверьте написание значения в письме; выход не записан\n',
    );
    return EXIT_REFUSED;
  }

  const { stats } = result;
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, result.output);
  process.stdout.write(
    `${input} → ${output}\n` +
      `  адреса: ${stats.emails}\n` +
      `  серийные номера: ${stats.serials} (различных ${stats.distinctSerials})\n` +
      `  имена хостов: ${stats.hosts}\n` +
      `  адреса IPv4: ${stats.ips}\n` +
      `  адреса IPv6: ${stats.ipv6}\n` +
      `  адреса MAC: ${stats.macs}\n` +
      `  отображаемые имена: ${stats.names}\n` +
      `  раскрыто заголовков encoded-word: ${stats.encodedWords}\n` +
      `  перекодировано частей не в UTF-8: ${stats.recodedParts}\n`,
  );
  return 0;
}

/*
 * Прогон только из командной строки: сами правила импортирует `test/anonymize-eml.test.ts`.
 */
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  process.exit(runCli(process.argv.slice(2)));
}
