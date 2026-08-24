import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createEngineFrom, preprocessOptionsFrom, readTicketOcrConfig } from './config';
import { prepareTicketFile } from './preprocess';
import { TicketFileError } from './errors';

/**
 * Проба пера для этапа 0 (ADR 0114, план §12): один вызов с картинкой, отвечающий на вопрос, от
 * которого зависит весь модуль, — **пропускает ли прокси мультимодальный `content` и видит ли
 * модель изображение**.
 *
 * Ответ на него нельзя получить чтением документации: скилл прокси описывает `chat/completions`
 * без единого слова о картинках, а вариант A вдобавок не гарантирует мультимодальную модель.
 * Узнать это по боевому контуру тоже нельзя: модель, не увидевшая изображение, честно вернёт
 * `null` по всем полям — то есть будет выглядеть как плохо снятый талон, а не как неверный
 * транспорт.
 *
 * Поэтому здесь тот же путь, что и в бою — подготовка страницы, тот же движок, тот же промпт, —
 * но без базы, очереди и заявки. Ничего не пишется: печатается то, что называют оператору прокси,
 * когда разбираются.
 *
 * Запуск на машине воркера (переменные читаются из окружения службы):
 *
 *   set -a; . /etc/technic-portal/prod.env; set +a
 *   pnpm --filter @technic/worker exec tsx src/ticket-ocr/probe.ts /path/to/talon.jpg
 *
 * Осечка здесь стоит одного вызова к модели — центы. Осечка в бою стоит выката.
 */
async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('Укажите файл: tsx src/ticket-ocr/probe.ts <файл скана>');
    process.exit(2);
  }

  const cfg = readTicketOcrConfig();
  // `TICKET_OCR_ENABLED` намеренно НЕ проверяется: проба и нужна до включения модуля — она и есть
  // то, чем включение проверяют. Транспорт при этом обязан быть настоящим: `stub` ответил бы
  // выдумкой и создал бы ровно ту уверенность, ради разрушения которой проба написана.
  if (cfg.mode !== 'proxy') {
    console.error('AI_PROVIDER_MODE=stub: проба без живого прокси бессмысленна');
    process.exit(2);
  }
  console.log(`Прокси:  ${cfg.baseUrl}`);
  console.log(`Модель:  ${cfg.model}${cfg.model === 'proxy' ? ' (вариант A — выбирает прокси)' : ''}`);

  const buffer = await readFile(path);
  console.log(`Файл:    ${basename(path)}, ${(buffer.length / 1024).toFixed(0)} КБ`);

  let prepared;
  try {
    prepared = await prepareTicketFile(buffer, preprocessOptionsFrom(cfg));
  } catch (e) {
    if (e instanceof TicketFileError) {
      console.error(`Файл отвергнут подготовкой (${e.code}): ${e.reason}`);
      process.exit(1);
    }
    throw e;
  }
  const page = prepared.pages[0];
  if (!page) {
    console.error('В файле не нашлось ни одной страницы');
    process.exit(1);
  }
  console.log(
    `Страниц: ${prepared.totalPages}, пробуем первую: ${page.mediaType}, ` +
      `${(page.buffer.length / 1024).toFixed(0)} КБ, sha256 ${page.sha256.slice(0, 12)}…`,
  );

  const engine = createEngineFrom(cfg);
  const started = Date.now();
  const outcome = await engine.recognize(page, {
    model: cfg.model,
    // Проба всегда идёт мимо дедупа прокси: повтор с тем же ключом вернул бы прошлый ответ, и
    // «проверка после правки настроек» показала бы вчерашнее состояние.
    forced: true,
    jobId: `probe-${createHash('sha256').update(String(started)).digest('hex').slice(0, 12)}`,
  });

  console.log('');
  console.log(`Заняло:  ${Date.now() - started} мс`);
  console.log(`Запрос:  x-request-id ${outcome.meta.requestId}`);
  console.log(`Прокси:  x-proxy-request-id ${outcome.meta.proxyRequestId || '(не назван)'}`);
  console.log(`Биллинг: upstream ${outcome.meta.upstreamRequestId || '(не назван)'}`);
  console.log(`Модель:  отработала ${outcome.meta.modelReported || '(не названа)'}`);
  console.log(`Токены:  вход ${outcome.meta.inputTokens ?? '?'}, выход ${outcome.meta.outputTokens ?? '?'}`);

  if (outcome.status === 'failed') {
    console.log('');
    console.error(`ОТКАЗ ${outcome.failure.code} (${outcome.failure.errorClass}, ${outcome.failure.errorScope})`);
    console.error(outcome.failure.message);
    if (outcome.failure.retryAfterMs != null) {
      console.error(`Прокси просит подождать ${Math.round(outcome.failure.retryAfterMs / 1000)} с`);
    }
    process.exit(1);
  }

  const tickets = outcome.response.tickets;
  console.log('');
  console.log(`Талонов на кадре: ${tickets.length}`);
  for (const [i, ticket] of tickets.entries()) {
    console.log(
      `  ${i + 1}. № ${ticket.number ?? '—'} · ${ticket.issuedOn ?? '—'} · ` +
        `${ticket.volumeM3 ?? '—'} м³ · ${ticket.workKind} · ${ticket.addressRaw ?? '—'}`,
    );
  }
  if (outcome.response.unreadable?.length) {
    console.log(`Не разобрала: ${outcome.response.unreadable.join(', ')}`);
  }

  // Главный вывод пробы — не «сколько талонов», а «видела ли модель картинку». Пустой ответ по
  // всем полям при живом транспорте означает ровно это: `content` не дошёл либо модель текстовая.
  const blind = tickets.length === 0 || tickets.every((t) => !t.number && !t.issuedOn && t.volumeM3 == null);
  console.log('');
  if (blind) {
    console.error(
      'ПУСТО. Транспорт работает, но полей нет ни одного — так выглядит модель, до которой\n' +
        'изображение не дошло (мультимодальный `content` не пропущен прокси либо модель текстовая).\n' +
        'Проверьте на заведомо читаемом скане; если и он пуст — это ответ на главный вопрос этапа 0.',
    );
    process.exit(3);
  }
  console.log('ГОТОВО. Прокси пропускает изображение, модель его видит, ответ разбирается схемой.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
