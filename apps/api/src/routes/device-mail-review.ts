import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  decodeDeviceCursor,
  deviceIdentityHintsSchema,
  deviceMailBindSchema,
  DEVICE_IDENTITY_KINDS,
  encodeDeviceCursor,
  equipmentCursorInstantIsExact,
  deviceTelemetryQuerySchema,
  type DeviceErrorCode,
  type DeviceIdentityHints,
  type DeviceMailBindResultDto,
  type DeviceMailQueueDto,
  type DeviceMailQueueItemDto,
  type DeviceMailboxStateDto,
  type DeviceMessageStatus,
  type DeviceProfileCode,
  type DeviceRawState,
} from '@technic/contracts';
import { db } from '../db/client';
import { deviceMailAccounts, deviceMailMessages } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import { bindDeviceMailIdentity, countBindTargets } from '../services/device-mail/apply';
import { reparseDeviceMessage } from '../services/device-mail/intake';

/**
 * ОЧЕРЕДЬ «ПИСЬМА УСТРОЙСТВ» — служебный экран разбора почты аппаратов (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, Р20, Р30, §9.1 п. 7–8).
 *
 * СВОИМ ФАЙЛОМ И СВОИМ АДРЕСОМ, А НЕ ВНУТРИ `/office-equipment/:id/…`. Очередь отвечает на вопрос,
 * у которого карточки ещё НЕТ: «чьё это письмо». Адрес, начинающийся с единицы справочника, обещал
 * бы обратное — что письмо уже приписано аппарату, — и первая же строка `unmatched` этому обещанию
 * противоречила бы. Блок карточки (`office-equipment-telemetry.ts`) живёт по своему адресу и по
 * своему праву, и это не дублирование: у них разные предметы.
 *
 * ПРАВО НА ВСЁ ЗДЕСЬ ОДНО — `officeEquipment.telemetry` (Р30), И НА ЧТЕНИЕ ТОЖЕ. Это служебный
 * экран, а не карточка: строка очереди несёт серийный номер, сетевое имя и адрес отправителя
 * аппарата, которого портал ещё не опознал, — то есть сведения о парке в обход области видимости
 * карточек. Открыть её по `officeEquipment.read` значило бы отдать этот срез всем читателям
 * справочника, и при этом половина из них не смогла бы сделать с ним ничего: действия всё равно
 * закрыты новым правом. Само право объявлено зависящим от `officeEquipment.read`
 * (`PERMISSION_REQUIRES`), поэтому вторым стражем чтение справочника здесь не спрашивается —
 * иначе одно требование жило бы в двух местах.
 *
 * ОБЛАСТЬ ВИДИМОСТИ ЗДЕСЬ НЕ СУЖАЕТСЯ, и это следствие предмета. У непривязанного письма нет ни
 * площадки, ни отдела — оно ещё ничьё; сузить очередь было бы не по чему. Право выдаётся набору
 * ИТ-службы, у которого область по модулю сквозная (`GRANT_MODULE_WIDE_SCOPE`), так что сужение
 * не убрало бы из выдачи ни строки, зато создало бы видимость защиты.
 */

/** Сколько письмо имеет право простоять в `received`, прежде чем попасть в очередь (§9.1, п. 8). */
const STUCK_RECEIVED_AFTER = sql`interval '1 hour'`;

const idParams = z.object({ id: z.string().uuid() });

/**
 * Отбор «на что смотрит человек» — ОДНИМ ВЫРАЖЕНИЕМ на все три ручки, которым он нужен.
 *
 * Четыре исхода разбора плюс две беды приёма:
 *
 * - `unmatched | ambiguous` — письмо принято и разобрано, аппарат не опознан (§6). Это главные
 *   клиенты «привязать»;
 * - `unrecognized | failed` — формат не распознан или разбор упал: сюда приходят за «перечитать»
 *   после правки профиля;
 * - `received` дольше часа — ЗАВИСШЕЕ письмо (Р26): строка заведена, исход не поставлен. Без этой
 *   ветки падение процесса между коммитами приёма не видно нигде;
 * - `ignored` с кодом `stuck` — письмо, закрытое счётчиком застревания (§9.1, п. 7). Иначе его не
 *   видно НИГДЕ: курсор уехал дальше, `last_error` ящика затёрт следующим успехом, и контур,
 *   съевший письмо, выглядит здоровым.
 *
 * И поверх всего — `reviewed_at IS NULL`. У `stuck`-строки нет ни сырья (значит «перечитать»
 * скрыто), ни снимка (значит применять нечего), а «игнорировать» ставит статус, который у неё уже
 * стоит: закрывающий след — ЕДИНСТВЕННЫЙ способ убрать её из очереди. Без него очередь за полгода
 * стала бы списком нерешаемых дел, в котором тонут непривязанные письма — ровно то, ради чего она
 * заведена.
 */
function queueScope(): SQL {
  return and(
    isNull(deviceMailMessages.reviewedAt),
    or(
      sql`${deviceMailMessages.status} IN ('unmatched','ambiguous','unrecognized','failed')`,
      sql`(${deviceMailMessages.status} = 'received'
           AND ${deviceMailMessages.receivedAt} < now() - ${STUCK_RECEIVED_AFTER})`,
      sql`(${deviceMailMessages.status} = 'ignored' AND ${deviceMailMessages.errorCode} = 'stuck')`,
    ),
  )!;
}

/**
 * Отметка времени С ПОЛНОЙ ТОЧНОСТЬЮ БАЗЫ — та же ловушка, что у блоков карточки и у ленты
 * событий. `timestamptz` хранит микросекунды, `Date` в JS заканчивается миллисекундой, и курсор,
 * собранный из `toISOString()`, оказывается МЛАДШЕ строки, которой принадлежит. Пачка писем,
 * прочитанная после паузы, ложится десятками строк в одну миллисекунду приёма — здесь эта ловушка
 * не теоретическая, а обычный вторник.
 */
function exactInstant(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * ФОРМА КУСКОВ КУРСОРА ПРОВЕРЯЕТСЯ ЗДЕСЬ, И ЭТО НЕ ПЕДАНТИЗМ.
 *
 * Кодек контракта отвечает за ЛЕНТУ: он снимает версию, сверяет метку (`device-mail-queue` против
 * `device-events` блока карточки) и убеждается, что куски не пусты. Формата он не знает и знать не
 * должен — метку он стережёт для всех лент разом, а ключ порядка у каждой свой. Но дальше куски
 * уезжают в SQL приведениями `::timestamptz` и `::uuid`, и `1~device-mail-queue~garbage~x` роняет
 * уже сам PostgreSQL: `invalid input syntax for type timestamp with time zone` — то есть `500` и
 * запись в журнал ошибок на ссылку, усечённую при копировании. А ручка рядом сама объявляет честным
 * ответом `422` «откройте заново», и пятисотка ровно там, где обещан внятный отказ, — худший из
 * возможных исходов.
 *
 * Тот же приём и по тому же образцу стоит у ленты событий (`office-equipment-telemetry.ts`,
 * `eventsCursorForm`) и у блоков карточки (`office-equipment-blocks.ts`): форма — часть СХЕМЫ, и
 * разбор чужой строки падает в одном месте и одинаково.
 */
const queueCursorForm = z.object({
  observedAt: z.string().datetime(),
  id: z.string().uuid(),
});

/** `null` — курсор чужой ленты, битый или с неразбираемыми кусками. Ответ один: `422`. */
function readQueueCursor(raw: string): { observedAt: string; id: string } | null {
  const decoded = decodeDeviceCursor('device-mail-queue', raw);
  if (!decoded) return null;
  const parsed = queueCursorForm.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * «Письма СТРОГО ПОЗЖЕ того, на котором остановились» — кортежем, как читается и сортировка.
 *
 * Порядок очереди — ПО ВОЗРАСТАНИЮ приёма, старые сверху, и это не вкус. У списков портала вопрос
 * «что нового», и свежее сверху на него отвечает; у очереди вопрос «чья очередь», и свежее сверху
 * означало бы, что письмо, до которого не дошли руки в первый день, не дождётся разбора никогда —
 * очередь работала бы как стек. Прецедент тот же и по той же причине — очередь кандидатов
 * (`CandidatesTab.tsx`).
 */
function afterCursor(cursor: { observedAt: string; id: string }): SQL {
  const anchor = sql`${cursor.id}::uuid`;
  if (equipmentCursorInstantIsExact(cursor.observedAt)) {
    return sql`(${deviceMailMessages.receivedAt}, ${deviceMailMessages.id})
             > (${cursor.observedAt}::timestamptz, ${anchor})`;
  }
  // Курсор без микросекунд прийти неоткуда — очередь выдаёт только свои, — но граница расширяется
  // осознанно: молча потерять строку хуже, чем один раз её повторить.
  return and(
    sql`${deviceMailMessages.receivedAt} > ${cursor.observedAt}::timestamptz - interval '1 millisecond'`,
    sql`${deviceMailMessages.id} <> ${anchor}`,
  )!;
}

/** Пустые подсказки: снимка нет вовсе (переросток, битый конверт) — это законное состояние. */
const NO_HINTS: DeviceIdentityHints = deviceIdentityHintsSchema.parse({});

/**
 * Подсказки опознания из СНИМКА, а не из сырья (Р20): серийник, инвентарный, имя устройства, узел,
 * IP и модель — всё, чем человек опознаёт аппарат глазами. Сырьё вычищается через тридцать дней, и
 * очередь, читающая подсказки из него, через месяц осталась бы без единой.
 *
 * Снимок не разобрался — отдаём пустые подсказки, а не роняем страницу: одна кривая строка не
 * имеет права закрыть очередь целиком.
 */
function hintsOf(payload: unknown): DeviceIdentityHints {
  if (payload === null || typeof payload !== 'object') return NO_HINTS;
  const identity = (payload as { identity?: unknown }).identity;
  const parsed = deviceIdentityHintsSchema.safeParse(identity ?? {});
  return parsed.success ? parsed.data : NO_HINTS;
}

/**
 * Состояние ящиков в шапке (§9.1, п. 8). ОТДЕЛЬНОЙ СТРОКОЙ, А НЕ ПРИЗНАКОМ ПИСЬМА: письмо может
 * застрять, не дойдя до базы вовсе — тело не принято ни разу, — и своей строки у него нет. Тогда
 * «курсор стоит с такого-то времени, причина» — единственное место, где беда видна.
 *
 * `cursorStuckAt` СЧИТАЕТСЯ ПО СЧЁТЧИКУ, А НЕ ПО ТЕКСТУ ОШИБКИ. Счётчик обнуляется при любом
 * успешном приёме и при сбросе курсора (§9.1, п. 7) — значит `stuck_attempts > 0` означает ровно
 * «голова пачки стоит прямо сейчас». Отметка при этом — момент ПОСЛЕДНЕГО подтверждённого отказа
 * (`updated_at` строки ящика: успешный приём её тоже переписывает, но вместе с обнулением
 * счётчика). Когда именно застревание началось, база не хранит; врать здесь нечем, поэтому
 * отдаётся то, что есть, а название поля уехало предложением к контракту.
 */
async function loadMailboxes(): Promise<DeviceMailboxStateDto[]> {
  const rows = await db
    .select({
      account: deviceMailAccounts.account,
      lastPollAt: deviceMailAccounts.lastPollAt,
      stuckAttempts: deviceMailAccounts.stuckAttempts,
      lastError: deviceMailAccounts.lastError,
      updatedAt: deviceMailAccounts.updatedAt,
    })
    .from(deviceMailAccounts)
    .orderBy(asc(deviceMailAccounts.account));

  return rows.map((row) => ({
    account: row.account,
    lastPollAt: row.lastPollAt?.toISOString() ?? null,
    cursorStuckAt: row.stuckAttempts > 0 ? row.updatedAt.toISOString() : null,
    lastError: row.lastError,
    stuckAttempts: row.stuckAttempts,
  }));
}

/** Строка очереди, на которой нажали. Отдельным чтением: без неё действие било бы вслепую. */
async function requireMessage(
  id: string,
): Promise<{ id: string; status: DeviceMessageStatus; rawState: DeviceRawState }> {
  const [row] = await db
    .select({
      id: deviceMailMessages.id,
      status: deviceMailMessages.status,
      rawState: deviceMailMessages.rawState,
    })
    .from(deviceMailMessages)
    .where(eq(deviceMailMessages.id, id));
  if (!row) throw err.notFound('Письмо аппарата не найдено');
  return row;
}

/**
 * ЕСТЬ ЛИ У СТРОКИ ДРУГОЙ ВЫХОД, КРОМЕ ОТМЕТКИ ПРОСМОТРА.
 *
 * Отметка просмотра НЕОБРАТИМА и не оставляет за собой ничего: списка просмотренных нет, обратной
 * ручки нет, и из очереди строка уходит навсегда. Поэтому она разрешена ровно там, где других
 * выходов не осталось, — и это не осторожность, а цена ошибки:
 *
 * - `unmatched | ambiguous` со снимком — предмет «привязать». Отметь такую просмотренной, и снимок
 *   не попадёт в карточку никогда, а строка при этом ОСТАНЕТСЯ в отборе пачки: `apply.ts` смотрит
 *   на статус, а не на след, — и будущая привязка того же серийника применит её молча, попутно
 *   войдя в «Будет затронуто писем: N», которое человек проверить глазами уже не может;
 * - сохранённое сырьё (`stored`) при любом статусе — предмет «перечитать»: письмо разберётся
 *   заново после правки профиля;
 * - всё остальное — `stuck`, `failed`/`unrecognized`/`received` с вычищенным или не принятым
 *   сырьём — нерешаемо ничем: снимка нет, перечитывать нечем, «игнорировать» поставило бы статус,
 *   который уже стоит. Ровно этим строкам план и даёт закрывающий след.
 *
 * Мусор со снимком закрывается «игнорировать», а не отметкой: оно меняет СТАТУС, и потому выводит
 * письмо и из очереди, и из отбора пачки разом.
 */
export function hasExitBesidesReview(
  status: DeviceMessageStatus,
  rawState: DeviceRawState,
): boolean {
  return status === 'unmatched' || status === 'ambiguous' || rawState === 'stored';
}

/**
 * Отказ слоя применения — словами человеку, а не пятисоткой.
 *
 * `bindDeviceMailIdentity` бросает обычный `Error` с человеческим текстом на двух своих барьерах:
 * карточка не найдена и ключ уже ведёт к другому аппарату. Оба — не поломка портала, а ответ на
 * то, что человек ввёл, и оба обязаны доехать до формы. Разбирается это по приставке, а не по
 * типу: слой применения — общий вход и для будущего коллектора, и заводить в нём свой класс
 * ошибок ради одной ручки было бы правкой чужого файла ради своего удобства.
 */
function bindRefusal(e: unknown): never {
  if (e instanceof Error && e.message.startsWith('привязка: ')) {
    throw err.unprocessable(e.message.slice('привязка: '.length));
  }
  throw e;
}

export default async function deviceMailReviewRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canReview = app.requirePermission('officeEquipment.telemetry');

  /**
   * Очередь и состояние ящиков одним ответом (`DeviceMailQueueDto`).
   *
   * ДВЕ ЧАСТИ В ОДНОЙ РУЧКЕ, потому что они отвечают на один вопрос — «всё ли разобрано». Строк в
   * очереди может не быть вовсе при стоящем курсоре, и разнеси их по двум адресам — экран, забывший
   * спросить второй, показал бы «разобрано всё» ровно в тот день, когда приём умер.
   *
   * ПУСТАЯ ОЧЕРЕДЬ — ЗАКОННЫЙ ОТВЕТ, а не `404` и не ошибка: разобранный ящик выглядит именно так.
   */
  r.get(
    '/queue',
    {
      preHandler: [app.authenticate, canReview],
      schema: { querystring: deviceTelemetryQuerySchema },
    },
    async (req): Promise<DeviceMailQueueDto> => {
      const raw = req.query.cursor;
      const cursor = raw ? readQueueCursor(raw) : null;
      // Отказ, а не молчаливая первая страница: «ссылка не читается — откройте заново» честнее
      // очереди, которая после «показать ещё» начинается сначала.
      if (raw && !cursor) {
        throw err.unprocessable('Ссылка на продолжение очереди не читается — откройте её заново', {
          cursor: 'Некорректный курсор',
        });
      }

      const pageSize = req.query.pageSize;
      const rows = await db
        .select({
          id: deviceMailMessages.id,
          status: deviceMailMessages.status,
          rawState: deviceMailMessages.rawState,
          receivedAt: deviceMailMessages.receivedAt,
          /** Та же отметка с точностью базы — она и уезжает в курсор (см. `exactInstant`). */
          receivedAtCursor: exactInstant(deviceMailMessages.receivedAt),
          deviceTime: deviceMailMessages.deviceTime,
          fromAddress: deviceMailMessages.fromAddress,
          envelopeTo: deviceMailMessages.envelopeTo,
          subject: deviceMailMessages.subject,
          profileCode: deviceMailMessages.profileCode,
          errorCode: deviceMailMessages.errorCode,
          errorText: deviceMailMessages.errorText,
          parsedPayload: deviceMailMessages.parsedPayload,
          observationCount: deviceMailMessages.observationCount,
          eventCount: deviceMailMessages.eventCount,
        })
        .from(deviceMailMessages)
        .where(and(queueScope(), cursor ? afterCursor(cursor) : undefined))
        .orderBy(asc(deviceMailMessages.receivedAt), asc(deviceMailMessages.id))
        // На строку больше страницы: она же и есть ответ на вопрос «а есть ли ещё».
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      const last = page[page.length - 1];

      return {
        mailbox: await loadMailboxes(),
        items: {
          items: page.map((row): DeviceMailQueueItemDto => ({
            id: row.id,
            status: row.status as DeviceMessageStatus,
            rawState: row.rawState as DeviceRawState,
            receivedAt: row.receivedAt.toISOString(),
            deviceTime: row.deviceTime?.toISOString() ?? null,
            fromAddress: row.fromAddress,
            envelopeTo: row.envelopeTo,
            subject: row.subject,
            profileCode: (row.profileCode as DeviceProfileCode | null) ?? null,
            // Пустая строка колонки — это «кода нет»; DTO говорит то же самое `null`, и две
            // формы одного «ничего» на экране разошлись бы первой же проверкой на истинность.
            errorCode: row.errorCode === '' ? null : (row.errorCode as DeviceErrorCode),
            errorText: row.errorText,
            identity: hintsOf(row.parsedPayload),
            observationCount: row.observationCount,
            eventCount: row.eventCount,
            // Перечитывать нечем ни у переростка (тела не было вовсе), ни у старого письма
            // (сырьё вычищено по сроку): кнопка, падающая без объяснения, хуже отсутствующей.
            canReparse: row.rawState === 'stored',
            /*
             * Флаг считается ТЕМ ЖЕ предикатом, что стоит барьером в ручке отметки, — отрицанием
             * `hasExitBesidesReview`. Одна функция на оба ответа, а не два похожих выражения:
             * разойдись они, экран показал бы кнопку, которую сервер отклоняет, — ровно та беда, от
             * которой правило одного места и заведено. Барьер в ручке при этом остаётся: флаг
             * прячет кнопку, барьер стережёт ручку от прямого запроса и от устаревшей страницы, и
             * это два разных рубежа, а не дубль.
             */
            canReview: !hasExitBesidesReview(row.status, row.rawState),
          })),
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeDeviceCursor('device-mail-queue', {
                  observedAt: last.receivedAtCursor,
                  id: last.id,
                })
              : null,
        },
      };
    },
  );

  /**
   * Сколько писем затронет привязка — ДО подтверждения (Р20: «перед подтверждением человеку
   * показывается, сколько писем будет затронуто»).
   *
   * СЧИТАЕТ СЕРВЕР ТЕМ ЖЕ ОТБОРОМ, ЧТО И ПРИМЕНЕНИЕ (`countBindTargets`). Портал посчитать это не
   * может даже теоретически: пачка ищется по нормализованной подсказке внутри снимков всех
   * накопленных писем, а у экрана на руках одна страница очереди. Своя оценка на клиенте показала
   * бы одно число, а применилось бы другое — и именно в том действии, цена ошибки которого
   * «чужая наработка в живой карточке» (§6).
   */
  r.get(
    '/messages/:id/bind-targets',
    {
      preHandler: [app.authenticate, canReview],
      schema: {
        params: idParams,
        querystring: z.object({
          kind: z.enum(DEVICE_IDENTITY_KINDS),
          value: z.string().min(1).max(200),
        }),
      },
    },
    async (req): Promise<{ messages: number }> => {
      await requireMessage(req.params.id);
      return {
        messages: await countBindTargets(db, {
          messageId: req.params.id,
          kind: req.query.kind,
          value: req.query.value,
        }),
      };
    },
  );

  /**
   * «Привязать к аппарату»: заводит подтверждённую привязку и применяет накопленные снимки — одной
   * транзакцией (Р20).
   *
   * ПАЧКА ИЛИ ОДНА СТРОКА — РЕШАЕТ РОД КЛЮЧА, И РЕШАЕТ ЕГО КОНТРАКТ (`isIdentifyingKind` внутри
   * слоя применения). Своей копии правила здесь нет намеренно: разойдись она со слоем — экран
   * показал бы число по одному правилу, а применил бы по другому.
   *
   * `confirmedBy` — тот, кто нажал: это и подпись под привязкой, и закрывающий след очереди
   * (`reviewed_by`/`reviewed_at` ставит сам слой применения, обе колонки разом — этого требует
   * проверка схемы).
   */
  r.post(
    '/messages/:id/bind',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: deviceMailBindSchema },
    },
    async (req): Promise<DeviceMailBindResultDto> => {
      const p = requirePrincipal(req);
      await requireMessage(req.params.id);
      try {
        return await bindDeviceMailIdentity({
          messageId: req.params.id,
          equipmentId: req.body.equipmentId,
          kind: req.body.kind,
          value: req.body.value,
          note: req.body.note,
          confirmedBy: p.id,
        });
      } catch (e) {
        bindRefusal(e);
      }
    },
  );

  /**
   * «Отметить просмотренным» — закрывающий след очереди.
   *
   * ТОЛЬКО ДЛЯ СТРОК, У КОТОРЫХ ДРУГОГО ВЫХОДА НЕТ (`hasExitBesidesReview`). Письмо, закрытое
   * счётчиком застревания, и письмо с вычищенным сырьём не решаются ничем: снимка нет, перечитывать
   * нечем, «игнорировать» поставило бы статус, который уже стоит. А непривязанное письмо со снимком
   * отметка не решает, а ТЕРЯЕТ: из очереди оно уходит навсегда, показания в карточку не попадут, и
   * при этом останется в отборе пачки — будущая привязка того же серийника применит его молча.
   * Барьер поэтому стоит НА СЕРВЕРЕ, а не в виде спрятанной кнопки: кнопку прячет экран, но
   * барьеру полагается быть одному, и это он.
   *
   * ОБЕ КОЛОНКИ ИЛИ НИ ОДНОЙ — этого требует `device_mail_messages_review_shape_check`, и это не
   * педантизм схемы: «просмотрено» без автора — след, по которому не спросишь, кто решил.
   * Повторная отметка отметку НЕ переписывает: первым просмотрел тот, кто просмотрел, и второе
   * нажатие соседа не имеет права занять его место в следе.
   */
  r.post(
    '/messages/:id/reviewed',
    { preHandler: [app.authenticate, canReview], schema: { params: idParams } },
    async (req): Promise<{ id: string; reviewedAt: string }> => {
      const p = requirePrincipal(req);
      const message = await requireMessage(req.params.id);
      // Отказ называет ВЫХОД, а не запрет: человек пришёл убрать строку из очереди, и «нельзя» без
      // продолжения он прочитает как поломку кнопки.
      if (hasExitBesidesReview(message.status, message.rawState)) {
        throw err.unprocessable(
          message.rawState === 'stored'
            ? 'У письма сохранено сырьё — перечитайте его или свяжите с аппаратом; ' +
                'ненужное закройте действием «Игнорировать»'
            : 'Письмо ждёт привязки к аппарату — свяжите его с карточкой; ' +
                'ненужное закройте действием «Игнорировать»',
        );
      }
      const now = new Date();
      const [row] = await db
        .update(deviceMailMessages)
        .set({ reviewedBy: p.id, reviewedAt: now, updatedAt: now })
        .where(and(eq(deviceMailMessages.id, req.params.id), isNull(deviceMailMessages.reviewedAt)))
        .returning({ id: deviceMailMessages.id, reviewedAt: deviceMailMessages.reviewedAt });
      if (row?.reviewedAt) return { id: row.id, reviewedAt: row.reviewedAt.toISOString() };

      // Строка уже отмечена — это успех, а не конфликт: человек нажал дважды либо коллега успел
      // раньше, и в обоих случаях желаемое состояние достигнуто. Отдаём чужую отметку как есть.
      const [existing] = await db
        .select({ id: deviceMailMessages.id, reviewedAt: deviceMailMessages.reviewedAt })
        .from(deviceMailMessages)
        .where(eq(deviceMailMessages.id, req.params.id));
      if (!existing?.reviewedAt) throw err.notFound('Письмо аппарата не найдено');
      return { id: existing.id, reviewedAt: existing.reviewedAt.toISOString() };
    },
  );

  /**
   * «Игнорировать» — выход для письма, которое разбирать НЕ НАДО (§10, перечень действий).
   *
   * ЧЕМ ОТЛИЧАЕТСЯ ОТ ОТМЕТКИ ПРОСМОТРА, И ПОЧЕМУ ОДНИМ ИЗ НИХ НЕ ОБОЙТИСЬ. Отметка — это след
   * «строку видели», статуса она не меняет; отбор пачки в `apply.ts` идёт по СТАТУСУ, и письмо,
   * закрытое одной отметкой, осталось бы `unmatched` — то есть продолжало бы попадать в будущую
   * привязку по тому же серийнику, уже не показываясь человеку. Здесь же меняется сам статус, и
   * письмо выходит из очереди и из отбора пачки разом. Ровно поэтому мусор закрывают этим
   * действием, а не тем.
   *
   * СЛЕД СТАВИТСЯ ТОЖЕ: «кто решил, что это не нужно» — вопрос того же порядка, что «кто привязал»,
   * а второй колонки под автора у строки нет. Обе колонки разом — этого требует проверка схемы.
   *
   * КОД ОШИБКИ НЕ ТРОГАЕТСЯ НАМЕРЕННО. Он объясняет, почему письмо оказалось в очереди
   * (`extract_failed`, `no_profile`), и переписать его «человек закрыл» значило бы потерять
   * единственное объяснение — а причину решения самого человека хранить всё равно негде: колонки
   * под неё в схеме нет, и предложение уехало отчётом пакета. Заодно этим держится отбор: код
   * `stuck` у закрытой строки остаётся на месте, а из очереди её выводит след.
   */
  r.post(
    '/messages/:id/ignore',
    { preHandler: [app.authenticate, canReview], schema: { params: idParams } },
    async (req): Promise<{ id: string; status: DeviceMessageStatus }> => {
      const p = requirePrincipal(req);
      const message = await requireMessage(req.params.id);
      // Уже разобранное письмо игнорировать нечего: его снимок лежит в карточке, и подмена статуса
      // рассказывала бы про живые показания, что их «отбросили».
      if (message.status === 'parsed') {
        throw err.unprocessable('Письмо уже разобрано и применено к карточке — отбрасывать нечего');
      }
      const now = new Date();
      await db
        .update(deviceMailMessages)
        .set({
          status: 'ignored',
          // След ПЕРВОГО решившего, а не последнего нажавшего: `COALESCE` держит и это, и форму
          // проверки схемы — обе колонки заполняются вместе либо обе остаются как были.
          reviewedBy: sql`COALESCE(${deviceMailMessages.reviewedBy}, ${p.id}::uuid)`,
          reviewedAt: sql`COALESCE(${deviceMailMessages.reviewedAt}, ${now})`,
          updatedAt: now,
        })
        .where(eq(deviceMailMessages.id, req.params.id));
      return { id: req.params.id, status: 'ignored' };
    },
  );

  /**
   * «Перечитать» письмо нынешними правилами разбора (Р26).
   *
   * ПРЯМЫМ ВЫЗОВОМ, А НЕ ЗАДАЧЕЙ ОЧЕРЕДИ, и это разница между двумя сценариями одного действия.
   * Очередь `reparse_device_message` написана для ПАКЕТНОГО прогона — тысяча накопленных писем на
   * выкате профиля, где никто не ждёт ответа. Здесь же человек стоит перед экраном, только что
   * поправил профиль и хочет увидеть исход этой строки: отложенная задача ответила бы ему
   * «принято» и оставила бы догадываться, разобралось ли.
   *
   * ПРОВЕРКА «ЕСТЬ ЛИ ЧЕМ» ЖИВЁТ В САМОМ СЛОЕ (`reparseDeviceMessage` отвечает 422 на `absent` и
   * `purged`), и второй такой проверки здесь нет: кнопка спрятана по `canReparse`, но спрятанная
   * кнопка — не барьер, а барьеру полагается быть одному.
   */
  r.post(
    '/messages/:id/reparse',
    { preHandler: [app.authenticate, canReview], schema: { params: idParams } },
    async (req): Promise<{ status: DeviceMessageStatus }> => {
      await requireMessage(req.params.id);
      return { status: await reparseDeviceMessage(req.params.id) };
    },
  );
}
