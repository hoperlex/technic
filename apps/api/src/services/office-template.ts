import { unzipSync, zipSync } from 'fflate';

/**
 * Подстановка значений в готовый бланк (ADR 0037 п. 10).
 *
 * И xlsx, и ods — это zip с XML внутри. Бланк 4-П верстается один раз в редакторе таблиц, а
 * подстановка правит ровно те байты, где стоят плейсхолдеры: сетка, слитые ячейки, рамки, штампы
 * и области печати остаются нетронутыми. Библиотека, которая читает книгу в объектную модель и
 * пишет заново, гарантий сохранности вёрстки не даёт — а бланк строгой отчётности обязан
 * ложиться на лист ровно так, как его утвердили.
 *
 * Тем же приёмом обслуживаются оба формата: у xlsx текст живёт в `xl/sharedStrings.xml`, у ods —
 * в `content.xml`, и различие сводится к списку частей, которые надо просмотреть.
 */

/** Плейсхолдер бланка: `{{driver_fio}}`. Ключ — латиница, цифры и подчёркивание. */
const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/gi;

/** Нижняя граница времени, которое умеет хранить zip: 1 января 1980 года. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1);

/** Части, где может стоять текст: xlsx хранит строки отдельно, ods — в теле документа. */
const XLSX_PARTS = /^xl\/(sharedStrings\.xml|worksheets\/.+\.xml)$/;
const ODS_PARTS = /^(content|styles)\.xml$/;

export type TemplateValue = string | number | null | undefined;

export interface RenderResult {
  bytes: Uint8Array;
  /** Плейсхолдеры бланка, для которых значения не пришло: напечатаны пустыми. */
  missing: string[];
  /** Значения, которым в бланке нет места: почти всегда опечатка в ключе. */
  unused: string[];
}

/**
 * XML-экранирование. Без него апостроф в фамилии («О'Коннор») или амперсанд в наименовании
 * организации («Иванов & Ко») ломают не значение, а весь документ: редактор объявляет файл
 * повреждённым и не открывает его вовсе.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function toText(value: TemplateValue): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? String(value) : value;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Какие части файла просматривать — по составу архива, а не по расширению имени файла. */
function partsMatcher(files: Record<string, Uint8Array>): RegExp {
  if ('xl/sharedStrings.xml' in files || Object.keys(files).some((n) => n.startsWith('xl/'))) {
    return XLSX_PARTS;
  }
  return ODS_PARTS;
}

/**
 * Плейсхолдеры, которые есть в бланке. Нужен вёрстке и тесту согласованности: разъехавшись со
 * сборщиком значений, шаблон молча напечатает пустую графу вместо СНИЛС — ошибка, которую не
 * ловит ни типизация, ни ревью.
 */
export function inspectTemplate(template: Uint8Array): string[] {
  const files = unzipSync(template);
  const matcher = partsMatcher(files);
  const found = new Set<string>();

  for (const [name, content] of Object.entries(files)) {
    if (!matcher.test(name)) continue;
    const xml = decoder.decode(content);
    for (const match of xml.matchAll(PLACEHOLDER)) found.add(match[1]!.toLowerCase());
  }
  return [...found].sort();
}

/**
 * Подставляет значения и отдаёт готовый файл.
 *
 * Плейсхолдер без значения печатается пустым, а не остаётся `{{...}}` на бланке: незаполненная
 * графа — норма (движение горючего, показания спидометра и отметки заполняют от руки), а
 * фигурные скобки в выданном документе — брак. Что осталось пустым, видно в `missing`.
 */
export function renderOfficeTemplate(
  template: Uint8Array,
  values: Record<string, TemplateValue>,
): RenderResult {
  const files = unzipSync(template);
  const matcher = partsMatcher(files);

  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    normalized.set(key.toLowerCase(), escapeXml(toText(value)));
  }

  const seen = new Set<string>();
  const missing = new Set<string>();
  const out: Record<string, Uint8Array> = {};

  for (const [name, content] of Object.entries(files)) {
    if (!matcher.test(name)) {
      out[name] = content;
      continue;
    }
    const xml = decoder.decode(content);
    const replaced = xml.replace(PLACEHOLDER, (_, rawKey: string) => {
      const key = rawKey.toLowerCase();
      seen.add(key);
      const value = normalized.get(key);
      if (value === undefined) {
        missing.add(key);
        return '';
      }
      return value;
    });
    out[name] = encoder.encode(replaced);
  }

  return {
    // Время фиксировано: одинаковый снимок обязан давать одинаковый файл, иначе повторная выдача
    // того же листа выглядит как другой документ — а на этом держится будущая подпись. Нижняя
    // граница формата zip, а не эпоха Unix: 1970 года он не знает вовсе.
    bytes: zipSync(out, { mtime: ZIP_EPOCH }),
    missing: [...missing].sort(),
    unused: [...normalized.keys()].filter((key) => !seen.has(key)).sort(),
  };
}
