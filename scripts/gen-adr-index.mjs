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

/** До пяти путей в порядке появления, остальное — счётчиком: строка указателя должна читаться. */
const PATHS_SHOWN = 5;

function build(adrs) {
  const byDomain = new Map(DOMAINS.map((d) => [d, []]));
  const orphans = [];
  for (const adr of adrs) {
    const domains = domainsOf(adr);
    if (domains.length === 0) orphans.push(adr);
    for (const domain of domains) byDomain.get(domain)?.push(adr);
  }

  /** Обратные рёбра: кто отменил и кто изменил это решение. Считаются по прямым полям соседей. */
  const inbound = new Map();
  for (const adr of adrs) {
    for (const rel of adr.relations) {
      const label =
        BACK_LABEL[rel.kind] ??
        (rel.kind === 'cancelled-by' || rel.kind === 'changed-by' ? null : null);
      if (!label) continue;
      const list = inbound.get(rel.id) ?? [];
      if (!list.some((x) => x.id === adr.id && x.label === label)) list.push({ id: adr.id, label });
      inbound.set(rel.id, list);
    }
    // Обратное поле самого решения («Изменён: ADR 0093») — то же ребро, записанное с другой
    // стороны. Дублировать его нельзя: указатель показал бы одну связь дважды.
    for (const rel of adr.relations) {
      if (rel.kind !== 'changed-by' && rel.kind !== 'cancelled-by') continue;
      const label = rel.kind === 'changed-by' ? 'изменён' : 'отменён';
      const list = inbound.get(adr.id) ?? [];
      if (!list.some((x) => x.id === rel.id && x.label === label)) list.push({ id: rel.id, label });
      inbound.set(adr.id, list);
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
    'Как читать строку: номер · заголовок · статус · «изменён/отменён» следующими решениями · ' +
      'миграции · до пяти путей, названных шапкой. **Отменённое решение помечено ⛔** — его текст ' +
      'остаётся правдой о прошлом, но действующим правилом больше не является.',
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
      const back = inbound.get(adr.id) ?? [];
      const cancelled = back.some((b) => b.label === 'отменён');
      const marks = [];
      const byLabel = (label) =>
        back
          .filter((b) => b.label === label)
          .map((b) => b.id)
          .sort();
      if (byLabel('отменён').length > 0) marks.push(`отменён ${byLabel('отменён').join(', ')}`);
      if (byLabel('изменён').length > 0) marks.push(`изменён ${byLabel('изменён').join(', ')}`);
      const migrations = adr.migrations.match(/`\d{4}`/g);
      if (migrations) marks.push(`миграции ${[...new Set(migrations)].join(', ')}`);
      const shown = adr.codePaths.slice(0, PATHS_SHOWN);
      if (shown.length > 0) {
        const rest = adr.codePaths.length - shown.length;
        marks.push(
          `код: ${shown.map((p) => `\`${p}\``).join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`,
        );
      }
      const status = adr.status && adr.status !== 'Принято' ? ` · ${adr.status.toLowerCase()}` : '';
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
      'Решение без источника домена — дефект, а не раздел указателя: его чинит поле «Домены» ' +
        'в шапке либо строка в таблице классификации.',
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
