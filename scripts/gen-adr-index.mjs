#!/usr/bin/env node
/**
 * `pnpm docs:index` — сборка указателя решений `docs/adr/README.md`.
 *
 * ЗАЧЕМ ОН ЛЕЖИТ В GIT, А НЕ СОБИРАЕТСЯ НА ЛЕТУ (план `docs/docs-navigation-plan.md`, Р1). Указатель
 * читают вместо того, чтобы перебирать 176 файлов, — и читают в том числе без запуска сборки. Плата
 * за это одна: файл может отстать от решений, и отставший он вреднее отсутствующего — выглядит
 * достоверным. Поэтому свежесть стережёт `--check` (Р9): побайтовое сравнение с тем, что собралось
 * бы сейчас.
 *
 * ИСТОЧНИК ОДИН — САМИ ADR. Разбор общий с проверкой (`lib/docs-navigation.mjs`, Р2), домены — либо
 * поле «Домены» решения, либо точная таблица `lib/docs-legacy-domains.mjs`; ни одного правила,
 * угадывающего домен по словам, здесь нет (Р3).
 *
 * ПОРЯДОК ЗАДАН ЯВНО — домен по словарю, затем номер числом, затем имя файла. Сортировка по locale
 * дала бы разный файл на разных машинах, и `--check` краснел бы не по делу.
 *
 * ВЫВОД ПРОГОНЯЕТСЯ ЧЕРЕЗ PRETTIER ПЕРЕД ЗАПИСЬЮ (Р9 редакции 3 плана). `.prettierignore` каталог
 * `docs` не покрывает, а `pnpm format` — это `prettier --write .`: он выравнивает markdown-таблицы
 * по столбцам и нормализует маркеры. Без этой строки любой `pnpm format` делал бы `--check`
 * красным, а генератор и prettier переписывали бы файл друг за другом до конца времён. Вариант
 * «внести указатель в `.prettierignore`» отвергнут: файл остаётся однородным с остальными `docs`.
 *
 * РЕЖИМЫ:
 *   node scripts/gen-adr-index.mjs            — записать docs/adr/README.md;
 *   node scripts/gen-adr-index.mjs --check    — сверить и упасть, если файл отстал.
 */
import process from 'node:process';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { DOMAINS, COLLISION_EXCEPTIONS, readAdrs } from './lib/docs-navigation.mjs';
import { LEGACY_DOMAINS } from './lib/docs-legacy-domains.mjs';

const say = (text = '') => process.stdout.write(`${text}\n`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'docs', 'adr', 'README.md');

/** Домены решения: поле шапки либо таблица. Оба сразу — ошибка, и её ловит `check-docs`. */
export function domainsOf(adr) {
  return adr.domains.length > 0 ? adr.domains : (LEGACY_DOMAINS.get(adr.name) ?? []);
}

/**
 * Как называется обратное ребро в строке указателя (Р4). Названия семантические: «отменён» и
 * «изменён» — это вывод о судьбе решения, и делать его можно только из типизированных полей.
 * Нейтральная связь «Связано» обратного ребра не даёт вовсе.
 */
const BACK_LABEL = { cancels: 'отменён', changes: 'изменён' };

/**
 * ⛔ СТАВИТСЯ ТОЛЬКО ПО СОБСТВЕННОМУ СТАТУСУ РЕШЕНИЯ (Р4).
 *
 * Входящее «Отменяет» — не приговор всему документу: ADR 0141 отменяет приём ADR 0053 **в модуле
 * оргтехники**, а в вывозе мусора тот приём работает. Пометить 0053 недействующим целиком значило
 * бы соврать читателю ровно в том месте, ради которого указатель и читают. Область отмены знает
 * только текст решения, поэтому обратное ребро показывается связью с уточнением, а знак ставит
 * автор — полем «Статус».
 */
const CANCELLED_STATUSES = new Set(['Отменено', 'Заменено']);

function build(adrs) {
  const byDomain = new Map(DOMAINS.map((d) => [d, []]));
  const orphans = [];
  for (const adr of adrs) {
    const domains = domainsOf(adr);
    if (domains.length === 0) orphans.push(adr);
    for (const domain of domains) byDomain.get(domain)?.push(adr);
  }

  /**
   * Обратные рёбра: кто отменил и кто изменил это решение. Ключ — ИМЯ ФАЙЛА цели, а не номер:
   * под 0060 и 0085 живут по два решения, и ключ-номер выдавал им общий набор связей.
   */
  const inbound = new Map();
  const ambiguities = new Map();
  const addBack = (targetName, entry) => {
    const list = inbound.get(targetName) ?? [];
    if (!list.some((x) => x.id === entry.id && x.label === entry.label)) list.push(entry);
    inbound.set(targetName, list);
  };
  for (const adr of adrs) {
    for (const rel of adr.relations) {
      // Голый номер занятого дважды номера цель не выбирает: догадка приписала бы связь не тому.
      if (rel.ambiguous || !rel.name) {
        if (rel.ambiguous) {
          const list = ambiguities.get(adr.name) ?? [];
          list.push(rel.id);
          ambiguities.set(adr.name, [...new Set(list)]);
        }
        continue;
      }
      const label = BACK_LABEL[rel.kind];
      if (label) addBack(rel.name, { id: adr.id, label, qualifier: rel.qualifier });
      // Обратное поле самого решения («Изменён: ADR 0093») — то же ребро с другой стороны.
      if (rel.kind === 'changed-by' || rel.kind === 'cancelled-by') {
        addBack(adr.name, {
          id: rel.id,
          label: rel.kind === 'changed-by' ? 'изменён' : 'отменён',
          qualifier: rel.qualifier,
        });
      }
    }
  }

  const lines = [];
  lines.push(
    '<!-- Файл собирается `pnpm docs:index`. Правки руками теряются при следующей сборке. -->',
  );
  lines.push('');
  lines.push('# Решения (ADR): указатель');
  lines.push('');
  lines.push(
    'Собран из шапок самих решений: домен берётся из поля «Домены» либо из точной таблицы ' +
      '`scripts/lib/docs-legacy-domains.mjs`, связи — из полей «Отменяет», «Изменяет», «Уточняет», ' +
      '«Развивает». Источник истины — сам ADR; указатель только показывает, где он лежит и что его ' +
      'касается.',
  );
  lines.push('');
  lines.push(
    'Как читать строку: номер · заголовок · статус · «изменён/отменён» следующими решениями (в ' +
      'скобках — граница, если решение правится не целиком) · миграции · пути, названные областью. ' +
      '**⛔ стоит только у решения, которое само объявило себя отменённым или заменённым.** ' +
      'Входящая связь показывает, кто его правил, но насколько — знает лишь текст самого решения: ' +
      'ADR 0141 отменяет приём ADR 0053 в модуле оргтехники, а в вывозе мусора тот приём работает.',
  );
  lines.push('');
  lines.push(`Решений: ${adrs.length}. Доменов: ${DOMAINS.length}.`);
  lines.push('');

  const collisions = COLLISION_EXCEPTIONS.map((exception) => ({
    exception,
    list: adrs.filter((a) => exception.files.includes(a.name)),
  })).filter((c) => c.list.length > 1);
  if (collisions.length > 0) {
    lines.push('## ⚠ Номера, занятые дважды');
    lines.push('');
    lines.push(
      'Ссылаться на такое решение голым номером нельзя — в ссылке обязан стоять путь к файлу. ' +
        'Перенумерация отклонена: номер решения — исторический идентификатор, и часть ссылок на ' +
        'него лежит в неизменяемых сообщениях коммитов.',
    );
    lines.push('');
    for (const { exception, list } of collisions) {
      lines.push(`- **${exception.id}** (${exception.since}) — ${exception.why}`);
      for (const adr of list) lines.push(`  - [${adr.title}](${adr.name})`);
    }
    lines.push('');
  }

  for (const domain of DOMAINS) {
    const list = byDomain.get(domain) ?? [];
    if (list.length === 0) continue;
    lines.push(`## ${domain} (${list.length})`);
    lines.push('');
    for (const adr of [...list].sort(
      (a, b) => Number(a.id) - Number(b.id) || (a.name < b.name ? -1 : 1),
    )) {
      const back = inbound.get(adr.name) ?? [];
      const marks = [];
      const byLabel = (label) =>
        back
          .filter((b) => b.label === label)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((b) => (b.qualifier ? `${b.id} (${b.qualifier})` : b.id));
      for (const label of ['отменён', 'изменён']) {
        const list = byLabel(label);
        if (list.length > 0) marks.push(`${label} ${list.join(', ')}`);
      }
      const unclear = ambiguities.get(adr.name) ?? [];
      if (unclear.length > 0) {
        marks.push(`связь по голому номеру неоднозначна: ${unclear.join(', ')}`);
      }
      const migrations = adr.migrations.match(/`\d{4}`/g);
      if (migrations) marks.push(`миграции ${[...new Set(migrations)].join(', ')}`);
      // Пути — все, названные «Областью»: обрезка прятала половину ответа на «где это в коде».
      if (adr.regionPaths.length > 0) {
        marks.push(`код: ${adr.regionPaths.map((x) => `\`${x}\``).join(', ')}`);
      }
      const status = adr.status && adr.status !== 'Принято' ? ` · ${adr.status.toLowerCase()}` : '';
      const cancelled = CANCELLED_STATUSES.has(adr.status);
      lines.push(
        `- ${cancelled ? '⛔ ' : ''}[${adr.id}](${adr.name}) — ${adr.title}${status}` +
          `${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`,
      );
    }
    lines.push('');
  }

  if (orphans.length > 0) {
    lines.push('## Без домена');
    lines.push('');
    lines.push(
      'Решение ещё не отнесено ни к одному домену: его чинит поле «Домены» в шапке либо строка ' +
        'в таблице классификации. Пока решение не закоммичено, это замечание, а не ошибка — ' +
        'оно ещё пишется.',
    );
    lines.push('');
    for (const adr of orphans) lines.push(`- [${adr.id}](${adr.name}) — ${adr.title}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Собранный указатель в том виде, в каком он ложится на диск: после prettier (Р9). */
export async function renderIndex(adrs) {
  const raw = build(adrs);
  const config = (await prettier.resolveConfig(INDEX)) ?? {};
  return prettier.format(raw, { ...config, filepath: INDEX });
}

const adrs = readAdrs(ROOT);
const index = await renderIndex(adrs);
if (process.argv.includes('--check')) {
  const current = existsSync(INDEX) ? readFileSync(INDEX, 'utf8') : null;
  if (current === index) {
    say(`Указатель свеж: ${adrs.length} решений.`);
    process.exit(0);
  }
  say(
    current === null
      ? 'Указателя docs/adr/README.md нет — соберите `pnpm docs:index`.'
      : 'Указатель docs/adr/README.md отстал от решений — соберите `pnpm docs:index`.',
  );
  process.exit(1);
}
writeFileSync(INDEX, index);
say(`Указатель собран: ${adrs.length} решений, ${DOMAINS.length} доменов.`);
