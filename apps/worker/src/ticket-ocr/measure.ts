import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createEngineFrom, preprocessOptionsFrom, readTicketOcrConfig } from './config';
import { prepareTicketFile } from './preprocess';
import { TicketFileError } from './errors';
import type { RecognitionOutcome } from './engine/types';

/**
 * Замер на пачке сканов (ADR 0114, этап 1 плана).
 *
 * Отличается от пробника (`probe.ts`) не масштабом, а вопросом. Пробник отвечает «работает ли
 * транспорт» — один файл, один вызов, три исхода. Замер отвечает «насколько верно читает выбранная
 * модель» — и для этого нужен именно пакет: на одном талоне не видно ни доли нечитаемых полей, ни
 * поворотов, ни кадров с двумя бланками.
 *
 * Ничего не пишет в базу и не трогает заявки: читает файлы с диска, зовёт тот же движок, что и бой,
 * и складывает ответы в отчёт. Каждый файл — платный вызов (или два, если задана эскалация).
 *
 * Запуск:
 *
 *   set -a; . .env.dev; set +a
 *   pnpm --filter @technic/worker exec tsx src/ticket-ocr/measure.ts /путь/к/сканам отчёт.json
 *
 * Сканы держат ПДн (адреса, госномера, подписи) — каталог с ними в репозитории не место, и отчёт
 * тоже пишется наружу, а не в дерево.
 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf', '.tif', '.tiff']);

interface PageReport {
  pageNo: number;
  sha256: string;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tickets: unknown[];
  unreadable: string[];
  error: string | null;
}

interface FileReport {
  file: string;
  totalPages: number;
  skippedPages: number;
  pages: PageReport[];
  rejected: string | null;
}

function describeTicket(t: Record<string, unknown>): string {
  const v = (key: string): string => {
    const value = t[key];
    return value === null || value === undefined || value === '' ? '—' : String(value);
  };
  return `№ ${v('number')} · ${v('issuedOn')} · ${v('volumeM3')} м³ · ${v('workKind')} · ${v('addressRaw')}`;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const out = process.argv[3];
  if (!dir) {
    console.error('Укажите каталог со сканами: tsx src/ticket-ocr/measure.ts <каталог> [отчёт.json]');
    process.exit(2);
  }
  const cfg = readTicketOcrConfig();
  if (cfg.mode !== 'proxy') {
    console.error('AI_PROVIDER_MODE=stub: замер на заглушке измерял бы генератор случайных чисел');
    process.exit(2);
  }

  const names = (await readdir(dir))
    .filter((name) => IMAGE_EXT.has(extname(name).toLowerCase()))
    .sort();
  if (names.length === 0) {
    console.error(`В ${dir} нет файлов подходящих форматов`);
    process.exit(2);
  }
  console.log(`Файлов: ${names.length}, модель: ${cfg.model}${cfg.escalationModel ? ` + ${cfg.escalationModel}` : ''}\n`);

  const engine = createEngineFrom(cfg);
  const reports: FileReport[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let ticketsFound = 0;
  let failures = 0;

  for (const name of names) {
    const report: FileReport = { file: name, totalPages: 0, skippedPages: 0, pages: [], rejected: null };
    let prepared;
    try {
      prepared = await prepareTicketFile(await readFile(join(dir, name)), preprocessOptionsFrom(cfg));
    } catch (e) {
      report.rejected = e instanceof TicketFileError ? `${e.code}: ${e.reason}` : String(e);
      reports.push(report);
      console.log(`${basename(name)} — ОТВЕРГНУТ подготовкой: ${report.rejected}\n`);
      continue;
    }
    report.totalPages = prepared.totalPages;
    report.skippedPages = prepared.skippedPages;

    for (const page of prepared.pages) {
      const outcome: RecognitionOutcome = await engine.recognize(page, {
        model: cfg.model,
        // Замер всегда идёт мимо дедупа: повтор с тем же ключом вернул бы прошлый ответ, и
        // «перемерили после правки промпта» показало бы вчерашние цифры.
        forced: true,
        jobId: `measure-${Date.now()}-${page.pageNo}`,
      });
      calls += 1;
      inputTokens += outcome.meta.inputTokens ?? 0;
      outputTokens += outcome.meta.outputTokens ?? 0;
      const entry: PageReport = {
        pageNo: page.pageNo,
        sha256: page.sha256,
        model: outcome.meta.modelReported || outcome.meta.model,
        durationMs: outcome.meta.durationMs,
        inputTokens: outcome.meta.inputTokens,
        outputTokens: outcome.meta.outputTokens,
        tickets: [],
        unreadable: [],
        error: null,
      };
      if (outcome.status === 'failed') {
        failures += 1;
        entry.error = `${outcome.failure.code} (${outcome.failure.errorClass}, ${outcome.failure.errorScope}): ${outcome.failure.message}`;
        console.log(`${name}, стр. ${page.pageNo} — ОТКАЗ ${entry.error}`);
      } else {
        entry.tickets = outcome.response.tickets;
        entry.unreadable = [...(outcome.response.unreadable ?? [])];
        ticketsFound += entry.tickets.length;
        const head = `${name}, стр. ${page.pageNo} — талонов ${entry.tickets.length}` +
          (entry.unreadable.length ? `, не прочитано: ${entry.unreadable.join(', ')}` : '') +
          ` (${outcome.meta.durationMs} мс, ${outcome.meta.inputTokens ?? '?'}/${outcome.meta.outputTokens ?? '?'} токенов)`;
        console.log(head);
        for (const ticket of entry.tickets) {
          console.log(`    ${describeTicket(ticket as Record<string, unknown>)}`);
        }
      }
      report.pages.push(entry);
    }
    if (report.skippedPages > 0) {
      console.log(`    (страниц сверх лимита: ${report.skippedPages})`);
    }
    console.log('');
    reports.push(report);
  }

  console.log('── Итог ──');
  console.log(`Файлов: ${reports.length}, вызовов: ${calls}, отказов: ${failures}`);
  console.log(`Талонов найдено: ${ticketsFound}`);
  console.log(`Токенов: вход ${inputTokens}, выход ${outputTokens}`);
  const withTickets = reports.filter((r) => r.pages.some((p) => p.tickets.length > 0)).length;
  console.log(`Файлов, где нашёлся хотя бы один талон: ${withTickets} из ${reports.length}`);
  // Доля страниц, где модель сама призналась, что поле не читается: главный показатель, по
  // которому решают, нужна ли эскалация на старшую модель (Р14).
  const pagesWithUnreadable = reports.flatMap((r) => r.pages).filter((p) => p.unreadable.length > 0).length;
  console.log(`Страниц с непрочитанными полями: ${pagesWithUnreadable}`);

  if (out) {
    await writeFile(out, JSON.stringify({ model: cfg.model, reports }, null, 2), 'utf8');
    console.log(`\nОтчёт: ${out}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
