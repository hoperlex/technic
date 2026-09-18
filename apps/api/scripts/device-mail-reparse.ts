import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db/client';
import { deviceMailMessages, jobs } from '../src/db/schema';
import { JOB_DELETE_S3_OBJECT, JOB_REPARSE_DEVICE_MESSAGE } from '../src/lib/jobs';

/**
 * Пакетное перечитывание накопленных писем аппаратов и уборка их сырья (план
 * `docs/office-equipment-mail-telemetry-plan.md`, Р26 и Р31; шаг выката Э3).
 *
 * ЗАЧЕМ ОН. Э2 выкатывается раньше Э3 и копит письма в `received`: приёмник уже работает, разбора
 * ещё нет. Разобрать их задним числом может только та же задача очереди, что разбирает горячие
 * письма, — своего второго разборщика у прогона нет и быть не должно, иначе накопленное
 * разобралось бы не тем же кодом, каким разбирается свежее. Поэтому прогон ничего не разбирает
 * сам: он ставит задачи и уходит.
 *
 * УБОРКА СЫРЬЯ СТАВИТСЯ КАЖДОЙ СТРОКЕ СО СЛОЖЕННЫМ СЫРЬЁМ — НЕЗАВИСИМО ОТ СТАТУСА (Р31). Это не
 * щедрость отбора, а его суть. Терминальные строки периода Э2 (чужой ящик, битый конверт) сырьё
 * сохранили, но в разбор не идут; правило «ставим задачу при приёме» их уже не догонит, и без этой
 * строки их тела остались бы в хранилище навсегда — а в них внутренние адреса и IP живой сети.
 *
 * СРОК — `max(получено + TTL, сейчас)`. Письмо, принятое сорок дней назад, уезжает немедленно;
 * принятое вчера доживает свои тридцать суток. Взять просто «сейчас плюс TTL» значило бы подарить
 * накопленному ящику второй срок хранения, а «получено плюс TTL» без нижней границы — поставить
 * задачу в прошлое. У писем, которые прогон САМ отправляет в перечитывание, нижняя граница —
 * «сейчас плюс сутки»: иначе обе задачи готовы в один момент, и одна отсрочка перечитывания
 * оставляет письмо без сырья и без снимка (разбор см. у самого расчёта).
 *
 * ПОЧЕМУ УБОРКА НЕ ЕДЕТ ВМЕСТЕ С Э2. Сырьё, удалённое до первого разбора, не оставляет после себя
 * ничего: снимок делает как раз разбор. Выкати Э3 позже, чем через тридцать дней после Э2, — и
 * накопленный ящик стал бы неразбираемым навсегда.
 *
 * Коды возврата: 0 — прогон дошёл до конца, 1 — не разобраны аргументы либо прогон упал.
 *
 * Использование:
 *   pnpm --filter @technic/api device-mail:reparse
 *   pnpm --filter @technic/api device-mail:reparse -- --dry-run
 *   pnpm --filter @technic/api device-mail:reparse -- --status all --batch 500
 */

const EXIT_FAILURE = 1;
/** Пачка: столько строк читается одним запросом и печатается одной строкой прогресса. */
const DEFAULT_BATCH = 200;
/**
 * Срок хранения сырья — из конфигурации портала, а не второй копией из окружения.
 *
 * Прежде здесь стояло своё чтение `process.env` с оговоркой «уедет в конфиг, когда поле появится»:
 * автор писал против дерева, в котором блока `deviceMail` ещё не было. Поле появилось швом, и
 * копия стала ровно тем, от чего предостерегала его же оговорка, — двумя местами для одного срока.
 * Проверку значения делает схема конфигурации на старте, и падает она раньше, чем дойдёт до
 * прогона.
 */
const TTL_DAYS = config.deviceMail.rawTtlDays;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Отборы перечитывания. `received` — то, ради чего прогон написан: накопленное Э2. Остальные два
 * нужны второму запуску, после правки профиля: письмо, не понятое разборщиком, — главный клиент
 * перечитывания, и гонять его руками по одному незачем.
 */
const STATUS_SETS = {
  received: ['received'],
  unparsed: ['received', 'unrecognized', 'failed'],
  all: ['received', 'unrecognized', 'failed', 'unmatched', 'ambiguous', 'parsed'],
} as const;
type StatusSet = keyof typeof STATUS_SETS;

interface Options {
  batch: number;
  statuses: StatusSet;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options | string {
  let batch = DEFAULT_BATCH;
  let statuses: StatusSet = 'received';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Разделитель `pnpm run … -- --flag` доезжает до аргументов отдельным словом: спотыкаться о
    // собственный способ запуска скрипт не должен.
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--batch') {
      const value = Number(argv[i + 1] ?? '');
      if (!Number.isInteger(value) || value <= 0) return 'размер пачки — целое число больше нуля';
      batch = value;
      i += 1;
      continue;
    }
    if (arg === '--status') {
      const value = argv[i + 1] ?? '';
      if (!(value in STATUS_SETS)) {
        return `отбор «${value}» неизвестен: received | unparsed | all`;
      }
      statuses = value as StatusSet;
      i += 1;
      continue;
    }
    return `неизвестный аргумент «${arg}»`;
  }
  return { batch, statuses, dryRun };
}

interface Row {
  id: string;
  status: string;
  rawState: string;
  receivedAt: Date;
  objectKey: string | null;
}

/**
 * Следующая пачка писем с сырьём — по возрастанию `id`, начиная с последнего пройденного.
 *
 * Ключом, а не смещением: прогон идёт минутами, и письма в это время приезжают — смещение
 * пропустило бы ровно столько строк, сколько их появилось.
 *
 * В отборе ТОЛЬКО `raw_state = 'stored'`, и это общий знаменатель обеих работ: перечитывать
 * нечем, если сырья нет (Р26 работает от сырья), и удалять нечего по той же причине.
 */
async function nextBatch(after: string, limit: number): Promise<Row[]> {
  return db
    .select({
      id: deviceMailMessages.id,
      status: deviceMailMessages.status,
      rawState: deviceMailMessages.rawState,
      receivedAt: deviceMailMessages.receivedAt,
      objectKey: deviceMailMessages.s3ObjectKey,
    })
    .from(deviceMailMessages)
    .where(
      and(
        eq(deviceMailMessages.rawState, 'stored'),
        isNotNull(deviceMailMessages.s3ObjectKey),
        after ? gt(deviceMailMessages.id, after) : undefined,
      ),
    )
    .orderBy(asc(deviceMailMessages.id))
    .limit(limit);
}

/**
 * Ключи, на которые задача уже стоит, — ОДНИМ запросом на род, а не вопросом на строку. Повторный
 * прогон (а он будет: сначала вхолостую, потом набело, потом после правки профиля) не обязан
 * плодить дубли, но и сканировать очередь тысячу раз подряд ему незачем: индекса по нагрузке у
 * `jobs` нет, и вопрос на строку превратил бы прогон в квадрат.
 *
 * ГЛУБИНА ОТБОРА У ДВУХ РОДОВ РАЗНАЯ, и это несущее различие.
 *
 * **Уборка сырья — ключ занят задачей ЛЮБОГО статуса, включая `done` и `dead`.** Признак `purged`
 * после успешного удаления объекта не ставит никто: обработчик `delete_s3_object` умеет только
 * удалять, а `purged` пишет лениво лишь перечитывание, наткнувшееся на отсутствующий объект.
 * Значит после первого прогона строка так и читается `stored` с непустым ключом, и второй прогон,
 * считай он живыми одни `pending`, завёл бы новую уборку на уже удалённый объект — и делал бы это
 * каждый раз. На архиве пилота это тысячи мёртвых задач. (Что уборке следует самой двигать
 * `raw_state`, — правка чужого файла и шов оркестратора.)
 *
 * **Перечитывание — только живые статусы** (`pending`, `running`, `failed`): `running` — доли
 * секунды между захватом задачи и работой, `failed` вернётся повтором. Задача, доведённая до
 * `done`, письмо уже перечитала, и новое перечитывание после правки профиля — законная работа,
 * ради которой прогон и запускают второй раз.
 */
async function occupiedJobKeys(
  type: string,
  field: 'messageId' | 'objectKey',
  anyStatus: boolean,
): Promise<Set<string>> {
  const rows = await db
    .select({
      key:
        field === 'messageId'
          ? sql<string>`${jobs.payload}->>'messageId'`
          : sql<string>`${jobs.payload}->>'objectKey'`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        anyStatus ? undefined : inArray(jobs.status, ['pending', 'running', 'failed']),
      ),
    );
  return new Set(
    rows.map((row) => row.key).filter((key): key is string => typeof key === 'string'),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`device-mail:reparse: ${parsed}`);
    process.exit(EXIT_FAILURE);
  }

  const startedAt = Date.now();
  const wanted: readonly string[] = STATUS_SETS[parsed.statuses];
  console.log(
    `device-mail:reparse: отбор перечитывания — ${wanted.join(', ')}; ` +
      `срок хранения сырья — ${TTL_DAYS} сут; пачка — ${parsed.batch}` +
      (parsed.dryRun ? '; ПРОГОН ВХОЛОСТУЮ, задачи не ставятся' : ''),
  );

  const queuedAlready = await occupiedJobKeys(JOB_REPARSE_DEVICE_MESSAGE, 'messageId', false);
  const purgedAlready = await occupiedJobKeys(JOB_DELETE_S3_OBJECT, 'objectKey', true);

  let after = '';
  let seen = 0;
  let queued = 0;
  let queuedSkipped = 0;
  let purges = 0;
  let purgesSkipped = 0;
  for (;;) {
    const batch = await nextBatch(after, parsed.batch);
    if (batch.length === 0) break;
    after = batch[batch.length - 1]!.id;
    seen += batch.length;

    for (const row of batch) {
      // Перечитывание — только выбранным статусам. Уборка — всем: см. шапку, Р31.
      const toReparse = wanted.includes(row.status);
      if (toReparse) {
        if (queuedAlready.has(row.id)) {
          queuedSkipped += 1;
        } else {
          if (!parsed.dryRun) {
            await db.insert(jobs).values({
              type: JOB_REPARSE_DEVICE_MESSAGE,
              payload: { messageId: row.id },
              nextRunAt: new Date(),
            });
          }
          queuedAlready.add(row.id);
          queued += 1;
        }
      }

      const objectKey = row.objectKey;
      if (!objectKey) continue;
      if (purgedAlready.has(objectKey)) {
        purgesSkipped += 1;
        continue;
      }
      /*
       * Срок уборки — `max(получено + TTL, сейчас)` по Р31, но у письма, которое тот же прогон
       * отправил на перечитывание, нижняя граница отодвигается на СУТКИ.
       *
       * Причина. Ровно в том случае, ради которого Р31 и написан, — письмо старше срока хранения, —
       * обе задачи готовы в одну секунду. На счастливом пути перечитывание успевает первым, но
       * одной отсрочки (перезапуск воркера на выкате, 503 от API, недоступное хранилище) хватает,
       * чтобы сырьё уехало раньше, чем разобралось: ни сырья, ни снимка, письмо навсегда в
       * `received`, а перечитывать нечем. Сутки — это запас на выкат, а не на аккуратность.
       */
      const floor = Date.now() + (toReparse ? DAY_MS : 0);
      const due = new Date(Math.max(row.receivedAt.getTime() + TTL_DAYS * DAY_MS, floor));
      if (!parsed.dryRun) {
        await db.insert(jobs).values({
          type: JOB_DELETE_S3_OBJECT,
          payload: { objectKey },
          nextRunAt: due,
        });
      }
      purgedAlready.add(objectKey);
      purges += 1;
    }
    console.log(`  просмотрено ${seen}, последняя пачка — ${batch.length}`);
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `device-mail:reparse: писем с сырьём ${seen}; на перечитывание ${queued}` +
      (queuedSkipped > 0 ? ` (уже стояло ${queuedSkipped})` : '') +
      `; на уборку сырья ${purges}` +
      (purgesSkipped > 0 ? ` (уже стояло ${purgesSkipped})` : '') +
      `; за ${seconds} с`,
  );
}

await main().catch((error: unknown) => {
  console.error(`device-mail:reparse: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_FAILURE);
});
// Явный выход: пул соединений держит цикл событий, и без него прогон, сделавший всё, просто висел
// бы в выкате.
process.exit(0);
