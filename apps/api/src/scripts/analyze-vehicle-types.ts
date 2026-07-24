/**
 * Анализатор типизации ТС (Этап 2). НЕ рантайм-маршрут API — dev/ops-инструмент.
 *
 * Запуск (нужен dev-dep `xlsx`: `pnpm --filter @technic/api add -D xlsx`):
 *   pnpm --filter @technic/api exec tsx src/scripts/analyze-vehicle-types.ts \
 *     "<полный реестр>.xlsx" "<работавшая техника>.xlsx"
 *
 * Полный реестр — лист `Лист_1` (марка/модель/госномер/подтип).
 * Активность — только лист `06.26-06.27`. Самосвалы исключаются до расчёта активности.
 * Скрипт падает, если остаются needs_review/not_found или classified ≠ 93.
 *
 * ВНИМАНИЕ: имена колонок и модельные эвристики (MODEL_RULES) выверяются на реальных
 * файлах — тут они заданы по документированной структуре и подлежат проверке при запуске.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  EXCLUDED_SOURCE_NAME,
  VEHICLE_SOURCE_MAPPINGS,
  VEHICLE_INSTANCE_OVERRIDES,
  VEHICLE_SUBTYPES,
} from '../db/vehicle-classification-data';

const nodeRequire = createRequire(import.meta.url);

interface XlsxModule {
  readFile(path: string): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: {
    sheet_to_json<T = Record<string, unknown>>(ws: unknown, opts?: { defval?: unknown }): T[];
  };
}

const REGISTRY_SHEET = 'Лист_1';
const ACTIVE_SHEET = '06.26-06.27';
const ACTIVE_COL = { vehicle: 'ТС', sourceType: 'Тип ТС' };
const REGISTRY_COL = { name: 'Наименование', brand: 'Марка', plate: 'Регистрационный знак' };

/** Модельные ключи для by_model/by_registry-групп → конечный подтип (дополняется по факту). */
const MODEL_RULES: { includes: string; code: string }[] = [
  { includes: 'ТЕЛЕСКОП', code: 'telescopic_loader' },
  { includes: 'WACKER NEUSON TH', code: 'telescopic_loader' },
  { includes: 'MANITOU', code: 'telescopic_loader' },
  { includes: 'МУСТАНГ', code: 'skid_steer_loader' },
  { includes: 'MUSTANG', code: 'skid_steer_loader' },
  { includes: 'BOBCAT', code: 'skid_steer_loader' },
  { includes: 'БОБКЭТ', code: 'skid_steer_loader' },
  { includes: 'WEIDEMANN', code: 'skid_steer_loader' },
  { includes: 'EVERUN', code: 'skid_steer_loader' },
  { includes: 'LINDE', code: 'forklift' },
  { includes: 'KOMATSU FD', code: 'forklift' },
];

type Status = 'classified' | 'excluded' | 'needs_review' | 'not_found';

interface ResultRow {
  sourceName: string;
  sourceType: string;
  registryMatch: string | null;
  plate: string;
  subtypeCode: string | null;
  method: string;
  status: Status;
  comment: string;
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const normPlate = (s: unknown): string => norm(s).replace(/[^0-9A-ZА-Я]/g, '');

/** Плашка обычно в хвосте строки ТС (…-<буква><цифры><буквы><цифры>). */
function extractPlate(vehicle: string): string {
  const m = norm(vehicle).match(/[А-ЯA-Z]\s*-?\s*\d{3}\s*-?\s*[А-ЯA-Z]{2}\s*-?\s*\d{2,3}\s*$/);
  return normPlate(m ? m[0] : vehicle.split(/[\s-]+/).slice(-3).join(''));
}

const directBySource = new Map(
  VEHICLE_SOURCE_MAPPINGS.filter((m) => !m.requiresInstanceResolution).map((m) => [
    norm(m.sourceName),
    m.targetCode,
  ]),
);
const ambiguousSources = new Set(
  VEHICLE_SOURCE_MAPPINGS.filter((m) => m.requiresInstanceResolution).map((m) => norm(m.sourceName)),
);

function classify(row: {
  sourceName: string;
  sourceType: string;
  plate: string;
  brand: string;
}): { code: string | null; method: string; comment: string } {
  const model = norm(`${row.sourceName} ${row.brand}`);
  // 1. Ручные исправления (по госномеру/модели) — приоритет.
  for (const o of VEHICLE_INSTANCE_OVERRIDES) {
    if (o.match.plate && normPlate(o.match.plate) === row.plate) {
      return { code: o.targetCode, method: 'override:plate', comment: o.comment };
    }
    if (o.match.modelIncludes && model.includes(norm(o.match.modelIncludes))) {
      return { code: o.targetCode, method: 'override:model', comment: o.comment };
    }
  }
  // 2. Однозначный source-mapping.
  const direct = directBySource.get(norm(row.sourceType));
  if (direct) return { code: direct, method: 'mapping:direct', comment: '' };
  // 3. Неоднозначная группа → по модели.
  if (ambiguousSources.has(norm(row.sourceType))) {
    const rule = MODEL_RULES.find((r) => model.includes(r.includes));
    if (rule) return { code: rule.code, method: 'model', comment: '' };
    return { code: null, method: 'needs_review', comment: 'Неоднозначная группа: модель не распознана' };
  }
  return { code: null, method: 'not_found', comment: 'Нет mapping для исходного типа' };
}

function main(): void {
  const [registryPath, activePath] = process.argv.slice(2);
  if (!registryPath || !activePath) {
    throw new Error('Usage: analyze-vehicle-types <registry.xlsx> <worked.xlsx>');
  }
  const XLSX = nodeRequire('xlsx') as XlsxModule;

  const regWb = XLSX.readFile(registryPath);
  const actWb = XLSX.readFile(activePath);
  if (!regWb.SheetNames.includes(REGISTRY_SHEET)) throw new Error(`Нет листа ${REGISTRY_SHEET}`);
  if (!actWb.SheetNames.includes(ACTIVE_SHEET)) throw new Error(`Нет листа ${ACTIVE_SHEET}`);

  const registry = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    regWb.Sheets[REGISTRY_SHEET],
    { defval: '' },
  );
  const active = XLSX.utils.sheet_to_json<Record<string, unknown>>(actWb.Sheets[ACTIVE_SHEET], {
    defval: '',
  });

  for (const c of [ACTIVE_COL.vehicle, ACTIVE_COL.sourceType]) {
    if (active[0] && !(c in active[0])) throw new Error(`В активном листе нет колонки «${c}»`);
  }

  const registryByPlate = new Map<string, Record<string, unknown>>();
  for (const r of registry) registryByPlate.set(normPlate(r[REGISTRY_COL.plate]), r);

  const results: ResultRow[] = [];
  for (const r of active) {
    const vehicle = String(r[ACTIVE_COL.vehicle] ?? '');
    const sourceType = String(r[ACTIVE_COL.sourceType] ?? '');
    if (norm(sourceType) === norm(EXCLUDED_SOURCE_NAME)) {
      results.push({ sourceName: vehicle, sourceType, registryMatch: null, plate: '', subtypeCode: null, method: 'excluded', status: 'excluded', comment: 'Самосвал — модуль вывоза мусора' });
      continue;
    }
    const plate = extractPlate(vehicle);
    const reg = registryByPlate.get(plate);
    const brand = reg ? String(reg[REGISTRY_COL.brand] ?? '') : '';
    const { code, method, comment } = classify({ sourceName: vehicle, sourceType, plate, brand });
    results.push({
      sourceName: vehicle,
      sourceType,
      registryMatch: reg ? String(reg[REGISTRY_COL.name] ?? '') : null,
      plate,
      subtypeCode: code,
      method,
      status: code ? 'classified' : method === 'not_found' ? 'not_found' : 'needs_review',
      comment,
    });
  }

  const by = (s: Status) => results.filter((x) => x.status === s).length;
  const counts: Record<string, number> = {};
  for (const x of results) if (x.status === 'classified' && x.subtypeCode) counts[x.subtypeCode] = (counts[x.subtypeCode] ?? 0) + 1;

  // Сверка фактических counts с утверждёнными (vehicle-classification-data.ts).
  const expected = new Map(
    VEHICLE_SUBTYPES.filter((s) => s.activeCount > 0).map((s) => [s.code, s.activeCount]),
  );
  const countMismatches: string[] = [];
  for (const [code, exp] of expected) {
    if ((counts[code] ?? 0) !== exp) countMismatches.push(`${code}: ожидалось ${exp}, получено ${counts[code] ?? 0}`);
  }
  for (const code of Object.keys(counts)) {
    if (!expected.has(code)) countMismatches.push(`${code}: неожиданный подтип`);
  }

  const summary = {
    sourceRows: results.length,
    excluded: by('excluded'),
    classified: by('classified'),
    needsReview: by('needs_review'),
    notFound: by('not_found'),
    counts,
    countMismatches,
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'vehicle-type-analysis-2026-07.json'), JSON.stringify({ summary, rows: results }, null, 2));
  const md = [
    '# Анализ типизации ТС (2026-07)',
    '',
    `- Строк активного листа: ${summary.sourceRows}`,
    `- Исключено самосвалов: ${summary.excluded}`,
    `- Классифицировано: ${summary.classified}`,
    `- needs_review: ${summary.needsReview}`,
    `- not_found: ${summary.notFound}`,
    '',
    '| Исходное ТС | Тип ТС | Реестр | Госномер | Подтип | Метод | Статус | Коммент |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.sourceName} | ${r.sourceType} | ${r.registryMatch ?? '—'} | ${r.plate} | ${r.subtypeCode ?? '—'} | ${r.method} | ${r.status} | ${r.comment} |`,
    ),
  ].join('\n');
  writeFileSync(join(outDir, 'vehicle-type-analysis-2026-07.md'), `${md}\n`);

  console.log(JSON.stringify(summary, null, 2));
  if (summary.needsReview > 0 || summary.notFound > 0) {
    throw new Error(`Остались needs_review=${summary.needsReview}, not_found=${summary.notFound}`);
  }
  if (summary.classified !== 93 || summary.excluded !== 1) {
    throw new Error(`Ожидалось classified=93, excluded=1; получено ${summary.classified}/${summary.excluded}`);
  }
  if (countMismatches.length > 0) {
    throw new Error(`Расхождение counts по подтипам:\n${countMismatches.join('\n')}`);
  }
  console.log('OK: 93 классифицировано, 1 самосвал исключён, counts сходятся.');
}

main();
