/**
 * Выжимка решения (ADR) для задания агенту.
 *
 * ЗАЧЕМ ОНА ВООБЩЕ. Система умеет считать, какие решения относятся к области работы, но до сих пор
 * сообщала агенту только их число и ссылки, привязанные к правилам. Ревьюер судил о коде, не зная
 * договорённостей, по которым код написан, — и находил «упрощения», отменяющие решения заказчика.
 * Ссылка на файл делу не помогает: у агента нет обещания, что он его откроет, а в области работы
 * решений бывает под три десятка.
 *
 * ПОЧЕМУ ЭТОТ КАТАЛОГ. Знание про `docs/adr/**` — знание про этот репозиторий, и жить оно обязано
 * рядом с разбором карты кода, а не в `core/**`: ядро не знает, что у проекта вообще есть ADR.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Своего разбора шапки: его ведёт `scripts/lib/docs-navigation.mjs` — один на
 * генератор указателя, проверку документации и теперь на выжимку (ADR 0176, Р2). Две реализации
 * разбора шапки, писавшейся три года и неоднородной, разошлись бы молча: указатель показывал бы
 * одно, задание агенту — другое. Здесь добавлено ровно то, чего у навигации нет и не должно быть, —
 * выбор СУТИ решения.
 *
 * ЧТО СЧИТАЕТСЯ СУТЬЮ (главный вопрос этого файла).
 *
 * Суть — это ведущие утверждения раздела «Решение»/«Решения»: подзаголовки `### Р1. …` и выделенные
 * жирным зачины пунктов (`5. **Разрешение по умолчанию отменено.**`). Собранные подряд, они дают
 * свод правил решения: «право, а не роль, — единица доступа», «маршрут без проверки роняет тест».
 *
 * Выбор проверен по корпусу: у всех 192 решений раздел «Решение(я)» есть, и у всех 192 ведущие
 * утверждения нашлись (183 пишут их жирным, 9 — подзаголовками). Медиана выжимки 453 знака, p90 —
 * 924, максимум 2518.
 *
 * Отвергнуто:
 *
 *   · РЕШЕНИЕ ЦЕЛИКОМ. Медиана раздела 4.2 КБ, максимум 38 КБ; на 28 решений области это 120 КБ —
 *     ровно тот размер, на котором задание перестаёт быть заданием (урок `work-packets/render.ts`).
 *   · ПЕРВЫЙ АБЗАЦ РАЗДЕЛА. Раздел здесь — нумерованный СПИСОК решений, и первый абзац даёт одно
 *     правило из одиннадцати, умалчивая об остальных десяти. Худший вид неполноты: выглядит как
 *     полный ответ.
 *   · ПЕРВЫЕ N ЗНАКОВ. То же самое плюс обрыв на полумысли; а проза после зачина — это обоснование
 *     и история вопроса, то есть ровно то, чего агенту знать не нужно. Ему нужно ПРАВИЛО.
 *
 * Нумерация зачинов сохраняется («5.», «Р1.») намеренно: по ней агент сошлётся на пункт решения
 * так же, как на него ссылаются люди и сообщения коммитов.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizePath } from '../core/paths.ts';

/**
 * Разбор шапки берётся из общего модуля навигации, но он на `.mjs` и без типов, а `tsconfig`
 * системы обслуживания не включает JavaScript. `createRequire` — единственный способ позвать его
 * СИНХРОННО, не заводя второй разбор и не переписывая чужой конфиг: Node >= 22.12 умеет
 * `require()` модуля ESM, а типы его экспорта названы здесь явно — иначе они приехали бы как `any`.
 */
interface DocsNavigationModule {
  readonly headerOf: (text: string) => string;
  readonly fieldsOf: (header: string) => Map<string, string>;
}

interface LegacyDomainsModule {
  readonly LEGACY_DOMAINS: ReadonlyMap<string, readonly string[]>;
}

const requireHere = createRequire(import.meta.url);
const navigation: DocsNavigationModule = requireHere('../../../scripts/lib/docs-navigation.mjs');
const legacy: LegacyDomainsModule = requireHere('../../../scripts/lib/docs-legacy-domains.mjs');

export interface AdrDigest {
  /** Путь от корня репозитория: `docs/adr/0021-permissions-model.md`. */
  readonly path: string;
  readonly number: string;
  readonly title: string;
  /** Как записано в шапке, до первой точки: «Принято», «Принято (реализовано целиком)». */
  readonly status: string;
  readonly domains: readonly string[];
  /** Суть решения в нескольких строках: то, ради чего агенту его показывают. */
  readonly essence: string;
  /**
   * Чего разбор не нашёл или где он пошёл запасным путём. Молчать об этом нельзя: агент обязан
   * отличать «решение говорит так» от «разбор показал первый попавшийся абзац».
   */
  readonly problems: readonly string[];
}

export interface DigestLimits {
  /** Сколько решений показать. Остальные — в `omitted`: соврать числом хуже, чем обрезать. */
  readonly maxAdr: number;
  /** Потолок сути одного решения в знаках. */
  readonly maxCharsEach: number;
}

/** Заголовки раздела, где живут сами решения. Сравнение точное — см. `chooseBody`. */
const DECISION_TITLES = ['решение', 'решения'];
const CONTEXT_TITLE = 'контекст';

/** Потолок строки статуса: шапка иногда продолжает её абзацем про схему и прецеденты. */
const STATUS_LIMIT = 120;

/** Сколько знаков запасного абзаца показывать, когда ведущих утверждений в разделе нет. */
const FALLBACK_LIMIT = 400;

interface Section {
  readonly title: string;
  readonly body: string;
}

/**
 * Разделы второго уровня. Третий уровень (`###`) остаётся внутри тела: подзаголовки и есть ведущие
 * утверждения у той части корпуса, что пишет решения не жирным, а секциями.
 */
function sectionsOf(text: string): readonly Section[] {
  const out: Section[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (title !== null) out.push({ title, body: body.join('\n').trim() });
    body = [];
  };
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1] ?? '';
      continue;
    }
    if (title !== null) body.push(line);
  }
  flush();
  return out;
}

/** Заголовок без оформления и хвостовой пунктуации: сравнивать его иначе нельзя. */
function normalizeTitle(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/[\s.:;,!?]+$/, '')
    .trim()
    .toLowerCase();
}

/** Ссылки читаются агентом как текст: цель ссылки он всё равно не откроет, а скобки мешают. */
function plainText(value: string): string {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Начало блока внутри списка. Нужно потому, что пункты не всегда разделены пустой строкой, а без
 * разделения два правила склеились бы в одно и второе пропало бы вместе со своим зачином.
 */
const LIST_MARKER = /^(?:\d{1,2}[.)]|[-*•]|[РПЭ]\d+[.)])\s+/;

/** Блоки раздела: абзац, пункт списка или подзаголовок. Переносы внутри блока склеены. */
function blocksOf(body: string): readonly string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push(current.join(' ').replace(/\s+/g, ' ').trim());
    current = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (/^#{3,6}\s+/.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (LIST_MARKER.test(line) && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return out;
}

/**
 * Ведущее утверждение блока — или ничего.
 *
 * Жирное принимается только В ЗАЧИНЕ блока: выделение посреди прозы — это ударение внутри
 * обоснования, а не правило. Приняв его, выжимка утонула бы в цитатах из истории вопроса.
 */
function leadOf(block: string): string | null {
  const heading = /^#{3,6}\s+(.+)$/.exec(block);
  if (heading) return plainText(heading[1] ?? '');
  const bold = /^((?:\d{1,2}[.)]\s+)?)\*\*(.+?)\*\*/.exec(block);
  if (bold) return plainText(`${bold[1] ?? ''}${bold[2] ?? ''}`);
  return null;
}

/**
 * Обрезка, которая не рвёт слово.
 *
 * Сначала — по границе строки: лучше показать девять правил целиком, чем десять с половиной.
 * Если целых строк не набирается, режем по пробелу. Обрубок посреди слова читается как опечатка
 * решения, а не как обрезка системой.
 */
function clip(text: string, limit: number): { readonly text: string; readonly clipped: boolean } {
  if (limit <= 0) return { text: '', clipped: text.length > 0 };
  if (text.length <= limit) return { text, clipped: false };
  const head = text.slice(0, limit);
  const byLine = head.lastIndexOf('\n');
  const cut = byLine > 0 ? byLine : head.lastIndexOf(' ');
  const kept = (cut > 0 ? head.slice(0, cut) : head).replace(/[\s,;:—-]+$/, '');
  return { text: `${kept} …`, clipped: true };
}

/**
 * Откуда брать суть, если привычного раздела нет.
 *
 * Лестница честная: сперва «Решение(я)», затем первый раздел, который не «Контекст» (у старых
 * файлов правила бывают названы своим словом — «Граница решения»), затем текст после шапки.
 * Догадок в лестнице нет, и каждая ступень ниже первой называется в `problems`: агент обязан
 * знать, что читает не то, что обычно.
 */
function chooseBody(text: string): { readonly body: string; readonly problem: string | null } {
  const sections = sectionsOf(text);
  const decision = sections.find((section) =>
    DECISION_TITLES.includes(normalizeTitle(section.title)),
  );
  if (decision !== undefined) return { body: decision.body, problem: null };

  const other = sections.find((section) => normalizeTitle(section.title) !== CONTEXT_TITLE);
  if (other !== undefined) {
    return {
      body: other.body,
      problem: `нет раздела «Решение»: суть взята из раздела «${other.title}»`,
    };
  }

  const header = navigation.headerOf(text);
  return {
    body: text.slice(header.length).trim(),
    problem: 'нет ни раздела «Решение», ни других разделов: суть взята из текста после шапки',
  };
}

/** Заголовок решения: строка `# ADR 0021. …`, а при её отсутствии — имя файла. */
function titleOf(text: string, name: string): string {
  const adr = /^#\s+ADR\s+\d{4}\.?\s*(.+)$/m.exec(text);
  if (adr) return plainText(adr[1] ?? '');
  const any = /^#\s+(.+)$/m.exec(text);
  return any ? plainText(any[1] ?? '') : name;
}

/** Статус — первым предложением: дальше идут оговорки про схему и прецеденты, а не сам статус. */
function statusOf(raw: string): string {
  const first = raw.replace(/[*_`]/g, '').split('\n')[0] ?? '';
  const sentence = first.split('. ')[0] ?? '';
  return clip(sentence.trim(), STATUS_LIMIT).text;
}

/**
 * Домены — по тому же правилу двух источников, что и у навигации (ADR 0176, Р3): поле «Домены»
 * шапки либо точная таблица legacy-классификации. Угадывать домен по словам заголовка нельзя:
 * угаданный хуже отсутствующего — он молча уводит агента не в ту область.
 */
function domainsOf(fields: Map<string, string>, name: string): readonly string[] {
  const declared = (fields.get('Домены') ?? '')
    .split(/[,;]/)
    .map((item) => item.replace(/[`*]/g, '').trim())
    .filter((item) => item !== '');
  if (declared.length > 0) return declared;
  return legacy.LEGACY_DOMAINS.get(name) ?? [];
}

/**
 * Выжимка одного решения. `null` — если файла нет или он не решение: списки ссылок приходят из
 * карты кода и политик, и там встречается что угодно, а выдумывать номер решения по имени плана
 * значило бы соврать.
 */
export function readAdrDigest(root: string, file: string): AdrDigest | null {
  const relative = normalizePath(root, file);
  const name = path.basename(relative);
  const number = /^(\d{4})-.+\.md$/.exec(name)?.[1];
  if (number === undefined) return null;

  let text: string;
  try {
    text = readFileSync(path.resolve(root, relative), 'utf8');
  } catch {
    return null;
  }

  const problems: string[] = [];
  const fields = navigation.fieldsOf(navigation.headerOf(text));
  const status = statusOf(fields.get('Статус') ?? '');
  if (status === '') {
    problems.push('в шапке нет поля «Статус»: действует решение или нет — неизвестно');
  }

  const chosen = chooseBody(text);
  if (chosen.problem !== null) problems.push(chosen.problem);

  const blocks = blocksOf(chosen.body);
  const leads = blocks.map(leadOf).filter((lead): lead is string => lead !== null && lead !== '');

  let essence: string;
  if (leads.length > 0) {
    essence = leads.join('\n');
  } else {
    const first = blocks.find((block) => block !== '') ?? '';
    essence = clip(plainText(first), FALLBACK_LIMIT).text;
    problems.push(
      'в разделе нет ни выделенных утверждений, ни подзаголовков: суть взята первым абзацем — это пересказ, а не свод правил',
    );
  }
  if (essence === '') problems.push('суть извлечь не удалось: текста после шапки нет');

  return {
    path: relative,
    number,
    title: titleOf(text, name),
    status,
    domains: domainsOf(fields, name),
    essence,
    problems,
  };
}

/**
 * Выжимки набора решений под потолками задания.
 *
 * ПОРЯДОК ДЕТЕРМИНИРОВАН — по пути, то есть по номеру решения. Порядок входного списка зависит от
 * того, в каком порядке обошли файлы области, и задание, пересобранное на том же дереве, обязано
 * совпасть с прежним дословно: иначе сравнивать два прогона нечем.
 *
 * ПОТОЛОК НЕ МОЛЧИТ. `omitted` возвращается отдельно, чтобы задание сказало «показаны 12 из 28»:
 * усечённый список без счёта прочитывается как полный, и агент уверенно судит о коде, не зная
 * шестнадцати договорённостей.
 */
export function digestMany(
  root: string,
  files: readonly string[],
  limits: DigestLimits,
): { readonly digests: readonly AdrDigest[]; readonly omitted: number } {
  const seen = new Set<string>();
  const all: AdrDigest[] = [];
  for (const file of files) {
    const relative = normalizePath(root, file);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const digest = readAdrDigest(root, file);
    if (digest !== null) all.push(digest);
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const limit = Math.max(0, limits.maxAdr);
  const taken = all.slice(0, limit);
  const digests = taken.map((digest) => {
    const cut = clip(digest.essence, limits.maxCharsEach);
    if (!cut.clipped) return digest;
    return {
      ...digest,
      essence: cut.text,
      problems: [
        ...digest.problems,
        `суть обрезана потолком в ${limits.maxCharsEach} знаков — полный текст в ${digest.path}`,
      ],
    };
  });
  return { digests, omitted: all.length - taken.length };
}
