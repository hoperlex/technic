import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converterBudgetMs, PRINT_TIMEOUT_CODE, printTimeoutMessage } from '@technic/contracts';
import { config } from '../config';
import { AppError, err } from '../lib/errors';
import { isClientGone } from '../lib/request-budget';
import { logger } from '../logger';

/**
 * Перевод готового бланка в PDF (ADR 0041, сроки — ADR 0148).
 *
 * Печатать надо тот же бланк, который выгружают: он пришёл из бухгалтерии, и портал не имеет
 * права перерисовывать его своей вёрсткой ради экрана — иначе на бумаге окажутся два разных
 * документа под одним номером. Поэтому печать — это тот же `renderOfficeTemplate`, только
 * доведённый до PDF, а не второй генератор.
 *
 * Переводит LibreOffice, поставленный в образ API. Своего движка здесь нет намеренно: бланк
 * держится на слитых ячейках, рамках, областях печати и подгонке по ширине, и любой самописный
 * рендер начал бы расходиться с оригиналом на первой же правке бухгалтерии.
 *
 * Конвертер — чужая программа на пути HTTP-запроса, и обходятся с ним соответственно: срок берётся
 * из общей лестницы (`PRINT_BUDGET`), работа прекращается вместе с уходом того, кто её просил, а
 * одновременных запусков не больше, чем машина готова вынести. Каждое из трёх правил закрывает
 * свой способ уронить портал печатью, и все три появились по факту (ADR 0148).
 */

/**
 * Профиль пользователя — свой на каждый запуск, во временном каталоге. Общий профиль LibreOffice
 * держит под блокировкой: два одновременных запуска встали бы в очередь, а второй мог бы
 * завершиться молча, ничего не сконвертировав.
 */
function convertArgs(dir: string, inputs: string[]): string[] {
  return [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=file://${join(dir, 'profile')}`,
    '--convert-to',
    'pdf:calc_pdf_Export',
    '--outdir',
    dir,
    ...inputs,
  ];
}

/**
 * Отмена печати тем, кто её просил: человек закрыл окно, обновил страницу или ушёл со связи.
 *
 * Отдельным классом, а не `AppError`: отвечать уже некому — соединения нет, — и ручке нужно
 * отличить этот случай от настоящего отказа, чтобы промолчать вместо записи в аудит и ответа в
 * закрытый сокет.
 */
export class PrintAborted extends Error {
  constructor() {
    super('Печать отменена: запросивший её больше не ждёт');
    this.name = 'PrintAborted';
  }
}

/** Сколько ждать вежливого завершения, прежде чем убивать насмерть. */
const KILL_GRACE_MS = 5_000;

/** Сколько stderr забирать в журнал: конвертер на битом файле сыплет предупреждениями без меры. */
const MAX_CAPTURED_STDERR = 8_000;

type RunOutcome =
  | { kind: 'ok' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; code: number | null; signal: NodeJS.Signals | null; stderr: string };

/**
 * Запуск конвертера под поводком — тем же приёмом, что растеризатор талонов в воркере
 * (`apps/worker/src/ticket-ocr/subprocess.ts`), и по той же причине: чужая программа на пути
 * живого запроса обязана иметь предел, иначе предел появится у портала.
 *
 * `spawn`, а не `execFile` с его опцией `timeout`, ради двух вещей, которых у того нет.
 *
 * Первая — **эскалация**. `execFile` шлёт по сроку один `SIGTERM` и на этом успокаивается;
 * зависший процесс сигнал обработать не обязан, и тогда он остаётся жить, а Node уже отчитался об
 * ошибке. Здесь за вежливым сигналом через `KILL_GRACE_MS` приходит `SIGKILL`.
 *
 * Вторая — **отмена**. Срок и уход клиента прекращают работу одинаково, но означают разное, и
 * различить их обязан тот, кто запускал: наверх уходит `timeout` или `aborted`, а не общее «не
 * получилось».
 *
 * Дерево процессов при этом убивается целиком без особых мер: `/usr/bin/soffice` — оболочка,
 * которая делает `exec` на `oosplash`, а тот держит `soffice.bin` своим потомком и уносит его с
 * собой. Проверено опытом; будь иначе, пришлось бы бить по группе процессов.
 */
function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return resolve({ kind: 'aborted' });

    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let outcome: 'timeout' | 'aborted' | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURED_STDERR) stderr += chunk;
    });

    /** Вежливо, затем насмерть: зависший офис на `SIGTERM` не обязан отвечать. */
    const stop = (why: 'timeout' | 'aborted') => {
      if (outcome) return;
      outcome = why;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const onAbort = () => stop('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (cause) => {
      cleanup();
      reject(cause);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (outcome) return resolve({ kind: outcome });
      if (code === 0) return resolve({ kind: 'ok' });
      resolve({ kind: 'failed', code, signal, stderr: stderr.trim() });
    });
  });
}

/**
 * Пропускник конвертера: сколько печатей идёт одновременно.
 *
 * Зачем он вообще. Один запуск LibreOffice занимает ядро целиком, а у контейнера API нет ни
 * лимита CPU, ни лимита памяти — сколько человек нажало «Печать», столько офисов и поднимется.
 * На VPS, который делят соседние порталы, десяток одновременных печатей выедает машину, и тогда
 * тормозит уже всё подряд: и списки, и сохранение, и сама печать, которая эти запуски породила.
 *
 * Очередь, а не отказ с порога: печать в разгар месяца нажимают вдвоём-втроём одновременно
 * штатно, и сказать второму «занято» значило бы сломать обычную работу ради редкого случая.
 * Ждущий при этом не ждёт бесконечно — над ним висит срок ручки и его собственная отмена.
 */
class GateAbandoned extends Error {}

class ConverterGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /**
   * Причину ожидающий не разбирает — он только перестаёт ждать. Что именно случилось (ушёл
   * человек или истёк срок), решает вызывающий: у него есть и сигнал, и число листов для ответа.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new GateAbandoned();
    if (this.running < this.limit) {
      this.running += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        // Ушедший из очереди не должен занимать место: иначе освободившийся пропуск достанется
        // тому, кого уже нет, а живые подождут ещё круг.
        const at = this.waiting.indexOf(wake);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new GateAbandoned());
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiting.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.running += 1;
    return () => this.release();
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const gate = new ConverterGate(config.print.concurrency);

/**
 * Единственное место, где обрыв работы превращается в ответ. Прерваться печать может дважды — в
 * очереди и под конвертером, — но разговор с человеком от этого не зависит: важно не где именно
 * не хватило времени, а ушёл он или ещё ждёт.
 */
function abandoned(
  signal: AbortSignal | undefined,
  sheets: number,
  where: string,
  timing?: { budgetMs: number; elapsedMs: number },
): never {
  // Журнал обязан различать причины так же, как ответ. Записать уход человека как истёкший срок
  // значило бы отправить будущий разбор искать несуществующую медлительность конвертера.
  if (isClientGone(signal)) {
    logger.info({ sheets, where, ...timing }, 'печать: отменена — запросивший её ушёл');
    throw new PrintAborted();
  }
  logger.warn({ sheets, where, ...timing }, 'печать: не уложились в срок');
  throw err.conflict(printTimeoutMessage(sheets), { code: PRINT_TIMEOUT_CODE });
}

/**
 * Возвращает PDF, собранный из xlsx/ods. Ошибку конвертера наружу не пропускает: человеку нужен
 * ответ «печать не удалась», а причина — в логе, вместе с кодом выхода и stderr.
 */
export async function renderPdf(office: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const [pdf] = await renderPdfBatch([office], signal);
  return pdf!;
}

/**
 * Те же бланки, но пачкой — одним запуском конвертера.
 *
 * Запуск LibreOffice стоит дороже самой конвертации: он поднимает офисный пакет с нуля, и на
 * десяти листах последовательные запуски дали бы десятикратное ожидание там, где хватает одного.
 * Поэтому файлы кладутся в общий каталог и передаются конвертеру списком.
 *
 * Порядок ответа — порядок входа: пачку печатают одним документом, и лист, уехавший на чужое
 * место, разошёлся бы с тем, что человек видел на экране. Имена файлов поэтому нумерованные, а
 * не по номеру бланка: сортировка каталога портала не касается.
 *
 * **Срок — из лестницы (`converterBudgetMs`), а не «столько-то на лист без предела».** Прежде он
 * считался как тридцать секунд, умноженные на число листов, и на полусотне давал двадцать пять
 * минут — вчетверо больше, чем держал nginx. Соединение рвалось, человек повторял печать, а
 * брошенные конвертации продолжали жить на сервере и выедать его. Теперь срок растёт с пачкой, но
 * упирается в потолок, и за потолком стоит осмысленный ответ вместо обрыва.
 */
export async function renderPdfBatch(
  files: readonly Uint8Array[],
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  if (files.length === 0) return [];
  const budgetMs = converterBudgetMs(files.length);
  // Пропуск берётся до временного каталога: ждущему в очереди незачем держать файлы на диске.
  let release: () => void;
  try {
    release = await gate.acquire(signal);
  } catch (cause) {
    if (cause instanceof GateAbandoned) abandoned(signal, files.length, 'очередь конвертера');
    throw cause;
  }
  const names = files.map((_, index) => `blank-${String(index).padStart(3, '0')}`);
  // Каталог заводится ВНУТРИ try, а не до него: `mkdtemp` падает ровно тогда, когда на диске нет
  // места, — и пропуск, взятый строкой выше, остался бы невозвращённым. Очередь после этого сужается
  // навсегда, а после `PRINT_CONCURRENCY` таких отказов печать встаёт совсем. Уборка ниже поэтому
  // тоже проверяет, что каталог вообще успел появиться.
  // Две переменные на один каталог: `created` видит уборка, `dir` — работа. Без второй TypeScript
  // не сужает тип внутри замыканий, а обещать в них «строка» надо по-настоящему.
  let created: string | null = null;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'technic-print-'));
    created = dir;
    await Promise.all(
      files.map((bytes, index) => writeFile(join(dir, `${names[index]!}.xlsx`), bytes)),
    );
    const started = Date.now();
    const outcome = await run(
      config.soffice.bin,
      convertArgs(
        dir,
        names.map((name) => join(dir, `${name}.xlsx`)),
      ),
      { timeoutMs: budgetMs, signal },
    );
    const elapsedMs = Date.now() - started;

    if (outcome.kind === 'aborted' || outcome.kind === 'timeout') {
      // Отдельным кодом отказа, а не общим «не удалось»: не уложиться в срок и упасть — разные
      // события с разными причинами, и лечатся они тоже по-разному.
      abandoned(signal, files.length, 'конвертер', { budgetMs, elapsedMs });
    }
    if (outcome.kind === 'failed') {
      // stderr конвертера — в журнал: без него о причине падения известно ровно ничего, и разбор
      // упирается в повторение случая руками на проде.
      logger.error(
        {
          bin: config.soffice.bin,
          count: files.length,
          code: outcome.code,
          signal: outcome.signal,
          stderr: outcome.stderr,
          elapsedMs,
        },
        'печать: конвертация бланков в PDF',
      );
      throw err.conflict(
        'Не удалось подготовить бланк к печати — выгрузите его файлом и напечатайте из редактора',
      );
    }

    return await Promise.all(
      names.map(async (name) => new Uint8Array(await readFile(join(dir, `${name}.pdf`)))),
    );
  } catch (cause) {
    // Свои отказы уже объяснены выше — заново их не переписываем: иначе «не уложились в срок»
    // превратилось бы в «не удалось подготовить», и совет человеку стал бы неверным.
    if (cause instanceof PrintAborted) throw cause;
    if (cause instanceof AppError) throw cause;
    logger.error(
      { err: cause, bin: config.soffice.bin, count: files.length },
      'печать: конвертация бланков в PDF',
    );
    throw err.conflict(
      'Не удалось подготовить бланк к печати — выгрузите его файлом и напечатайте из редактора',
    );
  } finally {
    // Пропуск возвращается ПЕРВЫМ и безусловно: он нужен следующему печатающему, а уборка чужого
    // каталога до этого никому не срочна.
    release();
    // Каталог уносит с собой и профиль LibreOffice: во временном каталоге ему жить один запуск.
    if (created) await rm(created, { recursive: true, force: true }).catch(() => {});
  }
}
