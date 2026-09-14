/**
 * ЕДИНСТВЕННЫЙ каталог системы, которому разрешено знать этот репозиторий.
 *
 * Здесь живёт разбор карты кода `docs/code-map.md` — реестра логических областей портала. Карта
 * написана для человека, и это осознанный выбор: заводить рядом машинный список доменов значило
 * бы получить вторую классификацию того же портала, которая разойдётся с первой при первой же
 * правке. Правило «одно правило — один носитель» здесь исполняется тем, что носитель остаётся
 * один, а система учится его читать.
 *
 * Что разбирается: заголовок раздела — название области; строка «- Домен: `id`» — идентификатор;
 * ссылки в строках состава — пути. Строка без ссылок (например, перечень масок тестов) даёт
 * области название, но не даёт путей — и это правильно: маска `waste-*.db.test.ts` не путь.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { DomainProvider } from '../core/contracts.ts';
import type { Domain } from '../core/types.ts';

/** Строки состава, из которых берутся пути. Прочие («Разделы портала», «Тесты») — не пути. */
const PATH_FIELDS = ['Источник истины', 'API-маршруты', 'Остальной API', 'Web'];
const ADR_FIELD = 'Решения';

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;

function linksOf(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(LINK)) {
    const target = match[1];
    if (target !== undefined && !target.startsWith('http')) out.push(target);
  }
  return out;
}

export interface CodeMapOptions {
  /** Путь к карте относительно корня репозитория. */
  readonly file: string;
}

export function codeMapDomains(options: CodeMapOptions): DomainProvider {
  return {
    id: `карта кода ${options.file}`,
    async load(root: string): Promise<readonly Domain[]> {
      const file = path.join(root, options.file);
      const dir = path.dirname(file);
      const text = readFileSync(file, 'utf8');
      const domains: Domain[] = [];
      let title: string | null = null;
      let id: string | null = null;
      let paths: string[] = [];
      let adr: string[] = [];

      const flush = () => {
        if (title !== null && id !== null) domains.push({ id, title, paths, adr });
        title = null;
        id = null;
        paths = [];
        adr = [];
      };

      for (const raw of text.split('\n')) {
        const heading = /^##\s+(.+?)\s*$/.exec(raw);
        if (heading) {
          flush();
          title = heading[1] ?? null;
          continue;
        }
        if (title === null) continue;
        const field = /^-\s+([^:]+):\s*(.*)$/.exec(raw);
        if (!field) continue;
        const name = (field[1] ?? '').trim();
        const value = field[2] ?? '';
        if (name === 'Домен') {
          id = value.replace(/`/g, '').trim() || null;
          continue;
        }
        const targets = linksOf(value).map((target) =>
          path.relative(root, path.resolve(dir, target)).split(path.sep).join('/'),
        );
        if (PATH_FIELDS.includes(name)) paths.push(...targets);
        else if (name === ADR_FIELD) adr.push(...targets);
      }
      flush();
      return domains;
    },
  };
}
