import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeReceiptPages, receiptDraftFrom, moscowDateKeyOf } from '@technic/contracts';
import type { ReceiptRecognitionResponse } from '@technic/contracts';
import { TicketFileError } from '../ticket-ocr/errors';
import { prepareTicketFile } from '../ticket-ocr/preprocess';
import { createReceiptEngineFrom, readReceiptOcrConfig } from './config';

/**
 * Замер этапа 0 (план `docs/auto-part-receipt-ocr-plan.md`, §12): прогон настоящих счетов через
 * боевой транспорт с печатью того, что модель прочитала, и того, во что это превратится в форме.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН, А НЕ «ВКЛЮЧИМ И ПОСМОТРИМ». Включённый модуль показывает результат
 * механику, и ошибку чтения он примет за свою невнимательность или за плохой скан. Замер же
 * отвечает на вопросы, которые надо задать ДО включения, и первый из них — **читается ли артикул**:
 * это самый мелкий шрифт в таблице, и ошибка в один символ в нём делает значение хуже пустого (по
 * неверному артикулу деталь «находится» неправильной). Второй вопрос — сходится ли сумма строк с
 * напечатанным «Итого»: им ловится пропущенная строка и страница, оставшаяся за кадром.
 *
 * Эталона у замера нет и быть не может: сверяет прочитанное с бумагой человек, глядя на экран
 * рядом со сканом. Поэтому вывод устроен как таблица для чтения глазами, а не как метрика.
 *
 * Ничего не пишется в базу: ни попыток, ни страниц, ни чеков. Считается только то, что называют
 * оператору прокси, и то, что уйдёт в счёт за вызовы.
 *
 * Запуск (переменные — из окружения службы или из `.env.dev`):
 *
 *   set -a; . /etc/technic-portal/prod.env; set +a
 *   pnpm --filter @technic/worker exec tsx src/receipt-ocr/measure.ts <файл|каталог>…
 *
 * Каждый файл — от одного до пяти вызовов (по числу страниц), и каждый оплачен.
 */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf']);

/** Пути прогона: файл берётся как есть, каталог разворачивается в свои сканы (без вложенных). */
async function filesOf(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      out.push(path);
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
        out.push(join(path, entry.name));
      }
    }
  }
  return out.sort();
}

function money(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Строка таблицы: что прочитано и чем это обернётся в форме. */
function printLines(merged: ReceiptRecognitionResponse): void {
  const draft = receiptDraftFrom(merged, moscowDateKeyOf(new Date()));
  console.log(
    `  Шапка: № ${draft.header.documentNumber || '—'} · ${draft.header.purchasedOn || '—'}` +
      `${draft.header.purchasedOnIssue ? ` (${draft.header.purchasedOnIssue})` : ''}` +
      ` · ${draft.header.sellerName || '—'}`,
  );
  console.log(`  Строк: ${draft.lines.length} (прочитано ${draft.notes.recognizedLines})`);
  for (const [i, line] of draft.lines.entries()) {
    const flags = line.issues.length > 0 ? `  ⚠ ${line.issues.join(', ')}` : '';
    console.log(
      `   ${String(i + 1).padStart(3)}. [${(line.article || '—').padEnd(18)}] ` +
        `${line.name.slice(0, 48).padEnd(48)} ${String(line.quantity ?? '—').padStart(4)} ` +
        `${line.unit.padEnd(5)} ${money(line.amount).padStart(12)} ${line.kind}${flags}`,
    );
  }
  // Главная проверка полноты: сумма подставленного против напечатанного «Итого» (Р9).
  const paper = draft.notes.linesTotal;
  const diff = paper === null ? null : Math.round((paper - draft.notes.draftTotal) * 100) / 100;
  console.log(
    `  Итоги: бумага ${money(paper)} · строки ${money(draft.notes.draftTotal)} · ` +
      `расхождение ${diff === null ? '—' : money(diff)}` +
      `${draft.notes.linesTruncated ? ' · таблица оборвана кадром' : ''}` +
      `${draft.notes.droppedLines > 0 ? ` · не влезло в чек: ${draft.notes.droppedLines}` : ''}`,
  );
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Укажите файлы или каталог: tsx src/receipt-ocr/measure.ts <путь>…');
    process.exit(2);
  }

  const cfg = readReceiptOcrConfig();
  // `RECEIPT_OCR_ENABLED` намеренно НЕ проверяется: замер и нужен до включения — он и есть то,
  // чем включение обосновывают. А вот транспорт обязан быть настоящим: `stub` ответил бы выдумкой
  // и создал бы ровно ту уверенность, ради разрушения которой замер затеян.
  if (cfg.mode !== 'proxy') {
    console.error('AI_PROVIDER_MODE=stub: замер без живого прокси бессмысленен');
    process.exit(2);
  }
  const files = await filesOf(paths);
  console.log(`Прокси:      ${cfg.baseUrl}`);
  console.log(`Модель:      ${cfg.model}${cfg.model === 'proxy' ? ' (выбирает прокси)' : ''}`);
  console.log(`Разрешение:  ${cfg.preprocess.maxEdgePx} px по длинной стороне`);
  console.log(`Файлов:      ${files.length}`);
  console.log('');

  const engine = createReceiptEngineFrom(cfg);
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let failures = 0;

  for (const file of files) {
    const buffer = await readFile(file).catch(() => null);
    if (!buffer) {
      console.error(`${basename(file)}: файл не прочитан`);
      continue;
    }
    console.log(`── ${basename(file)} (${(buffer.length / 1024).toFixed(0)} КБ)`);

    let prepared;
    try {
      prepared = await prepareTicketFile(buffer, cfg.preprocess);
    } catch (e) {
      if (e instanceof TicketFileError) {
        console.error(`  отвергнут подготовкой (${e.code}): ${e.reason}`);
        continue;
      }
      throw e;
    }

    const pages: ReceiptRecognitionResponse[] = [];
    const started = Date.now();
    for (const page of prepared.pages) {
      const outcome = await engine.recognize(page, {
        model: cfg.model,
        // Замер всегда идёт мимо дедупа: повтор с тем же ключом вернул бы прошлый ответ, и
        // «посмотрим, что изменилось после правки промпта» показало бы вчерашнее чтение.
        forced: true,
        jobId: `measure-${createHash('sha256').update(`${file}${page.pageNo}${started}`).digest('hex').slice(0, 12)}`,
      });
      calls += 1;
      inputTokens += outcome.meta.inputTokens ?? 0;
      outputTokens += outcome.meta.outputTokens ?? 0;
      if (outcome.status === 'failed') {
        failures += 1;
        console.error(
          `  стр. ${page.pageNo}: ОТКАЗ ${outcome.failure.code} ` +
            `(${outcome.failure.errorClass}/${outcome.failure.errorScope}) — ${outcome.failure.message}`,
        );
        continue;
      }
      pages.push(outcome.response);
    }
    console.log(
      `  страниц ${prepared.pages.length}/${prepared.totalPages} · ${Date.now() - started} мс`,
    );
    if (pages.length > 0) printLines(mergeReceiptPages(pages));
    console.log('');
  }

  console.log('── Итого замера');
  console.log(`Вызовов: ${calls}, из них отказов: ${failures}`);
  console.log(`Токены:  вход ${inputTokens}, выход ${outputTokens}`);
  // Цену в рублях здесь НЕ считаем: тариф зависит от слага каталога и от договора с оператором
  // прокси, и вписанное сюда число устарело бы молча. Токены — то, что можно умножить самому.
}

void main();
